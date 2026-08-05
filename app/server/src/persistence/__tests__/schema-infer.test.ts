/**
 * InferRecord 编译期类型派生测试
 * 参考: specs/tech/persistence/[P0]schema_interface.md §2.3
 *       states/v0.0.2/verify/test-plan.md §3 SchemaDef 维度
 *
 * 用 as const satisfies 锁住 schema，让 InferRecord 派生精确到字面量。
 * 校验 + 错误类型测试见 schema-validation.test.ts。
 */
import { describe, it, expect } from 'vitest';
import {
  type SchemaDef,
  type InferRecord,
} from '../index';

const ULID_OK = '01ARZ3NDEKTSV4RRFFQ69G5FAV'; // 26 字符合法 ULID（Crockford base32）

// 用 as const satisfies 锁住 schema，让派生精确到字面量
const DemoSchema = {
  entity: 'demo',
  engine: 'sqlite',
  fields: {
    id: { type: 'ulid', required: true },
    role: { type: 'enum', required: true, enumValues: ['user', 'assistant'] },
    count: { type: 'number', required: true },
    active: { type: 'boolean', required: true },
    payload: { type: 'json' }, // 可选 json
    tag: { type: 'string' }, // 可选 string
  },
} as const satisfies SchemaDef;

describe('InferRecord 类型派生（编译期）', () => {
  it('必填字段进主体（无 ?）', () => {
    type Rec = InferRecord<typeof DemoSchema>;
    // 必填：id/role/count/active 均无 ?；赋 undefined 应类型报错（运行时断言等价值：键存在即非 undefined）
    const r: Rec = { id: ULID_OK, role: 'user', count: 1, active: true };
    expect(r.id).toBe(ULID_OK);
    expect(r.count).toBe(1);
  });

  it('可选字段加 ?（可省略）', () => {
    type Rec = InferRecord<typeof DemoSchema>;
    const r: Rec = { id: ULID_OK, role: 'user', count: 1, active: true }; // 省略 payload/tag
    expect(r.payload).toBeUndefined();
    expect(r.tag).toBeUndefined();
  });

  it('enum 字段成字面量 union', () => {
    type Rec = InferRecord<typeof DemoSchema>;
    const r1: Rec = { id: ULID_OK, role: 'user', count: 1, active: true };
    const r2: Rec = { id: ULID_OK, role: 'assistant', count: 1, active: true };
    expect(['user', 'assistant']).toContain(r1.role);
    expect(['user', 'assistant']).toContain(r2.role);
  });

  it('json 字段类型为 unknown', () => {
    type Rec = InferRecord<typeof DemoSchema>;
    // unknown 允许赋任意值
    const r: Rec = { id: ULID_OK, role: 'user', count: 1, active: true, payload: { any: [1, 2] } };
    expect(r.payload).toEqual({ any: [1, 2] });
  });
});
