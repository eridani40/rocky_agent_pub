/**
 * config handlers — /config/{app,dev,plugin} 路由分发入口
 * 参考: specs/api/overall/02-llm-chat.md §4（三域 get-set）
 *       reqs/[done] v0.0.67.plugin_config_refactor/design.md §3 D4（PUT 端点删，配置只读化）
 *
 * 文件组成：
 *   - kv-config-handlers.ts：app/dev 通用 KV GET/PUT + secret PUT 占位 merge（GET 明文）
 *   - plugin-scope-handlers.ts：scope list / activation list（仅 GET）
 *   - 本文件：/config/plugin GET（inventory + scopeId query）；配置只读（无 PUT）
 *
 * KV 与 scope handler 通过 re-export 暴露，避免 router.ts 改动 import 路径（向后兼容）。
 *
 * plugin handler 设计（design §3 D4：PUT 端点返 405 Method Not Allowed 表「只读」语义）：
 *   - GET → { tree: PluginInventoryTree }（scopeId query 缺省 default 向后兼容）
 *   - 非 GET（PUT/POST/DELETE）→ 405 Method Not Allowed（路由层透传到本 handler，由 handler 统一返 405）
 *   - 错误：GET scopeId 不存在 → 400。
 */
// KV handler（app/dev）从独立文件 re-export（router.ts 仍 import { handleKvConfig } from './config'）
export { handleKvConfig, handleKvConfigPut, handleKvConfigDelete } from './kv-config-handlers';

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
 * 处理 /config/plugin 的 GET（只读，无 PUT）。
 * 透传 PluginConfigService.inventory() 返回（顶层 plugins[] + groups[]）。
 * scopeId query 缺省='default' 向后兼容；未激活 EP 取 default 视图由 service.inventory(scopeId) 处理。
 */
export async function handlePluginConfig(
  req: Request,
  method: string,
  url: URL,
  pluginSvc: PluginConfigService,
): Promise<Response> {
  if (method !== 'GET') {
    return json(405, { error: 'Method Not Allowed' });
  }
  const scopeId = url.searchParams.get('scopeId') ?? DEFAULT_SCOPE_ID;
  if (!pluginSvc.listScopes().some((s) => s.scopeId === scopeId)) {
    return json(400, { error: `scopeId "${scopeId}" 不存在` });
  }
  return json(200, { tree: pluginSvc.inventory(scopeId) });
}
