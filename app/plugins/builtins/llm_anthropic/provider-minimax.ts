/**
 * MiniMax Coding Plan provider impl（v0.0.350 决策①⑨）
 * 参考: specs/tech/version_logs/v0.0.350/change_plan.md 决策①⑨
 *       specs/research/v0.0.350-live-verify.md §3（实测响应原文，与 cc-switch 零偏差）
 *
 * 协议 = anthropic（buildAuthHeaders 复用 x-api-key）；额度查询 Bearer。
 * 解析规则（实测背书）：
 *   - model_remains[] 只取 model_name=="general"（video 等条目忽略）
 *   - 5h 桶：current_interval_remaining_percent → 已用% = 100 − remaining%
 *   - 周桶：仅 current_weekly_status==1 才展示（==3 = 无周限额，跳过不展示）
 *   - 时间戳毫秒；base_resp.status_code != 0 → business 错误透 status_msg
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

/** minimax 实测响应最小结构 */
interface MinimaxRemainsResponse {
  base_resp?: { status_code?: unknown; status_msg?: string };
  model_remains?: Array<{
    model_name?: string;
    end_time?: unknown; // 5h 窗口结束=重置时间（毫秒）
    weekly_end_time?: unknown; // 周窗口结束（毫秒）
    current_interval_remaining_percent?: unknown;
    current_weekly_status?: unknown;
    current_weekly_remaining_percent?: unknown;
  }>;
}

/** remaining% 反转已用%（四舍五入；实测 99 → 已用 1） */
function invert(remaining: number): number {
  return Math.round(100 - remaining);
}

/**
 * minimax 额度解析（纯函数）：general 条目 + 反转 + 周桶 status==1 门控。
 * base_resp.status_code 非 0 → QuotaBusinessError（透 status_msg）。
 */
export function parseMinimaxQuota(raw: unknown, meta: { providerId: string; providerLabel: string }): QuotaSnapshot {
  const data = raw as MinimaxRemainsResponse;
  const statusCode = parseNum(data?.base_resp?.status_code);
  if (statusCode !== undefined && statusCode !== 0) {
    throw new QuotaBusinessError(data?.base_resp?.status_msg || `额度查询失败（status_code=${statusCode}）`);
  }
  const general = (data?.model_remains ?? []).find((m) => m?.model_name === 'general');
  const tiers: QuotaTier[] = [];
  if (general) {
    // 5h 桶：恒在（current_interval_*）
    const intervalRemaining = parseNum(general.current_interval_remaining_percent);
    if (intervalRemaining !== undefined) {
      tiers.push({ window: 'five_hour', usedPercent: invert(intervalRemaining), resetsAt: parseResetTime(general.end_time) });
    }
    // 周桶：仅 status==1（==3 无周限额跳过）
    if (parseNum(general.current_weekly_status) === 1) {
      const weeklyRemaining = parseNum(general.current_weekly_remaining_percent);
      if (weeklyRemaining !== undefined) {
        tiers.push({ window: 'weekly', usedPercent: invert(weeklyRemaining), resetsAt: parseResetTime(general.weekly_end_time) });
      }
    }
  }
  return {
    providerId: meta.providerId,
    providerLabel: meta.providerLabel,
    implId: 'minimax_coding_plan',
    kind: 'quota',
    ...(tiers.length > 0 ? { tiers } : {}),
    fetchedAt: Date.now(),
  };
}

export default class MinimaxCodingPlanProvider extends AnthropicCompatibleProvider {
  /** GET {推导域}/v1/api/openplatform/coding_plan/remains（Bearer） */
  async queryQuota(config: LlmProviderConfig): Promise<QuotaSnapshot | null> {
    const key = pickKeyValue(config.credentials);
    if (key === undefined) {
      return { providerId: config.id, providerLabel: config.id, implId: 'minimax_coding_plan', kind: 'quota', fetchedAt: Date.now(), error: { kind: 'auth', message: '未配置 API Key' } };
    }
    try {
      const raw = await fetchQuotaRaw(
        `${deriveQuotaBaseUrl('minimax_coding_plan', config.baseUrl)}/v1/api/openplatform/coding_plan/remains`,
        key,
        'bearer',
      );
      const snap = parseMinimaxQuota(raw, { providerId: config.id, providerLabel: config.id });
      if (snap.tiers === undefined) {
        throw new QuotaBusinessError('响应无可解析额度段（general 条目缺失）');
      }
      return snap;
    } catch (e) {
      return {
        providerId: config.id, providerLabel: config.id, implId: 'minimax_coding_plan', kind: 'quota', fetchedAt: Date.now(),
        error: classifyQuotaError(e),
      };
    }
  }
}
