/**
 * SessionTaskLock — 统一 per-session × per-task 内存锁（v0.0.55 新建）
 * 参考: specs/tech/agent/session/[P0]session_task_lock.md（权威 spec）
 *       specs/tech/version_logs/v0.0.55.memory_ui_session_lock/change_log.md §0/§2
 *       specs/tech/version_logs/v0.0.78.bug/change_plan.md §1 T2（bus 注入 + SSE 恢复）
 *
 * 设计要点（spec §1 §3）：
 *   - **管什么**：同 session 同类后台任务（compact / tier1 整理 / 后续同类）的并发互斥。
 *     冲突直接跳过（fire-and-forget 不堆积、不排队）。
 *   - **不管什么**：跨 session / 跨 taskType / 持久化 / agent loop 五态机——全部正交。
 *   - **不落盘**（§3.2 客户端产品决策）：内存 only，进程重启 = 全部释放。
 *     磁盘锁会被认为「应用挂了留下幽灵锁」；内存锁简单有效。
 *   - **CAS 语义**（§3.1）：acquire 等价 markRunning CAS——state ∈ {idle,done,failed} → running，
 *     返 bool 表达抢到/没抢到。
 *
 * subsumes v0.0.13 summaryTask CAS（§3.3）：原 compact 互斥由 Session.summaryTask 持久化字段
 * + SessionStateMachine.markSummaryRunning/Done/Failed 承担；v0.0.55 起改由本统一锁承担，
 * 旧机制废弃（持久字段 + CAS 方法删除）。
 *
 * 与五态机正交（§3.5 / 不变量 §7.1）：本锁不动 session.state / Run / currentRunId。
 * compact / tier1 是 forked agent 触发的「agent loop 之外」任务（无副作用、不持 Run 句柄）。
 *
 * [v0.0.78.bug] SSE 推送恢复：CAS 状态变更后 emit `summary_task_update` 到
 *   (session_panel, `session_id:<sid>`) group；前端 CompactBtn 据此渲染 spinner。
 *   bus 注入走后置 setter（与 ContextEngine.setTaskLock 同模式，避免构造函数耦合）。
 */
import type { ReplayableEventBus } from './event-bus';
import { ulid } from '../config/ulid';
/**
 * 任务状态（spec §2 SessionTaskState）。
 * - idle：初始 / 已释放
 * - running：任务进行中（acquire 成功后的状态）
 * - done：任务成功结束（markDone 后）
 * - failed：任务失败结束（markFailed 后，带 error）
 */
export interface SessionTaskState {
  status: 'idle' | 'running' | 'done' | 'failed';
  /** 触发锁的任务 runId（观测用；compact 形如 "compact:1700000000"） */
  runId?: string | null;
  /** ISO8601；acquire 时设 */
  startedAt?: string | null;
  /** markFailed 时设 */
  error?: string | null;
}

/** 任务类型枚举（开放集合，后续可加 tier1_consolidation / tier2_consolidation 等）
 *  [v0.0.210] 'training-turn'：academy 训练引擎 per-task lock（防同 task 并发 runTurn） */
export type SessionTaskType = 'compact' | 'tier1_consolidation' | 'training-turn' | string;

/** reconcileOnStartup 返回形态（spec §2） */
export interface ReconcileResult {
  reconciled: Array<{ sessionId: string; taskType: SessionTaskType }>;
}

/** idle 状态常量（spread 时复用，避免对象重复创建） */
const IDLE_STATE: SessionTaskState = {
  status: 'idle',
  runId: null,
  startedAt: null,
  error: null,
};

/**
 * SessionTaskLock — per-session × per-task 内存 CAS 锁。
 *
 * 数据结构：`Map<sessionId, Map<taskType, SessionTaskState>>`。
 * 单值 per (sessionId, taskType)——同 session 同 taskType 同时只 1 个锁。
 *
 * 单文件 ≤300 行（spec 任务约束）；纯内存 + 同步 API（无 fs / async 开销）。
 *
 * [v0.0.78.bug] bus 注入：bootstrap 在 registerTopic(SESSION_PANEL_TOPIC) 后调
 *   `setSessionPanelBus(sessionStatusBus)` 注入；CAS 状态变更成功后调 emitTaskUpdate
 *   emit `summary_task_update` 事件（前端 CompactBtn 订阅渲染 spinner）。
 */
export class SessionTaskLock {
  /** 内层 Map：<taskType, state>；外层 Map：<sessionId, 内层>。lazy 建（首次 acquire 时 insert） */
  private readonly sessions = new Map<string, Map<SessionTaskType, SessionTaskState>>();
  /**
   * [v0.0.78.bug] session_panel topic 的 bus（与 SessionStore.statusBus 同实例）。
   * 后置注入（setSessionPanelBus），bootstrap 顺序保证 registerTopic 后才注入；
   * 缺省 undefined（UT fixture 不注入 = 静默 no-op，与 statusBus 同兜底模式）。
   */
  private sessionPanelBus?: ReplayableEventBus;

  /**
   * [v0.0.78.bug] 注入 session_panel topic 的 bus。
   * 必须在 hub.registerTopic(SESSION_PANEL_TOPIC, ...) 之后调（保证 bus 已就绪）。
   * 与 ContextEngine.setTaskLock 同模式（后置 setter，避免构造函数耦合 + bootstrap 顺序不可控）。
   */
  setSessionPanelBus(bus: ReplayableEventBus): void {
    this.sessionPanelBus = bus;
  }

  /**
   * 尝试获取 (sessionId, taskType) 锁（spec §2 §3.1 CAS 语义）。
   *
   * CAS：state ∈ {idle, done, failed} → running + 设 runId/startedAt + 清 error。
   *
   * @returns true = 抢到（可以跑）；false = 已被占（state=running → 调用方直接跳过）
   */
  acquire(sessionId: string, taskType: SessionTaskType, runId?: string): boolean {
    const inner = this.sessions.get(sessionId) ?? new Map<SessionTaskType, SessionTaskState>();
    const cur = inner.get(taskType) ?? IDLE_STATE;
    // CAS WHERE state IN ('idle','done','failed') → 'running'（spec §3.1）
    if (cur.status === 'running') return false;
    const next: SessionTaskState = {
      status: 'running',
      runId: runId ?? null,
      startedAt: new Date().toISOString(),
      error: null,
    };
    inner.set(taskType, next);
    this.sessions.set(sessionId, inner);
    // [v0.0.78.bug] CAS 成功 → emit summary_task_update（让前端 CompactBtn 立即渲染 running）
    this.emitTaskUpdate(sessionId, next);
    return true;
  }

  /**
   * 任务成功结束：CAS running → done + 清 runId/startedAt/error（spec §2）。
   * 非_running 调用为 no-op（崩溃恢复后 markDone 安全，不变量 §7.6 幂等）。
   */
  markDone(sessionId: string, taskType: SessionTaskType): void {
    const inner = this.sessions.get(sessionId);
    if (!inner) return;
    const cur = inner.get(taskType);
    if (!cur || cur.status !== 'running') return;
    const next: SessionTaskState = { status: 'done', runId: null, startedAt: null, error: null };
    inner.set(taskType, next);
    // [v0.0.78.bug] CAS 成功 → emit summary_task_update（让前端 CompactBtn spinner 消失）
    this.emitTaskUpdate(sessionId, next);
  }

  /**
   * 任务失败结束：CAS running → failed + 设 error（spec §2）。
   * 非_running 调用为 no-op（幂等保护）。
   */
  markFailed(sessionId: string, taskType: SessionTaskType, error: string): void {
    const inner = this.sessions.get(sessionId);
    if (!inner) return;
    const cur = inner.get(taskType);
    if (!cur || cur.status !== 'running') return;
    const next: SessionTaskState = { status: 'failed', runId: null, startedAt: null, error };
    inner.set(taskType, next);
    // [v0.0.78.bug] CAS 成功 → emit summary_task_update（让前端 CompactBtn 显示失败态）
    this.emitTaskUpdate(sessionId, next);
  }

  /**
   * 显式释放（不分成功/失败，少见；通常用 markDone/markFailed）（spec §2）。
   * 非_running 调用为 no-op（幂等）。释放后 state 回到 idle（下一次 acquire 可成功）。
   */
  release(sessionId: string, taskType: SessionTaskType): void {
    const inner = this.sessions.get(sessionId);
    if (!inner) return;
    const cur = inner.get(taskType);
    if (!cur || cur.status !== 'running') return;
    const next: SessionTaskState = { status: 'idle', runId: null, startedAt: null, error: null };
    inner.set(taskType, next);
    // [v0.0.78.bug] CAS 成功 → emit summary_task_update（与 acquire/markDone/markFailed 对称）
    this.emitTaskUpdate(sessionId, next);
  }

  /**
   * 查当前状态（spec §2）。读不持锁。
   * 未 acquire 过的 (sessionId, taskType) → 返 idle 状态（不写 Map，避免查询污染）。
   */
  getState(sessionId: string, taskType: SessionTaskType): SessionTaskState {
    const inner = this.sessions.get(sessionId);
    if (!inner) return { ...IDLE_STATE };
    const cur = inner.get(taskType);
    return cur ?? { ...IDLE_STATE };
  }

  /**
   * 进程启动清理（spec §3.4）：接口保留（与五态机 reconcile / 旧 summaryTask reconcile
   * 同范式），但实现是 no-op——内存已空 = 全部释放，无可清对象。
   *
   * 调用方（bootstrap）不需要知道「锁在内存还是磁盘」，统一调 reconcile 即可。
   * 未来若改回落盘（极不可能），实现可改，调用方零改动。
   *
   * @returns reconciled 列表（实际始终空，因为内存已空）
   */
  reconcileOnStartup(): ReconcileResult {
    // no-op：内存 only，进程重启 = 全部释放（spec §3.2 §3.4）。
    // 不扫 sessions Map——理论上崩溃前 running 状态在重启后已不存在（Map 随进程死）。
    return { reconciled: [] };
  }

  // ============================================================
  // [v0.0.78.bug] 私有 helpers — SSE 推送
  // ============================================================

  /**
   * [v0.0.78.bug] CAS 状态变更成功后 emit summary_task_update 事件到
   * (session_panel, `session_id:<sid>`) group。
   *
   * 设计：
   *   - bus 未注入（UT fixture / 测试环境）→ 静默 no-op（与 statusBus 同兜底）。
   *   - emit 异常吞掉（safe-wrap），不影响 CAS 返回值 / 调用方主路径（observability 失败不抛）。
   *   - data = 调用方传入的 next state（acquire/markDone/markFailed/release 各传自己 CAS 后的 state）。
   *   - 不走 session_meta topic（compact 状态属 session 自身，per-session group 而非 broadcast）。
   */
  private emitTaskUpdate(sessionId: string, nextState: SessionTaskState): void {
    if (!this.sessionPanelBus) return;
    try {
      // event.createdAt 与 emit envelope.timestamp 同一瞬时（event 构造 = emit 时刻）
      const ts = new Date().toISOString();
      const event = {
        id: ulid(),
        type: 'summary_task_update' as const,
        sessionId,
        createdAt: ts,
        data: nextState,
      };
      this.sessionPanelBus.emit(`session_id:${sessionId}`, {
        data: event,
        timestamp: ts,
      });
    } catch (e) {
      // emit 失败不影响锁的语义（observability 链路自治，不污染调用方）
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[session-task-lock] emitTaskUpdate failed (suppressed): ${msg}`);
    }
  }
}
