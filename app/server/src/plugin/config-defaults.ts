/**
 * config-defaults — manifest configSchema → default 底座提取（共享 util）
 * 参考: specs/tech/plugin_system/[P0]ext_impl_and_manifest_interface.md §4（default 位置）
 *       specs/tech/version_logs/v0.0.71/change_plan.md 模块 5（bug-A JOIN default 复用本 util）
 *
 * 设计：
 *   - BUG-003 修复（v0.0.14）：default 值在 `properties.{key}.default`（不在顶层 `configSchema.default`）
 *   - v0.0.71 bug-A：inventory-builder.buildExtImplNode JOIN manifest default 进 ExtImplNode.config
 *     字段（per-domain 默认表对齐 spec），与 plugin-manager.instantiate 用同一算法（DRY）
 *
 * 抽出独立 util（v0.0.71）：原为 plugin-manager.ts 内部 function，bug-A 修复后 inventory-builder
 * 也需消费。抽出共享避免重复实现（change_plan 模块 5 MUST extractConfigDefaults 复用约束）。
 * plugin-manager.ts 可后续 refactor 改 import 本 util（T4 收尾）。
 */

/**
 * 从 manifest configSchema 提取 default 底座（per-key `{key: default}` 平铺）。
 *
 * 算法：
 *   - 无 configSchema / 无 properties → 返空对象
 *   - 遍历 properties.{key}：含 `default` 字段则拍平到输出
 *
 * @param configSchema manifest 声明的 JSON Schema（impl 级 configSchema）
 * @returns `{key: default}` 平铺对象（实例化 / inventory JOIN 用底座）
 */
export function extractConfigDefaults(configSchema: unknown): Record<string, unknown> {
  if (!configSchema || typeof configSchema !== 'object') return {};
  const props = (configSchema as { properties?: Record<string, unknown> }).properties;
  if (!props || typeof props !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    if (def && typeof def === 'object' && 'default' in def) {
      out[key] = (def as { default: unknown }).default;
    }
  }
  return out;
}
