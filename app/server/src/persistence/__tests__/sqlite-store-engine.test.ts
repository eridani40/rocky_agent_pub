/**
 * SqliteCrudStore 集成测试 — engine 专有能力：事务 / WAL / json_extract（真实 SqlDriver）
 * 参考: specs/tech/persistence/[P0]sqlite_crud_store_engine.md §3.5/§4/§5
 *       specs/tech/persistence/[P0]sqlite_engine_packaged_promotion.md §2.3（手动 BEGIN/COMMIT/ROLLBACK）
 *
 * 覆盖：
 *   - 事务：transaction 内多 put 全成功→落盘；任一异常→全部回滚（连建表 DDL 一并回滚）
 *     （手动 BEGIN/COMMIT/ROLLBACK via driver.exec，跨 driver 共识）
 *   - WAL：文件库初始化后 PRAGMA journal_mode=wal
 *   - json_extract 扩展查询（engine 专有，不跨 engine 可移植）
 *
 * CRUD / mode / ifVersion / query 见 sqlite-store.test.ts（拆分自原单文件，≤300 行）。
 * 用 :memory: 内存库 + 临时文件库断言 WAL；vitest 跑在 bun 下，BunSqlDriver 可用。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BunSqlDriver } from '../search-sql-driver';
import { createCrudSqlDriver } from '../crud-sqlite-driver-factory';
import { SqliteCrudStore } from '../sqlite-store';
import type { SchemaDef } from '../schema-types';

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

// 两个 entity 用于事务跨表回滚断言
const OtherSchema = {
  entity: 'other_config',
  engine: 'sqlite',
  fields: {
    id: { type: 'ulid', required: true },
    note: { type: 'string', required: true },
  },
} as const satisfies SchemaDef;

// 合法 ULID（26 字符 Crockford base32）
const ULID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID_B = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

// ============================================================
// 公用：每个 it 独立 store（:memory:），避免状态串扰
// 走 createCrudSqlDriver 工厂（createSqlDriver + applyWal + new SqliteCrudStore）
// ============================================================
async function newStore(): Promise<SqliteCrudStore> {
  const { store } = await createCrudSqlDriver(':memory:');
  return store;
}

describe('SqliteCrudStore — 事务（engine 专有，手动 BEGIN/COMMIT/ROLLBACK）', () => {
  it('transaction 内多 put 全成功 → 全部落盘', async () => {
    const store = await newStore();
    store.transaction((tx) => {
      tx.put(ModelConfigSchema, { id: ULID_A, key: 'a', value: {} });
      tx.put(OtherSchema, { id: ULID_B, note: 'n' });
    });
    expect(store.get(ModelConfigSchema, ULID_A)?.key).toBe('a');
    expect(store.get(OtherSchema, ULID_B)?.note).toBe('n');
  });

  it('transaction 内任一异常 → 全部回滚（连建表 DDL 一并回滚，表不存在）', async () => {
    const store = await newStore();
    expect(() =>
      store.transaction((tx) => {
        tx.put(ModelConfigSchema, { id: ULID_A, key: 'a', value: {} });
        tx.put(OtherSchema, { id: ULID_B, note: 'n' });
        throw new Error('boom');
      }),
    ).toThrowError(/boom/);
    // 事务回滚后 DDL 也回滚，表不存在 → get 抛 no such table（更强回滚证据）
    // 用 raw 查询断言：回滚后两表均无对应行
    expect(store.readRawRow('model_config', ULID_A)).toBeUndefined();
    expect(store.readRawRow('other_config', ULID_B)).toBeUndefined();
  });
});

describe('SqliteCrudStore — WAL 与文件库', () => {
  let tmpDir: string;
  let dbPath: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-test-'));
    dbPath = path.join(tmpDir, 'app.db');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('文件库初始化后 PRAGMA journal_mode=wal', async () => {
    const { store, driver } = await createCrudSqlDriver(dbPath);
    // engine 内部已开 WAL（applyWal），用独立连接验证
    const probe = await BunSqlDriver.create(dbPath);
    const row = probe.prepare<{ journal_mode?: string }>('PRAGMA journal_mode').get();
    probe.close();
    store.close();
    // 关 driver 同 store（store.close 转发 driver.close，避免重复 close）
    void driver;
    expect(row?.journal_mode?.toLowerCase()).toBe('wal');
  });
});

describe('SqliteCrudStore — json_extract 扩展查询（engine 专有，不跨 engine 可移植）', () => {
  it('按 data 内业务字段过滤（标注 engine 专有）', async () => {
    const store = await newStore();
    store.put(ModelConfigSchema, { id: ULID_A, key: 'a', value: { n: 1 } });
    store.put(ModelConfigSchema, { id: ULID_B, key: 'b', value: { n: 2 } });
    // json_extract(data,'$.key')=? — engine 专有，契约不保证跨 engine
    const r = store.queryByJsonExtract(ModelConfigSchema, 'key', 'b');
    expect(r.map((x) => x.id)).toEqual([ULID_B]);
  });
});
