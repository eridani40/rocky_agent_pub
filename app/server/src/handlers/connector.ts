/**
 * connector handlers — /config/connectors GET/PUT
 * 参考: specs/api/overall/03-config-center.md §3.6（连接器端点组）
 *       specs/tech/config/[P1]connectors.md §2-§5（双状态机 + ConnectorManager）
 *
 * 设计（双状态机异步迁移，spec §3.6）：
 *   - GET /config/connectors → 200 + { items: ConnectorState[] }（所有连接器实时态）
 *   - PUT /config/connectors/:id body {enable:boolean} → 202 + {ok:true}
 *     （fire-and-forget：派发 enable/disable，状态异步迁移；客户端轮询 GET 看终态）
 *
 * 错误：
 *   - 400 body 非 {enable:boolean} / :id 非法（非 'browser'）
 *   - 405 非 GET/PUT
 *   - 500 ConnectorManager 未注入 enable/disable（缺能力）
 *
 * 与 handleKvConfig/handlePluginConfig 的差异：连接器是双状态机（switch intent + connection
 * 运行时态），PUT 不直接落盘值，而是派发 enable/disable 触发 ConnectorManager 异步迁移。
 */
import type { ConnectorManager, ConnectorId } from '../tools/browser/connector-manager';

/** 构造 JSON Response（可选 Allow 头，405 类响应附带） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/** 合法 connector id 集合（仅 browser） */
const VALID_CONNECTOR_IDS = new Set<ConnectorId>(['browser']);

/** PUT /config/connectors/:id 请求体 */
interface ConnectorPutBody {
  enable?: unknown;
}

/**
 * 处理 GET /config/connectors：返所有连接器实时态。
 * @param cm ConnectorManager 实例（必须有 getAll）
 */
export function handleConnectorList(cm: ConnectorManager): Response {
  if (!cm.getAll) {
    return json(500, { error: 'connector manager not fully wired (no getAll)' });
  }
  return json(200, { items: cm.getAll() });
}

/**
 * 处理 PUT /config/connectors/:id：派发 enable/disable（fire-and-forget）。
 *
 * 异步迁移：返 202 后 ConnectorManager 在后台进 connecting/error，客户端轮询 GET 看终态。
 * 不 await enable/disable 完成（spec §3.6 双状态机异步语义），失败由 connection=error 反映。
 *
 * @param id connector id（path 参数，必须属 VALID_CONNECTOR_IDS）
 * @param body 请求体 {enable:boolean}
 * @param cm ConnectorManager 实例（必须有 enable/disable）
 */
export async function handleConnectorToggle(
  id: string,
  body: ConnectorPutBody,
  cm: ConnectorManager,
): Promise<Response> {
  // :id 校验（仅 browser）
  if (!VALID_CONNECTOR_IDS.has(id as ConnectorId)) {
    return json(400, { error: `unknown connector id: ${id}` });
  }
  const connectorId = id as ConnectorId;
  // body 校验：{enable:boolean}
  if (typeof body.enable !== 'boolean') {
    return json(400, { error: 'body requires { enable: boolean }' });
  }
  // 派发：enable=true → cm.enable；enable=false → cm.disable
  // fire-and-forget：不 await 完成（后台异步迁移状态机），返 202 立即响应。
  const op = body.enable ? cm.enable : cm.disable;
  if (!op) {
    return json(500, {
      error: `connector manager missing ${body.enable ? 'enable' : 'disable'} capability`,
    });
  }
  // 异步触发，不阻塞响应；catch 防 unhandled rejection（错误已落 connection=error）
  void op.call(cm, connectorId).catch(() => {
    /* 状态机已落 error 态，错误吞掉避免 unhandled rejection */
  });
  return json(202, { ok: true });
}

/**
 * 路由分发 /config/connectors（list）+ /config/connectors/:id（toggle）。
 *
 * @param req Request
 * @param method HTTP method（GET/PUT）
 * @param path 完整路径（如 /config/connectors 或 /config/connectors/browser）
 * @param cm ConnectorManager 实例
 */
export async function handleConnectorRoute(
  req: Request,
  method: string,
  path: string,
  cm: ConnectorManager,
): Promise<Response> {
  // /config/connectors（无 :id）
  if (path === '/config/connectors') {
    if (method === 'GET') return handleConnectorList(cm);
    return json(405, { error: 'Method Not Allowed' }, 'GET');
  }
  // /config/connectors/:id
  const match = path.match(/^\/config\/connectors\/([^/]+)$/);
  if (match) {
    if (method !== 'PUT') {
      return json(405, { error: 'Method Not Allowed' }, 'PUT');
    }
    let body: ConnectorPutBody;
    try {
      body = (await req.json()) as ConnectorPutBody;
    } catch {
      return json(400, { error: 'invalid json body' });
    }
    return handleConnectorToggle(match[1]!, body, cm);
  }
  return json(404, { error: 'Not Found' });
}
