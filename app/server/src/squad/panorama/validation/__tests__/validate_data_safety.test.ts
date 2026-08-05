/**
 * validate_data_safety UT — Layer 4 七项破坏性判定的正反例覆盖（M1）.
 * 参考: specs/tech/squad/[P1]panorama_validation.md §5
 */
import { describe, it, expect } from 'vitest';
import { validateDataSafety } from '../validate_data_safety';
import type { PanoramaSchema, EntityDef } from '../../dsl/types';
import type { StoreLike } from '../types';

/** 构造一个带 enum 状态字段的实体骨架 */
function entity(over: Partial<EntityDef>): EntityDef {
  return {
    label: over.label ?? 'X',
    id_field: over.id_field ?? 'id',
    fields: over.fields ?? { id: { type: 'string' } },
    states: over.states,
    display: over.display,
  };
}

function schema(entities: Record<string, EntityDef>): PanoramaSchema {
  return { meta: { version: '1.0' }, entities, views: [] };
}

/** mock store：返回固定实例列表 */
function storeOf(data: Record<string, Record<string, unknown>[]>): StoreLike {
  return { listInstances: (e: string) => data[e] ?? [] };
}

const has = (errs: { code: string }[], c: string) => errs.some(e => e.code === c);

describe('checkDroppedFields — 4.2 删字段', () => {
  it('删字段且有非空值 → panorama_dropping_field_data', () => {
    const oldS = schema({ x: entity({ fields: { id: { type: 'string' }, note: { type: 'string' } } }) });
    const newS = schema({ x: entity({ fields: { id: { type: 'string' } } }) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', note: 'hello' }] }), errors as never);
    expect(has(errors, 'panorama_dropping_field_data')).toBe(true);
  });

  it('删字段但存量值为空 → 不报错', () => {
    const oldS = schema({ x: entity({ fields: { id: { type: 'string' }, note: { type: 'string' } } }) });
    const newS = schema({ x: entity({ fields: { id: { type: 'string' } } }) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', note: '' }] }), errors as never);
    expect(errors).toHaveLength(0);
  });

  it('删字段但无存量实例 → 不报错', () => {
    const oldS = schema({ x: entity({ fields: { id: { type: 'string' }, note: { type: 'string' } } }) });
    const newS = schema({ x: entity({ fields: { id: { type: 'string' } } }) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [] }), errors as never);
    expect(errors).toHaveLength(0);
  });
});

describe('checkTypeChanges — 4.4 改字段类型', () => {
  it('同名字段类型变更且有实例 → panorama_field_type_changed', () => {
    const oldS = schema({ x: entity({ fields: { id: { type: 'string' }, n: { type: 'number' } } }) });
    const newS = schema({ x: entity({ fields: { id: { type: 'string' }, n: { type: 'string' } } }) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', n: 5 }] }), errors as never);
    expect(has(errors, 'panorama_field_type_changed')).toBe(true);
  });

  it('类型未变 → 不报错', () => {
    const oldS = schema({ x: entity({ fields: { id: { type: 'string' }, n: { type: 'number' } } }) });
    const newS = schema({ x: entity({ fields: { id: { type: 'string' }, n: { type: 'number' } } }) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', n: 5 }] }), errors as never);
    expect(errors).toHaveLength(0);
  });
});

describe('checkEnumNarrowing — 4.3 收窄 enum', () => {
  it('移除 enum 值且存量受影响 → panorama_enum_narrowed', () => {
    const oldS = schema({ x: entity({ fields: { id: { type: 'string' }, st: { type: 'enum', values: ['a', 'b', 'c'] } } }) });
    const newS = schema({ x: entity({ fields: { id: { type: 'string' }, st: { type: 'enum', values: ['a', 'b'] } } }) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', st: 'c' }] }), errors as never);
    expect(has(errors, 'panorama_enum_narrowed')).toBe(true);
  });

  it('移除 enum 值但无存量使用该值 → 不报错', () => {
    const oldS = schema({ x: entity({ fields: { id: { type: 'string' }, st: { type: 'enum', values: ['a', 'b', 'c'] } } }) });
    const newS = schema({ x: entity({ fields: { id: { type: 'string' }, st: { type: 'enum', values: ['a', 'b'] } } }) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', st: 'a' }] }), errors as never);
    expect(errors).toHaveLength(0);
  });
});

describe('checkStateFieldChanged — 4.5 改 states.field', () => {
  it('states.field 变更且旧状态值不在新 enum → panorama_state_field_changed', () => {
    const oldS = schema({
      x: entity({
        fields: { id: { type: 'string' }, status: { type: 'enum', values: ['a', 'b', 'c'] } },
        states: { field: 'status', initial: 'a', transitions: {} },
      }),
    });
    const newS = schema({
      x: entity({
        fields: { id: { type: 'string' }, status2: { type: 'enum', values: ['a', 'b'] } },
        states: { field: 'status2', initial: 'a', transitions: {} },
      }),
    });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', status: 'c' }] }), errors as never);
    expect(has(errors, 'panorama_state_field_changed')).toBe(true);
  });

  it('states.field 未变 → 不报错', () => {
    const oldS = schema({
      x: entity({
        fields: { id: { type: 'string' }, status: { type: 'enum', values: ['a', 'b'] } },
        states: { field: 'status', initial: 'a', transitions: {} },
      }),
    });
    const newS = schema({
      x: entity({
        fields: { id: { type: 'string' }, status: { type: 'enum', values: ['a', 'b'] } },
        states: { field: 'status', initial: 'a', transitions: {} },
      }),
    });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', status: 'a' }] }), errors as never);
    expect(errors).toHaveLength(0);
  });
});

describe('checkTerminalExpanded — 4.6 扩大 terminal', () => {
  it('新增 terminal 且存量实例处于该状态 → panorama_terminal_expanded', () => {
    const oldS = schema({
      x: entity({
        fields: { id: { type: 'string' }, st: { type: 'enum', values: ['a', 'b', 'c'] } },
        states: { field: 'st', initial: 'a', transitions: {}, terminal: ['c'] },
      }),
    });
    const newS = schema({
      x: entity({
        fields: { id: { type: 'string' }, st: { type: 'enum', values: ['a', 'b', 'c'] } },
        states: { field: 'st', initial: 'a', transitions: {}, terminal: ['b', 'c'] },
      }),
    });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', st: 'b' }] }), errors as never);
    expect(has(errors, 'panorama_terminal_expanded')).toBe(true);
  });

  it('新增 terminal 但无存量实例处于该状态 → 不报错', () => {
    const oldS = schema({
      x: entity({
        fields: { id: { type: 'string' }, st: { type: 'enum', values: ['a', 'b', 'c'] } },
        states: { field: 'st', initial: 'a', transitions: {}, terminal: ['c'] },
      }),
    });
    const newS = schema({
      x: entity({
        fields: { id: { type: 'string' }, st: { type: 'enum', values: ['a', 'b', 'c'] } },
        states: { field: 'st', initial: 'a', transitions: {}, terminal: ['b', 'c'] },
      }),
    });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', st: 'a' }] }), errors as never);
    expect(errors).toHaveLength(0);
  });
});

describe('checkConstraintTightened — 4.7 收紧约束', () => {
  it('number min 抬高且存量越界 → panorama_constraint_tightened', () => {
    const oldS = schema({ x: entity({ fields: { id: { type: 'string' }, n: { type: 'number', min: 0 } } }) });
    const newS = schema({ x: entity({ fields: { id: { type: 'string' }, n: { type: 'number', min: 10 } } }) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', n: 5 }] }), errors as never);
    expect(has(errors, 'panorama_constraint_tightened')).toBe(true);
  });

  it('number max 降低且存量越界 → panorama_constraint_tightened', () => {
    const oldS = schema({ x: entity({ fields: { id: { type: 'string' }, n: { type: 'number', max: 100 } } }) });
    const newS = schema({ x: entity({ fields: { id: { type: 'string' }, n: { type: 'number', max: 50 } } }) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', n: 80 }] }), errors as never);
    expect(has(errors, 'panorama_constraint_tightened')).toBe(true);
  });

  it('string max 缩短且存量超长 → panorama_constraint_tightened', () => {
    const oldS = schema({ x: entity({ fields: { id: { type: 'string' }, s: { type: 'string', max: 100 } } }) });
    const newS = schema({ x: entity({ fields: { id: { type: 'string' }, s: { type: 'string', max: 5 } } }) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', s: 'hello world' }] }), errors as never);
    expect(has(errors, 'panorama_constraint_tightened')).toBe(true);
  });

  it('收紧约束但存量未越界 → 不报错', () => {
    const oldS = schema({ x: entity({ fields: { id: { type: 'string' }, n: { type: 'number', min: 0 } } }) });
    const newS = schema({ x: entity({ fields: { id: { type: 'string' }, n: { type: 'number', min: 10 } } }) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', n: 20 }] }), errors as never);
    expect(errors).toHaveLength(0);
  });
});

describe('validateDataSafety — 4.1 删实体 + 综合', () => {
  it('删除有存量数据的实体 → panorama_dropping_entity_data', () => {
    const oldS = schema({ x: entity({}), y: entity({}) });
    const newS = schema({ x: entity({}) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ y: [{ id: '1' }] }), errors as never);
    expect(has(errors, 'panorama_dropping_entity_data')).toBe(true);
  });

  it('删除无数据的实体 → 不报错', () => {
    const oldS = schema({ x: entity({}), y: entity({}) });
    const newS = schema({ x: entity({}) });
    const errors: { code: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ y: [] }), errors as never);
    expect(errors).toHaveLength(0);
  });

  it('新旧 schema 完全一致 → 不报错', () => {
    const s = schema({ x: entity({ fields: { id: { type: 'string' }, n: { type: 'number', min: 0, max: 10 } } }) });
    const errors: { code: string }[] = [];
    validateDataSafety(s, s, storeOf({ x: [{ id: '1', n: 5 }] }), errors as never);
    expect(errors).toHaveLength(0);
  });

  it('suggestion 字段存在（喂回 agent 修复）', () => {
    const oldS = schema({ x: entity({ fields: { id: { type: 'string' }, note: { type: 'string' } } }) });
    const newS = schema({ x: entity({ fields: { id: { type: 'string' } } }) });
    const errors: { code: string; suggestion?: string }[] = [];
    validateDataSafety(oldS, newS, storeOf({ x: [{ id: '1', note: 'x' }] }), errors as never);
    expect(errors[0]!.suggestion).toBeTruthy();
  });
});
