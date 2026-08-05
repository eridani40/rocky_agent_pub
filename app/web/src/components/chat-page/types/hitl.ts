/**
 * HITL（Human-in-the-Loop）交互载荷类型 —— ask-question + approval 两类 pending 载荷的 UI 镜像。
 * 参考: specs/api/overall/04-agent-session.md §3.6 + §3.2 toolReply
 *       specs/ui/components/chat-page/component-pending-question-card.md §3
 *       specs/ui/components/chat-page/component-pending-approval-card.md §Props
 *       specs/tech/agent/tools/[P0]tool_permission.md §4/§5/§6
 *
 * 对齐后端 app/server/src/tools/types.ts（Question / FeedbackData / ApprovalData / PendingToolCall）。
 *
 * 拆分自原 chat-page/types.ts（v0.0.156 纯拆分，类型定义 + 类型守卫函数实现 100% 不变）。
 */

// ============================================================
// [v0.0.101] HITL ask-question 载荷类型（UI 镜像，对齐后端 tools/types.ts）
// 参考: specs/api/overall/04-agent-session.md §3.6 + §3.2 toolReply
//       specs/ui/components/chat-page/component-pending-question-card.md §3
// ============================================================

/** 单个提问项的选项（UI 子集） */
export interface PendingQuestionOption {
  /** 选项 key（提交时按 key 汇总；选项个体无 testid，按可见 label 文案定位） */
  key: string;
  /** 选项展示文案 */
  label: string;
}

/**
 * 单个提问项（FeedbackData.questions 元素）。
 * 后端权威：app/server/src/tools/types.ts Question。
 */
export interface PendingQuestion {
  /** 问题 id（前端 question 区块 key + FeedbackAnswer.selections 的 key） */
  id: string;
  /** 问题标题 */
  title: string;
  /** 作答类型：single=单选（radio）/ multi=多选（checkbox） */
  type: 'single' | 'multi';
  /** 选项列表 */
  options: PendingQuestionOption[];
  /** 后端声明是否带「其他」选项——前端恒定渲染「其他」不消费本字段（保留仅为持久化/schema 兼容） */
  allowOther?: boolean;
}

/**
 * FeedbackData —— ask-question 的交互载荷（data 字段，subState='need_feedback' 时）。
 * 前端按 questions[] 渲染提问卡（每 question 一区块）；用户答案汇总成 FeedbackAnswer.selections。
 */
export interface FeedbackData {
  /** 可选的整体提示语（卡片头部展示） */
  prompt?: string;
  /** 问题列表（>=1） */
  questions: PendingQuestion[];
}

/**
 * 用户答案载荷（提交时 POST /messages body.toolReply.payload）。
 * selections 按 questionId 聚合选中 option.key 列表；「其他」值格式 `其他：<text>`。
 */
export interface FeedbackAnswer {
  /** { [questionId]: 选中的 option.key 列表（含「其他：<text>」） } */
  selections: Record<string, string[]>;
}

// ============================================================
// [v0.0.122] HITL approval 载荷类型（UI 镜像，对齐后端 tools/types.ts ApprovalData）
// 参考: specs/ui/components/chat-page/component-pending-approval-card.md §Props
//       specs/tech/agent/tools/[P0]tool_permission.md §4/§5/§6
// ============================================================

/**
 * ApprovalData —— 危险 bash 命令审批的交互载荷（data 字段，subState='need_approval' 时）。
 * 前端按 toolName + arguments.command + reason 渲染审批卡；
 * 用户答案为 {decision} payload 通过 submitReply('approval', ...) 回填。
 * 对齐后端 app/server/src/tools/types.ts ApprovalData。
 */
export interface ApprovalData {
  /** 工具名称（如 "bash"） */
  toolName: string;
  /** 工具调用参数（bash 场景含 command: string） */
  arguments: Record<string, unknown>;
  /** 策略层拦截原因（如「rm 通配删除，需用户批准」） */
  reason?: string;
  /** 审批 key（永远同意时的记忆 key，如 'bash:rm-wildcard'） */
  approvalKey?: string;
}

/** handleType 三分发（对齐后端 ToolHandleType） */
export type ToolHandleType = 'direct_result' | 'approval' | 'callback';

/** PendingToolCall subState（渲染分发 key） */
export type PendingToolCallSubState = 'need_feedback' | 'need_approval';

/**
 * PendingToolCall UI 镜像（对齐后端 app/server/src/tools/types.ts PendingToolCall）。
 * 来源：SSE `require_human_input` event.data.pending + GET /pending-tool-call 响应。
 * subState='need_feedback' → data 为 FeedbackData，渲染提问卡；
 * subState='need_approval' → data 为 ApprovalData，渲染审批卡。
 */
export interface PendingToolCallView {
  sessionId: string;
  runId: string;
  /** 关联 tool call id（提交时回填 key + 卡片容器 testid 后缀） */
  toolCallId: string;
  toolName: string;
  handleType: ToolHandleType;
  subState: PendingToolCallSubState;
  /** 交互载荷（subState='need_feedback' → FeedbackData；'need_approval' → ApprovalData） */
  data: FeedbackData | ApprovalData | Record<string, unknown>;
  /** transcript 里占位 block 的编辑目标 message id */
  resultMessageId: string;
  /** transcript 里占位 block 的编辑目标 block index */
  resultBlockIndex: number;
  status: 'pending' | 'resolved';
}

/**
 * 类型守卫：pending.data 是否为 FeedbackData（subState='need_feedback'）。
 * 用于提问卡渲染前判定。
 */
export function isFeedbackData(data: PendingToolCallView['data']): data is FeedbackData {
  return (
    !!data &&
    typeof data === 'object' &&
    Array.isArray((data as FeedbackData).questions)
  );
}

/**
 * 类型守卫：pending.data 是否为 ApprovalData（subState='need_approval'）。
 * 判据：data.toolName 为 string（FeedbackData 无此字段）。
 * 与 isFeedbackData 并列，两者互斥。
 */
export function isApprovalData(data: PendingToolCallView['data']): data is ApprovalData {
  return (
    !!data &&
    typeof data === 'object' &&
    typeof (data as ApprovalData).toolName === 'string'
  );
}
