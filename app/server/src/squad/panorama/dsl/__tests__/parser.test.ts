/**
 * parser UT — parseDsl 覆盖：合法 DSL / YAML 错误 / 根类型 / 缺顶层键 /
 * meta 默认值 / 护栏上限 / 字段类型 / enum / ref / transitions 归一化 / views.
 * 参考: specs/tech/squad/[P1]panorama_dsl.md §1-§6
 */
import { describe, it, expect } from 'vitest';
import { parseDsl, LIMITS } from '../parser';

const VALID_DSL = `
meta:
  version: "1.0"
  author: "session-1"
version:
  id: dev
  name: Dev
  board_name: CI/CD
entities:
  pipeline_run:
    label: Pipeline
    id_field: id
    fields:
      id:           { type: string }
      branch:       { type: string, max: 200 }
      commit:       { type: string, pattern: "^[0-9a-f]{7}$" }
      status:       { type: enum, values: [queued, running, success, failed] }
      duration_sec: { type: number, min: 0 }
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
    display:
      status_labels: { queued: Q, running: R }
      status_colors: { queued: "#888" }
views:
  - id: run_kanban
    label: Kanban
    entity: pipeline_run
    component: kanban
    group_by: status
    columns: [queued, running, success, failed]
    card:
      title: "{id} . {branch}"
      badges: [status, commit]
      footer: "{duration_sec}s"
  - id: run_table
    label: Table
    entity: pipeline_run
    component: table
    columns: [id, branch, status]
    sort: { field: started_at, order: desc }
    limit: 50
  - id: run_chart
    label: Chart
    entity: pipeline_run
    component: bar_chart
    bucket: { field: started_at, unit: day, days: 7 }
    stack_by: status
`;

describe('parseDsl — Layer 1 语法层', () => {
  it('YAML 解析失败 → panorama_yaml_parse_error', () => {
    const r = parseDsl('entities: [invalid\n\tindent]');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.code).toBe('panorama_yaml_parse_error');
      expect(r.errors[0]!.layer).toBe('syntax');
    }
  });

  it('根非 map → panorama_invalid_root', () => {
    const r = parseDsl('- just\n- an\n- array');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe('panorama_invalid_root');
  });

  it('缺 entities → panorama_missing_top_level', () => {
    const r = parseDsl('views: []');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.path === 'entities')).toBe(true);
  });

  it('缺 views → panorama_missing_top_level', () => {
    const r = parseDsl('entities: {}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.path === 'views')).toBe(true);
  });
});

describe('parseDsl — meta 默认值', () => {
  it('meta 缺失 → 填默认 version="1.0" + warning', () => {
    const r = parseDsl('entities: {}\nviews: []');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema.meta.version).toBe('1.0');
      expect(r.warnings.some(w => w.code === 'panorama_meta_default')).toBe(true);
    }
  });

  it('meta.version 格式不对 → warning + 填默认', () => {
    const r = parseDsl('meta:\n  version: "abc"\nentities: {}\nviews: []');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema.meta.version).toBe('1.0');
      expect(r.warnings.length).toBeGreaterThan(0);
    }
  });

  it('meta 完整 → 无 warning', () => {
    const r = parseDsl('meta:\n  version: "1.0"\n  author: "s1"\nentities: {}\nviews: []');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema.meta.author).toBe('s1');
      expect(r.warnings.length).toBe(0);
    }
  });
});

describe('parseDsl — 合法 DSL 全量', () => {
  it('返回 ok:true + 完整 schema', () => {
    const r = parseDsl(VALID_DSL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { schema } = r;
    expect(schema.meta.version).toBe('1.0');
    expect(schema.version?.board_name).toBe('CI/CD');

    const ent = schema.entities['pipeline_run']!;
    expect(ent.label).toBe('Pipeline');
    expect(ent.id_field).toBe('id');
    expect(ent.fields['id']!.type).toBe('string');
    expect(ent.fields['status']!.type).toBe('enum');
    expect(ent.fields['duration_sec']).toMatchObject({ type: 'number', min: 0 });
    expect(ent.fields['pipeline_ref']).toMatchObject({ type: 'ref', entity: 'pipeline_run' });

    // states + transitions 归一化
    expect(ent.states?.field).toBe('status');
    expect(ent.states?.initial).toBe('queued');
    expect(ent.states?.transitions['queued']).toEqual([{ to: 'running' }]);
    expect(ent.states?.transitions['running']).toEqual([
      { to: 'success', guard: { field: 'duration_sec', op: 'gt', value: 0 } },
    ]);
    expect(ent.states?.terminal).toEqual(['success', 'failed']);

    // views
    expect(schema.views).toHaveLength(3);
    const kb = schema.views[0]!;
    expect(kb.component).toBe('kanban');
    if (kb.component === 'kanban') {
      expect(kb.group_by).toBe('status');
      expect(kb.card.title).toBe('{id} . {branch}');
    }
    const tb = schema.views[1]!;
    expect(tb.component).toBe('table');
    if (tb.component === 'table') expect(tb.sort).toEqual({ field: 'started_at', order: 'desc' });
    const bc = schema.views[2]!;
    expect(bc.component).toBe('bar_chart');
    if (bc.component === 'bar_chart') expect(bc.bucket).toEqual({ field: 'started_at', unit: 'day', days: 7 });
  });
});

describe('parseDsl — 字段类型校验', () => {
  it('未知 type → panorama_invalid_field_type', () => {
    const r = parseDsl('entities:\n  x:\n    label: X\n    id_field: id\n    fields:\n      id: { type: string }\n      bad: { type: json }\nviews: []');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'panorama_invalid_field_type')).toBe(true);
  });

  it('enum 缺 values → panorama_missing_enum_values', () => {
    const r = parseDsl('entities:\n  x:\n    label: X\n    id_field: id\n    fields:\n      id: { type: string }\n      s: { type: enum }\nviews: []');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'panorama_missing_enum_values')).toBe(true);
  });

  it('ref 缺 entity → panorama_missing_ref_entity', () => {
    const r = parseDsl('entities:\n  x:\n    label: X\n    id_field: id\n    fields:\n      id: { type: string }\n      r: { type: ref }\nviews: []');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'panorama_missing_field' && e.path.includes('.entity'))).toBe(true);
  });
});

describe('parseDsl — 实体名校验', () => {
  it('大写开头 → panorama_invalid_entity_name', () => {
    const r = parseDsl('entities:\n  BadName:\n    label: X\n    id_field: id\n    fields:\n      id: { type: string }\nviews: []');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'panorama_invalid_entity_name')).toBe(true);
  });
});

describe('parseDsl — transitions 归一化', () => {
  it('shorthand 字符串归一化为 {to}', () => {
    const r = parseDsl(`entities:
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
        a: [b, c]
        b: [c]
views: []`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const tr = r.schema.entities['x']!.states!.transitions;
      expect(tr['a']).toEqual([{ to: 'b' }, { to: 'c' }]);
      expect(tr['b']).toEqual([{ to: 'c' }]);
    }
  });

  it('shorthand + longhand 混用', () => {
    const r = parseDsl(`entities:
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
        a: [b, { to: c }]
views: []`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.schema.entities['x']!.states!.transitions['a']).toEqual([
        { to: 'b' }, { to: 'c' },
      ]);
    }
  });
});

describe('parseDsl — 护栏上限', () => {
  it('实体数 > 20 → panorama_limit_entities', () => {
    const ents: string[] = [];
    for (let i = 0; i <= LIMITS.MAX_ENTITIES; i++) ents.push(`e${i}:`);
    const yaml = `entities:\n${ents.map(e => `  ${e} { label: X, id_field: id, fields: { id: { type: string } } }`).join('\n')}\nviews: []`;
    const r = parseDsl(yaml);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'panorama_limit_entities')).toBe(true);
  });

  it('view 数 > 10 → panorama_limit_views', () => {
    const views: string[] = [];
    for (let i = 0; i <= LIMITS.MAX_VIEWS; i++) {
      views.push(`  - { id: v${i}, label: V, entity: x, component: table, columns: [id] }`);
    }
    const r = parseDsl(`entities:\n  x: { label: X, id_field: id, fields: { id: { type: string } } }\nviews:\n${views.join('\n')}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'panorama_limit_views')).toBe(true);
  });

  it('enum 值 > 15 → panorama_limit_enum_values', () => {
    const vals = Array.from({ length: 16 }, (_, i) => `v${i}`);
    const r = parseDsl(`entities:\n  x:\n    label: X\n    id_field: id\n    fields:\n      id: { type: string }\n      st: { type: enum, values: [${vals.join(', ')}] }\nviews: []`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'panorama_limit_enum_values')).toBe(true);
  });

  it('字段数 > 30 → panorama_limit_fields', () => {
    const fields: string[] = [];
    for (let i = 0; i <= LIMITS.MAX_FIELDS; i++) fields.push(`f${i}: { type: string }`);
    const r = parseDsl(`entities:\n  x:\n    label: X\n    id_field: id\n    fields:\n${fields.map(f => `      ${f}`).join('\n')}\nviews: []`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'panorama_limit_fields')).toBe(true);
  });
  it('card 模板长度 > 200 → panorama_limit_card_template', () => {
    const r = parseDsl(`entities:\n  x: { label: X, id_field: id, fields: { id: { type: string }, st: { type: enum, values: [a, b] } } }\nviews:\n  - { id: v1, label: V, entity: x, component: kanban, group_by: st, columns: [a, b], card: { title: "${'x'.repeat(201)}" } }`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'panorama_limit_card_template')).toBe(true);
  });
  it('transitions 出边 > 10 → panorama_limit_transitions', () => {
    const ts = Array.from({ length: 11 }, (_, i) => `s${i}`).join(', ');
    const r = parseDsl(`entities:\n  x:\n    label: X\n    id_field: id\n    fields:\n      id: { type: string }\n      st: { type: enum, values: [${ts}] }\n    states:\n      field: st\n      initial: s0\n      transitions:\n        s0: [${ts}]\nviews: []`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'panorama_limit_transitions')).toBe(true);
  });
});

describe('parseDsl — views 校验', () => {
  it('无效 component → panorama_invalid_view_component', () => {
    const r = parseDsl(`entities:\n  x: { label: X, id_field: id, fields: { id: { type: string } } }\nviews:\n  - { id: v1, label: V, entity: x, component: pie_chart }`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.code === 'panorama_invalid_view_component')).toBe(true);
  });

  it('kanban 缺 card → error', () => {
    const r = parseDsl(`entities:\n  x: { label: X, id_field: id, fields: { id: { type: string } } }\nviews:\n  - { id: v1, label: V, entity: x, component: kanban, group_by: st, columns: [a] }`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some(e => e.path.includes('card'))).toBe(true);
  });
});