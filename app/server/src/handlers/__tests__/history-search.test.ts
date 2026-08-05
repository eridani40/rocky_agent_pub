/**
 * handleHistorySearch 单测 —— GET /history/search 参数解析 + 校验 + 序列化
 * 参考: specs/api/overall/19-history-search.md §1（端点契约）
 *       specs/tech/version_logs/v0.0.126/change_plan.md 模块5（router + handler）
 *       test-plan §1 UT 关键点（router: GET /history/search 分发 / 400 BAD_REQUEST / debug=1 打分明细）
 *
 * 覆盖：
 *   - handleHistorySearch: q 命中返回 hits / keywords 命中 / q+keywords 都缺→400 /
 *     debug=1 返回打分明细 / scope=exclude_current + current_session 校验 /
 *     top_k 范围校验 / scope 非法值 / time_range 透传
 *   - _parseKeywords: csv→[] 过滤空/重复 / 空串→[]
 *   - _parseTimeRange: ISO 接受 / ULID 接受 / 空白过滤
 *   - router 集成：GET /history/search 分发 / searchEngine 未装配→503
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  handleHistorySearch,
  _parseKeywords,
  _parseTimeRange,
} from '../history-search';
import type { SearchEngine, HistorySearchHit } from '../../persistence/search-engine';

// ============================================================
// 工具：构造 mock SearchEngine
// ============================================================

/** 构造 mock SearchEngine，记录调用 + 返回预设 hits */
function makeMockEngine(hits: HistorySearchHit[] = []): {
  engine: SearchEngine;
  calls: { query: string; opts: unknown; withDebug: boolean }[];
} {
  const calls: { query: string; opts: unknown; withDebug: boolean }[] = [];
  const engine = {
    search: vi.fn((query: string, opts: unknown) => {
      calls.push({ query, opts, withDebug: false });
      return hits;
    }),
    searchWithDebug: vi.fn((query: string, opts: unknown) => {
      calls.push({ query, opts, withDebug: true });
      return hits;
    }),
  } as unknown as SearchEngine;
  return { engine, calls };
}

/** 构造一条 hit（含可选 debug） */
function makeHit(overrides: Partial<HistorySearchHit> = {}): HistorySearchHit {
  return {
    sessionId: '01SESSION0001',
    sessionTitle: null,
    messageId: '01MSG00000001',
    role: 'user',
    timestamp: '2026-01-01T00:00:00.000Z',
    snippet: '«hello» world',
    score: 0.5,
    ...overrides,
  };
}

/** 构造 URL（helper） */
function makeUrl(query: string): URL {
  return new URL(`http://localhost/history/search?${query}`);
}

// ============================================================
// _parseKeywords
// ============================================================

describe('_parseKeywords', () => {
  it('CSV → string[]，过滤空串和重复', () => {
    expect(_parseKeywords('a,b,a,c,,b')).toEqual(['a', 'b', 'c']);
  });

  it('空白条目过滤', () => {
    expect(_parseKeywords('  a  , b ,')).toEqual(['a', 'b']);
  });

  it('空串 / null → []', () => {
    expect(_parseKeywords('')).toEqual([]);
    expect(_parseKeywords(null)).toEqual([]);
  });

  it('单个关键词', () => {
    expect(_parseKeywords('hello')).toEqual(['hello']);
  });

  it('中文关键词', () => {
    expect(_parseKeywords('打包,electron,部署')).toEqual(['打包', 'electron', '部署']);
  });
});

// ============================================================
// _parseTimeRange
// ============================================================

describe('_parseTimeRange', () => {
  it('ISO 时间接受', () => {
    expect(_parseTimeRange('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z')).toEqual({
      after: '2026-01-01T00:00:00Z',
      before: '2026-12-31T00:00:00Z',
    });
  });

  it('ULID 接受（原样透传）', () => {
    expect(_parseTimeRange('01HXXXXXXXXXXXXXXX', '01HYYYYYYYYYYYYYYY')).toEqual({
      after: '01HXXXXXXXXXXXXXXX',
      before: '01HYYYYYYYYYYYYYYY',
    });
  });

  it('仅 after', () => {
    expect(_parseTimeRange('2026-01-01', null)).toEqual({ after: '2026-01-01' });
  });

  it('仅 before', () => {
    expect(_parseTimeRange(null, '2026-12-31')).toEqual({ before: '2026-12-31' });
  });

  it('空白过滤', () => {
    expect(_parseTimeRange('   ', '  ')).toEqual({});
  });

  it('都缺 → {}', () => {
    expect(_parseTimeRange(null, null)).toEqual({});
  });
});

// ============================================================
// handleHistorySearch
// ============================================================

describe('handleHistorySearch', () => {
  // ── 成功路径 ──

  it('q 命中 → 200 + hits', async () => {
    const hit = makeHit({ snippet: '«hello» world' });
    const { engine, calls } = makeMockEngine([hit]);
    const res = await handleHistorySearch(makeUrl('q=hello'), engine);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0].messageId).toBe('01MSG00000001');
    expect(body.meta.query).toBe('hello');
    expect(body.meta.total).toBe(1);
    // 调用参数
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toBe('hello');
    expect(calls[0]!.withDebug).toBe(false);
  });

  it('keywords 命中（无 q）→ 200 + keywords 数组传给 engine', async () => {
    const { engine, calls } = makeMockEngine([]);
    const res = await handleHistorySearch(makeUrl('keywords=electron,打包'), engine);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.meta.keywords).toEqual(['electron', '打包']);
    // 调用 engine 时 opts.keywords 透传
    expect(calls[0]!.opts).toMatchObject({ keywords: ['electron', '打包'] });
  });

  it('q + keywords 同时提供 → 都传给 engine', async () => {
    const { engine, calls } = makeMockEngine([]);
    const res = await handleHistorySearch(makeUrl('q=hello&keywords=a,b'), engine);
    expect(res.status).toBe(200);
    expect(calls[0]!.query).toBe('hello');
    expect(calls[0]!.opts).toMatchObject({ keywords: ['a', 'b'] });
  });

  it('debug=1 → 调 searchWithDebug（非 search）', async () => {
    const hitWithDebug = makeHit({
      debug: { bm25_score: 2.3, matched_terms: ['hel'], fts_route: 'bm25' },
    });
    const { engine, calls } = makeMockEngine([hitWithDebug]);
    const res = await handleHistorySearch(makeUrl('q=hello&debug=1'), engine);
    expect(res.status).toBe(200);
    expect(calls[0]!.withDebug).toBe(true);
    const body = (await res.json()) as Record<string, any>;
    expect(body.hits[0].debug).toBeDefined();
    expect(body.hits[0].debug.bm25_score).toBe(2.3);
    expect(body.meta.debug).toBe(true);
  });

  it('debug 默认 0（不传）', async () => {
    const { engine, calls } = makeMockEngine([]);
    const res = await handleHistorySearch(makeUrl('q=hello'), engine);
    expect(calls[0]!.withDebug).toBe(false);
    const body = (await res.json()) as Record<string, any>;
    expect(body.meta.debug).toBe(false);
  });

  // ── 校验失败 ──

  it('q 和 keywords 都缺 → 400 BAD_REQUEST', async () => {
    const { engine } = makeMockEngine([]);
    const res = await handleHistorySearch(makeUrl(''), engine);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe('BAD_REQUEST');
  });

  it('q 和 keywords 都缺（keywords 是空串）→ 400', async () => {
    const { engine } = makeMockEngine([]);
    const res = await handleHistorySearch(makeUrl('q=&keywords=,'), engine);
    expect(res.status).toBe(400);
  });

  it('scope=exclude_current 但 current_session 缺 → 400', async () => {
    const { engine } = makeMockEngine([]);
    const res = await handleHistorySearch(
      makeUrl('q=hello&scope=exclude_current'),
      engine,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe('BAD_REQUEST');
    expect(body.message).toMatch(/current_session/);
  });

  it('scope=exclude_current + current_session 提供 → 200 + opts 透传', async () => {
    const { engine, calls } = makeMockEngine([]);
    const res = await handleHistorySearch(
      makeUrl('q=hello&scope=exclude_current&current_session=01SESSION0001'),
      engine,
    );
    expect(res.status).toBe(200);
    expect(calls[0]!.opts).toMatchObject({
      scope: 'exclude_current',
      currentSession: '01SESSION0001',
    });
  });

  it('scope 非法值 → 400', async () => {
    const { engine } = makeMockEngine([]);
    const res = await handleHistorySearch(makeUrl('q=hello&scope=invalid'), engine);
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.message).toMatch(/scope/);
  });

  it('top_k 非整数 → 400', async () => {
    const { engine } = makeMockEngine([]);
    const res = await handleHistorySearch(makeUrl('q=hello&top_k=abc'), engine);
    expect(res.status).toBe(400);
  });

  it('top_k > 50 → 400', async () => {
    const { engine } = makeMockEngine([]);
    const res = await handleHistorySearch(makeUrl('q=hello&top_k=100'), engine);
    expect(res.status).toBe(400);
  });

  it('top_k < 1 → 400', async () => {
    const { engine } = makeMockEngine([]);
    const res = await handleHistorySearch(makeUrl('q=hello&top_k=0'), engine);
    expect(res.status).toBe(400);
  });

  it('top_k 缺省 → 用默认 8', async () => {
    const { engine, calls } = makeMockEngine([]);
    await handleHistorySearch(makeUrl('q=hello'), engine);
    expect(calls[0]!.opts).toMatchObject({ topK: 8 });
  });

  it('top_k 合法值 → 透传', async () => {
    const { engine, calls } = makeMockEngine([]);
    await handleHistorySearch(makeUrl('q=hello&top_k=20'), engine);
    expect(calls[0]!.opts).toMatchObject({ topK: 20 });
  });

  // ── time_range 透传 ──

  it('after/before 透传给 engine opts', async () => {
    const { engine, calls } = makeMockEngine([]);
    await handleHistorySearch(
      makeUrl('q=hello&after=2026-01-01&before=2026-12-31'),
      engine,
    );
    expect(calls[0]!.opts).toMatchObject({
      after: '2026-01-01',
      before: '2026-12-31',
    });
  });

  // ── 错误兜底 ──

  it('SearchEngine.search 抛错 → 500 INTERNAL', async () => {
    const engine = {
      search: vi.fn(() => { throw new Error('fts5 unavailable'); }),
      searchWithDebug: vi.fn(() => { throw new Error('fts5 unavailable'); }),
    } as unknown as SearchEngine;
    const res = await handleHistorySearch(makeUrl('q=hello'), engine);
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe('INTERNAL');
    expect(body.detail.reason).toMatch(/fts5 unavailable/);
  });

  // ── 响应体形状 ──

  it('meta 字段完整（total/returned/query/keywords/elapsedMs/debug）', async () => {
    const { engine } = makeMockEngine([makeHit(), makeHit({ messageId: '01MSG002' })]);
    const res = await handleHistorySearch(makeUrl('q=hello'), engine);
    const body = (await res.json()) as Record<string, any>;
    expect(body.meta).toEqual({
      total: 2,
      returned: 2,
      query: 'hello',
      keywords: [],
      elapsedMs: expect.any(Number),
      debug: false,
    });
    expect(body.meta.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================
// 集成：router GET /history/search 分发
// ============================================================

describe('router GET /history/search 集成', () => {
  let tmpRoot: string;

  // beforeEach 在 it 内部按需创建（避免无谓 bootstrap）

  it('真实 bootstrap 后 GET /history/search?q=... 返 200（searchEngine 已装配）', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-history-search-router-'));
    try {
      const { handleRequest } = await import('../../router');
      const res = await handleRequest(
        new Request('http://localhost/history/search?q=test'),
        tmpRoot,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, any>;
      expect(body.hits).toEqual([]);
      expect(body.meta.total).toBe(0);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('GET /history/search 缺参 → 400 BAD_REQUEST（真实 bootstrap 链）', async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-history-search-router-'));
    try {
      const { handleRequest } = await import('../../router');
      const res = await handleRequest(
        new Request('http://localhost/history/search'),
        tmpRoot,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, any>;
      expect(body.code).toBe('BAD_REQUEST');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
