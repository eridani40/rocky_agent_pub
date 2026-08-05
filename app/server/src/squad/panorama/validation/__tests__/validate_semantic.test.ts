/**
 * validate_semantic UT — Layer 3 语义层（跨引用闭合）覆盖.
 * 参考: specs/tech/squad/[P1]panorama_validation.md §4
 */
import { describe, it, expect } from 'vitest';
import { validateSchema } from '../validate_schema';

const code = (r: { errors: { code: string }[] }, c: string) =>
  r.errors.some(e => e.code === c);

describe('Layer 3 — ref / view.entity', () => {
  it('ref.entity 不存在 → panorama_unknown_ref_target', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      r: { type: ref, entity: ghost }
views: []`);
    expect(code(r, 'panorama_unknown_ref_target')).toBe(true);
  });

  it('view.entity 不存在 → panorama_unknown_view_entity', () => {
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string } } }
views:
  - { id: v1, label: V, entity: ghost, component: table, columns: [id] }`);
    expect(code(r, 'panorama_unknown_view_entity')).toBe(true);
  });
});

describe('Layer 3 — kanban', () => {
  it('group_by 不存在 → panorama_unknown_group_by', () => {
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string } } }
views:
  - { id: v1, label: V, entity: x, component: kanban, group_by: st, columns: [a], card: { title: hi } }`);
    expect(code(r, 'panorama_unknown_group_by')).toBe(true);
  });

  it('group_by 非 enum → panorama_group_by_not_enum', () => {
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string }, txt: { type: string } } }
views:
  - { id: v1, label: V, entity: x, component: kanban, group_by: txt, columns: [a], card: { title: hi } }`);
    expect(code(r, 'panorama_group_by_not_enum')).toBe(true);
  });

  it('columns 缺少 enum 值 → warning (非 error)', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [a, b, c] }
    states:
      field: st
      initial: a
      transitions: {}
views:
  - { id: v1, label: V, entity: x, component: kanban, group_by: st, columns: [a], card: { title: hi } }`);
    expect(r.warnings.some(w => w.code === 'panorama_warn_missing_column')).toBe(true);
    expect(r.ok).toBe(true);
  });
});

describe('Layer 3 — card 模板', () => {
  it('card 模板引用不存在字段 → panorama_unknown_field_in_template', () => {
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string } } }
views:
  - { id: v1, label: V, entity: x, component: kanban, group_by: st, columns: [a], card: { title: "{ghost}" } }`);
    expect(code(r, 'panorama_unknown_field_in_template')).toBe(true);
  });

  it('ref 点导航用于非 ref 字段 → panorama_ref_navigation_on_non_ref', () => {
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string }, txt: { type: string } } }
views:
  - { id: v1, label: V, entity: x, component: kanban, group_by: st, columns: [a], card: { title: "{txt.bar}" } }`);
    expect(code(r, 'panorama_ref_navigation_on_non_ref')).toBe(true);
  });

  it('ref 导航目标实体无该字段 → panorama_unknown_ref_target_field', () => {
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string }, parent: { type: ref, entity: y } } }
  y: { label: Y, id_field: id, fields: { id: { type: string } } }
views:
  - { id: v1, label: V, entity: x, component: kanban, group_by: st, columns: [a], card: { title: "{parent.ghost}" } }`);
    expect(code(r, 'panorama_unknown_ref_target_field')).toBe(true);
  });

  it('badge 引用不存在字段 → panorama_unknown_badge_field', () => {
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string } } }
views:
  - { id: v1, label: V, entity: x, component: kanban, group_by: st, columns: [a], card: { title: hi, badges: [ghost] } }`);
    expect(code(r, 'panorama_unknown_badge_field')).toBe(true);
  });
});

describe('Layer 3 — table / bar_chart', () => {
  it('table column 不存在 → panorama_unknown_column', () => {
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string } } }
views:
  - { id: v1, label: V, entity: x, component: table, columns: [ghost] }`);
    expect(code(r, 'panorama_unknown_column')).toBe(true);
  });

  it('sort.field 不存在 → panorama_unknown_sort_field', () => {
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string } } }
views:
  - { id: v1, label: V, entity: x, component: table, columns: [id], sort: { field: ghost, order: asc } }`);
    expect(code(r, 'panorama_unknown_sort_field')).toBe(true);
  });

  it('bucket.field 非 datetime → panorama_bucket_not_datetime', () => {
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string } } }
views:
  - { id: v1, label: V, entity: x, component: bar_chart, bucket: { field: id, unit: day, days: 7 } }`);
    expect(code(r, 'panorama_bucket_not_datetime')).toBe(true);
  });

  it('stack_by 非 enum → panorama_stack_by_not_enum', () => {
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string }, dt: { type: datetime } } }
views:
  - { id: v1, label: V, entity: x, component: bar_chart, bucket: { field: dt, unit: day, days: 7 }, stack_by: id }`);
    expect(code(r, 'panorama_stack_by_not_enum')).toBe(true);
  });
});

describe('Layer 3 — 状态机一致性', () => {
  it('terminal 有出边 → panorama_terminal_has_outgoing', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [a, b, c] }
    states:
      field: st
      initial: a
      transitions:
        a: [b]
        b: [c]
      terminal: [b]
views: []`);
    expect(code(r, 'panorama_terminal_has_outgoing')).toBe(true);
  });
});

describe('Layer 3 — ref 无环', () => {
  it('ref 循环 A→B→A → panorama_circular_ref', () => {
    const r = validateSchema(`
entities:
  a:
    label: A
    id_field: id
    fields:
      id: { type: string }
      rb: { type: ref, entity: b }
  b:
    label: B
    id_field: id
    fields:
      id: { type: string }
      ra: { type: ref, entity: a }
views: []`);
    expect(code(r, 'panorama_circular_ref')).toBe(true);
  });

  it('自引用 ref (A→A) 不报循环', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      self: { type: ref, entity: x }
views: []`);
    expect(code(r, 'panorama_circular_ref')).toBe(false);
  });
});

// v0.0.259 — system entity 恒在可引用（panorama_builtin §3 决策5）：
// leader 即使未在 entities 声明 task，ref.entity/view.entity 指向 task 也合法；
// view 用 SYSTEM_ENTITY_DEFS.task canonical def 校下游（group_by/columns/card/badges）。
// 双断言核心：① view→task 未声明通过；② 改 task schema 字段仍 immutable（不破既有保护）。
describe('Layer 3 — system entity 恒在可引用 (v0.0.259)', () => {
  it('view.entity=task 但 entities 无 task → 不报 panorama_unknown_view_entity，下游用 canonical def 校验通过', () => {
    // task canonical def: status enum (todo/waiting/in_progress/done), title 字段存在
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string } } }
views:
  - { id: v1, label: V, entity: task, component: kanban, group_by: status, columns: [todo, waiting, in_progress, done], card: { title: "{title}" } }`);
    expect(code(r, 'panorama_unknown_view_entity')).toBe(false);
    expect(code(r, 'panorama_unknown_group_by')).toBe(false);
    expect(code(r, 'panorama_group_by_not_enum')).toBe(false);
    expect(code(r, 'panorama_unknown_field_in_template')).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('view.entity=task + badges=[owner,status] → canonical def 字段存在校验通过', () => {
    // TASK_ENTITY_DEF.fields 含 owner / status；TASK_VIEW_DEF.badges=['owner','status']
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string } } }
views:
  - { id: v1, label: V, entity: task, component: kanban, group_by: status, columns: [todo, waiting, in_progress, done], card: { title: "{title}", badges: [owner, status] } }`);
    expect(code(r, 'panorama_unknown_badge_field')).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('ref.entity=task（leader entity 字段 ref→task）且 entities 无 task → 不报 panorama_unknown_ref_target', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      task_ref: { type: ref, entity: task }
views: []`);
    expect(code(r, 'panorama_unknown_ref_target')).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('反例（回归保护）：leader 改 task.label → 仍由 checkSystemEntityImmutable 报 panorama_system_entity_immutable', () => {
    // leader 提交 task 但 label 漂移（canonical='任务'）+ fields 缺失 → immutable error
    // 验证 semantic 改动没破坏 v0.0.243 的 immutable 保护
    const r = validateSchema(`
entities:
  task:
    label: 被改的标签
    id_field: id
    fields:
      id: { type: string }
views: []`);
    expect(code(r, 'panorama_system_entity_immutable')).toBe(true);
  });
});
