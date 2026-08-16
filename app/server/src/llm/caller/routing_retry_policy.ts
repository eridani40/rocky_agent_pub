/**
 * routing_retry_policy —— 模型路由差异化重试策略（纯函数）
 * 参考: specs/tech/agent/providers_and_models/[P0]model_routing.md §7（D1，差异化重试表）
 *       specs/prd/model-routing-PRD-2026-08-14.md §2.6（错误类别 → 重试次数 → 熔断行为表）
 *
 * 纯函数：LlmErrorCategory → { inModelRetries, directOpen }，attempt 循环按表决策。
 * 规则（PRD §2.6 表逐行）：
 *   - RATE_LIMITED(429) / PROVIDER_OVERLOADED(529) → 0 次（快速失败直接降级）
 *   - 瞬态（网络/超时/5xx/流断/空响应/MAX_TOKENS_TOO_HIGH）→ 1 次
 *   - AUTH_INVALID(401) / AUTH_FORBIDDEN(403) → 0 次 + directOpen（直接熔断 Open，短期不恢复）
 *   - 请求/内容类（CONTEXT_LENGTH / MAX_TOKENS_EXCEEDED / CONTENT_FILTERED /
 *     MODEL_NOT_FOUND / MALFORMED_TOOL_CALL / BAD_REQUEST_OTHER）→ 0 次（走现有压缩/bump 修复
 *     流程或快速失败，模型内不再重试）
 *   - ABORTED_BY_USER 由调用方处理（不算失败），本函数不涉及
 */
import { LlmErrorCategory } from './error_types';

/** 差异化重试策略产出 */
export interface RoutingRetryPolicy {
  /** 模型内重试次数（换下一个模型前对同 (provider, model) 的额外尝试次数） */
  inModelRetries: number;
  /** true = 直接熔断 Open（AUTH 类，key 失效短期不恢复） */
  directOpen: boolean;
}

/**
 * 差异化重试策略纯函数（PRD §2.6 表逐行）。
 * @param category 归一化错误分类（error_normalization classify 产出）
 * @returns { inModelRetries, directOpen }
 */
export function routingRetryPolicy(category: LlmErrorCategory): RoutingRetryPolicy {
  switch (category) {
    // 429 / 529：0 次（快速失败直接降级；限流重试无意义，等退避不如换模型）
    case LlmErrorCategory.RATE_LIMITED:
    case LlmErrorCategory.PROVIDER_OVERLOADED:
      return { inModelRetries: 0, directOpen: false };
    // 瞬态：1 次（网络抖动/超时/5xx/流断/空响应/TOO_HIGH 值得重试一次）
    case LlmErrorCategory.NETWORK:
    case LlmErrorCategory.TIMEOUT_FIRST_CHUNK:
    case LlmErrorCategory.TIMEOUT_INTER_CHUNK:
    case LlmErrorCategory.SERVER_ERROR:
    case LlmErrorCategory.STREAM_INCOMPLETE:
    case LlmErrorCategory.EMPTY_RESPONSE:
    case LlmErrorCategory.MAX_TOKENS_TOO_HIGH:
      return { inModelRetries: 1, directOpen: false };
    // AUTH：0 次 + 直接熔断 Open（key 失效短期不恢复，全部候选 AUTH 失败 → 上抛首个 AUTH 错误）
    case LlmErrorCategory.AUTH_INVALID:
    case LlmErrorCategory.AUTH_FORBIDDEN:
      return { inModelRetries: 0, directOpen: true };
    // 其余（请求/内容/客户端内部）：0 次快速失败（模型内不重试；CONTEXT_LENGTH / MAX_TOKENS_EXCEEDED
    // 走现有压缩/bump 修复流程，修复后成功不算路由失败——修复在 routing_loop 内处理，不占重试次数）
    default:
      return { inModelRetries: 0, directOpen: false };
  }
}
