/**
 * agent 工具共享类型（v0.0.28 task-2）
 * 参考: specs/tech/multi_agent/[P1]subagent_derivation.md §4（SpawnAgentInput/Result 契约）
 *       specs/tech/multi_agent/[P1]subagent_templates.md §2（SubAgentTemplate）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §2（AgentRef）
 *       specs/tech/agent/tools/[P1]agent_tools.md §1（agent 单工具 3 action）
 *
 * 本文件是 agent 工具子系统（spawn/query/abort + send_message）的对外类型契约。
 * 工具实现（agent-tool.ts / send-message-tool.ts）+ spawn/query/abort action 共享引用。
 *
 * 单文件 ≤300 行（纯类型，无运行时逻辑）。
 */
import type { ContentBlock } from '../../message/types';
import type { Usage } from '../../message/types';
import type { StopReason } from '../agent-event-types';
import type { Role, Derivation } from '@app/shared';

/**
 * SubAgentTemplate —— 模板（用户配置，存储在 dev_config sub_agent_templates 组）。
 * 参考 subagent_templates §2。spawn 时 templateRef 引用，载入 systemPrompt/tools/skills/modelId。
 *
 * 注：存储后端由 task-3 实现（dev_config group）；本接口定义结构契约。
 */
export interface SubAgentTemplate {
  /** 模板标识（= templateRef；= 派生 session 的 subAgentTemplateType） */
  name: string;
  /** 人读说明（UI + parent LLM 选模板用） */
  description: string;
  /** 子 agent 人设 */
  systemPrompt: string;
  /** 工具白名单（如 ['read','web_search','web_fetch','send_message']；无通配符） */
  tools: string[];
  /** 可选 skills */
  skills?: string[];
  /**
   * 可选——模板指定 model；走模板时 child model = template.modelId。
   * 缺省/null = inherit parent.modelId（D8 修订，subagent_templates §2）。
   */
  modelId?: string | null;
  /** 系统预配（explorer=true），只读可复制衍生 */
  builtin?: boolean;
}

/**
 * SpawnAgentInput —— agent.spawn action 入参（derivation §4）。
 * 无 modelId 字段（D8：spawn 时不可覆盖 model；走模板 or inherit parent）。
 *
 * 可选 role + derivation（普通 spawn 不传走 bloodline/subagent 缺省；
 * derivation='parent' 一律被 gate 强制回 'subagent'——spawn 只能产派生子 agent）。
 */
export interface SpawnAgentInput {
  /** 引用模板（载入 systemPrompt/tools/skills/modelId）；无模板时 systemPrompt 必填 */
  templateRef?: string;
  /** 覆盖模板 systemPrompt（无 templateRef 时必填） */
  systemPrompt?: string;
  /** 覆盖模板 tools 白名单（含 send_message 的可达目标 = 拓扑编码） */
  tools?: string[];
  /** 覆盖模板 skills */
  skills?: string[];
  /** 显式指定 Role（覆盖 parent.role bloodline） */
  role?: Role;
  /** 显式指定 Derivation（缺省 'subagent'；'parent' 被 gate 强制回 'subagent'） */
  derivation?: Derivation;
  /** 首任务内容（语义 = send_message：内部构造 sender.agent 子结构，needReply 按 mode 设） */
  task: { content: ContentBlock[] };
  /** sync=阻塞等 final answer；async=立即返 handle */
  mode: 'sync' | 'async';
  /** 缺省 25 */
  maxIter?: number;
  /**
   * caller-provided child 工作目录（v0.0.203 新增，通用透传）。
   * 传入时 child session.workspaceDir=该值；不传时 child 继承 parent.workspaceDir（既有行为不变）。
   * 参考: specs/tech/agent/session/[P0]session_workspace.md §3
   */
  workspaceDir?: string;
}

/**
 * SpawnAgentResult —— agent.spawn 返回（derivation §4）。
 * sync 返 answer/usage/stopReason（await run.promise 透传 RunResult）；
 * async 返 runId/status:running（subagent 完成主动 send_message 回 parent）。
 */
export type SpawnAgentResult =
  | {
      mode: 'sync';
      childSessionId: string;
      answer: string;
      usage: Usage;
      stopReason: StopReason;
    }
  | {
      mode: 'async';
      childSessionId: string;
      runId: string;
      status: 'running';
    };

/**
 * QueryAgentInput —— agent.query action 入参（derivation §7 + agent_tools §1）。
 * 带 ref → 单 child 详情；不带 ref + filter → list_children 分组。
 */
export interface QueryAgentInput {
  /** 单查目标（AgentRef struct / sessionId 字串 / "parent" 别名） */
  ref?: AgentRefLike | string;
  /** 列表筛选（不带 ref 时生效） */
  filter?: {
    /** running=仅运行组；terminated=仅终止组；缺省=两组 */
    status?: 'running' | 'terminated';
    /** 按模板标签筛（如 'explorer'） */
    templateType?: string;
    /** 最多返回 N 条（缺省 20，按 updatedAt desc） */
    limit?: number;
  };
}

/** AgentRef 的 LLM 友好形态（输入接受 struct 或字串别名，内部 canonical 化） */
export interface AgentRefLike {
  // [v0.0.33.1] member→mate（B 方案命名统一）
  type?: 'leader' | 'mate' | 'subagent' | 'squad';
  sessionId?: string;
  name?: string;
}

/** SendMessageInput —— send_message 工具入参（derivation §5.1 + a2a_protocol §6） */
export interface SendMessageInput {
  /** 目标（AgentRef struct / sessionId / "parent" 别名） */
  target: AgentRefLike | string;
  /** 消息内容 */
  content: ContentBlock[];
  /** 必填——透传到接收方 message.sender.agent.needReply */
  needReply: boolean;
  /** 关联原 message.id（thread；回复某 a2a 消息时填） */
  inReplyTo?: string;
}

/**
 * SpawnContext —— spawn 执行所需的最小上下文（从 ToolCtx.config 注入）。
 * agent 工具经 ctx.config.agentSpawnContext 读这些依赖（避免耦合完整 SessionConfig）。
 */
export interface AgentSpawnContext {
  /** parent sessionId（spawn 创建 child 关联 parentSessionId） */
  parentSessionId: string;
  /** parent modelId（D8 inherit 用：无模板时 child modelId = parent.modelId） */
  parentModelId: string;
  /** parent providerId（child 继承，client 构造用） */
  parentProviderId?: string;
  /** parent workspaceDir（child 默认继承 parent 工作目录） */
  parentWorkspaceDir?: string;
  /** parent runId（origin.spawnRunId 审计用） */
  parentRunId: string;
  /** parent AgentRef（首任务 sender.agent.ref = parent.ref） */
  parentRef: { type: 'leader' | 'mate' | 'subagent' | 'squad'; sessionId: string; name: string };
  /** parent scope（spawn 只允许 session scope——subagent 工具不注册，门控前置） */
  parentScope?: 'session' | 'subagent';
}
