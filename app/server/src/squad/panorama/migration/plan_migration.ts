/**
 * classifyChanges + requiresApproval + planMigration — 变更分类 + 迁移方案生成.
 * 参考: specs/tech/squad/[P1]panorama_migration.md §1（分类总表）/ §3（迁移方案）/ §4（用户介入门槛）
 *       specs/research/v0.0.189.dsl_board/panorama_migration.md §1 / §3 / §5
 *
 * 增量变更（9 类）自动生效；破坏性变更（8 类）须 MigrationPlan + 可能需用户审批.
 */
import type { PanoramaSchema, EnumFieldDef } from '../dsl/types';
import type {
  SchemaChange, ChangeKind, ClassifiedChanges,
  ApprovalLevel, MigrationAnalysis, MigrationPlan,
  MigrationOperation, MigrationOperationType, HandlerStrategy,
} from './types';
import { MigrationMismatchError } from './types';

// ── 增量变更 kind（9 类，自动生效，无需 migration） ──────────
const INCREMENTAL_KINDS: ReadonlySet<ChangeKind> = new Set([
  'entity_added',
  'field_added',
  'enum_expanded',
  'view_added',
  'transition_added',
  'display_changed',
  'constraint_relaxed',
  'meta_updated',
  'view_modified', // 视图层配置变更，不影响数据
  'transition_removed', // 删 transition 出边无存量依赖 → 自动生效（spec §1）
]);

// ── 破坏性变更 kind（须 migration） ─────────────────────────
const BREAKING_KINDS: ReadonlySet<ChangeKind> = new Set([
  'entity_deleted',
  'field_deleted',
  'enum_narrowed',
  'field_type_changed',
  'state_field_changed',
  'constraint_tightened',
  'terminal_expanded',
]);

// ── 重大变更 kind（需用户审批，spec §4 重大清单） ────────────
const MAJOR_KINDS: ReadonlySet<ChangeKind> = new Set([
  'entity_deleted',
  'field_deleted',
  'enum_narrowed',
  'field_type_changed',
  'state_field_changed',
]);

/**
 * 将原始变更分类为增量 / 破坏性.
 * 增量 = 自动生效；破坏性 = 须 MigrationPlan.
 */
export function classifyChanges(changes: SchemaChange[]): ClassifiedChanges {
  const incremental: SchemaChange[] = [];
  const breaking: SchemaChange[] = [];
  for (const change of changes) {
    if (INCREMENTAL_KINDS.has(change.kind)) {
      incremental.push(change);
    } else if (BREAKING_KINDS.has(change.kind)) {
      breaking.push(change);
    }
    // terminal_shrunk / view_deleted / view_modified 归 incremental（可逆/展示层）
    else {
      incremental.push(change);
    }
  }
  return { incremental, breaking };
}

/**
 * 判定用户介入门槛（spec §4）.
 * - major: 删实体(有数据)/删字段(有非空值)/收窄enum(有存量值)/改类型/改states.field → 需用户点头
 * - minor: 删transition出边(无依赖)/扩terminal/收紧约束/删实体(无数据)/删字段(全null)/删视图 → agent 自决
 * - none: 纯增量，无介入
 *
 * 注意：是否有存量数据需 store 查询——此处做 kind 级初判（有 store 时可细化）.
 * 默认对 MAJOR_KINDS 判 major（保守，宁严勿松）.
 */
export function requiresApproval(
  breaking: SchemaChange[],
  options?: { hasInstances?: (entity: string) => number },
): ApprovalLevel {
  if (breaking.length === 0) return 'none';

  const hasInstances = options?.hasInstances ?? (() => 1); // 缺省保守=有数据

  for (const change of breaking) {
    if (!MAJOR_KINDS.has(change.kind)) continue;

    // 有数据才重大（spec §5.2/§5.3 区分）
    if (change.entity) {
      const count = hasInstances(change.entity);
      if (count > 0) return 'major';
    } else {
      return 'major';
    }
  }
  return 'minor';
}

/**
 * 完整变更分析（dryRun 预检用，spec §4.2）.
 * 不落盘、不执行、不审计.
 */
export function analyzeMigration(
  oldSchema: PanoramaSchema,
  newSchema: PanoramaSchema,
  options?: { hasInstances?: (entity: string) => number },
): MigrationAnalysis {
  const changes = diffAndCollect(oldSchema, newSchema);
  const classified = classifyChanges(changes);
  const approval = requiresApproval(classified.breaking, options);
  return {
    changes,
    classified,
    approval,
    needsMigrationPlan: classified.breaking.length > 0,
  };
}

// 延迟引入 diffSchema（避免循环，运行时 require）
import { diffSchema } from './diff_schema';

function diffAndCollect(oldSchema: PanoramaSchema, newSchema: PanoramaSchema): SchemaChange[] {
  return diffSchema(oldSchema, newSchema);
}

// ── 迁移方案生成 ────────────────────────────────────────────

/**
 * 根据破坏性变更自动生成 MigrationPlan（每条 breaking change → 一个 operation + handler）.
 * agent 可在此默认方案基础上调整 handler 策略后提交.
 *
 * 若调用方已有 plan（用户/agent 手写），直接传入跳过自动生成.
 */
export function planMigration(
  oldSchema: PanoramaSchema,
  newSchema: PanoramaSchema,
  changes?: SchemaChange[],
): MigrationPlan {
  const allChanges = changes ?? diffSchema(oldSchema, newSchema);
  const { breaking } = classifyChanges(allChanges);
  const operations: MigrationOperation[] = [];

  for (const change of breaking) {
    const op = changeToOperation(change);
    if (op) operations.push(op);
  }

  return { operations };
}

function changeToOperation(change: SchemaChange): MigrationOperation | null {
  const entity = change.entity ?? '';
  const field = change.field;
  const loc = { entity, field };

  switch (change.kind) {
    case 'entity_deleted':
      return op('delete_entity', { entity }, change,
        { strategy: 'archive' });

    case 'field_deleted':
      return op('delete_field', { entity, field }, change,
        { strategy: 'drop' });

    case 'enum_narrowed':
      return op('narrow_enum', { entity, field }, change,
        { strategy: 'mapping' });

    case 'field_type_changed':
      return op('change_field_type', { entity, field }, change,
        { strategy: 'default' });

    case 'state_field_changed':
      return op('change_state_field', { entity }, change,
        { strategy: 'default' });

    case 'constraint_tightened':
      return op('tighten_constraint', { entity, field }, change,
        { strategy: 'clip' });

    case 'terminal_expanded':
      return op('expand_terminal', { entity }, change,
        { strategy: 'default' });

    default:
      return null;
  }
}

function op(
  operation: MigrationOperationType,
  target: { entity: string; field?: string },
  change: SchemaChange,
  handler: { strategy: HandlerStrategy },
): MigrationOperation {
  return {
    operation,
    target,
    ...(change.from !== undefined ? { from: change.from } : {}),
    ...(change.to !== undefined ? { to: change.to } : {}),
    handler,
  };
}

/**
 * 校验 MigrationPlan 是否覆盖所有 breaking changes（缺 operation → throw）.
 * 用于 applyMigration 前置检查.
 */
export function validateMigrationCoverage(
  analysis: MigrationAnalysis,
  plan: MigrationPlan,
): void {
  const covered = new Set(
    plan.operations.map(op => `${op.operation}:${op.target.entity}:${op.target.field ?? ''}`),
  );
  const missing: string[] = [];

  for (const change of analysis.classified.breaking) {
    const op = changeToOperation(change);
    if (!op) continue;
    const key = `${op.operation}:${op.target.entity}:${op.target.field ?? ''}`;
    if (!covered.has(key)) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new MigrationMismatchError(missing);
  }
}
