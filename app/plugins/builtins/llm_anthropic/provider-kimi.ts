/**
 * Kimi Coding Plan provider impl（v0.0.350 决策①⑨）
 * 参考: specs/tech/version_logs/v0.0.350/change_plan.md 决策①（extends AnthropicCompatible）
 *       specs/research/v0.0.350-live-verify.md §1（实测响应原文）
 *
 * 协议 = anthropic（buildAuthHeaders 复用 x-api-key）；差异仅额度查询（queryQuota）。
 * 解析规则（实测背书）：
 *   - limits[] → 5h 桶（多条取首条；window.duration:300 分钟显式声明 5h）
 *   - usage → 周桶；已用优先直读 usage.used，缺失用 limit-remaining 换算兜底
 *   - 数值全字符串兼容（parseNum）；resetTime ISO
 *   - user.membership.level 套餐档位透出
 * 解析器（parseKimiQuota）与 HTTP 分离，可独立单测。
 */
import type { LlmProviderConfig, QuotaSnapshot, QuotaTier } from '../../../server/src/llm/provider-types';
import { pickKeyValue } from '../../../server/src/llm/credentials';
import AnthropicCompatibleProvider from './provider';
import {
  classifyQuotaError,
  deriveQuotaBaseUrl,
  fetchQuotaRaw,
  parseNum,
  parseResetTime,
  QuotaBusinessError,
} from './quota-shared';

/** kimi 实测响应最小结构（防御解析用；未知字段忽略） */
interface KimiUsagesResponse {
  user?: { membership?: { level?: string } };
  usage?: { limit?: unknown; used?: unknown; remaining?: unknown; resetTime?: unknown };
  limits?: Array<{
    detail?: { limit?: unknown; used?: unknown; remaining?: unknown; resetTime?: unknown };
  }>;
}

/**
 * kimi 额度解析（纯函数）：5h 桶取 limits[0].detail；周桶取 usage。
 * 已用%：used 直读优先（limit-remaining 换算兜底，与周桶同构）；
 * 满额形态上游省略 remaining 只留 used（2026-08-15 kimi-2 实测，BUG 报告：
 * outputs/bugs/kimi2-five-hour-tier-missing.md）——两条取值路径互为兜底。
 */
export function parseKimiQuota(raw: unknown, meta: { providerId: string; providerLabel: string }): QuotaSnapshot {
  const data = raw as KimiUsagesResponse;
  const tiers: QuotaTier[] = [];
  // 5h 桶：limits[0]（多条逐条取首条，多条降级不猜）
  const fiveHour = data?.limits?.[0]?.detail;
  if (fiveHour) {
    const limit = parseNum(fiveHour.limit);
    const remaining = parseNum(fiveHour.remaining);
    // used 直读优先（满额形态无 remaining）+ limit-remaining 换算兜底（旧形态无 used），与周桶同构
    const used = parseNum(fiveHour.used)
      ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined);
    if (used !== undefined && limit !== undefined && limit > 0) {
      tiers.push({ window: 'five_hour', usedPercent: pct(used, limit), resetsAt: parseResetTime(fiveHour.resetTime) });
    }
  }
  // 周桶：usage（used 直读优先 / limit-remaining 兜底）
  const usage = data?.usage;
  if (usage) {
    const limit = parseNum(usage.limit);
    const used = parseNum(usage.used) ?? (limit !== undefined && parseNum(usage.remaining) !== undefined
      ? limit - parseNum(usage.remaining)!
      : undefined);
    if (used !== undefined && limit !== undefined && limit > 0) {
      tiers.push({ window: 'weekly', usedPercent: pct(used, limit), resetsAt: parseResetTime(usage.resetTime) });
    }
  }
  return {
    providerId: meta.providerId,
    providerLabel: meta.providerLabel,
    implId: 'kimi_coding_plan',
    kind: 'quota',
    ...(tiers.length > 0 ? { tiers } : {}),
    membership: data?.user?.membership?.level,
    fetchedAt: Date.now(),
  };
}

/** 百分比取整（四舍五入；kimi 实测整值） */
function pct(used: number, limit: number): number {
  return Math.round((used / limit) * 100);
}

export default class KimiCodingPlanProvider extends AnthropicCompatibleProvider {
  /** GET {推导 baseUrl}/v1/usages（Bearer）；kimi baseUrl 原样保留 /coding 前缀 */
  async queryQuota(config: LlmProviderConfig): Promise<QuotaSnapshot | null> {
    const key = pickKeyValue(config.credentials);
    if (key === undefined) {
      return { ...errorSnapshot(config), error: { kind: 'auth', message: '未配置 API Key' } };
    }
    try {
      const raw = await fetchQuotaRaw(
        `${deriveQuotaBaseUrl('kimi_coding_plan', config.baseUrl)}/v1/usages`,
        key,
        'bearer',
      );
      const snap = parseKimiQuota(raw, { providerId: config.id, providerLabel: config.id });
      if (snap.tiers === undefined) {
        throw new QuotaBusinessError('响应缺少可解析的额度段（usage/limits 均缺失）');
      }
      return snap;
    } catch (e) {
      return { ...errorSnapshot(config), error: classifyQuotaError(e) };
    }
  }
}

/** 错误态快照（providerLabel 占位 id，聚合端点用实例 label 覆盖） */
function errorSnapshot(config: LlmProviderConfig): Omit<QuotaSnapshot, 'error'> {
  return {
    providerId: config.id,
    providerLabel: config.id,
    implId: 'kimi_coding_plan',
    kind: 'quota',
    fetchedAt: Date.now(),
  };
}
