/**
 * validate_schema UT — Layer 1 短路 + Layer 2 schema 层覆盖.
 * 参考: specs/tech/squad/[P1]panorama_validation.md §2-§3
 * Layer 3 语义层测试在 validate_semantic.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { validateSchema, validateSyntax } from '../validate_schema';

const VALID_DSL = `
meta:
  version: "1.0"
entities:
  pipeline_run:
    label: Pipeline
    id_field: id
    fields:
      id:           { type: string }
      branch:       { type: string, max: 200 }
      status:       { type: enum, values: [queued, running, success, failed] }
      duration_sec: { type: number, min: 0, max: 86400 }
      is_hotfix:    { type: boolean }
      pipeline_ref: { type: ref, entity: pipeline_run }
      started_at:   { type: datetime }
    states:
      field: status
      initial: queued
      transitions:
        queued:  [running]
        running: [{ to: success, guard: { field: duration_sec, op: gt, value: 0 } }]
      terminal: [success, failed]
views:
  - id: run_kanban
    label: Kanban
    entity: pipeline_run
    component: kanban
    group_by: status
    columns: [queued, running, success, failed]
    card:
      title: "{id} . {branch}"
      badges: [status]
      footer: "{duration_sec}s"
  - id: run_table
    label: Table
    entity: pipeline_run
    component: table
    columns: [id, branch, status]
  - id: run_chart
    label: Chart
    entity: pipeline_run
    component: bar_chart
    bucket: { field: started_at, unit: day, days: 7 }
    stack_by: status
`;

const code = (r: { errors: { code: string }[] }, c: string) =>
  r.errors.some(e => e.code === c);

describe('validateSchema — 合法 DSL', () => {
  it('全量合法 DSL → ok=true', () => {
    const r = validateSchema(VALID_DSL);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });
});

describe('validateSchema — Layer 1 短路', () => {
  it('YAML 解析失败 → 短路返回 syntax error', () => {
    const r = validateSchema('entities: [bad\n\tindent]');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.layer).toBe('syntax');
  });

  it('validateSyntax 单独跑 Layer 1', () => {
    const r = validateSyntax('entities: {}');
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.path === 'views')).toBe(true);
  });
});

describe('validateSchema — Layer 2 schema 层', () => {
  it('meta.updated_at 手填 → panorama_manual_updated_at（M3）', () => {
    const r = validateSchema(`
meta:
  version: "1.0"
  updated_at: "2026-07-22T00:00:00Z"
entities:
  x: { label: X, id_field: id, fields: { id: { type: string } } }
views: []`);
    expect(code(r, 'panorama_manual_updated_at')).toBe(true);
  });

  it('meta.updated_at 缺省 → 不报 panorama_manual_updated_at', () => {
    const r = validateSchema(`
meta:
  version: "1.0"
entities:
  x: { label: X, id_field: id, fields: { id: { type: string } } }
views: []`);
    expect(code(r, 'panorama_manual_updated_at')).toBe(false);
  });

  it('id_field 非 string → panorama_id_field_not_string', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: num
    fields:
      id: { type: string }
      num: { type: number }
views: []`);
    expect(code(r, 'panorama_id_field_not_string')).toBe(true);
  });

  it('id_field 指向不存在字段 → panorama_id_field_not_string', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: nonexistent
    fields:
      id: { type: string }
views: []`);
    expect(code(r, 'panorama_id_field_not_string')).toBe(true);
  });

  it('enum 值格式不对 → panorama_invalid_enum_value', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [ok, BadCase] }
views: []`);
    expect(code(r, 'panorama_invalid_enum_value')).toBe(true);
  });

  it('enum 值重复 → panorama_duplicate_enum_value', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [a, a, b] }
views: []`);
    expect(code(r, 'panorama_duplicate_enum_value')).toBe(true);
  });

  it('string.max 非正整数 → panorama_invalid_max', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      s: { type: string, max: 0 }
views: []`);
    expect(code(r, 'panorama_invalid_max')).toBe(true);
  });

  it('number.min > max → panorama_invalid_range', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      n: { type: number, min: 100, max: 10 }
views: []`);
    expect(code(r, 'panorama_invalid_range')).toBe(true);
  });

  it('states.field 非 enum → panorama_state_field_not_enum', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      txt: { type: string }
    states:
      field: txt
      initial: foo
      transitions: {}
views: []`);
    expect(code(r, 'panorama_state_field_not_enum')).toBe(true);
  });

  it('initial 不在 enum values → panorama_invalid_initial', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [a, b] }
    states:
      field: st
      initial: zzz
      transitions: {}
views: []`);
    expect(code(r, 'panorama_invalid_initial')).toBe(true);
  });

  it('transition to 不在 enum → panorama_invalid_transition_target', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [a, b] }
    states:
      field: st
      initial: a
      transitions:
        a: [zzz]
views: []`);
    expect(code(r, 'panorama_invalid_transition_target')).toBe(true);
  });

  it('terminal 不在 enum → panorama_invalid_terminal', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [a, b] }
    states:
      field: st
      initial: a
      transitions: {}
      terminal: [zzz]
views: []`);
    expect(code(r, 'panorama_invalid_terminal')).toBe(true);
  });

  it('guard.field 不存在 → panorama_guard_unknown_field', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [a, b] }
    states:
      field: st
      initial: a
      transitions:
        a: [{ to: b, guard: { field: nonexistent, op: gt, value: 0 } }]
views: []`);
    expect(code(r, 'panorama_guard_unknown_field')).toBe(true);
  });

  it('display color 非 hex → panorama_invalid_color', () => {
    const r = validateSchema(`
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [a, b] }
    states:
      field: st
      initial: a
      transitions: {}
    display:
      status_colors: { a: "not-a-color" }
views: []`);
    expect(code(r, 'panorama_invalid_color')).toBe(true);
  });

  it('view id 重复 → panorama_duplicate_view_id', () => {
    const r = validateSchema(`
entities:
  x: { label: X, id_field: id, fields: { id: { type: string } } }
views:
  - { id: dup, label: A, entity: x, component: table, columns: [id] }
  - { id: dup, label: B, entity: x, component: table, columns: [id] }`);
    expect(code(r, 'panorama_duplicate_view_id')).toBe(true);
  });

  it('跨实体同名 enum values 不一致 → panorama_enum_name_collision', () => {
    const r = validateSchema(`
entities:
  a:
    label: A
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [x, y] }
  b:
    label: B
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [x, y, z] }
views: []`);
    expect(code(r, 'panorama_enum_name_collision')).toBe(true);
  });
});
