/**
 * schema_defs barrel — 实验实体 SchemaDef 集中 re-export
 * 参考: states/v0.0.2/task.json keyDecisions.experimentEntities
 *       specs/tech/version_logs/v0.0.8/change_log.md §2.2（注册 4 业务 schema）
 *
 * 实验 fixture：model_config（fs vs sqlite 双 engine）。
 *
 * 业务 schema（session/message/summary/run）定义在 agent/schema_defs/（业务模块目录），
 * 此处仅作便捷 re-export，便于 CompositeStore mount 时一站式 import。
 */
export {
  ModelConfigFsSchema,
  ModelConfigSqliteSchema,
} from './model_config';
export type { ModelConfigRecord } from './model_config';

// 业务 schema re-export（权威定义在 agent/schema_defs/）
export {
  SessionSchema,
  MessageSchema,
  SummarySchema,
  RunSchema,
} from '../../agent/schema_defs';
export type {
  SessionRecord,
  MessageRecord,
  SummaryRecord,
  RunRecord,
} from '../../agent/schema_defs';
