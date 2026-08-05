/**
 * HistoryIndexer 单元测试 — 写入队列 + 兜底机制
 * 参考: specs/tech/persistence/[P1]search_engine.md §4 / §5 / §3.3
 *       specs/tech/version_logs/v0.0.126/change_plan.md 模块2
 *       specs/tech/version_logs/v0.0.136/change_plan.md（async consumer loop 改造）
 *       states/v0.0.136/verify/test-plan.md（UT 关键覆盖点）
 *
 * 覆盖：
 *   - index：串行保序 / fire-and-forget / 异常吞 / 背压 drop new
 *   - _consumerLoop：批间 yield / 单 worker 保序 / consumer loop async
 *   - _flushBatch：batch 原子事务 / last_ulid 更新
 *   - reconcile：扫 last_ulid 之后 jsonl 补索 / session 维度并行 / 文本来自 jsonl
 *   - deleteBySession：chunks + fts 行同删（级联）/ idempotent
 *   - rebuild：清库后 count 与 chunks 一致
 *   - stats：未初始化不抛错
 *
 * v0.0.136 起 consumer loop 批间 sleep BATCH_INTERVAL_MS=1000ms，UT 用 fake timer
 * 快进避免真等 1s/batch。BATCH_SIZE=32 / BATCH_INTERVAL_MS=1000 与生产模块对齐
 * （UT 内部常量，不 export test-hook 污染生产模块）。
 *
 * 用 BunSqlDriver + :memory: + 临时目录造 jsonl fixture。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BunSqlDriver } from '../search-sql-driver';
import {
  HistoryIndexer,
  extractTextFromContent,
  type IndexPayload,
} from '../history-indexer';
import type { ContentBlock } from '../../message/types';

// ============================================================
// 与生产模块对齐的常量（UT 内部约定，不 export 污染生产）
// ============================================================

/** 一批 INSERT 条数（=生产 BATCH_SIZE） */
const BATCH_SIZE = 32;
/** 批间 sleep 时长 ms（=生产 BATCH_INTERVAL_MS） */
const BATCH_INTERVAL_MS = 1000;

/**
 * 用 fake timer 推进足够让 n 条 payload 全部落库的时间（含兜底 +1 批）。
 * 前提：beforeEach 已启 vi.useFakeTimers()。
 */
async function advanceForCount(n: number): Promise<void> {
  const batches = Math.ceil(n / BATCH_SIZE) + 1;
  await vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS * batches);
}

// ============================================================
// 辅助：造 payload
// ============================================================

let tmpCounter = 0;
/** 造 ULID-like 字符串（单调递增，字典序 = 时间序；26 字符 base32 模拟） */
function mkUlid(seq: number): string {
  // 补齐 26 字符让字典序稳定（前缀时间戳部分）
  return `01HZ${String(seq).padStart(22, '0')}`;
}

function mkPayload(seq: number, sessionId = 'sess-1', text?: string): IndexPayload {
  return {
    messageId: mkUlid(seq),
    sessionId,
    role: seq % 2 === 0 ? 'user' : 'assistant',
    ts: mkUlid(seq),
    text: text ?? `msg-${seq}`,
  };
}

/** 造临时 jsonl transcript 文件（模拟主存落盘） */
function writeJsonl(
  root: string,
  sessionId: string,
  records: Array<{ id: string; role: string; content: ContentBlock[] }>,
): void {
  const dir = path.join(root, 'sessions', sessionId, 'transcript');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${records[0]?.id ?? 'seg'}.jsonl`);
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(file, body);
}

// ============================================================
// extractTextFromContent
// ============================================================

describe('extractTextFromContent', () => {
  it('仅取 type=text 块的 text 字段拼接（\n 分隔）', () => {
    const content: ContentBlock[] = [
      { type: 'text', text: 'hello' },
      { type: 'tool_call', id: 'tc1', name: 'x', arguments: {} },
      { type: 'text', text: 'world' },
      { type: 'usage', usage: { total_tokens: 10 } },
    ];
    expect(extractTextFromContent(content)).toBe('hello\nworld');
  });

  it('无 text 块返回空串', () => {
    const content: ContentBlock[] = [
      { type: 'tool_call', id: 'tc1', name: 'x', arguments: {} },
      { type: 'reasoning', text: 'think' }, // reasoning 不算（仅 type=text）
    ];
    expect(extractTextFromContent(content)).toBe('');
  });

  it('非数组 / 空数组返回空串', () => {
    expect(extractTextFromContent([])).toBe('');
    expect(extractTextFromContent(null)).toBe('');
    expect(extractTextFromContent('not-array')).toBe('');
  });
});

// ============================================================
// index / _flushBatch — 串行保序 + fire-and-forget + 异常吞
// ============================================================

describe('HistoryIndexer.index', () => {
  let driver: BunSqlDriver;
  let indexer: HistoryIndexer;

  beforeEach(async () => {
    vi.useFakeTimers();
    driver = await BunSqlDriver.create(':memory:');
    indexer = new HistoryIndexer(driver, null);
  });

  afterEach(() => {
    vi.useRealTimers();
    driver.close();
  });

  it('串行保序：多 payload 按 FIFO 顺序落库', async () => {
    const payloads = [mkPayload(1), mkPayload(2), mkPayload(3), mkPayload(4), mkPayload(5)];
    indexer.index(payloads);
    await advanceForCount(payloads.length);
    await indexer.flush();

    const rows = driver
      .prepare('SELECT message_id, ts FROM chunks ORDER BY rowid')
      .all<{ message_id: string; ts: string }>();
    expect(rows.map((r) => r.message_id)).toEqual([
      payloads[0]!.messageId,
      payloads[1]!.messageId,
      payloads[2]!.messageId,
      payloads[3]!.messageId,
      payloads[4]!.messageId,
    ]);
    // ts = messageId
    expect(rows[0]!.ts).toBe(payloads[0]!.messageId);
  });

  it('fire-and-forget：index() 不 await 也能触发后台 consumer loop', async () => {
    indexer.index(mkPayload(10));
    // 不 await indexer.flush()——fake timer 推进让 consumer loop 跑过一次 batch interval
    await advanceForCount(1);
    const count = driver.prepare('SELECT COUNT(*) AS c FROM chunks').all<{ c: number }>()[0]?.c;
    expect(count).toBe(1);
  });

  it('batch 32：>32 条会分批写入，全部落库', async () => {
    const payloads: IndexPayload[] = [];
    for (let i = 0; i < 70; i++) payloads.push(mkPayload(i + 100));
    indexer.index(payloads);
    await advanceForCount(payloads.length);
    await indexer.flush();
    const count = driver.prepare('SELECT COUNT(*) AS c FROM chunks').all<{ c: number }>()[0]?.c;
    expect(count).toBe(70);
  });

  it('last_ulid 更新为本批最大 ts（ULID 字典序）', async () => {
    indexer.index([mkPayload(5), mkPayload(20), mkPayload(10)]);
    await advanceForCount(3);
    await indexer.flush();
    const last = driver
      .prepare("SELECT v FROM idx_meta WHERE k = 'last_ulid'")
      .all<{ v: string }>()[0]?.v;
    expect(last).toBe(mkUlid(20)); // 最大 seq
  });

  it('异常吞：批失败被 consumer loop 内部 catch，不抛出到 index/flush 调用方', async () => {
    // 同 messageId 重复插入会抛 UNIQUE 约束错（整批原子回滚）
    const dup = mkPayload(1);
    indexer.index([dup, dup]);
    await advanceForCount(2);
    // flush 不应抛错（consumer loop 内部 catch）
    await expect(indexer.flush()).resolves.toBeUndefined();
    // 整批原子回滚：count=0（reconcile 兜底后续补）
    const count = driver.prepare('SELECT COUNT(*) AS c FROM chunks').all<{ c: number }>()[0]?.c;
    expect(count).toBe(0);
  });

  it('空数组 index 不报错也不入库', async () => {
    indexer.index([]);
    await advanceForCount(1);
    await indexer.flush();
    const count = driver.prepare('SELECT COUNT(*) AS c FROM chunks').all<{ c: number }>()[0]?.c;
    expect(count).toBe(0);
  });
});

// ============================================================
// deleteBySession — 级联删 + idempotent
// ============================================================

describe('HistoryIndexer.deleteBySession', () => {
  let driver: BunSqlDriver;
  let indexer: HistoryIndexer;

  beforeEach(async () => {
    vi.useFakeTimers();
    driver = await BunSqlDriver.create(':memory:');
    indexer = new HistoryIndexer(driver, null);
  });

  afterEach(() => {
    vi.useRealTimers();
    driver.close();
  });

  it('删 chunks 行 + fts 级联行同步删除', async () => {
    indexer.index([
      mkPayload(1, 'sess-A', 'alpha keyword'),
      mkPayload(2, 'sess-B', 'beta keyword'),
      mkPayload(3, 'sess-A', 'gamma keyword'),
    ]);
    await advanceForCount(3);
    await indexer.flush();

    // 验 fts 建好（搜 keyword 能命中）
    const beforeFts = driver
      .prepare("SELECT c.message_id FROM fts JOIN chunks c ON c.rowid = fts.rowid WHERE fts MATCH 'keyword'")
      .all<{ message_id: string }>();
    expect(beforeFts.length).toBe(3);

    // 删 sess-A
    const deleted = await indexer.deleteBySession('sess-A');
    expect(deleted).toBe(2);

    // chunks 表只剩 sess-B
    const remain = driver
      .prepare('SELECT session_id AS sid FROM chunks')
      .all<{ sid: string }>();
    expect(remain).toHaveLength(1);
    expect(remain[0]!.sid).toBe('sess-B');

    // fts 也只剩 1 条（triggers 级联删了 sess-A 的 fts 行）
    const afterFts = driver
      .prepare("SELECT c.message_id FROM fts JOIN chunks c ON c.rowid = fts.rowid WHERE fts MATCH 'keyword'")
      .all<{ message_id: string }>();
    expect(afterFts).toHaveLength(1);
    expect(afterFts[0]!.message_id).toBe(mkUlid(2));
  });

  it('idempotent：删不存在的 session 返 0 不抛错', async () => {
    indexer.index([mkPayload(1, 'sess-X')]);
    await advanceForCount(1);
    await indexer.flush();

    const r1 = await indexer.deleteBySession('not-exist');
    expect(r1).toBe(0);

    // 二次删已删 session 也 idempotent
    const r2 = await indexer.deleteBySession('sess-X');
    expect(r2).toBe(1);
    const r3 = await indexer.deleteBySession('sess-X');
    expect(r3).toBe(0);
  });
});

// ============================================================
// stats — 未初始化不抛错
// ============================================================

describe('HistoryIndexer.stats', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('空库返 count=0 不抛错', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    const indexer = new HistoryIndexer(driver, null);
    const s = indexer.stats();
    expect(s.count).toBe(0);
    expect(s.last_ulid).toBeNull();
    expect(s.driver).toBe('BunSqlDriver');
    driver.close();
  });

  it('有数据返正确 count + last_ulid', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    const indexer = new HistoryIndexer(driver, null);
    indexer.index([mkPayload(5), mkPayload(10), mkPayload(15)]);
    await advanceForCount(3);
    await indexer.flush();
    const s = indexer.stats();
    expect(s.count).toBe(3);
    expect(s.last_ulid).toBe(mkUlid(15));
    driver.close();
  });
});

// ============================================================
// reconcile — 扫 jsonl 补索（文本来自落盘 jsonl）
// ============================================================

describe('HistoryIndexer.reconcile', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `hist-test-${tmpCounter++}-`));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('扫 last_ulid 之后的 jsonl 补索', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    const indexer = new HistoryIndexer(driver, tmpDir);

    // 先入库 seq=1（模拟 last_ulid 推进到 seq=1）
    indexer.index([mkPayload(1, 'sess-A')]);
    await advanceForCount(1);
    await indexer.flush();

    // 造 jsonl：seq=1（已索引）+ seq=2,3（未索引，应补索）
    writeJsonl(tmpDir, 'sess-A', [
      { id: mkUlid(1), role: 'user', content: [{ type: 'text', text: 'old' }] },
      { id: mkUlid(2), role: 'assistant', content: [{ type: 'text', text: 'new-2' }] },
      { id: mkUlid(3), role: 'user', content: [{ type: 'text', text: 'new-3' }] },
    ]);

    const res = await indexer.reconcile();
    // scanned = 3（扫了 3 行），indexed = 2（seq 2,3 补索）
    expect(res.scanned).toBe(3);
    expect(res.indexed).toBe(2);

    // 验入库内容
    const rows = driver
      .prepare('SELECT message_id, text FROM chunks ORDER BY ts')
      .all<{ message_id: string; text: string }>();
    expect(rows).toHaveLength(3);
    expect(rows[1]!.text).toBe('new-2');
    expect(rows[2]!.text).toBe('new-3');

    // last_ulid 更新为 seq=3
    expect(indexer.stats().last_ulid).toBe(mkUlid(3));
    driver.close();
  });

  it('文本来自 jsonl（不是内存 messages）—— reconcile 后 fts 可命中 jsonl 中的文本', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    const indexer = new HistoryIndexer(driver, tmpDir);

    writeJsonl(tmpDir, 'sess-X', [
      {
        id: mkUlid(100),
        role: 'user',
        content: [{ type: 'text', text: 'uniquetoken' }],
      },
    ]);

    await indexer.reconcile();

    // fts 搜 unique token 能命中（trigram 分词对 uniquetoken 友好）
    const hit = driver
      .prepare("SELECT c.message_id FROM fts JOIN chunks c ON c.rowid = fts.rowid WHERE fts MATCH 'uniquetoken'")
      .all<{ message_id: string }>();
    expect(hit).toHaveLength(1);
    expect(hit[0]!.message_id).toBe(mkUlid(100));
    driver.close();
  });

  it('session 维度并行：多 session 各自补索', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    const indexer = new HistoryIndexer(driver, tmpDir);

    writeJsonl(tmpDir, 'sess-A', [
      { id: mkUlid(1), role: 'user', content: [{ type: 'text', text: 'a-1' }] },
    ]);
    writeJsonl(tmpDir, 'sess-B', [
      { id: mkUlid(2), role: 'assistant', content: [{ type: 'text', text: 'b-2' }] },
    ]);
    writeJsonl(tmpDir, 'sess-C', [
      { id: mkUlid(3), role: 'user', content: [{ type: 'text', text: 'c-3' }] },
    ]);

    const res = await indexer.reconcile();
    expect(res.indexed).toBe(3);

    const count = driver
      .prepare('SELECT session_id AS sid, COUNT(*) AS c FROM chunks GROUP BY session_id ORDER BY sid')
      .all<{ sid: string; c: number }>();
    expect(count.map((r) => r.sid)).toEqual(['sess-A', 'sess-B', 'sess-C']);
    expect(count.every((r) => r.c === 1)).toBe(true);
    driver.close();
  });

  it('role 过滤：system/tool 跳过', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    const indexer = new HistoryIndexer(driver, tmpDir);

    writeJsonl(tmpDir, 'sess-A', [
      { id: mkUlid(1), role: 'user', content: [{ type: 'text', text: 'u' }] },
      { id: mkUlid(2), role: 'system', content: [{ type: 'text', text: 's' }] },
      { id: mkUlid(3), role: 'tool', content: [{ type: 'text', text: 't' }] },
      { id: mkUlid(4), role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ]);

    const res = await indexer.reconcile();
    expect(res.scanned).toBe(4);
    expect(res.indexed).toBe(2); // 仅 user+assistant

    const roles = driver
      .prepare('SELECT role FROM chunks ORDER BY ts')
      .all<{ role: string }>()
      .map((r) => r.role);
    expect(roles).toEqual(['user', 'assistant']);
    driver.close();
  });

  it('dataRoot 无 sessions 目录返 0 不抛错', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    const indexer = new HistoryIndexer(driver, tmpDir); // tmpDir 存在但无 sessions/
    const res = await indexer.reconcile();
    expect(res.scanned).toBe(0);
    expect(res.indexed).toBe(0);
    driver.close();
  });

  it('坏行（非 JSON）跳过不崩', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    const indexer = new HistoryIndexer(driver, tmpDir);
    const dir = path.join(tmpDir, 'sessions', 'sess-A', 'transcript');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'seg.jsonl'),
      '{"id":"x","role":"user","content":[{"type":"text","text":"good"}]}\n' +
        'this is not json\n' +
        '{"id":"y","role":"user","content":[{"type":"text","text":"good2"}]}\n',
    );
    const res = await indexer.reconcile();
    expect(res.indexed).toBe(2); // 2 条好的入库，坏行跳过
    driver.close();
  });
});

// ============================================================
// rebuild — 清库 + 全扫
// ============================================================

describe('HistoryIndexer.rebuild', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `hist-rebuild-${tmpCounter++}-`));
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('清库后全扫重建：count 与 jsonl 中 user/assistant 行数一致', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    const indexer = new HistoryIndexer(driver, tmpDir);

    // 先手动塞一条旧数据（rebuild 应清掉）
    indexer.index([mkPayload(999, 'sess-old')]);
    await advanceForCount(1);
    await indexer.flush();
    expect(indexer.stats().count).toBe(1);

    // 造 jsonl（多 session + system/tool）
    writeJsonl(tmpDir, 'sess-A', [
      { id: mkUlid(1), role: 'user', content: [{ type: 'text', text: 'a1' }] },
      { id: mkUlid(2), role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    ]);
    writeJsonl(tmpDir, 'sess-B', [
      { id: mkUlid(3), role: 'user', content: [{ type: 'text', text: 'b3' }] },
      { id: mkUlid(4), role: 'system', content: [{ type: 'text', text: 'sys' }] },
    ]);

    const res = await indexer.rebuild();
    expect(res.total).toBe(4); // 扫了 4 行
    expect(res.indexed).toBe(3); // 入库 3 条（system 跳过）

    // 旧数据被清
    const hasOld = driver
      .prepare("SELECT COUNT(*) AS c FROM chunks WHERE session_id = 'sess-old'")
      .all<{ c: number }>()[0]?.c;
    expect(hasOld).toBe(0);

    // 新数据 count 一致
    expect(indexer.stats().count).toBe(3);
    expect(indexer.stats().last_ulid).toBe(mkUlid(3));
    driver.close();
  });
});

// ============================================================
// consumer loop async（v0.0.136 新增）— 批间 yield / 单 worker 保序 / 背压 drop new
// ============================================================

describe('HistoryIndexer consumer loop async', () => {
  let driver: BunSqlDriver;
  let indexer: HistoryIndexer;

  beforeEach(async () => {
    vi.useFakeTimers();
    driver = await BunSqlDriver.create(':memory:');
    indexer = new HistoryIndexer(driver, null);
  });

  afterEach(() => {
    vi.useRealTimers();
    driver.close();
  });

  /**
   * 批间 yield 验证：index() 后 cycle 1 同步段仅写 1 批（32 条），剩余 batch 必须推进
   * timer 才能跑（证明 _consumerLoop 不是同步排空，批间有 await sleep 让出 event loop）。
   * 同步排空实现会让 index() 返回时 chunks=70 → 此断言会 fail。
   */
  it('批间 yield：index() 后仅写 1 批，后续 cycle 需推进 timer 才跑', async () => {
    const payloads: IndexPayload[] = [];
    for (let i = 0; i < 70; i++) payloads.push(mkPayload(i + 200));
    indexer.index(payloads);
    // index() 返回时 cycle 1 同步段（splice 32 + _flushBatch）已执行；剩余 38 条卡在 await sleep
    await Promise.resolve(); // 让 microtask 跑完（cycle 1 已在 index 同步段执行，此处保险）

    let count = driver.prepare('SELECT COUNT(*) AS c FROM chunks').all<{ c: number }>()[0]?.c;
    expect(count).toBe(32); // 仅第 1 batch

    // 推进 BATCH_INTERVAL_MS 让 cycle 2 跑（再写 32 条）
    await vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS);
    count = driver.prepare('SELECT COUNT(*) AS c FROM chunks').all<{ c: number }>()[0]?.c;
    expect(count).toBe(64);

    // 再推进让 cycle 3 跑（剩 6 条）
    await vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS);
    count = driver.prepare('SELECT COUNT(*) AS c FROM chunks').all<{ c: number }>()[0]?.c;
    expect(count).toBe(70);
  });

  /**
   * 单 worker 保序：连续两次 index 共 70 条，consumer loop 单实例按 FIFO 消费全部落库。
   * 验证 loopStarted flag 守卫（第二次 index 不启新 loop，仅入队）+ 跨 index 调用保序。
   */
  it('单 worker 保序：连续 index 两次共 70 条，flush 后全 FIFO 落库', async () => {
    const first: IndexPayload[] = [];
    for (let i = 0; i < 40; i++) first.push(mkPayload(i + 300));
    const second: IndexPayload[] = [];
    for (let i = 0; i < 30; i++) second.push(mkPayload(i + 400));

    indexer.index(first);
    indexer.index(second); // loop 已启动，仅入队（loopStarted=true 不启新 loop）

    await advanceForCount(70);
    await indexer.flush();

    const rows = driver
      .prepare('SELECT message_id FROM chunks ORDER BY rowid')
      .all<{ message_id: string }>();
    expect(rows).toHaveLength(70);
    // FIFO：first 40 条在前，second 30 条在后
    expect(rows[0]!.message_id).toBe(first[0]!.messageId);
    expect(rows[39]!.message_id).toBe(first[39]!.messageId);
    expect(rows[40]!.message_id).toBe(second[0]!.messageId);
    expect(rows[69]!.message_id).toBe(second[29]!.messageId);
  });

  /**
   * 背压 drop new：queue 已塞满 5000 后再 index 1 条 → warn + 该条未入队。
   * 用 cast 直接塞 private queue 绕过 index 内部 splice 副作用（cycle 1 会消费 32 条
   * 让 queue<5000，无法触发背压；cast 一次性赋值 queue=5000 模拟真实积压场景）。
   */
  it('背压 drop new：queue 满 5000 后 index 1 条 → warn + 未入队', async () => {
    // 直接 cast 填满 private queue（不经过 index 启动 loop，避免 cycle 1 splice 副作用）
    const fill: IndexPayload[] = [];
    for (let i = 0; i < 5000; i++) fill.push(mkPayload(i + 500));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (indexer as any).queue = fill;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    indexer.index(mkPayload(99999));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('queue overflow');
    expect(msg).toContain('5000');
    // 队列长度未变（drop new 未入队）
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const queueLen = (indexer as any).queue.length as number;
    expect(queueLen).toBe(5000);
    warnSpy.mockRestore();
  });
});
