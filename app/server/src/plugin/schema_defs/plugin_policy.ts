/**
 * plugin_policy entity 的 SchemaDef — 按 kind 分片（plugin | impl），json 格式
 * 参考: specs/tech/config/[P0]plugin_config.md（数据形状）
 *       specs/tech/config/[P0]plugin_config_service.md §4.4（落盘 plugins.policy.json）
 *       specs/tech/persistence/[P0]schema_interface.md §2
 *
 * 设计（plugin_config_service §3 overlay 模型）：
 *   - 单 entity 承载两级 policy record（plugin 级 + ext impl 级），用 kind 字段区分
 *   - kind 既分片键（shardKey）也是逻辑分类（plugin / impl 两个 shard 目录）
 *   - key 为逻辑身份（pluginId 或 implId），id 为 ULID 物理主键
 *   - data 恒为 json：稀疏 delta（enabled? / order? / configValues?），缺字段即未配置
 *   - 落盘 {root}/plugin_policy/{kind}/<id>.json（FsCrudStore engine:'file'）
 *   - 复用 T1 persistence schema-types（as const satisfies SchemaDef + InferRecord）
 *
 * [v0.0.55] data 删 `exclusive?` 字段——三种 cardinality 共用 enabled+order 数据模型
 *   （exclusive EP 改 enabled 互斥，setExclusive 不再写 exclusive 字段；旧 record 启动 lazy migrate 清）。
 *   schema data 字段是 json 类型（业务字段透明），无显式 field 删除——仅业务层注释更新。
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * plugin_policy entity 的 SchemaDef。
 * 落盘路径：{root}/plugin_policy/{kind}/<id>.json（kind='plugin' 或 'impl'）。
 */
export const PluginPolicySchema = {
  entity: 'plugin_policy',
  engine: 'file',
  fs: {
    sharding: {
      shardKeyField: 'kind',
      dirTemplate: 'plugin_policy/{shardKey}/',
    },
    format: 'json',
  },
  fields: {
    /** ULID 主键（persistence 保留名，业务生成） */
    id: { type: 'ulid', required: true },
    /** 分片键 + 逻辑分类：'plugin'（plugin 级 record）或 'impl'（ext impl 级 record） */
    kind: { type: 'string', required: true },
    /** 逻辑身份：kind='plugin' 时为 pluginId，kind='impl' 时为 implId */
    key: { type: 'string', required: true },
    /** 稀疏 delta 值（enabled? / order? / configValues?），对 persistence 不透明 */
    data: { type: 'json', required: true },
  },
} as const satisfies SchemaDef;

/** plugin_policy 记录类型（从 SchemaDef 派生） */
export type PluginPolicyRecord = InferRecord<typeof PluginPolicySchema>;
