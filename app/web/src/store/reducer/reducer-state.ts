/**
 * reducer-state —— reducer 输入/输出状态切片类型（从 chat-slice-reducer.ts 拆出）
 * 参考: specs/ui/components/chat-page/_overview.md §4.10（loading 阶段）/ §4.13（run-finish）
 *       specs/tech/version_logs/v0.0.95.lifecycle_buffer/change_plan.md §B（reducer 纯化：runCtx 值传递）
 *
 * 纯类型模块；被 apply-agent-event.ts / useMessages 等消费。
 * v0.0.156 拆分重构：从原单文件 chat-slice-reducer.ts move，**字段/注释 100% 等价**（INV-G1/G2）。
 */
import type { EnqueueItem, LoadingPhase, Message, PendingToolCallView, RunFinish, RunRetryStatus } from '../../components/chat-page/types';

/** 当前 run 上下文（跨多次 applyAgentEvent 维护：累积 messageId / tool_call JSON 片段 / pendingError）
 * [v0.0.25] pendingError 改新契约 { category, displayReason, detail?, code? }（对齐 RunFinish.error） */
export interface RunContext {
  runId: string;
  currentAssistantMessageId?: string;
  toolCallRawArgs?: Map<string, string>;
  pendingError?: NonNullable<RunFinish['error']>;
  /** [v0.0.130.hang] 当前执行中的 tool 名列表（tool_execution_start 置 / tool_execution_end 清），随 runCtx 跨帧累积 */
  runningToolNames?: string[];
}

/** reducer 输入状态切片 */
export interface ReducerState {
  loadingPhase: LoadingPhase | null;
  runActive: boolean;
  lastRunFinish: RunFinish | null;
  /** [v0.0.12] enqueue-view 排队项 */
  enqueueItems: EnqueueItem[];
  /**
   * [v0.0.101] HITL 悬挂 tool call 队首（ask-question）。
   * 来源：SSE require_human_input + onInit GET /pending-tool-call（recover）。
   * 可见性 = pendingToolCall !== null（提问卡 mount/unmount 主判定）。
   * 多 pending 串行展示（INV-4）：resolve 一条后后端 emit 下一个驱动切换；
   *   提交后前端乐观置 null（unmount），由后端 emit 下一个或继续 LLM。
   */
  pendingToolCall: PendingToolCallView | null;
  /**
   * [v0.0.130.hang] 当前执行中的 tool 名列表（供 loading spinner 渲染「运行工具: X」）。
   * tool_execution_start 置 / tool_execution_end + run_end 清；旧回放无 execution 事件时保持
   * undefined（仅 tool_result_start 兜底置 tool_executing 阶段，无具体 tool 名可显）。
   */
  runningToolNames?: string[];
  /**
   * [v0.0.144] 「重试中」叠加态（LLM 失败自动重试进度）。
   * llm_attempt(RETRY/ROTATE_KEY/FALLBACK) 置 / 后续正常运行事件（assistant message_start /
   *   text_block_delta / tool_call_start / tool_result_start / tool_execution_start）+ run_end 清。
   * 非空时气泡显「重试中 {attempt}/{maxAttempts}」+ ！icon；空 → 原 4 态零回归。
   */
  retryStatus?: RunRetryStatus | null;
}

/** reducer 输出（messages + 状态切片） */
export type ReducerResult = ReducerState & { messages: Message[] };

/** v0.0.95 纯化：reducer 返回值含新 runCtx（消费方写回 buffer.runCtx，纯函数无 ref 副作用） */
export type ReducerFullResult = ReducerResult & { runCtx: RunContext | null };
