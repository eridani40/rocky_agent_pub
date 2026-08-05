/**
 * TokenUsageAggregator — token 用量聚合查询（raw SQL GROUP BY SUM，读写分离 §2.6 read path）
 * 参考: specs/tech/persistence/[P1]token_usage_stat.md §5（查询路径 + 口径）
 *       specs/api/overall/11c-token-stats.md §3/§4/§5（端点契约 + 口径）
 *       specs/tech/version_logs/v0.0.194/change_plan.md 模块 C 第 1 行
 *
 * 职责：
 *   - query(squadId, opts) → 构造 GROUP BY SQL 通过注入的 SqlDriver 执行
 *   - scope=team WHERE squadId（不 filter memberId）/ scope=memberId 加 AND memberId
 *   - granularity=day GROUP BY substr(hour,1,10) / granularity=hour GROUP BY hour
 *   - 可选 model 筛选 AND providerId+modelId
 *   - 后处理派生 totalTokens + cacheRate（视图层算，§5）
 *
 * 存储契约：SqliteCrudStore 是 blob-first（所有业务字段在 data JSON blob 列）。
 * 故 SQL 里所有业务字段都要走 json_extract(data, '$.field')，不能当裸列引用。
 *
 * 依赖：接收 SqlDriver（与 SqliteCrudStore 共享同一实例，bootstrap 注入，读写分离 §2.6）。
 */
import type { SqlDriver } from '../../persistence/search-sql-driver';

/** 查询参数 */
export interface TokenUsageQueryOpts {
  /** 'YYYY-MM-DD'（含）；缺省 to-60 天 */
  from?: string;
  /** 'YYYY-MM-DD'（含）；缺省今天 */
  to?: string;
  /** 'team' = Σ 全 member（WHERE squadId）/ 具体 memberId = 单 member 过滤；缺省 'team' */
  scope?: string;
  /** 'day' = GROUP BY substr(hour,1,10) / 'hour' = GROUP BY hour；缺省 'day' */
  granularity?: 'day' | 'hour';
  /** 可选 model 筛选（providerId + modelId 必须同时提供） */
  providerId?: string;
  modelId?: string;
}

/** 单个时间桶的聚合数据点（对齐 API §3.2 TokenUsageStatPoint） */
export interface TokenUsageStatPoint {
  /** 时间桶 key：day='YYYY-MM-DD' / hour='YYYY-MM-DD HH' */
  bucket: string;
  input_no_cache: number;
  cache_read: number;
  cache_creation: number;
  output_response: number;
  output_reasoning: number;
  cost: number;
  llmCallCount: number;
  /** 总 token = input_no_cache + cache_read + cache_creation + output_response + output_reasoning（派生） */
  total: number;
  /** 缓存率 [0,1]：cache_read / (cache_read + input_no_cache)，分母 ≤0 返 0 */
  cacheRate: number;
}

/** 查询结果（对齐 API §3.1 TokenUsageQueryResult） */
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
   * 从 token_usage_stat 数据派生（非 squad.modelDefault 配置）；供前端 model 筛选下拉。
   * label：'__unknown__' → '未知模型'，否则 `${providerId}/${modelId}`。
   */
  availableModels?: AvailableModel[];
}

/** distinct model 条目（前端 model 下拉数据源） */
export interface AvailableModel {
  providerId: string;
  modelId: string;
  /**
   * 显示 label（本层派生 = fallback）：'__unknown__' → '未知模型'，否则 `${providerId}/${modelId}`。
   * handler 层会用 app_config providers.label 改写为 `${providerName} / ${modelId}`（ULID 不可读）。
   */
  label: string;
}

/** SQL 聚合行的原始形态（SUM 字段 + bucket） */
interface AggRow {
  bucket: string;
  input_no_cache: number;
  cache_read: number;
  cache_creation: number;
  output_response: number;
  output_reasoning: number;
  cost: number;
  llmCallCount: number;
}

/** 全零数据点（补零点位用） */
function zeroPoint(bucket: string): TokenUsageStatPoint {
  return {
    bucket,
    input_no_cache: 0,
    cache_read: 0,
    cache_creation: 0,
    output_response: 0,
    output_reasoning: 0,
    cost: 0,
    llmCallCount: 0,
    total: 0,
    cacheRate: 0,
  };
}

/**
 * hour 粒度补零：把 [from, to] 范围内每天的 00~23 小时桶补全成完整序列。
 * 有数据的桶保留原值，无数据的桶补零点位；返回按 bucket ASC 排序。
 * 桶 key 是 'YYYY-MM-DD HH' 字符串（subscriber 写入时已按 squad.timezone 本地化），
 * 故日期迭代是纯字符串日期数学（Date.UTC），不涉运行时区。
 */
function zeroFillHours(
  series: TokenUsageStatPoint[],
  from: string,
  to: string,
): TokenUsageStatPoint[] {
  const byBucket = new Map(series.map((p) => [p.bucket, p]));
  const filled: TokenUsageStatPoint[] = [];
  // 逐日迭代 [from..to]（含两端），每天 24 个小时桶
  const [fy, fm, fd] = from.split('-').map(Number);
  const cursor = Date.UTC(fy!, fm! - 1, fd!);
  for (let t = cursor; ; t += 86_400_000) {
    const d = new Date(t);
    const day =
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
      `-${String(d.getUTCDate()).padStart(2, '0')}`;
    if (day > to) break;
    for (let h = 0; h < 24; h++) {
      const bucket = `${day} ${String(h).padStart(2, '0')}`;
      filled.push(byBucket.get(bucket) ?? zeroPoint(bucket));
    }
  }
  return filled;
}

/**
 * TokenUsageAggregator — raw SQL GROUP BY SUM 聚合查询。
 *
 * @param driver 与 SqliteCrudStore 共享同一实例的 SqlDriver（bootstrap 注入）
 */
export class TokenUsageAggregator {
  constructor(private readonly driver: SqlDriver) {}

  /**
   * 执行 GROUP BY SUM 聚合查询（读写分离 §2.6 read path）。
   *
   * SQL 构造（blob-first：业务字段走 json_extract）：
   *   SELECT <bucket_expr> AS bucket,
   *     SUM(json_extract(data,'$.input_no_cache')) AS input_no_cache, ...
   *   FROM token_usage_stat
   *   WHERE json_extract(data,'$.squadId') = ?
   *     AND json_extract(data,'$.hour') >= ? AND json_extract(data,'$.hour') <= ?
   *     [AND json_extract(data,'$.memberId') = ?]              -- scope!=team
   *     [AND json_extract(data,'$.providerId') = ?
   *      AND json_extract(data,'$.modelId') = ?]               -- 可选 model 筛选
   *   GROUP BY bucket ORDER BY bucket ASC
   */
  query(
    squadId: string,
    opts: TokenUsageQueryOpts,
    timezone: string = 'UTC',
  ): TokenUsageQueryResult {
    const granularity = opts.granularity ?? 'day';
    const scope = opts.scope ?? 'team';
    const from = opts.from ?? '';
    const to = opts.to ?? '';

    // bucket 表达式：day = substr(hour,1,10)；hour = hour 全值
    const bucketExpr =
      granularity === 'day'
        ? `substr(json_extract(data, '$.hour'), 1, 10)`
        : `json_extract(data, '$.hour')`;

    // WHERE 子句构造（参数化绑定，防注入）
    const where: string[] = [`json_extract(data, '$.squadId') = ?`];
    const params: unknown[] = [squadId];
    // hour 范围：from/to 是 'YYYY-MM-DD'，SQL 走 'YYYY-MM-DD 00' ~ 'YYYY-MM-DD 23' 字典序比较
    if (from) {
      where.push(`json_extract(data, '$.hour') >= ?`);
      params.push(`${from} 00`);
    }
    if (to) {
      where.push(`json_extract(data, '$.hour') <= ?`);
      params.push(`${to} 23`);
    }
    // scope != team → 加 memberId 过滤
    if (scope !== 'team') {
      where.push(`json_extract(data, '$.memberId') = ?`);
      params.push(scope);
    }
    // 可选 model 筛选（providerId + modelId 必须同时提供）
    if (opts.providerId && opts.modelId) {
      where.push(`json_extract(data, '$.providerId') = ?`);
      params.push(opts.providerId);
      where.push(`json_extract(data, '$.modelId') = ?`);
      params.push(opts.modelId);
    }

    const sql =
      `SELECT ${bucketExpr} AS bucket, ` +
      `SUM(json_extract(data, '$.input_no_cache')) AS input_no_cache, ` +
      `SUM(json_extract(data, '$.cache_read')) AS cache_read, ` +
      `SUM(json_extract(data, '$.cache_creation')) AS cache_creation, ` +
      `SUM(json_extract(data, '$.output_response')) AS output_response, ` +
      `SUM(json_extract(data, '$.output_reasoning')) AS output_reasoning, ` +
      `SUM(json_extract(data, '$.cost')) AS cost, ` +
      `SUM(json_extract(data, '$.llmCallCount')) AS llmCallCount ` +
      `FROM token_usage_stat WHERE ${where.join(' AND ')} ` +
      `GROUP BY bucket ORDER BY bucket ASC`;

    const rows = this.driver.prepare<AggRow>(sql).all(...params);
    let series = rows.map(row => this.derivePoint(row));
    // granularity=hour 且范围有界 → 补零成完整小时序列（范围内每天 00~23 共 24 点位，
    // 无数据的点位补 0；单日视图固定 24 点位契约）。day 粒度不补零。
    if (granularity === 'hour' && from && to) {
      series = zeroFillHours(series, from, to);
    }
    return {
      squadId,
      granularity,
      scope,
      from,
      to,
      timezone,
      ...(opts.providerId && opts.modelId
        ? { providerId: opts.providerId, modelId: opts.modelId }
        : {}),
      series,
    };
  }

  /**
   * 后处理：派生 total + cacheRate（视图层算，spec §5）。
   * - total = input_no_cache + cache_read + cache_creation + output_response + output_reasoning
   * - cacheRate = cache_read / (cache_read + input_no_cache)，分母 ≤0 返 0
   */
  private derivePoint(row: AggRow): TokenUsageStatPoint {
    const input_no_cache = row.input_no_cache ?? 0;
    const cache_read = row.cache_read ?? 0;
    const cache_creation = row.cache_creation ?? 0;
    const output_response = row.output_response ?? 0;
    const output_reasoning = row.output_reasoning ?? 0;
    const total = input_no_cache + cache_read + cache_creation + output_response + output_reasoning;
    const denom = cache_read + input_no_cache;
    const cacheRate = denom > 0 ? cache_read / denom : 0;
    return {
      bucket: row.bucket,
      input_no_cache,
      cache_read,
      cache_creation,
      output_response,
      output_reasoning,
      cost: row.cost ?? 0,
      llmCallCount: row.llmCallCount ?? 0,
      total,
      cacheRate,
    };
  }

  /**
   * 查询某 squad 在指定范围内**实际使用过**的 distinct (providerId, modelId) 组合。
   * 用于前端 model 筛选下拉数据源（用户真正用过的 model，非 squad 配置默认）。
   *
   * SQL（blob-first：业务字段走 json_extract）：
   *   SELECT DISTINCT
   *     IFNULL(json_extract(data,'$.providerId'), '__unknown__') AS providerId,
   *     IFNULL(json_extract(data,'$.modelId'), '__unknown__') AS modelId
   *   FROM token_usage_stat
   *   WHERE json_extract(data,'$.squadId') = ?
   *     [AND json_extract(data,'$.hour') >= ? AND json_extract(data,'$.hour') <= ?]
   *   ORDER BY providerId, modelId
   *
   * `__unknown__` 兜底：subscriber model 三级 fallback 终站 = '__unknown__'，
   *   但历史/异常数据可能 NULL，统一归入 '__unknown__'。
   *
   * @param squadId 必填
   * @param range 可选 {from,to} 'YYYY-MM-DD'（与 query 同口径：from 00:00 ~ to 23:00）
   * @returns distinct model 列表（含 label 派生）；空数据返 []
   */
  queryDistinctModels(
    squadId: string,
    range?: { from?: string; to?: string },
  ): AvailableModel[] {
    const where: string[] = [`json_extract(data, '$.squadId') = ?`];
    const params: unknown[] = [squadId];
    if (range?.from) {
      where.push(`json_extract(data, '$.hour') >= ?`);
      params.push(`${range.from} 00`);
    }
    if (range?.to) {
      where.push(`json_extract(data, '$.hour') <= ?`);
      params.push(`${range.to} 23`);
    }
    const sql =
      `SELECT DISTINCT ` +
      `IFNULL(json_extract(data, '$.providerId'), '__unknown__') AS providerId, ` +
      `IFNULL(json_extract(data, '$.modelId'), '__unknown__') AS modelId ` +
      `FROM token_usage_stat WHERE ${where.join(' AND ')} ` +
      `ORDER BY providerId ASC, modelId ASC`;
    const rows = this.driver.prepare<{ providerId: string; modelId: string }>(sql).all(...params);
    return rows.map((r) => {
      const providerId = r.providerId ?? '__unknown__';
      const modelId = r.modelId ?? '__unknown__';
      const label = providerId === '__unknown__' || modelId === '__unknown__'
        ? '未知模型'
        : `${providerId}/${modelId}`;
      return { providerId, modelId, label };
    });
  }
}
