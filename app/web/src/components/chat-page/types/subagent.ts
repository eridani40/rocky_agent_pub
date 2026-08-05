/**
 * multi_agent subagent 展开树类型（对齐 api 10-multi-agent.md §3.2 ChildrenView + component-subagent-tree.md Props）。
 * 参考: specs/api/overall/10-multi-agent.md §3.2（GET /session/:id/children 响应结构）
 *       specs/ui/components/chat-page/component-subagent-tree.md Props.SubagentNode
 *
 * 拆分自原 chat-page/types.ts（v0.0.156 纯拆分，类型定义 100% 不变）。
 */

/**
 * subagent 节点（component-subagent-tree Props / ChildrenView 子项通用结构）。
 * state 为 session.state 五态之一（running 含 interrupting；terminated = idle/error/interrupted）。
 */
export interface SubagentNode {
  /** child session id（点击切到该 subagent 只读页面，§5 交互8） */
  sessionId: string;
  /** subagent 显示名（subAgentTemplateType 或系统名 "subagent"） */
  name: string;
  /** session 状态（running 含 interrupting；idle/error/interrupted = terminated 组）
   *  [v0.0.101] 加 'suspended'（HITL 悬挂态，subagent 也可能 suspended） */
  state: 'idle' | 'running' | 'interrupting' | 'interrupted' | 'error' | 'suspended';
  /** 模板标签（null = inline spawn 无 templateRef） */
  subAgentTemplateType: string | null;
  /** isoDate，活跃时间（组内排序依据：updatedAt desc） */
  updatedAt: string;
}

/**
 * GET /session/:id/children 响应结构（对齐 api 10-multi-agent.md §3.2）。
 * parent 派生的 children 按 state 分 running / terminated 两组。
 */
export interface ChildrenView {
  parentSessionId: string;
  /** state === "running" 的 child（含 interrupting，按 updatedAt desc） */
  running: SubagentNode[];
  /** state ∈ {idle, error, interrupted} 的 child（按 updatedAt desc） */
  terminated: SubagentNode[];
}
