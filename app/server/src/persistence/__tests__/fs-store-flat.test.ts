/**
 * FsCrudStore 扁平目录集成测试（spec §2/§4 + §3.6 原子写）
 * 参考: specs/tech/persistence/[P0]fs_crud_store_engine.md §2-§4
 *       states/v0.0.2/verify/test-plan.md §3 FsCrudStore 维度 + §2 P1 写入读回
 *
 * 覆盖：
 *   - P1 不分片 put→磁盘断言 {root}/{entity}/{id}.json 存在且内容含 record+信封
 *   - P1 get 读回字段+信封一致
 *   - P4 PutOptions.ifVersion：匹配→version+1、不匹配→VersionConflictError
 *   - P5 PutOptions.mode：insert(已存在→RecordExistsError)/replace/upsert
 *   - §3.6 原子写：put/delete 后磁盘无残留 .tmp 文件
 *   - delete/query 行为
 *
 * now 通过构造器注入（engine 专有扩展，便于测试固定时间）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FsCrudStore } from '../fs-store';
import {
  RecordExistsError,
  RecordNotFoundError,
  VersionConflictError,
} from '../errors';
import type { SchemaDef } from '../schema-types';

const FlatSchema = {
  entity: 'app_config',
  engine: 'file',
  fields: {
    id: { type: 'ulid', required: true },
    key: { type: 'string', required: true },
    value: { type: 'json', required: true },
  },
} as const satisfies SchemaDef;

const ULID_A = '01KVCA58G80Y54TTF2S8ZPFR5M';
const ULID_B = '01KVCBNW48VQVCK4S034WS86WR';

const T1 = '2026-06-19T03:10:00.000Z';
const T2 = '2026-06-19T04:00:00.000Z';

// 可变时钟，便于测试在不同 put 间推进时间
let clock: { now: string };
let store: FsCrudStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-store-flat-'));
  clock = { now: T1 };
  store = new FsCrudStore({ root: tmpRoot, now: () => clock.now });
});

let tmpRoot: string;

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function listTmpFiles(root: string): Promise<string[]> {
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

describe('FsCrudStore 扁平目录 P1 写入读回', () => {
  it('put 返回含信封（createdAt/updatedAt/version=1）', () => {
    const r = store.put(FlatSchema, { id: ULID_A, key: 'theme', value: { color: 'dark' } });
    expect(r.version).toBe(1);
    expect(r.createdAt).toBe(T1);
    expect(r.updatedAt).toBe(T1);
    expect(r.key).toBe('theme');
    expect(r.value).toEqual({ color: 'dark' });
  });

  it('磁盘落盘：{root}/{entity}/{id}.json 存在且含 record+信封', () => {
    store.put(FlatSchema, { id: ULID_A, key: 'theme', value: { color: 'dark' } });
    const file = path.join(tmpRoot, 'app_config', `${ULID_A}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.id).toBe(ULID_A);
    expect(raw.key).toBe('theme');
    expect(raw.value).toEqual({ color: 'dark' });
    expect(raw.createdAt).toBe(T1);
    expect(raw.updatedAt).toBe(T1);
    expect(raw.version).toBe(1);
  });

  it('get 读回字段+信封一致', () => {
    store.put(FlatSchema, { id: ULID_A, key: 'theme', value: 1 });
    const got = store.get(FlatSchema, ULID_A);
    expect(got?.id).toBe(ULID_A);
    expect(got?.key).toBe('theme');
    expect(got?.value).toBe(1);
    expect(got?.createdAt).toBe(T1);
    expect(got?.version).toBe(1);
  });

  it('get 不存在返回 undefined', () => {
    expect(store.get(FlatSchema, ULID_B)).toBeUndefined();
  });

  it('upsert 二次写：version 自增 + updatedAt 推进 + createdAt 保留', () => {
    store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    clock.now = T2;
    const r2 = store.put(FlatSchema, { id: ULID_A, key: 'a', value: 2 });
    expect(r2.version).toBe(2);
    expect(r2.createdAt).toBe(T1);
    expect(r2.updatedAt).toBe(T2);
    expect(r2.value).toBe(2);
  });
});

describe('FsCrudStore P4 ifVersion 乐观锁', () => {
  it('ifVersion 匹配 → 写入 + version+1', () => {
    store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    clock.now = T2;
    const r2 = store.put(FlatSchema, { id: ULID_A, key: 'a', value: 2 }, {
      mode: 'upsert',
      ifVersion: 1,
    });
    expect(r2.version).toBe(2);
  });

  it('ifVersion 不匹配 → VersionConflictError{expected,actual}', () => {
    store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    try {
      store.put(FlatSchema, { id: ULID_A, key: 'a', value: 2 }, { ifVersion: 99 });
      throw new Error('unreachable');
    } catch (e) {
      expect(e).toBeInstanceOf(VersionConflictError);
      const v = e as VersionConflictError;
      expect(v.expected).toBe(99);
      expect(v.actual).toBe(1);
    }
  });
});

describe('FsCrudStore P5 mode', () => {
  it('insert 已存在 → RecordExistsError', () => {
    store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    expect(() =>
      store.put(FlatSchema, { id: ULID_A, key: 'a', value: 2 }, { mode: 'insert' }),
    ).toThrow(RecordExistsError);
  });

  it('insert 首次 → 成功', () => {
    const r = store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 }, { mode: 'insert' });
    expect(r.version).toBe(1);
  });

  it('replace 重置时间 + version+1', () => {
    store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    clock.now = T2;
    const r2 = store.put(FlatSchema, { id: ULID_A, key: 'a', value: 2 }, { mode: 'replace' });
    expect(r2.version).toBe(2);
    expect(r2.createdAt).toBe(T2);
    expect(r2.updatedAt).toBe(T2);
  });

  it('replace 不存在 → RecordNotFoundError', () => {
    expect(() =>
      store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 }, { mode: 'replace' }),
    ).toThrow(RecordNotFoundError);
  });
});

describe('FsCrudStore delete/query', () => {
  it('delete 实际删除返回 true，再次删除返回 false', () => {
    store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    expect(store.delete(FlatSchema, ULID_A)).toBe(true);
    expect(store.delete(FlatSchema, ULID_A)).toBe(false);
    expect(store.get(FlatSchema, ULID_A)).toBeUndefined();
  });

  it('query 按 createdAtDesc 默认排序 + limit 截断', () => {
    store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    clock.now = T2;
    store.put(FlatSchema, { id: ULID_B, key: 'b', value: 2 });
    const all = store.query(FlatSchema, {});
    expect(all.map((r) => r.id)).toEqual([ULID_B, ULID_A]);

    const one = store.query(FlatSchema, { limit: 1 });
    expect(one.length).toBe(1);
    expect(one[0]!.id).toBe(ULID_B);
  });

  it('query createdAfter/createdBefore 过滤 + createdAtAsc', () => {
    store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    clock.now = T2;
    store.put(FlatSchema, { id: ULID_B, key: 'b', value: 2 });
    const after = store.query(FlatSchema, { createdAfter: T1, order: 'createdAtAsc' });
    expect(after.map((r) => r.id)).toEqual([ULID_B]);
    const before = store.query(FlatSchema, { createdBefore: T2 });
    expect(before.map((r) => r.id)).toEqual([ULID_A]);
  });

  it('query ids 过滤', () => {
    store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    clock.now = T2;
    store.put(FlatSchema, { id: ULID_B, key: 'b', value: 2 });
    const r = store.query(FlatSchema, { ids: [ULID_A] });
    expect(r.map((x) => x.id)).toEqual([ULID_A]);
  });
});

describe('FsCrudStore §3.6 原子写', () => {
  it('put 后无 .tmp 残留', async () => {
    store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    store.put(FlatSchema, { id: ULID_B, key: 'b', value: 2 });
    expect(await listTmpFiles(tmpRoot)).toEqual([]);
  });

  it('delete 后无 .tmp 残留', async () => {
    store.put(FlatSchema, { id: ULID_A, key: 'a', value: 1 });
    store.delete(FlatSchema, ULID_A);
    expect(await listTmpFiles(tmpRoot)).toEqual([]);
  });
});
