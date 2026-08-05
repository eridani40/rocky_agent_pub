/**
 * connector_config entity 的 SchemaDef — 按 id 分片，json 格式
 * 参考: specs/tech/config/[P1]connectors.md §4（持久化 switch intent）
 *       specs/tech/persistence/[P0]schema_interface.md §2（SchemaDef 约定）
 *
 * 设计：
 *   - 连接器是「用户面向」的运行时状态附件（有 nav 页 + toggle），与 app_config（权威值）
 *     正交，自成一域（spec §4 边界说明）。
 *   - 只持久化 **enabled（switch INTENT）**，不持久化 connection 运行时态（运行时重派生）。
 *   - 落盘 {root}/connector_config/<id>.json（id 即 connector id，如 "browser"）。
 *   - record 不存在 / enabled=false → 启动态 switch=off / connection=disconnected。
 *   - enabled=true → 启动 reconnect（spec §3.3，由 ConnectorManager.bootstrap 处理）。
 *
 * 与 app_config 的结构差异：
 *   - app_config 是 (group, key) → data 的 KV 形态（group 分片）。
 *   - 本域是 id → enabled 的单值形态（id 分片，无 group），故不复用 KvConfigService 基类。
 */
import type { SchemaDef, InferRecord } from '../../persistence/schema-types';

/**
 * connector_config entity 的 SchemaDef。
 * 落盘路径：{root}/connector_config/<id>.json（扁平布局，无分片；id 即 connector id）。
 *
 * 不用 fs.sharding：与 app_config 的 group 分片不同，本域 id 全集很小（当前仅
 * "browser" 一个），扁平目录更直观，且与 spec §4 文档路径「connector_config/<id>.json」一致。
 */
export const ConnectorConfigSchema = {
  entity: 'connector_config',
  engine: 'file',
  fields: {
    /** connector id（"browser"，当前仅此一个；同时是主键） */
    id: { type: 'string', required: true },
    /** 持久化的 switch INTENT（非实时态）；true=用户已开启 */
    enabled: { type: 'boolean', required: true },
  },
} as const satisfies SchemaDef;

/** connector_config 记录类型（从 SchemaDef 派生） */
export type ConnectorConfigRecord = InferRecord<typeof ConnectorConfigSchema>;
