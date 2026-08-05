/**
 * history_search 工具（read-only，FTS5 BM25 历史召回）
 * 参考: specs/tech/agent/tools/[P1]history_search_tool.md（契约）
 *       specs/tech/version_logs/v0.0.126/change_plan.md 模块4 §historySearchTool
 *       specs/tech/persistence/[P1]search_engine.md §3.5（检索语义）
 *
 * 设计：
 *   - read-only / 免审批：profile toolBound 登记即用，不进 HITL 队列
 *   - query/keywords 二选一校验在 run 内（schema 不标 required，LLM 可更灵活）
 *   - 调 ctx.config.historyToolDeps.searchEngine.search()（spec 用对象单参；代码用 (query, opts) 双参 —
 *     见 decisions: SearchEngine.search 签名与 spec 偏离）
 *   - 输出格式含 messageId/sessionId 锚点（LLM 据此调 history_get_context）
 */
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from './types';
import { errorResult, textResult } from './types';
import type { SearchEngine, HistorySearchHit, SearchOptions } from '../persistence/search-engine';

/** history 工具运行时依赖（与 history_get_context 共用）。bootstrap 装配注入。 */
export interface HistoryToolDeps {
  searchEngine: SearchEngine;
  /** 只读类型，实际是 SessionStore（鸭子类型，仅需 getMessages） */
  sessionStore: {
    getMessages(
      sessionId: string,
      range?: { beforeId?: string; fromId?: string; upToId?: string; limit?: number },
    ): Promise<{ items: unknown[]; hasMore: boolean }>;
  };
}

/** history_search 工具输入（宽松类型，run 内做判型校验） */
interface HistorySearchInput {
  query?: unknown;
  keywords?: unknown;
  scope?: unknown;
  time_range?: unknown;
  top_k?: unknown;
}

/** 从 ToolCtx 取 historyToolDeps（鸭子 downcast）；history_get_context tool 复用 */
export function resolveHistoryDeps(ctx: ToolCtx): HistoryToolDeps | undefined {
  const d = ctx.config.historyToolDeps as Partial<HistoryToolDeps> | undefined;
  if (!d || !d.searchEngine || !d.sessionStore) return undefined;
  return d as HistoryToolDeps;
}

/** 把 time_range 入参（{after?, before?}）规范化为 SearchOptions.after/before */
function parseTimeRange(raw: unknown): { after?: string; before?: string } {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as { after?: unknown; before?: unknown };
  const out: { after?: string; before?: string } = {};
  if (typeof obj.after === 'string' && obj.after) out.after = obj.after;
  if (typeof obj.before === 'string' && obj.before) out.before = obj.before;
  return out;
}

/**
 * history_search 工具（单例导出，registry.defaultTools 引用）。
 * inputSchema 与 history_search_tool.md §2 一字不差；run 调 SearchEngine.search(query, opts)（双参）。
 */
export const historySearchTool: Tool = {
  definition: {
    name: 'history_search',
    description:
      'Search past conversation history (transcript-level) by a sentence and/or keywords. ' +
      'Use when the user mentions past discussions ("what we talked about last week", "previously discussed X") ' +
      'OR when you cannot find what they refer to in the current context window (it may have been compacted out). ' +
      'Returns matching snippets + session/message anchors you can resolve via history_get_context.',
    intro: 'Search past conversation history by keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自然语言一句话（推荐）' },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '关键词数组（OR boost）',
        },
        scope: {
          type: 'string',
          enum: ['all', 'exclude_current'],
          default: 'all',
          description:
            'all=也索当前 session（可找回 compact 内容）；exclude_current=agent 自查历史时排除当前',
        },
        time_range: {
          type: 'object',
          properties: {
            after: { type: 'string', description: 'ISO 时间或 ULID 下界（含）' },
            before: { type: 'string', description: 'ISO 时间或 ULID 上界（不含）' },
          },
        },
        top_k: { type: 'number', default: 8, minimum: 1, maximum: 50 },
      },
    },
  },

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    const deps = resolveHistoryDeps(ctx);
    if (!deps) {
      return errorResult(
        '[history_search] runtime error: historyToolDeps not injected',
      );
    }

    const typed = input as HistorySearchInput;

    // query / keywords 至少一个（run 内校验，非 schema required）
    const query = typeof typed.query === 'string' ? typed.query.trim() : '';
    const keywords = Array.isArray(typed.keywords)
      ? typed.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      : [];
    if (!query && keywords.length === 0) {
      return textResult('history_search: query 和 keywords 至少提供一个');
    }

    // scope 透传：exclude_current 需 currentSession（从 ctx.config.sessionId 读）
    const scopeRaw = typeof typed.scope === 'string' ? typed.scope : 'all';
    const sessionId = ctx.config.sessionId;
    const opts: SearchOptions = {
      keywords: keywords.length > 0 ? keywords : undefined,
      ...(scopeRaw === 'exclude_current' && sessionId
        ? { scope: 'exclude_current', currentSession: sessionId }
        : {}),
      ...parseTimeRange(typed.time_range),
      topK: typeof typed.top_k === 'number' && typed.top_k > 0
        ? Math.min(50, Math.floor(typed.top_k))
        : 8,
    };

    // SearchEngine.search 同步返回（spec §3.5）
    const hits = deps.searchEngine.search(query, opts);
    // [history_search] 临时验证 log：tool 调用入参 + 返回数
    try {
      console.log(
        `[history_search] tool called: query=${JSON.stringify(query)}, ` +
          `keywords=${JSON.stringify(keywords)}, scope=${scopeRaw}, topK=${opts.topK ?? '?'}, ` +
          `sessionId=${sessionId ?? '?'}, hits=${hits.length}`,
      );
    } catch {
      // log 本身不抛错
    }
    if (hits.length === 0) {
      return textResult('历史会话中未找到匹配内容。可尝试更换关键词或 refine 查询。');
    }
    return textResult(formatHits(hits));
  },
};

/**
 * 把 HistorySearchHit[] 格式化成 LLM 可读纯文本。
 * 每条含 messageId + sessionId 锚点（LLM 据此调 history_get_context）。
 * 与 history_search_tool.md §3 输出格式对齐。
 */
export function formatHits(hits: HistorySearchHit[]): string {
  const lines: string[] = [`找到 ${hits.length} 条匹配：`];
  hits.forEach((h, i) => {
    const tsLabel = h.timestamp ? `  ts=${h.timestamp}` : '';
    const title = h.sessionTitle ? `  title="${h.sessionTitle}"` : '';
    lines.push(
      `[${i + 1}] session=${h.sessionId}  msg=${h.messageId}  role=${h.role}${tsLabel}${title}`,
    );
    lines.push(`   ${h.snippet.replace(/\n/g, ' ')}`);
  });
  return lines.join('\n');
}
