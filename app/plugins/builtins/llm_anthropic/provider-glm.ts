/**
 * 智谱 GLM Coding Plan provider impl（v0.0.350 决策①⑨）
 * 参考: specs/tech/version_logs/v0.0.350/change_plan.md 决策①（extends）/决策⑨（解析规则）
 *       specs/research/v0.0.350-live-verify.md §2（实测响应原文）
 *
 * 协议 = anthropic（buildAuthHeaders 复用 x-api-key）；额度查询特例：**裸 api_key 无 Bearer**（实测）。
 * 解析规则（实测背书，issue #3036 教训）：
 *   - 过滤 type ∈ {TOKENS_LIMIT, CREDIT_LIMIT}（大小写不敏感）；TIME_LIMIT 忽略
 *   - 分桶**只锚 unit**：unit:3 → 5h、unit:6 → 周（number:5/number:1 等取值变体不锚定）
 *   - percentage 直读已用%；nextResetTime 毫秒
 *   - **禁按重置时间排序**（保持响应原序）
 *   - data.level = 套餐名透出；success==false → business 错误透 msg
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

/** glm 实测响应最小结构 */
interface GlmQuotaResponse {
  success?: boolean;
  msg?: string;
  data?: {
    level?: string;
    limits?: Array<{
      type?: string;
      unit?: unknown;
      percentage?: unknown;
      nextResetTime?: unknown;
    }>;
  };
}

/** type ∈ {TOKENS_LIMIT, CREDIT_LIMIT}（大小写不敏感） */
function isQuotaLimitType(t: unknown): boolean {
  return typeof t === 'string'
    && (t.toUpperCase() === 'TOKENS_LIMIT' || t.toUpperCase() === 'CREDIT_LIMIT');
}

/**
 * glm 额度解析（纯函数）：unit 分桶（3→5h、6→周）；percentage 直读；禁排序（原序遍历）。
 */
export function parseGlmQuota(raw: unknown, meta: { providerId: string; providerLabel: string }): QuotaSnapshot {
  const data = raw as GlmQuotaResponse;
  if (data?.success === false) {
    throw new QuotaBusinessError(data?.msg || '额度查询失败（success=false）');
  }
  const tiers: QuotaTier[] = [];
  for (const limit of data?.data?.limits ?? []) {
    if (!isQuotaLimitType(limit?.type)) continue; // TIME_LIMIT 等忽略
    const unit = parseNum(limit.unit);
    const percentage = parseNum(limit.percentage);
    if (percentage === undefined) continue;
    if (unit === 3) {
      tiers.push({ window: 'five_hour', usedPercent: Math.round(percentage), resetsAt: parseResetTime(limit.nextResetTime) });
    } else if (unit === 6) {
      tiers.push({ window: 'weekly', usedPercent: Math.round(percentage), resetsAt: parseResetTime(limit.nextResetTime) });
    }
  }
  return {
    providerId: meta.providerId,
    providerLabel: meta.providerLabel,
    implId: 'glm_coding_plan',
    kind: 'quota',
    ...(tiers.length > 0 ? { tiers } : {}),
    membership: data?.data?.level,
    fetchedAt: Date.now(),
  };
}

export default class GlmCodingPlanProvider extends AnthropicCompatibleProvider {
  /** GET {推导域}/api/monitor/usage/quota/limit — 裸 api_key（无 Bearer，实测特例） */
  async queryQuota(config: LlmProviderConfig): Promise<QuotaSnapshot | null> {
    const key = pickKeyValue(config.credentials);
    if (key === undefined) {
      return { providerId: config.id, providerLabel: config.id, implId: 'glm_coding_plan', kind: 'quota', fetchedAt: Date.now(), error: { kind: 'auth', message: '未配置 API Key' } };
    }
    try {
      const raw = await fetchQuotaRaw(
        `${deriveQuotaBaseUrl('glm_coding_plan', config.baseUrl)}/api/monitor/usage/quota/limit`,
        key,
        'raw',
      );
      const snap = parseGlmQuota(raw, { providerId: config.id, providerLabel: config.id });
      if (snap.tiers === undefined) {
        throw new QuotaBusinessError('响应无可解析额度段（limits 缺失或全被过滤）');
      }
      return snap;
    } catch (e) {
      return {
        providerId: config.id, providerLabel: config.id, implId: 'glm_coding_plan', kind: 'quota', fetchedAt: Date.now(),
        error: classifyQuotaError(e),
      };
    }
  }
}
