/**
 * session-read handler — POST /session/:id/read 标读端点
 * 参考: specs/api/overall/04-agent-session.md §2.3.1（端点契约 + GET 纯读对比）
 *       specs/tech/agent/session/[P0]session_state.md §6（explicit-bool 模型 + 唯一消除入口）
 *       specs/tech/agent/session/[P0]session_event.md §2/§3（session_read_update 触发时机）
 *
 * 职责：调 store.markRead(id)（CAS unread=true→false + 内部 emit session_read_update）
 *   → 200 {ok:true, session:<Session unread=false>}；session 不存在 → 404。
 *
 * 幂等（spec §2.3.1）：unread 已是 false 时 CAS 0 行，markRead 返 false 不发事件，handler 仍返 200。
 *
 * 不持有依赖：复用 session.ts 的 SessionHandlerDeps（router 透传）。
 */
import type { SessionHandlerDeps } from './session';

/** 构造 JSON Response */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * 处理 POST /session/:id/read — 标记 session 已读（清未读）。
 *
 * @param req    入站 Request（body 忽略，spec §2.3.1 空 body）
 * @param method HTTP 方法（仅 POST，其他 → 405）
 * @param id     session id
 * @param deps   handler 依赖（store.markRead）
 * @returns 200 {ok:true, session} / 404 session 不存在 / 405 非 POST
 */
export async function handleSessionRead(
  _req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' }, 'POST');
  }
  // 先确认 session 存在（不存在 → 404；CAS 也能感知但 404 语义更清晰）
  const existing = await deps.store.getSession(id);
  if (!existing) return json(404, { error: 'session not found' });

  // markRead：CAS unread=true→false；CAS 0 行（已 false）幂等 no-op 不发事件，仍返 200
  await deps.store.markRead(id);

  // 重新读取，确保返回最新 Session（unread 必为 false）
  const session = await deps.store.getSession(id);
  return json(200, { ok: true, session });
}
