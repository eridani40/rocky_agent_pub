/**
 * DeepSeek 按量付费 provider impl（v0.0.350 决策①⑨）
 * 参考: specs/tech/version_logs/v0.0.350/change_plan.md 决策①⑨
 *       specs/research/v0.0.350-live-verify.md §4（实测响应原文，与官方文档/ cc-switch 三方互证）
 *
 * 协议 = anthropic（buildAuthHeaders 复用 x-api-key）；余额查询 Bearer。
 * 解析规则：余额型（kind='balance'）无窗口概念——
 *   - balance_infos[]（字符串金额 parseNum）+ is_available 透出
 *   - currency 币种原样（实测 CNY）；total/granted/toppedUp 数值化
 */
import type { LlmProviderConfig, QuotaSnapshot } from '../../../server/src/llm/provider-types';
import { pickKeyValue } from '../../../server/src/llm/credentials';
import AnthropicCompatibleProvider from './provider';
import {
  classifyQuotaError,
  deriveQuotaBaseUrl,
  fetchQuotaRaw,
  parseNum,
  QuotaBusinessError,
} from './quota-shared';

/** deepseek 实测响应最小结构 */
interface DeepseekBalanceResponse {
  is_available?: boolean;
  balance_infos?: Array<{
    currency?: string;
    total_balance?: unknown;
    granted_balance?: unknown;
    topped_up_balance?: unknown;
  }>;
}

/**
 * deepseek 余额解析（纯函数）：balance_infos[] 逐条转 QuotaSnapshot.balance（多币种多余额并存，
 * 聚合端点取首条——聚合语义在 handler，本解析器只透出 parse 结果数组）。
 * @returns 每条 balance_info 一个 {currency,total,granted?,toppedUp?}；空/缺失 → 空数组
 */
export function parseDeepseekBalance(raw: unknown): {
  isAvailable: boolean;
  balances: Array<{ currency: string; total: number; granted?: number; toppedUp?: number }>;
} {
  const data = raw as DeepseekBalanceResponse;
  const balances = (data?.balance_infos ?? [])
    .map((b) => {
      const total = parseNum(b?.total_balance);
      if (total === undefined || typeof b?.currency !== 'string') return undefined;
      return {
        currency: b.currency,
        total,
        ...(parseNum(b.granted_balance) !== undefined ? { granted: parseNum(b.granted_balance) } : {}),
        ...(parseNum(b.topped_up_balance) !== undefined ? { toppedUp: parseNum(b.topped_up_balance) } : {}),
      };
    })
    .filter((b): b is { currency: string; total: number; granted?: number; toppedUp?: number } => b !== undefined);
  return { isAvailable: data?.is_available === true, balances };
}

export default class DeepSeekApiProvider extends AnthropicCompatibleProvider {
  /** GET {origin}/user/balance（Bearer）→ 余额型快照（无 tiers） */
  async queryQuota(config: LlmProviderConfig): Promise<QuotaSnapshot | null> {
    const key = pickKeyValue(config.credentials);
    if (key === undefined) {
      return { providerId: config.id, providerLabel: config.id, implId: 'deepseek_api', kind: 'balance', fetchedAt: Date.now(), error: { kind: 'auth', message: '未配置 API Key' } };
    }
    try {
      const raw = await fetchQuotaRaw(
        `${deriveQuotaBaseUrl('deepseek_api', config.baseUrl)}/user/balance`,
        key,
        'bearer',
      );
      const { isAvailable, balances } = parseDeepseekBalance(raw);
      if (balances.length === 0) {
        throw new QuotaBusinessError('响应无可解析余额段（balance_infos 缺失）');
      }
      // 首条为主余额（实测单条 CNY；多币种并存超集展示 v2 再加）
      const first = balances[0]!;
      return {
        providerId: config.id,
        providerLabel: config.id,
        implId: 'deepseek_api',
        kind: 'balance',
        balance: first,
        isAvailable,
        fetchedAt: Date.now(),
      };
    } catch (e) {
      return {
        providerId: config.id, providerLabel: config.id, implId: 'deepseek_api', kind: 'balance', fetchedAt: Date.now(),
        error: classifyQuotaError(e),
      };
    }
  }
}
