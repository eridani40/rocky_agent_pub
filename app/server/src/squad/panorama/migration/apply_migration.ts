/**
 * applyMigration — 迁移引擎编排：分析 → 审批 → 备份 → 执行 → 审计.
 * 参考: specs/tech/squad/[P1]panorama_migration.md §4（介入门槛）/ §5（审计）/ §6（执行保证）
 *       specs/research/v0.0.189.dsl_board/panorama_migration.md §4 / §6
 *
 * 原子性（§6.1）：全过落盘 / 失败全回滚（备份→执行→失败恢复）.
 * handler 策略执行拆到 handlers.ts（单文件 ≤300 行）.
 */
import * as fs from 'node:fs';
import { stringify as stringifyYaml } from 'yaml';
import * as path from 'node:path';
import type { PanoramaSchema } from '../dsl/types';
import type {
  MigrationPlan, MigrationAnalysis, ApplyMigrationResult, SchemaChange,
  PostValidationViolation,
} from './types';
import { BreakingChangeRequiresApprovalError, MigrationPostValidationError } from './types';
import { validateInstance } from '../validation';
import { analyzeMigration, requiresApproval, validateMigrationCoverage, planMigration } from './plan_migration';
import { executeOperation } from './handlers';

// ── store 接口 ──────────────────────────────────────────────

export interface MigrationStore {
  listInstances(entity: string): Record<string, unknown>[];
  getInstance(entity: string, id: string): Record<string, unknown> | undefined;
  putInstance(entity: string, id: string, record: Record<string, unknown>): void;
  deleteInstance(entity: string, id: string): boolean;
  writeBoard(schema: PanoramaSchema): void;
  appendEvent(event: Record<string, unknown>): number;
  appendEventWithSeq(seq: number, event: Record<string, unknown>): void;
  nextSeq(): number;
  readonly panoramaDir: string;
}

export interface ApplyMigrationOptions {
  oldSchema: PanoramaSchema;
  newSchema: PanoramaSchema;
  plan?: MigrationPlan;
  approved?: boolean;
  dryRun?: boolean;
  hasInstances?: (entity: string) => number;
  messageId?: string | null;
}

/**
 * 执行迁移：分类 → 审批 → 备份 → 逐 operation 执行 → 审计 → 落盘.
 */
export function applyMigration(
  store: MigrationStore,
  options: ApplyMigrationOptions,
): ApplyMigrationResult {
  const { oldSchema, newSchema } = options;

  // 1. 分析
  const analysis = analyzeMigration(oldSchema, newSchema, {
    hasInstances: options.hasInstances ?? ((e) => store.listInstances(e).length),
  });

  // 2. dryRun = 只分析不落盘（§4.2）
  if (options.dryRun) {
    return { applied: false, seq: 0, operationsExecuted: 0, instancesAffected: 0 };
  }

  // 3. 审批门槛（§4）
  const approval = requiresApproval(analysis.classified.breaking, {
    hasInstances: options.hasInstances ?? ((e) => store.listInstances(e).length),
  });
  if (approval === 'major' && !options.approved) {
    throw new BreakingChangeRequiresApprovalError(analysis);
  }

  // 4. 纯增量 → 直接落盘 + 审计
  if (analysis.classified.breaking.length === 0) {
    const seq = commitDefine(store, newSchema, analysis.changes, options.messageId);
    return { applied: true, seq, operationsExecuted: 0, instancesAffected: 0 };
  }

  // 5. 生成/取 plan + 校验覆盖
  const plan = options.plan ?? planMigration(oldSchema, newSchema);
  validateMigrationCoverage(analysis, plan);

  // 6. 备份 → 执行 → 审计（原子：失败回滚）
  const seq = store.nextSeq();
  const backupPath = path.join(store.panoramaDir, '.archive', `pre-migration-${seq}`);
  let instancesAffected = 0;

  backupBeforeMigration(store, backupPath, oldSchema, plan);

  try {
    for (const operation of plan.operations) {
      instancesAffected += executeOperation(store, operation, newSchema);
    }
  } catch (err) {
    rollback(store, backupPath, oldSchema);
    throw err;
  }

  // 迁移后校验（§6.1 原子性）：受影响实体的存量实例须过新 schema 实例校验，
  // 不过 → 回滚 + MigrationPostValidationError（典型：narrow_enum 缺 mapping 残留非法值）
  const violations = postValidateInstances(store, plan, newSchema);
  if (violations.length > 0) {
    rollback(store, backupPath, oldSchema);
    throw new MigrationPostValidationError(violations);
  }

  // 7. 落盘新 DSL + 审计
  writeBoardAndAudit(store, newSchema, seq, analysis.changes, plan, instancesAffected, options.messageId);

  return { applied: true, seq, operationsExecuted: plan.operations.length, instancesAffected, backupPath };
}

/** 迁移后校验：plan 触及且仍存在于新 schema 的实体，逐实例过 validateInstance（update 模式） */
function postValidateInstances(
  store: MigrationStore, plan: MigrationPlan, newSchema: PanoramaSchema,
): PostValidationViolation[] {
  const storeLike = {
    getInstance: (e: string, i: string) => store.getInstance(e, i) ?? null,
    listInstances: (e: string) => store.listInstances(e),
    hasId: (e: string, i: string) => store.getInstance(e, i) !== undefined,
  };
  const violations: PostValidationViolation[] = [];
  const targets = [...new Set(plan.operations.map((op) => op.target.entity))];
  for (const entity of targets) {
    const entityDef = newSchema.entities[entity];
    if (!entityDef) continue; // delete_entity：实体已从新 schema 移除，不校验
    for (const inst of store.listInstances(entity)) {
      const vr = validateInstance(entity, entityDef, inst, { mode: 'update', store: storeLike });
      if (!vr.ok) {
        violations.push({ entity, id: String(inst[entityDef.id_field] ?? inst.id ?? '?'), errors: vr.errors });
      }
      if (violations.length >= 20) return violations; // 上限防爆炸（调用方再截 10 展示）
    }
  }
  return violations;
}

// ── 备份 + 回滚（§6.3 / §6.1） ──────────────────────────────

function backupBeforeMigration(
  store: MigrationStore, backupPath: string,
  oldSchema: PanoramaSchema, plan: MigrationPlan,
): void {
  fs.mkdirSync(path.join(backupPath, 'entities'), { recursive: true });
  fs.writeFileSync(path.join(backupPath, 'board.yaml.bak'), stringifyYaml(oldSchema));

  const entities = new Set(plan.operations.map(op => op.target.entity));
  for (const entity of entities) {
    for (const inst of store.listInstances(entity)) {
      const dir = path.join(backupPath, 'entities', entity);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${String(inst.id ?? 'unknown')}.json`), JSON.stringify(inst, null, 2));
    }
  }
}

function rollback(store: MigrationStore, backupPath: string, oldSchema: PanoramaSchema): void {
  store.writeBoard(oldSchema);
  const entitiesDir = path.join(backupPath, 'entities');
  if (!fs.existsSync(entitiesDir)) return;
  for (const entity of fs.readdirSync(entitiesDir)) {
    const entityDir = path.join(entitiesDir, entity);
    if (!fs.statSync(entityDir).isDirectory()) continue;
    for (const file of fs.readdirSync(entityDir)) {
      if (!file.endsWith('.json')) continue;
      const inst = JSON.parse(fs.readFileSync(path.join(entityDir, file), 'utf8'));
      store.putInstance(entity, String(inst.id), inst);
    }
  }
}

// ── 审计 + 落盘（§5） ───────────────────────────────────────

function commitDefine(
  store: MigrationStore, newSchema: PanoramaSchema,
  changes: SchemaChange[], messageId: string | null | undefined,
): number {
  const seq = store.nextSeq();
  writeBoardAndAudit(store, newSchema, seq, changes, { operations: [] }, 0, messageId);
  return seq;
}

function writeBoardAndAudit(
  store: MigrationStore, newSchema: PanoramaSchema, seq: number,
  changes: SchemaChange[], plan: MigrationPlan,
  instancesAffected: number, messageId: string | null | undefined,
): void {
  store.writeBoard(newSchema);
  store.appendEventWithSeq(seq, {
    ts: new Date().toISOString(),
    type: 'board.defined',
    entity: '*',
    summary: `DSL 更新（${changes.length} changes）`,
    payload: {
      changes: changes.map(ch => auditChangeEntry(ch, plan, instancesAffected)),
      breaking: plan.operations.length > 0,
      instancesAffected,
      lastWriteMessageId: messageId ?? null,
    },
  });
}

function auditChangeEntry(
  change: SchemaChange, plan: MigrationPlan, instancesAffected: number,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { kind: change.kind };
  if (change.entity) entry.entity = change.entity;
  if (change.field) entry.field = change.field;
  if (change.view) entry.view = change.view;
  if (change.detail) entry.detail = change.detail;
  const matched = plan.operations.find(op =>
    op.target.entity === change.entity && op.target.field === change.field,
  );
  if (matched) {
    entry.migration_strategy = matched.handler.strategy;
    entry.affected_instances = instancesAffected;
  }
  return entry;
}
