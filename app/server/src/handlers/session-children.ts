/**
 * GET /session/:id/children handler —— children/swarm 列表
 * 参考: specs/api/overall/10-multi-agent.md §3（GET /session/:id/children 契约）
 *       specs/tech/multi_agent/[P1]subagent_derivation.md §7（list_children 同源逻辑）
 *
 * 返 ChildrenView { parentSessionId, running[], terminated[] }（按 state 分组，组内 updatedAt desc）。
 * - query status?: 'running' | 'terminated'（未请求组返 []）
 * - query limit?: [1,100]（单组按 updatedAt desc 截断，缺省 20）
 * - parent 不存在 → 404
 * - status 非 running/terminated → 400；limit 非 [1,100] → 400
 *
 * 数据源：store.listChildren（与 agent.query LLM 工具同源，api §3.4）。
 */
import type { SessionHandlerDeps } from './session';

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 处理 GET /session/:id/children（api 10-multi-agent §3）。
 *
 * @param _req    Request（本端点 GET 无 body）
 * @param method  HTTP method（非 GET → 405）
 * @param id      parent sessionId
 * @param deps    SessionHandlerDeps（用 store.listChildren）
 * @param url     URL（取 query string）
 */
export async function handleSessionChildren(
  _req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
  url: URL,
): Promise<Response> {
  if (method !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }
  // parent 存在性校验（404）
  const parent = await deps.store.getSession(id);
  if (!parent) {
    return json(404, { error: 'session not found' });
  }

  // query 解析 + 校验
  const statusParam = url.searchParams.get('status');
  if (statusParam !== null && statusParam !== 'running' && statusParam !== 'terminated') {
    return json(400, { error: 'status must be "running" or "terminated"' });
  }
  const limitParam = url.searchParams.get('limit');
  let limit = 20;
  if (limitParam !== null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      return json(400, { error: 'limit must be an integer in [1,100]' });
    }
    limit = n;
  }

  const view = await deps.store.listChildren(id, {
    ...(statusParam ? { status: statusParam } : {}),
    limit,
  });
  return json(200, view);
}
