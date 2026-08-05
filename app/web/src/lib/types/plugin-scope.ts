/**
 * plugin-scope 类型 —— v0.0.26 ext-impl 配置层 scope 维度的前端类型契约。
 *
 * 参考:
 * - specs/tech/config/[P0]ext_impl_scope.md §2（PluginScope 一等实体）/ §7（PluginInventoryTree 扩展）
 * - specs/api/version_logs/v0.0.26/change_log.md §1.1（字段名 scopeId 约定）/ §3.1（inventory scope 视图）
 *
 * 字段名约定（与后端 API JSON 一致，注意区分）：
 * - `PluginScope`：scope 业务实体，业务 id 字段为 `scopeId`（与 PluginScopeStore interface 同源，
 *   api change_log §1.1 明确约定）。**非** `id`。
 * - `PluginScopeMeta`：inventory 顶层 `scope` 字段的简化形态（当前查询 scope 的元信息），
 *   按 api change_log §3.1 响应示例用 `id`/`name`/`description`（当前 scope 元信息，非 PluginScope 记录）。
 *
 * 该刻意区分已在 task 6 description + change_log §1.1 注释中明确：
 *   `tree.scope`（单数，当前 scope 元信息）用 `id`；
 *   `tree.scopes[]`（复数，PluginScope 记录列表）用 `scopeId`。
 */

/**
 * PluginScope —— scope 一等实体（API JSON 形态，业务 id 字段 = `scopeId`）。
 *
 * 对应 api change_log §1.1 响应示例 + tech §2 PluginScopeSchema（实体字段 id/name/description/createdAt），
 * JSON 序列化时业务 id 字段命名为 `scopeId`（与 PluginScopeStore interface 同源，避免与
 * inventory `scope.id` 元信息形态混淆）。
 */
export interface PluginScope {
  /** scope 业务 id（snake_case，'default' 常驻基线） */
  scopeId: string;
  /** 显示名（如「快速对话」「Default」） */
  name: string;
  /** 说明（可选；default 有「默认基线 scope」，其他 scope 可空） */
  description?: string;
  /** ISO8601 创建时间 */
  createdAt: string;
}

/**
 * PluginScopeMeta —— inventory 顶层 `scope` 字段的简化形态（当前查询 scope 的元信息）。
 *
 * 对应 api change_log §3.1 响应示例 `tree.scope: { id, name, description }`（**单数 scope**，
 * 当前查询的 scope 元信息，字段名 `id`，**非** scopeId）。与 `tree.scopes[]`（复数，
 * PluginScope 记录列表，字段名 `scopeId`）刻意区分。
 */
export interface PluginScopeMeta {
  /** 当前查询 scope 的 id（'default' 或其他 scope id） */
  id: string;
  /** 当前 scope 显示名 */
  name: string;
  /** 当前 scope 说明（default 为「默认基线 scope」） */
  description: string;
}
