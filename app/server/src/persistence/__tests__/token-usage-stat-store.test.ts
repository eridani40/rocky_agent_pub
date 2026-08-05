/**
 * TokenUsageStatStore 单元测试 — upsertDelta 4 维度唯一累加
 * 参考: specs/tech/persistence/[P1]token_usage_stat.md §2.5（唯一约定）+ §4（写入路径）
 *       states/v0.0.194/verify/test-plan.md T1 UT 范围
 *
 * 覆盖：
 *   - 首见：生成新行 + delta 作初始值
 *   - 同维度二次 upsert：复用 id + per-field Σ 累加
 *   - 不同维度（hour/providerId/modelId）：各自独立行
 *   - (sessionId,hour,providerId,modelId) 唯一约定验证
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createCrudSqlDriver } from '../crud-sqlite-driver-factory';
import { TokenUsageStatStore, type TokenUsageDimension } from '../token-usage-stat-store';
import { TokenUsageStatSchema } from '../../agent/schema_defs';

// 合法 ULID（26 字符 Crockford base32）
const SQUAD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MEMBER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const SESSION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const PROVIDER_A = 'prov-a';
const PROVIDER_B = 'prov-b';
const MODEL_A = 'model-a';
const MODEL_B = 'model-b';

async function newStore(): Promise<TokenUsageStatStore> {
  const { store } = await createCrudSqlDriver(':memory:');
  return new TokenUsageStatStore(store);
}

function makeDim(overrides: Partial<TokenUsageDimension> = {}): TokenUsageDimension {
  return {
    squadId: SQUAD_ID,
    memberId: MEMBER_ID,
    sessionId: SESSION_ID,
    hour: '2026-07-23 14',
    providerId: PROVIDER_A,
    modelId: MODEL_A,
    ...overrides,
  };
}

describe('TokenUsageStatStore — upsertDelta', () => {
  let statStore: TokenUsageStatStore;
  beforeEach(async () => {
    statStore = await newStore();
  });

  it('首见：生成新行 + delta 作初始值', async () => {
    const dim = makeDim();
    await statStore.upsertDelta(dim, {
      input_no_cache: 100, cache_read: 50, output_response: 200, cost: 0.01, llmCallCount: 1,
    });
    // 直接用 SqliteCrudStore 查回验证
    const { store } = await createCrudSqlDriver(':memory:');
    // 用新 store 重跑（beforeEach 已建，直接查 crud）
    // 注：statStore 内部 crud 持有 sqlite 实例，通过 queryByJsonExtract 验证
    const ext = statStore as unknown as {
      crud: {
        queryByJsonExtract: (schema: unknown, field: string, value: unknown) => Array<Record<string, unknown>>;
      };
    };
    const rows = ext.crud.queryByJsonExtract(TokenUsageStatSchema, 'sessionId', SESSION_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input_no_cache).toBe(100);
    expect(rows[0]!.cache_read).toBe(50);
    expect(rows[0]!.output_response).toBe(200);
    expect(rows[0]!.cost).toBe(0.01);
    expect(rows[0]!.llmCallCount).toBe(1);
    expect(rows[0]!.hour).toBe('2026-07-23 14');
    expect(rows[0]!.providerId).toBe(PROVIDER_A);
    expect(rows[0]!.modelId).toBe(MODEL_A);
    // undefined 字段 → 0
    expect(rows[0]!.cache_creation).toBe(0);
    expect(rows[0]!.output_reasoning).toBe(0);
    void store; // avoid unused
    store.close();
  });

  it('同维度二次 upsert：复用 id + per-field Σ 累加', async () => {
    const dim = makeDim();
    await statStore.upsertDelta(dim, {
      input_no_cache: 100, cache_read: 50, output_response: 200, cost: 0.01, llmCallCount: 1,
    });
    await statStore.upsertDelta(dim, {
      input_no_cache: 30, cache_read: 20, output_response: 80, cost: 0.005, llmCallCount: 1,
    });

    const ext = statStore as unknown as {
      crud: {
        queryByJsonExtract: (schema: unknown, field: string, value: unknown) => Array<Record<string, unknown>>;
      };
    };
    const rows = ext.crud.queryByJsonExtract(TokenUsageStatSchema, 'sessionId', SESSION_ID);
    expect(rows).toHaveLength(1); // 同维度 → 同一行
    expect(rows[0]!.input_no_cache).toBe(130);
    expect(rows[0]!.cache_read).toBe(70);
    expect(rows[0]!.output_response).toBe(280);
    expect(rows[0]!.cost).toBeCloseTo(0.015);
    expect(rows[0]!.llmCallCount).toBe(2);
  });

  it('不同 hour → 各自独立行', async () => {
    await statStore.upsertDelta(makeDim({ hour: '2026-07-23 14' }), { input_no_cache: 100, llmCallCount: 1 });
    await statStore.upsertDelta(makeDim({ hour: '2026-07-23 15' }), { input_no_cache: 200, llmCallCount: 1 });

    const ext = statStore as unknown as {
      crud: {
        queryByJsonExtract: (schema: unknown, field: string, value: unknown) => Array<Record<string, unknown>>;
      };
    };
    const rows = ext.crud.queryByJsonExtract(TokenUsageStatSchema, 'sessionId', SESSION_ID);
    expect(rows).toHaveLength(2);
    const byHour = rows.sort((a, b) => (a.hour as string).localeCompare(b.hour as string));
    expect(byHour[0]!.hour).toBe('2026-07-23 14');
    expect(byHour[0]!.input_no_cache).toBe(100);
    expect(byHour[1]!.hour).toBe('2026-07-23 15');
    expect(byHour[1]!.input_no_cache).toBe(200);
  });

  it('不同 providerId+modelId → 各自独立行', async () => {
    await statStore.upsertDelta(makeDim({ providerId: PROVIDER_A, modelId: MODEL_A }), { input_no_cache: 100, llmCallCount: 1 });
    await statStore.upsertDelta(makeDim({ providerId: PROVIDER_B, modelId: MODEL_B }), { input_no_cache: 200, llmCallCount: 1 });

    const ext = statStore as unknown as {
      crud: {
        queryByJsonExtract: (schema: unknown, field: string, value: unknown) => Array<Record<string, unknown>>;
      };
    };
    const rows = ext.crud.queryByJsonExtract(TokenUsageStatSchema, 'sessionId', SESSION_ID);
    expect(rows).toHaveLength(2);
  });

  it('delta undefined 字段视为 0（不累加）', async () => {
    const dim = makeDim();
    await statStore.upsertDelta(dim, { input_no_cache: 100 });
    await statStore.upsertDelta(dim, { input_no_cache: 50, cache_read: 30 });

    const ext = statStore as unknown as {
      crud: {
        queryByJsonExtract: (schema: unknown, field: string, value: unknown) => Array<Record<string, unknown>>;
      };
    };
    const rows = ext.crud.queryByJsonExtract(TokenUsageStatSchema, 'sessionId', SESSION_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.input_no_cache).toBe(150);
    expect(rows[0]!.cache_read).toBe(30); // 第一次 undefined=0 + 第二次 30
  });
});
