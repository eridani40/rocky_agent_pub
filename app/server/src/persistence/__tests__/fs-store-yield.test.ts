/**
 * putAsync/deleteAsync yield 集成测试
 * 参考: specs/tech/version_logs/v0.0.291/change_plan.md
 *
 * 覆盖：deleteAsync/putAsync 60 次循环让出被触发 / 返回值语义零变 / FIFO 不变
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FsCrudStore } from '../fs-store';
import { resetFsYield } from '../fs-yield';
import type { SchemaDef } from '../schema-types';

// 扁平 json schema
const FlatSchema = {
  entity: 'app_config',
  engine: 'file',
  fields: {
    id: { type: 'ulid', required: true },
    key: { type: 'string', required: true },
    value: { type: 'json', required: true },
  },
} as const satisfies SchemaDef;

let tmpRoot: string;
let store: FsCrudStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-yield-int-'));
  store = new FsCrudStore({ root: tmpRoot });
  resetFsYield();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 生成 26 字符合法 ULID（Crockford base32） */
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

describe('deleteAsync — yield 被触发', () => {
  it('60 次循环 deleteAsync → setImmediate 被调 ≥1 次（让出）', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const id = ulid('01KVYD', i);
      ids.push(id);
      store.put(FlatSchema, { id, key: `k${i}`, value: i });
    }
    const spy = vi.spyOn(globalThis, 'setImmediate');
    for (const id of ids) await store.deleteAsync(FlatSchema, id);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('返回值语义零变：存在 → true，不存在 → false', async () => {
    const id = ulid('01KVD', 0);
    store.put(FlatSchema, { id, key: 'a', value: 1 });
    expect(await store.deleteAsync(FlatSchema, id)).toBe(true);
    expect(await store.deleteAsync(FlatSchema, id)).toBe(false);
  });
});

describe('putAsync — yield 被触发', () => {
  it('60 次循环 putAsync → setImmediate 被调 ≥1 次（让出）', async () => {
    const spy = vi.spyOn(globalThis, 'setImmediate');
    for (let i = 0; i < 60; i++) {
      await store.putAsync(FlatSchema, { id: ulid('01KVYPT', i), key: `k${i}`, value: i });
    }
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('返回值语义零变：version 自增、data 落盘正确', async () => {
    const id = ulid('01KVP', 0);
    const r1 = await store.putAsync(FlatSchema, { id, key: 'a', value: 1 });
    expect(r1.version).toBe(1);
    const r2 = await store.putAsync(FlatSchema, { id, key: 'a', value: 2 });
    expect(r2.version).toBe(2);
    expect(store.get(FlatSchema, id)?.value).toBe(2);
  });
});

describe('yield 在 withFileLock fn 内 — FIFO 不交叉', () => {
  it('同 path 并发 deleteAsync → 一个 true 一个 false（串行不交叉）', async () => {
    const id = ulid('01KVF', 0);
    store.put(FlatSchema, { id, key: 'a', value: 1 });
    const [r1, r2] = await Promise.all([
      store.deleteAsync(FlatSchema, id),
      store.deleteAsync(FlatSchema, id),
    ]);
    expect([r1, r2].sort()).toEqual([false, true]);
    expect(store.get(FlatSchema, id)).toBeUndefined();
  });

  it('同 path 并发 putAsync → 串行无丢更新（version 正确自增）', async () => {
    const id = ulid('01KVC', 0);
    const [r1, r2] = await Promise.all([
      store.putAsync(FlatSchema, { id, key: 'a', value: 1 }),
      store.putAsync(FlatSchema, { id, key: 'a', value: 2 }),
    ]);
    expect(r1.version).toBe(1);
    expect(r2.version).toBe(2);
    expect(store.get(FlatSchema, id)?.value).toBe(2);
  });
});
