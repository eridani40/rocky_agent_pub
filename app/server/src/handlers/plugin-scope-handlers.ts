/**
 * plugin scope handlers — 仅读端点（listScopes + listActivations）
 * 参考: reqs/[done] v0.0.67.plugin_config_refactor/design.md §3 D4（写端点删）
 *       specs/tech/config/[P0]ext_impl_scope.md §6
 *
 * 设计（design §3 D4：写端点返 405 Method Not Allowed 表「只读」语义）：
 *   - 保留 GET：
 *       GET /config/plugin/scopes                → { items: PluginScope[] }
 *       GET /config/plugin/scopes/:id/activations → { items: [{ pointId }] }
 *   - 写端点（POST createScope / DELETE scope / POST activate / DELETE deactivate）：
 *       路由层透传 POST/DELETE 到本 handler，由 handler 返 405（统一只读语义）
 *
 * 路由注册：scope 端点（/config/plugin/scopes*）必须在通用 /config/plugin 之前注册
 * （见 router.ts，避免前缀匹配冲突）。
 */
import type { PluginConfigService } from '../plugin/plugin-config-service';
import { DEFAULT_SCOPE_ID } from '../plugin/plugin-scope-store';

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 处理 /config/plugin/scopes 的 GET（list scopes）。
 * scope 元信息从 ScopeConfigProvider 取（不读落盘）。
 */
export async function handlePluginScopes(
  req: Request,
  method: string,
  path: string,
  pluginSvc: PluginConfigService,
): Promise<Response> {
  // GET /config/plugin/scopes —— 列所有 scope（default 首位）
  if (method === 'GET' && path === '/config/plugin/scopes') {
    return json(200, { items: pluginSvc.listScopes() });
  }
  return json(405, { error: 'Method Not Allowed' });
}

/**
 * 处理 /config/plugin/scopes/:id/activations 的 GET（list activated EP）。
 *
 * spec §2.3：v0.0.206 起 default 同路径返 default.yaml 声明的激活 EP（plugin scope D6 已删，
 * default 无特权）；其他 scope 从代码声明（ScopeConfigProvider）取。
 * 本 handler 仅服务 GET 读路径。
 */
export async function handleScopeActivation(
  req: Request,
  method: string,
  path: string,
  pluginSvc: PluginConfigService,
): Promise<Response> {
  const actxMatch = path.match(/^\/config\/plugin\/scopes\/([^/]+)\/activations$/);
  if (method === 'GET' && actxMatch) {
    const scopeId = decodeURIComponent(actxMatch[1]!);
    // 非 default scope 不存在 → 404（default 无特权，同路径返 yaml 声明集）
    if (scopeId !== DEFAULT_SCOPE_ID && !pluginSvc.listScopes().some((s) => s.scopeId === scopeId)) {
      return json(404, { error: 'Not Found' });
    }
    const pointIds = pluginSvc.listActivatedPoints(scopeId);
    return json(200, { items: pointIds.map((pointId) => ({ pointId })) });
  }
  return json(405, { error: 'Method Not Allowed' });
}
