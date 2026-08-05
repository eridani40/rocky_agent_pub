/**
 * Panorama Layer 4 数据安全层 — 存量实例 vs 新 DSL 兼容性.
 * 参考: specs/tech/squad/[P1]panorama_validation.md §5（七项破坏性判定）
 *
 * 仅 define（非 dryRun）且有存量数据时触发。纯函数，依赖 StoreLike 接口；
 * 实际调用时机由 Task#3 store 集成决定。
 */
import type {
  PanoramaSchema, EntityDef, EnumFieldDef,
  NumberFieldDef, StringFieldDef,
} from '../dsl/types';
import type { ValidationError, StoreLike } from './types';
import { makeError } from './types';

/** 共享错误工厂 — 固定 data_safety 层（m5：逻辑收敛到 types.makeError） */
const e = (code: string, path: string, msg: string, suggestion?: string): ValidationError =>
  makeError('data_safety', code, path, msg, suggestion);

export function validateDataSafety(
  oldSchema: PanoramaSchema,
  newSchema: PanoramaSchema,
  store: StoreLike,
  errors: ValidationError[],
): void {
  // 4.1 删除实体（有数据）
  for (const name of Object.keys(oldSchema.entities)) {
    if (newSchema.entities[name]) continue;
    const count = store.listInstances?.(name)?.length ?? 0;
    if (count > 0) {
      errors.push(e('panorama_dropping_entity_data', `entities.${name}`,
        `删除实体 "${name}" 将丢失 ${count} 条存量数据`,
        '重提 define + approved:true（引擎自动 archive 迁移；purge 彻底删除需附 migration delete_entity+purge）'));
    }
  }

  for (const [name, newEntity] of Object.entries(newSchema.entities)) {
    const oldEntity = oldSchema.entities[name];
    if (!oldEntity) continue; // 新增实体无迁移顾虑

    checkDroppedFields(name, oldEntity, newEntity, store, errors);
    checkTypeChanges(name, oldEntity, newEntity, store, errors);
    checkEnumNarrowing(name, oldEntity, newEntity, store, errors);
    checkStateFieldChanged(name, oldEntity, newEntity, store, errors);
    checkTerminalExpanded(name, oldEntity, newEntity, store, errors);
    checkConstraintTightened(name, oldEntity, newEntity, store, errors);
  }
}

/** 4.2 删字段（有非空值） */
function checkDroppedFields(
  name: string, oldEntity: EntityDef, newEntity: EntityDef,
  store: StoreLike, errors: ValidationError[],
): void {
  const instances = store.listInstances?.(name) ?? [];
  if (!instances.length) return;
  for (const fn of Object.keys(oldEntity.fields)) {
    if (newEntity.fields[fn]) continue;
    if (instances.some(inst => inst[fn] != null && inst[fn] !== '')) {
      errors.push(e('panorama_dropping_field_data', `entities.${name}.fields.${fn}`,
        `删除字段 "${fn}" 将丢失存量数据`,
        '重提 define + approved:true（引擎自动 archive 字段值；彻底丢弃附 migration delete_field+drop）'));
    }
  }
}

/** 4.4 改字段类型（有实例） */
function checkTypeChanges(
  name: string, oldEntity: EntityDef, newEntity: EntityDef,
  store: StoreLike, errors: ValidationError[],
): void {
  const instances = store.listInstances?.(name) ?? [];
  if (!instances.length) return;
  for (const [fn, newField] of Object.entries(newEntity.fields)) {
    const oldField = oldEntity.fields[fn];
    if (oldField && oldField.type !== newField.type) {
      errors.push(e('panorama_field_type_changed', `entities.${name}.fields.${fn}`,
        `字段 "${fn}" 类型从 ${oldField.type} 改为 ${newField.type}，存量数据可能不兼容`,
        '重提 define + approved:true（存量值原样保留；需值转换附 migration change_field_type+transform）'));
    }
  }
}

/** 4.3 收窄 enum（有存量值受影响） */
function checkEnumNarrowing(
  name: string, oldEntity: EntityDef, newEntity: EntityDef,
  store: StoreLike, errors: ValidationError[],
): void {
  const instances = store.listInstances?.(name) ?? [];
  for (const [fn, newField] of Object.entries(newEntity.fields)) {
    if (newField.type !== 'enum') continue;
    const oldField = oldEntity.fields[fn];
    if (oldField?.type !== 'enum') continue;
    const removed = (oldField as EnumFieldDef).values
      .filter(v => !(newField as EnumFieldDef).values.includes(v));
    if (!removed.length) continue;
    const affected = instances.filter(inst => removed.includes(String(inst[fn])));
    if (affected.length > 0) {
      errors.push(e('panorama_enum_narrowed', `entities.${name}.fields.${fn}`,
        `enum 收窄移除值 [${removed.join(', ')}]，${affected.length} 条存量数据受影响`,
        '重提 define + approved:true 并附 migration narrow_enum+mapping/default_value（被删枚举值的实例必须映射到新值，否则迁移后校验不过会回滚）'));
    }
  }
}

/** 4.5 改 states.field 致存量旧状态值不在新 enum 中 */
function checkStateFieldChanged(
  name: string, oldEntity: EntityDef, newEntity: EntityDef,
  store: StoreLike, errors: ValidationError[],
): void {
  const instances = store.listInstances?.(name) ?? [];
  if (!instances.length) return;
  const oldStates = oldEntity.states;
  const newStates = newEntity.states;
  if (!oldStates || !newStates || oldStates.field === newStates.field) return;
  const newField = newEntity.fields[newStates.field];
  if (!newField || newField.type !== 'enum') return;
  const newVals = new Set((newField as EnumFieldDef).values);
  const affected = instances.filter(inst => {
    const v = inst[oldStates.field];
    return v != null && v !== '' && !newVals.has(String(v));
  });
  if (affected.length > 0) {
    errors.push(e('panorama_state_field_changed', `entities.${name}.states.field`,
      `states.field 从 "${oldStates.field}" 改为 "${newStates.field}"，${affected.length} 条存量的旧状态值不在新 enum 中`,
      '重提 define + approved:true（引擎自动把旧状态字段值搬到新字段）'));
  }
}

/** 4.6 扩大 terminal 致存量非终态实例被锁为终态 */
function checkTerminalExpanded(
  name: string, oldEntity: EntityDef, newEntity: EntityDef,
  store: StoreLike, errors: ValidationError[],
): void {
  const instances = store.listInstances?.(name) ?? [];
  if (!instances.length) return;
  const oldStates = oldEntity.states;
  const newStates = newEntity.states;
  if (!oldStates || !newStates) return;
  const oldTerm = new Set(oldStates.terminal ?? []);
  const added = (newStates.terminal ?? []).filter(t => !oldTerm.has(t));
  if (!added.length) return;
  const addedSet = new Set(added);
  const affected = instances.filter(inst => {
    const v = inst[newStates.field];
    return v != null && addedSet.has(String(v));
  });
  if (affected.length > 0) {
    errors.push(e('panorama_terminal_expanded', `entities.${name}.states.terminal`,
      `terminal 扩大新增 [${added.join(', ')}]，${affected.length} 条存量实例被锁为终态`,
      '重提 define + approved:true'));
  }
}

/** 4.7 收紧约束（number min↑/max↓、string max↓）致存量越界 */
function checkConstraintTightened(
  name: string, oldEntity: EntityDef, newEntity: EntityDef,
  store: StoreLike, errors: ValidationError[],
): void {
  const instances = store.listInstances?.(name) ?? [];
  if (!instances.length) return;
  for (const [fn, newField] of Object.entries(newEntity.fields)) {
    const oldField = oldEntity.fields[fn];
    if (!oldField) continue;

    if (newField.type === 'number' && oldField.type === 'number') {
      checkNumberTightened(name, fn, oldField, newField, instances, errors);
    } else if (newField.type === 'string' && oldField.type === 'string') {
      checkStringTightened(name, fn, oldField, newField, instances, errors);
    }
  }
}

function checkNumberTightened(
  name: string, fn: string,
  oldField: NumberFieldDef, newField: NumberFieldDef,
  instances: Record<string, unknown>[],
  errors: ValidationError[],
): void {
  const minUp = newField.min !== undefined && (oldField.min === undefined || newField.min > oldField.min);
  const maxDown = newField.max !== undefined && (oldField.max === undefined || newField.max < oldField.max);
  if (!minUp && !maxDown) return;
  const affected = instances.filter(inst => {
    const v = inst[fn];
    if (typeof v !== 'number') return false;
    if (minUp && v < newField.min!) return true;
    if (maxDown && v > newField.max!) return true;
    return false;
  });
  if (affected.length > 0) {
    const parts = [minUp && `min=${newField.min}`, maxDown && `max=${newField.max}`].filter(Boolean);
    errors.push(e('panorama_constraint_tightened', `entities.${name}.fields.${fn}`,
      `约束收紧（${parts.join(' ')}），${affected.length} 条存量数据越界`,
      '重提 define + approved:true（越界数值自动 clip 到新区间）'));
  }
}

function checkStringTightened(
  name: string, fn: string,
  oldField: StringFieldDef, newField: StringFieldDef,
  instances: Record<string, unknown>[],
  errors: ValidationError[],
): void {
  const maxDown = newField.max !== undefined && (oldField.max === undefined || newField.max < oldField.max);
  if (!maxDown) return;
  const affected = instances.filter(inst => {
    const v = inst[fn];
    return typeof v === 'string' && v.length > newField.max!;
  });
  if (affected.length > 0) {
    errors.push(e('panorama_constraint_tightened', `entities.${name}.fields.${fn}`,
      `string.max 收紧为 ${newField.max}，${affected.length} 条存量数据超长`,
      '重提 define + approved:true（越界数值自动 clip 到新区间）'));
  }
}
