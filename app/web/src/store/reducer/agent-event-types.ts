/**
 * agent-event-types —— SSE AgentEvent 类型定义（从 chat-slice-reducer.ts 拆出）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §8 + §9（事件→Message 映射）
 *       specs/tech/version_logs/v0.0.95.lifecycle_buffer/change_plan.md §T1 §B（reducer 纯化）
 *
 * 纯类型模块（leaf，无运行时依赖）；被 reducer-state.ts / apply-agent-event.ts / useMessages 等消费。
 * v0.0.156 拆分重构：从原单文件 chat-slice-reducer.ts move 类型定义，**签名/注释 100% 等价**（INV-G1/G2）。
 */
import type { ContentBlock, Message, PendingToolCallView, RunFinish } from '../../components/chat-page/types';

/** [v0.0.144] llm_attempt 事件的 decide 动作：重试类（RETRY/ROTATE_KEY/FALLBACK）进重试态；FAIL 终态不进 */
export type LlmAttemptAction = 'RETRY' | 'ROTATE_KEY' | 'FALLBACK' | 'FAIL';

/**
 * message_start 事件中的 sender 身份最小子集。
 * 目前只支持 source='agent'（a2a inbox 消息），携带 agent.ref 供 isA2aInbox 判定 + 成员名解析。
 * [v0.0.119] BUG-001 修复：SSE 推送时 a2a 消息因缺少 sender 信息被误判为 YOU。
 */
type MessageStartEventSender =
  | { source: 'agent'; agent: { ref: { type: string; sessionId: string; name: string } } };

/** AgentEvent（前端消费的子集，对齐 agent_event.md §8 + v0.0.12 enqueue 级三事件） */
export type AgentEvent =
  | { type: 'run_start'; runId: string; sessionId: string }
  | { type: 'run_end'; runId: string; sessionId: string; stopReason: RunFinish['stopReason'] }
  | {
      type: 'message_start';
      messageId: string;
      sessionId: string;
      role: Message['role'];
      metadata?: Record<string, unknown>;
      origin?: { type: string; configId: string };
      /**
       * [v0.0.119] 消息作者身份（a2a inbox 消息携带）。
       * 优先用本字段重建 Message.sender；source='agent' 时写入 agent.ref 供 isA2aInbox 判定。
       * origin 字段（user channel）保留向后兼容，二者各司其职。
       */
      sender?: MessageStartEventSender;
    }
  | { type: 'message_end'; messageId: string; sessionId: string }
  | { type: 'text_block_delta'; blockId: string; messageId: string; delta: string }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; messageId: string }
  | { type: 'tool_call_delta'; toolCallId: string; messageId: string; delta: string }
  | { type: 'tool_call_end'; toolCallId: string; messageId: string }
  | { type: 'tool_result_start'; toolCallId: string; messageId: string }
  | { type: 'tool_result_delta'; toolCallId: string; messageId: string; delta: string }
  | { type: 'tool_result_end'; toolCallId: string; messageId: string; isError: boolean }
  // [v0.0.130.hang] 标记③段「工具执行开始/结束」（与后端 loop_tools_begin/end breadcrumb 同址）。
  //   填补 message_end → tool_result_start 之间「LLM 已决定调工具但结果尚未返回」的空白期，
  //   修 hang 场景 UI 永停「思考中」——tool_execution_start 到达即置 loadingPhase='tool_executing'
  //   （早于 tool_result_start，见 applyAgentEventToMessages case 处理）。
  | { type: 'tool_execution_start'; toolNames: string[]; toolCallIds: string[] }
  | { type: 'tool_execution_end'; resultCount?: number; pendingCount?: number }
  // [v0.0.25] SSE error 事件：向后兼容 + 新增 errorCategory/displayReason/errorDetail。
  //   新后端发 { errorCategory, displayReason, errorDetail?, message? }；旧后端只发 { message, code }。
  //   reducer 统一映射为 RunFinish.error { category, displayReason, detail?, code? }。
  //   见 specs/api/version_logs/v0.0.25/change_log.md §1.2 + tech llm_caller_rev2_changes.md §3。
  | {
      type: 'error';
      /** 兜底文案（旧后端 / 兜底） */
      message?: string;
      /** 短 code 标签（旧后端，如 RATE_LIMITED / 401） */
      code?: string;
      /** [v0.0.25] 错误分类（LlmErrorCategory 枚举值，权威） */
      errorCategory?: string;
      /** [v0.0.25] 用户可读一句话（默认展示，非 hover 也可见） */
      displayReason?: string;
      /** [v0.0.25] 完整细节（raw provider message，hover tooltip 显） */
      errorDetail?: string;
      runId?: string;
    }
  // [v0.0.12] enqueue 级三事件（design §3.4）
  // BUG-007（v0.0.12）：content 类型对齐后端 MessageEnqueuedEvent.content: ContentBlock[]，
  // 不再误用 string —— 真 LLM 时后端发 [{type:'text',text:'...'}]，
  // reducer 用 contentBlocksToPreviewText 拍平为预览字符串（EnqueueItem.content 仍为 string），
  // 避免 enqueue-view 把 {type,text} 对象当 React child 渲染导致整树崩（Objects are not valid as a React child）。
  | { type: 'message_enqueued'; enqueueId: string; content: ContentBlock[] | string }
  | { type: 'enqueued_message_processed'; enqueueId: string }
  | { type: 'enqueued_message_canceled'; enqueueId: string }
  // [v0.0.101] HITL ask-question 悬挂事件（loop ③ 段 pending.length>0 时 emit 队首单个）
  //   payload breaking change：旧占位 {toolCalls,prompt?} 从未 emit；新 {pending: PendingToolCallView} 队首单个。
  //   多 pending 串行展示（INV-4 peek 队首）：resolve 一条后后端 emit 下一个。
  | { type: 'require_human_input'; pending: PendingToolCallView }
  // [v0.0.144] LLM 调用失败重试事件（后端 llm_attempt SSE，补 maxAttempts + message 字段）。
  //   action ∈ RETRY/ROTATE_KEY/FALLBACK → 气泡切「重试中 x/x」态；FAIL 终态不进（交棒 run-finish）。
  //   前端自定义 event 形状（不依赖 server 类型导入），字段对齐 agent-event-types.ts LlmAttemptEvent。
  | {
      type: 'llm_attempt';
      category: string;
      attempt: number;
      maxAttempts: number;
      message: string;
      action: LlmAttemptAction;
    };
