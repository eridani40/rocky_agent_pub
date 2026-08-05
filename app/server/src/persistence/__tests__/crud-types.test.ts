/**
 * CrudStore 契约层 — 类型契约单测（编译期校验）
 * 参考: specs/tech/persistence/[P0]crud_store_interface.md §2.1-§2.3
 *       states/v0.0.2/verify/test-plan.md §3 CrudStore 契约维度
 *
 * 覆盖：
 *   - StoredRecord<S> = InferRecord<S> & RecordMeta（含信封三字段）
 *   - PutOptions（mode / ifVersion）
 *   - QueryFilter（shardKey/ids/createdAfter/Before/limit/order）
 *   - CrudStore 接口四方法（put/get/query/delete）签名兼容性
 *
 * 这些是「类型层」测试（expectTypeOf / 断言字面量），不跑运行时逻辑。
 * 运行时纯逻辑测试见 envelope.test.ts。
 */
import { describe, it, expectTypeOf } from 'vitest';
import type {
  SchemaDef,
} from '../schema-types';
import type {
  RecordMeta,
  StoredRecord,
  PutOptions,
  PutMode,
  QueryFilter,
  QueryOrder,
  CrudStore,
} from '../crud-types';

// ============================================================
// 实验用 schema（与 spec §4 transcript 风格一致）
// ============================================================
const TranscriptSchema = {
  entity: 'transcript',
  engine: 'file',
  fs: {
    sharding: { shardKeyField: 'sessionId', dirTemplate: 'sessions/{shardKey}/' },
    format: 'jsonl',
    jsonlMaxCount: 1000,
  },
  fields: {
    id: { type: 'ulid', required: true },
    sessionId: { type: 'ulid', required: true },
    role: { type: 'enum', required: true, enumValues: ['user', 'assistant', 'tool'] },
    content: { type: 'json', required: true },
  },
} as const satisfies SchemaDef;

type TranscriptRecord = StoredRecord<typeof TranscriptSchema>;

// ============================================================
// StoredRecord 含信封三字段
// ============================================================
describe('StoredRecord<S> 类型契约', () => {
  it('含实体字段 + 信封三字段（createdAt/updatedAt/version）', () => {
    expectTypeOf<TranscriptRecord>().toMatchTypeOf<{
      id: string;
      sessionId: string;
      role: 'user' | 'assistant' | 'tool';
      content: unknown;
      createdAt: string;
      updatedAt: string;
      version: number;
    }>();
  });

  it('RecordMeta 字段类型精确', () => {
    expectTypeOf<RecordMeta['createdAt']>().toEqualTypeOf<string>();
    expectTypeOf<RecordMeta['updatedAt']>().toEqualTypeOf<string>();
    expectTypeOf<RecordMeta['version']>().toEqualTypeOf<number>();
  });
});

// ============================================================
// PutOptions / QueryFilter 字段
// ============================================================
describe('PutOptions / QueryFilter 类型契约', () => {
  it('PutMode 三值', () => {
    expectTypeOf<PutMode>().toEqualTypeOf<'insert' | 'replace' | 'upsert'>();
  });

  it('PutOptions 可空（缺省 upsert 语义）', () => {
    const opts: PutOptions = {};
    expectTypeOf(opts).toMatchTypeOf<{ mode?: PutMode; ifVersion?: number }>();
  });

  it('QueryOrder 两值', () => {
    expectTypeOf<QueryOrder>().toEqualTypeOf<'createdAtAsc' | 'createdAtDesc'>();
  });

  it('QueryFilter 所有字段可选', () => {
    const empty: QueryFilter = {};
    expectTypeOf(empty).toMatchTypeOf<{
      shardKey?: string;
      ids?: string[];
      createdAfter?: string;
      createdBefore?: string;
      limit?: number;
      order?: QueryOrder;
    }>();
  });
});

// ============================================================
// CrudStore 接口四方法签名
// ============================================================
describe('CrudStore 接口签名', () => {
  it('CrudStore 是带四方法的对象类型', () => {
    // 接口存在四方法（运行时 mock 由 T3+ engine 提供真实实现，此处只验类型）
    const mock: CrudStore = {
      put: (() => ({} as never)) as CrudStore['put'],
      get: (() => undefined) as CrudStore['get'],
      delete: (() => false) as CrudStore['delete'],
      query: (() => []) as CrudStore['query'],
    };
    expectTypeOf<typeof mock.put>().toBeFunction();
    expectTypeOf<typeof mock.get>().toBeFunction();
    expectTypeOf<typeof mock.delete>().toBeFunction();
    expectTypeOf<typeof mock.query>().toBeFunction();
  });

  it('CrudStore.delete 返回 boolean', () => {
    expectTypeOf<CrudStore['delete']>().returns.toEqualTypeOf<boolean>();
  });

  it('CrudStore.get 类型签名允许返回 undefined（未找到语义）', () => {
    // 通过 mock 实现 get 返回 undefined，类型必须兼容（接口允许返回 undefined 分支）
    const mock: CrudStore = {
      put: (() => ({} as never)) as CrudStore['put'],
      get: (() => undefined) as CrudStore['get'],
      delete: (() => false) as CrudStore['delete'],
      query: (() => []) as CrudStore['query'],
    };
    // 调用 get 在 TS 层不报错（接口签名允许 undefined）
    const _ret: TranscriptRecord | undefined = mock.get(TranscriptSchema, 'id-x');
    expectTypeOf<typeof _ret>().toMatchTypeOf<TranscriptRecord | undefined>();
  });
});
