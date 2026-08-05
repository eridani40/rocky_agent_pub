/**
 * diffSchema — 对比 old/new PanoramaSchema，产出原始变更清单.
 * 参考: specs/tech/squad/[P1]panorama_migration.md §1（变更分类总表）/ §4.4（change kind 清单）
 *       specs/research/v0.0.189.dsl_board/panorama_migration.md §1（变更分类表）
 *
 * 纯函数：只比较 schema 结构，不查存量数据（破坏性判定在 plan_migration）。
 */
import type { PanoramaSchema, EntityDef, FieldDef, EnumFieldDef, NumberFieldDef, StringFieldDef, StatesDef, ViewDef } from '../dsl/types';
import type { SchemaChange, ChangeKind } from './types';

/**
 * 对比 old/new schema 产出变更清单.
 * 覆盖 19 种 change kind（entity/field/enum/type/constraint/states/transition/terminal/view/display/meta）.
 */
export function diffSchema(
  oldSchema: PanoramaSchema,
  newSchema: PanoramaSchema,
): SchemaChange[] {
  const changes: SchemaChange[] = [];
  const oldEntities = oldSchema.entities ?? {};
  const newEntities = newSchema.entities ?? {};

  // ── 实体级 ──────────────────────────────────────
  for (const name of Object.keys(newEntities)) {
    if (!oldEntities[name]) {
      changes.push(c('entity_added', { entity: name }));
    }
  }
  for (const name of Object.keys(oldEntities)) {
    if (!newEntities[name]) {
      changes.push(c('entity_deleted', { entity: name }));
    }
  }

  // ── 字段级 + states + display（共有实体） ──────────
  for (const name of Object.keys(newEntities)) {
    const oldEntity = oldEntities[name];
    if (!oldEntity) continue;
    diffEntity(name, oldEntity, newEntities[name]!, changes);
  }

  // ── 视图级 ──────────────────────────────────────
  diffViews(oldSchema.views ?? [], newSchema.views ?? [], changes);

  // ── meta/version（展示层变更，增量） ────────────────
  diffMeta(oldSchema, newSchema, changes);

  return changes;
}

// ── helpers ─────────────────────────────────────────────────

function c(
  kind: ChangeKind,
  loc: { entity?: string; field?: string; view?: string },
  extra?: { from?: unknown; to?: unknown; detail?: string },
): SchemaChange {
  return { kind, ...loc, ...(extra ?? {}) };
}

function diffEntity(
  entity: string,
  oldEntity: EntityDef,
  newEntity: EntityDef,
  changes: SchemaChange[],
): void {
  const oldFields = oldEntity.fields ?? {};
  const newFields = newEntity.fields ?? {};

  // 字段增删
  for (const fn of Object.keys(newFields)) {
    if (!oldFields[fn]) changes.push(c('field_added', { entity, field: fn }));
  }
  for (const fn of Object.keys(oldFields)) {
    if (!newFields[fn]) changes.push(c('field_deleted', { entity, field: fn }));
  }

  // 共有字段：类型 / enum / 约束
  for (const fn of Object.keys(newFields)) {
    const oldField = oldFields[fn];
    if (!oldField) continue;
    diffField(entity, fn, oldField, newFields[fn]!, changes);
  }

  // states（状态机）
  diffStates(entity, oldEntity.states, newEntity.states, changes);

  // display（展示配置）
  if (!shallowEqual(oldEntity.display, newEntity.display)) {
    changes.push(c('display_changed', { entity }));
  }
}

function diffField(
  entity: string,
  field: string,
  oldField: FieldDef,
  newField: FieldDef,
  changes: SchemaChange[],
): void {
  // 类型变更
  if (oldField.type !== newField.type) {
    changes.push(c('field_type_changed', { entity, field },
      { from: oldField.type, to: newField.type }));
    return; // 类型变了不再细查 enum/约束
  }

  // enum 值集
  if (oldField.type === 'enum' && newField.type === 'enum') {
    const oldVals = (oldField as EnumFieldDef).values;
    const newVals = (newField as EnumFieldDef).values;
    const added = newVals.filter(v => !oldVals.includes(v));
    const removed = oldVals.filter(v => !newVals.includes(v));
    if (added.length > 0) {
      changes.push(c('enum_expanded', { entity, field }, { detail: `+${added.join(', ')}` }));
    }
    if (removed.length > 0) {
      changes.push(c('enum_narrowed', { entity, field },
        { from: oldVals, to: newVals, detail: `-${removed.join(', ')}` }));
    }
  }

  // 约束收紧/放宽（number min/max, string max/pattern）
  diffConstraint(entity, field, oldField, newField, changes);
}

function diffConstraint(
  entity: string,
  field: string,
  oldField: FieldDef,
  newField: FieldDef,
  changes: SchemaChange[],
): void {
  if (oldField.type === 'number' && newField.type === 'number') {
    const o = oldField as NumberFieldDef;
    const n = newField as NumberFieldDef;
    // min 增大 = 收紧；min 减小 = 放宽
    if (o.min !== n.min) {
      const tightened = n.min !== undefined && (o.min === undefined || n.min > o.min);
      changes.push(c(tightened ? 'constraint_tightened' : 'constraint_relaxed',
        { entity, field }, { detail: `min: ${o.min} → ${n.min}` }));
    }
    // max 减小 = 收紧；max 增大 = 放宽
    if (o.max !== n.max) {
      const tightened = n.max !== undefined && (o.max === undefined || n.max < o.max);
      changes.push(c(tightened ? 'constraint_tightened' : 'constraint_relaxed',
        { entity, field }, { detail: `max: ${o.max} → ${n.max}` }));
    }
  }
  if (oldField.type === 'string' && newField.type === 'string') {
    const o = oldField as StringFieldDef;
    const n = newField as StringFieldDef;
    // max 减小 = 收紧
    if (o.max !== n.max) {
      const tightened = n.max !== undefined && (o.max === undefined || n.max < o.max);
      changes.push(c(tightened ? 'constraint_tightened' : 'constraint_relaxed',
        { entity, field }, { detail: `max: ${o.max} → ${n.max}` }));
    }
    // 加 pattern = 收紧；去 pattern = 放宽
    if (!!o.pattern !== !!n.pattern || (o.pattern && n.pattern && o.pattern !== n.pattern)) {
      changes.push(c(n.pattern ? 'constraint_tightened' : 'constraint_relaxed',
        { entity, field }, { detail: `pattern: ${o.pattern ?? '∅'} → ${n.pattern ?? '∅'}` }));
    }
  }
}

function diffStates(
  entity: string,
  oldStates: StatesDef | undefined,
  newStates: StatesDef | undefined,
  changes: SchemaChange[],
): void {
  // 加状态机
  if (!oldStates && newStates) {
    // 首次加状态机——不算单独 transition change（整个 states 新增）
    return;
  }
  // 删状态机——不影响存量（忽略）
  if (oldStates && !newStates) return;
  if (!oldStates || !newStates) return;

  // states.field 变更（破坏性）
  if (oldStates.field !== newStates.field) {
    changes.push(c('state_field_changed', { entity },
      { from: oldStates.field, to: newStates.field }));
    return; // field 变了后续 transition 比较无意义
  }

  // transitions 出边增删
  const oldFroms = Object.keys(oldStates.transitions ?? {});
  const newFroms = Object.keys(newStates.transitions ?? {});
  for (const from of newFroms) {
    if (!oldFroms.includes(from)) {
      changes.push(c('transition_added', { entity }, { detail: `${from}: *` }));
      continue;
    }
    const oldTargets = (oldStates.transitions[from] ?? []).map(t => t.to);
    const newTargets = (newStates.transitions[from] ?? []).map(t => t.to);
    const added = newTargets.filter(t => !oldTargets.includes(t));
    const removed = oldTargets.filter(t => !newTargets.includes(t));
    for (const to of added) {
      changes.push(c('transition_added', { entity }, { detail: `${from} → ${to}` }));
    }
    for (const to of removed) {
      changes.push(c('transition_removed', { entity }, { detail: `${from} → ${to}` }));
    }
  }
  for (const from of oldFroms) {
    if (!newFroms.includes(from)) {
      changes.push(c('transition_removed', { entity }, { detail: `${from}: *` }));
    }
  }

  // terminal 扩/缩
  const oldTerm = oldStates.terminal ?? [];
  const newTerm = newStates.terminal ?? [];
  const termAdded = newTerm.filter(t => !oldTerm.includes(t));
  const termRemoved = oldTerm.filter(t => !newTerm.includes(t));
  if (termAdded.length) {
    changes.push(c('terminal_expanded', { entity }, { detail: `+${termAdded.join(', ')}` }));
  }
  if (termRemoved.length) {
    changes.push(c('terminal_shrunk', { entity }, { detail: `-${termRemoved.join(', ')}` }));
  }
}

function diffViews(oldViews: ViewDef[], newViews: ViewDef[], changes: SchemaChange[]): void {
  const oldMap = new Map(oldViews.map(v => [v.id, v]));
  const newMap = new Map(newViews.map(v => [v.id, v]));
  for (const [id, view] of newMap) {
    if (!oldMap.has(id)) {
      changes.push(c('view_added', { view: id }));
    } else if (!shallowEqual(oldMap.get(id), view)) {
      changes.push(c('view_modified', { view: id }));
    }
  }
  for (const id of oldMap.keys()) {
    if (!newMap.has(id)) {
      changes.push(c('view_deleted', { view: id }));
    }
  }
}

function diffMeta(oldSchema: PanoramaSchema, newSchema: PanoramaSchema, changes: SchemaChange[]): void {
  const oldMeta = oldSchema.meta;
  const newMeta = newSchema.meta;
  if (oldMeta.author !== newMeta.author ||
    oldMeta.version !== newMeta.version) {
    changes.push(c('meta_updated', {}, { detail: 'meta/version 变更' }));
  }
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every(k => JSON.stringify((a as Record<string, unknown>)[k]) === JSON.stringify((b as Record<string, unknown>)[k]));
}
