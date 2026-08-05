/**
 * validate_instance UT — create/update 写入校验（类型/enum/ref/required/约束）+ coerceRecord 无损类型转换.
 * 参考: specs/tech/squad/[P1]panorama_validation.md §6
 */
import { describe, it, expect } from 'vitest';
import { validateInstance, coerceRecord } from '../validate_instance';
import type { EntityDef } from '../../dsl/types';
import type { StoreLike } from '../types';

const entity: EntityDef = {
  label: 'Task',
  id_field: 'id',
  fields: {
    id:     { type: 'string', required: true },
    title:  { type: 'string', required: true, max: 100 },
    commit: { type: 'string', pattern: '^[0-9a-f]{7}$' },
    status: { type: 'enum', values: ['todo', 'doing', 'done'] },
    score:  { type: 'number', min: 0, max: 100 },
    active: { type: 'boolean' },
    parent: { type: 'ref', entity: 'task' },
    due:    { type: 'datetime' },
  },
  states: { field: 'status', initial: 'todo', transitions: {} },
};

const store: StoreLike = {
  hasId: (_e, id) => id === 'dup-id',
  getInstance: (e, id) => (e === 'task' && id === 'task-1' ? { id: 'task-1' } : null),
};

function validate(record: Record<string, unknown>, mode: 'create' | 'update' = 'create') {
  return validateInstance('task', entity, record, { mode, store });
}

const code = (r: { errors: { code: string }[] }, c: string) =>
  r.errors.some(e => e.code === c);

describe('validateInstance — 合法实例', () => {
  it('全部字段合法 → ok', () => {
    const r = validate({
      id: 't1', title: 'Hello', status: 'todo', score: 50, active: true,
    });
    expect(r.ok).toBe(true);
  });

  it('optional 字段为空 → ok', () => {
    const r = validate({ id: 't1', title: 'Hi' });
    expect(r.ok).toBe(true);
  });
});

describe('validateInstance — required', () => {
  it('required 字段缺失 → panorama_missing_required', () => {
    const r = validate({ id: 't1' });
    expect(code(r, 'panorama_missing_required')).toBe(true);
  });

  it('required 字段空串 → panorama_missing_required', () => {
    const r = validate({ id: 't1', title: '' });
    expect(code(r, 'panorama_missing_required')).toBe(true);
  });
});

describe('validateInstance — 类型校验', () => {
  it('string 传 number → panorama_type_mismatch', () => {
    const r = validate({ id: 123, title: 'Hi' });
    expect(code(r, 'panorama_type_mismatch')).toBe(true);
  });

  it('number 传 string → panorama_type_mismatch', () => {
    const r = validate({ id: 't1', title: 'Hi', score: 'abc' });
    expect(code(r, 'panorama_type_mismatch')).toBe(true);
  });

  it('boolean 传 string → panorama_type_mismatch', () => {
    const r = validate({ id: 't1', title: 'Hi', active: 'yes' });
    expect(code(r, 'panorama_type_mismatch')).toBe(true);
  });
});

describe('validateInstance — 约束校验', () => {
  it('string 超 max → panorama_value_too_long', () => {
    const r = validate({ id: 't1', title: 'x'.repeat(101) });
    expect(code(r, 'panorama_value_too_long')).toBe(true);
  });

  it('pattern 不匹配 → panorama_pattern_mismatch', () => {
    const r = validate({ id: 't1', title: 'Hi', commit: 'xyz1234' });
    expect(code(r, 'panorama_pattern_mismatch')).toBe(true);
  });

  it('pattern 匹配 → ok', () => {
    const r = validate({ id: 't1', title: 'Hi', commit: 'abc1234' });
    expect(code(r, 'panorama_pattern_mismatch')).toBe(false);
  });

  it('number < min → panorama_value_out_of_range', () => {
    const r = validate({ id: 't1', title: 'Hi', score: -1 });
    expect(code(r, 'panorama_value_out_of_range')).toBe(true);
  });

  it('number > max → panorama_value_out_of_range', () => {
    const r = validate({ id: 't1', title: 'Hi', score: 200 });
    expect(code(r, 'panorama_value_out_of_range')).toBe(true);
  });
});

describe('validateInstance — enum', () => {
  it('enum 值不合法 → panorama_invalid_enum_value', () => {
    const r = validate({ id: 't1', title: 'Hi', status: 'ghost' });
    expect(code(r, 'panorama_invalid_enum_value')).toBe(true);
  });

  it('enum 值合法 → ok', () => {
    const r = validate({ id: 't1', title: 'Hi', status: 'doing' });
    expect(r.ok).toBe(true);
  });
});

describe('validateInstance — ref', () => {
  it('ref 目标不存在 → panorama_dangling_ref', () => {
    const r = validate({ id: 't1', title: 'Hi', parent: 'ghost-id' });
    expect(code(r, 'panorama_dangling_ref')).toBe(true);
  });

  it('ref 目标存在 → ok', () => {
    const r = validate({ id: 't1', title: 'Hi', parent: 'task-1' });
    expect(r.ok).toBe(true);
  });
});

describe('validateInstance — datetime', () => {
  it('非法日期 → panorama_invalid_datetime', () => {
    const r = validate({ id: 't1', title: 'Hi', due: 'not-a-date' });
    expect(code(r, 'panorama_invalid_datetime')).toBe(true);
  });

  it('合法 ISO → ok', () => {
    const r = validate({ id: 't1', title: 'Hi', due: '2026-07-22T10:00:00Z' });
    expect(r.ok).toBe(true);
  });
});

describe('validateInstance — create 专属', () => {
  // v0.0.259 §B：duplicate check 已从 validateInstance 移除，由调用方（runCreate / handleCreateEntity）
  // 在 coerce+validate 之前用 store.hasId 短路。两模式均不再产生 panorama_duplicate_id.
  it('create id 已存在 → 不再报 panorama_duplicate_id（短路归调用方）', () => {
    const r = validate({ id: 'dup-id', title: 'Hi' });
    expect(code(r, 'panorama_duplicate_id')).toBe(false);
  });

  it('status 非法值 → panorama_invalid_initial_value', () => {
    const r = validate({ id: 't1', title: 'Hi', status: 'ghost' });
    expect(code(r, 'panorama_invalid_initial_value')).toBe(true);
  });

  it('status 未提供 → 用 initial 默认（不报错）', () => {
    const r = validate({ id: 't1', title: 'Hi' });
    expect(r.ok).toBe(true);
  });
});

describe('validateInstance — update 模式', () => {
  it('update 不做 duplicate check（与 create 一致）', () => {
    const r = validate({ id: 'dup-id', title: 'Hi' }, 'update');
    expect(code(r, 'panorama_duplicate_id')).toBe(false);
  });

  it('update 仍校验字段类型', () => {
    const r = validate({ title: 123 }, 'update');
    expect(code(r, 'panorama_type_mismatch')).toBe(true);
  });
});

// ── v0.0.259 §C：coerceRecord 无损类型转换 ───────────────────────────────

describe('coerceRecord — 无损类型转换', () => {
  it('number 字段 + string 值（无损）→ 转 number', () => {
    const r = coerceRecord(entity, { id: 't1', score: '1928' });
    expect(r.score).toBe(1928);
    expect(typeof r.score).toBe('number');
  });

  it('string 字段 + number 值（有限）→ 转 string', () => {
    const r = coerceRecord(entity, { id: 1928, title: 'Hi' });
    expect(r.id).toBe('1928');
    expect(typeof r.id).toBe('string');
  });

  it('boolean 字段 + "true"/"false" → 转 boolean', () => {
    const r = coerceRecord(entity, { id: 't1', active: 'true' });
    expect(r.active).toBe(true);
    const r2 = coerceRecord(entity, { id: 't1', active: 'false' });
    expect(r2.active).toBe(false);
  });

  it('number 字段 + 有损 string 值 → 保留原值（交下游 check 报错）', () => {
    // "0x10" → Number=16 但 String(16)!="0x10" → 不 coerce
    expect(coerceRecord(entity, { id: 't1', score: '0x10' }).score).toBe('0x10');
    // "1.0" → Number=1 但 String(1)!="1.0" → 不 coerce
    expect(coerceRecord(entity, { id: 't1', score: '1.0' }).score).toBe('1.0');
    // "" / "  " → 空 / 纯空白不 coerce
    expect(coerceRecord(entity, { id: 't1', score: '' }).score).toBe('');
    expect(coerceRecord(entity, { id: 't1', score: '  ' }).score).toBe('  ');
    // "1e3" → Number=1000 但 String(1000)!="1e3" → 不 coerce（防科学计数歧义）
    expect(coerceRecord(entity, { id: 't1', score: '1e3' }).score).toBe('1e3');
    // "12a" → Number=NaN → 不 coerce
    expect(coerceRecord(entity, { id: 't1', score: '12a' }).score).toBe('12a');
  });

  it('boolean 字段 + 非 "true"/"false"（如 1/0/"True"）→ 保留原值', () => {
    expect(coerceRecord(entity, { id: 't1', active: 1 }).active).toBe(1);
    expect(coerceRecord(entity, { id: 't1', active: 'True' }).active).toBe('True');
  });

  it('enum/ref/datetime 字段 → 不 coerce（语义串/严格 id/ISO 解析交 check）', () => {
    const r = coerceRecord(entity, { id: 't1', status: 'todo', parent: 'task-1', due: '2026-07-22T10:00:00Z' });
    expect(r.status).toBe('todo');
    expect(r.parent).toBe('task-1');
    expect(r.due).toBe('2026-07-22T10:00:00Z');
  });

  it('入参 record 不被 mutate（返回新对象）', () => {
    const input = { id: 't1', score: '1928', active: 'true' };
    const snapshot = { ...input };
    const r = coerceRecord(entity, input);
    expect(r).not.toBe(input); // 新对象
    expect(input).toEqual(snapshot); // 入参未变
    expect(input.score).toBe('1928'); // 原 string 未被改
  });

  it('声明外的字段（无 fieldDef）→ 原值保留（不丢字段）', () => {
    const r = coerceRecord(entity, { id: 't1', custom: 'value' } as Record<string, unknown>);
    expect(r.custom).toBe('value');
  });
});

// ── v0.0.259 §C：错误信息含声明约束原文 + readSchema 引导 ────────────────

describe('checkString/checkNumber/checkEnumValue — 错误信息含声明约束原文', () => {
  it('checkString type mismatch → message 含声明约束原文（max/pattern）+ suggestion 含 readSchema/GET schema', () => {
    // title 字段：声明 type=string, max=100 → type_mismatch message 含这两项
    const r = validate({ id: 't1', title: 123 });
    const err = r.errors.find(x => x.code === 'panorama_type_mismatch')!;
    expect(err).toBeDefined();
    expect(err.message).toContain('type=string');
    expect(err.message).toContain('max=100');
    expect(err.suggestion).toContain('readSchema');
    expect(err.suggestion).toContain('GET schema');
    expect(err.suggestion).toContain('entities.task.title');
    // commit 字段：声明 pattern → type_mismatch message 含 pattern 原文
    const r2 = validate({ id: 't1', title: 'Hi', commit: 123 });
    const err2 = r2.errors.find(x => x.code === 'panorama_type_mismatch')!;
    expect(err2.message).toContain('pattern=^[0-9a-f]{7}$');
  });

  it('checkString too long → message 含声明 max=N', () => {
    const r = validate({ id: 't1', title: 'x'.repeat(101) });
    const err = r.errors.find(x => x.code === 'panorama_value_too_long')!;
    expect(err.message).toContain('max=100');
  });

  it('checkString pattern mismatch → message 含声明 pattern=regex', () => {
    const r = validate({ id: 't1', title: 'Hi', commit: 'xyz1234' });
    const err = r.errors.find(x => x.code === 'panorama_pattern_mismatch')!;
    expect(err.message).toContain('pattern=');
  });

  it('checkNumber type mismatch → message 含 min/max 声明 + suggestion 引导', () => {
    const r = validate({ id: 't1', title: 'Hi', score: 'abc' });
    const err = r.errors.find(x => x.code === 'panorama_type_mismatch')!;
    expect(err.message).toContain('type=number');
    expect(err.message).toContain('min=0');
    expect(err.message).toContain('max=100');
    expect(err.suggestion).toContain('readSchema');
  });

  it('checkNumber out of range → message 含声明 min/max', () => {
    const r = validate({ id: 't1', title: 'Hi', score: -1 });
    const err = r.errors.find(x => x.code === 'panorama_value_out_of_range')!;
    expect(err.message).toContain('min=0');
  });

  it('checkEnumValue invalid → message 含 type=enum + 完整 values 列表 + suggestion 引导', () => {
    const r = validate({ id: 't1', title: 'Hi', status: 'ghost' });
    const err = r.errors.find(x => x.code === 'panorama_invalid_enum_value')!;
    expect(err.message).toContain('type=enum');
    expect(err.message).toContain('todo');
    expect(err.message).toContain('doing');
    expect(err.message).toContain('done');
    expect(err.suggestion).toContain('readSchema');
    expect(err.suggestion).toContain('entities.task.status');
  });
});
