/**
 * HeartbeatHandler — type='heartbeat' 的 JobHandler 实现（[v0.0.116] squad 级统一心跳）。
 * 参考: specs/tech/scheduling/[P1]heartbeat_handler.md §2（gate 链 + 逐成员展开 + 伪码）
 *       specs/tech/scheduling/[P1]heartbeat_handler.md §0（squad 级总述 + §0.1 提示词权威）
 *       specs/tech/scheduling/[P0]engine.md §3（engine.tick fire-and-forget 调 handler.fire）
 *
 * 设计（[v0.0.116] squad 级）：
 *   - 一个 heartbeat job per squad（Job.id=`heartbeat:<squadId>`），到点整队一次
 *   - gate 顺序：gate0 killswitch → gate1 activeWindows 多段 → gate2 budget → 逐成员 filter + deliverTo
 *   - 队级 gate 全通过即 fired（成员级 busy/benched/非白名单仅 continue，不影响 job lastResult）
 *   - killswitch 每 tick 现取（squad.enableHeartBeat，toggle ≤1s 生效）
 *   - activeWindows 多段来源 = getSquad 返回的 SquadSnapshot.heartbeatConfig.activeWindows（不进 engine types）
 *   - budget null=放行；非 null && remaining<=0 才 skip（gate2 short-circuit）
 *   - 异常 try/catch 自吞（不阻塞 engine 下 tick）
 *
 * 多 squad 隔离：Job.id=`heartbeat:<squadId>` 全局唯一；engine 单例遍历但 job 独立。
 */
import type { Job, JobHandler } from '../types';
import type { HeartbeatPayload } from '../payloads';
import type { SchedulerEngine } from '../engine';
import { withinActiveWindow } from '../active-window';
import type { SchedulerStateStore } from '../../squad/scheduler/scheduler-state';
import type { SchedulerHistory } from '../../squad/scheduler/scheduler-history';
import { buildHeartbeatTickMessage } from '../../squad/scheduler/tick-message';
import type { Message } from '../../message/types';
import type { SquadSnapshot, MemberSnapshot } from '../../squad/scheduler/types';

/** tick 投递结果（对齐 scheduler.json lastResult 值域） */
export type TickResultKind =
  | 'fired'
  | 'skipped_window'
  | 'skipped_budget'
  | 'skipped_killswitch';

/** tick 投递结果包装 */
export interface TickResult {
  kind: TickResultKind;
}

/**
 * HeartbeatHandler 依赖（构造注入；bootstrap 装配，UT 用 mock）。
 * [v0.0.116] 新增 listMembers 逐成员展开用。
 */
export interface HeartbeatHandlerDeps {
  /** 读 squad record（每 fire 调，取 enableHeartBeat/budget/timezone/heartbeatConfig） */
  getSquad(squadId: string): Promise<SquadSnapshot | undefined>;
  /** [v0.0.116] 逐成员展开（squad-runtime 注入 memberStore.listMembers 投影） */
  listMembers(squadId: string): Promise<MemberSnapshot[]>;
  /** Gate budget 余量（sync cache；squad.budget!==null 时才调，Infinity=放行） */
  budgetRemaining(squadId: string): number;
  /** busy check（防 enqueue 堆 tick；逐成员 filter 用） */
  isSessionBusy(sessionId: string): Promise<boolean>;
  /** 统一投递入口（message 须为完整 Message） */
  deliverTo(sessionId: string, message: Message): Promise<unknown>;
  /** scheduler.json 持久化（squad 级 lastFiredAt/lastResult） */
  stateStore: SchedulerStateStore;
  /** history ring buffer + jsonl */
  history: SchedulerHistory;
  /** engine 反向引用（fire 成功才 updateJobLastFiredAt） */
  engine: SchedulerEngine;
}

/**
 * HeartbeatHandler — heartbeat job squad 级 gate chain + 逐成员投递 + 落盘。
 * engine.tick 内 `void handler.fire(job, now)`；handler 内部完成全部业务 gate。
 */
export class HeartbeatHandler implements JobHandler {
  constructor(private readonly deps: HeartbeatHandlerDeps) {}

  /**
   * engine 调入口（fire-and-forget，engine 不 await）。
   * 串行：tryFire（gate chain + 逐成员 deliverTo）→ recordHistory → 落盘 lastResult →
   *   队级 gate 全通过才 engine.updateJobLastFiredAt。
   */
  async fire(job: Job, now: Date): Promise<void> {
    if (job.type !== 'heartbeat') return;
    const p = job.payload as HeartbeatPayload;
    try {
      const result = await this.tryFire(job, p, now);
      this.recordHistory(p, now, result);
      // 队级 gate 全通过（fired）才更新 engine 内存 lastFiredAt；gate skip 保旧值（下 tick 重试）
      if (result.kind === 'fired') {
        this.deps.engine.updateJobLastFiredAt(job.id, now.toISOString());
      }
      // scheduler.json squad 级 lastResult 落盘（[v0.0.116] 走 writeSquad，非 writeRole）
      this.deps.stateStore.writeSquad(p.squadId, {
        lastFiredAt: result.kind === 'fired' ? now.toISOString() : job.lastFiredAt,
        lastResult: result.kind,
      });
    } catch {
      // best-effort：异常不阻塞 engine 下 tick
    }
  }

  /**
   * squad 级 gate chain（[v0.0.116] 重写）。
   * gate0 killswitch → gate1 activeWindows 多段 → gate2 budget → 逐成员 filter + deliverTo。
   * 队级任一 gate 不过 → 整队 skip；成员级 busy/benched/非白名单仅 continue（不影响 job lastResult）。
   */
  private async tryFire(job: Job, p: HeartbeatPayload, now: Date): Promise<TickResult> {
    const squad = await this.deps.getSquad(p.squadId);
    // gate0: killswitch（squad 不存在当 killswitch；每 tick 现取，toggle ≤1s 生效）
    if (!squad) return { kind: 'skipped_killswitch' };
    if (!squad.enableHeartBeat) return { kind: 'skipped_killswitch' };
    // gate1: activeWindows 多段（空数组=全天放行；跟 squad.timezone）
    // activeWindows 来源 = getSquad().heartbeatConfig，不读 job.schedule.activeWindow（engine 纯度守护）
    const windows = squad.heartbeatConfig?.activeWindows ?? [];
    if (windows.length > 0 && !windows.some((w) => withinActiveWindow(w, now, squad.timezone ?? 'UTC'))) {
      return { kind: 'skipped_window' };
    }
    // gate2: budget（null=off=不限量=放行；非 null && remaining<=0 才 skip）
    if (squad.budget !== null && this.deps.budgetRemaining(p.squadId) <= 0) {
      return { kind: 'skipped_budget' };
    }
    // 队级 gate 全通过 → 逐成员展开投递（scope∩deployed∩有session∩非busy）
    const scope = squad.heartbeatConfig?.scope ?? { mode: 'all', memberIds: [] };
    const members = await this.deps.listMembers(p.squadId);
    for (const m of members) {
      // scope whitelist：不在列表则跳过（后续新增成员不自动纳入）
      if (scope.mode === 'whitelist' && !scope.memberIds.includes(m.id)) continue;
      // benched 不唤醒（任何模式）
      if (m.state !== 'deployed') continue;
      // 无 session（SquadChat 无 member 天然排除）
      if (!m.sessionId) continue;
      // busy 跳过该成员（不堆 tick，逐成员判定）
      if (await this.deps.isSessionBusy(m.sessionId)) continue;
      // 投递固定心跳提示词（§0.1 权威文案）
      await this.deps.deliverTo(m.sessionId, buildHeartbeatTickMessage(m.sessionId, now.toISOString()));
    }
    // 队级 gate 全通过即 fired（成员级 skip 不改 job lastResult）
    return { kind: 'fired' };
  }

  /** 写 squad 级 history（[v0.0.116] roleId 记 squadId，squad 级一条） */
  private recordHistory(p: HeartbeatPayload, now: Date, result: TickResult): void {
    this.deps.history.append(p.squadId, {
      roleId: p.squadId,
      at: now.toISOString(),
      reason: 'heartbeat',
      result: result.kind,
    });
  }
}
