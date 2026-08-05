/**
 * SchemaDef 校验 + 错误类型单测
 * 参考: specs/tech/persistence/[P0]schema_interface.md §2-§3
 *       states/v0.0.2/verify/test-plan.md §3 SchemaDef 维度
 *
 * 覆盖：
 *   - 错误类型 SchemaValidationError{field} / PrimaryKeyMissingError
 *   - validateSchemaDef（schema 自身静态校验）
 *   - validateRecord（运行时写入校验）
 *
 * InferRecord 类型派生测试见 schema-infer.test.ts。
 */
import { describe, it, expect } from 'vitest';
import {
  SchemaValidationError,
  PrimaryKeyMissingError,
  validateSchemaDef,
  validateRecord,
  type SchemaDef,
} from '../index';

// ============================================================
// 工具：构造一份合法 schema（用最简形式，避免每个 case 重复）
// ============================================================
const ULID_OK = '01ARZ3NDEKTSV4RRFFQ69G5FAV'; // 26 字符合法 ULID（Crockford base32）

function baseSchema(): SchemaDef {
  return {
    entity: 'demo',
    engine: 'sqlite',
    fields: {
      id: { type: 'ulid', required: true },
      name: { type: 'string', required: true },
      kind: { type: 'enum', required: true, enumValues: ['a', 'b', 'c'] },
      note: { type: 'string' }, // 可选
      meta: { type: 'json' }, // 可选 json
    },
  };
}

/** 跑 fn，断言抛 SchemaValidationError 且 field === expectField（消除重复 try/catch） */
function expectSchemaError(
  fn: () => void,
  expectField: string,
): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(SchemaValidationError);
  expect((caught as SchemaValidationError).field).toBe(expectField);
}

// ============================================================
// 1. 错误类型构造
// ============================================================
describe('错误类型', () => {
  it('SchemaValidationError 携带 field 字段', () => {
    const err = new SchemaValidationError('name', '不合规');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SchemaValidationError);
    expect(err.field).toBe('name');
    expect(err.message).toContain('name');
  });

  it('PrimaryKeyMissingError 是独立类', () => {
    const err = new PrimaryKeyMissingError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(PrimaryKeyMissingError);
    expect(err).not.toBeInstanceOf(SchemaValidationError);
  });
});

// ============================================================
// 2. SchemaDef 自身静态校验（validateSchemaDef）
// ============================================================
describe('validateSchemaDef — schema 自身合法性', () => {
  it('合法 schema 不抛错', () => {
    expect(() => validateSchemaDef(baseSchema())).not.toThrow();
  });

  it('缺少 id 字段 → SchemaValidationError', () => {
    const s = baseSchema();
    delete (s.fields as Record<string, unknown>).id;
    expect(() => validateSchemaDef(s)).toThrow(SchemaValidationError);
  });

  it('id 非 ulid 类型 → SchemaValidationError', () => {
    const s: SchemaDef = {
      entity: 'demo',
      engine: 'sqlite',
      fields: { id: { type: 'string', required: true } },
    };
    expect(() => validateSchemaDef(s)).toThrow(SchemaValidationError);
  });

  it('id ulid 但 required 未声明 → SchemaValidationError', () => {
    const s: SchemaDef = {
      entity: 'demo',
      engine: 'sqlite',
      fields: { id: { type: 'ulid' } },
    };
    expect(() => validateSchemaDef(s)).toThrow(SchemaValidationError);
  });

  it('实体声明 createdAt 信封字段 → SchemaValidationError', () => {
    const s = baseSchema();
    (s.fields as Record<string, unknown>).createdAt = { type: 'isoDate' };
    expect(() => validateSchemaDef(s)).toThrow(SchemaValidationError);
  });

  it('实体声明 updatedAt / version 信封字段 → SchemaValidationError', () => {
    for (const reserved of ['updatedAt', 'version']) {
      const s = baseSchema();
      (s.fields as Record<string, unknown>)[reserved] = { type: 'isoDate' };
      expect(() => validateSchemaDef(s)).toThrow(SchemaValidationError);
    }
  });

  it('enum 字段缺 enumValues → SchemaValidationError', () => {
    const s: SchemaDef = {
      entity: 'demo',
      engine: 'sqlite',
      fields: {
        id: { type: 'ulid', required: true },
        kind: { type: 'enum', required: true }, // 缺 enumValues
      },
    };
    expect(() => validateSchemaDef(s)).toThrow(SchemaValidationError);
  });
});

// ============================================================
// 3. 运行时写入校验（validateRecord）
// ============================================================
describe('validateRecord — 运行时校验', () => {
  it('合法 record 通过', () => {
    const rec = { id: ULID_OK, name: 'x', kind: 'a' };
    expect(() => validateRecord(baseSchema(), rec)).not.toThrow();
  });

  // P6: 缺 id → PrimaryKeyMissingError
  it('缺 id 字段 → PrimaryKeyMissingError', () => {
    const rec = { name: 'x', kind: 'a' };
    expect(() => validateRecord(baseSchema(), rec)).toThrow(PrimaryKeyMissingError);
  });

  // P6: id 是 undefined → PrimaryKeyMissingError（主键缺失语义）
  it('id 字段为 undefined → PrimaryKeyMissingError', () => {
    const rec = { id: undefined, name: 'x', kind: 'a' };
    expect(() => validateRecord(baseSchema(), rec)).toThrow(PrimaryKeyMissingError);
  });

  // P6: id ULID 格式非法 → SchemaValidationError
  it('id 非合法 ULID → SchemaValidationError{field:"id"}', () => {
    const rec = { id: 'not-a-ulid', name: 'x', kind: 'a' };
    expectSchemaError(() => validateRecord(baseSchema(), rec), 'id');
  });

  // 必填缺失 → SchemaValidationError
  it('必填字段缺失 → SchemaValidationError{field}', () => {
    const rec = { id: ULID_OK, kind: 'a' }; // 缺 name
    expectSchemaError(() => validateRecord(baseSchema(), rec), 'name');
  });

  // 类型不匹配 → SchemaValidationError
  it('字段类型不匹配（number 传 string） → SchemaValidationError', () => {
    const s: SchemaDef = {
      entity: 'demo',
      engine: 'sqlite',
      fields: {
        id: { type: 'ulid', required: true },
        count: { type: 'number', required: true },
      },
    };
    const rec = { id: ULID_OK, count: '5' as unknown as number };
    expectSchemaError(() => validateRecord(s, rec), 'count');
  });

  // 类型：boolean
  it('boolean 类型校验', () => {
    const s: SchemaDef = {
      entity: 'demo',
      engine: 'sqlite',
      fields: {
        id: { type: 'ulid', required: true },
        active: { type: 'boolean', required: true },
      },
    };
    expect(() => validateRecord(s, { id: ULID_OK, active: 'true' as unknown as boolean }))
      .toThrow(SchemaValidationError);
    expect(() => validateRecord(s, { id: ULID_OK, active: true })).not.toThrow();
  });

  // isoDate 格式校验
  it('isoDate 非法格式 → SchemaValidationError', () => {
    const s: SchemaDef = {
      entity: 'demo',
      engine: 'sqlite',
      fields: {
        id: { type: 'ulid', required: true },
        ts: { type: 'isoDate', required: true },
      },
    };
    expect(() => validateRecord(s, { id: ULID_OK, ts: '2026/06/19' })).toThrow(SchemaValidationError);
    expect(() => validateRecord(s, { id: ULID_OK, ts: '2026-06-19T10:00:00.000Z' })).not.toThrow();
  });

  // enum 越界 → SchemaValidationError
  it('enum 越界 → SchemaValidationError{field}', () => {
    const rec = { id: ULID_OK, name: 'x', kind: 'z' };
    expectSchemaError(() => validateRecord(baseSchema(), rec), 'kind');
  });

  // 实体自带信封保留字段 → SchemaValidationError
  it('record 自带 createdAt → SchemaValidationError', () => {
    const rec = { id: ULID_OK, name: 'x', kind: 'a', createdAt: '2026-01-01T00:00:00.000Z' };
    expectSchemaError(() => validateRecord(baseSchema(), rec), 'createdAt');
  });

  it('record 自带 updatedAt / version → SchemaValidationError', () => {
    for (const reserved of ['updatedAt', 'version']) {
      const rec: Record<string, unknown> = { id: ULID_OK, name: 'x', kind: 'a' };
      rec[reserved] = reserved === 'version' ? 1 : '2026-01-01T00:00:00.000Z';
      expectSchemaError(() => validateRecord(baseSchema(), rec), reserved);
    }
  });

  // 可选 json 字段允许任意值（unknown）
  it('json 字段允许任意 JSON 值', () => {
    const rec = {
      id: ULID_OK,
      name: 'x',
      kind: 'a',
      meta: { nested: { arr: [1, 'two', true] } },
    };
    expect(() => validateRecord(baseSchema(), rec)).not.toThrow();
  });

  // 可选字段为 undefined 时不报错
  it('可选字段为 undefined 不报错', () => {
    const rec = { id: ULID_OK, name: 'x', kind: 'a', note: undefined };
    expect(() => validateRecord(baseSchema(), rec)).not.toThrow();
  });
});
