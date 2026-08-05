/**
 * session usage handler — GET /session/:id/usage 只读端点
 * 参考: specs/api/overall/04-agent-session.md §6（GET /session/:id/usage 契约）
 *       specs/tech/agent/session/[P0]session_usage.md §8（SessionUsageView）
 *
 * 职责：
 *   - GET /session/:id/usage：调 sessionStore.getUsageView(sid) → 返 SessionUsageView
 *     含 ContextWindowUsage 7 字段 + 三分区 AccumulatedUsage + 4 cacheRate 派生字段
 *
 * 不直接持有依赖：经 SessionHandlerDeps 注入 SessionStore（session.ts 定义并 re-export）。
 * 用途：usage 面板打开时 GET 一次拉全量，之后靠 SSE session_usage_update 增量刷新。
 */
import type { SessionHandlerDeps } from './session';

/** 构造 JSON Response（可选 Allow 头，405 类响应附带） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * 处理 GET /session/:id/usage — 返 SessionUsageView 全字段。
 * spec api §6：
 *   - 200 + SessionUsageView（ContextWindowUsage 7 字段 + 三分区 AccumulatedUsage + 4 cacheRate）
 *   - 404 session 不存在
 *   - 405 非 GET
 *
 * @param _req Request（GET /usage 无请求体）
 * @param method HTTP 方法（用于 405 判定）
 * @param id session id（path param）
 * @param deps SessionHandlerDeps（用 store.getUsageView）
 */
export async function handleSessionUsage(
  _req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'GET') {
    return json(405, { error: 'Method Not Allowed' }, 'GET');
  }
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });
  // getUsageView 内部 normalize：缺字段 record 兜底（旧 3 字段 ContextWindowUsage 补全 7 字段）
  const usage = await deps.store.getUsageView(id);
  return json(200, usage);
}
