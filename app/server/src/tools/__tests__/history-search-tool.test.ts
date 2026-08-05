/**
 * history_search 工具单测（UT）
 * 参考: specs/tech/agent/tools/[P1]history_search_tool.md §2/§3/§6（契约 + 测试覆盖）
 *       specs/tech/version_logs/v0.0.126/change_plan.md UT 关键覆盖点
 *
 * 覆盖：
 *   - query/keywords 二选一校验（缺 → 错误提示，不抛错）
 *   - 无命中 → 友好提示（不抛错）
 *   - formatHits 含 messageId + sessionId 锚点
 *   - scope=exclude_current → currentSession 取 ctx.config.sessionId
 *   - top_k 默认 8（透传 SearchOptions）
 *   - top_k 上限 50 保护
 *   - time_range 透传（after/before）
 *   - historyToolDeps 缺失 → RUNTIME_ERROR
 *   - definition.name='history_search' + inputSchema 必要字段对齐 spec §2
 *
 * 隔离策略：mock SearchEngine（不需真 bun:sqlite），mock sessionStore（仅校验透传）。
 */
import { describe, it, expect } from 'vitest';
import { historySearchTool, formatHits } from '../history-search-tool';
import type { HistorySearchHit } from '../../persistence/search-engine';
import type { ToolCtx, ToolRunResult } from '../types';

// ── helpers ──────────────────────────────────────────────────────────

/** 构造 mock SearchEngine（捕获入参 + 返回固定 hits） */
function mockSearchEngine(hits: HistorySearchHit[] = []) {
  const calls: Array<{ query: string; opts: Record<string, unknown> }> = [];
  const engine = {
    search(query: string, opts: Record<string, unknown>): HistorySearchHit[] {
      calls.push({ query, opts });
      return hits;
    },
    calls,
  };
  return engine;
}

/** 构造 ToolCtx（historyToolDeps + sessionId 注入；与生产 ctx.config 形态一致） */
function ctxOf(overrides: {
  searchEngine?: ReturnType<typeof mockSearchEngine>;
  sessionId?: string;
  omitDeps?: boolean;
} = {}): ToolCtx {
  const cfg: Record<string, unknown> = {
    tools: [],
    sessionId: overrides.sessionId ?? 'S-001',
  };
  if (!overrides.omitDeps) {
    cfg.historyToolDeps = {
      searchEngine: overrides.searchEngine ?? mockSearchEngine(),
      sessionStore: { getMessages: async () => ({ items: [], hasMore: false }) },
    };
  }
  return {
    config: cfg as unknown as ToolCtx['config'],
    workdir: '/tmp/test',
  };
}

/** 取 TextBlock text */
function textOf(r: ToolRunResult): string {
  expect(r.content).toHaveLength(1);
  expect(r.content[0]!.type).toBe('text');
  return (r.content[0] as { type: 'text'; text: string }).text;
}

// ── 测试数据 ──────────────────────────────────────────────────────────

const SAMPLE_HITS: HistorySearchHit[] = [
  {
    sessionId: '01SESSION001',
    sessionTitle: '打包讨论',
    messageId: '01HV0000000000000000000001',
    role: 'user',
    timestamp: '2026-07-10T10:00:00.000Z',
    snippet: '上周讨论的打包方案是 «dmg» + asar',
    score: 1.23,
  },
  {
    sessionId: '01SESSION002',
    sessionTitle: null,
    messageId: '01HV0000000000000000000002',
    role: 'assistant',
    timestamp: '2026-07-11T12:00:00.000Z',
    snippet: '建议走 better-sqlite3 + asarUnpack',
    score: 0.98,
  },
];

// ── tests ─────────────────────────────────────────────────────────────

describe('history_search tool', () => {
  describe('definition', () => {
    it('name 与 inputSchema 字段对齐 spec §2', () => {
      expect(historySearchTool.definition.name).toBe('history_search');
      const schema = historySearchTool.definition.inputSchema as Record<string, unknown>;
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.query).toBeDefined();
      expect(props.keywords).toBeDefined();
      expect(props.scope).toBeDefined();
      expect(props.time_range).toBeDefined();
      expect(props.top_k).toBeDefined();
      // query/keywords 非 required（spec §2 二选一在 run 内校验）
      const required = (schema.required as string[]) ?? [];
      expect(required).not.toContain('query');
      expect(required).not.toContain('keywords');
    });

    it('description 含 history_get_context 引导', () => {
      expect(historySearchTool.definition.description).toContain('history_get_context');
    });
  });

  describe('query/keywords 二选一校验', () => {
    it('两者都缺 → 错误提示（isError=false 友好提示，不抛错）', async () => {
      const r = await historySearchTool.run({}, ctxOf());
      expect(r.isError).toBe(false);
      expect(textOf(r)).toContain('query 和 keywords 至少提供');
    });

    it('仅 query → 透传 searchEngine', async () => {
      const se = mockSearchEngine(SAMPLE_HITS);
      await historySearchTool.run({ query: '打包方案' }, ctxOf({ searchEngine: se }));
      expect(se.calls).toHaveLength(1);
      expect(se.calls[0]!.query).toBe('打包方案');
    });

    it('仅 keywords → query="" 仍走检索', async () => {
      const se = mockSearchEngine(SAMPLE_HITS);
      await historySearchTool.run(
        { keywords: ['dmg', 'asar'] },
        ctxOf({ searchEngine: se }),
      );
      expect(se.calls).toHaveLength(1);
      expect(se.calls[0]!.opts.keywords).toEqual(['dmg', 'asar']);
    });

    it('query 空白字符串 + 无 keywords → 友好提示', async () => {
      const r = await historySearchTool.run({ query: '   ' }, ctxOf());
      expect(textOf(r)).toContain('query 和 keywords 至少提供');
    });

    it('keywords 非数组 / 含空字符串 → 过滤', async () => {
      const se = mockSearchEngine(SAMPLE_HITS);
      await historySearchTool.run(
        // 故意传非 string 元素 + 空字符串
        { keywords: ['dmg', '', 123 as unknown as string] },
        ctxOf({ searchEngine: se }),
      );
      expect(se.calls[0]!.opts.keywords).toEqual(['dmg']);
    });
  });

  describe('无命中', () => {
    it('空 hits → 友好提示（不抛错）', async () => {
      const r = await historySearchTool.run(
        { query: '不存在的关键字' },
        ctxOf({ searchEngine: mockSearchEngine([]) }),
      );
      expect(r.isError).toBe(false);
      expect(textOf(r)).toContain('未找到匹配');
    });
  });

  describe('formatHits 含锚点', () => {
    it('每条含 messageId + sessionId + role', () => {
      const text = formatHits(SAMPLE_HITS);
      expect(text).toContain('找到 2 条匹配');
      expect(text).toContain('session=01SESSION001');
      expect(text).toContain('msg=01HV0000000000000000000001');
      expect(text).toContain('role=user');
      expect(text).toContain('session=01SESSION002');
      expect(text).toContain('role=assistant');
      // snippet 内容透出
      expect(text).toContain('dmg');
      expect(text).toContain('better-sqlite3');
    });

    it('sessionTitle 透出（有值时）', () => {
      const text = formatHits(SAMPLE_HITS.slice(0, 1));
      expect(text).toContain('title="打包讨论"');
    });

    it('sessionTitle 为 null 时不输出 title 行', () => {
      const text = formatHits([SAMPLE_HITS[1]!]);
      expect(text).not.toContain('title=');
    });
  });

  describe('scope 透传', () => {
    it('scope=all → opts 无 scope/currentSession', async () => {
      const se = mockSearchEngine(SAMPLE_HITS);
      await historySearchTool.run(
        { query: 'x', scope: 'all' },
        ctxOf({ searchEngine: se, sessionId: 'S-CURRENT' }),
      );
      expect(se.calls[0]!.opts.scope).toBeUndefined();
      expect(se.calls[0]!.opts.currentSession).toBeUndefined();
    });

    it('scope=exclude_current → currentSession 取自 ctx.config.sessionId', async () => {
      const se = mockSearchEngine(SAMPLE_HITS);
      await historySearchTool.run(
        { query: 'x', scope: 'exclude_current' },
        ctxOf({ searchEngine: se, sessionId: 'S-CURRENT' }),
      );
      expect(se.calls[0]!.opts.scope).toBe('exclude_current');
      expect(se.calls[0]!.opts.currentSession).toBe('S-CURRENT');
    });

    it('scope=exclude_current 但 sessionId 缺失 → 不传 scope（safe fallback）', async () => {
      // 业务上 agent 总有 sessionId；此用例验证极端场景的 safe fallback（防 scope 透传无 currentSession）
      const se = mockSearchEngine(SAMPLE_HITS);
      const ctx = ctxOf({ searchEngine: se });
      // 显式删 sessionId 模拟缺失场景
      delete (ctx.config as { sessionId?: string }).sessionId;
      await historySearchTool.run({ query: 'x', scope: 'exclude_current' }, ctx);
      expect(se.calls[0]!.opts.scope).toBeUndefined();
      expect(se.calls[0]!.opts.currentSession).toBeUndefined();
    });
  });

  describe('top_k', () => {
    it('默认 8（未传 → opts.topK=8）', async () => {
      const se = mockSearchEngine(SAMPLE_HITS);
      await historySearchTool.run({ query: 'x' }, ctxOf({ searchEngine: se }));
      expect(se.calls[0]!.opts.topK).toBe(8);
    });

    it('上限 50 保护（传 100 → 截到 50）', async () => {
      const se = mockSearchEngine(SAMPLE_HITS);
      await historySearchTool.run(
        { query: 'x', top_k: 100 },
        ctxOf({ searchEngine: se }),
      );
      expect(se.calls[0]!.opts.topK).toBe(50);
    });

    it('负数 / 非数字 → 走默认 8', async () => {
      const se = mockSearchEngine(SAMPLE_HITS);
      await historySearchTool.run(
        { query: 'x', top_k: -5 },
        ctxOf({ searchEngine: se }),
      );
      expect(se.calls[0]!.opts.topK).toBe(8);

      const se2 = mockSearchEngine(SAMPLE_HITS);
      await historySearchTool.run(
        { query: 'x', top_k: 'abc' },
        ctxOf({ searchEngine: se2 }),
      );
      expect(se2.calls[0]!.opts.topK).toBe(8);
    });
  });

  describe('time_range 透传', () => {
    it('ISO 时间透传 after/before', async () => {
      const se = mockSearchEngine(SAMPLE_HITS);
      await historySearchTool.run(
        { query: 'x', time_range: { after: '2026-07-01T00:00:00Z', before: '2026-07-31T00:00:00Z' } },
        ctxOf({ searchEngine: se }),
      );
      expect(se.calls[0]!.opts.after).toBe('2026-07-01T00:00:00Z');
      expect(se.calls[0]!.opts.before).toBe('2026-07-31T00:00:00Z');
    });

    it('空对象 time_range → 不透传 after/before', async () => {
      const se = mockSearchEngine(SAMPLE_HITS);
      await historySearchTool.run(
        { query: 'x', time_range: {} },
        ctxOf({ searchEngine: se }),
      );
      expect(se.calls[0]!.opts.after).toBeUndefined();
      expect(se.calls[0]!.opts.before).toBeUndefined();
    });
  });

  describe('historyToolDeps 缺失', () => {
    it('historyToolDeps 未注入 → RUNTIME_ERROR (isError=true)', async () => {
      const r = await historySearchTool.run({ query: 'x' }, ctxOf({ omitDeps: true }));
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('historyToolDeps not injected');
    });
  });
});
