/**
 * 慢查询性能日志 UT
 * 参考: reqs/[working] v0.0.257/req.md（三条硬约束）
 *       app/server/src/persistence/slow-query.ts（sink 注册点 + queryWithSlowLog）
 *
 * 校验点：
 *   - FsCrudStore.query 超阈值（>200ms）→ sink 上报 {engine:'fs', entity, shardKey, ms, count, filter}
 *   - 未超阈值不上报；sink 未注册零副作用（不抛、正常返回）
 *   - 分片 schema 上报 shardKey=filter.shardKey；不分片为 null
 *   - SqliteCrudStore.query 超阈值 → sink 上报 engine='sqlite'
 *   - 端到端：sink 接真实 LogWriter —— 开关 true 落 performance.log（含 entity/ms/count/ts）；
 *     开关 false 不落盘（LogWriter 零开销门禁）
 *
 * 全程注入式（fake nowMs + setSlowQuerySink），无 vi.mock 模块替换。
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FsCrudStore } from '../fs-store';
import { SqliteCrudStore } from '../sqlite-store';
import { createCrudSqlDriver } from '../crud-sqlite-driver-factory';
import {
  SLOW_QUERY_MS,
  setSlowQuerySink,
  type SlowQueryInfo,
} from '../slow-query';
import { LogWriter } from '../../dev-logs/log-writer';
import type { SchemaDef } from '../schema-types';
import type { SqlDriver } from '../search-sql-driver';

// ============================================================
// fixture
// ============================================================

/** 不分片 fs entity */
const FlatSchema = {
  entity: 'perf_flat',
  engine: 'file',
  fields: {
    id: { type: 'ulid', required: true },
    key: { type: 'string', required: true },
  },
} as const satisfies SchemaDef;

/** 分片 fs entity（sessionId 为 shardKeyField） */
const ShardSchema = {
  entity: 'perf_shard',
  engine: 'file',
  fs: {
    sharding: { shardKeyField: 'sessionId', dirTemplate: 'sessions/{shardKey}/' },
    format: 'json',
  },
  fields: {
    id: { type: 'ulid', required: true },
    sessionId: { type: 'ulid', required: true },
  },
} as const satisfies SchemaDef;

/** sqlite entity */
const SqliteSchema = {
  entity: 'perf_sqlite',
  engine: 'sqlite',
  fields: {
    id: { type: 'ulid', required: true },
    key: { type: 'string', required: true },
  },
} as const satisfies SchemaDef;

const ULID_A = '01KVCA58G80Y54TTF2S8ZPFR5M';
const ULID_B = '01KVCBNW48VQVCK4S034WS86WR';
const SESSION_A = '01KVCB00ABCDEFGHJKMNPQRST0';

/**
 * 步进假时钟：每次调用推进 stepMs。
 * queryWithSlowLog 每次 query 恰好调 2 次 nowMs（sink 注册时）→ 测得耗时 = stepMs。
 */
function fakeClock(stepMs: number): () => number {
  let t = 0;
  return () => (t += stepMs);
}

/** sink 收集器：注册到模块级注册点，返回收集数组 */
function collectSink(): SlowQueryInfo[] {
  const infos: SlowQueryInfo[] = [];
  setSlowQuerySink((info) => infos.push(info));
  return infos;
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'slow-query-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  setSlowQuerySink(null); // 模块级 sink 必须复位（隔离 UT 间状态）
  vi.restoreAllMocks();
});

// ============================================================
// FsCrudStore.query 埋点
// ============================================================

describe('FsCrudStore.query 慢查询埋点', () => {
  function seedFlat(store: FsCrudStore): void {
    store.put(FlatSchema, { id: ULID_A, key: 'a' });
    store.put(FlatSchema, { id: ULID_B, key: 'b' });
  }

  it('超阈值（300ms > 200ms）→ sink 上报 entity/ms/count/filter，shardKey=null', () => {
    const store = new FsCrudStore({ root: tmpRoot, nowMs: fakeClock(300) });
    seedFlat(store);
    const infos = collectSink();

    const records = store.query(FlatSchema, {});

    expect(records.length).toBe(2); // 查询行为零变更（原样透传）
    expect(infos.length).toBe(1);
    const info = infos[0]!;
    expect(info.kind).toBe('slowquery'); // 与 hang 对称的 grep tag
    expect(info.engine).toBe('fs');
    expect(info.entity).toBe('perf_flat');
    expect(info.ms).toBe(300);
    expect(info.count).toBe(2);
    expect(info.shardKey).toBeNull();
    expect(info.filter).toEqual({});
  });

  it('未超阈值（100ms ≤ 200ms）→ sink 不上报，查询正常返回', () => {
    const store = new FsCrudStore({ root: tmpRoot, nowMs: fakeClock(100) });
    seedFlat(store);
    const infos = collectSink();

    const records = store.query(FlatSchema, {});

    expect(records.length).toBe(2);
    expect(infos.length).toBe(0);
  });

  it('分片 schema：shardKey=filter.shardKey 上报（定位到具体 shard）', () => {
    const store = new FsCrudStore({ root: tmpRoot, nowMs: fakeClock(300) });
    store.put(ShardSchema, { id: ULID_A, sessionId: SESSION_A });
    const infos = collectSink();

    const records = store.query(ShardSchema, { shardKey: SESSION_A });

    expect(records.length).toBe(1);
    expect(infos.length).toBe(1);
    expect(infos[0]!.entity).toBe('perf_shard');
    expect(infos[0]!.shardKey).toBe(SESSION_A);
    expect(infos[0]!.filter).toEqual({ shardKey: SESSION_A });
  });

  it('sink 未注册 → 零副作用（不抛、正常返回、即使超阈值也无任何产出）', () => {
    const store = new FsCrudStore({ root: tmpRoot, nowMs: fakeClock(9999) });
    seedFlat(store);
    setSlowQuerySink(null); // 显式未注册

    const records = store.query(FlatSchema, {});

    expect(records.length).toBe(2);
  });
});

// ============================================================
// SqliteCrudStore.query 埋点
// ============================================================

describe('SqliteCrudStore.query 慢查询埋点', () => {
  let driver: SqlDriver;

  afterEach(() => {
    driver?.close();
  });

  it('超阈值 → sink 上报 engine=sqlite + entity + count', async () => {
    const { driver: d } = await createCrudSqlDriver(':memory:');
    driver = d;
    const store = new SqliteCrudStore(driver, { nowMs: fakeClock(300) });
    store.put(SqliteSchema, { id: ULID_A, key: 'a' });
    store.put(SqliteSchema, { id: ULID_B, key: 'b' });
    const infos = collectSink();

    const records = store.query(SqliteSchema, {});

    expect(records.length).toBe(2);
    expect(infos.length).toBe(1);
    const info = infos[0]!;
    expect(info.kind).toBe('slowquery');
    expect(info.engine).toBe('sqlite');
    expect(info.entity).toBe('perf_sqlite');
    expect(info.ms).toBe(300);
    expect(info.count).toBe(2);
    expect(info.shardKey).toBeNull(); // sqlite 不分片
  });

  it('未超阈值 → sink 不上报', async () => {
    const { driver: d } = await createCrudSqlDriver(':memory:');
    driver = d;
    const store = new SqliteCrudStore(driver, { nowMs: fakeClock(50) });
    store.put(SqliteSchema, { id: ULID_A, key: 'a' });
    const infos = collectSink();

    store.query(SqliteSchema, {});

    expect(infos.length).toBe(0);
  });
});

// ============================================================
// 端到端：sink 接真实 LogWriter（开关门禁 + performance.log 落盘）
// ============================================================

describe('端到端：慢查询 → LogWriter → performance.log', () => {
  /** 构造可控开关的 mock appConfig（与 log-writer.test.ts 同款） */
  function makeMockAppConfig(overrides: Record<string, unknown> = {}) {
    const store: Record<string, unknown> = { ...overrides };
    return {
      get: (g: string, k: string) => store[`${g}.${k}`],
      set: (g: string, k: string, v: unknown) => {
        store[`${g}.${k}`] = v;
      },
    };
  }

  async function flushQueue(w: LogWriter): Promise<void> {
    await w['queue'].flush(5_000);
  }

  it('开关 true：慢查询落 performance.log（JSONL 含 ts/engine/entity/ms/count）', async () => {
    const appConfig = makeMockAppConfig({ 'logs.enablePerformanceLog': true });
    const writer = new LogWriter(tmpRoot, appConfig);
    // 模拟 bootstrap 装配：sink 适配到 LogWriter.write('performance', ...)
    setSlowQuerySink((info) => writer.write('performance', info));
    const store = new FsCrudStore({ root: tmpRoot, nowMs: fakeClock(300) });
    store.put(FlatSchema, { id: ULID_A, key: 'a' });

    store.query(FlatSchema, {});
    await flushQueue(writer);

    const logPath = join(tmpRoot, 'logs', 'performance.log');
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(1);
    const obj = JSON.parse(lines[0]!);
    expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/);
    expect(obj.kind).toBe('slowquery');
    expect(obj.engine).toBe('fs');
    expect(obj.entity).toBe('perf_flat');
    expect(obj.ms).toBe(300);
    expect(obj.count).toBe(1);
    expect(obj.shardKey).toBeNull();
  });

  it('开关 false（默认缺省）：慢查询不落盘（LogWriter 零开销门禁）', async () => {
    const appConfig = makeMockAppConfig({}); // enablePerformanceLog 缺省 = false
    const writer = new LogWriter(tmpRoot, appConfig);
    setSlowQuerySink((info) => writer.write('performance', info));
    const store = new FsCrudStore({ root: tmpRoot, nowMs: fakeClock(300) });
    store.put(FlatSchema, { id: ULID_A, key: 'a' });

    store.query(FlatSchema, {});
    await flushQueue(writer);

    expect(existsSync(join(tmpRoot, 'logs', 'performance.log'))).toBe(false);
  });

  it('阈值边界：恰好 200ms 不算慢（严格大于），201ms 算慢', () => {
    expect(SLOW_QUERY_MS).toBe(200); // 阈值常量锁定（req：默认 200ms）
    const storeEq = new FsCrudStore({ root: tmpRoot, nowMs: fakeClock(200) });
    storeEq.put(FlatSchema, { id: ULID_A, key: 'a' });
    const infos = collectSink();
    storeEq.query(FlatSchema, {});
    expect(infos.length).toBe(0); // 恰好等于阈值不上报

    setSlowQuerySink(null);
    const storeOver = new FsCrudStore({ root: tmpRoot, nowMs: fakeClock(201) });
    storeOver.put(FlatSchema, { id: ULID_B, key: 'b' });
    const infos2 = collectSink();
    storeOver.query(FlatSchema, {});
    expect(infos2.length).toBe(1);
    expect(infos2[0]!.ms).toBe(201);
  });
});
