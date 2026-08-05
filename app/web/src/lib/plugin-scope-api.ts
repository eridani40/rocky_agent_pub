/**
 * plugin-scope-api —— v0.0.67 起仅保留读端点（scope list / activation list）。
 *
 * v0.0.67 重构（用户指示「直接删写端点，无死代码」）：
 *   - 删写函数（createScope/deleteScope/activateEp/deactivateEp）
 *   - 保留读函数：listScopes / listActivations
 *
 * 从 api-client.ts 拆出（避免主文件超 300 行；类型在 types/plugin-scope.ts）。
 * 通过 api-client.ts re-export，旧 import 路径 `from './api-client'` 仍可用（零调用方改动）。
 */
import { req } from './api-client';
import type { PluginScope } from './types/plugin-scope';

/**
 * GET /config/plugin/scopes —— 列所有 scope（default 首位，按 createdAt 升序）。
 * 参考: specs/api/version_logs/v0.0.26/change_log.md §1.1
 */
export async function listScopes(base?: string): Promise<PluginScope[]> {
  const r = await req<{ items: PluginScope[] }>(
    '/config/plugin/scopes',
    undefined,
    base,
  );
  return r.items ?? [];
}

/**
 * GET /config/plugin/scopes/:id/activations —— 查某 scope 激活的 EP 列表（default 返全 EP）。
 * 参考: api change_log §2.3
 * @returns 激活的 pointId 列表（含 activatedAt 后续按需扩展）
 */
export async function listActivations(
  scopeId: string,
  base?: string,
): Promise<{ pointId: string; activatedAt?: string }[]> {
  const r = await req<{ items: { pointId: string; activatedAt?: string }[] }>(
    `/config/plugin/scopes/${encodeURIComponent(scopeId)}/activations`,
    undefined,
    base,
  );
  return r.items ?? [];
}
