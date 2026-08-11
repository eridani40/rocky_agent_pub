/**
 * message 子域类型 —— UI Message 模型 + 视图拍平结构（对齐后端 Message + ContentBlock 子集）。
 * 参考: specs/tech/agent/message/[P0]agent_message_interface.md
 *       specs/ui/components/chat-page/_overview.md §2
 *
 * UI 不发明新模型，消费真实 Message + ContentBlock 子集。ReasoningBlock 不渲染（§6）。
 * 视图层合并：把 Message[] 拍平为 view-element 序列（user 文本 / agent answer 文本 /
 * tool-call-item(call+绑定result)），连续 tool-call-item 合并为 tool-batch（跨消息边界）。
 *
 * 拆分自原 chat-page/types.ts（v0.0.156 纯拆分，类型定义 100% 不变）。
 */

/**
 * [v0.0.105] UI 图片块（对齐后端 ImageBlock spec 形：source.kind 判别联合 + mediaType 顶层）。
 * 后端权威：app/server/src/message/types.ts ImageBlock。computer use get_app_state 的 tool_result
 * content 含 image + text 双 block；UI P1 最小占位渲染（缩略 + click 展开）。
 */
export type ImageBlockView = {
  type: 'image';
  source: { kind: 'url'; url: string } | { kind: 'base64'; data: string };
  mediaType: string;
};

/** [v0.0.105] tool_result 内容块 UI 子集（text + image，computer use 返 image+text 双 block） */
export type ToolResultContentBlock = { type: 'text'; text: string } | ImageBlockView;

/** UI 关心的 ContentBlock 子集（对齐 message interface §4） */
export type ContentBlock =
  | { type: 'text'; text: string; isSystemReminder?: boolean }
  | ImageBlockView
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | {
      type: 'tool_result';
      toolCallId: string;
      content: ToolResultContentBlock[];
      isError: boolean;
    }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: Record<string, number> };

/**
 * AgentRef UI 子集（a2a sender.agent.ref 用于 squad 群聊白名单 + 角色名）。
 * 后端权威：app/server/src/message/types.ts AgentRef（UI 宽松读 name/type）。
 */
export interface AgentRefView {
  type: 'leader' | 'mate' | string;
  sessionId: string;
  name: string;
}

/**
 * MessageSender UI 镜像：对齐后端判别联合（discriminated union，读 agent.ref）。
 * 后端权威：message/types.ts MessageSender（session-store-converters.ts:139 原样透传，wire 形态 = 后端联合）。
 */
export type MessageSender =
  | { source: 'agent'; agent: { ref: AgentRefView; needReply: boolean; inReplyTo?: string } }
  | {
      source: 'user';
      /**
       * IM 渠道来源（slim 镜像后端 sender.channel，只取 type/configId 用于来源徽标；
       * imUserId/imUserName 是 PII，不透前端）。web client 消息无此字段（向后兼容，不显徽标）。
       */
      channel?: { type: string; configId: string };
    }
  | { source: 'system'; system: { kind: string; refId?: string } }
  | { source: 'approval'; approval: { toolCallId: string; decision: 'allow' | 'allow_always' | 'deny' } };

/** 真实 Message（对齐 message interface §5，UI 用子集） */
export interface Message {
  id: string;
  sessionId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ContentBlock[];
  runId?: string;
  createdAt: string;
  updatedAt?: string;
  version?: number;
  sender?: MessageSender;
  /** 扩展元数据（业务侧 message 透传，如 cron/heartbeat 等系统消息携带的 meta） */
  metadata?: Record<string, unknown>;
  /**
   * 所属 run 的 stopReason（GET /messages 后端 join runs/{runId}.json 下发；全部类型原样下发，
   * run 未结束 / 无 runId 的消息无此字段）。冷读 seed lastRunFinish 用（use-messages onInit），
   * 展示与 SSE run_end 走同一 ComponentRunFinish 链路。
   */
  stopReason?: string;
  /** 所属 run 的失败信息（stopReason='error' 时下发；server RunErrorInfo 形状） */
  runError?: { errorCategory: string; displayReason: string; errorDetail?: string };
}

/** run 结束原因（对齐 agent_event.md §4.1 + agent_loop.md §2）
 *  [v0.0.101] 加 'tool_pending'（HITL 悬挂态）；删 'require_approval'（O7 代决废弃，被 tool_pending 取代） */
export type StopReason =
  | 'no_tool_call'
  | 'no_new_messages'
  | 'max_iterations'
  | 'doom_loop'
  | 'error'
  | 'tool_pending'
  | 'interrupted';

/** 视图元素（拍平 Message[] 后的渲染单元，§2 rule5） */
export type ViewElement =
  | {
      kind: 'user-text';
      key: string;
      messageId: string;
      text: string;
      name?: string;
    }
  | { kind: 'agent-answer'; key: string; messageId: string; textIndex: number; text: string }
  | {
      kind: 'tool-call-item';
      key: string;
      messageId: string;
      toolCallId: string;
      name: string;
      arguments: Record<string, unknown>;
      result?: {
        content: ToolResultContentBlock[];
        isError: boolean;
      };
    }
  | {
      /** send_message 信封视图元素（独立信封渲染，不进 tool-batch）。result 绑定同 tool-call-item。 */
      kind: 'send-message-envelope';
      key: string;
      messageId: string;
      toolCallId: string;
      arguments: Record<string, unknown>;
      result?: {
        content: ToolResultContentBlock[];
        isError: boolean;
      };
    };

/** loading 阶段（§4.10，从 SSE 事件派生） */
export type LoadingPhase = 'thinking' | 'answering' | 'tool_calling' | 'tool_executing';

/**
 * [v0.0.144] 运行气泡「重试中」叠加态（§4.10 第 5 态；PRD 03-run-spinner-retry.md）。
 * LLM 调用失败进入自动重试/换 key/降级时的进度外显，独立于 4 阶段 LoadingPhase 之外的叠加态。
 * 数据流：后端 llm_attempt SSE（补 maxAttempts + message 字段）→ chat-slice-reducer 消费置态
 *   → use-messages → section-chat-session → component-message-stream → ComponentLoadingStatus。
 */
export interface RunRetryStatus {
  /** 当前进行到第几次尝试（1-based；reducer 侧已 Math.min(attempt, maxAttempts) clamp 防越界 4/3） */
  attempt: number;
  /** 该请求允许的最大尝试次数（= llm_request config retry.max_attempts，v0.0.144 config 接线修复后才真实） */
  maxAttempts: number;
  /** 本次错误的用户可读文案（后端 deriveDisplayReason(category) 派生，hover ！icon 展示） */
  message: string;
}

/** run 结束态（§2 rule7，仅 last run 渲染）
 * error 契约对齐后端 RunErrorInfo（specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §9.1）：
 * { category, displayReason, detail?, code? }，来源 = SSE error 事件 errorCategory/displayReason/errorDetail。 */
export interface RunFinish {
  stopReason: StopReason;
  error?: {
    /** 错误分类（LlmErrorCategory 枚举值，如 PROVIDER_OVERLOADED / AUTH_INVALID） */
    category: string;
    /** 用户可读一句话（如「认证失败，请检查 API Key」），默认展示（非 hover 也可见） */
    displayReason: string;
    /** 完整细节（raw provider message），hover tooltip 显；可空 */
    detail?: string;
    /** 短 code 标签（如 RATE_LIMITED / 401），可空 */
    code?: string;
  };
}

/** 从 Message[] + 已知 last run runId 计算视图元素序列 + tool-batch 分组 + last-run finish */
export interface FlattenedView {
  /** 拍平后的视图元素序列（user-text / agent-answer / tool-call-item，reasoning 跳过） */
  elements: ViewElement[];
  /** tool-batch 分组：每组 = 连续 tool-call-item 的 element-key 数组（§2 rule5） */
  batches: { key: string; elementKeys: string[] }[];
  /** 每个 element 所属 batch key（非 tool 元素为 null） */
  elementBatch: Map<string, string | null>;
}
