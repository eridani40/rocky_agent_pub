/**
 * SqlDriver 抽象 + 3 实现 + 工厂 — 单元测试
 * 参考: specs/tech/persistence/[P1]search_engine.md §3.1
 *       specs/tech/version_logs/v0.0.126/change_plan.md 模块1（UT 关键覆盖点）
 *       states/v0.0.126/verify/test-plan.md（路径→case 映射锚点）
 *
 * 覆盖：
 *   - BunSqlDriver：prepare/exec/close 行为（建表/插入/查询/close 后抛错）
 *   - SqlStatement 契约：all 返回行数组 / run 返回 changes + lastInsertRowid
 *   - createSqlDriver：dev runtime（process.versions.bun 存在）→ BunSqlDriver 实例
 *   - NodeSqlDriver / BetterSqlite3Driver：仅 type 断言（dev 不实际实例化 dynamic import 包，
 *     避免装包依赖）
 *
 * 用 :memory: 内存库；vitest 跑在 bun 下，bun:sqlite 可用。
 */
import { describe, it, expect } from 'vitest';
import {
  BunSqlDriver,
  NodeSqlDriver,
  BetterSqlite3Driver,
  createSqlDriver,
  setPackagedSqlDriverKind,
  type SqlDriver,
  type SqlStatement,
} from '../search-sql-driver';

// ============================================================
// BunSqlDriver — prepare/exec/close 行为
// ============================================================

describe('BunSqlDriver', () => {
  it('exec 建表 + prepare+run 插入 + prepare+all 查询返回行', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');

    const stmt = driver.prepare('INSERT INTO t (name) VALUES (?)');
    const res = stmt.run('alice');
    expect(res.changes).toBe(1);
    expect(Number(res.lastInsertRowid)).toBe(1);

    const rows = driver.prepare<{ id: number; name: string }>(
      'SELECT id, name FROM t WHERE name = ?',
    ).all('alice');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('alice');
    expect(rows[0]!.id).toBe(1);

    driver.close();
  });

  it('prepare 返回的 SqlStatement 可重复执行（参数化）', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    driver.exec('CREATE TABLE t (k TEXT, v INTEGER)');
    const ins = driver.prepare('INSERT INTO t (k, v) VALUES (?, ?)');
    ins.run('a', 1);
    ins.run('b', 2);
    ins.run('a', 3);

    const got = driver.prepare<{ k: string; v: number }>(
      'SELECT v FROM t WHERE k = ? ORDER BY v',
    ).all('a');
    expect(got.map((r) => r.v)).toEqual([1, 3]);
    driver.close();
  });

  it('run 返回 changes 反映受影响行数（UPDATE/DELETE）', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    driver.exec('CREATE TABLE t (k TEXT, v INTEGER)');
    driver.prepare('INSERT INTO t VALUES (?, ?)').run('a', 1);
    driver.prepare('INSERT INTO t VALUES (?, ?)').run('a', 2);

    const upd = driver.prepare('UPDATE t SET v = v + 10 WHERE k = ?').run('a');
    expect(upd.changes).toBe(2);

    const del = driver.prepare('DELETE FROM t WHERE v > ?').run(11);
    expect(del.changes).toBe(1);

    driver.close();
  });

  it('close 后再操作抛错（连接已关闭）', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    driver.exec('CREATE TABLE t (id INTEGER)');
    driver.close();
    // 关闭后 prepare/exec 应抛（bun:sqlite 在 close 后操作抛 error）
    expect(() => driver.exec('SELECT 1')).toThrow();
  });

  it('exec 可一次执行多条 SQL（DDL 串联，建 schema 用）', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    driver.exec(`
      CREATE TABLE a (id INTEGER PRIMARY KEY);
      CREATE TABLE b (id INTEGER PRIMARY KEY);
      CREATE INDEX idx_a ON a(id);
    `);
    // 两表都能写
    driver.prepare('INSERT INTO a (id) VALUES (?)').run(1);
    driver.prepare('INSERT INTO b (id) VALUES (?)').run(1);
    expect(driver.prepare<{ id: number }>('SELECT id FROM a').all()).toHaveLength(1);
    expect(driver.prepare<{ id: number }>('SELECT id FROM b').all()).toHaveLength(1);
    driver.close();
  });
});

// ============================================================
// SqlStatement 契约 — all 返回行数组 + run 返回 changes/lastInsertRowid
// ============================================================

describe('SqlStatement 契约（BunSqlDriver 产出的 SqlStatement）', () => {
  it('all 无结果返回空数组（不抛错）', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    driver.exec('CREATE TABLE t (id INTEGER)');
    const rows = driver.prepare('SELECT * FROM t').all();
    expect(rows).toEqual([]);
    driver.close();
  });

  it('run 返回 lastInsertRowid 在多行插入后递增', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const r1 = driver.prepare('INSERT INTO t (v) VALUES (?)').run('x');
    const r2 = driver.prepare('INSERT INTO t (v) VALUES (?)').run('y');
    expect(Number(r2.lastInsertRowid)).toBeGreaterThan(Number(r1.lastInsertRowid));
    driver.close();
  });

  it('get 命中返回首行；不命中返回 undefined（SqlStatement.get 单行查询）', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    driver.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    driver.prepare('INSERT INTO t (id, name) VALUES (?, ?)').run(1, 'alice');
    driver.prepare('INSERT INTO t (id, name) VALUES (?, ?)').run(2, 'bob');

    const hit = driver.prepare<{ id: number; name: string }>(
      'SELECT id, name FROM t WHERE id = ?',
    ).get(1);
    expect(hit).toBeDefined();
    expect(hit?.id).toBe(1);
    expect(hit?.name).toBe('alice');

    const miss = driver.prepare<{ id: number; name: string }>(
      'SELECT id, name FROM t WHERE id = ?',
    ).get(999);
    expect(miss).toBeUndefined();
    driver.close();
  });

  it('get 多行匹配只返回首行（单行查询语义）', async () => {
    const driver = await BunSqlDriver.create(':memory:');
    driver.exec('CREATE TABLE t (k TEXT, v INTEGER)');
    driver.prepare('INSERT INTO t VALUES (?, ?)').run('a', 1);
    driver.prepare('INSERT INTO t VALUES (?, ?)').run('a', 2);
    const row = driver.prepare<{ k: string; v: number }>(
      'SELECT k, v FROM t WHERE k = ? ORDER BY v',
    ).get('a');
    // get 命中首行（v=1，ORDER BY v 升序）
    expect(row?.v).toBe(1);
    driver.close();
  });
});

// ============================================================
// createSqlDriver — 按 runtime 选实现
// ============================================================

describe('createSqlDriver', () => {
  it('dev runtime（process.versions.bun 存在）→ 返回 BunSqlDriver 实例', async () => {
    // vitest 跑在 bun 下，process.versions.bun 存在
    const driver = await createSqlDriver(':memory:');
    expect(driver).toBeInstanceOf(BunSqlDriver);
    // 验确实可用
    driver.exec('CREATE TABLE t (id INTEGER)');
    driver.prepare('INSERT INTO t VALUES (?)').run(42);
    const rows = driver.prepare<{ id: number }>('SELECT id FROM t').all();
    expect(rows[0]!.id).toBe(42);
    driver.close();
  });

  it('返回的实例满足 SqlDriver 契约（prepare/exec/close 都在）', async () => {
    const driver = await createSqlDriver(':memory:');
    expect(typeof driver.prepare).toBe('function');
    expect(typeof driver.exec).toBe('function');
    expect(typeof driver.close).toBe('function');
    driver.close();
  });

  it('setPackagedSqlDriverKind 在 dev runtime 仍走 BunSqlDriver（dev 永远 Bun）', async () => {
    setPackagedSqlDriverKind('better-sqlite3');
    const driver = await createSqlDriver(':memory:');
    // dev runtime 强制走 BunSqlDriver（packagedKind 只在非 Bun runtime 生效）
    expect(driver).toBeInstanceOf(BunSqlDriver);
    driver.close();
    setPackagedSqlDriverKind('node'); // 复位（隔离后续测试）
  });
});

// ============================================================
// NodeSqlDriver / BetterSqlite3Driver — 仅结构/type 断言
// （dev 不实际实例化 dynamic import 的包，避免装包依赖；
//  真实路径在 packaged spike 阶段验。）
// ============================================================

describe('NodeSqlDriver / BetterSqlite3Driver（仅结构断言）', () => {
  it('NodeSqlDriver 暴露 create 异步工厂（不在构造期 import 包）', () => {
    expect(typeof NodeSqlDriver.create).toBe('function');
    // create 是 async（返回 Promise）
    const p = NodeSqlDriver.create(':memory:');
    // dev 无 node:sqlite 模块会 reject；此处只验「create 返回 Promise、不在顶层 import」
    expect(p).toBeInstanceOf(Promise);
    // 吞掉 reject 防止 unhandled rejection（dev 下必然 reject）
    p.catch(() => {});
  });

  it('BetterSqlite3Driver 暴露 create 异步工厂（不在构造期 import 包）', () => {
    expect(typeof BetterSqlite3Driver.create).toBe('function');
    const p = BetterSqlite3Driver.create(':memory:');
    expect(p).toBeInstanceOf(Promise);
    p.catch(() => {});
  });

  it('NodeSqlDriver / BetterSqlite3Driver 类自身 implements SqlDriver 契约（type 层面）', () => {
    // type 断言：类实现了 SqlDriver 接口（编译期保证，运行时 no-op）
    const _checkNode: SqlDriver = null as unknown as NodeSqlDriver;
    const _checkBetter: SqlDriver = null as unknown as BetterSqlite3Driver;
    // 防未使用告警
    expect(typeof _checkNode).toBe('object');
    expect(typeof _checkBetter).toBe('object');
  });
});
