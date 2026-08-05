/**
 * session 子域类型 —— Session 顶层模型 + 运行态枚举（对齐 api 04-agent-session.md §2.1）。
 * 参考: specs/api/overall/04-agent-session.md §2.1
 *       specs/tech/agent/session/[P0]session_state.md
 *
 * Session 字段含 v0.0.148 effort / approvalMode + v0.0.101 suspended 态。
 * summaryTask 字段引用 usage 子域 SummaryTaskStatus（单向依赖：session → usage）。
 *
 * 拆分自原 chat-page/types.ts（v0.0.156 纯拆分，类型定义 100% 不变）。
 */

import type { BizType, Role, Derivation } from '@app/shared';
import type { SummaryTaskStatus } from './usage';

/** session 运行态（对齐 api 04-agent-session.md §2.1 + session_state.md 六态机）
 *  [v0.0.101] 加 'suspended'（HITL 悬挂态：loop 已退出等用户回填，running=false 排除） */
export type SessionState =
  | 'idle'
  | 'running'
  | 'interrupting'
  | 'interrupted'
  | 'error'
  | 'suspended';

/** Session（对齐 api 04-agent-session.md §2.1） */
export interface Session {
  id: string;
  title: string;
  status: 'active';
  /** 手动选 model 持久化（可空，未选过时 undefined） */
  providerId?: string;
  /** 手动选 model 持久化（可空） */
  modelId?: string;
  /** 当前 run 状态机位（详见 specs/tech/agent/session/[P0]session_state.md） */
  state?: SessionState;
  /** state ∈ {running, interrupting} 时为 true（前端展示 loading/中断按钮/enqueue view 的快捷布尔） */
  running?: boolean;
  /** 当前活跃 run ULID；idle/interrupted/error/interrupting 时为 null */
  currentRunId?: string | null;
  /**
   * 未读标记（显式存储值，非派生）。
   * true → 渲染 conv-item 未读红点；进入会话时前端 POST /session/:id/read 清零（详见 api §2.3.1）。
   * 后端权威 specs/tech/agent/session/[P0]session_state.md §6。
   */
  unread?: boolean;
  /**
   * titled 标记（lazy 默认 false：s.titled === true）。
   * 派生自 Session.titled（详见 specs/api/overall/04-agent-session.md §2.1 +
   * specs/tech/agent/session/[P0]session_store.md §2）。
   * 仅作 conv-item 内部判定（编辑态 save 时 PUT body 携带 titled:true 同步置 true，
   * 防 AI 名返回覆盖用户名）；渲染层不读此字段（标题文本永远来自 title prop）。
   */
  titled?: boolean;
  /**
   * session 关联工作目录（对齐后端 SessionMetaView.workspaceDir）。
   * 会话列表订阅 session_meta 广播时按 sessionId 整条替换，列表展示需要此字段实时更新
   * （UI spec _overview.md §5 交互7：列表始终反映权威最新态含 workspaceDir）。
   */
  workspaceDir?: string;
  /**
   * summaryTask 快照（compact 进度；对齐后端 SummaryTaskStatus）。
   * 会话列表订阅 session_meta 广播时按 sessionId 整条替换，列表展示需要此字段实时更新。
   */
  summaryTask?: SummaryTaskStatus;
  /**
   * 会话角色（SessionKind.role，不含 'subagent'——subagent 用 derivation 表达）。
   * 值域：'rocky'|'leader'|'mate'|'squad'。UI 据 derivation==='subagent' + parentSessionId
   * 决定渲染位置（挂 parent tree，不作顶层项）。
   */
  role?: Role;
  /**
   * 派生层级（SessionKind.derivation）：'main'（顶层）| 'subagent'（子 agent）。
   */
  derivation?: Derivation;
  /**
   * 业务分区（SessionKind.biz）：'playground'|'studio'。
   * 对齐后端 session-event-types.ts / session-meta-broadcaster.ts：studio session 广播带
   * biz:'studio'，playground 缺省不带。applySessionMetaEvent 守卫 incoming.biz==='studio' 拒纳，
   * 防 studio 会话经 session_meta `_all` 广播泄漏进 playground 列表（缺省/undefined 视为 playground）。
   * 参考 specs/tech/agent/session/[P0]session_biztype.md。
   */
  biz?: BizType;
  /**
   * 派生者 session id（仅 derivation==="subagent" 有值，权威）。
   * 会话列表据 derivation + parentSessionId 把 subagent 挂到对应 parent tree。
   */
  parentSessionId?: string;
  /**
   * subagent 派生自哪个模板（如 "explorer"）；inline spawn 无 templateRef 时为 null。
   */
  subAgentTemplateType?: string | null;
  /**
   * 由哪次 spawn 产生（审计/观测）；仅 derivation==="subagent" 有值。
   */
  origin?: { spawnRunId: string; toolCallId: string };
  /**
   * studio session 关联的 squad id（API spec 11-squad.md §2）。
   * 所有 studio session（squad/leader/mate + 其 subagent）都带；playground session 为 undefined。
   * 后端 chrome 服务（GET /session/:id/chrome）据此拉 squad 成员 + 模型默认值。
   */
  squadId?: string;
  /**
   * studio session 对应的 member id（API spec 11-squad.md §2）。
   * 仅 leader/mate session 带（与 member.sessionId 双向）；squad 群聊 session + subagent session 均为 undefined。
   * 后端 chrome 服务据此判单聊/群聊（空=群聊）+ 投影 chrome.memberId（前端据此定位对端 member）。
   */
  memberId?: string;
  /**
   * [v0.0.148] session 级 effort 推理强度（4 档 canonical 语义键，缺省 'default'）。
   * 透传到 LLM wire body：非 default 档注入 output_config.effort（low/high/max）。
   * default 档 = 不传 wire 字段（模型厂商默认行为）。详见 PRD v0.0.148 §1.1。
   */
  effort?: 'default' | 'low' | 'high' | 'max';
  /**
   * [v0.0.148] session 级审批模式（缺省 'normal'）。
   * 'greenlight' = 绿灯短路所有 ask（不弹审批卡，直接放行）；deny 路径仍保留（安全 invariant）。
   * 详见 PRD v0.0.148 §2.2。
   */
  approvalMode?: 'normal' | 'greenlight';
  /**
   * [v0.0.210] academy 4 实例字段（SessionMetaView 读侧投影，对齐后端 session-store-types.ts）。
   * 仅 biz='academy' 的 session 带；前端按此过滤教室/学生/版本/任务归属。
   */
  academyClassroomId?: string;
  /** academy student session 带（学生绑定） */
  academyStudentId?: string;
  /** academy student session 带（具体版本绑定） */
  academyVersionId?: string;
  /** academy coach session 带（绑定训练任务） */
  academyTrainingTaskId?: string;
  /**
   * [v0.0.231] 置顶标记（lazy 默认 false：s.pinned === true；对齐后端 SessionMetaView 投影）。
   * 列表分组（置顶组在前）+ conv-item pinned 视觉（pin 图标 + 背景加重）的唯一依据；
   * 写路径 = 右键菜单置顶项 PUT /session/:id {pinned}（fire-and-forget），
   * 归位靠 session_meta 广播 + chat-slice compareSessionsForList 统一比较器。
   * 详见 specs/api/overall/04-agent-session.md §2.1 + _overview.md §4.1/§4.2。
   */
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
}
