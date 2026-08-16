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
   * [v0.0.354 T1] 加 onResult?（透传 engine）：在 executeAndEmit 内部 emit/span 之后调用（观察用）
   */
  opts?: {
    runId?: string;
    childRegistry?: ChildProcessRegistry;
    onResult?: (result: ToolResultBlock, index: number) => void;
  };
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
 * [v0.0.354 T1] 逐个化改造（BUG-multi-tool-result-sse-batch）：
 *   - 删除「批量预起 span + await 全批后同步连发」旧流程（快工具结果被最慢工具扣住，span 时长失真）
 *   - 改为 engine 增量回调 onResult：每个 result 到达即 emitToolResult + endToolSpan；
 *     startToolSpan 逐个化（进一个 tool 起一个，startTime=该 tool 真实开始时刻）
 *   - 返回值 `{ results, pending }` 契约不变（等长同序 + HITL pending 同序）
 *   - 帧序不变式保持：每 result 的 start/delta/end 三帧相邻，全部 result 帧先于 tool_execution_end
 *     （execution_end 由 caller 在 executeAndEmit 返回后 emit）
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
  // [v0.0.354 T1] 回调注入：每个 result 到达即 emit + endSpan（emitCtx 两态均安全——publish 按 group 开关早退）。
  // span 逐个化：startToolSpan 进一个起一个；startTime 用串行语义推导——tool i 的真实开始时刻 =
  // 上一 result 完成时刻（= 上一回调时刻），第一个 tool 用 execute 起点。span 时长回归真实执行时长
  // （不再被批量预起的 t0 拉长到含排队时间）。
  let prevStartTime = new Date(); // execute 起点（第一个 tool 的开始时刻）
  const onResult = (result: ToolResultBlock, index: number): void => {
    const startTime = prevStartTime;
    prevStartTime = new Date(); // 本次 result 完成时刻 = 下一个 tool 的开始时刻（串行）
    const call = toolCalls[index];
    const handle = call ? obs.startToolSpan(call) : undefined;
    try {
      emitToolResult(emitCtx, result);
    } finally {
      // span 闭合不因 emit 异常而悬挂（emit 异常由 engine pushResult fail-silent 吞掉）
      if (handle) obs.endToolSpan(handle, result, startTime);
    }
    // 透传调用方观察回调（如测试/日志；异常由 engine pushResult fail-silent 兜底）
    opts?.onResult?.(result, index);
  };
  // 调 base.executeTools 原语（agent_loop_base §2.2，含 allowedTools 门控 + HITL 钩子）
  // [v0.0.354 T1] 经 opts.onResult 注入回调（engine 每 result push 即调，emit 随执行逐个发）
  const { results, pending } = await baseExecuteTools({
    toolEngine,
    config,
    toolCalls,
    allowedTools,
    opts: { ...opts, onResult },
  });
  return { results, pending };
}
