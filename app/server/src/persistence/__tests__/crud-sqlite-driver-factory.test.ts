/**
 * createCrudSqlDriver 工厂测试 — 双产物 + WAL + SqlDriver 注入
 * 参考: specs/tech/persistence/[P0]sqlite_engine_packaged_promotion.md §2.5（注入而非 new）
 *       specs/tech/persistence/[P1]token_usage_stat.md §2.6（读写分离 store + driver 共享）
 *
 * 覆盖：
 *   - 双产物：返回的 {store, driver} 共享同一 SqlDriver 实例（读写分离前提）
 *   - WAL 已开：driver.exec('PRAGMA journal_mode=WAL') 已调（文件库 PRAGMA 读回 wal）
 *   - store 是 SqliteCrudStore 实例（构造注入 driver，不再内部 new Database）
 *   - SqlDriver 注入：可用 mock driver 构造 SqliteCrudStore（测试可控 + 不依赖真实 sqlite）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCrudSqlDriver } from '../crud-sqlite-driver-factory';
import { SqliteCrudStore } from '../sqlite-store';
import { BunSqlDriver, type SqlDriver, type SqlStatement } from '../search-sql-driver';

/**
 * Mock SqlDriver：记录所有调用 + 简单 in-memory 表模拟（仅测注入链路，不测 SQL 正确性）。
 * SqlStatement.get 用于按主键读单行，mock 需实现。
 */
function makeMockDriver(): SqlDriver & { execCalls: string[] } {
  const execCalls: string[] = [];
  return {
    execCalls,
    prepare: <T = unknown>(_sql: string): SqlStatement<T> => ({
      all: () => [],
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => undefined,
    }),
    exec: (sql: string) => {
      execCalls.push(sql);
    },
    close: () => {},
  };
}

describe('createCrudSqlDriver — 双产物工厂', () => {
  it('返回 {store, driver}，store 是 SqliteCrudStore 实例 + driver 非空', async () => {
    const { store, driver } = await createCrudSqlDriver(':memory:');
    expect(store).toBeInstanceOf(SqliteCrudStore);
    expect(driver).toBeDefined();
    expect(typeof driver.prepare).toBe('function');
    expect(typeof driver.exec).toBe('function');
    store.close();
  });

  it('store.getDriver() 返回与工厂产物 driver 同一实例（读写分离 §2.6）', async () => {
    const { store, driver } = await createCrudSqlDriver(':memory:');
    expect(store.getDriver()).toBe(driver);
    store.close();
  });

  it('WAL 已开（applyWal）：dev runtime 下 PRAGMA journal_mode=wal', async () => {
    // 用临时文件库（:memory: 不持久化 PRAGMA），独立 probe 验证
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crud-factory-test-'));
    try {
      const dbPath = path.join(tmpDir, 'crud.sqlite');
      const { store } = await createCrudSqlDriver(dbPath);
      // 独立 BunSqlDriver 连接验 PRAGMA（同库不同连接可见 WAL）
      const probe = await BunSqlDriver.create(dbPath);
      const row = probe.prepare<{ journal_mode?: string }>('PRAGMA journal_mode').get();
      probe.close();
      store.close();
      expect(row?.journal_mode?.toLowerCase()).toBe('wal');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('SqliteCrudStore 可注入 mock driver（不再内部 new Database，测试可控）', () => {
    const mock = makeMockDriver();
    // 构造接受外部 driver（不再走 {path}）
    const store = new SqliteCrudStore(mock);
    expect(store.getDriver()).toBe(mock);
    store.close();
    // close 转发给 driver.close（mock 记录无抛错即通过）
  });
});

describe('SqliteCrudStore — transaction 手动 BEGIN/COMMIT/ROLLBACK 链路', () => {
  it('transaction 正常路径：BEGIN → fn → COMMIT（via driver.exec 记录）', async () => {
    const mock = makeMockDriver();
    const store = new SqliteCrudStore(mock);
    const result = store.transaction(() => 42);
    expect(result).toBe(42);
    // 应有 BEGIN + COMMIT（顺序）
    expect(mock.execCalls).toContain('BEGIN');
    expect(mock.execCalls).toContain('COMMIT');
    expect(mock.execCalls[mock.execCalls.length - 1]).toBe('COMMIT');
    store.close();
  });

  it('transaction 异常路径：BEGIN → fn throw → ROLLBACK + 原异常向上抛', async () => {
    const mock = makeMockDriver();
    const store = new SqliteCrudStore(mock);
    expect(() =>
      store.transaction(() => {
        throw new Error('biz-fail');
      }),
    ).toThrowError(/biz-fail/);
    // 应有 BEGIN + ROLLBACK
    expect(mock.execCalls).toContain('BEGIN');
    expect(mock.execCalls).toContain('ROLLBACK');
    expect(mock.execCalls[mock.execCalls.length - 1]).toBe('ROLLBACK');
    store.close();
  });
});
