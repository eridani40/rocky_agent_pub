/**
 * SqliteCrudStore 集成测试 — CRUD / mode / ifVersion（真实 SqlDriver）
 * 参考: specs/tech/persistence/[P0]sqlite_crud_store_engine.md §2-§5
 *       specs/tech/persistence/[P0]sqlite_engine_packaged_promotion.md（SqlDriver 注入版）
 *       states/v0.0.2/verify/test-plan.md §3 SqliteCrudStore 维度（P1/P4/P5）
 *
 * 覆盖（acceptance criteria）：
 *   P1 blob-first：put 后表存在（表名=schema.entity）、data 列含实体 JSON（不含信封）、
 *                  信封四列正确；get 读回 data+信封合并一致
 *   P4 ifVersion：匹配→+1、不匹配→VersionConflictError{expected,actual}
 *   P5 mode：insert 已存在→RecordExistsError、replace 不存在→RecordNotFoundError、upsert 皆可
 *   query：ids/createdAfter/Before/order/limit 全走信封列；id 全局索引 get 无需 shardKey
 *
 * 事务 / WAL / json_extract 扩展查询见 sqlite-store-engine.test.ts（拆分自原单文件，≤300 行）。
 * 用 :memory: 内存库；vitest 跑在 bun 下，BunSqlDriver 可用（createCrudSqlDriver 工厂自动选）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCrudSqlDriver } from '../crud-sqlite-driver-factory';
import { SqliteCrudStore } from '../sqlite-store';
import type { SchemaDef } from '../schema-types';
import {
  RecordExistsError,
  RecordNotFoundError,
  VersionConflictError,
} from '../errors';

// ============================================================
// 实验 fixture：不分片 sqlite entity（model_config 风格）
// ============================================================

const ModelConfigSchema = {
  entity: 'model_config',
  engine: 'sqlite',
  fields: {
    id: { type: 'ulid', required: true },
    key: { type: 'string', required: true },
    value: { type: 'json', required: true },
  },
} as const satisfies SchemaDef;

// 合法 ULID（26 字符 Crockford base32）
const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_B = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const ULID_C = '01ARZ3NDEKTSV4RRFFQ69G5FAX';

// ============================================================
// 公用：每个 it 独立 store（:memory:），避免状态串扰
// SqliteCrudStore 不再内部 new Database，走 createCrudSqlDriver 工厂
// （工厂内 createSqlDriver + applyWal + new SqliteCrudStore）。
// ============================================================
async function newStore(): Promise<SqliteCrudStore> {
  const { store } = await createCrudSqlDriver(':memory:');
  return store;
}

describe('SqliteCrudStore — blob-first 表结构（P1）', () => {
  it('put 后惰性建表（表名=schema.entity）+ 信封四列 + data blob 不含信封', async () => {
    const store = await newStore();
    const rec = { id: ULID_A, key: 'model', value: { name: 'gpt' } };
    const stored = store.put(ModelConfigSchema, rec);

    // 返回值含信封
    expect(stored.createdAt).toBeTruthy();
    expect(stored.updatedAt).toBe(stored.createdAt);
    expect(stored.version).toBe(1);

    // 直接查原始行，断言表结构与 blob 内容（白盒）
    const row = store.readRawRow('model_config', ULID_A) as {
      id: string;
      data: string;
      created_at: string;
      updated_at: string;
      version: number;
    };
    expect(row.id).toBe(ULID_A);
    expect(row.version).toBe(1);
    // data blob 不含信封字段
    const blob = JSON.parse(row.data) as Record<string, unknown>;
    expect(blob.id).toBe(ULID_A);
    expect(blob.key).toBe('model');
    expect(blob.value).toEqual({ name: 'gpt' });
    expect(blob.createdAt).toBeUndefined();
    expect(blob.updatedAt).toBeUndefined();
    expect(blob.version).toBeUndefined();
    // 信封列与返回值一致
    expect(row.created_at).toBe(stored.createdAt);
    expect(row.updated_at).toBe(stored.updatedAt);
  });

  it('get 读回 data + 信封合并一致；不存在返回 undefined（无需 shardKey）', async () => {
    const store = await newStore();
    const rec = { id: ULID_A, key: 'k', value: { n: 1 } };
    const stored = store.put(ModelConfigSchema, rec);

    const got = store.get(ModelConfigSchema, ULID_A);
    expect(got).toBeDefined();
    expect(got?.id).toBe(ULID_A);
    expect(got?.key).toBe('k');
    expect(got?.value).toEqual({ n: 1 });
    expect(got?.createdAt).toBe(stored.createdAt);
    expect(got?.version).toBe(stored.version);

    // id 全局索引，get 不需要 shardKey（调用方未传第二参）
    expect(store.get(ModelConfigSchema, ULID_B)).toBeUndefined();
  });

  it('二次 upsert 同 id：createdAt 保留、updatedAt 推进、version 自增', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T03:00:00.000Z'));
    const store = await newStore();
    const r1 = store.put(ModelConfigSchema, { id: ULID_A, key: 'k', value: { n: 1 } });
    // 推进时间，确保 updatedAt 与 createdAt 不同（new Date().toISOString 受系统时间控制）
    vi.setSystemTime(new Date('2026-06-19T03:01:00.000Z'));
    const r2 = store.put(ModelConfigSchema, { id: ULID_A, key: 'k2', value: { n: 2 } });
    vi.useRealTimers();

    expect(r2.createdAt).toBe(r1.createdAt); // createdAt 不可变
    expect(r2.updatedAt).not.toBe(r1.updatedAt); // updatedAt 推进
    expect(r2.version).toBe(r1.version + 1);
    expect(r2.key).toBe('k2');
  });
});

describe('SqliteCrudStore — delete / query', () => {
  let store: SqliteCrudStore;
  beforeEach(async () => {
    store = await newStore();
    store.put(ModelConfigSchema, { id: ULID_A, key: 'a', value: { n: 1 } });
    store.put(ModelConfigSchema, { id: ULID_B, key: 'b', value: { n: 2 } });
    store.put(ModelConfigSchema, { id: ULID_C, key: 'c', value: { n: 3 } });
  });

  it('delete 实际删除返回 true；再删返回 false', () => {
    expect(store.delete(ModelConfigSchema, ULID_A)).toBe(true);
    expect(store.get(ModelConfigSchema, ULID_A)).toBeUndefined();
    expect(store.delete(ModelConfigSchema, ULID_A)).toBe(false);
  });

  it('query 按 order 排序 + limit 截断', () => {
    const desc = store.query(ModelConfigSchema, { order: 'createdAtDesc', limit: 2 });
    expect(desc.map((r) => r.id)).toEqual([ULID_C, ULID_B]);
    const asc = store.query(ModelConfigSchema, { order: 'createdAtAsc' });
    expect(asc.map((r) => r.id)).toEqual([ULID_A, ULID_B, ULID_C]);
  });

  it('query 按 ids 过滤', () => {
    const r = store.query(ModelConfigSchema, { ids: [ULID_A, ULID_C] });
    expect(r.map((x) => x.id).sort()).toEqual([ULID_A, ULID_C]);
  });

  it('query 按 createdAfter/createdBefore 范围过滤（isoDate 字典序与时间序一致）', () => {
    const all = store.query(ModelConfigSchema, { order: 'createdAtAsc' });
    const after = store.query(ModelConfigSchema, {
      createdAfter: all[0]!.createdAt,
      order: 'createdAtAsc',
    });
    // createdAfter 是「下界含」，故 all[0] 应包含
    expect(after.map((r) => r.id)).toContain(all[0]!.id);
    const before = store.query(ModelConfigSchema, {
      createdBefore: all[1]!.createdAt,
      order: 'createdAtAsc',
    });
    // createdBefore 是「上界不含」，故 all[1] 不应出现
    expect(before.map((r) => r.id)).not.toContain(all[1]!.id);
  });
});

describe('SqliteCrudStore — PutOptions.mode（P5）', () => {
  it('insert 已存在 → RecordExistsError', async () => {
    const store = await newStore();
    store.put(ModelConfigSchema, { id: ULID_A, key: 'k', value: {} });
    expect(() =>
      store.put(ModelConfigSchema, { id: ULID_A, key: 'k', value: {} }, { mode: 'insert' }),
    ).toThrowError(RecordExistsError);
  });

  it('insert 不存在 → 正常写入 version=1', async () => {
    const store = await newStore();
    const r = store.put(
      ModelConfigSchema,
      { id: ULID_A, key: 'k', value: {} },
      { mode: 'insert' },
    );
    expect(r.version).toBe(1);
  });

  it('replace 不存在 → RecordNotFoundError', async () => {
    const store = await newStore();
    expect(() =>
      store.put(ModelConfigSchema, { id: ULID_A, key: 'k', value: {} }, { mode: 'replace' }),
    ).toThrowError(RecordNotFoundError);
  });

  it('replace 存在 → 重置时间 + version 自增', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-19T03:00:00.000Z'));
    const store = await newStore();
    const r1 = store.put(ModelConfigSchema, { id: ULID_A, key: 'k', value: {} });
    vi.setSystemTime(new Date('2026-06-19T03:01:00.000Z'));
    const r2 = store.put(
      ModelConfigSchema,
      { id: ULID_A, key: 'k2', value: {} },
      { mode: 'replace' },
    );
    vi.useRealTimers();
    expect(r2.version).toBe(r1.version + 1);
    expect(r2.createdAt).not.toBe(r1.createdAt); // replace 重置 createdAt
    expect(r2.key).toBe('k2');
  });

  it('upsert（缺省）首次与更新皆可', async () => {
    const store = await newStore();
    const r1 = store.put(ModelConfigSchema, { id: ULID_A, key: 'k', value: {} });
    expect(r1.version).toBe(1);
    const r2 = store.put(ModelConfigSchema, { id: ULID_A, key: 'k2', value: {} });
    expect(r2.version).toBe(2);
  });
});

describe('SqliteCrudStore — PutOptions.ifVersion 乐观锁（P4）', () => {
  it('ifVersion 匹配 → version+1 写入成功', async () => {
    const store = await newStore();
    const r1 = store.put(ModelConfigSchema, { id: ULID_A, key: 'k', value: {} });
    const r2 = store.put(
      ModelConfigSchema,
      { id: ULID_A, key: 'k2', value: {} },
      { ifVersion: r1.version },
    );
    expect(r2.version).toBe(r1.version + 1);
  });

  it('ifVersion 不匹配 → VersionConflictError{expected,actual}', async () => {
    const store = await newStore();
    store.put(ModelConfigSchema, { id: ULID_A, key: 'k', value: {} });
    let err: unknown;
    try {
      store.put(
        ModelConfigSchema,
        { id: ULID_A, key: 'k2', value: {} },
        { ifVersion: 99 },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(VersionConflictError);
    const vce = err as VersionConflictError;
    expect(vce.expected).toBe(99);
    expect(vce.actual).toBe(1);
    expect(vce.id).toBe(ULID_A);
  });
});
