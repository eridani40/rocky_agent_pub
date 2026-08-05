/**
 * ext_impl_scope_activation entity 的 SchemaDef — per-(scope,EP) 激活记录（v0.0.26 F3 D1）
 * 参考: specs/tech/config/[P0]ext_impl_scope.md §3（ScopeActivationSchema + D1 独立 entity）
 *
 * 设计（spec §3.2 选定 A — 独立 activation entity）：
 *   - 激活语义显式独立：activation 是「该 scope 此 EP 是否独立配置」的状态，与配置值正交
 *   - 支撑 snapshot 隔离（PRD UC-F3-1）：激活记录独立存在 → scope 此 EP 走自己的 plugin_policy record
 *   - 逻辑 key = (scopeId, pointId)：同 scope 内 pointId 唯一
 *   - 按 scopeId 分片（spec §3.2）：某 scope 激活的 EP 集中在一个 shard 目录，
 *     便于 cascade 删除（删 scope 时整 shard 目录清）
 *
 * D6（default scope 不写 activation record）：
 *   - default 全 EP 永远激活是运行时短路（scopeId==='default' 直接视为全激活）
 *   - 本 store 不主动为 default 写 activation；activateEp('default',...) 由 service 层拒绝
 *
 * Spec gap 修正（persistence 约束）：
 *   - spec §3.2 原文含 `createdAt` 业务字段；createdAt 是信封保留名，schema 禁声明
 *   - 修正：createdAt 不声明（信封自动注入），保留业务字段 activatedAt（激活时间，isoDate）
 *
 * 落盘路径：{root}/ext_impl_scope_activation/{scopeId}/<id>.json
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * ext_impl_scope_activation entity 的 SchemaDef。
 * 落盘路径：{root}/ext_impl_scope_activation/{scopeId}/<id>.json（按 scopeId 分片）。
 */
export const ScopeActivationSchema = {
  entity: 'ext_impl_scope_activation',
  engine: 'file',
  fs: {
    sharding: {
      /** 按 scopeId 分片（cascade 删 scope 时整 shard 目录清） */
      shardKeyField: 'scopeId',
      dirTemplate: 'ext_impl_scope_activation/{shardKey}/',
    },
    format: 'json',
  },
  fields: {
    /** ULID 主键（persistence 保留名，业务生成） */
    id: { type: 'ulid', required: true },
    /** 分片键 + scope 引用（指向 plugin_scope.scopeId） */
    scopeId: { type: 'string', required: true },
    /** 激活的 EP id（同 scope 内 pointId 唯一） */
    pointId: { type: 'string', required: true },
    /** 激活时间（ISO8601） */
    activatedAt: { type: 'isoDate', required: true },
    // createdAt 不声明：信封保留名，store 自动注入
  },
} as const satisfies SchemaDef;

/** ext_impl_scope_activation 记录类型（从 SchemaDef 派生；信封由 store 注入） */
export type ScopeActivationRecord = InferRecord<typeof ScopeActivationSchema>;
