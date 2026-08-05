/**
 * session-pending-tool-call handler — GET /session/:id/pending-tool-call（v0.0.101 T4 新增）
 * 参考: specs/api/version_logs/v0.0.101.change_log.md §3.6
 *       specs/api/overall/04-agent-session.md §3.6
 *       specs/tech/version_logs/v0.0.101/change_plan.md 模块 F
 *
 * 职责：
 *   - 返当前 session 的 pendingToolCalls 队首（单个 PendingToolCall），只读 peek（不清空/不锁）。
 *   - 空队列返 200 + { pending: null }（非 404）。
 *   - recover 用：切走切回 / 重启后前端 onInit 主动拉（配合 SSE require_human_input sticky replay）。
 *
 * 设计：
 *   - 复用 store.peekPendingToolCall（只读快照，深拷贝防外层误改）。
 *   - 不 drain / 不 emit / 不锁；纯查询。
 */
import type { SessionHandlerDeps } from './session';

/** 构造 JSON Response（可选 Allow 头，405 类响应附带） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * 处理 GET /session/:id/pending-tool-call — 返悬挂队列队首。
 *
 * 响应：
 *   - 200 + `{ pending: PendingToolCall | null }`（空队列 null，非 404）
 *   - 404 session 不存在
 *   - 405 非 GET
 *
 * @param _req    Request（无请求体）
 * @param method  HTTP 方法（405 判定）
 * @param id      session id
 * @param deps    SessionHandlerDeps
 */
export async function handleSessionPendingToolCall(
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
  // peek 返深拷贝快照（session-pending-ops.ts 保证），无副作用
  const pending = await deps.store.peekPendingToolCall(id);
  return json(200, { pending });
}
