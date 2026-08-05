/**
 * panorama/migration 模块导出 — 变更分类 + 迁移引擎.
 */
export type {
  ChangeKind, SchemaChange, HandlerStrategy, MigrationHandler,
  MigrationOperationType, MigrationOperation, MigrationPlan,
  ClassifiedChanges, ApprovalLevel, MigrationAnalysis,
  ApplyMigrationResult,
} from './types';
export {
  BreakingChangeRequiresApprovalError, MigrationMismatchError,
} from './types';

export { diffSchema } from './diff_schema';
export {
  classifyChanges, requiresApproval, analyzeMigration,
  planMigration, validateMigrationCoverage,
} from './plan_migration';
export { applyMigration } from './apply_migration';
export type { MigrationStore, ApplyMigrationOptions } from './apply_migration';
