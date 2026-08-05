/**
 * History Search HTTP Handler —— GET /history/search
 * 参考: specs/api/overall/19-history-search.md §1-§2（端点契约 + 行为细节）
 *       specs/tech/version_logs/v0.0.126/change_plan.md 模块5（router + handler 行）
 *
 * 职责：
 *   - 解析 query 参数（q/keywords/scope/current_session/after/before/top_k/debug）
 *   - 校验：q 和 keywords 至少一个（缺 → 400 BAD_REQUEST）；scope=exclude_current 时 current_session 必填
 *     （缺 → 400）；top_k 非法（非 1..50 → 400）
 *   - 委托 SearchEngine.search / searchWithDebug → 序列化 {hits:[...], meta:{...}} 响应
 *
 * 不含业务逻辑：sanitize / bm25 / recency 在 SearchEngine 内；本层只解析+校验+序列化。
 * 一期无 gate（公开访问，spec §3）；二期若加 auth/限额再补。
 */
import type { SearchEngine, SearchOptions, HistorySearchHit } from '../persistence/search-engine';

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** top_k 默认值（spec §1：default 8） */
const DEFAULT_TOP_K = 8;
/** top_k 范围（spec §1：1..50） */
const MIN_TOP_K = 1;
const MAX_TOP_K = 50;

/** 校验失败错误体：{ code:'BAD_REQUEST', message, detail? }（对齐 04-agent-session.md 错误惯例） */
function badRequest(message: string, detail?: Record<string, unknown>): Response {
  return json(400, { code: 'BAD_REQUEST', message, ...(detail ? { detail } : {}) });
}

/**
 * CSV 解析为关键词数组：逗号分隔 → string[]，过滤空串和重复（spec §2）。
 * 空串 / 全空白 → 空数组（不抛错，让 caller 走「q 和 keywords 都缺」分支）。
 */
export function _parseKeywords(csv: string | null): string[] {
  if (!csv) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of csv.split(',')) {
    const k = raw.trim();
    if (k.length === 0) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/**
 * 解析时间范围参数（after / before）。
 * 接受 ISO 时间字符串 或 ULID（spec §1 + §2）。
 * 一期实现：不转 ULID，原样透传给 SearchEngine（SQL 用字典序比较；
 *   ISO 字符串与 ULID 字典序不一致，但 chunks.ts 存的是 ULID，故 ISO 参数实际作为「字符串下界」，
 *   在 ULID 序中可能无意义命中——这是 spec 留给二期完善的开放点）。
 * coder 决策：一期保持简单透传（ULID 直接比较语义正确；ISO 输入用户应自行转 ULID 或用 ULID）。
 * @returns 规范化后的 { after?, before? }，空/空白过滤掉
 */
export function _parseTimeRange(
  after: string | null,
  before: string | null,
): { after?: string; before?: string } {
  const out: { after?: string; before?: string } = {};
  if (after && after.trim().length > 0) out.after = after.trim();
  if (before && before.trim().length > 0) out.before = before.trim();
  return out;
}

/**
 * 解析 top_k 参数（字符串 → number；范围 1..50；非法 → null 表示校验失败）。
 */
function _parseTopK(raw: string | null): { ok: true; value: number } | { ok: false; reason: string } {
  if (raw === null || raw.trim() === '') return { ok: true, value: DEFAULT_TOP_K };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, reason: `top_k 非整数: ${raw}` };
  }
  if (n < MIN_TOP_K || n > MAX_TOP_K) {
    return { ok: false, reason: `top_k 不在 ${MIN_TOP_K}..${MAX_TOP_K}: ${n}` };
  }
  return { ok: true, value: n };
}

/** 解析 debug=0|1 参数（default false；非 '1' 一律视为 false） */
function _parseDebug(raw: string | null): boolean {
  return raw === '1';
}

/**
 * GET /history/search handler（端点入口，spec §1 契约）。
 *
 * @param url 请求 URL（取 searchParams）
 * @param searchEngine 检索引擎实例（bootstrap 装配注入）
 * @returns JSON Response（200 含 hits+meta / 400 BAD_REQUEST / 500 INTERNAL）
 */
export async function handleHistorySearch(
  url: URL,
  searchEngine: SearchEngine,
): Promise<Response> {
  const params = url.searchParams;
  const q = params.get('q');
  const keywordsCsv = params.get('keywords');
  const scope = params.get('scope') ?? 'all'; // default 'all'（spec §1）
  const currentSession = params.get('current_session');
  const after = params.get('after');
  const before = params.get('before');
  const topKRaw = params.get('top_k');
  const debugRaw = params.get('debug');

  // 校验 1: q 和 keywords 至少一个（spec §1 错误表）
  const hasQ = q !== null && q.trim().length > 0;
  const keywords = _parseKeywords(keywordsCsv);
  if (!hasQ && keywords.length === 0) {
    return badRequest('q 和 keywords 至少提供一个');
  }

  // 校验 2: scope=exclude_current 时 current_session 必填（spec §1 错误表）
  if (scope === 'exclude_current' && (!currentSession || currentSession.trim().length === 0)) {
    return badRequest('scope=exclude_current 时 current_session 必填');
  }
  // scope 只允许 'all' | 'exclude_current'
  if (scope !== 'all' && scope !== 'exclude_current') {
    return badRequest(`scope 非法: ${scope}（允许 'all' | 'exclude_current'）`);
  }

  // 校验 3: top_k 范围 1..50（spec §1 错误表）
  const topKRes = _parseTopK(topKRaw);
  if (!topKRes.ok) return badRequest(topKRes.reason);

  const debug = _parseDebug(debugRaw);
  const timeRange = _parseTimeRange(after, before);

  // 组装 SearchOptions（SearchEngine.search 双参签名：query + opts）
  const opts: SearchOptions = {
    topK: topKRes.value,
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(scope === 'exclude_current' && currentSession
      ? { scope: 'exclude_current' as const, currentSession }
      : {}),
    ...(timeRange.after ? { after: timeRange.after } : {}),
    ...(timeRange.before ? { before: timeRange.before } : {}),
  };

  const startMs = Date.now();
  let hits: HistorySearchHit[];
  try {
    hits = debug
      ? searchEngine.searchWithDebug(q ?? '', opts)
      : searchEngine.search(q ?? '', opts);
  } catch (e) {
    // SearchEngine 内部异常（FTS5 不可用 / search.sqlite 损坏）→ 500 INTERNAL（spec §1）
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { code: 'INTERNAL', message: 'search engine error', detail: { reason: msg } });
  }
  const elapsedMs = Date.now() - startMs;

  // 序列化响应（spec §1 200 响应体）
  return json(200, {
    hits,
    meta: {
      total: hits.length,
      returned: hits.length,
      query: q ?? '',
      keywords,
      elapsedMs,
      debug,
    },
  });
}
