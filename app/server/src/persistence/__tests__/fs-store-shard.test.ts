/**
 * FsCrudStore 分片集成测试（spec §2/§3.1/§3.6/§3.7）
 * 参考: specs/tech/persistence/[P0]fs_crud_store_engine.md §2/§3.1/§3.7
 *       states/v0.0.2/verify/test-plan.md §2 P2 分片路径 + §3 分片维度
 *
 * 覆盖：
 *   - P2 分片：按 sessionId 落 shard 目录；put 提取 shardKey
 *   - P2 get/delete 必须传 shardKey 路由
 *   - P2 query 单 shard 返回该 session 记录
 *   - §3.7 query scatter 不带 shardKey 遍历所有 shard 目录
 *   - 同 shardKey 多 entity 聚同 shard 目录（断言落盘路径）
 *   - json 格式分片（不同于 transcript 的 jsonl）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FsCrudStore } from '../fs-store';
import { debugSegmentStats } from '../fs-jsonl';
import type { SchemaDef } from '../schema-types';

// 分片 json 格式（summary 风格）
const ShardJsonSchema = {
  entity: 'summary',
  engine: 'file',
  fs: {
    sharding: { shardKeyField: 'sessionId', dirTemplate: 'sessions/{shardKey}/' },
    format: 'json',
  },
  fields: {
    id: { type: 'ulid', required: true },
    sessionId: { type: 'ulid', required: true },
    text: { type: 'string', required: true },
  },
} as const satisfies SchemaDef;

// 分片 jsonl 格式（transcript 风格，maxCount=3 便于测试 roll 段）
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

const SESSION_A = '01KVCB00ABCDEFGHJKMNPQRSTV0'; // 已弃用，保留注释占位

let tmpRoot: string;
let store: FsCrudStore;
let clock: { now: string };

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-store-shard-'));
  clock = { now: '2026-06-19T03:10:00.000Z' };
  store = new FsCrudStore({ root: tmpRoot, now: () => clock.now });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// 生成 26 字符合法 ULID
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

// 合法 sessionId（26 字符，由 ulid 生成保证合法）
const SID_OK = ulid('01KVSESS', 0);
const SID_OK2 = ulid('01KVSETT', 0);

describe('FsCrudStore 分片 json 路由 P2', () => {
  it('put 按 sessionId 落 shard 目录 {root}/sessions/<sid>/summary/{id}.json', () => {
    const id = ulid('01KVVDAA', 1);
    store.put(ShardJsonSchema, { id, sessionId: SID_OK, text: 'hi' });
    const file = path.join(tmpRoot, 'sessions', SID_OK, 'summary', `${id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.id).toBe(id);
    expect(raw.sessionId).toBe(SID_OK);
    expect(raw.text).toBe('hi');
  });

  it('get 必须传 shardKey 才正确路由；不传抛错', () => {
    const id = ulid('01KVVDAA', 2);
    store.put(ShardJsonSchema, { id, sessionId: SID_OK, text: 'hi' });
    const got = store.get(ShardJsonSchema, id, SID_OK);
    expect(got?.id).toBe(id);

    // 不传 shardKey → 抛错（point 访问需路由）
    expect(() => store.get(ShardJsonSchema, id)).toThrow(/shardKey/);
  });

  it('delete 必须传 shardKey；正确删除返回 true', () => {
    const id = ulid('01KVVDAA', 3);
    store.put(ShardJsonSchema, { id, sessionId: SID_OK, text: 'hi' });
    expect(store.delete(ShardJsonSchema, id, SID_OK)).toBe(true);
    expect(store.get(ShardJsonSchema, id, SID_OK)).toBeUndefined();
  });

  it('同 shardKey 多 entity 聚同 shard 目录不同子目录', () => {
    const id1 = ulid('01KVTRAA', 1);
    const id2 = ulid('01KVSVAA', 1);
    store.put(ShardJsonlSchema, {
      id: id1,
      sessionId: SID_OK,
      role: 'user',
      content: [{ type: 'text', text: 'q' }],
    });
    store.put(ShardJsonSchema, { id: id2, sessionId: SID_OK, text: 'sum' });
    // 两 entity 同 shard 目录
    const dir = path.join(tmpRoot, 'sessions', SID_OK);
    expect(fs.existsSync(path.join(dir, 'transcript'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'summary'))).toBe(true);
  });
});

describe('FsCrudStore 分片 query P2/§3.7', () => {
  it('query 带 shardKey = 单 shard 目录查询', () => {
    // session A: 2 条；session B: 1 条
    store.put(ShardJsonSchema, { id: ulid('01KVA00A', 1), sessionId: SID_OK, text: 'a1' });
    store.put(ShardJsonSchema, { id: ulid('01KVA00B', 2), sessionId: SID_OK, text: 'a2' });
    store.put(ShardJsonSchema, { id: ulid('01KVB00A', 1), sessionId: SID_OK2, text: 'b1' });

    const inA = store.query(ShardJsonSchema, { shardKey: SID_OK });
    expect(inA.length).toBe(2);
    expect(inA.every((r) => r.sessionId === SID_OK)).toBe(true);

    const inB = store.query(ShardJsonSchema, { shardKey: SID_OK2 });
    expect(inB.length).toBe(1);
    expect(inB[0]!.sessionId).toBe(SID_OK2);
  });

  it('query 不带 shardKey = scatter 遍历所有 shard 目录', () => {
    store.put(ShardJsonSchema, { id: ulid('01KVA00A', 1), sessionId: SID_OK, text: 'a1' });
    store.put(ShardJsonSchema, { id: ulid('01KVB00A', 1), sessionId: SID_OK2, text: 'b1' });
    const all = store.query(ShardJsonSchema, {});
    expect(all.length).toBe(2);
    expect(new Set(all.map((r) => r.sessionId))).toEqual(new Set([SID_OK, SID_OK2]));
  });
});

describe('FsCrudStore jsonl 段文件 §3.2-§3.4', () => {
  it('段名 = 段首条 ULID；段内行按 id 有序', () => {
    const id1 = ulid('01KVVD01', 1);
    const id2 = ulid('01KVVD02', 1);
    store.put(ShardJsonlSchema, {
      id: id1,
      sessionId: SID_OK,
      role: 'user',
      content: 'a',
    });
    store.put(ShardJsonlSchema, {
      id: id2,
      sessionId: SID_OK,
      role: 'assistant',
      content: 'b',
    });
    const segDir = path.join(tmpRoot, 'sessions', SID_OK, 'transcript');
    const stats = debugSegmentStats(segDir);
    expect(stats.length).toBe(1);
    expect(stats[0]!.name).toBe(id1); // 段名 = 首条 ULID
    expect(stats[0]!.count).toBe(2);
    expect(stats[0]!.firstId).toBe(id1);
    expect(stats[0]!.lastId).toBe(id2); // 段内 id 升序
  });

  it('jsonlMaxCount 封顶后 roll 新段（段名=新段首条 ULID）', () => {
    // maxCount=3，写 4 条 id 单调递增 → 前 3 在段1，第 4 在新段2
    const ids = [ulid('01KVVD01', 1), ulid('01KVVD02', 1), ulid('01KVVD03', 1), ulid('01KVVD04', 1)];
    for (const id of ids) {
      store.put(ShardJsonlSchema, {
        id,
        sessionId: SID_OK,
        role: 'user',
        content: id,
      });
    }
    const stats = debugSegmentStats(path.join(tmpRoot, 'sessions', SID_OK, 'transcript'));
    expect(stats.length).toBe(2);
    expect(stats[0]!.name).toBe(ids[0]); // 段1 名 = 第1条
    expect(stats[1]!.name).toBe(ids[3]); // 段2 名 = 第4条（新段首条）
    expect(stats[0]!.count).toBe(3);
    expect(stats[1]!.count).toBe(1);
  });

  it('jsonl append 尾段路径：id 单调递增全部入尾段（未满）', () => {
    const ids = [ulid('01KVJJ01', 1), ulid('01KVJJ02', 1)];
    for (const id of ids) {
      store.put(ShardJsonlSchema, { id, sessionId: SID_OK, role: 'user', content: id });
    }
    const stats = debugSegmentStats(path.join(tmpRoot, 'sessions', SID_OK, 'transcript'));
    expect(stats.length).toBe(1);
    expect(stats[0]!.count).toBe(2);
  });

  it('jsonl 乱序回填：id < shardMax 重写段插到正确位置', () => {
    // 先写 id 大的，再回填 id 小的
    const big = ulid('01KVZZ00', 9);
    store.put(ShardJsonlSchema, { id: big, sessionId: SID_OK, role: 'user', content: 'big' });
    const small = ulid('01KVAA00', 1);
    store.put(ShardJsonlSchema, { id: small, sessionId: SID_OK, role: 'user', content: 'small' });
    const stats = debugSegmentStats(path.join(tmpRoot, 'sessions', SID_OK, 'transcript'));
    // 段名 = 首条最小 ULID（即 small）
    expect(stats[0]!.name).toBe(small);
    expect(stats[0]!.firstId).toBe(small);
    expect(stats[0]!.lastId).toBe(big);
    // 读回顺序正确
    const got = store.get(ShardJsonlSchema, big, SID_OK);
    expect(got?.id).toBe(big);
    const got2 = store.get(ShardJsonlSchema, small, SID_OK);
    expect(got2?.id).toBe(small);
  });

  it('jsonl get 二分段名定位段 + 段内取行', () => {
    const ids = Array.from({ length: 5 }, (_, i) => ulid('01KVGG0', i + 1));
    for (const id of ids) {
      store.put(ShardJsonlSchema, { id, sessionId: SID_OK, role: 'user', content: id });
    }
    // maxCount=3 → 段1 3条、段2 2条
    const stats = debugSegmentStats(path.join(tmpRoot, 'sessions', SID_OK, 'transcript'));
    expect(stats.length).toBe(2);
    // 任取一个 id 都能读回
    for (const id of ids) {
      const got = store.get(ShardJsonlSchema, id, SID_OK);
      expect(got?.id).toBe(id);
    }
  });

  it('jsonl query 单 shard 按 createdAtDesc 默认排序 + limit（最近 N）', () => {
    const ids = Array.from({ length: 5 }, (_, i) => ulid('01KVQQ0', i + 1));
    let t = 1;
    for (const id of ids) {
      clock.now = `2026-06-19T03:${10 + t}:00.000Z`;
      t++;
      store.put(ShardJsonlSchema, { id, sessionId: SID_OK, role: 'user', content: id });
    }
    const recent3 = store.query(ShardJsonlSchema, { shardKey: SID_OK, limit: 3 });
    expect(recent3.length).toBe(3);
    // DESC → 最后写的在前
    expect(recent3[0]!.id).toBe(ids[4]);
    expect(recent3[2]!.id).toBe(ids[2]);
  });

  it('jsonl delete 重写段删行；段空则删段文件', () => {
    const id1 = ulid('01KVDD01', 1);
    store.put(ShardJsonlSchema, { id: id1, sessionId: SID_OK, role: 'user', content: 'a' });
    expect(store.delete(ShardJsonlSchema, id1, SID_OK)).toBe(true);
    // 段空 → 段文件被删
    const stats = debugSegmentStats(path.join(tmpRoot, 'sessions', SID_OK, 'transcript'));
    expect(stats.length).toBe(0);
    expect(store.get(ShardJsonlSchema, id1, SID_OK)).toBeUndefined();
  });

  it('jsonl update（同 id 再 put）覆盖该行', () => {
    const id = ulid('01KVVV01', 1);
    store.put(ShardJsonlSchema, { id, sessionId: SID_OK, role: 'user', content: 'v1' });
    const r2 = store.put(ShardJsonlSchema, {
      id,
      sessionId: SID_OK,
      role: 'assistant',
      content: 'v2',
    });
    expect(r2.version).toBe(2);
    const got = store.get(ShardJsonlSchema, id, SID_OK);
    expect(got?.role).toBe('assistant');
    expect(got?.content).toBe('v2');
  });
});
