/**
 * TokenUsageAggregator 单元测试 — GROUP BY SUM + cacheRate + total 派生
 * 参考: specs/tech/persistence/[P1]token_usage_stat.md §5（查询路径 + 口径）
 *       specs/api/overall/11c-token-stats.md §4（口径：团队=Σ member / cacheRate / total）
 *       states/v0.0.194/verify/test-plan.md T1 UT 范围
 *
 * 覆盖：
 *   - scope=team：WHERE squadId，Σ 全 member
 *   - scope=memberId：AND memberId 过滤
 *   - granularity=day：GROUP BY substr(hour,1,10)
 *   - granularity=hour：GROUP BY hour
 *   - model 筛选：AND providerId+modelId
 *   - cacheRate = cache_read / (cache_read + input_no_cache)，分母 ≤0 返 0
 *   - total = input+output 各细分和（派生）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createCrudSqlDriver } from '../../../persistence/crud-sqlite-driver-factory';
import { TokenUsageStatStore } from '../../../persistence/token-usage-stat-store';
import { TokenUsageAggregator } from '../token-usage-aggregator';

const SQUAD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MEMBER_1 = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const MEMBER_2 = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const SESSION_1 = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
const SESSION_2 = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
const PROVIDER_A = 'prov-a';
const MODEL_A = 'model-a';
const MODEL_B = 'model-b';

async function newFixture() {
  const { store: crud, driver } = await createCrudSqlDriver(':memory:');
  const statStore = new TokenUsageStatStore(crud);
  const aggregator = new TokenUsageAggregator(driver);
  return { statStore, aggregator };
}

describe('TokenUsageAggregator — GROUP BY SUM', () => {
  let statStore: TokenUsageStatStore;
  let aggregator: TokenUsageAggregator;

  beforeEach(async () => {
    const fx = await newFixture();
    statStore = fx.statStore;
    aggregator = fx.aggregator;

    // seed：2 member × 多 hour × 多 model
    // member1: 2026-07-23 14h model-a {input:100, cache_read:50, output:200}
    // member1: 2026-07-23 14h model-b {input:30, output:60}
    // member1: 2026-07-23 15h model-a {input:80, cache_read:40, output:160}
    // member2: 2026-07-23 14h model-a {input:70, cache_read:30, output:140}
    // member2: 2026-07-24 10h model-a {input:200, output:400}
    await statStore.upsertDelta(
      { squadId: SQUAD_ID, memberId: MEMBER_1, sessionId: SESSION_1, hour: '2026-07-23 14', providerId: PROVIDER_A, modelId: MODEL_A },
      { input_no_cache: 100, cache_read: 50, cache_creation: 10, output_response: 200, output_reasoning: 5, cost: 0.01, llmCallCount: 1 },
    );
    await statStore.upsertDelta(
      { squadId: SQUAD_ID, memberId: MEMBER_1, sessionId: SESSION_1, hour: '2026-07-23 14', providerId: PROVIDER_A, modelId: MODEL_B },
      { input_no_cache: 30, output_response: 60, llmCallCount: 1 },
    );
    await statStore.upsertDelta(
      { squadId: SQUAD_ID, memberId: MEMBER_1, sessionId: SESSION_1, hour: '2026-07-23 15', providerId: PROVIDER_A, modelId: MODEL_A },
      { input_no_cache: 80, cache_read: 40, output_response: 160, llmCallCount: 1 },
    );
    await statStore.upsertDelta(
      { squadId: SQUAD_ID, memberId: MEMBER_2, sessionId: SESSION_2, hour: '2026-07-23 14', providerId: PROVIDER_A, modelId: MODEL_A },
      { input_no_cache: 70, cache_read: 30, output_response: 140, llmCallCount: 1 },
    );
    await statStore.upsertDelta(
      { squadId: SQUAD_ID, memberId: MEMBER_2, sessionId: SESSION_2, hour: '2026-07-24 10', providerId: PROVIDER_A, modelId: MODEL_A },
      { input_no_cache: 200, output_response: 400, llmCallCount: 1 },
    );
  });

  it('scope=team granularity=day：Σ 全 member，GROUP BY date', () => {
    const result = aggregator.query(SQUAD_ID, {
      from: '2026-07-23', to: '2026-07-24', scope: 'team', granularity: 'day',
    });
    expect(result.scope).toBe('team');
    expect(result.granularity).toBe('day');
    expect(result.series).toHaveLength(2); // 2026-07-23 + 2026-07-24

    const d23 = result.series.find(s => s.bucket === '2026-07-23')!;
    expect(d23).toBeDefined();
    // 23号 Σ 全 member 全 model: input=100+30+80+70=280, cache_read=50+40+30=120, output=200+60+160+140=560
    expect(d23.input_no_cache).toBe(280);
    expect(d23.cache_read).toBe(120);
    expect(d23.cache_creation).toBe(10);
    expect(d23.output_response).toBe(560);
    expect(d23.output_reasoning).toBe(5);
    expect(d23.llmCallCount).toBe(4);
    // total = 280 + 120 + 10 + 560 + 5 = 975
    expect(d23.total).toBe(975);
    // cacheRate = 120 / (120 + 280) = 0.3
    expect(d23.cacheRate).toBeCloseTo(0.3, 5);

    const d24 = result.series.find(s => s.bucket === '2026-07-24')!;
    expect(d24.input_no_cache).toBe(200);
    expect(d24.cache_read).toBe(0);
    // 分母 ≤ 0 → cacheRate = 0
    expect(d24.cacheRate).toBe(0);
  });

  it('scope=memberId：AND memberId 过滤（只含 member1 数据）', () => {
    const result = aggregator.query(SQUAD_ID, {
      from: '2026-07-23', to: '2026-07-23', scope: MEMBER_1, granularity: 'day',
    });
    expect(result.scope).toBe(MEMBER_1);
    expect(result.series).toHaveLength(1);
    const d = result.series[0]!;
    // member1 23号: input=100+30+80=210, cache_read=50+40=90, output=200+60+160=420
    expect(d.input_no_cache).toBe(210);
    expect(d.cache_read).toBe(90);
    expect(d.output_response).toBe(420);
  });

  it('granularity=hour：GROUP BY hour + 补零成固定 24 点位（0~23 点）', () => {
    const result = aggregator.query(SQUAD_ID, {
      from: '2026-07-23', to: '2026-07-23', scope: 'team', granularity: 'hour',
    });
    // 单日 → 固定 24 个小时桶（0~23 点），无数据的点位补 0
    expect(result.series).toHaveLength(24);
    expect(result.series[0]!.bucket).toBe('2026-07-23 00');
    expect(result.series[23]!.bucket).toBe('2026-07-23 23');
    const h14 = result.series.find(s => s.bucket === '2026-07-23 14')!;
    const h15 = result.series.find(s => s.bucket === '2026-07-23 15')!;
    expect(h14).toBeDefined();
    expect(h15).toBeDefined();
    // 14h: member1(100+50+200) + member1-model-b(30+60) + member2(70+30+140) = 200+90+200
    expect(h14.input_no_cache).toBe(200); // 100+30+70
    expect(h14.cache_read).toBe(80); // 50+30
    // 15h: member1 only
    expect(h15.input_no_cache).toBe(80);
    expect(h15.cache_read).toBe(40);
    // 无数据点位补 0（如 03 点）
    const h03 = result.series.find(s => s.bucket === '2026-07-23 03')!;
    expect(h03.total).toBe(0);
    expect(h03.input_no_cache).toBe(0);
    expect(h03.cacheRate).toBe(0);
    expect(h03.llmCallCount).toBe(0);
  });

  it('granularity=hour 多日范围：每天各补零 24 点位', () => {
    const result = aggregator.query(SQUAD_ID, {
      from: '2026-07-23', to: '2026-07-24', scope: 'team', granularity: 'hour',
    });
    // 2 天 × 24 点位
    expect(result.series).toHaveLength(48);
    expect(result.series[0]!.bucket).toBe('2026-07-23 00');
    expect(result.series[24]!.bucket).toBe('2026-07-24 00');
    // 24 号 10h 有数据（member2），其余补 0
    const d24h10 = result.series.find(s => s.bucket === '2026-07-24 10')!;
    expect(d24h10.input_no_cache).toBe(200);
    const d24h11 = result.series.find(s => s.bucket === '2026-07-24 11')!;
    expect(d24h11.total).toBe(0);
  });

  it('granularity=hour 无 from/to：不补零（范围无界无法生成序列）', () => {
    const result = aggregator.query(SQUAD_ID, { scope: 'team', granularity: 'hour' });
    // 只有有数据的桶（23 14h / 23 15h / 24 10h）
    expect(result.series).toHaveLength(3);
  });

  it('model 筛选：AND providerId+modelId（只含 model-a 数据）', () => {
    const result = aggregator.query(SQUAD_ID, {
      from: '2026-07-23', to: '2026-07-23', scope: 'team',
      granularity: 'day', providerId: PROVIDER_A, modelId: MODEL_A,
    });
    expect(result.providerId).toBe(PROVIDER_A);
    expect(result.modelId).toBe(MODEL_A);
    // model-a 23号: input=100+80+70=250（排除 model-b 的 30）
    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.input_no_cache).toBe(250);
    expect(result.series[0]!.output_response).toBe(500); // 200+160+140
  });

  it('from/to 范围过滤：只返回范围内的桶', () => {
    const result = aggregator.query(SQUAD_ID, {
      from: '2026-07-24', to: '2026-07-24', scope: 'team', granularity: 'day',
    });
    expect(result.series).toHaveLength(1);
    expect(result.series[0]!.bucket).toBe('2026-07-24');
    expect(result.series[0]!.input_no_cache).toBe(200);
  });

  it('空数据：返空 series', () => {
    const result = aggregator.query('01ARZ3NDEKTSV4RRFFQ69G5FAZ', {
      from: '2026-07-23', to: '2026-07-23', scope: 'team', granularity: 'day',
    });
    expect(result.series).toHaveLength(0);
  });

  it('bucket 按 ASC 排序', () => {
    const result = aggregator.query(SQUAD_ID, {
      from: '2026-07-23', to: '2026-07-24', scope: 'team', granularity: 'day',
    });
    expect(result.series.map(s => s.bucket)).toEqual(['2026-07-23', '2026-07-24']);
  });
});

describe('TokenUsageAggregator.queryDistinctModels —— distinct model 列表（v0.0.194 补全）', () => {
  let statStore: TokenUsageStatStore;
  let aggregator: TokenUsageAggregator;

  beforeEach(async () => {
    const fx = await newFixture();
    statStore = fx.statStore;
    aggregator = fx.aggregator;

    // seed：2 member × 多 hour × 多 model
    // member1: 2026-07-23 14h model-a / model-b
    // member1: 2026-07-23 15h model-a
    // member2: 2026-07-23 14h model-a
    // member2: 2026-07-24 10h model-a
    await statStore.upsertDelta(
      { squadId: SQUAD_ID, memberId: MEMBER_1, sessionId: SESSION_1, hour: '2026-07-23 14', providerId: PROVIDER_A, modelId: MODEL_A },
      { input_no_cache: 100, cache_read: 50, output_response: 200, llmCallCount: 1 },
    );
    await statStore.upsertDelta(
      { squadId: SQUAD_ID, memberId: MEMBER_1, sessionId: SESSION_1, hour: '2026-07-23 14', providerId: PROVIDER_A, modelId: MODEL_B },
      { input_no_cache: 30, output_response: 60, llmCallCount: 1 },
    );
    await statStore.upsertDelta(
      { squadId: SQUAD_ID, memberId: MEMBER_1, sessionId: SESSION_1, hour: '2026-07-23 15', providerId: PROVIDER_A, modelId: MODEL_A },
      { input_no_cache: 80, output_response: 160, llmCallCount: 1 },
    );
    await statStore.upsertDelta(
      { squadId: SQUAD_ID, memberId: MEMBER_2, sessionId: SESSION_2, hour: '2026-07-23 14', providerId: PROVIDER_A, modelId: MODEL_A },
      { input_no_cache: 70, output_response: 140, llmCallCount: 1 },
    );
    await statStore.upsertDelta(
      { squadId: SQUAD_ID, memberId: MEMBER_2, sessionId: SESSION_2, hour: '2026-07-24 10', providerId: PROVIDER_A, modelId: MODEL_A },
      { input_no_cache: 200, output_response: 400, llmCallCount: 1 },
    );
  });

  it('返 distinct (providerId, modelId) 组合（去重 + ASC 排序）', () => {
    const models = aggregator.queryDistinctModels(SQUAD_ID);
    // seed 含 (prov-a, model-a) + (prov-a, model-b)
    expect(models).toHaveLength(2);
    expect(models.map((m) => `${m.providerId}/${m.modelId}`).sort()).toEqual(
      ['prov-a/model-a', 'prov-a/model-b'].sort(),
    );
  });

  it('label 派生：providerId + "/" + modelId', () => {
    const models = aggregator.queryDistinctModels(SQUAD_ID);
    const labels = models.map((m) => m.label);
    expect(labels).toContain('prov-a/model-a');
    expect(labels).toContain('prov-a/model-b');
  });

  it('from/to 范围过滤：仅查 2026-07-24（只剩 model-a）', () => {
    const models = aggregator.queryDistinctModels(SQUAD_ID, {
      from: '2026-07-24', to: '2026-07-24',
    });
    expect(models).toHaveLength(1);
    expect(models[0]!.providerId).toBe(PROVIDER_A);
    expect(models[0]!.modelId).toBe(MODEL_A);
  });

  it('空数据 squad → 返 []', () => {
    const models = aggregator.queryDistinctModels('01ARZ3NDEKTSV4RRFFQ69G5FAZ');
    expect(models).toEqual([]);
  });

  it('非本 squad 数据不混入（scope 隔离）', () => {
    // 另一个 squad 的数据
    const OTHER_SQUAD = '01ARZ3NDEKTSV4RRFFQ69G5FAZ';
    void statStore.upsertDelta(
      { squadId: OTHER_SQUAD, memberId: '01ARZ3NDEKTSV4RRFFQ69G5FBW', sessionId: '01ARZ3NDEKTSV4RRFFQ69G5FB3', hour: '2026-07-23 14', providerId: 'prov-other', modelId: 'model-other' },
      { input_no_cache: 1, llmCallCount: 1 },
    );
    const models = aggregator.queryDistinctModels(SQUAD_ID);
    expect(models.every((m) => m.providerId !== 'prov-other')).toBe(true);
  });
});
