/**
 * T2 UT — jsonlPut append 尾段路径纯 append 优化（v0.0.302）
 * 参考: specs/tech/version_logs/v0.0.302/change_plan.md T2 行 + D5/D6
 *
 * 覆盖：
 *   - 追加不读旧内容：mock fs 验证热路径只调 appendFileSync，不调 readFileSync
 *   - 冷路径首次 miss：读一次填缓存，后续命中热路径零读
 *   - 段文件格式不变：追加后每行一条 JSON + 末尾换行，jsonlGet/jsonlQuerySegments 正常解析
 *   - 乱序回填路径不变且清缓存
 *   - 尾段满 roll 新段后缓存正确重置
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 用 vi.mock 拦截 node:fs 的 readFileSync / appendFileSync 调用计数
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    appendFileSync: vi.fn(actual.appendFileSync),
  };
});

// 在被测模块导入前完成 mock（vi.mock hoisted，beforeEach 内动态导入）
let jsonlPut: typeof import('../fs-jsonl').jsonlPut;
let jsonlGet: typeof import('../fs-jsonl').jsonlGet;
let jsonlQuerySegments: typeof import('../fs-jsonl').jsonlQuerySegments;
let jsonlDelete: typeof import('../fs-jsonl').jsonlDelete;
let debugSegmentStats: typeof import('../fs-jsonl').debugSegmentStats;

let tmpDir: string;

function mkRow(id: string, extra?: Record<string, unknown>) {
  return { id, ...extra };
}

/** 生成递增 ULID 风格 id（字典序 = 时间序） */
let idCounter = 0;
function nextId(): string {
  idCounter++;
  return `01KZJ${String(idCounter).padStart(20, '0')}`;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-append-'));
  idCounter = 0;
  vi.clearAllMocks();
  // 动态导入被测模块（vi.mock 已 hoist，每次 beforeEach 重导入确保 mock 生效）
  const mod = await import('../fs-jsonl');
  jsonlPut = mod.jsonlPut;
  jsonlGet = mod.jsonlGet;
  jsonlQuerySegments = mod.jsonlQuerySegments;
  jsonlDelete = mod.jsonlDelete;
  debugSegmentStats = mod.debugSegmentStats;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('jsonlPut append 尾段路径纯 append 优化', () => {
  it('热路径连续追加：首次 miss 读一次填缓存，后续零读文件直接 appendFileSync', () => {
    const id1 = nextId();
    const id2 = nextId();
    const id3 = nextId();

    // 首条：无段 → writeSegment（新建首段）
    jsonlPut(tmpDir, id1, mkRow(id1, { msg: 'first' }), 100);

    // 清 mock 计数（新建段的 writeSegment 会调 readFileSync 吗？不会——atomicWriteSync 只写）
    vi.clearAllMocks();

    // 第二条：cache 已有（首条写入时已填），命中热路径 → 零 readFileSync + 一次 appendFileSync
    jsonlPut(tmpDir, id2, mkRow(id2, { msg: 'second' }), 100);
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);

    // 第三条：同样命中热路径
    vi.clearAllMocks();
    jsonlPut(tmpDir, id3, mkRow(id3, { msg: 'third' }), 100);
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);

    // 验证数据正确
    const rows = jsonlQuerySegments(tmpDir);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id)).toEqual([id1, id2, id3]);
  });

  it('冷路径 cache miss（新进程/新 dir）：首次读一次填缓存，后续命中热路径', () => {
    // 先用原生 fs 写一个段文件（模拟另一个进程写入，cache 无此 dir）
    const id1 = nextId();
    const id2 = nextId();
    const segFile = path.join(tmpDir, `${id1}.jsonl`);
    fs.writeFileSync(segFile, JSON.stringify(mkRow(id1, { msg: 'existing' })) + '\n');

    vi.clearAllMocks();

    // 首次 put：cache miss → 回退 readSegment 读一次填缓存
    jsonlPut(tmpDir, id2, mkRow(id2, { msg: 'appended' }), 100);
    // readFileSync 被调（readSegment 读段文件）
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalled();

    vi.clearAllMocks();

    // 第二次 put：cache 命中 → 零 readFileSync
    const id3 = nextId();
    jsonlPut(tmpDir, id3, mkRow(id3, { msg: 'hot' }), 100);
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
  });

  it('段文件格式不变：追加后每行一条 JSON + 末尾换行，读取侧正常解析', () => {
    const ids = [nextId(), nextId(), nextId(), nextId(), nextId()];
    for (const id of ids) {
      jsonlPut(tmpDir, id, mkRow(id, { content: `msg-${id}` }), 100);
    }

    // 验证段文件格式：每行一条 JSON + 末尾换行
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.jsonl'));
    expect(files).toHaveLength(1); // 5 条 < maxCount=100，单段
    const raw = fs.readFileSync(path.join(tmpDir, files[0]!), 'utf8');
    const lines = raw.split('\n').filter((s) => s.trim().length > 0);
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // 末尾换行
    expect(raw.endsWith('\n')).toBe(true);

    // 读取侧正常解析
    const all = jsonlQuerySegments(tmpDir);
    expect(all).toHaveLength(5);
    for (const id of ids) {
      const row = jsonlGet(tmpDir, id);
      expect(row).toBeDefined();
      expect(row!.id).toBe(id);
    }
  });

  it('尾段满 roll 新段：缓存正确重置，新段纯 append', () => {
    const maxCount = 3;
    const ids = Array.from({ length: 5 }, () => nextId());

    // 写 3 条（满 maxCount）
    for (let i = 0; i < 3; i++) {
      jsonlPut(tmpDir, ids[i]!, mkRow(ids[i]!), maxCount);
    }

    vi.clearAllMocks();

    // 第 4 条：尾段满 → 新开段（writeSegment），缓存重置
    jsonlPut(tmpDir, ids[3]!, mkRow(ids[3]!), maxCount);

    vi.clearAllMocks();

    // 第 5 条：新段只有 1 条 < maxCount → 命中热路径纯 append
    jsonlPut(tmpDir, ids[4]!, mkRow(ids[4]!), maxCount);
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);

    // 验证段结构
    const stats = debugSegmentStats(tmpDir);
    expect(stats).toHaveLength(2);
    expect(stats[0]!.count).toBe(3); // 第一段满
    expect(stats[1]!.count).toBe(2); // 第二段 2 条
  });

  it('乱序回填路径不变：触发后清缓存，后续 append 回退冷路径', () => {
    const id1 = nextId();
    const id2 = nextId();
    const id3 = nextId();

    // 先写 2 条（递增，填缓存）
    jsonlPut(tmpDir, id1, mkRow(id1), 100);
    jsonlPut(tmpDir, id3, mkRow(id3), 100);

    // 乱序回填：id2 < id3（maxId）→ 走乱序路径
    vi.clearAllMocks();
    jsonlPut(tmpDir, id2, mkRow(id2), 100);
    // 乱序路径会 readSegment 读段文件
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalled();

    // 乱序后缓存已清 → 下次 append 回退冷路径（需 readSegment 填缓存）
    const id4 = nextId();
    vi.clearAllMocks();
    jsonlPut(tmpDir, id4, mkRow(id4), 100);
    // 冷路径 readSegment 读一次
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalled();

    // 再下次：缓存已填 → 热路径零读
    const id5 = nextId();
    vi.clearAllMocks();
    jsonlPut(tmpDir, id5, mkRow(id5), 100);
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();

    // 验证数据完整 + 有序
    const all = jsonlQuerySegments(tmpDir);
    expect(all.map((r) => r.id)).toEqual([id1, id2, id3, id4, id5]);
  });

  it('jsonlDelete 清缓存：删除后 append 回退冷路径重新填缓存', () => {
    const id1 = nextId();
    const id2 = nextId();
    const id3 = nextId();

    jsonlPut(tmpDir, id1, mkRow(id1), 100);
    jsonlPut(tmpDir, id2, mkRow(id2), 100);
    jsonlPut(tmpDir, id3, mkRow(id3), 100);

    // 删除中间一条 → 清缓存
    jsonlDelete(tmpDir, id2);

    // 下次 append：冷路径 readSegment
    const id4 = nextId();
    vi.clearAllMocks();
    jsonlPut(tmpDir, id4, mkRow(id4), 100);
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalled();

    // 验证数据
    const all = jsonlQuerySegments(tmpDir);
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.id)).toEqual([id1, id3, id4]);
  });

  it('appendFileSync 写入内容格式正确（JSON + 换行）', () => {
    const id1 = nextId();
    jsonlPut(tmpDir, id1, mkRow(id1), 100);

    const id2 = nextId();
    const row2 = mkRow(id2, { msg: 'check-format' });
    vi.clearAllMocks();
    jsonlPut(tmpDir, id2, row2, 100);

    // 验证 appendFileSync 被调时内容 = JSON + \n
    expect(vi.mocked(fs.appendFileSync)).toHaveBeenCalledTimes(1);
    const [, content] = vi.mocked(fs.appendFileSync).mock.calls[0]!;
    expect(typeof content).toBe('string');
    expect((content as string).endsWith('\n')).toBe(true);
    expect(JSON.parse((content as string).trim())).toEqual(row2);
  });
});
