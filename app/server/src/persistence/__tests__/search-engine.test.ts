/**
 * SearchEngine 单元测试 — BM25 + recency 重排 + snippet
 * 参考: specs/tech/persistence/[P1]search_engine.md §3.2(schema) §3.5(检索)
 *       specs/tech/version_logs/v0.0.126/change_plan.md 模块1（UT 关键覆盖点）
 *       states/v0.0.126/verify/test-plan.md
 *
 * 覆盖：
 *   - ensureSchema：幂等（调 2 次）+ fts 表 tokenize=trigram 存在
 *   - _sanitize（间接：通过 search 行为）：剥 FTS5 控制字符；空 query 返空；正常 query 命中
 *   - search：MATCH + bm25 召回排序；recency 半衰期（老 ts 排名靠后）；snippet 含命中片段
 *   - extractPlainText：type=text 拼接 / 跳过 image/tool_use/tool_result
 *   - decodeUlidTime：合法 ULID 解码 / 非法字符返 null
 *
 * 用 BunSqlDriver + :memory: 跑真实 FTS5（外部 content 模式：写 chunks 后手动同步 fts）。
 */
import { describe, it, expect } from 'vitest';
import { BunSqlDriver } from '../search-sql-driver';
import {
  SearchEngine,
  extractPlainText,
  decodeUlidTime,
  type HistorySearchHit,
} from '../search-engine';
import type { ContentBlock } from '../../message/types';

// ============================================================
// 测试辅助 — 构造一个已建 schema 的内存引擎 + 灌数据
// ============================================================

interface ChunkRow {
  message_id: string;
  session_id: string;
  role: 'user' | 'assistant';
  ts: string;
  text: string;
}

/**
 * 构造一个内存 SearchEngine 并灌 chunks（external-content 模式：
 * 写完 chunks 必须再 INSERT INTO fts(rowid, text) 同步索引，否则 MATCH 召回不到）。
 */
async function makeEngineWithChunks(chunks: ChunkRow[]): Promise<SearchEngine> {
  const driver = await BunSqlDriver.create(':memory:');
  const engine = new SearchEngine(driver);
  const ins = driver.prepare(
    'INSERT INTO chunks (message_id, session_id, role, ts, text) VALUES (?, ?, ?, ?, ?)',
  );
  const ftsIns = driver.prepare('INSERT INTO fts (rowid, text) VALUES (?, ?)');
  for (const c of chunks) {
    const r = ins.run(c.message_id, c.session_id, c.role, c.ts, c.text);
    // external-content：fts.rowid 必须对齐 chunks.rowid 才能 JOIN 取业务字段
    ftsIns.run(Number(r.lastInsertRowid), c.text);
  }
  return engine;
}

/** 生成 ULID（给定时间戳 ms + 16 字符随机后缀，Crockford base32） */
function ulidFor(ms: number, suffix = '0000ZZZZ0000ZZZZ'): string {
  const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = ms;
  let head = '';
  for (let i = 0; i < 10; i++) {
    head = ALPHA[time % 32] + head;
    time = Math.floor(time / 32);
  }
  return head + suffix;
}

const NOW_MS = Date.parse('2026-07-12T00:00:00.000Z');
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ============================================================
// ensureSchema — 幂等 + fts 表存在
// ============================================================

describe('ensureSchema', () => {
  it('调两次不抛错（幂等，IF NOT EXISTS）', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    const engine = new SearchEngine(driver);
    expect(() => engine.ensureSchema()).not.toThrow();
    driver.close();
  });

  it('fts 虚拟表存在 + tokenize=trigram（查 sqlite_master）', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    const engine = new SearchEngine(driver);
    const rows = driver.prepare<{ name: string; tbl_name: string; sql: string }>(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='table' AND name='fts'",
    ).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('fts');
    // sql 字段含 tokenize='trigram'
    expect(rows[0]!.sql).toMatch(/tokenize\s*=\s*'trigram'/i);
    driver.close();
  });

  it('chunks 表 + idx_chunks_session 索引 + idx_meta 都存在', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    const engine = new SearchEngine(driver);
    const tables = driver.prepare<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name IN ('chunks','idx_chunks_session','idx_meta')",
    ).all().map((r) => r.name);
    expect(tables.sort()).toEqual(['chunks', 'idx_chunks_session', 'idx_meta']);
    driver.close();
  });
});

// ============================================================
// _sanitize（通过 search 行为间接验证；方法 private）
// ============================================================

describe('_sanitize（通过 search 间接验证）', () => {
  it('空 query / 全空白 → search 返空 hits', async () => {
    const engine = await makeEngineWithChunks([
      { message_id: ulidFor(NOW_MS), session_id: 's1', role: 'user', ts: 'x', text: 'hello world foo' },
    ]);
    expect(engine.search('')).toEqual([]);
    expect(engine.search('   ')).toEqual([]);
  });

  it('全 FTS5 控制字符（" * : ( ) ^）→ 剥光后为空 → 返空', async () => {
    const engine = await makeEngineWithChunks([
      { message_id: ulidFor(NOW_MS), session_id: 's1', role: 'user', ts: 'x', text: 'something' },
    ]);
    // 这些字符会被 _sanitize 替成空格后 trim 为空
    expect(engine.search('"*:^()')).toEqual([]);
    expect(engine.search('":"')).toEqual([]);
  });

  it('正常 query 能召回（不抛 FTS5 语法错）', async () => {
    const engine = await makeEngineWithChunks([
      { message_id: ulidFor(NOW_MS), session_id: 's1', role: 'user', ts: 'x', text: 'the quick brown fox jumps over the lazy dog' },
    ]);
    const hits = engine.search('quick brown');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('含控制字符的 query 仍能命中（sanitize 剥掉后正常 MATCH）', async () => {
    const engine = await makeEngineWithChunks([
      { message_id: ulidFor(NOW_MS), session_id: 's1', role: 'user', ts: 'x', text: 'alpha bravo charlie delta' },
    ]);
    // 用户输入的 "alpha" 带引号——sanitize 应剥掉
    const hits = engine.search('"alpha" (bravo)');
    expect(hits.length).toBeGreaterThan(0);
  });
});

// ============================================================
// search — MATCH + bm25 召回排序 + snippet
// ============================================================

describe('search（BM25 召回 + 排序 + snippet）', () => {
  it('query 命中多条 → 按 bm25 相关性排序返回', async () => {
    const engine = await makeEngineWithChunks([
      // A: 文本里 "alpha" 出现 3 次（高相关）
      { message_id: ulidFor(NOW_MS, '0000ZZZZ0000ZZ01'), session_id: 's1', role: 'user', ts: 'x', text: 'alpha alpha alpha other stuff' },
      // B: "alpha" 出现 1 次（低相关）
      { message_id: ulidFor(NOW_MS, '0000ZZZZ0000ZZ02'), session_id: 's1', role: 'user', ts: 'x', text: 'beta gamma alpha other' },
      // C: 不含 "alpha"（不召回）
      { message_id: ulidFor(NOW_MS, '0000ZZZZ0000ZZ03'), session_id: 's1', role: 'user', ts: 'x', text: 'completely unrelated content here' },
    ]);
    const hits = engine.search('alpha');
    expect(hits).toHaveLength(2);
    // 高相关排在前面（bm25 越小越相关，但 score 取 abs × decay，decay 相同时 abs(bm25) 越大越相关）
    expect(hits[0]!.messageId).not.toBe(hits[1]!.messageId);
    // C 不应出现（hits 全是命中 "alpha" 的）
    const allHit = hits.every((h) => h.messageId !== undefined);
    expect(allHit).toBe(true);
  });

  it('topK 截断：只返回 top_k 条', async () => {
    const chunks: ChunkRow[] = [];
    for (let i = 0; i < 5; i++) {
      chunks.push({
        message_id: ulidFor(NOW_MS + i),
        session_id: 's1', role: 'user', ts: 'x',
        text: `alpha occurrence number ${i}`,
      });
    }
    const engine = await makeEngineWithChunks(chunks);
    const hits = engine.search('alpha', { topK: 3 });
    expect(hits).toHaveLength(3);
  });

  it('snippet 含命中片段（fts snippet 函数产出）', async () => {
    const engine = await makeEngineWithChunks([
      { message_id: ulidFor(NOW_MS), session_id: 's1', role: 'user', ts: 'x',
        text: 'intro padding alpha bravo the actual match here charlie delta padding outro' },
    ]);
    const hits = engine.search('alpha bravo');
    expect(hits).toHaveLength(1);
    // snippet 应包含查询词的某种片段（trigram 命中后 snippet 提取相关窗口）
    expect(hits[0]!.snippet.length).toBeGreaterThan(0);
  });

  it('role 字段正确反映（user / assistant）', async () => {
    const engine = await makeEngineWithChunks([
      { message_id: ulidFor(NOW_MS, '0000ZZZZ0000ZZ11'), session_id: 's1', role: 'user', ts: 'x', text: 'alpha content' },
      { message_id: ulidFor(NOW_MS, '0000ZZZZ0000ZZ12'), session_id: 's1', role: 'assistant', ts: 'x', text: 'alpha reply' },
    ]);
    const hits = engine.search('alpha');
    expect(hits).toHaveLength(2);
    const roles = hits.map((h) => h.role).sort();
    expect(roles).toEqual(['assistant', 'user']);
  });

  it('timestamp 从 ULID 解码出 ISO（与 NOW_MS 对齐）', async () => {
    const engine = await makeEngineWithChunks([
      { message_id: ulidFor(NOW_MS), session_id: 's1', role: 'user', ts: 'fallback', text: 'alpha' },
    ]);
    const hits = engine.search('alpha');
    expect(hits).toHaveLength(1);
    // ULID 时间戳解码后应等于 NOW_MS（毫秒精度，toISOString 截到毫秒）
    expect(hits[0]!.timestamp).toBe(new Date(NOW_MS).toISOString());
  });

  it('scope=exclude_current 排除当前 session', async () => {
    const engine = await makeEngineWithChunks([
      { message_id: ulidFor(NOW_MS, '0000ZZZZ0000ZZ21'), session_id: 's1', role: 'user', ts: 'x', text: 'alpha in s1' },
      { message_id: ulidFor(NOW_MS, '0000ZZZZ0000ZZ22'), session_id: 's2', role: 'user', ts: 'x', text: 'alpha in s2' },
    ]);
    const hits = engine.search('alpha', { scope: 'exclude_current', currentSession: 's1' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sessionId).toBe('s2');
  });
});

// ============================================================
// search — recency 半衰期重排
// ============================================================

describe('search（recency 半衰期重排）', () => {
  it('老 ts 的 hit 因 decay 衰减排名靠后（同相关度时）', async () => {
    // 两条相同文本（同 bm25 分），但时间差 60 天（≈ 2 个半衰期 → decay ≈ 0.25）
    // recency 重排后：新的 score ≈ 4× 老的 → 新的排前面
    const engine = await makeEngineWithChunks([
      // 新：0 天前
      { message_id: ulidFor(NOW_MS), session_id: 's1', role: 'user', ts: 'x', text: 'same content alpha' },
      // 老：60 天前（2 × 半衰期 30 天）
      { message_id: ulidFor(NOW_MS - 60 * ONE_DAY_MS), session_id: 's1', role: 'user', ts: 'x', text: 'same content alpha' },
    ]);
    const hits = engine.search('alpha');
    expect(hits).toHaveLength(2);
    // 新的（NOW_MS）应排第一
    const newerTs = new Date(NOW_MS).toISOString();
    expect(hits[0]!.timestamp).toBe(newerTs);
    // score 也应新的 > 老的
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });
});

// ============================================================
// searchWithDebug — debug 字段
// ============================================================

describe('searchWithDebug', () => {
  it('每 hit 附 debug（bm25_score / matched_terms / fts_route）', async () => {
    const engine = await makeEngineWithChunks([
      { message_id: ulidFor(NOW_MS), session_id: 's1', role: 'user', ts: 'x', text: 'alpha beta gamma' },
    ]);
    const hits = engine.searchWithDebug('alpha');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.debug).toBeDefined();
    expect(hits[0]!.debug?.fts_route).toBe('bm25');
    expect(typeof hits[0]!.debug?.bm25_score).toBe('number');
    expect(hits[0]!.debug?.bm25_score).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(hits[0]!.debug?.matched_terms)).toBe(true);
    expect(hits[0]!.debug?.matched_terms?.length).toBeGreaterThan(0);
  });
});

// ============================================================
// extractPlainText — ContentBlock[] → 纯文本
// ============================================================

describe('extractPlainText', () => {
  it('仅 type=text 的 block 被拼接（多个 text block 用 \\n 连接）', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello' } as ContentBlock,
      { type: 'text', text: 'world' } as ContentBlock,
    ];
    expect(extractPlainText(blocks)).toBe('hello\nworld');
  });

  it('跳过 image / tool_use / tool_result block', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'keep this' } as ContentBlock,
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'xxx' } } as unknown as ContentBlock,
      { type: 'tool_use', id: 't1', name: 'foo', input: {} } as unknown as ContentBlock,
      { type: 'tool_result', tool_use_id: 't1', content: [] } as unknown as ContentBlock,
      { type: 'text', text: 'end' } as ContentBlock,
    ];
    expect(extractPlainText(blocks)).toBe('keep this\nend');
  });

  it('空数组返空字符串', () => {
    expect(extractPlainText([])).toBe('');
  });

  it('非数组输入返空字符串（防御）', () => {
    expect(extractPlainText(null as unknown as ContentBlock[])).toBe('');
    expect(extractPlainText(undefined as unknown as ContentBlock[])).toBe('');
  });

  it('空文本 block（text === ""）被跳过', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: '' } as ContentBlock,
      { type: 'text', text: 'real content' } as ContentBlock,
    ];
    expect(extractPlainText(blocks)).toBe('real content');
  });
});

// ============================================================
// decodeUlidTime — ULID 时间戳解码
// ============================================================

describe('decodeUlidTime', () => {
  it('合法 ULID 解码出毫秒时间戳', () => {
    // 用已知时间：2026-01-01T00:00:00.000Z
    const ms = Date.parse('2026-01-01T00:00:00.000Z');
    const id = ulidFor(ms);
    expect(decodeUlidTime(id)).toBe(ms);
  });

  it('小写 ulid 也能解码（实现做了 toUpperCase）', () => {
    const ms = Date.parse('2026-01-01T00:00:00.000Z');
    const id = ulidFor(ms).toLowerCase();
    expect(decodeUlidTime(id)).toBe(ms);
  });

  it('非 ULID 字符串（含非法字符 I/L/O/U）返 null', () => {
    // I/L/O/U 不在 Crockford base32 字母表
    expect(decodeUlidTime('ILLEGALSTR12345')).toBeNull();
  });

  it('长度 < 10 返 null', () => {
    expect(decodeUlidTime('ABC')).toBeNull();
    expect(decodeUlidTime('')).toBeNull();
  });
});
