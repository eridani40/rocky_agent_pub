/**
 * agent.abort action —— 主动中断 child（v0.0.28 task-2）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §6（abort 级联）+ §7（abort_agent）
 *       specs/tech/agent/tools/[P1]agent_tools.md §1（agent.abort）
 *
 * 语义：parent 用它停自己派的 in-flight child（省 token、无 orphan）。
 * - 走 manager.abort(childSid, childRunId, 'current')，child 用【独立 controller】
 * - D6 单向级联：parent abort 时遍历 in-flight child 级联（manager.abort finalize 已实现）；
 *   child 自身 abort/error 不级联 parent
 * - 传递性：child 被 abort 后级联 grandchild…直到无 in-flight 后代
 *
 * 单文件 ≤300 行。
 */
import type { AbortResult } from '../agent-interface';

/** abort 依赖注入接口 */
export interface AbortDeps {
  /** parent sessionId（校验 target ∈ caller.reachable——subagent 仅可达 parent；abort 仅 parent 向下） */
  parentSessionId: string;
  /** 解析 ref（AgentRef / sessionId / "parent" 别名）→ childSessionId */
  resolveRef(ref: unknown): string | null;
  /** 读 child 的 currentRunId（abort 需要 runId） */
  getChildRunId(childSid: string): Promise<string | null>;
  /** manager.abort(sessionId, runId, 'current')（注入实现） */
  abortRun(sessionId: string, runId: string): Promise<AbortResult>;
}

/** abort 结果（成功/失败原因，对齐 AbortResult） */
export interface AbortAgentResult {
  sessionId: string;
  accepted: boolean;
  reason?: 'run_id_mismatch' | 'no_active_controller' | 'cas_failed' | 'child_not_found' | 'not_running';
}

/**
 * 执行 agent.abort action（derivation §6/§7 + agent_tools §1）。
 *
 * 流程：resolve ref → 取 child.currentRunId → 无 run=no_active_controller → manager.abort。
 * 级联：manager.abort 内部 finalize 时 cascadeAbortChildren（parent→child→grandchild）。
 *
 * @param ref   目标（AgentRef / sessionId / "parent" 别名）
 * @param deps  注入依赖（parentSessionId / resolveRef / getChildRunId / abortRun）
 * @returns AbortAgentResult（accepted + 可选 reason）
 */
export async function executeAbort(
  ref: unknown,
  deps: AbortDeps,
): Promise<AbortAgentResult> {
  const childSid = deps.resolveRef(ref);
  if (!childSid) {
    return { sessionId: '', accepted: false, reason: 'child_not_found' };
  }
  const runId = await deps.getChildRunId(childSid);
  if (!runId) {
    return { sessionId: childSid, accepted: false, reason: 'not_running' };
  }
  const result = await deps.abortRun(childSid, runId);
  if (result.accepted) {
    return { sessionId: childSid, accepted: true };
  }
  return { sessionId: childSid, accepted: false, reason: result.reason };
}
