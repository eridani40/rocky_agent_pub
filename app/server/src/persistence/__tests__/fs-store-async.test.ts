/**
 * FsCrudStore.putAsync/deleteAsync + CompositeStore forwarder 并发串行化测试
 * 参考: specs/tech/persistence/[P1]file_write_lock.md §4（async 扩展）+ §7（C1-C13 场景）
 *
 * 覆盖（spec §7 最低要求）：
 *   - C1  两并发 putAsync 同 record（json）→ 串行、无丢更新、version=2
 *   - C2  N=10 并发 putAsync 同 record → 全串行、version=N、无 tmp 残留
 *   - C3  两并发 jsonl putAsync 同 shard 同段 → 串行入段、段名不变式保持
 *   - C4  两并发 jsonl putAsync 同 shard 不同 id 范围 → 串行（锁颗粒=段目录）
 *   - C11 边界：sync put 不走锁（与 putAsync 不互斥）—— 迁移后禁止同 path 混用
 *   - C13 两并发 deleteAsync 同 record → 串行、第二个返 false（已删）
 *   - CompositeStore forwarder（§4.3）：engine=fs 委托 putAsync；engine=sqlite 退化 Promise.resolve(sync)
 *
 * 风格参考 fs-store-flat.test.ts / fs-store-shard.test.ts（schema/fixture/clock 注入）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FsCrudStore } from '../fs-store';
import { CompositeStore } from '../composite';
import { getLockSize } from '../file-lock';
import { debugSegmentStats } from '../fs-jsonl';
import type { CrudStore, PutOptions, QueryFilter, StoredRecord } from '../crud-types';
import type { SchemaDef, InferRecord } from '../schema-types';

// 扁平 json schema（单文件锁颗粒）
const FlatSchema = {
  entity: 'app_config',
  engine: 'file',
  fields: {
    id: { type: 'ulid', required: true },
    key: { type: 'string', required: true },
    value: { type: 'json', required: true },
  },
} as const satisfies SchemaDef;

// 分片 jsonl schema（段目录锁颗粒，maxCount=3 便于测段不变式）
const ShardJsonlSchema = {
  entity: 'transcript',
  engine: 'file',
  fs: {
    sharding: { shardKeyField: 'sessionId', dirTemplate: 'sessions/{shardKey}/' },
    format: 'jsonl',
    jsonlMaxCount: 3,
  },
  fields: {
    id: { type: 'ulid', required: true },
    sessionId: { type: 'ulid', required: true },
    role: { type: 'enum', required: true, enumValues: ['user', 'assistant', 'tool'] },
    content: { type: 'json', required: true },
  },
} as const satisfies SchemaDef;

const ULID_A = '01KVCA58G80Y54TTF2S8ZPFR5M';
const ULID_B = '01KVCBNW48VQVCK4S034WS86WR';

let tmpRoot: string;
let store: FsCrudStore;
let clock: { now: string };

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-store-async-'));
  clock = { now: '2026-07-01T03:10:00.000Z' };
  store = new FsCrudStore({ root: tmpRoot, now: () => clock.now });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 生成 26 字符合法 ULID（Crockford base32）
function ulid(prefix: string, n: number): string {
  const c = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let s = prefix;
  let x = n;
  while (s.length < 26) {
    s += c[x % c.length];
    x = Math.floor(x / c.length) + 1;
  }
  return s.slice(0, 26);
}

const SID_OK = ulid('01KVSESS', 0);

/** 递归扫 tmpRoot 下所有 .tmp 残留（spec §3.6 原子写不应残留） */
function listTmpFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (e.endsWith('.tmp')) out.push(p);
    }
  }
  walk(root);
  return out;
}

// ============================================================
// C1 / C2 — json putAsync 并发串行
// ============================================================
describe('FsCrudStore.putAsync — json 并发串行（C1/C2）', () => {
  it('C1: 两并发 putAsync 同 record → 串行无丢更新，version=2', async () => {
    const [r1, r2] = await Promise.all([
      store.putAsync(FlatSchema, { id: ULID_A, key: 'a', value: 1 }),
      store.putAsync(FlatSchema, { id: ULID_A, key: 'a', value: 2 }),
    ]);
    // FIFO：第一次得 version=1，第二次看到 v1 后自增到 v2（无丢更新）
    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);
    const got = store.get(FlatSchema, ULID_A);
    expect(got?.version).toBe(2);
    expect(got?.value).toBe(2);
  });

  it('C2: N=10 并发 putAsync 同 record → 全串行，version 1..10，无 tmp 残留', async () => {
    const N = 10;
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        store.putAsync(FlatSchema, { id: ULID_A, key: 'a', value: i }),
      );
    }
    const results = (await Promise.all(promises)) as { version: number }[];
    // version 严格 1..N（FIFO 顺序与入队一致；每项看到前项写后自增）
    expect(results.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const got = store.get(FlatSchema, ULID_A);
    expect(got?.version).toBe(N);
    // 原子写无 tmp 互相覆盖残留
    expect(listTmpFiles(tmpRoot)).toEqual([]);
  });
});

// ============================================================
// C3 / C4 — jsonl putAsync 段目录锁
// ============================================================
describe('FsCrudStore.putAsync — jsonl 段目录锁（C3/C4）', () => {
  it('C3: 两并发 jsonl putAsync 同 shard 同段 → 串行入段，段名=段首最小 ULID', async () => {
    const id1 = ulid('01KVAA01', 1);
    const id2 = ulid('01KVAA02', 1);
    await Promise.all([
      store.putAsync(ShardJsonlSchema, {
        id: id1, sessionId: SID_OK, role: 'user', content: 'a',
      }),
      store.putAsync(ShardJsonlSchema, {
        id: id2, sessionId: SID_OK, role: 'user', content: 'b',
      }),
    ]);
    const segDir = path.join(tmpRoot, 'sessions', SID_OK, 'transcript');
    const stats = debugSegmentStats(segDir);
    // 两记录同入一段（锁段目录串行，无 tmp 互相覆盖）
    expect(stats.length).toBe(1);
    expect(stats[0]!.count).toBe(2);
    // 不变式：段名 = 段首最小 ULID
    const expectedName = id1 < id2 ? id1 : id2;
    expect(stats[0]!.name).toBe(expectedName);
    // 两记录都能读回
    expect(store.get(ShardJsonlSchema, id1, SID_OK)?.content).toBe('a');
    expect(store.get(ShardJsonlSchema, id2, SID_OK)?.content).toBe('b');
  });

  it('C4: 两并发 jsonl putAsync 同 shard 不同 id 范围 → 仍串行（锁颗粒=段目录）', async () => {
    // 即使 id 范围差很大（不同段范围），同 shard 同 entity 的段目录锁仍串行
    const small = ulid('01KVAA00', 1);
    const big = ulid('01KVZZ90', 9);
    await Promise.all([
      store.putAsync(ShardJsonlSchema, {
        id: big, sessionId: SID_OK, role: 'user', content: 'big',
      }),
      store.putAsync(ShardJsonlSchema, {
        id: small, sessionId: SID_OK, role: 'user', content: 'small',
      }),
    ]);
    // 两记录都正确落盘（无损坏、无丢更新）
    expect(store.get(ShardJsonlSchema, big, SID_OK)?.content).toBe('big');
    expect(store.get(ShardJsonlSchema, small, SID_OK)?.content).toBe('small');
    // 段名不变式：段首 = 最小 ULID（small）
    const stats = debugSegmentStats(path.join(tmpRoot, 'sessions', SID_OK, 'transcript'));
    expect(stats[0]!.name).toBe(small);
    expect(stats[0]!.count).toBe(2);
  });
});

// ============================================================
// C11 — sync put 与 putAsync 不互斥（边界文档化）
// ============================================================
describe('FsCrudStore — sync put vs putAsync 边界（C11）', () => {
  it('sync put 不入锁 Map（getLockSize 不变），与 putAsync 不互斥', () => {
    // 边界（spec §8 反例）：sync put 不经 withFileLock，与 putAsync 同 path 混用
    // 时会绕过串行 → 等于没锁。此测试断言「sync put 确实不入锁」。
    // 迁移约束：同 path 须整路径切 async（spec §8）；禁止 sync+async 混用。
    const before = getLockSize();
    store.put(FlatSchema, { id: ULID_A, key: 'sync', value: 1 });
    expect(getLockSize()).toBe(before); // sync put 不持锁
    expect(store.get(FlatSchema, ULID_A)?.value).toBe(1);
  });

  it('putAsync/deleteAsync 之间通过锁互斥（同 path 串行）', async () => {
    // 对照：putAsync 入锁 Map（与 sync put 形成对比）
    // 这里通过「并发不丢更新」间接证明锁生效（不直接窥探 Map，避免时序耦合）
    await Promise.all([
      store.putAsync(FlatSchema, { id: ULID_B, key: 'a', value: 1 }),
      store.putAsync(FlatSchema, { id: ULID_B, key: 'a', value: 2 }),
    ]);
    expect(store.get(FlatSchema, ULID_B)?.version).toBe(2);
  });
});

// ============================================================
// C13 — deleteAsync 并发串行
// ============================================================
describe('FsCrudStore.deleteAsync — 并发串行（C13）', () => {
  it('C13: 两并发 deleteAsync 同 record → 串行，第二个返 false（已删）', async () => {
    await store.putAsync(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    expect(store.get(FlatSchema, ULID_A)).toBeDefined();

    const [r1, r2] = await Promise.all([
      store.deleteAsync(FlatSchema, ULID_A),
      store.deleteAsync(FlatSchema, ULID_A),
    ]);
    // 一个 true（实际删）、一个 false（已删）；顺序不固定但集合确定
    expect([r1, r2].sort()).toEqual([false, true]);
    expect(store.get(FlatSchema, ULID_A)).toBeUndefined();
  });

  it('deleteAsync 不存在 record 返 false（不抛错）', async () => {
    const ok = await store.deleteAsync(FlatSchema, ULID_B);
    expect(ok).toBe(false);
  });
});

// ============================================================
// CompositeStore forwarder（§4.3）
// ============================================================
describe('CompositeStore.putAsync/deleteAsync forwarder（§4.3）', () => {
  it('engine=fs → 委托 putAsync：并发同 record 串行（version 正确自增）', async () => {
    const composite = new CompositeStore().mount('app_config', store);
    const [r1, r2] = await Promise.all([
      composite.putAsync(FlatSchema, { id: ULID_A, key: 'a', value: 1 }),
      composite.putAsync(FlatSchema, { id: ULID_A, key: 'a', value: 2 }),
    ]);
    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);
    // 落盘正确（经 CompositeStore 路由到 FsCrudStore）
    expect(composite.get(FlatSchema, ULID_A)?.version).toBe(2);
  });

  it('engine=fs → 委托 deleteAsync', async () => {
    const composite = new CompositeStore().mount('app_config', store);
    await composite.putAsync(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    expect(await composite.deleteAsync(FlatSchema, ULID_A)).toBe(true);
    expect(composite.get(FlatSchema, ULID_A)).toBeUndefined();
  });

  it('engine 无 putAsync（如 SqliteCrudStore）→ 退化为 Promise.resolve(sync put/delete)', async () => {
    // 用 mock engine 模拟「只实现 sync CrudStore 的 engine」（即 SqliteCrudStore 形态），
    // 避免直接 import bun:sqlite（其只在 bun runtime 可用，vitest 隔离跑挂）。
    // 断言：CompositeStore forwarder 检测到 engine 无 putAsync → 走 Promise.resolve(sync put)。
    const calls: string[] = [];
    const mockEngine: CrudStore = {
      put<S extends SchemaDef>(s: S, r: InferRecord<S>, o?: PutOptions): StoredRecord<S> {
        calls.push('put');
        return { ...r, createdAt: 't', updatedAt: 't', version: 1 } as StoredRecord<S>;
      },
      get<S extends SchemaDef>(s: S, id: string): StoredRecord<S> | undefined {
        calls.push('get');
        return undefined;
      },
      delete<S extends SchemaDef>(s: S, id: string): boolean {
        calls.push('delete');
        return true;
      },
      query<S extends SchemaDef>(s: S, f: QueryFilter): StoredRecord<S>[] {
        calls.push('query');
        return [];
      },
    };
    const composite = new CompositeStore().mount('app_config', mockEngine);

    // putAsync → 检测到 mock 无 putAsync → 调 sync put 并包 Promise
    const r = await composite.putAsync(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    expect(r.version).toBe(1);
    expect(calls).toContain('put');
    // 确认走的是 sync 分支（非 putAsync）
    expect('putAsync' in mockEngine).toBe(false);

    // deleteAsync 同样退化为 sync delete
    expect(await composite.deleteAsync(FlatSchema, ULID_A)).toBe(true);
    expect(calls).toContain('delete');
  });
});
