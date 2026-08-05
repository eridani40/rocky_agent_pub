/**
 * AgentLoop stage ③：工具执行 + emit tool_result + observability span（agent-loop 拆分模块）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §2.2
 *       specs/tech/agent/observability/[P0]overall.md §5.4
 *       specs/tech/version_logs/v0.0.101/change_plan.md 模块 C（HITL pending 透传）
 *
 * 职责：把 stageToolExecution 的工具执行编排（base.executeTools 调用 + emit tool_result +
 * observability tool span 跟踪）抽离，主类只保留中断门控 + ingest。
 *
 * 设计：
 *   - executeAndEmit 是纯逻辑函数（注入 toolEngine / obs / emitCtx），无 mode 依赖
 *   - 主类 AgentLoop.stageToolExecution 调用本函数后，自己做中断门控 + ingest
 *   - [v0.0.101] 返回 `{ results, pending }`：pending 透传给 caller（runReActLoop ③ 段）
 *     决定 stopReason / state.done / emit require_human_input（pending 占位 block 也经 emit 暴露）
 */
import type { ToolCallBlock, ToolResultBlock } from '../message/types';
import type { PendingToolCall } from '../tools/types';
import type { ToolExecutionEngine } from '../tools/engine';
import type { ChildProcessRegistry } from '../tools/child-process-registry';
import type { EmitContext } from './agent-loop-emitters';
import { emitToolResult } from './agent-loop-emitters';
import type { LoopObservability } from './agent-loop-observability';
import type { SpanHandle } from '../observability/types';
import { executeTools as baseExecuteTools } from './agent-loop-base';

/** executeAndEmit 输入参数 */
export interface ExecuteAndEmitInput {
  toolEngine: ToolExecutionEngine;
  /** config 透传给引擎（caller 负责 cast 成 ToolSessionConfigLike 兼容形态） */
  config: Parameters<ToolExecutionEngine['execute']>[0];
  toolCalls: ToolCallBlock[];
  /** 白名单（eager=全集；forked=白名单） */
  allowedTools: string[];
  /** emit 上下文（mode 注入） */
  emitCtx: EmitContext;
  /** observability 协调器（缺省 NoopAdapter） */
  obs: LoopObservability;
  /**
   * [v0.0.101] run 上下文（runId 透传引擎构造 PendingToolCall）。
   * [v0.0.130.hang] 加 childRegistry?（沿 opts 透传链下沉到 engine ctx，供 bash 等 spawn 型工具
   * 注册子进程；来源 = spec.controller.childRegistry，caller run-react-loop 透传）
   */
  opts?: { runId?: string; childRegistry?: ChildProcessRegistry };
}

/** [v0.0.101] executeAndEmit 返回：results（含 pending 占位 block）+ pending 队列 */
export interface ExecuteAndEmitResult {
  /** ToolResultBlock[]（与 toolCalls 等长同序；含 pending 占位 block status='pending'） */
  results: ToolResultBlock[];
  /** 悬挂队列（顺序对应悬挂 toolCalls 相对顺序；caller 决定 stopReason / state.done） */
  pending: PendingToolCall[];
}

/**
 * 执行 toolCalls + emit tool_result_* + observability tool span 跟踪（agent_loop_base §2.2 + overall §5.4）。
 *
 * 流程：
 *   1. 每个 toolCall 引擎跑前 startSpan（parent=step span）
 *   2. 一次性调 base.executeTools（含 allowedTools 门控，引擎内串行 + HITL 钩子）
 *   3. 逐 result emit tool_result（含 pending 占位 block）+ endSpan
 *
 * [v0.0.101] 返回 `{ results, pending }`：pending 透传给 caller 决定 stopReason。
 * pending 占位 block 也在 results 中（status='pending'），与对应 toolCall 配对（INV-1 合法 pair）。
 *
 * @returns { results, pending }（caller 负责 ingest / 追加内存 / 决定 stopReason）
 */
export async function executeAndEmit(
  input: ExecuteAndEmitInput,
): Promise<ExecuteAndEmitResult> {
  const { toolEngine, config, toolCalls, allowedTools, emitCtx, obs, opts } = input;
  // observability: 每个 toolCall 引擎跑前 startSpan（parent=step span，overall §5.4）
  const toolSpanStarts: { handle: SpanHandle; startTime: Date; call: ToolCallBlock }[] =
    toolCalls.map((call) => ({
      call,
      startTime: new Date(),
      handle: obs.startToolSpan(call),
    }));
  // 调 base.executeTools 原语（agent_loop_base §2.2，含 allowedTools 门控 + HITL 钩子）
  const { results, pending } = await baseExecuteTools({
    toolEngine,
    config,
    toolCalls,
    allowedTools,
    opts,
  });
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    emitToolResult(emitCtx, result);
    const started = toolSpanStarts[i];
    if (started) obs.endToolSpan(started.handle, result, started.startTime);
  }
  return { results, pending };
}
