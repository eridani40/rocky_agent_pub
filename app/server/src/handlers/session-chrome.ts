/**
 * session-chrome handler — GET /session/:id/chrome（会话装饰同构接口）
 * 参考: specs/api/overall/04a-session-chrome.md §2/§6（端点契约 + 错误码）
 *
 * 职责：
 *   - GET：store.getSession 判存在（404）→ buildSessionChrome 组装（200）
 *   - 非 GET → 405（Allow: GET）
 *
 * 设计：独立 SessionChromeDeps（chrome 专用数据源集合），MUST NOT 膨胀 SessionHandlerDeps
 * （chrome 只读聚合 session + squad/classroom + app_config，与 agent 运行链无关）。
 * 降级语义在 buildSessionChrome 内保证（数据源缺失 → null/[]，不 throw 不 4xx）。
 */
import {
  buildSessionChrome,
  type ChromeSessionSource,
  type SessionChromeSources,
} from '../services/session-chrome';

/** 构造 JSON Response（可选 Allow 头，405 响应附带） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * chrome 端点依赖（独立接口，不复用 SessionHandlerDeps）。
 * store 结构子集（getSession 判存在 + 取装饰字段）；数据源四件套见 SessionChromeSources。
 */
export interface SessionChromeDeps extends SessionChromeSources {
  store: { getSession(id: string): Promise<ChromeSessionSource | null | undefined> };
}

/**
 * 处理 GET /session/:id/chrome。
 *
 * 响应：
 *   - 200 + SessionChromeView（含数据源降级：defaultModel/members 为 null/[]）
 *   - 404 session 不存在
 *   - 405 非 GET（Allow: GET）
 *
 * @param _req   Request（GET 无请求体）
 * @param method HTTP 方法（405 判定）
 * @param id     session id（path param）
 * @param deps   SessionChromeDeps
 */
export async function handleSessionChrome(
  _req: Request,
  method: string,
  id: string,
  deps: SessionChromeDeps,
): Promise<Response> {
  if (method !== 'GET') {
    return json(405, { error: 'Method Not Allowed' }, 'GET');
  }
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });
  const view = await buildSessionChrome(got, deps);
  return json(200, view);
}
