/**
 * SessionStateMachine — session 运行态 CAS + reconcile + 事件推送（v0.0.12 新建）
 * 参考: specs/tech/agent/session/[P0]session_state.md §3 §5
 *       specs/tech/agent/session/[P0]session_event.md §3
 *       states/v0.0.12/design.md 板块 4/7
 *
 * 设计：
 *   - 全 CAS 原子条件写（WHERE 子句防并发交错）—— 返 boolean，false = CAS 失败
 *   - 每次 CAS 成功后内部 emit session_status_update（见 session_event.md §3）
 *   - reconcileOnStartup 扫描 running/interrupting orphan → idle + Run.status=interrupted
 *
 * 实现策略（基于现有 CrudStore）：
 *   - get-then-put 在单 JS 进程内足够安全（Node 单线程，竞态只发生在 await 之间；
 *     本系统的并发只来自单进程内的多个异步 activate/abort，无跨进程并发）。
 *   - 真正的数据库级 CAS 留给未来 sqlite engine；此处用「读校验 + 写」语义对齐 spec §3。
 */
import { ulid } from '../config/ulid';
import { CompositeStore } from '../persistence/composite';
import type { LogWriter } from '../dev-logs/log-writer';
import { SessionSchema, RunSchema } from './schema_defs';
import type { SessionRecord, RunRecord } from './schema_defs';
import type { ReplayableEventBus } from './event-bus';
import type {
  SessionState,
  SessionStatus,
} from './session-store-types';
import type {
  SessionStatusUpdateEvent,
} from './session-event-types';
import { SESSION_PANEL_TOPIC } from './session-event-types';
// [v0.0.101] PendingToolCall（reconcileSuspendedPending 校验 pendingToolCalls 一致性用）
import type { PendingToolCall } from '../tools/types';

/**
 * 从 session record 移除 currentRunId 字段（语义 = null）。
 * CrudStore.put 写 json 时 undefined 字段不落盘；InferRecord 类型不接受 null。
 */
function unsetRunId(rec: SessionRecord): SessionRecord {
  const { currentRunId: _drop, ...rest } = rec;
  return rest as SessionRecord;
}

/**
 * CrudStore.get 返回的记录含信封字段（createdAt/updatedAt/version），但 CrudStore.put
 * 禁止 record 自带信封字段（由 store 注入）。此函数剥除信封字段，便于 get→改→put 往返。
 */
function stripEnvelope<T extends Record<string, unknown>>(rec: T): T {
  const { createdAt, updatedAt, version, ...rest } = rec as unknown as {
    createdAt?: unknown;
    updatedAt?: unknown;
    version?: unknown;
  };
  void createdAt; void updatedAt; void version;
  return rest as T;
}

// v0.0.55：normalizeSummaryTask 已删除（summaryTask CAS 被 SessionTaskLock 取代，schema 字段同步删除）。

/** SessionStateMachine 构造参数 */
export interface SessionStateMachineOptions {
  // [v0.0.38 T4] crud 类型由 CrudStore 收紧为 CompositeStore（spec §6.1：状态转换走 putAsync）
  crud: CompositeStore;
  /** session_panel topic 的 bus（推送 SessionEvent；可为 undefined → 推送降级为 no-op） */
  statusBus?: ReplayableEventBus;
  /** [dev-logs] agent 诊断日志（写 logs/agent.log；undefined 时不写，零开销） */
  logWriter?: LogWriter;
}

/**
 * v0.0.12 session 运行态维护器。CAS + 事件推送 + reconcile。
 * 与 SessionStore 解耦：本类只管运行态字段（state/running/currentRunId）+ run.status。
 */
export class SessionStateMachine {
  // [v0.0.38 T4] crud 类型由 CrudStore 收紧为 CompositeStore（spec §6.1：状态转换走 putAsync）
  private readonly crud: CompositeStore;
  private readonly statusBus?: ReplayableEventBus;
  /** [dev-logs] agent 诊断日志（可选；undefined 时所有 log 调用 no-op） */
  private readonly logWriter?: LogWriter;

  constructor(opts: SessionStateMachineOptions) {
    this.crud = opts.crud;
    this.statusBus = opts.statusBus;
    this.logWriter = opts.logWriter;
  }

  /**
   * [dev-logs] 写一条 agent state_change 诊断日志（受 logs.enableAgentLog 开关控制）。
   * 只记 sessionId/from/to/runId/ok，绝不记消息内容。失败静默（LogWriter 哲学）。
   */
  private logStateChange(
    sessionId: string,
    from: SessionState | string,
    to: string,
    runId: string | null,
    ok: boolean,
  ): void {
    this.logWriter?.write('agent', { event: 'state_change', sessionId, from, to, runId, ok });
  }

  /**
   * activate 用：CAS state ∈ {idle, interrupted, error, suspended} → running + 设 currentRunId。
   * [v0.0.101] WHERE 加 'suspended'（O6 activate 闸门）：suspended 是 HITL 合法存活态，
   *   用户回填（b 路径）或发 query（c 路径放弃）后需能 markRunning 重新激活跑 loop。
   *   recover 不靠 currentRunId（靠 pendingToolCalls 落盘），故 suspended→running 设新 runId。
   * @returns true=成功；false=当前 state 不允许 activate（已在 running/interrupting/suspended 之外的非法态）
   */
  async markRunning(sessionId: string, newRunId: string): Promise<boolean> {
    const rec = this.crud.get(SessionSchema, sessionId) as SessionRecord | null;
    if (!rec) return false;
    const cur = (rec.state ?? 'idle') as SessionState;
    if (cur !== 'idle' && cur !== 'interrupted' && cur !== 'error' && cur !== 'suspended') {
      this.logStateChange(sessionId, cur, 'running', newRunId, false);
      return false;
    }
    // [v0.0.38 T4] putAsync 串行化（spec §6.1 [wait]）：状态机一致性关键
    await this.crud.putAsync(SessionSchema, stripEnvelope({
      ...rec,
      state: 'running',
      running: true,
      currentRunId: newRunId,
    }));
    this.emitStatus(sessionId, { state: 'running', running: true, currentRunId: newRunId });
    this.logStateChange(sessionId, cur, 'running', newRunId, true);
    return true;
  }

  /**
   * abort step1：CAS currentRunId=expected AND state=running → interrupting + 清 currentRunId。
   * @returns true=成功；false=currentRunId 已变或非 running
   */
  async markInterrupting(sessionId: string, expectedRunId: string): Promise<boolean> {
    const rec = this.crud.get(SessionSchema, sessionId) as SessionRecord | null;
    if (!rec) return false;
    const cur = (rec.state ?? 'idle') as SessionState;
    if (rec.currentRunId !== expectedRunId || cur !== 'running') {
      this.logStateChange(sessionId, cur, 'interrupting', expectedRunId, false);
      return false;
    }
    // [v0.0.38 T4] putAsync 串行化（spec §6.1 [wait]）
    await this.crud.putAsync(SessionSchema, stripEnvelope(unsetRunId({ ...rec, state: 'interrupting', running: true })));
    this.emitStatus(sessionId, { state: 'interrupting', running: true, currentRunId: null });
    this.logStateChange(sessionId, cur, 'interrupting', expectedRunId, true);
    return true;
  }

  /**
   * abort step4：CAS state=interrupting → interrupted + running=false。
   * @returns true=成功；false=非 interrupting（已被他人改）
   */
  async markInterrupted(sessionId: string): Promise<boolean> {
    const rec = this.crud.get(SessionSchema, sessionId) as SessionRecord | null;
    if (!rec) return false;
    const cur = (rec.state ?? 'idle') as SessionState;
    if (cur !== 'interrupting') {
      this.logStateChange(sessionId, cur, 'interrupted', null, false);
      return false;
    }
    // [v0.0.38 T4] putAsync 串行化（spec §6.1 [wait]）
    await this.crud.putAsync(SessionSchema, stripEnvelope({ ...rec, state: 'interrupted', running: false }));
    this.emitStatus(sessionId, { state: 'interrupted', running: false, currentRunId: null });
    this.logStateChange(sessionId, cur, 'interrupted', null, true);
    return true;
  }

  /**
   * loop run_end 正常：CAS currentRunId=expected AND state=running → idle + 清 currentRunId。
   * @returns true=成功；false=currentRunId 已变或非 running（被 abort 改了）
   */
  async markIdle(sessionId: string, expectedRunId: string): Promise<boolean> {
    const rec = this.crud.get(SessionSchema, sessionId) as SessionRecord | null;
    if (!rec) return false;
    const cur = (rec.state ?? 'idle') as SessionState;
    if (rec.currentRunId !== expectedRunId || cur !== 'running') {
      this.logStateChange(sessionId, cur, 'idle', expectedRunId, false);
      return false;
    }
    // [v0.0.38 T4] putAsync 串行化（spec §6.1 [wait]）
    await this.crud.putAsync(SessionSchema, stripEnvelope(unsetRunId({ ...rec, state: 'idle', running: false })));
    this.emitStatus(sessionId, { state: 'idle', running: false, currentRunId: null });
    this.logStateChange(sessionId, cur, 'idle', expectedRunId, true);
    return true;
  }

  /**
   * loop run_end error：CAS currentRunId=expected AND state=running → error + running=false。
   * @returns true=成功；false=currentRunId 已变或非 running
   */
  async markError(sessionId: string, expectedRunId: string): Promise<boolean> {
    const rec = this.crud.get(SessionSchema, sessionId) as SessionRecord | null;
    if (!rec) return false;
    const cur = (rec.state ?? 'idle') as SessionState;
    if (rec.currentRunId !== expectedRunId || cur !== 'running') {
      this.logStateChange(sessionId, cur, 'error', expectedRunId, false);
      return false;
    }
    // [v0.0.38 T4] putAsync 串行化（spec §6.1 [wait]）
    await this.crud.putAsync(SessionSchema, stripEnvelope(unsetRunId({ ...rec, state: 'error', running: false })));
    this.emitStatus(sessionId, { state: 'error', running: false, currentRunId: null });
    this.logStateChange(sessionId, cur, 'error', expectedRunId, true);
    return true;
  }

  /**
   * [v0.0.101] HITL 悬挂：CAS currentRunId=expected AND state=running → suspended + running=false。
   *
   * 唯一调用方 = MainLifecyclePort.onRunEnd（stopReason='tool_pending' 分支）。
   * suspended 是合法存活态（非错误非空闲）：loop 因 tool 悬挂等用户回填，pendingToolCalls 落盘
   * 记录悬挂队列；recover 靠 pendingToolCalls 不靠 currentRunId，故此处清 currentRunId
   * （与 markIdle/markError 一致——run 已终止，persistRun 已落 Run.stopReason=tool_pending）。
   *
   * INV-2：suspended 排除 running（running=false，列表亮「?」非 spinner）。
   *
   * @returns true=成功；false=currentRunId 已变或非 running（被 abort 改了）
   */
  async markSuspended(sessionId: string, expectedRunId: string): Promise<boolean> {
    const rec = this.crud.get(SessionSchema, sessionId) as SessionRecord | null;
    if (!rec) return false;
    const cur = (rec.state ?? 'idle') as SessionState;
    if (rec.currentRunId !== expectedRunId || cur !== 'running') {
      this.logStateChange(sessionId, cur, 'suspended', expectedRunId, false);
      return false;
    }
    // [v0.0.38 T4] putAsync 串行化（spec §6.1 [wait]）：状态机一致性关键
    await this.crud.putAsync(SessionSchema, stripEnvelope(unsetRunId({ ...rec, state: 'suspended', running: false })));
    this.emitStatus(sessionId, { state: 'suspended', running: false, currentRunId: null });
    this.logStateChange(sessionId, cur, 'suspended', expectedRunId, true);
    return true;
  }

  /**
   * 启动扫描（bootstrap）：扫 state ∈ {running, interrupting} 的 session
   * → state=idle + currentRunId=null + 对应 Run.status=interrupted（design §7）。
   * 已终态（idle/interrupted/error）不动。
   *
   * [v0.0.101] suspended 是 HITL 合法存活态（INV-3）：reconcile **保留 suspended 不清 idle**。
   *   仅校验其 pendingToolCalls 落盘一致（suspended 必有 ≥1 个 status='pending' 的悬挂项）；
   *   不一致（空/全 resolved/字段损坏）→ log warn + 清 pendingToolCalls（set []），state 保持 suspended
   *   （recover 走 markRunning WHERE 含 suspended，前端 peek 拿到空 → 用户发 query 即可激活）。
   *
   * v0.0.12 BUG-003 修复（容错）：逐 session/run try-catch——单条非法记录（如脏数据
   * 导致 schema 校验失败）跳过 + log warn，不中断整体 bootstrap。
   * 生产环境单条数据损坏不应拖垮整个 reconcile（design 板块 7 健壮性）。
   * @returns 修复的 session id 列表（running/interrupting→idle 的 + suspended 清 pending 的）
   */
  async reconcileOnStartup(): Promise<{ reconciled: string[] }> {
    const all = this.crud.query(SessionSchema, { order: 'createdAtDesc' }) as SessionRecord[];
    const reconciled: string[] = [];
    for (const rec of all) {
      try {
        const state = (rec.state ?? 'idle') as SessionState;
        // [v0.0.101] suspended 合法存活：保留，仅校验 pendingToolCalls 一致性
        if (state === 'suspended') {
          if (await this.reconcileSuspendedPending(rec)) {
            reconciled.push(rec.id);
          }
          continue;
        }
        if (state !== 'running' && state !== 'interrupting') continue;
        // 修复 session → idle（currentRunId 字段从 record 移除，相当于 null）
        // [v0.0.38 T4] putAsync 串行化（spec §6.1 [wait]）：reconcile 写也走锁，与运行时一致
        await this.crud.putAsync(SessionSchema, stripEnvelope(unsetRunId({ ...rec, state: 'idle', running: false })));
        // 修复对应活跃 Run（status=running → interrupted）。
        // running session: 直接用 currentRunId；interrupting session: currentRunId 已被
        // abort step1 清为 null，但 Run 记录可能仍 running → 扫该 session 所有 Run 找 running 的
        const runIdsToCheck: string[] = [];
        if (rec.currentRunId) {
          runIdsToCheck.push(rec.currentRunId);
        } else {
          // interrupting session currentRunId=null 兜底：扫 runs by sessionId 找 running
          try {
            const runsOfSession = this.crud.query(RunSchema, {}) as RunRecord[];
            for (const r of runsOfSession) {
              if (r.sessionId === rec.id && r.status === 'running') {
                runIdsToCheck.push(r.id);
              }
            }
          } catch (scanErr) {
            console.warn(`[reconcile] session ${rec.id} runs scan skip:`, scanErr instanceof Error ? scanErr.message : String(scanErr));
          }
        }
        for (const rid of runIdsToCheck) {
          try {
            const run = this.crud.get(RunSchema, rid, rec.id) as RunRecord | null;
            if (run && run.status === 'running') {
              // [v0.0.38 T4] putAsync 串行化（spec §6.1 [wait]）
              await this.crud.putAsync(RunSchema, stripEnvelope({
                ...run,
                status: 'interrupted',
                endedAt: new Date().toISOString(),
              }));
            }
          } catch (runErr) {
            // 单条 Run 损坏不影响 session reconcile 的完成（log 后继续）
            console.warn(`[reconcile] session ${rec.id} run ${rid} skip:`, runErr instanceof Error ? runErr.message : String(runErr));
          }
        }
        this.emitStatus(rec.id, { state: 'idle', running: false, currentRunId: null });
        // [dev-logs] reconcile 修复 running/interrupting→idle（启动扫描信号）
        this.logStateChange(rec.id, state, 'idle', null, true);
        reconciled.push(rec.id);
      } catch (sessErr) {
        // 单条 session 非法（schema 校验失败 / 字段缺失）跳过 + log，不中断整体
        console.warn(`[reconcile] session ${rec?.id ?? '<unknown>'} skip:`, sessErr instanceof Error ? sessErr.message : String(sessErr));
      }
    }
    return { reconciled };
  }

  // v0.0.55：summaryTask CAS 段（markSummaryRunning/Done/Failed/Idle + reconcileSummaryTaskOnStartup
  //   + emitSummary）已删除——被 SessionTaskLock 统一锁取代（内存 only 不落盘，spec §3.3 subsumes）。
  //   compact 互斥迁移到 SessionTaskLock.acquire/markDone/markFailed('compact')；旧
  //   reconcileSummaryTaskOnStartup 调用点（bootstrap）改调 SessionTaskLock.reconcileOnStartup（no-op）。
  //   见 specs/tech/agent/session/[P0]session_task_lock.md §3 §6。

  /**
   * [v0.0.101] 校验 suspended session 的 pendingToolCalls 落盘一致性。
   *
   * 一致性契约：suspended 必有 ≥1 个 status='pending' 的悬挂项（runReActLoop ③ 段原子写入）。
   * 不一致场景：① pendingToolCalls 字段缺失/非数组/损坏；② 数组为空；③ 全部 status='resolved'。
   * 不一致处置：log warn + 清 pendingToolCalls（set []），state 保持 suspended（INV-3 不清 idle）。
   *   前端 peek 拿到空 → 用户发 query 走 markRunning(suspended→running) 激活（O6 闸门）。
   *
   * @param rec suspended session record（caller 保证 state==='suspended'）
   * @returns true=不一致已修复（清空 pending）；false=一致无需动
   */
  private async reconcileSuspendedPending(rec: SessionRecord): Promise<boolean> {
    const raw = rec.pendingToolCalls as unknown;
    let inconsistent = false;
    if (!Array.isArray(raw)) {
      inconsistent = true;
    } else {
      const arr = raw as PendingToolCall[];
      const hasPending = arr.some((p) => p && p.status === 'pending');
      if (!hasPending) inconsistent = true;
    }
    if (!inconsistent) return false;
    console.warn(
      `[reconcile] session ${rec.id} suspended 但 pendingToolCalls 不一致（空/全 resolved/损坏），清空 pending，state 保持 suspended`,
    );
    // 清 pendingToolCalls（set []）；保留 suspended（INV-3）。putAsync 串行化（spec §6.1 [wait]）
    await this.crud.putAsync(SessionSchema, stripEnvelope({
      ...rec,
      pendingToolCalls: [] as unknown,
    }));
    // suspended 态清理 pending 不 emit（state 未变，meta view 无需刷新；前端 peek 时自取最新）
    return true;
  }

  /** emit session_status_update（CAS 成功后内部调；statusBus 缺省时 no-op） */
  private emitStatus(sessionId: string, status: SessionStatus): void {
    if (!this.statusBus) return;
    const e: SessionStatusUpdateEvent = {
      id: ulid(),
      type: 'session_status_update',
      sessionId,
      createdAt: new Date().toISOString(),
      data: status,
    };
    this.statusBus.emit(`session_id:${sessionId}`, {
      data: e,
      timestamp: new Date().toISOString(),
    });
  }
}
