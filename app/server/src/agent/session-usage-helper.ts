/**
 * SessionUsage 累计 / ratio 学习 / view 聚合 helper。
 * 参考: specs/tech/agent/session/[P0]session_usage.md §2 §6 §7 §8
 *
 * 纯函数，无 IO，无副作用：AccumulatedUsage 三分区（current/sub/forked）Σ 累加 +
 *   llmCallCount；ratio 仅 current 喂（sliding 3 取中位数）；view = 三分区 + total + cw + cacheRate。
 */
import type { Usage, ContextWindowUsage } from '../message/types';

// ratio 学习：sliding 3 取中位数；窗口未满用 1.0 冷启动；sample clamp [0.2, 5.0]
const RATIO_WINDOW_SIZE = 3;
const RATIO_COLD_START = 1.0;
const RATIO_CLAMP_MIN = 0.2;
const RATIO_CLAMP_MAX = 5.0;
/** ContextWindowUsage 输出预算缺省值（AppConfig `context.maxOutputTokens` 未配置时回退，spec context_snapshot_interface §2 默认值表） */
export const DEFAULT_MAX_OUTPUT_TOKENS = 20000;
/** ContextWindowUsage 模型窗口缺省值（历史 record 无 tokenLimit 时回退） */
export const DEFAULT_TOKEN_LIMIT = 200000;

/** Usage 数值字段 + char 计数的累加 key 集合（llmCallCount 由 partition 顶级单独维护） */
const NUMERIC_KEYS = [
  'input_cache_read',
  'input_cache_write',
  'input_no_cache',
  'input_total_tokens',
  'output_response',
  'output_reasoning',
  'output_total_tokens',
  'total_tokens',
  'cost',
  'inputCharCount',
  'outputCharCount',
] as const;

/**
 * 累加版 usage（spec session_usage §2）。用 Record<string, number> 表示（兼容 view 形态）；
 * llmCallCount 单独存（partition 顶级）。
 */
export interface AccumulatedPartition {
  fields: Record<string, number>;
  llmCallCount: number;
}

/** ratio 滑动窗口（spec session_usage §7 / session_store §2 RatioWindow） */
export interface RatioWindow {
  samples: number[];
  current: number;
}

/** session 级 usage meta（spec session_store §2 SessionUsageMeta 简化） */
export interface SessionUsageMeta {
  current: AccumulatedPartition;
  sub: AccumulatedPartition;
  forked: AccumulatedPartition;
  ratio: RatioWindow;
}

/** 空分区（Σ 起点） */
export function emptyPartition(): AccumulatedPartition {
  return { fields: {}, llmCallCount: 0 };
}

/** 空 usage meta（新 session / 历史 session 缺字段时回退） */
export function emptyMeta(): SessionUsageMeta {
  return {
    current: emptyPartition(),
    sub: emptyPartition(),
    forked: emptyPartition(),
    ratio: { samples: [], current: RATIO_COLD_START },
  };
}

/** 规范化单个 partition（缺字段回退，兼容历史 / 脏 record）。 */
export function normalizePartition(raw: unknown): AccumulatedPartition {
  if (!raw || typeof raw !== 'object') return emptyPartition();
  const pp = raw as Partial<AccumulatedPartition>;
  return {
    fields: (pp.fields && typeof pp.fields === 'object')
      ? { ...pp.fields as Record<string, number> }
      : {},
    llmCallCount: typeof pp.llmCallCount === 'number' ? pp.llmCallCount : 0,
  };
}

/** 规范化历史 / 脏 usage meta record → SessionUsageMeta（缺字段回退）。 */
export function normalizeMeta(raw: unknown): SessionUsageMeta {
  if (!raw || typeof raw !== 'object') return emptyMeta();
  const r = raw as Partial<SessionUsageMeta>;
  const ratioRaw = r.ratio;
  const ratio: RatioWindow = ratioRaw && typeof ratioRaw === 'object'
    ? {
        samples: Array.isArray(ratioRaw.samples)
          ? ratioRaw.samples.filter((x): x is number => typeof x === 'number')
          : [],
        current: typeof ratioRaw.current === 'number' ? ratioRaw.current : RATIO_COLD_START,
      }
    : { samples: [], current: RATIO_COLD_START };
  return {
    current: normalizePartition(r.current),
    sub: normalizePartition(r.sub),
    forked: normalizePartition(r.forked),
    ratio,
  };
}

/**
 * 把单次 Usage Σ 累加到一个 partition（各字段加 + llmCallCount++）。
 * spec session_usage §6.2 step1：读该分区 + 各字段 Σ + llmCallCount++ + 写回。
 *
 * @returns 新 partition（不可变：返回新对象，便于写回 + view 派生）
 */
export function accumulatePartition(
  partition: AccumulatedPartition,
  usage: Usage,
): AccumulatedPartition {
  const fields: Record<string, number> = { ...partition.fields };
  for (const key of NUMERIC_KEYS) {
    const v = usage[key];
    if (typeof v === 'number' && !Number.isNaN(v)) {
      fields[key] = (fields[key] ?? 0) + v;
    }
  }
  return { fields, llmCallCount: partition.llmCallCount + 1 };
}

/**
 * Σ 两个 Usage 的数值字段（NUMERIC_KEYS），返回新 Usage（纯函数无 IO）。
 * runReActLoop 每轮 callLLMForSpec usage 经本函数累加进 RunResult.usage，供 forked caller 总量累计
 * （spec session_usage §6.1 + §10）。b=null 直返 a；非 number 跳过；currency 缺取 b.currency。
 */
export function sumUsage(a: Usage, b: Usage | null): Usage {
  if (b === null) return a;
  const out: Usage = { ...a };
  for (const key of NUMERIC_KEYS) {
    const bv = b[key];
    if (typeof bv !== 'number' || Number.isNaN(bv)) continue;
    const av = a[key];
    out[key] = (typeof av === 'number' && !Number.isNaN(av) ? av : 0) + bv;
  }
  if (!out.currency && b.currency) out.currency = b.currency;
  return out;
}

/**
 * 规范化 ContextWindowUsage record（兼容旧 3 字段 / 缺字段历史数据）。
 * 缺字段回退规则见 spec context_snapshot_interface.md §2「历史数据 normalize 兜底」；
 * 仅保证读回期间 UI / compact 触发判定不崩（下一次 assemble 会真算覆盖）。
 */
export function normalizeContextWindowUsage(raw: unknown): ContextWindowUsage {
  if (!raw || typeof raw !== 'object') {
    // 完全缺失 → 零占用（tokenLimit 默认 + maxOutput 默认 20000）
    const tokenLimit = DEFAULT_TOKEN_LIMIT;
    const maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
    return {
      systemTokens: 0,
      messageTokens: 0,
      toolTokens: 0,
      totalTokens: 0,
      maxOutputTokens,
      tokenLimit,
      remainingTokens: tokenLimit - 0 - maxOutputTokens,
    };
  }
  const r = raw as Record<string, unknown>;
  // 旧 record 兼容：usedTokens（合并值，等价于 totalTokens）
  const legacyUsed = typeof r.usedTokens === 'number' ? r.usedTokens : undefined;
  const systemTokens = typeof r.systemTokens === 'number' ? r.systemTokens : 0;
  // 旧 record 无法精确拆分 → 全归 messageTokens
  const messageTokens = typeof r.messageTokens === 'number'
    ? r.messageTokens
    : (legacyUsed ?? 0);
  const toolTokens = typeof r.toolTokens === 'number' ? r.toolTokens : 0;
  const totalTokens = typeof r.totalTokens === 'number'
    ? r.totalTokens
    : (legacyUsed ?? (systemTokens + messageTokens + toolTokens));
  const maxOutputTokens = typeof r.maxOutputTokens === 'number'
    ? r.maxOutputTokens
    : DEFAULT_MAX_OUTPUT_TOKENS;
  const tokenLimit = typeof r.tokenLimit === 'number'
    ? r.tokenLimit
    : DEFAULT_TOKEN_LIMIT;
  // remainingTokens：若 record 有且合法则用，否则按新公式重算
  const remainingTokens = typeof r.remainingTokens === 'number'
    ? r.remainingTokens
    : tokenLimit - totalTokens - maxOutputTokens;
  return {
    systemTokens,
    messageTokens,
    toolTokens,
    totalTokens,
    maxOutputTokens,
    tokenLimit,
    remainingTokens,
  };
}

/**
 * 计算单次 ratio sample（spec session_usage §7）。
 * sample = clamp(usage.input_total_tokens / usage.inputCharCount, 0.2, 5.0)。
 * 输入非法（缺字段 / 除 0）→ null（丢弃此 sample，不进窗口）。
 */
export function computeRatioSample(usage: Usage): number | null {
  const tok = usage.input_total_tokens;
  const chars = usage.inputCharCount;
  if (typeof tok !== 'number' || typeof chars !== 'number') return null;
  if (chars <= 0 || !Number.isFinite(chars)) return null;
  const raw = tok / chars;
  if (!Number.isFinite(raw)) return null;
  return Math.min(RATIO_CLAMP_MAX, Math.max(RATIO_CLAMP_MIN, raw));
}

/**
 * 推入新 sample 并重算 ratio（sliding 3 取中位数；窗口未满用 1.0 冷启动）。
 * spec session_usage §7：窗口 sliding 3，取中位数；窗口未满用 1.0。
 *
 * @returns 新 RatioWindow（不可变）
 */
export function pushRatioSample(win: RatioWindow, sample: number): RatioWindow {
  const next = [...win.samples, sample].slice(-RATIO_WINDOW_SIZE);
  if (next.length < RATIO_WINDOW_SIZE) {
    // 冷启动：窗口未满，current 保持 1.0（不学）
    return { samples: next, current: RATIO_COLD_START };
  }
  // 取中位数
  const sorted = [...next].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)]!;
  return { samples: next, current: mid };
}

/**
 * 派生 SessionUsageView 的 total（Σ 三分区）。
 * spec session_usage §8：totalAccumulatedUsage = Σ(current, sub, forked)。
 */
export function sumPartitions(
  partitions: AccumulatedPartition[],
): AccumulatedPartition {
  const fields: Record<string, number> = {};
  let llmCallCount = 0;
  for (const p of partitions) {
    for (const [k, v] of Object.entries(p.fields)) {
      fields[k] = (fields[k] ?? 0) + v;
    }
    llmCallCount += p.llmCallCount;
  }
  return { fields, llmCallCount };
}

/** 简化 partition 为纯 Record<string, number>（含 llmCallCount 平铺），兼容现有 SessionUsageView 形态 */
export function partitionToRecord(p: AccumulatedPartition): Record<string, number> {
  return { ...p.fields, llmCallCount: p.llmCallCount };
}

/**
 * 计算分区 cacheRate（v0.0.16；spec session_usage.md §8）。
 * cacheRate = input_cache_read / input_total_tokens（分母 0 返 0）。
 */
export function computeCacheRate(p: AccumulatedPartition): number {
  const total = p.fields.input_total_tokens ?? 0;
  if (total <= 0 || !Number.isFinite(total)) return 0;
  return (p.fields.input_cache_read ?? 0) / total;
}

/** SessionUsageView 业务视图（三分区 + total + ratio + 4 cacheRate；v0.0.16 加 cacheRate） */
export interface SessionUsageView {
  current: Record<string, number>;
  sub: Record<string, number>;
  forked: Record<string, number>;
  total: Record<string, number>;
  ratio: number;
  /** 最近 assemble 的 context window 占用（v0.0.14 加；可空） */
  contextWindowUsage?: ContextWindowUsage;
  /** [v0.0.16] 4 个 cacheRate 派生字段（cache_read / input_total，分母 0 返 0） */
  currentCacheRate: number;
  subCacheRate: number;
  forkedCacheRate: number;
  totalCacheRate: number;
}

/** 派生 SessionUsageView（spec session_usage §8：三分区 + total + cw + 4 cacheRate） */
export function deriveUsageView(
  meta: SessionUsageMeta,
  contextWindowUsage?: ContextWindowUsage,
): SessionUsageView {
  const total = sumPartitions([meta.current, meta.sub, meta.forked]);
  const view: SessionUsageView = {
    current: partitionToRecord(meta.current),
    sub: partitionToRecord(meta.sub),
    forked: partitionToRecord(meta.forked),
    total: partitionToRecord(total),
    ratio: meta.ratio.current,
    currentCacheRate: computeCacheRate(meta.current),
    subCacheRate: computeCacheRate(meta.sub),
    forkedCacheRate: computeCacheRate(meta.forked),
    totalCacheRate: computeCacheRate(total),
  };
  if (contextWindowUsage) view.contextWindowUsage = contextWindowUsage;
  return view;
}
