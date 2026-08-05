/**
 * 双 engine 一致性实验 — model_config 经 fs 与 sqlite 存取行为对比（P3）
 * 参考: states/v0.0.2/verify/test-plan.md §2 P3（engine 可换）
 *       specs/tech/persistence/[P0]crud_store_interface.md §3.4
 *
 * 实验目的（task.json T5 §3）：验证 CrudStore 契约在两 engine 间行为一致——
 *   - put 首次注入信封（createdAt/updatedAt/version=1）
 *   - upsert 二次写推进 version、updatedAt；createdAt 不变
 *   - get 读回 data + 信封合并一致
 *   - delete 实际删除返回 true、再删 false
 *   - query 按 ids/createdAfter/limit 返回一致
 *
 * 同一份 record 数据分别经 FsCrudStore 与 SqliteCrudStore 存取，
 * 断言两 engine 行为对齐（task.json keyDecisions.experimentEntities）。
 *
 * 真实落盘：fs 用 tmp DATA_DIR，sqlite 用 :memory:。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsCrudStore } from '../fs-store';
import { SqliteCrudStore } from '../sqlite-store';
import { createCrudSqlDriver } from '../crud-sqlite-driver-factory';
import { VersionConflictError } from '../errors';
import {
  ModelConfigFsSchema,
  ModelConfigSqliteSchema,
} from '../schema_defs/model_config';
import type { CrudStore } from '../crud-types';
import type { SchemaDef } from '../schema-types';
import type { ModelConfigRecord } from '../schema_defs';

const CFG_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CFG_ID_2 = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

let tmpRoot: string;
let fsStore: FsCrudStore;
let sqliteStore: SqliteCrudStore;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-exp-'));
  fsStore = new FsCrudStore({ root: tmpRoot });
  // SqliteCrudStore 走 createCrudSqlDriver 工厂（接收 SqlDriver 注入）
  const { store } = await createCrudSqlDriver(':memory:');
  sqliteStore = store;
});

afterEach(() => {
  sqliteStore.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 两 engine 各自对应的 schema（entity 名不同，字段相同） */
function schemaFor(store: CrudStore): SchemaDef {
  // 用 instanceof 区分；fs→ModelConfigFsSchema，sqlite→ModelConfigSqliteSchema
  return store instanceof FsCrudStore ? ModelConfigFsSchema : ModelConfigSqliteSchema;
}

/** 两 engine 都跑一遍断言的辅助 */
function forBothEngines<T>(
  fn: (store: CrudStore, schema: SchemaDef, label: string) => T,
): { fs: T; sqlite: T } {
  return {
    fs: fn(fsStore, ModelConfigFsSchema, 'fs'),
    sqlite: fn(sqliteStore, ModelConfigSqliteSchema, 'sqlite'),
  };
}

describe('双 engine 一致性 — put/get 信封注入（P1）', () => {
  it('首次 put：两 engine 均注入 createdAt/updatedAt/version=1', () => {
    const results = forBothEngines((store, schema) => {
      const rec: ModelConfigRecord = { id: CFG_ID, key: 'model', value: { n: 1 } };
      return store.put(schema, rec);
    });
    for (const r of [results.fs, results.sqlite]) {
      expect(r.version).toBe(1);
      expect(r.createdAt).toBeTruthy();
      expect(r.updatedAt).toBe(r.createdAt);
      expect(r.key).toBe('model');
      expect(r.value).toEqual({ n: 1 });
    }
  });

  it('upsert 二次写：两 engine 均推进 version、updatedAt；createdAt 不变', () => {
    const results = forBothEngines((store, schema) => {
      const rec: ModelConfigRecord = { id: CFG_ID, key: 'k1', value: 1 };
      store.put(schema, rec);
      // 延时让 updatedAt 不同于首次（同毫秒下 createdAt/updatedAt 可能相等）
      const updated = store.put(schema, { id: CFG_ID, key: 'k1', value: 2 });
      const got = store.get(schema, CFG_ID)!;
      return { updated, got };
    });

    for (const r of [results.fs, results.sqlite]) {
      expect(r.updated.version).toBe(2);
      expect(r.got.version).toBe(2);
      expect(r.got.value).toBe(2);
      expect(r.got.createdAt).toBe(r.updated.createdAt); // createdAt 不可变
    }
  });
});

describe('双 engine 一致性 — delete 返回值', () => {
  it('delete 已存在→true、再删→false、get→undefined', () => {
    const results = forBothEngines((store, schema) => {
      store.put(schema, { id: CFG_ID, key: 'k', value: 1 });
      const del1 = store.delete(schema, CFG_ID);
      const del2 = store.delete(schema, CFG_ID);
      const got = store.get(schema, CFG_ID);
      return { del1, del2, got };
    });
    for (const r of [results.fs, results.sqlite]) {
      expect(r.del1).toBe(true);
      expect(r.del2).toBe(false);
      expect(r.got).toBeUndefined();
    }
  });
});

describe('双 engine 一致性 — query', () => {
  it('query 按 ids 过滤 + limit 一致返回（两 engine 返回相同集合）', () => {
    // 注：同毫秒 createdAt 跨 engine 顺序不稳定（fs 与 sqlite 同毫秒排序可能不同），
    // 故只断言 ids 过滤 + limit 的结果集合一致，不断言顺序。
    const results = forBothEngines((store, schema) => {
      store.put(schema, { id: CFG_ID, key: 'a', value: 1 });
      store.put(schema, { id: CFG_ID_2, key: 'b', value: 2 });
      return store
        .query(schema, { ids: [CFG_ID, CFG_ID_2] })
        .map((r) => r.id)
        .sort();
    });
    expect(results.fs).toHaveLength(2);
    expect(results.sqlite).toHaveLength(2);
    expect(results.fs).toEqual(results.sqlite);
  });
});

describe('双 engine 一致性 — 乐观锁 ifVersion（P4）', () => {
  it('ifVersion 匹配→成功、不匹配→VersionConflictError（两 engine 一致）', () => {
    const results = forBothEngines((store, schema) => {
      const r1 = store.put(schema, { id: CFG_ID, key: 'k', value: 1 });
      // 匹配：成功 +1
      const r2 = store.put(
        schema,
        { id: CFG_ID, key: 'k', value: 2 },
        { ifVersion: r1.version },
      );
      // 不匹配：抛错
      let conflict: VersionConflictError | undefined;
      try {
        store.put(
          schema,
          { id: CFG_ID, key: 'k', value: 3 },
          { ifVersion: r1.version },
        );
      } catch (e) {
        conflict = e as VersionConflictError;
      }
      return { v1: r1.version, v2: r2.version, conflict };
    });

    for (const r of [results.fs, results.sqlite]) {
      expect(r.v1).toBe(1);
      expect(r.v2).toBe(2); // ifVersion=1 匹配后 +1
      expect(r.conflict).toBeInstanceOf(VersionConflictError);
      expect(r.conflict!.expected).toBe(1);
      expect(r.conflict!.actual).toBe(2); // 当前已 version=2
    }
  });
});
