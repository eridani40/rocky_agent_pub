/**
 * app_config entity 的 SchemaDef — KV-sharded，按 group 分片，json 格式
 * 参考: specs/tech/config/[P0]app_config.md §1（模型）
 *       specs/tech/persistence/[P0]schema_interface.md §2（SchemaDef 约定）
 *       states/v0.0.3/task.json T1 keyDecisions.configAggregation
 *
 * 设计：
 *   - app_config 是一个 KV 型 entity，按 group 分片存储（engine: file）
 *   - 每条 record = (group, key) → data(json)，落盘 {root}/app_config/{group}/<id>.json
 *   - group 既是分片键也是配置界面 tab（集合由需求/PRD 定义，不动态扩展）
 *   - data 恒为 json：简单值存标量，复杂值存嵌套树（对 persistence 不透明）
 *   - 复用 persistence schema-types（as const satisfies SchemaDef + InferRecord 派生）
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * app_config entity 的 SchemaDef。
 * 落盘路径：{root}/app_config/{group}/<id>.json（同 group 聚一 shard 目录）。
 */
export const AppConfigSchema = {
  entity: 'app_config',
  engine: 'file',
  fs: {
    sharding: {
      shardKeyField: 'group',
      dirTemplate: 'app_config/{shardKey}/',
    },
    format: 'json',
  },
  fields: {
    /** ULID 主键（persistence 保留名，业务生成） */
    id: { type: 'ulid', required: true },
    /** 分片键 + 配置界面 tab（集合由需求/PRD 定义） */
    group: { type: 'string', required: true },
    /** 组内逻辑 key（同 group 内唯一） */
    key: { type: 'string', required: true },
    /** 值，恒为 json（简单值或嵌套树，对 persistence 不透明） */
    data: { type: 'json', required: true },
  },
} as const satisfies SchemaDef;

/** app_config 记录类型（从 SchemaDef 派生，无需手写 interface） */
export type AppConfigRecord = InferRecord<typeof AppConfigSchema>;
