/**
 * 迁移 handler 策略执行（6 策略 + clip，spec §3.2）.
 * 参考: specs/tech/squad/[P1]panorama_migration.md §3.2（handler 策略）
 *       specs/research/v0.0.189.dsl_board/panorama_migration.md §3.3
 *
 * 每个 handler 对存量实例做值变换；幂等（§6.2）：mapping 已在目标集 = no-op 等.
 * 从 apply_migration.ts 拆出（控制单文件 ≤300 行）.
 */
import type { PanoramaSchema, NumberFieldDef } from '../dsl/types';
import type { MigrationOperation, MigrationHandler } from './types';
import type { MigrationStore } from './apply_migration';

const TRANSFORM_FNS = new Set([
  'parseFloat', 'parseInt', 'toString', 'toLowerCase', 'toUpperCase', 'trim',
]);

/**
 * 执行单个 migration operation，遍历存量实例应用 handler.
 * @returns 受影响实例数.
 */
export function executeOperation(
  store: MigrationStore,
  operation: MigrationOperation,
  newSchema: PanoramaSchema,
): number {
  const { operation: opType, target, handler } = operation;
  const entity = target.entity;
  const field = target.field;
  const instances = store.listInstances(entity);

  switch (opType) {
    case 'delete_entity':
      return handleDeleteEntity(store, entity, handler, instances);
    case 'delete_field':
      return handleDeleteField(store, entity, field!, handler, instances);
    case 'narrow_enum':
      return handleNarrowEnum(store, entity, field!, handler, instances);
    case 'change_field_type':
      return handleChangeFieldType(store, entity, field!, handler, instances);
    case 'change_state_field':
      return handleChangeStateField(
        store, entity, handler, instances,
        String(operation.from), String(operation.to),
      );
    case 'tighten_constraint':
      return handleTightenConstraint(store, entity, field!, handler, instances, newSchema);
    case 'expand_terminal':
      return 0; // terminal 扩大 — 仅限制未来操作，no-op on existing
    default:
      return 0;
  }
}

function handleDeleteEntity(
  store: MigrationStore, entity: string, handler: MigrationHandler,
  instances: Record<string, unknown>[],
): number {
  if (handler.strategy === 'purge') {
    for (const inst of instances) store.deleteInstance(entity, String(inst.id));
    return instances.length;
  }
  // archive — 标记 _archived（保留数据，查询层过滤）
  for (const inst of instances) {
    store.putInstance(entity, String(inst.id), { ...inst, _archived: true });
  }
  return instances.length;
}

function handleDeleteField(
  store: MigrationStore, entity: string, field: string, handler: MigrationHandler,
  instances: Record<string, unknown>[],
): number {
  let count = 0;
  for (const inst of instances) {
    if (inst[field] == null) continue; // 幂等
    if (handler.strategy === 'archive') {
      const archived = (inst._archived_fields as Record<string, unknown> | undefined) ?? {};
      archived[field] = inst[field];
      store.putInstance(entity, String(inst.id), { ...inst, [field]: null, _archived_fields: archived });
    } else {
      store.putInstance(entity, String(inst.id), { ...inst, [field]: null });
    }
    count++;
  }
  return count;
}

function handleNarrowEnum(
  store: MigrationStore, entity: string, field: string, handler: MigrationHandler,
  instances: Record<string, unknown>[],
): number {
  const mapping = handler.mapping ?? {};
  const targetVals = new Set(Object.values(mapping).map(String));
  let count = 0;
  for (const inst of instances) {
    const cur = inst[field];
    if (cur == null) continue;
    const curStr = String(cur);
    if (targetVals.has(curStr)) continue; // 幂等：已在目标集
    const mapped = mapping[curStr];
    const newVal = mapped !== undefined ? mapped : handler.default_value;
    if (newVal !== undefined) {
      store.putInstance(entity, String(inst.id), { ...inst, [field]: newVal });
      count++;
    }
  }
  return count;
}

function handleChangeFieldType(
  store: MigrationStore, entity: string, field: string, handler: MigrationHandler,
  instances: Record<string, unknown>[],
): number {
  let count = 0;
  for (const inst of instances) {
    const cur = inst[field];
    if (cur == null) continue;
    store.putInstance(entity, String(inst.id), { ...inst, [field]: applyTransform(handler, cur) });
    count++;
  }
  return count;
}

function handleChangeStateField(
  store: MigrationStore, entity: string, handler: MigrationHandler,
  instances: Record<string, unknown>[],
  from: string, to: string,
): number {
  void handler; // state_field 迁移由 operation.from/to 驱动，handler 不参与值变换
  let count = 0;
  for (const inst of instances) {
    if (inst[to] !== undefined) continue; // 幂等：目标字段已存在
    if (inst[from] == null) continue;     // 旧字段无值，跳过
    store.putInstance(entity, String(inst.id), { ...inst, [to]: inst[from], [from]: null });
    count++;
  }
  return count;
}

function handleTightenConstraint(
  store: MigrationStore, entity: string, field: string, handler: MigrationHandler,
  instances: Record<string, unknown>[],
  newSchema: PanoramaSchema,
): number {
  const fieldDef = newSchema.entities[entity]?.fields[field];
  let min: number | undefined;
  let max: number | undefined;
  if (fieldDef?.type === 'number') {
    min = (fieldDef as NumberFieldDef).min;
    max = (fieldDef as NumberFieldDef).max;
  }
  let count = 0;
  for (const inst of instances) {
    const cur = inst[field];
    if (typeof cur !== 'number') continue;
    let newVal = cur;
    if (max !== undefined && newVal > max) newVal = max;
    if (min !== undefined && newVal < min) newVal = min;
    if (newVal === cur) continue; // 幂等
    store.putInstance(entity, String(inst.id), { ...inst, [field]: newVal });
    count++;
  }
  return count;
}

// ── transform 表达式求值（§3.3，白名单 + 链式） ─────────────

function applyTransform(handler: MigrationHandler, value: unknown): unknown {
  if (!handler.transform) return handler.default_value ?? value;
  return evalTransformExpr(handler.transform, value);
}

function evalTransformExpr(expr: string, value: unknown): unknown {
  const cleaned = expr.replace(/\s+/g, '');
  const m = cleaned.match(/^(parseFloat|parseInt|toString|toLowerCase|toUpperCase|trim)\((.*)\)$/);
  if (!m) return value;
  const fn = m[1]!;
  const inner = m[2]!;
  const innerVal = inner === 'value' ? value : evalTransformExpr(inner, value);
  return applyTransformFn(fn, innerVal);
}

function applyTransformFn(fn: string, val: unknown): unknown {
  switch (fn) {
    case 'parseFloat': return typeof val === 'number' ? val : parseFloat(String(val));
    case 'parseInt': return typeof val === 'number' ? val : parseInt(String(val), 10);
    case 'toString': return String(val);
    case 'toLowerCase': return String(val).toLowerCase();
    case 'toUpperCase': return String(val).toUpperCase();
    case 'trim': return String(val).trim();
    default: return val;
  }
}
