/**
 * diffSchema UT — 变更检测覆盖：
 *   加实体/删实体/加字段/删字段/改类型/enum扩值/enum收窄/约束收紧放宽/
 *   states.field变更/transition增删/terminal扩缩/view增删改/display变更/meta变更.
 */
import { describe, it, expect } from 'vitest';
import { diffSchema } from '../diff_schema';
import type { PanoramaSchema } from '../../dsl/types';

function baseSchema(): PanoramaSchema {
  return {
    meta: { version: '1.0', author: 's1' },
    entities: {
      pipeline_run: {
        label: 'Pipeline',
        id_field: 'id',
        fields: {
          id: { type: 'string' },
          status: { type: 'enum', values: ['queued', 'running', 'success'] },
          duration_sec: { type: 'number', min: 0, max: 600 },
        },
        states: {
          field: 'status',
          initial: 'queued',
          transitions: { queued: [{ to: 'running' }] },
          terminal: ['success'],
        },
        display: { status_colors: { queued: '#888' } },
      },
    },
    views: [{ id: 'run_kanban', label: 'Kanban', entity: 'pipeline_run', component: 'kanban', group_by: 'status', columns: ['queued', 'running', 'success'], card: { title: '{id}' } }],
  };
}

const kinds = (changes: { kind: string }[]) => changes.map(c => c.kind);

function ent(s: PanoramaSchema) {
  return s.entities.pipeline_run!;
}


describe('diffSchema — 实体级', () => {
  it('加实体 → entity_added', () => {
    const old = baseSchema();
    const next: PanoramaSchema = { ...old, entities: { ...old.entities, task: { label: 'T', id_field: 'id', fields: { id: { type: 'string' } } } } };
    expect(kinds(diffSchema(old, next))).toContain('entity_added');
  });

  it('删实体 → entity_deleted', () => {
    const old = baseSchema();
    const next = { ...old, entities: {} };
    expect(kinds(diffSchema(old, next))).toContain('entity_deleted');
  });
});

describe('diffSchema — 字段级', () => {
  it('加字段 → field_added', () => {
    const old = baseSchema();
    const next = baseSchema();
    ent(next).fields.branch = { type: 'string' };
    expect(kinds(diffSchema(old, next))).toContain('field_added');
  });

  it('删字段 → field_deleted', () => {
    const old = baseSchema();
    const next = baseSchema();
    delete ent(next).fields.duration_sec;
    expect(kinds(diffSchema(old, next))).toContain('field_deleted');
  });

  it('改字段类型 → field_type_changed', () => {
    const old = baseSchema();
    const next = baseSchema();
    ent(next).fields.duration_sec = { type: 'string' };
    expect(kinds(diffSchema(old, next))).toContain('field_type_changed');
  });

  it('enum 扩值 → enum_expanded', () => {
    const old = baseSchema();
    const next = baseSchema();
    (ent(next).fields.status as { values: string[] }).values.push('failed');
    expect(kinds(diffSchema(old, next))).toContain('enum_expanded');
  });

  it('enum 收窄 → enum_narrowed', () => {
    const old = baseSchema();
    const next = baseSchema();
    (ent(next).fields.status as { values: string[] }).values = ['queued', 'running'];
    expect(kinds(diffSchema(old, next))).toContain('enum_narrowed');
  });

  it('约束 max 减小 → constraint_tightened', () => {
    const old = baseSchema();
    const next = baseSchema();
    (ent(next).fields.duration_sec as { min: number; max: number }).max = 300;
    expect(kinds(diffSchema(old, next))).toContain('constraint_tightened');
  });

  it('约束 max 增大 → constraint_relaxed', () => {
    const old = baseSchema();
    const next = baseSchema();
    (ent(next).fields.duration_sec as { min: number; max: number }).max = 1200;
    expect(kinds(diffSchema(old, next))).toContain('constraint_relaxed');
  });
});

describe('diffSchema — states', () => {
  it('states.field 变更 → state_field_changed', () => {
    const old = baseSchema();
    const next = baseSchema();
    ent(next).states!.field = 'phase';
    expect(kinds(diffSchema(old, next))).toContain('state_field_changed');
  });

  it('加 transition 出边 → transition_added', () => {
    const old = baseSchema();
    const next = baseSchema();
    ent(next).states!.transitions.running = [{ to: 'success' }];
    expect(kinds(diffSchema(old, next))).toContain('transition_added');
  });

  it('删 transition 出边 → transition_removed', () => {
    const old = baseSchema();
    const next = baseSchema();
    delete ent(next).states!.transitions.queued;
    expect(kinds(diffSchema(old, next))).toContain('transition_removed');
  });

  it('terminal 扩大 → terminal_expanded', () => {
    const old = baseSchema();
    const next = baseSchema();
    ent(next).states!.terminal = ['success', 'failed'];
    expect(kinds(diffSchema(old, next))).toContain('terminal_expanded');
  });

  it('terminal 缩小 → terminal_shrunk', () => {
    const old = baseSchema();
    const next = baseSchema();
    ent(next).states!.terminal = [];
    expect(kinds(diffSchema(old, next))).toContain('terminal_shrunk');
  });
});

describe('diffSchema — views + display + meta', () => {
  it('加视图 → view_added', () => {
    const old = baseSchema();
    const next = { ...old, views: [...old.views, { id: 'table1', label: 'T', entity: 'pipeline_run', component: 'table' as const, columns: ['id'] }] };
    expect(kinds(diffSchema(old, next))).toContain('view_added');
  });

  it('删视图 → view_deleted', () => {
    const old = baseSchema();
    const next = { ...old, views: [] };
    expect(kinds(diffSchema(old, next))).toContain('view_deleted');
  });

  it('视图配置变更 → view_modified', () => {
    const old = baseSchema();
    const next = baseSchema();
    (next.views[0] as { label: string }).label = 'Updated Kanban';
    expect(kinds(diffSchema(old, next))).toContain('view_modified');
  });

  it('display 变更 → display_changed', () => {
    const old = baseSchema();
    const next = baseSchema();
    ent(next).display = { status_colors: { queued: '#fff' } };
    expect(kinds(diffSchema(old, next))).toContain('display_changed');
  });

  it('meta 变更 → meta_updated', () => {
    const old = baseSchema();
    const next = { ...old, meta: { version: '2.0', author: 's2' } };
    expect(kinds(diffSchema(old, next))).toContain('meta_updated');
  });
});

describe('diffSchema — 无变更', () => {
  it('完全相同 → 空数组', () => {
    const s = baseSchema();
    expect(diffSchema(s, s)).toHaveLength(0);
  });
});
