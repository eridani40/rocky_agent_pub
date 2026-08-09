/**
 * persistence 模块入口（统一 re-export T1-T5 公共模块）
 * 参考: specs/tech/persistence/[P0]schema_interface.md
 *       specs/tech/persistence/[P0]crud_store_interface.md
 *       states/v0.0.2/task.json T1-T5
 *
 * 使用方：`import { CompositeStore, ModelConfigFsSchema, ... } from '@app/server/persistence'`
 *
 * 模块组成：
 *   T1 SchemaDef 子系统：schema-types（类型派生）+ schema-validation（校验）+ errors（部分）
 *   T2 CrudStore 契约层：crud-types（接口/Filter/Options）+ envelope（信封纯逻辑）+ errors（部分）
 *   T3 FsCrudStore：fs-store + fs-paths + fs-io + fs-jsonl
 *   T4 SqliteCrudStore：sqlite-store + sqlite-schema + sqlite-query + sqlite-rows
 *   T5 CompositeStore + schema_defs（model_config；transcript 已由 agent/schema_defs/message.ts 接管）
 */
// T1 SchemaDef 子系统
export type {
  FieldType,
  FieldDef,
  IndexDef,
  FsStorageConfig,
  SchemaDef,
  TsOf,
  InferRecord,
} from './schema-types';

export { validateSchemaDef, validateRecord, isValidUlid } from './schema-validation';

// T2 CrudStore 契约层
export type {
  RecordMeta,
  StoredRecord,
  PutMode,
  PutOptions,
  QueryOrder,
  QueryFilter,
  CrudStore,
} from './crud-types';

export { computeEnvelope } from './envelope';
export type { ComputeEnvelopeInput } from './envelope';

// 错误类型（T1/T2/T5 合并 re-export）
export {
  SchemaValidationError,
  PrimaryKeyMissingError,
  RecordExistsError,
  RecordNotFoundError,
  VersionConflictError,
  EntityNotMountedError,
} from './errors';

// T3 FsCrudStore
export { FsCrudStore } from './fs-store';
export type { FsCrudStoreOptions } from './fs-store';

// fs-yield — 进程级 fs I/O 让出闸门 singleton library（v0.0.291）
export { acquireFsSlot, trackFsTime, resetFsYield } from './fs-yield';

// T4 SqliteCrudStore（接收 SqlDriver 注入，不再内部 new Database）
export { SqliteCrudStore } from './sqlite-store';
// createCrudSqlDriver 工厂（双产物 {store, driver}，读写分离）
export { createCrudSqlDriver } from './crud-sqlite-driver-factory';

// T5 CompositeStore（按 entity 路由）
export { CompositeStore } from './composite';

// T5 schema_defs（实验 fixture；transcript 已由 agent/schema_defs/message.ts 接管）
export {
  ModelConfigFsSchema,
  ModelConfigSqliteSchema,
} from './schema_defs/model_config';
export type { ModelConfigRecord } from './schema_defs/model_config';
