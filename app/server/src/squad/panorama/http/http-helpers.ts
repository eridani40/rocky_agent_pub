/**
 * panorama HTTP helpers —— json 响应 + caller 身份解析
 *
 * panorama HTTP 端点自包含的 HTTP 工具（不依赖 board handlers）。
 * caller 身份经 header 传（x-caller-role/x-caller-member/x-message-id），与 panorama_http.md §5 对齐。
 */

/** 通用 JSON 响应（带可选 Allow 头，DELETE/POST 405 用） */
export function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Caller 身份（panorama_http.md §5 权限/越权 403）。
 * HTTP 无 session context（不像 LLM 工具走 rtc），通过 header 传递：
 *   - x-caller-role: 'leader' | 'mate' | 'user'（缺省 'user'，UI 用户驱动等同 leader 写权）
 *   - x-caller-member: memberId（mate 必填）
 *   - x-message-id: ULID（缺省 undefined；写入 store lastWriteMessageId 驱动 reminder 变化检测）
 *
 * 设计：UI 默认无 header → role='user' → 全写权（用户驱动编辑等同 leader）。
 * mate 走显式 header（由 UI mate-session 路径注入）。
 */
export interface CallerCtx {
  role: 'leader' | 'mate' | 'user';
  memberId?: string;
  messageId?: string;
}

/** 从 Request headers 解析 caller 身份（缺省 role='user'）。 */
export function readCallerCtx(req: Request): CallerCtx {
  const roleRaw = req.headers.get('x-caller-role');
  const memberRaw = req.headers.get('x-caller-member');
  const msgRaw = req.headers.get('x-message-id');
  const role: CallerCtx['role'] =
    roleRaw === 'leader' || roleRaw === 'mate' ? roleRaw : 'user';
  return {
    role,
    ...(memberRaw ? { memberId: memberRaw } : {}),
    ...(msgRaw ? { messageId: msgRaw } : {}),
  };
}
