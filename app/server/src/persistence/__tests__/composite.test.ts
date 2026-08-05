/**
 * CompositeStore 集成测试 — 按 entity 路由 + 未挂载报错 + transcript 分片
 * 参考: specs/tech/persistence/[P0]crud_store_interface.md §3.4 + §4
 *       states/v0.0.2/verify/test-plan.md §3 CompositeStore 维度（P2/P3）
 *
 * 覆盖（acceptance criteria）：
 *   P3 路由：mount(entity, engine) 后 put/get/query/delete 按 schema.entity 正确落到对应 engine
 *   P3 未挂载：路由到未 mount 的 entity → EntityNotMountedError
 *   P2 分片：transcript（fs 分片 jsonl）经 CompositeStore 写/读/查按 sessionId shardKey
 *
 * 真实落盘：fs 用 tmp DATA_DIR（os.tmpdir + mkdtemp），sqlite 用 :memory:。
 * afterEach 清理 tmp 目录（spec 文件系统隔离）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../composite';
import { FsCrudStore } from '../fs-store';
import { SqliteCrudStore } from '../sqlite-store';
import { createCrudSqlDriver } from '../crud-sqlite-driver-factory';
import { EntityNotMountedError } from '../errors';
import { MessageSchema } from '../../agent/schema_defs/message';
import type { MessageRecord } from '../../agent/schema_defs/message';
import {
  ModelConfigFsSchema,
  ModelConfigSqliteSchema,
} from '../schema_defs/model_config';
import type { ModelConfigRecord } from '../schema_defs';

// 合法 ULID（26 字符 Crockford base32）
const MSG_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SESSION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const CFG_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-composite-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造一个 mount 好的 CompositeStore：transcript→fs、model_config_fs→fs、model_config_sqlite→sqlite
 * SqliteCrudStore 走 createCrudSqlDriver 工厂（接收 SqlDriver 注入）
 */
async function newMountedStore(): Promise<{ store: CompositeStore; sqlite: SqliteCrudStore }> {
  const fs = new FsCrudStore({ root: tmpRoot });
  const { store: sqlite } = await createCrudSqlDriver(':memory:');
  const store = new CompositeStore()
    .mount('transcript', fs)
    .mount('model_config_fs', fs)
    .mount('model_config_sqlite', sqlite);
  return { store, sqlite };
}

describe('CompositeStore — 按 entity 路由（P3）', () => {
  it('put 按 schema.entity 路由：transcript→fs、model_config_sqlite→sqlite', async () => {
    const { store, sqlite } = await newMountedStore();

    const msg: MessageRecord = {
      id: MSG_ID,
      sessionId: SESSION_ID,
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    };
    const storedMsg = store.put(MessageSchema, msg);
    expect(storedMsg.version).toBe(1);
    // fs 分片落盘：sessions/<sessionId>/transcript/...

    const cfg: ModelConfigRecord = {
      id: CFG_ID,
      key: 'model',
      value: { name: 'gpt-4' },
    };
    const storedCfg = store.put(ModelConfigSqliteSchema, cfg);
    expect(storedCfg.version).toBe(1);

    // 白盒：sqlite 表里应有 model_config_sqlite 的行
    const rawRow = sqlite.readRawRow('model_config_sqlite', CFG_ID);
    expect(rawRow).toBeDefined();
    expect(rawRow!.version).toBe(1);
  });

  it('get 按 schema.entity 路由读回（含信封一致）', async () => {
    const { store } = await newMountedStore();
    const cfg: ModelConfigRecord = {
      id: CFG_ID,
      key: 'model',
      value: { name: 'gpt-4' },
    };
    store.put(ModelConfigSqliteSchema, cfg);

    const got = store.get(ModelConfigSqliteSchema, CFG_ID);
    expect(got).toBeDefined();
    expect(got!.key).toBe('model');
    expect(got!.value).toEqual({ name: 'gpt-4' });
    expect(got!.version).toBe(1);
  });

  it('delete 按 schema.entity 路由删除（返回 true，删后再 get 为 undefined）', async () => {
    const { store } = await newMountedStore();
    const cfg: ModelConfigRecord = {
      id: CFG_ID,
      key: 'model',
      value: 42,
    };
    store.put(ModelConfigFsSchema, cfg);

    expect(store.delete(ModelConfigFsSchema, CFG_ID)).toBe(true);
    expect(store.get(ModelConfigFsSchema, CFG_ID)).toBeUndefined();
    // 再删一次返回 false
    expect(store.delete(ModelConfigFsSchema, CFG_ID)).toBe(false);
  });

  it('query 按 schema.entity 路由查询', async () => {
    const { store } = await newMountedStore();
    const cfg1: ModelConfigRecord = { id: CFG_ID, key: 'k1', value: 1 };
    const cfg2: ModelConfigRecord = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAA',
      key: 'k2',
      value: 2,
    };
    store.put(ModelConfigSqliteSchema, cfg1);
    store.put(ModelConfigSqliteSchema, cfg2);

    const list = store.query(ModelConfigSqliteSchema, {
      ids: [CFG_ID],
    });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(CFG_ID);
  });
});

describe('CompositeStore — 未挂载 entity（P3）', () => {
  it('put 未挂载 entity → EntityNotMountedError（含 entity 名）', () => {
    const store = new CompositeStore(); // 空 mount
    const cfg: ModelConfigRecord = { id: CFG_ID, key: 'k', value: 1 };
    expect(() => store.put(ModelConfigSqliteSchema, cfg)).toThrowError(
      EntityNotMountedError,
    );
    try {
      store.put(ModelConfigSqliteSchema, cfg);
    } catch (e) {
      expect((e as EntityNotMountedError).entity).toBe('model_config_sqlite');
    }
  });

  it('get / delete / query 未挂载 entity 均抛 EntityNotMountedError', () => {
    const store = new CompositeStore();
    expect(() => store.get(ModelConfigSqliteSchema, CFG_ID)).toThrowError(
      EntityNotMountedError,
    );
    expect(() => store.delete(ModelConfigSqliteSchema, CFG_ID)).toThrowError(
      EntityNotMountedError,
    );
    expect(() => store.query(ModelConfigSqliteSchema, {})).toThrowError(
      EntityNotMountedError,
    );
  });
});

describe('CompositeStore — transcript 分片 jsonl（P2）', () => {
  it('put 落到按 sessionId 分片的 fs 目录；get 必须带 shardKey 读回', async () => {
    const { store } = await newMountedStore();
    const msg: MessageRecord = {
      id: MSG_ID,
      sessionId: SESSION_ID,
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    };
    const stored = store.put(MessageSchema, msg);
    expect(stored.version).toBe(1);

    // 带 shardKey 读回
    const got = store.get(MessageSchema, MSG_ID, SESSION_ID);
    expect(got).toBeDefined();
    expect(got!.role).toBe('assistant');
    expect(got!.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('query 按 sessionId shardKey 返回该 session 的消息（按 createdAt desc）', async () => {
    const { store } = await newMountedStore();
    // 写 3 条同 session 消息
    const ids = [
      '01ARZ3NDEKTSV4RRFFQ69G5FAA',
      '01ARZ3NDEKTSV4RRFFQ69G5FAB',
      '01ARZ3NDEKTSV4RRFFQ69G5FAC',
    ];
    for (const id of ids) {
      store.put(MessageSchema, {
        id,
        sessionId: SESSION_ID,
        role: 'user' as const,
        content: { seq: id },
      });
    }

    const list = store.query(MessageSchema, {
      shardKey: SESSION_ID,
      order: 'createdAtDesc',
      limit: 2,
    });
    expect(list).toHaveLength(2);
    // 所有返回项都属于该 session
    for (const r of list) {
      expect(r.sessionId).toBe(SESSION_ID);
    }
  });
});
