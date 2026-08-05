/**
 * component-token-stats-types —— token 用量统计视图的类型 + 视图层派生
 * 参考: specs/ui/components/studio-page/component-token-stats.md
 *       specs/api/overall/11c-token-stats.md §3（TokenUsageQueryResult 契约）
 *
 * 维度模型：
 *   - 粒度 Granularity：'day'（跨天，每点=1天）/ 'hour'（单日，每点=1小时）
 *   - 范围 Scope：'__team__'（团队=Σ 所有 member）/ 单个 memberId
 *   - 类型 KindFilter：'total' | 'input' | 'output' | 'cache' | 'cacheRate'（比率，%）
 *   - 视图 ViewMode：'calendar'（日历热力）/ 'timeline'（堆积柱图）
 *   - model 筛选：'__all__'（不筛选）/ `${providerId}/${modelId}`（单个 model 过滤）
 *
 * breakdown 视图层派生（API 返原值）：
 *   - input  = input_no_cache
 *   - output = output_response + output_reasoning
 *   - cache  = cache_read + cache_creation
 *
 * 团队口径（MANDATORY）：scope='__team__' 时后端 WHERE squadId（Σ 全 member）；
 *   breakdown 不冗余存 total/cacheRate（视图层派生）。
 */

/** 粒度：'day'（跨天日序列）/ 'hour'（单日 24h 序列） */
export type Granularity = 'day' | 'hour';

/** 类型筛选：'total'=三段和 / 'input'/'output'/'cache'=单类（token 量 M）/ 'cacheRate'=比率（%） */
export type KindFilter = 'total' | 'input' | 'output' | 'cache' | 'cacheRate';

/** 视图模式：'calendar'（日历热力）/ 'timeline'（堆积柱图） */
export type ViewMode = 'calendar' | 'timeline';

/** 视图层用量 breakdown（从 API point 派生，三段合并便于可视化） */
export interface UsageBreakdown {
  /** input = API input_no_cache */
  input: number;
  /** output = API output_response + output_reasoning */
  output: number;
  /** cache = API cache_read + cache_creation */
  cache: number;
}

/** 单个时间桶的聚合数据点（对齐 API 11c §3.2 TokenUsageStatPoint） */
export interface TokenUsageStatPoint {
  bucket: string;
  input_no_cache: number;
  cache_read: number;
  cache_creation: number;
  output_response: number;
  output_reasoning: number;
  cost: number;
  llmCallCount: number;
  total: number;
  cacheRate: number;
}

/** 查询结果（对齐 API 11c §3.1 TokenUsageQueryResult） */
export interface TokenUsageQueryResult {
  squadId: string;
  granularity: 'day' | 'hour';
  scope: string;
  from: string;
  to: string;
  timezone: string;
  providerId?: string;
  modelId?: string;
  series: TokenUsageStatPoint[];
  /**
   * 当前 squad 在查询范围内**实际使用过**的 distinct model 列表。
   * 从 token_usage_stat 数据派生（非 squad.modelDefault 配置）。
   */
  availableModels?: AvailableModel[];
}

/** distinct model 条目（前端 model 下拉数据源） */
export interface AvailableModel {
  providerId: string;
  modelId: string;
  /**
   * 显示 label（后端 handler 已用 provider 名字改写）：'${providerName} / ${modelId}'；
   * '__unknown__' → '未知模型'；provider 已删除等未命中场景 fallback '${providerId}/${modelId}'。
   */
  label: string;
}

/** 序列点（已转换为视图 breakdown + 派生 label） */
export interface SeriesPoint {
  /** 原始 bucket：day='YYYY-MM-DD' / hour='YYYY-MM-DD HH' */
  bucket: string;
  /** 横轴 label（day='M/D' / hour='HH'） */
  label: string;
  breakdown: UsageBreakdown;
}

/** API point → 视图 breakdown（三段合并） */
export function pointToBreakdown(p: TokenUsageStatPoint): UsageBreakdown {
  return {
    input: p.input_no_cache,
    output: p.output_response + p.output_reasoning,
    cache: p.cache_read + p.cache_creation,
  };
}

/** 总量 = 三段之和（cacheRate 不是 token 量，不走此函数） */
export function totalOf(b: UsageBreakdown): number {
  return b.input + b.output + b.cache;
}

/**
 * 按 KindFilter 取对应值：
 *   - 'total' = 三段之和
 *   - 'input'/'output'/'cache' = 单段
 *   - 'cacheRate' = cache / (cache + input)，比率 0-1（分母 ≤0 返 0）
 */
export function valueByKind(b: UsageBreakdown, kind: KindFilter): number {
  switch (kind) {
    case 'input':
      return b.input;
    case 'output':
      return b.output;
    case 'cache':
      return b.cache;
    case 'total':
      return totalOf(b);
    case 'cacheRate': {
      const denom = b.cache + b.input;
      return denom <= 0 ? 0 : b.cache / denom;
    }
  }
}
