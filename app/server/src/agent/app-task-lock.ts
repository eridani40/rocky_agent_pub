/**
 * AppTaskLock — app 级 × per-task 内存 CAS 锁（v0.0.164.memory_opt 新建）
 *
 * 参考: specs/tech/agent/session/[P0]app_task_lock.md（权威 spec）
 *       specs/tech/version_logs/v0.0.164.memory_opt/change_plan.md 模块 F 后半
 *       specs/tech/agent/session/[P0]session_task_lock.md（姊妹机制，本类照抄结构去 sessionId 维度）
 *
 * 设计要点（spec §1 §3）：
 *   - 管什么：app 级同类后台任务（tier2 天级整理 / 未来 backup/cleanup 等）的并发互斥。
 *     同 taskType 同时只 1 个 active；冲突 fire-and-forget 直接跳过。
 *   - 不管什么：per-session 任务（→ SessionTaskLock，正交）；跨 taskType 互斥；持久化。
 *   - 不落盘（§3.2 客户端产品决策）：内存 only，进程重启 = 全部释放。
 *   - CAS 语义（§3.1）：acquire = state ∈ {idle,done,failed} → running；返 bool 表达抢到/没抢到。
 *   - 超时接管（§3.1）：state=running 且 startedAt 距今 > STALE_RUNNING_MS(1h) →
 *     acquire 强制接管（同进程 hang 兜底，重启天然释放只补启动场景）。
 *
 * 与 SessionTaskLock 差异：
 *   - 去掉 sessionId 维度（Map<taskType, state> 单层，非 Map<sid, Map<taskType, state>>）
 *   - emit target = (app_task topic, `_all` group) 广播，非 per-sid group
 *   - 事件类型 = `consolidation_task_update`（PRD 定案 3）
 *
 * bootstrap 装配：
 *   - store-phase 构造 AppTaskLock 单例 + reconcileOnStartup（no-op 占位）
 *   - bus-phase registerTopic APP_TASK_TOPIC non-replayable
 *   - agent-phase 调 setAppTaskBus 后置注入（bus 就绪后）
 */
import type { ReplayableEventBus } from './event-bus';
import { APP_TASK_BROADCAST_GROUP, type ConsolidationTaskUpdateEvent } from './session-event-types';
import { ulid } from '../config/ulid';

/**
 * 任务状态（spec §2 AppTaskState，与 SessionTaskState 完全同构，心智对齐）。
 */
export interface AppTaskState {
  status: 'idle' | 'running' | 'done' | 'failed';
  /** 触发锁的任务 runId（观测用：手动='manual:<ulid>' / cron='cron:<iso>'） */
  runId?: string | null;
  /** ISO8601；acquire 时设 */
  startedAt?: string | null;
  /** markFailed 时设 */
  error?: string | null;
}

/** 任务类型枚举（开放集合，本版本唯一值 tier2_consolidation） */
export type AppTaskType = 'tier2_consolidation' | string;

/** reconcileOnStartup 返回形态（spec §2） */
export interface AppReconcileResult {
  reconciled: Array<{ taskType: AppTaskType }>;
}

/** idle 状态常量（spread 时复用，避免对象重复创建） */
const IDLE_STATE: AppTaskState = {
  status: 'idle',
  runId: null,
  startedAt: null,
  error: null,
};

/**
 * running 态超时接管阈值（1h，spec §3.1 [v0.0.205.t2_cons]）。
 * 同进程 hang 永久卡死的兜底：state=running 且 startedAt 距今 >1h → acquire 强制接管。
 * 仍内存 only 不落盘（重启天然释放已由 §3.2 满足，本机制只补同进程 hang 场景）。
 */
export const STALE_RUNNING_MS = 3_600_000;

/**
 * 超时接管判定：running 且 startedAt 距今 > STALE_RUNNING_MS。
 * startedAt 缺失（null/undefined）或非法（Date.parse=NaN）→ false（保守不接管，仍拒获）。
 */
function isStaleRunning(state: AppTaskState): boolean {
  if (state.status !== 'running' || !state.startedAt) return false;
  return Date.now() - Date.parse(state.startedAt) > STALE_RUNNING_MS;
}

/**
 * AppTaskLock — app 级 × per-task 内存 CAS 锁。
 * 数据结构：`Map<AppTaskType, AppTaskState>` 单层。
 * 单值 per taskType——同 taskType 同时只 1 个锁。
 */
export class AppTaskLock {
  /** 内存 Map：<taskType, state>；lazy 建（首次 acquire 时 insert） */
  private readonly tasks = new Map<AppTaskType, AppTaskState>();
  /**
   * app_task topic 的 bus（bus-phase registerTopic 后由 agent-phase setAppTaskBus 注入）。
   * 缺省 undefined = UT/未注入 场景 → 静默 no-op emit。
   */
  private appTaskBus?: ReplayableEventBus;

  /**
   * 注入 app_task topic 的 bus（bootstrap 后置 setter，与 SessionTaskLock.setSessionPanelBus 同模式）。
   * 必须在 hub.registerTopic(APP_TASK_TOPIC, ...) 之后调（保证 bus 已就绪）。
   */
  setAppTaskBus(bus: ReplayableEventBus): void {
    this.appTaskBus = bus;
  }

  /**
   * 尝试获取 taskType 锁（spec §2 §3.1 CAS 语义）。
   *
   * CAS：state ∈ {idle, done, failed} → running + 设 runId/startedAt + 清 error。
   *
   * 超时接管（spec §3.1 [v0.0.205.t2_cons]）：state=running 但 startedAt 距今 >
   * STALE_RUNNING_MS → 视为可获取（覆盖写新 running + emit，等价 release+re-acquire
   * 原子一步）。startedAt 缺失/非法（Date.parse=NaN）→ 不接管（保守拒获）。
   *
   * @returns true = 抢到（可以跑）；false = 已被占（state=running 且未超时 → 调用方直接跳过）
   */
  acquire(taskType: AppTaskType, runId?: string): boolean {
    const cur = this.tasks.get(taskType) ?? IDLE_STATE;
    if (cur.status === 'running' && !isStaleRunning(cur)) return false;
    const next: AppTaskState = {
      status: 'running',
      runId: runId ?? null,
      startedAt: new Date().toISOString(),
      error: null,
    };
    this.tasks.set(taskType, next);
    // CAS 成功 → emit consolidation_task_update（让前端立即渲染 running）
    this.emitTaskUpdate(next);
    return true;
  }

  /**
   * 任务成功结束：CAS running → done + 清 runId/startedAt/error（spec §2）。
   * 非 running 调用为 no-op（幂等保护）。
   */
  markDone(taskType: AppTaskType): void {
    const cur = this.tasks.get(taskType);
    if (!cur || cur.status !== 'running') return;
    const next: AppTaskState = { status: 'done', runId: null, startedAt: null, error: null };
    this.tasks.set(taskType, next);
    this.emitTaskUpdate(next);
  }

  /**
   * 任务失败结束：CAS running → failed + 设 error（spec §2）。
   * 非 running 调用为 no-op（幂等保护）。
   */
  markFailed(taskType: AppTaskType, error: string): void {
    const cur = this.tasks.get(taskType);
    if (!cur || cur.status !== 'running') return;
    const next: AppTaskState = { status: 'failed', runId: null, startedAt: null, error };
    this.tasks.set(taskType, next);
    this.emitTaskUpdate(next);
  }

  /**
   * 显式释放（少见；通常用 markDone/markFailed）。
   * 非 running 调用为 no-op（幂等）。释放后 state 回到 idle。
   */
  release(taskType: AppTaskType): void {
    const cur = this.tasks.get(taskType);
    if (!cur || cur.status !== 'running') return;
    const next: AppTaskState = { status: 'idle', runId: null, startedAt: null, error: null };
    this.tasks.set(taskType, next);
    this.emitTaskUpdate(next);
  }

  /**
   * 查当前状态（读不持锁）。
   * 未 acquire 过的 taskType → 返 idle 状态（不写 Map，避免查询污染）。
   */
  getState(taskType: AppTaskType): AppTaskState {
    const cur = this.tasks.get(taskType);
    return cur ?? { ...IDLE_STATE };
  }

  /**
   * 进程启动清理（spec §3.4 no-op）：内存 only，重启 = 全部释放。
   * 接口保留与 SessionTaskLock 同范式，调用方（bootstrap）不需要感知实现细节。
   */
  reconcileOnStartup(): AppReconcileResult {
    return { reconciled: [] };
  }

  // ============================================================
  // 私有 helpers — SSE 推送
  // ============================================================

  /**
   * CAS 状态变更成功后 emit consolidation_task_update 到 (app_task, _all) group。
   *
   * emit 三不原则（spec §3.4 严格守）：
   *   1. bus 未注入 → 静默 no-op（UT fixture / 测试环境）
   *   2. CAS 失败（acquire 返 false / non-running markDone/markFailed）→ 不 emit（state 未变，无信号可推）
   *      —— 由调用方保证：只在 CAS 成功分支后调本 helper
   *   3. emit 异常吞掉（safe-wrap console.warn）→ 不影响锁语义
   *
   * 无 sessionId 字段——app 级事件广播非 per-sid。
   */
  private emitTaskUpdate(nextState: AppTaskState): void {
    if (!this.appTaskBus) return;
    try {
      const ts = new Date().toISOString();
      const event: ConsolidationTaskUpdateEvent = {
        id: ulid(),
        type: 'consolidation_task_update',
        createdAt: ts,
        data: nextState,
      };
      this.appTaskBus.emit(APP_TASK_BROADCAST_GROUP, {
        data: event,
        timestamp: ts,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[app-task-lock] emitTaskUpdate failed (suppressed): ${msg}`);
    }
  }
}
