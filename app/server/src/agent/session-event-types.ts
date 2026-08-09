/**
 * SessionEvent 类型定义（v0.0.12 新建）
 * 参考: specs/tech/agent/session/[P0]session_event.md §2
 *
 * session 面板（topic=`session_panel`）的低频 meta 事件流——session 自身 meta 类
 * 信息的变更通知（usage / status）。与 agent_loop topic（agent 流式进度）区分。
 *
 * v0.0.12 落地 `session_status_update`（运行态变更）。
 * `session_usage_update`（usage 变更）类型声明保留（v0.0.12 不实现 usage 推送）。
 */
import type { SessionStatus, SessionUsageView } from './session-store-types';
import type { BizType, SessionType, Role, Derivation } from '@app/shared';
// [v0.0.78.bug] 恢复 import：summary_task_update 事件 data 用 SessionTaskState（v0.0.55 删后恢复）
import type { SessionTaskState } from './session-task-lock';

/** SessionEvent 公共字段（agent session_event.md §2） */
export interface SessionEventBase {
  /** 事件自身 ULID */
  id: string;
  type: SessionEventType;
  /** 变更的 session（与 group 编码冗余，便于消费方直接取） */
  sessionId: string;
  /** ISO 8601 UTC */
  createdAt: string;
}

/** SessionEvent 类型联合 key */
export type SessionEventType =
  | 'session_usage_update'
  | 'session_status_update'
  | 'messages_cleared'
  | 'session_workspace_dir_changed'
  | 'session_workspace_file_changed'
  | 'session_read_update'
  | 'session_todo_changed'
  | 'session_cron_changed'
  | string; // 预留扩展

/** usage 变更（updateUsage 写+推一体 / notifyUsageChanged 触发；负载 = getUsageView 全量） */
export interface SessionUsageUpdateEvent extends SessionEventBase {
  type: 'session_usage_update';
  data: SessionUsageView;
}

/** 运行态变更（v0.0.12；状态机 CAS API 写完后触发） */
export interface SessionStatusUpdateEvent extends SessionEventBase {
  type: 'session_status_update';
  data: SessionStatus;
}

/**
 * 压缩 / 后台任务状态变更（v0.0.78.bug 恢复；v0.0.55 误删）。
 *
 * 由 SessionTaskLock.acquire/markDone/markFailed/release 在 CAS 成功后 emit 到
 * (session_panel, group=`session_id:<sid>`)；前端 CompactBtn 据此渲染 spinner。
 *
 * data = SessionTaskLock 当前 (sid, taskType) 的 SessionTaskState（running/done/failed/idle）。
 * 与 session_status_update（agent loop 运行态）正交——本事件只表「压缩任务在跑/完成/失败」。
 */
export interface SummaryTaskUpdateEvent extends SessionEventBase {
  type: 'summary_task_update';
  data: SessionTaskState;
}

export type SessionEvent =
  | SessionUsageUpdateEvent
  | SessionStatusUpdateEvent
  | SummaryTaskUpdateEvent
  | MessagesClearedEvent
  | SessionWorkspaceDirChangedEvent
  | SessionWorkspaceFileChangedEvent
  | SessionReadUpdateEvent
  | SessionTodoChangedEvent
  | SessionCronChangedEvent;

/**
 * session_cron_changed 事件（照抄 session_todo_changed 模式）。
 * cron 写操作（create/update/toggle/delete）成功后 emit
 * （topic=session_panel，group=session_id:<sid>）。
 * data 为空对象（轻量信号不携带 cron 数据；消费方收事件后重拉 GET /session/:id/cron 全量）。
 */
export interface SessionCronChangedEvent extends SessionEventBase {
  type: 'session_cron_changed';
  data: Record<string, never>;
}

/**
 * messages_cleared 事件（v0.0.16；session_clear.md §5 step4）。
 * clear 后前端一次清空对话区，避免逐条 message_deleted 抖动。
 * data 为空对象（事件本身即「该 session 全清」语义，sessionId 已在事件顶级）。
 */
export interface MessagesClearedEvent extends SessionEventBase {
  type: 'messages_cleared';
  data: Record<string, never>;
}

/**
 * session_workspace_dir_changed 事件（v0.0.17；session_workspace.md §4 + session_event.md §2）。
 * SessionStore.setWorkspaceDir 完成后触发；前端 WorkspacePanel 据此刷新路径栏 + 重拉 tree。
 */
export interface SessionWorkspaceDirChangedEvent extends SessionEventBase {
  type: 'session_workspace_dir_changed';
  data: {
    /** 新的 workspaceDir（绝对路径） */
    workspaceDir: string;
    /** 旧 workspaceDir（首次设置时为 null） */
    prevDir: string | null;
  };
}

/**
 * session_workspace_file_changed 事件（v0.0.17；session_workspace_manager.md §6 + session_event.md §2）。
 * chokidar 检测到 workspace 内 add/change/unlink/addDir/unlinkDir，由
 * SessionWorkspaceManager.handleFsEvent 100ms debounce 后触发；前端 WorkspacePanel 据此
 * 按展开状态做局部 re-fetch / 标 stale。
 */
export interface SessionWorkspaceFileChangedEvent extends SessionEventBase {
  type: 'session_workspace_file_changed';
  data: {
    /** 相对 workspaceDir 的相对路径（前端 join 后 GET 子目录重拉；非绝对路径，防泄漏） */
    path: string;
    /** chokidar eventName 映射（manager spec §6） */
    kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
    /** addDir/unlinkDir → true；add/change/unlink → false */
    isDir: boolean;
  };
}

/**
 * session_read_update 事件（v0.0.27；session_event.md §2 + session_state.md §6）。
 * markRead CAS 成功后内部 emit（topic=session_panel，group=session_id:<sid>）。
 * data 固定 {unread:false}（消除未读的唯一事件形态；产生未读不发事件——无订阅方）。
 * 前端收到后更新 sessions[i].unread=false（红点实时消失）。
 */
export interface SessionReadUpdateEvent extends SessionEventBase {
  type: 'session_read_update';
  data: { unread: false };
}

/**
 * session_todo_changed 事件（session_event.md §2/§3 + todo_tools.md §4）。
 * TodoStore.upsertItem/removeItem/cleanupFinished 写成功后内部 emit
 * （topic=session_panel，group=session_id:<sid>）。
 * data 为空对象（轻量信号不携带 todo 数据；消费方收事件后重拉 GET /session/:id/todos
 * 全量——todo 规模小，重拉代价可忽略）。
 */
export interface SessionTodoChangedEvent extends SessionEventBase {
  type: 'session_todo_changed';
  data: Record<string, never>;
}

/** session_panel topic 名（hub.registerTopic 用） */
export const SESSION_PANEL_TOPIC = 'session_panel';

/**
 * [v0.0.164] app_task topic 名（hub.registerTopic 用）。
 * 参考: specs/tech/agent/session/[P0]app_task_lock.md §4
 *
 * app 级后台任务（tier2_consolidation 等）状态更新的广播 topic。
 * non-replayable + 广播 group `_all`（非 per-sid）——新连接订阅只关心当前状态，
 * 初始态走 HTTP `GET /consolidation/status` 拉取；本 topic 只推实时更新。
 */
export const APP_TASK_TOPIC = 'app_task';

/** [v0.0.164] app_task 共享广播 group（对齐 SESSION_META_BROADCAST_GROUP 广播模式） */
export const APP_TASK_BROADCAST_GROUP = '_all';

/**
 * [v0.0.164] app 级后台任务状态变更事件（app_task topic 唯一事件类型）。
 * 参考: specs/tech/agent/session/[P0]app_task_lock.md §3.4 emit payload
 *
 * 由 AppTaskLock.acquire/markDone/markFailed/release 在 CAS 成功后 emit 到
 * (app_task, _all) group；前端设置页组件据此渲染「立即整理」按钮 disabled/running/失败态。
 *
 * data = AppTaskLock 当前 taskType 的 AppTaskState（running/done/failed/idle）。
 * 无 sessionId 字段——app 级广播非 per-sid（与 SessionEventBase 差异，故不 extends SessionEventBase）。
 *
 * 类型 inline 复制 AppTaskState 结构避免循环 import（session-event-types ← app-task-lock ← session-event-types）。
 */
export interface ConsolidationTaskUpdateEvent {
  /** 事件自身 ULID */
  id: string;
  /** 固定 'consolidation_task_update'（app_task topic 首个事件类型） */
  type: 'consolidation_task_update';
  /** ISO 8601 UTC */
  createdAt: string;
  /** app 级任务状态（AppTaskState 同构；inline 定义避免循环 import） */
  data: {
    status: 'idle' | 'running' | 'done' | 'failed';
    runId?: string | null;
    startedAt?: string | null;
    error?: string | null;
  };
}

/**
 * [v0.0.27] session_meta topic 名（hub.registerTopic 用）。
 * 参考: specs/tech/agent/session/[P0]session_event.md §3a + specs/tech/app/frontend/[P0]sse_channel.md §10
 * 共享广播 group `_all`（非 per-sid），non-replayable，会话列表订阅一次收所有 session meta 变更。
 */
export const SESSION_META_TOPIC = 'session_meta';

/** [v0.0.27] session_meta 共享广播 group（spec sse_channel.md §10.2） */
export const SESSION_META_BROADCAST_GROUP = '_all';

/**
 * [v0.0.27] session 完整最新 meta 视图（对齐 GET /session 返回 shape，不含 transcript）。
 * 参考: specs/tech/agent/session/[P0]session_event.md §3a.3
 *
 * 用于 session_meta_update 事件的 data 字段；reducer 收到后按 data.id 整条替换列表条目，
 * 与哪个字段变了无关（全量最新态 payload，spec decision.md §3）。
 */
export interface SessionMetaView {
  id: string;
  title: string;
  status: 'active' | 'archived';
  /** 运行态（对齐 SessionStatus，session_state.md §1）。
   *  [v0.0.101] 加 'suspended'（HITL 悬挂态，合法存活态；running bool 排除它）。 */
  state: 'idle' | 'running' | 'interrupting' | 'interrupted' | 'error' | 'suspended';
  running: boolean;
  currentRunId: string | null;
  /** session 关联工作目录（session_workspace.md §2） */
  workspaceDir: string;
  /** 未读标记（session_state.md §6 explicit-bool） */
  unread: boolean;
  /**
   * [v0.0.47] titled 标记（AI 起名 CAS gate，spec session_store.md §2 + auto_naming/[P0]auto_naming_service.md）。
   * true = title 已命名（人工/AI）；false = 仍是默认占位。前端会话列表据此决定是否允许 AI 起名
   * （前端不读此字段做渲染，仅 conv-item 透传；CAS gate 在 service 层消费）。
   */
  titled: boolean;
  /**
   * [v0.0.231] 会话置顶标记（spec session_store.md §2；lazy 默认 false）。
   * true = 已置顶（playground 列表置顶组在前，前端展示层归位）。
   * 投影层恒规范化为 boolean（同 unread/titled），写路径 = PUT /session/:id body.pinned。
   */
  pinned: boolean;
  /**
   * [v0.0.78.bug 恢复；v0.0.55 误删] 压缩任务状态（数据源 = SessionTaskLock，内存 only）。
   *
   * **方案 A（开放点-1 决策）**：optional；broadcaster **不填**（不持 lock 实例，避免耦合）。
   * 前端 CompactBtn 通过单独的 `summary_task_update` SSE 事件取最新态，不读 meta_view.summaryTask。
   * 字段保留是为了：(1) GET /session 返回 shape 与前端类型对齐；(2) 未来若 broadcaster 注入 lock 引用可直接填。
   */
  summaryTask?: SessionTaskState;
  /** provider / model（手动选 model 持久化，v0.0.9） */
  providerId?: string;
  modelId?: string;
  /**
   * [v0.0.28] multi_agent 5 字段（对齐 GET /session 返回 shape，spec §2.3）。
   * 参考: specs/api/overall/10-multi-agent.md §2（字段语义）
   *       specs/tech/multi_agent/[P1]subagent_derivation.md §2
   * 前端会话列表订阅 session_meta 据此把 subagent 挂到对应 parent 的 tree。
   */
  /** @deprecated v0.0.56 起 role+derivation 是权威源；一期过渡保留 */
  type?: SessionType;
  parentSessionId?: string;
  /** @deprecated v0.0.56 起 derivation 是权威源；一期过渡保留 */
  scope?: 'session' | 'subagent';
  subAgentTemplateType?: string;
  origin?: { spawnRunId: string; toolCallId: string };
  /**
   * [v0.0.33.1] 业务分区（playground|studio）+ squad 关联（对齐 GET /session 返回 shape）。
   * @deprecated v0.0.56 起 biz 是权威源；一期过渡保留（前端 T4 迁移前仍需）。
   */
  bizType?: BizType;
  /**
   * [v0.0.56] 新字段（权威源）：业务分区 / 会话角色 / 派生层级。
   * 替代旧 bizType / type / scope 三等分判定。
   */
  biz?: BizType;
  role?: Role;
  derivation?: Derivation;
  squadId?: string;
  memberId?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * [v0.0.27] session_meta_update 事件（session_meta topic 唯一事件类型）。
 * 参考: specs/tech/agent/session/[P0]session_event.md §3a.2
 *
 * 由 session 层 SessionMetaBroadcaster 在 session 状态/meta 变更时 emit 到
 * (session_meta, _all) group；会话列表订阅一次即可收所有 session 的 meta 变更。
 * data=全量 SessionMetaView（非 diff），reducer 据此整条替换列表条目。
 */
export interface SessionMetaUpdateEvent {
  /** 事件自身 ULID */
  id: string;
  /** 固定 'session_meta_update'（session_meta topic 只此一种事件） */
  type: 'session_meta_update';
  /** 变更的 session（reducer 据此整条替换，与 data.id 一致） */
  sessionId: string;
  /** ISO 8601 UTC */
  createdAt: string;
  /** session 完整最新 meta 视图（全量，非 diff） */
  data: SessionMetaView;
}

/** session_meta topic 的事件联合（预留扩展） */
export type SessionMetaEvent = SessionMetaUpdateEvent;
