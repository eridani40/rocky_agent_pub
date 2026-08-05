/**
 * llm_attempt_emit —— LlmCaller retry/fallback 进度外显 emit 辅助
 * 参考: specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3.1（llm_attempt event emit 时机）
 *       specs/api/version_logs/v0.0.25/change_log.md §1.4（llm_attempt wire schema）
 *
 * 职责：从 invoke 的 decide 决策点合成 llm_attempt StreamEvent 转发到 ctx.onEvent。
 *
 * emit 路径：ctx.onEvent（StreamEvent）→ agent-loop-call-via-invoker 的 onEvent 拦截
 * llm_attempt 类型 → 转 LlmAttemptEvent AgentEvent emit 到 bus（同 SSE 流）。
 *
 * 纯函数无副作用。
 */
import type { StreamEvent } from '../protocol';
import type { InvokeContext } from './llm_caller';
import { type LlmErrorCategory } from './error_types';
import { deriveDisplayReason } from './display_reason';

/** attempt 失败 target 的最小形态（all_dead 终结时传 null）。 */
export interface AttemptTarget {
  providerId: string;
  keyRef: string;
  model: { modelId: string };
}

/** llm_attempt 的 action 枚举（spec §3.1）。 */
export type LlmAttemptAction = 'RETRY' | 'ROTATE_KEY' | 'FALLBACK' | 'FAIL';

/**
 * 发 llm_attempt StreamEvent 到 ctx.onEvent（spec §3.1）。
 *
 * 通过 ctx.onEvent 转发（同 message_* 事件 emit 路径）。agent-loop-call-via-invoker 的 onEvent
 * 拦截 type='llm_attempt' 的 StreamEvent，转成 LlmAttemptEvent AgentEvent emit 到 bus（同 SSE 流）。
 *
 * @param ctx       InvokeContext（含 onEvent 回调）
 * @param category  本次 attempt 失败的错误分类
 * @param target    失败目标（all_dead 终结时传 null；attempt 失败时传 resolved.target）
 * @param attempt   第几次 attempt（1-based；all_dead 终结时传 0 表示非 attempt 级）
 * @param action    decide 产的动作（RETRY / ROTATE_KEY / FALLBACK / FAIL）
 * @param maxAttempts 本次 invoke 的最大 attempt 次数（= config.retry.max_attempts，前端「重试中 x/x」分母）
 */
export function emitLlmAttempt(
  ctx: InvokeContext,
  category: LlmErrorCategory,
  target: AttemptTarget | null,
  attempt: number,
  action: LlmAttemptAction,
  maxAttempts: number,
): void {
  if (!ctx.onEvent) return;
  const evt: Extract<StreamEvent, { type: 'llm_attempt' }> = {
    type: 'llm_attempt',
    category,
    providerId: target?.providerId ?? '',
    modelId: target?.model.modelId ?? '',
    keyRef: target?.keyRef,
    attempt,
    maxAttempts,
    action,
    // message = category 对应的用户可读文案（前端 hover 展示，不重复维护映射）
    message: deriveDisplayReason(category),
  };
  ctx.onEvent(evt);
}
