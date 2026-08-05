/**
 * Panorama 迁移引擎类型定义 — 变更分类 + 迁移方案 + handler 策略.
 * 参考: specs/tech/squad/[P1]panorama_migration.md §3.1 / §3.2
 *       specs/research/v0.0.189.dsl_board/panorama_migration.md §3.1 / §4.4
 *
 * 设计：纯 interface/type 文件，无 runtime 代码。diff/plan/apply 共享。
 */

// ── change kind 清单（spec §4.4，完整 19 类） ───────────────

export type ChangeKind =
  | 'entity_added'          // 新增实体
  | 'entity_deleted'        // 删除实体
  | 'field_added'           // 新增字段
  | 'field_deleted'         // 删除字段
  | 'field_type_changed'    // 字段类型变更
  | 'enum_expanded'         // enum 扩值（增量）
  | 'enum_narrowed'         // enum 收窄（破坏性）
  | 'constraint_tightened'  // 约束收紧（破坏性）
  | 'constraint_relaxed'    // 约束放宽（增量）
  | 'view_added'            // 新增视图
  | 'view_deleted'          // 删除视图
  | 'view_modified'         // 视图配置变更
  | 'state_field_changed'   // states.field 变更（破坏性）
  | 'transition_added'      // 加 transition 出边
  | 'transition_removed'    // 删 transition 出边
  | 'terminal_expanded'     // 扩大 terminal 集
  | 'terminal_shrunk'       // 缩小 terminal 集
  | 'display_changed'       // display labels/colors 变更
  | 'meta_updated';         // meta.updated_at 引擎自动更新

// ── diffSchema 产出的原始变更 ───────────────────────────────

export interface SchemaChange {
  kind: ChangeKind;
  entity?: string;
  field?: string;
  view?: string;
  from?: unknown;
  to?: unknown;
  detail?: string;
}

// ── handler 策略（spec §3.2，7 类闭集合） ───────────────────

export type HandlerStrategy =
  | 'archive'    // delete_entity/delete_field — 归档存量到 .archive/ 或 _archived 字段
  | 'purge'      // delete_entity — 物理删除存量数据
  | 'drop'       // delete_field — 丢弃字段值
  | 'mapping'    // narrow_enum — 值映射表 {old: new}
  | 'default'    // change_field_type/narrow_enum — 设默认值
  | 'transform'  // change_field_type — 变换表达式（parseFloat/parseInt/toString/toLowerCase/toUpperCase/trim）
  | 'clip';      // tighten_constraint — 值截断到约束范围

export interface MigrationHandler {
  strategy: HandlerStrategy;
  /** strategy=mapping 时的值映射表 */
  mapping?: Record<string, unknown>;
  /** strategy=default 时的默认值 */
  default_value?: unknown;
  /** strategy=transform 时的变换表达式（如 "parseFloat(value)"） */
  transform?: string;
}

// ── 迁移操作（spec §3.1） ───────────────────────────────────

export type MigrationOperationType =
  | 'delete_entity'
  | 'delete_field'
  | 'narrow_enum'
  | 'change_field_type'
  | 'change_state_field'
  | 'expand_terminal'
  | 'tighten_constraint';

export interface MigrationOperation {
  operation: MigrationOperationType;
  target: {
    entity: string;
    field?: string;
    view?: string;
  };
  from?: unknown;
  to?: unknown;
  handler: MigrationHandler;
}

export interface MigrationPlan {
  operations: MigrationOperation[];
}

// ── 分类结果 ────────────────────────────────────────────────

export interface ClassifiedChanges {
  incremental: SchemaChange[];
  breaking: SchemaChange[];
}

// ── 介入门槛级别（spec §4） ─────────────────────────────────

export type ApprovalLevel = 'none' | 'minor' | 'major';

export interface MigrationAnalysis {
  changes: SchemaChange[];
  classified: ClassifiedChanges;
  approval: ApprovalLevel;
  needsMigrationPlan: boolean;
}

// ── applyMigration 结果 ─────────────────────────────────────

export interface ApplyMigrationResult {
  applied: boolean;
  seq: number;
  operationsExecuted: number;
  instancesAffected: number;
  backupPath?: string;
}

// ── 迁移引擎错误 ────────────────────────────────────────────

/** 重大破坏性变更需用户确认 */
export class BreakingChangeRequiresApprovalError extends Error {
  readonly code = 'panorama_breaking_change_requires_approval';
  readonly analysis: MigrationAnalysis;
  constructor(analysis: MigrationAnalysis) {
    super('破坏性变更需用户确认（panorama_breaking_change_requires_approval）');
    this.name = 'BreakingChangeRequiresApprovalError';
    this.analysis = analysis;
  }
}

/** 迁移方案与实际变更不匹配（缺 operation / 多 operation） */
export class MigrationMismatchError extends Error {
  readonly code = 'panorama_migration_mismatch';
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`迁移方案不完整，缺少 operation: ${missing.join(', ')}`);
    this.name = 'MigrationMismatchError';
    this.missing = missing;
  }
}

// ── 迁移后校验（§6.1 原子性：不过 → 全回滚） ────────────────

/** 单个实例的迁移后校验违规明细 */
export interface PostValidationViolation {
  entity: string;
  id: string;
  errors: { code: string; message: string; path?: string }[];
}

/** 迁移执行后存量实例不符合新 schema（已回滚）——典型：narrow_enum 缺 mapping 残留非法值 */
export class MigrationPostValidationError extends Error {
  readonly code = 'panorama_migration_postcheck';
  readonly violations: PostValidationViolation[];
  constructor(violations: PostValidationViolation[]) {
    super(`迁移后校验失败：${violations.length} 个实例不符合新 schema（已回滚），检查 migration handler（如 narrow_enum 需 mapping）`);
    this.name = 'MigrationPostValidationError';
    this.violations = violations;
  }
}
