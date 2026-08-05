/**
 * validate_transition UT — terminal 锁 / transitions 表 / guard 求值.
 * 参考: specs/tech/squad/[P1]panorama_validation.md §7
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { validateTransition } from '../validate_transition';
import { parseDsl } from '../../dsl/parser';
import type { PanoramaSchema } from '../../dsl/types';

const SCHEMA_TEXT = `
meta: { version: "1.0" }
entities:
  task:
    label: Task
    id_field: id
    fields:
      id:     { type: string }
      status: { type: enum, values: [todo, doing, done, cancelled] }
      score:  { type: number }
    states:
      field: status
      initial: todo
      transitions:
        todo:   [doing, cancelled]
        doing:  [{ to: done, guard: { field: score, op: gte, value: 60 } }, cancelled]
      terminal: [done, cancelled]
views: []`;

let schema: PanoramaSchema;
beforeAll(() => {
  const r = parseDsl(SCHEMA_TEXT);
  if (!r.ok) throw new Error('test schema parse failed');
  schema = r.schema;
});


describe('validateTransition — 合法跃迁', () => {
  it('todo → doing ok', () => {
    expect(validateTransition(schema, 'task', 'todo', 'doing').ok).toBe(true);
  });

  it('doing → done (guard 满足)', () => {
    expect(validateTransition(schema, 'task', 'doing', 'done', { score: 80 }).ok).toBe(true);
  });

  it('todo → cancelled (无 guard) ok', () => {
    expect(validateTransition(schema, 'task', 'todo', 'cancelled').ok).toBe(true);
  });
});

describe('validateTransition — 非法状态', () => {
  it('from 不在 enum → illegal_transition', () => {
    const r = validateTransition(schema, 'task', 'ghost', 'todo');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('panorama_illegal_transition');
  });

  it('to 不在 enum → illegal_transition', () => {
    const r = validateTransition(schema, 'task', 'todo', 'ghost');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('panorama_illegal_transition');
  });
});

describe('validateTransition — 终态锁', () => {
  it('done (terminal) 不可跃迁 → terminal_locked', () => {
    const r = validateTransition(schema, 'task', 'done', 'todo');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('panorama_terminal_locked');
    expect(r.suggestion).toBeTruthy();
  });

  it('cancelled (terminal) 不可跃迁', () => {
    expect(validateTransition(schema, 'task', 'cancelled', 'todo').code)
      .toBe('panorama_terminal_locked');
  });
});

describe('validateTransition — transitions 表', () => {
  it('done → cancelled 不在表（done 是 terminal 先锁）', () => {
    // done is terminal, so terminal_locked fires first
    expect(validateTransition(schema, 'task', 'done', 'cancelled').code)
      .toBe('panorama_terminal_locked');
  });

  it('todo → done 不在 transitions 表 → illegal_transition', () => {
    const r = validateTransition(schema, 'task', 'todo', 'done');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('panorama_illegal_transition');
    expect(r.suggestion).toContain('doing');
  });

  it('doing → todo 不在表 → illegal_transition', () => {
    expect(validateTransition(schema, 'task', 'doing', 'todo').code)
      .toBe('panorama_illegal_transition');
  });
});

describe('validateTransition — guard 求值', () => {
  it('score < 60 → guard_failed', () => {
    const r = validateTransition(schema, 'task', 'doing', 'done', { score: 30 });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('panorama_guard_failed');
    expect(r.suggestion).toContain('score');
    expect(r.suggestion).toContain('30');
  });

  it('score = 60 (gte) → ok', () => {
    expect(validateTransition(schema, 'task', 'doing', 'done', { score: 60 }).ok).toBe(true);
  });

  it('score 未提供 → guard 跳过（undefined instance）', () => {
    // 不传 instance → guard 不求值，视为 ok
    const r = validateTransition(schema, 'task', 'doing', 'done');
    expect(r.ok).toBe(true);
  });

  it('guard op in / not_in', () => {
    const text = `
meta: { version: "1.0" }
entities:
  x:
    label: X
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [a, b, c] }
      cat: { type: string }
    states:
      field: st
      initial: a
      transitions:
        a: [{ to: c, guard: { field: cat, op: in, value: [p1, p2] } }]
views: []`;
    const parsed = parseDsl(text);
    if (!parsed.ok) throw new Error('parse failed');
    expect(validateTransition(parsed.schema, 'x', 'a', 'c', { cat: 'p1' }).ok).toBe(true);
    expect(validateTransition(parsed.schema, 'x', 'a', 'c', { cat: 'p3' }).ok).toBe(false);
    expect(validateTransition(parsed.schema, 'x', 'a', 'c', { cat: 'p3' }).code)
      .toBe('panorama_guard_failed');
  });

  // m3: 8 op 全覆盖（gte/gt/in/eq/ne/lt/lte/not_in）
  it('guard op eq/ne（字符串相等）', () => {
    const text = `
meta: { version: "1.0" }
entities:
  eq:
    label: Eq
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [s, e] }
      role: { type: string }
    states:
      field: st
      initial: s
      transitions:
        s: [{ to: e, guard: { field: role, op: eq, value: admin } }]
views: []`;
    const parsed = parseDsl(text);
    if (!parsed.ok) throw new Error('parse failed');
    expect(validateTransition(parsed.schema, 'eq', 's', 'e', { role: 'admin' }).ok).toBe(true);
    expect(validateTransition(parsed.schema, 'eq', 's', 'e', { role: 'user' }).ok).toBe(false);
  });

  it('guard op ne（不相等）', () => {
    const text = `
meta: { version: "1.0" }
entities:
  ne:
    label: Ne
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [s, e] }
      role: { type: string }
    states:
      field: st
      initial: s
      transitions:
        s: [{ to: e, guard: { field: role, op: ne, value: blocked } }]
views: []`;
    const parsed = parseDsl(text);
    if (!parsed.ok) throw new Error('parse failed');
    expect(validateTransition(parsed.schema, 'ne', 's', 'e', { role: 'user' }).ok).toBe(true);
    expect(validateTransition(parsed.schema, 'ne', 's', 'e', { role: 'blocked' }).ok).toBe(false);
  });

  it('guard op lt（小于）', () => {
    const text = `
meta: { version: "1.0" }
entities:
  lt:
    label: Lt
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [s, e] }
      n: { type: number }
    states:
      field: st
      initial: s
      transitions:
        s: [{ to: e, guard: { field: n, op: lt, value: 10 } }]
views: []`;
    const parsed = parseDsl(text);
    if (!parsed.ok) throw new Error('parse failed');
    expect(validateTransition(parsed.schema, 'lt', 's', 'e', { n: 5 }).ok).toBe(true);
    expect(validateTransition(parsed.schema, 'lt', 's', 'e', { n: 10 }).ok).toBe(false);
    expect(validateTransition(parsed.schema, 'lt', 's', 'e', { n: 15 }).ok).toBe(false);
  });

  it('guard op lte（小于等于）', () => {
    const text = `
meta: { version: "1.0" }
entities:
  lte:
    label: Lte
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [s, e] }
      n: { type: number }
    states:
      field: st
      initial: s
      transitions:
        s: [{ to: e, guard: { field: n, op: lte, value: 10 } }]
views: []`;
    const parsed = parseDsl(text);
    if (!parsed.ok) throw new Error('parse failed');
    expect(validateTransition(parsed.schema, 'lte', 's', 'e', { n: 10 }).ok).toBe(true);
    expect(validateTransition(parsed.schema, 'lte', 's', 'e', { n: 11 }).ok).toBe(false);
  });

  it('guard op gt（大于）', () => {
    const text = `
meta: { version: "1.0" }
entities:
  gt:
    label: Gt
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [s, e] }
      n: { type: number }
    states:
      field: st
      initial: s
      transitions:
        s: [{ to: e, guard: { field: n, op: gt, value: 10 } }]
views: []`;
    const parsed = parseDsl(text);
    if (!parsed.ok) throw new Error('parse failed');
    expect(validateTransition(parsed.schema, 'gt', 's', 'e', { n: 15 }).ok).toBe(true);
    expect(validateTransition(parsed.schema, 'gt', 's', 'e', { n: 10 }).ok).toBe(false);
    expect(validateTransition(parsed.schema, 'gt', 's', 'e', { n: 5 }).ok).toBe(false);
  });

  it('guard op not_in（不在列表中）', () => {
    const text = `
meta: { version: "1.0" }
entities:
  ni:
    label: Ni
    id_field: id
    fields:
      id: { type: string }
      st: { type: enum, values: [s, e] }
      cat: { type: string }
    states:
      field: st
      initial: s
      transitions:
        s: [{ to: e, guard: { field: cat, op: not_in, value: [x1, x2] } }]
views: []`;
    const parsed = parseDsl(text);
    if (!parsed.ok) throw new Error('parse failed');
    expect(validateTransition(parsed.schema, 'ni', 's', 'e', { cat: 'ok' }).ok).toBe(true);
    expect(validateTransition(parsed.schema, 'ni', 's', 'e', { cat: 'x1' }).ok).toBe(false);
  });
});

describe('validateTransition — 边界', () => {
  it('实体不存在 → error', () => {
    const r = validateTransition(schema, 'ghost', 'a', 'b');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('panorama_unknown_entity');
  });

  it('实体无状态机 → error', () => {
    const text = `
meta: { version: "1.0" }
entities:
  nostate:
    label: NoState
    id_field: id
    fields: { id: { type: string } }
views: []`;
    const parsed = parseDsl(text);
    if (!parsed.ok) throw new Error('parse failed');
    const r = validateTransition(parsed.schema, 'nostate', 'a', 'b');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('panorama_no_state_machine');
  });
});
