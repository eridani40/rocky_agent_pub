/**
 * chat-slice-reducer llm_attempt「重试中」态单测（v0.0.144 需求3 前端）
 * 参考: specs/tech/version_logs/v0.0.144/change_plan.md「需求3 前端」reducer 行
 *       specs/prd/version_logs/v0.0.144/03-run-spinner-retry.md（进入/退出/clamp 规则）
 *       specs/ui/components/chat-page/_overview.md §4.10（重试态契约）
 *
 * 验证点：
 *   - llm_attempt(RETRY/ROTATE_KEY/FALLBACK) → retryStatus 设置（attempt/maxAttempts/message）
 *   - attempt 越界 → Math.min clamp（绝不出 4/3）
 *   - action=FAIL → 不进重试态（retryStatus 不设）
 *   - 后续正常运行事件（assistant message_start / text_block_delta / tool_call_start /
 *       tool_result_start / tool_execution_start）→ 清 retryStatus=null
 *   - run_end → 清 retryStatus=null
 *   - 纯函数：不 mutate 入参 state
 */
import { describe, it, expect } from 'vitest';
import {
  applyAgentEventToMessages,
  type AgentEvent,
  type LlmAttemptAction,
  type ReducerState,
} from '../chat-slice-reducer';

const emptyState: ReducerState = {
  loadingPhase: null,
  runActive: false,
  lastRunFinish: null,
  enqueueItems: [],
  pendingToolCall: null,
};

const runStart = (runId: string): AgentEvent => ({ type: 'run_start', runId, sessionId: 's1' });
const llmAttempt = (
  action: LlmAttemptAction,
  attempt: number,
  maxAttempts: number,
  message = 'boom',
  category = 'PROVIDER_OVERLOADED',
): AgentEvent => ({ type: 'llm_attempt', category, attempt, maxAttempts, message, action });

/** 起一个 active run（retryStatus 消费前置：run 进行中） */
function activeRun() {
  return applyAgentEventToMessages([], null, runStart('r1'), emptyState);
}

describe('[v0.0.144] chat-slice-reducer llm_attempt 重试态', () => {
  it('action=RETRY → retryStatus 设置（attempt/maxAttempts/message）', () => {
    const r0 = activeRun();
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, llmAttempt('RETRY', 1, 3, '模型限流'), r0);
    expect(r1.retryStatus).toEqual({ attempt: 1, maxAttempts: 3, message: '模型限流' });
  });

  it('action=ROTATE_KEY → 进重试态', () => {
    const r0 = activeRun();
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, llmAttempt('ROTATE_KEY', 2, 3), r0);
    expect(r1.retryStatus).toEqual({ attempt: 2, maxAttempts: 3, message: 'boom' });
  });

  it('action=FALLBACK → 进重试态', () => {
    const r0 = activeRun();
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, llmAttempt('FALLBACK', 3, 3), r0);
    expect(r1.retryStatus).toEqual({ attempt: 3, maxAttempts: 3, message: 'boom' });
  });

  it('attempt 越界 → Math.min clamp，绝不出 4/3', () => {
    const r0 = activeRun();
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, llmAttempt('RETRY', 4, 3), r0);
    expect(r1.retryStatus).toEqual({ attempt: 3, maxAttempts: 3, message: 'boom' });
  });

  it('action=FAIL → 不进重试态（retryStatus 保持不设）', () => {
    const r0 = activeRun();
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, llmAttempt('FAIL', 0, 3), r0);
    expect(r1.retryStatus == null).toBe(true);
  });

  it('连续多次重试：分子随事件更新（1/3 → 2/3 → 3/3），hover message 反映最近一次', () => {
    let r = activeRun();
    r = applyAgentEventToMessages(r.messages, r.runCtx, llmAttempt('RETRY', 1, 3, 'e1'), r);
    expect(r.retryStatus).toEqual({ attempt: 1, maxAttempts: 3, message: 'e1' });
    r = applyAgentEventToMessages(r.messages, r.runCtx, llmAttempt('ROTATE_KEY', 2, 3, 'e2'), r);
    expect(r.retryStatus).toEqual({ attempt: 2, maxAttempts: 3, message: 'e2' });
    r = applyAgentEventToMessages(r.messages, r.runCtx, llmAttempt('FALLBACK', 3, 3, 'e3'), r);
    expect(r.retryStatus).toEqual({ attempt: 3, maxAttempts: 3, message: 'e3' });
  });

  describe('退出规则：正常运行事件覆盖重试态 → 清 null', () => {
    it('assistant message_start → 清 retryStatus', () => {
      const r0 = activeRun();
      const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, llmAttempt('RETRY', 1, 3), r0);
      expect(r1.retryStatus).not.toBeNull();
      const r2 = applyAgentEventToMessages(
        r1.messages,
        r1.runCtx,
        { type: 'message_start', messageId: 'm1', sessionId: 's1', role: 'assistant' },
        r1,
      );
      expect(r2.retryStatus).toBeNull();
    });

    it('text_block_delta → 清 retryStatus', () => {
      const r0 = activeRun();
      const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, llmAttempt('RETRY', 1, 3), r0);
      const rMsg = applyAgentEventToMessages(
        r1.messages,
        r1.runCtx,
        { type: 'message_start', messageId: 'm1', sessionId: 's1', role: 'assistant' },
        r1,
      );
      // message_start(assistant) 已清；再置一次重试态验证 text_block_delta 独立清除
      const rRetry = applyAgentEventToMessages(rMsg.messages, rMsg.runCtx, llmAttempt('RETRY', 2, 3), rMsg);
      expect(rRetry.retryStatus).not.toBeNull();
      const r2 = applyAgentEventToMessages(
        rRetry.messages,
        rRetry.runCtx,
        { type: 'text_block_delta', blockId: 'b1', messageId: 'm1', delta: 'hi' },
        rRetry,
      );
      expect(r2.retryStatus).toBeNull();
    });

    it('tool_call_start → 清 retryStatus', () => {
      const r0 = activeRun();
      const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, llmAttempt('RETRY', 1, 3), r0);
      const r2 = applyAgentEventToMessages(
        r1.messages,
        r1.runCtx,
        { type: 'tool_call_start', toolCallId: 'tc1', toolName: 'bash', messageId: 'm1' },
        r1,
      );
      expect(r2.retryStatus).toBeNull();
    });

    it('tool_result_start → 清 retryStatus', () => {
      const r0 = activeRun();
      const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, llmAttempt('RETRY', 1, 3), r0);
      const r2 = applyAgentEventToMessages(
        r1.messages,
        r1.runCtx,
        { type: 'tool_result_start', toolCallId: 'tc1', messageId: 'm2' },
        r1,
      );
      expect(r2.retryStatus).toBeNull();
    });

    it('tool_execution_start → 清 retryStatus', () => {
      const r0 = activeRun();
      const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, llmAttempt('RETRY', 1, 3), r0);
      const r2 = applyAgentEventToMessages(
        r1.messages,
        r1.runCtx,
        { type: 'tool_execution_start', toolNames: ['bash'], toolCallIds: ['tc1'] },
        r1,
      );
      expect(r2.retryStatus).toBeNull();
    });
  });

  it('run_end → 兜底清 retryStatus=null（FAIL 耗尽交棒 run-finish）', () => {
    const r0 = activeRun();
    const r1 = applyAgentEventToMessages(r0.messages, r0.runCtx, llmAttempt('RETRY', 3, 3), r0);
    expect(r1.retryStatus).not.toBeNull();
    const r2 = applyAgentEventToMessages(
      r1.messages,
      r1.runCtx,
      { type: 'run_end', runId: 'r1', sessionId: 's1', stopReason: 'error' },
      r1,
    );
    expect(r2.retryStatus).toBeNull();
  });

  it('纯函数：llm_attempt 不 mutate 入参 state', () => {
    const r0 = activeRun();
    const snapshot: ReducerState = { ...r0 };
    applyAgentEventToMessages(r0.messages, r0.runCtx, llmAttempt('RETRY', 1, 3), r0);
    expect(r0.retryStatus).toBe(snapshot.retryStatus); // 入参 state.retryStatus 未被 mutate
    expect(r0.loadingPhase).toBe(snapshot.loadingPhase);
  });

  it('零回归：无 llm_attempt 事件时 retryStatus 恒 null（旧回放路径）', () => {
    let r = activeRun();
    expect(r.retryStatus == null).toBe(true);
    r = applyAgentEventToMessages(
      r.messages,
      r.runCtx,
      { type: 'message_start', messageId: 'm1', sessionId: 's1', role: 'assistant' },
      r,
    );
    expect(r.retryStatus == null).toBe(true);
  });
});
