/**
 * model_config 双 engine 实验 SchemaDefs — 验证「engine 可换」(task.json T5 §3)
 * 参考: specs/tech/persistence/[P0]crud_store_interface.md §3.4（按 entity 寻址）
 *       states/v0.0.2/task.json keyDecisions.experimentEntities
 *
 * 实验目的：同一份业务数据（key/value 配置）经 FsCrudStore 与 SqliteCrudStore
 * 存取时行为是否一致（put/get/delete/query + 信封注入）。
 *
 * 为何定义两份 SchemaDef 而非一份改 engine：
 *   - SchemaDef.entity 是底层集合名（FS 目录名 / SQLite 表名），同时也是
 *     CompositeStore 路由 key（crud §3.4）；同一进程内 entity 名必须唯一。
 *   - 两份 schema 字段完全相同，仅 entity 名（model_config_fs / model_config_sqlite）
 *     与 engine（file / sqlite）不同，便于在同一 CompositeStore 内并存对比。
 *   - 测试用同一份 record 数据分别经两 engine 存取，断言行为一致（见
 *     __tests__/experiment.test.ts）。
 *
 * 这是实验 fixture，业务侧正式 model_config schema 归未来 config 业务模块。
 */
import type { SchemaDef, InferRecord } from '../schema-types';

/**
 * model_config 的 file engine 版本（无分片，扁平目录 json 单文件）。
 * 落盘路径：{root}/model_config_fs/<id>.json
 */
export const ModelConfigFsSchema = {
  entity: 'model_config_fs',
  engine: 'file',
  fields: {
    id: { type: 'ulid', required: true },
    key: { type: 'string', required: true },
    value: { type: 'json', required: true },
  },
} as const satisfies SchemaDef;

/**
 * model_config 的 sqlite engine 版本（无分片，blob-first 单表）。
 * 落盘表：model_config_sqlite（列 id/data/created_at/updated_at/version）。
 */
export const ModelConfigSqliteSchema = {
  entity: 'model_config_sqlite',
  engine: 'sqlite',
  fields: {
    id: { type: 'ulid', required: true },
    key: { type: 'string', required: true },
    value: { type: 'json', required: true },
  },
} as const satisfies SchemaDef;

/** model_config 记录类型（两 engine 字段相同，共用一份派生类型） */
export type ModelConfigRecord = InferRecord<typeof ModelConfigFsSchema>;
