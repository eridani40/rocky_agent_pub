/**
 * plugin_scope entity 的 SchemaDef — scope 一等实体（v0.0.26 F1）
 * 参考: specs/tech/config/[P0]ext_impl_scope.md §2（PluginScopeSchema）
 *       specs/tech/persistence/[P0]schema_interface.md §2（SchemaDef 约定）
 *
 * 设计：
 *   - scope 是独立 entity，存 scope **元数据**（id/name/description/createdAt）
 *   - default scope 系统启动时 bootstrap 确保存在（不可删）；非 default 可动态创建
 *   - 该 scope 下的 impl 配置（enabled/order/configValues）存独立 entity plugin_policy（§4）
 *   - per-EP 激活记录存独立 entity ext_impl_scope_activation（§3，D1）
 *
 * Spec gap 修正（persistence 约束）：
 *   - spec §2 原文 `id:{type:'string'}`（业务 scope id）+ `dirTemplate:'plugin_scope/'`（不分片）+ `createdAt` 业务字段
 *   - 但 persistence 强制：id 必须是 ulid（schema-validation §3）+ dirTemplate 必须含 {shardKey}
 *     （fs-paths resolveDirTemplate）+ createdAt/updatedAt/version 是信封保留名（schema 禁声明）
 *   - 修正方案（对齐既有 plugin_policy/app_config 范式）：
 *       · `id` = ULID 物理主键（persistence 强制）
 *       · 新增业务字段 `scopeId`（snake_case 业务 id，同 entity 内唯一，对应 spec §2 的 id 语义）
 *       · 按 scopeId 分片（dirTemplate 含 {shardKey}），落盘 {root}/plugin_scope/{scopeId}/<ulid>.json
 *       · createdAt 不声明（信封自动注入，语义等价）
 *   - 落盘语义：每 scope 一目录（scopeId 命名），目录内一个 json（ULID 文件名）
 *     → spec §2 「每 scope 一份 json，文件名 = id（scope id）」由「目录名 = scopeId」等价表达
 *   - D5「scope 总数有限」语义保留：scope 数量小，分片不引入性能问题
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * plugin_scope entity 的 SchemaDef。
 * 落盘路径：{root}/plugin_scope/{scopeId}/<id>.json（每 scope 一个 shard 目录）。
 */
export const PluginScopeSchema = {
  entity: 'plugin_scope',
  engine: 'file',
  fs: {
    sharding: {
      /** 按 scopeId 分片（满足 fs-paths dirTemplate 必须含 {shardKey} 约束；每 scope 一目录便于隔离） */
      shardKeyField: 'scopeId',
      dirTemplate: 'plugin_scope/{shardKey}/',
    },
    format: 'json',
  },
  fields: {
    /** ULID 主键（persistence 保留名，业务生成） */
    id: { type: 'ulid', required: true },
    /** scope 业务 id（snake_case，default 常驻不可删；非 default 可创建）；同 entity 内唯一 */
    scopeId: { type: 'string', required: true },
    /** 显示名（如「Default」/「快速对话」） */
    name: { type: 'string', required: true },
    /** 说明（可选） */
    description: { type: 'string', required: false },
    // createdAt 不声明：信封保留名，store 自动注入（等价 spec §2 的 createdAt 业务字段）
  },
} as const satisfies SchemaDef;

/** plugin_scope 记录类型（从 SchemaDef 派生；信封 createdAt/updatedAt/version 由 store 注入） */
export type PluginScopeRecord = InferRecord<typeof PluginScopeSchema>;
