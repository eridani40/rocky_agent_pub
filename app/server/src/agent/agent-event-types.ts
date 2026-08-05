/**
 * AgentEvent 联合类型（agent 事件权威源）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §2 §3 §8
 *       specs/tech/version_logs/v0.0.8/change_log.md §4（StopReason 6 枚举）
 *       specs/tech/version_logs/v0.0.101/change_plan.md 模块 C（tool_pending 替代 require_approval）
 *
 * 核心：AgentEvent 是 Agent 执行过程中的流式进度单元（topic=agent_loop）。
 * 一次 run 产生的事件序列累积后可重建出对应 Message（agent_event.md §9）。
 *
 * 事件类型（对齐 agent_event.md §3 总览）：
 *   - 生命周期：run_start / run_end / message_start / message_end
 *   - enqueue：message_enqueued / enqueued_message_processed / enqueued_message_canceled
 *   - 文本流：text_block_{start,delta,end}
 *   - 思维流：reasoning_block_{start,delta,end}
 *   - 工具调用：tool_call_{start,delta,end}
 *   - 工具结果：tool_result_{start,delta,end}
 *   - 一次性：usage_block / error / custom
 *   - HITL：require_human_input（[v0.0.101] 实际 emit，携队首 PendingToolCall）
 * 图片流（image_block_*）不实现，不在此声明。
 * StopReason 7 枚举（v0.0.101 起 require_approval 退役，加 tool_pending）。
 */
import type {
  MessageRole,
  MessageSource,
  ContentBlock,
  Usage,
} from '../message/types';
// LlmErrorCategory（ErrorEvent.errorCategory + LlmAttemptEvent.category 用）
import type { LlmErrorCategory } from '../llm/caller/error_types';
// PendingToolCall（RequireHumanInputEvent.payload 用，type-only）
import type { PendingToolCall } from '../tools/types';
// RunKind（AgentEventBase.runKind 闭合枚举；v0.0.204 扁平化）
import type { RunKind } from '../../../shared/src/types/session-kind';

/**
 * StopReason 唯一权威枚举（v0.0.101 起 require_approval 退役为 tool_pending）。
 *
 * - tool_pending：[v0.0.101] HITL 悬挂退出（ask-question / 审批型 tool 触发），run 终态，
 *     session.state 转 suspended（非 idle）；由 runReActLoop ③ 段在 executeToolsForSpec
 *     返 pending.length>0 时设置 + emit require_human_input(队首)
 * - require_approval：已退役（v0.0.101 O7 代决废弃，被 tool_pending 取代；零 emit 故安全删）
 */
export type StopReason =
  | 'no_tool_call'
  | 'no_new_messages'
  | 'max_iterations'
  | 'doom_loop'
  | 'error'
  | 'tool_pending' // [v0.0.101] HITL 悬挂退出（替代退役的 require_approval）
  | 'interrupted'; // abort api 收尾 emit run_stop 用（loop 自身不发此 reason）

/** AgentEventType discriminated union key（agent_event.md §8） */
export type AgentEventType =
  | 'run_start'
  | 'run_end'
  | 'message_start'
  | 'message_end'
  | 'message_enqueued'
  | 'enqueued_message_processed'
  | 'enqueued_message_canceled'
  | 'text_block_start'
  | 'text_block_delta'
  | 'text_block_end'
  | 'reasoning_block_start'
  | 'reasoning_block_delta'
  | 'reasoning_block_end'
  | 'tool_call_start'
  | 'tool_call_delta'
  | 'tool_call_end'
  | 'tool_result_start'
  | 'tool_result_delta'
  | 'tool_result_end'
  | 'usage_block'
  | 'error'
  // LlmCaller retry/fallback 进度实时外显（spec §3.1 / api change_log §1.4）
  | 'llm_attempt'
  | 'custom'
  | 'require_human_input'
  // [v0.0.130.hang] ③ 段工具执行阶段事件（P6-backend，填 message_end→tool_result 之间的空白）
  | 'tool_execution_start'
  | 'tool_execution_end';

/**
 * 所有 Agent 事件继承的公共字段（agent_event.md §2）。
 *
 * `runKind: RunKind` 必填。取值：主对话="main" / forked summary="summary" / forked 记忆抽取="consolidate"（v0.0.204 扁平闭合枚举）。
 * 用于事件 group 路由（groupKey 命名 `session_id:<sid>_amt:<runKind>`）+ 前端按 runKind 分流。
 */
export interface AgentEventBase {
  /** 事件自身 ULID */
  id: string;
  type: AgentEventType;
  /** 归属 session（唯一一定存在的业务字段） */
  sessionId: string;
  /** ISO 8601 UTC */
  createdAt: string;
  /**
   * agent run kind（agent_interface §4 + agent_event.md §2；v0.0.204 RunKind 扁平闭合枚举）。
   * 必填。取值："main"（主对话 eager/lazy）/ "summary"（forked 压缩）/ "consolidate"（forked 记忆抽取）。
   * groupKey 命名规范：`session_id:<sid>_amt:<runKind>`。
   */
  runKind: RunKind;
  /** 关联的 Message ULID（content/message 级事件） */
  messageId?: string;
  /** 关联的 agent run ULID（run 内事件） */
  runId?: string;
  /** 关联的 inbox 入队句柄（enqueue 级事件） */
  enqueueId?: string;
}

// ============================================================
// 生命周期 — Run 级
// ============================================================

export interface RunStartEvent extends AgentEventBase {
  type: 'run_start';
  /** 传入的 message id 列表 */
  inputMessageIds: string[];
}

export interface RunEndEvent extends AgentEventBase {
  type: 'run_end';
  stopReason: StopReason;
}

// ============================================================
// 生命周期 — Message 级
// ============================================================

/**
 * message_start 事件中携带的 sender 最小子集。
 * 仅携带前端重建 sender 身份所需字段：
 *   - source='agent'：a2a 消息，携带 agent.ref（type/sessionId/name 供 isA2aInbox 判定 + 成员名解析）
 *   - 其他 source 暂不携带（user channel 走 origin 字段，向后兼容）
 */
export type MessageStartSender =
  | { source: 'agent'; agent: { ref: { type: string; sessionId: string; name: string } } };

export interface MessageStartEvent extends AgentEventBase {
  type: 'message_start';
  role: MessageRole;
  /** 业务侧 message 透传 Message.metadata（如 cron/heartbeat 等系统消息携带的 meta）；LLM 路径不发 */
  metadata?: Record<string, unknown>;
  /**
   * 用户消息来源信封（仅 role=user 携带，派生自 sender.channel；
   * client 无 channel → {type:'client', configId:'0'}，非 user role 不带）。
   * 是「信封元数据」——绝不进发给 LLM 的 content（protocol-encode 不读）。
   * accumulator（echo 屏蔽 + 跨渠道渲染）与 client（来源徽标）消费事件时，origin 唯一来源就是本字段。
   * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §4.2
   */
  origin?: { type: string; configId: string };
  /**
   * [v0.0.119] 消息作者身份（a2a inbox 消息必填）。
   * source='agent' 时携带 agent.ref，供前端 isA2aInbox 判定 + 成员名/头像解析。
   * 修复 SSE 实时推送时 a2a 消息被误判为 YOU 的问题（BUG-001）。
   * origin 字段（user channel）保留向后兼容，二者各司其职。
   */
  sender?: MessageStartSender;
}

export interface MessageEndEvent extends AgentEventBase {
  type: 'message_end';
}

// ============================================================
// Enqueue 级（入队 → 处理配对，agent_event.md §4.3）
// ============================================================

/** 入队时发出（AgentManager.enqueue 时刻，run 之外） */
export interface MessageEnqueuedEvent extends AgentEventBase {
  type: 'message_enqueued';
  /** 入队句柄（窄化必填） */
  enqueueId: string;
  source: MessageSource;
  role: MessageRole;
  /** 完整内容供 enqueue view 直接渲染 */
  content: ContentBlock[];
}

/** 入队消息被 loop 消费时发出 */
export interface EnqueuedMessageProcessedEvent extends AgentEventBase {
  type: 'enqueued_message_processed';
  enqueueId: string;
  /** 处理时生成的真身 id */
  messageId: string;
  role: MessageRole;
}

/**
 * drain 同批拿到 message + cancel（同 enqueueId）时发出（design 板块 3.4）。
 * 该 message 被作废：不生成 messageId、不写主 store、不进对话流。
 * 与 message_enqueued（建）/ enqueued_message_processed（处理移除）配对，
 * 构成「入队 → 处理 | 取消」完整生命周期。
 */
export interface EnqueuedMessageCanceledEvent extends AgentEventBase {
  type: 'enqueued_message_canceled';
  /** 被作废的入队句柄（窄化必填），前端据此从 enqueue view 移除 */
  enqueueId: string;
}

// ============================================================
// 文本流
// ============================================================

export interface TextBlockStartEvent extends AgentEventBase {
  type: 'text_block_start';
  blockId: string;
}
export interface TextBlockDeltaEvent extends AgentEventBase {
  type: 'text_block_delta';
  blockId: string;
  delta: string;
}
export interface TextBlockEndEvent extends AgentEventBase {
  type: 'text_block_end';
  blockId: string;
}

// ============================================================
// 思维流（UI 不渲染但事件仍发 + 后端落库）
// ============================================================

export interface ReasoningBlockStartEvent extends AgentEventBase {
  type: 'reasoning_block_start';
  blockId: string;
}
export interface ReasoningBlockDeltaEvent extends AgentEventBase {
  type: 'reasoning_block_delta';
  blockId: string;
  delta: string;
}
export interface ReasoningBlockEndEvent extends AgentEventBase {
  type: 'reasoning_block_end';
  blockId: string;
}

// ============================================================
// 工具调用流
// ============================================================

export interface ToolCallStartEvent extends AgentEventBase {
  type: 'tool_call_start';
  blockId: string;
  toolCallId: string;
  toolName: string;
}
export interface ToolCallDeltaEvent extends AgentEventBase {
  type: 'tool_call_delta';
  blockId: string;
  toolCallId: string;
  /** 增量 JSON 片段（arguments 的流式拼接） */
  delta: string;
}
export interface ToolCallEndEvent extends AgentEventBase {
  type: 'tool_call_end';
  blockId: string;
  toolCallId: string;
}

// ============================================================
// 工具结果流
// ============================================================

export interface ToolResultStartEvent extends AgentEventBase {
  type: 'tool_result_start';
  blockId: string;
  toolCallId: string;
}
export interface ToolResultDeltaEvent extends AgentEventBase {
  type: 'tool_result_delta';
  blockId: string;
  toolCallId: string;
  delta: string;
}
export interface ToolResultEndEvent extends AgentEventBase {
  type: 'tool_result_end';
  blockId: string;
  toolCallId: string;
  isError: boolean;
}

// ============================================================
// 一次性事件
// ============================================================

export interface UsageBlockEvent extends AgentEventBase {
  type: 'usage_block';
  usage: Usage;
}

export interface ErrorEvent extends AgentEventBase {
  type: 'error';
  message: string;
  /** 错误码，如 RATE_LIMIT / TOOL_EXECUTION_FAILED */
  code: string;
  /**
   * LLM 错误分类（agent loop run 失败时填）。
   * 参考: specs/api/version_logs/v0.0.25/change_log.md §1.2
   * 按真实 category 给（如 PROVIDER_OVERLOADED / AUTH_INVALID 等）。
   * 可选字段：旧 caller 仍读 message/code（向后兼容）。
   */
  errorCategory?: LlmErrorCategory;
  /**
   * 用户可读理由（从 errorCategory 派生，前端可直接显示）。
   * 完整映射表见 specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §1。
   */
  displayReason?: string;
  /**
   * raw provider message（给 debug tooltip / log，不直接给终端用户）。
   */
  errorDetail?: string;
}

/**
 * LlmCaller retry / fallback 进度实时外显事件。
 * 参考: specs/tech/agent/llm_caller/[P0]llm_caller.md §3.1
 *       specs/api/version_logs/v0.0.25/change_log.md §1.4
 *
 * 每次 attempt 失败 decide 产 action 时发一次（attempt 1 首次成功不发）；
 * 整链 all_dead 发 action:FAIL；用户 abort 不发（走原 abort 路径）。
 * caller 语义：可选消费——前端据 action 显示进度（RETRY→重试中/ROTATE_KEY→切换凭证/
 * FALLBACK→切换备用模型/FAIL→进入 error 终态）。不阻塞主流程。
 */
export interface LlmAttemptEvent extends AgentEventBase {
  type: 'llm_attempt';
  /** 本次 attempt 失败的错误分类 */
  category: LlmErrorCategory;
  /** 失败目标 provider id */
  providerId: string;
  /** 失败目标 model id */
  modelId: string;
  /** 失败目标 key 引用（health 四元组之一） */
  keyRef?: string;
  /** 第几次 attempt（1-based） */
  attempt: number;
  /** 本次 invoke 的最大 attempt 次数（= config.retry.max_attempts，前端「重试中 x/x」分母） */
  maxAttempts: number;
  /** decide 产的动作：RETRY=退避重试 / ROTATE_KEY=换 key / FALLBACK=换 provider / FAIL=进入终态 */
  action: 'RETRY' | 'ROTATE_KEY' | 'FALLBACK' | 'FAIL';
  /** category 对应的用户可读文案（前端 hover 展示，deriveDisplayReason 派生） */
  message: string;
}

export interface CustomEvent extends AgentEventBase {
  type: 'custom';
  name: string;
  value: Record<string, unknown>;
}

// ============================================================
// HITL（[v0.0.101] 实际 emit，payload breaking：队首单个 PendingToolCall）
// ============================================================

/**
 * [v0.0.101] HITL 悬挂事件（loop ③ 段 pending.length>0 时 emit 队首单个）。
 *
 * payload breaking change（v0.0.101）：
 *   - 旧：`{ toolCalls: ToolCallBlock[]; prompt? }`（从未实际 emit，spec 占位）
 *   - 新：`{ pending: PendingToolCall }`（队首单个；多 pending 串行展示，INV-4 peek 队首）
 *
 * emit 时机：runReActLoop ③ 段 executeToolsForSpec 返 pending.length>0 → emit 本事件携队首 +
 *   state.stopReason='tool_pending' + state.done=true break；onRunEnd 据 stopReason 调 markSuspended。
 *
 * 前端订阅本事件（useMessages reducer）→ mount 提问卡 / 审批卡（按 pending.subState 分发）。
 */
export interface RequireHumanInputEvent extends AgentEventBase {
  type: 'require_human_input';
  /** 队首悬挂 tool call（前端据此渲染；多 pending 串行展示，resolve 后 emit 下一个） */
  pending: PendingToolCall;
}

// ============================================================
// [v0.0.130.hang] 工具执行阶段事件（P6-backend）
// ============================================================

/**
 * [v0.0.130.hang] 标记③段「工具执行开始」（executeToolsForSpec 调用前 emit）。
 * 与 agent.log 的 loop_tools_begin breadcrumb 同址、同字段（toolNames/toolCallIds），
 * 目的是把 message_end → tool_result_start 之间「LLM 已决定调工具但结果尚未返回」的
 * 空白期外显给前端（修 hang 时 UI 仍停在「思考中」）。
 *
 * MUST NOT 复用 tool_result_start：该事件语义=单个工具结果已开始返回（执行已结束），
 * 无法表达「执行中」阶段。
 */
export interface ToolExecutionStartEvent extends AgentEventBase {
  type: 'tool_execution_start';
  /** 本轮待执行的工具名列表（与 toolCallIds 一一对应） */
  toolNames: string[];
  /** 本轮待执行的 tool call id 列表 */
  toolCallIds: string[];
}

/**
 * [v0.0.130.hang] 标记③段「工具执行结束」（ingestToolResults 之后 emit）。
 * 与 agent.log 的 loop_tools_end breadcrumb 同址、同字段（resultCount/pendingCount）。
 */
export interface ToolExecutionEndEvent extends AgentEventBase {
  type: 'tool_execution_end';
  /** 本轮已产出的工具结果数量 */
  resultCount?: number;
  /** 本轮悬挂（HITL）数量 */
  pendingCount?: number;
}

// ============================================================
// 联合类型
// ============================================================

export type AgentEvent =
  | RunStartEvent
  | RunEndEvent
  | MessageStartEvent
  | MessageEndEvent
  | MessageEnqueuedEvent
  | EnqueuedMessageProcessedEvent
  | EnqueuedMessageCanceledEvent
  | TextBlockStartEvent
  | TextBlockDeltaEvent
  | TextBlockEndEvent
  | ReasoningBlockStartEvent
  | ReasoningBlockDeltaEvent
  | ReasoningBlockEndEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | ToolResultStartEvent
  | ToolResultDeltaEvent
  | ToolResultEndEvent
  | UsageBlockEvent
  | ErrorEvent
  | LlmAttemptEvent
  | CustomEvent
  | RequireHumanInputEvent
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent;
