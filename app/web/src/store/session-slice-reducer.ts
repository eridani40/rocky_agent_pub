/**
 * session-slice-reducer —— SSE session_panel 事件帧的纯函数 reducer
 * 参考: specs/tech/app/frontend/[P0]sse_channel.md §9（chat 页 session_panel 订阅接线）
 *       specs/tech/agent/session/[P0]session_event.md §2（SessionStatus / SessionUsageView / SummaryTaskStatus）/ §3（触发时机）
 *       specs/ui/components/chat-page/_overview.md §5-6（running 状态来源）/ §4.11b（abort-btn 渲染条件）
 *       specs/ui/components/chat-page/component-usage-panel.md §2（数据契约）/ §3.3（CompactBtn 状态绑定）
 *
 * 背景（design S4 / [D4.1] 仅前端 / [D4.2] 权威源切换）：
 *   v0.0.12 后端 session_status_update event 已全接好真在发（6 CAS 方法 + reconcileOnStartup
 *   完成后触发，topic=session_panel、group=session_id:<sid>，SSE 白名单已含 session_panel，
 *   详见 session_event.md §2-§3），但 chat 页从未 subscribe。v0.0.13 修复：chat 页 mount 时
 *   subscribe session_panel，本 reducer 处理 session_status_update 帧 → 推导 sessionRunning
 *   （中断按钮 / enqueue-view 可见性权威源）。
 *
 * [D4.2] sessionRunning 权威源切换：session_panel 含 interrupting / interrupted 中间态，
 * 比 agent_loop run_start/run_end 派生更准（agent_loop 只看 run 级，不感知 session 状态机）。
 * 故 chat-slice.ts 中 applyAgentEvent 不再用 r.runActive 覆盖 sessionRunning，
 * 而由本 reducer（session_status_update 优先）驱动；agent_loop 仅作 fallback 兜底。
 *
 * [v0.0.16] 扩展：本 reducer 除 session_status_update 外，也处理 session_usage_update /
 * summary_task_update 两种 SessionEvent（usage-panel / CompactBtn 的数据源），以及 clear
 * 场景下的 messages_cleared 帧（前端清对话区，避免逐条 message_deleted）。三种事件按 type
 * 分流，由 chat-slice.ts applySessionEvent 统一派发到本文件的纯函数。
 */

import type {
  SessionUsageView,
  SummaryTaskStatus,
} from '../components/chat-page/types';
import type {
  WorkspaceDirChangedEvent,
  WorkspaceFileChangedEvent,
} from '../components/chat-page/workspace-types';

/** session 运行态枚举（对齐 session_event.md §2 SessionStatus.state，六态机）
 *  [v0.0.101] 加 'suspended'（HITL 悬挂态：loop 已退出等用户回填，running=false 排除） */
export type SessionState = 'idle' | 'running' | 'interrupting' | 'interrupted' | 'error' | 'suspended';

/** session 运行态快照（对齐 session_event.md §2 SessionStatus） */
export interface SessionStatus {
  state: SessionState;
  running: boolean;
  currentRunId: string | null;
}

/**
 * todo 变更轻量信号（session_event.md §2 SessionTodoChangedEvent）。
 * TodoStore 写成功后 emit；data 恒空对象（轻量信号不携带 todo 数据，消费方重拉）。
 * id 作幂等键（ulid 必唯一；不用 createdAt——同毫秒连写可能撞键丢事件）。
 */
export interface SessionTodoChangedEvent {
  /** 事件自身 ULID（store 幂等键） */
  id: string;
  type: 'session_todo_changed';
  sessionId: string;
  createdAt: string;
  data: Record<string, never>;
}

/**
 * chat 页消费的 SessionEvent 子集（session_panel 订阅）。
 * [v0.0.16] 扩展：加 session_usage_update / summary_task_update / messages_cleared 三类。
 * [v0.0.27] 扩展：加 session_read_update（清未读，红点实时消失）。
 *   - session_status_update → sessionRunning（中断按钮 / enqueue-view 可见性）
 *   - session_usage_update → usage（usage-panel 圆环 / 表格）
 *   - summary_task_update → summaryTask（CompactBtn 四态）
 *   - messages_cleared → 触发 chat-slice 清对话区（clear 端点的 emit）
 *   - session_read_update → 对应 session.unread=false（红点消失，§5 交互7）
 *   - session_todo_changed → store.lastTodoEvent（useTodoCrud 静默 refetch）
 */
export type SessionEvent =
  | {
      type: 'session_status_update';
      sessionId: string;
      createdAt: string;
      data: SessionStatus;
    }
  | {
      type: 'session_usage_update';
      sessionId: string;
      createdAt: string;
      data: SessionUsageView;
    }
  | {
      type: 'summary_task_update';
      sessionId: string;
      createdAt: string;
      data: SummaryTaskStatus;
    }
  | {
      type: 'messages_cleared';
      sessionId: string;
      createdAt: string;
      data: { sessionId: string };
    }
  /** [v0.0.27] 标读事件（POST /session/:id/read 后端 CAS 成功 emit；data.unread 恒 false） */
  | {
      type: 'session_read_update';
      sessionId: string;
      createdAt: string;
      data: { unread: false };
    }
  /** [v0.0.17] workspace 事件（session_panel topic，section-workspace-panel 消费） */
  | WorkspaceFileChangedEvent
  | WorkspaceDirChangedEvent
  /** todo 变更轻量信号（fanout → lastTodoEvent → useTodoCrud 消费） */
  | SessionTodoChangedEvent;

/** session_panel reducer 输出切片：sessionRunning（中断按钮 / enqueue-view 可见性权威源） */
export interface SessionReducerResult {
  /** running = state∈{running, interrupting}（abort-btn 渲染条件，design §4.11b） */
  sessionRunning: boolean;
  /** 当前 session 运行态快照（debug 用，可扩展驱动更细 UI） */
  sessionStatus: SessionStatus;
}

/**
 * 把一条 session_status_update SessionEvent 应用到 sessionRunning 切片（纯函数，便于单测）。
 *
 * 推导规则（对齐 _overview.md §5-6 / design 板块 4.1）：
 *   - state=running       → sessionRunning=true  （run 进行中，显示 abort-btn + 可能 enqueue-view）
 *   - state=interrupting  → sessionRunning=true  （abort 收尾中，abort-btn 仍可见但 disabled，enqueue-view 仍可存在）
 *   - state=idle          → sessionRunning=false （正常结束，abort-btn 消失，enqueue-view 不显示）
 *   - state=interrupted   → sessionRunning=false （被中断收尾完成，abort-btn 消失，enqueue-view 不显示）
 *   - state=error         → sessionRunning=false （异常终态，abort-btn 消失，enqueue-view 不显示）
 *
 * 优先用 event.data.running（状态机权威）；若缺字段则按 state 推导兜底。
 * currentRunId 字段当前未直接驱动 UI（runId 跟踪归 agent_loop reducer），保留以便扩展。
 *
 * @param evt session_status_update 帧（data 含 state/running/currentRunId）
 * @param _currentRunning 当前 sessionRunning（保留参数位便于未来做状态比较，当前不读）
 * @returns 新的 sessionRunning + sessionStatus 快照
 */
export function applySessionStatusUpdate(
  evt: Extract<SessionEvent, { type: 'session_status_update' }>,
  _currentRunning: boolean,
): SessionReducerResult {
  const data = evt.data ?? { state: 'idle' as SessionState, running: false, currentRunId: null };
  const state: SessionState = data.state ?? 'idle';
  // 状态机权威：data.running 优先；若缺失则按 state 推导（running/interrupting 视为 running）
  const running =
    typeof data.running === 'boolean'
      ? data.running
      : state === 'running' || state === 'interrupting';
  return {
    sessionRunning: running,
    sessionStatus: { state, running, currentRunId: data.currentRunId ?? null },
  };
}
