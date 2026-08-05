/**
 * CronHandler — type='cron' 的 JobHandler 实现（cron job gate chain + 投递 + 落盘）。
 * 参考: specs/tech/scheduling/[P1]cron_subsystem.md §2（权威契约：gate 顺序 + orphan clean）
 *       specs/tech/scheduling/[P0]engine.md §3（engine.tick fire-and-forget 调 handler.fire）
 *       specs/tech/scheduling/index.md §④ 核心原则（gate 下沉 handler）
 *
 * 设计（与 HeartbeatHandler 对偶，去 window/killswitch gate）：
 *   - gate 顺序：sessionExists（gate0）→ enabled 双保 → busy（gate1）→ squad budget（gate2）→ deliverTo
 *   - gate0 fail = orphan auto-clean（cronStore.removeJob + engine.unregister，spec §8）
 *   - gate2 仅 payload.squadId !== null 时检查（playground skip，spec §1 归属规则）
 *   - fire 成功（deliverTo 通过）才 engine.updateJobLastFiredAt + cronStore.upsertJob（保 lastFiredAt 续接语义）
 *   - 异常 try/catch 自吞（engine 已 .catch 兜底；handler 内部仍 try/catch 防 reject）
 *
 * 与 HeartbeatHandler 区别：
 *   - cron schedule 不带 activeWindow（cron expr 自带时段）→ 无 window gate
 *   - cron 无 squad.enableHeartBeat 总开关 → 无 killswitch gate（per-job enabled 即总开关）
 */
import type { Job, JobHandler } from '../types';
import type { CronPayload } from '../payloads';
import type { SchedulerEngine } from '../engine';
import type { CronPersistenceAdapter } from '../persistence/cron-adapter';
import { buildCronUserMessage } from '../cron-message';
import type { Message } from '../../message/types';

/** CronHandler 依赖（构造注入；T6 bootstrap 装配，UT 用 mock） */
export interface CronHandlerDeps {
  /** session 是否存在（gate0，防 archived session 残留 job 触发；spec §8） */
  sessionExists(sessionId: string): Promise<boolean>;
  /** busy check（gate1，防 enqueue 不可撤致堆 tick；与 heartbeat gate3 同语义） */
  isSessionBusy(sessionId: string): Promise<boolean>;
  /**
   * Gate squad budget 余量（gate2；仅 payload.squadId !== null 时调）。
   * 返 null=放行（无 budget 配置）；非 null && <=0 → skip。
   */
  squadBudgetRemaining(squadId: string): Promise<number | null>;
  /** 统一投递入口（T6 注入 agentManager.deliverTo）；message 须为完整 Message */
  deliverTo(sessionId: string, message: Message): Promise<unknown>;
  /** cron.json 持久化（lastFiredAt 更新 / orphan clean / removeJob） */
  cronStore: CronPersistenceAdapter;
  /** engine 反向引用（fire 成功才 updateJobLastFiredAt；engine 不感知 handler 存在） */
  engine: SchedulerEngine;
}

/**
 * CronHandler — cron job gate chain + 投递 + 落盘。
 * engine.tick 内 `void handler.fire(job, now)`；handler 内部完成全部业务 gate。
 */
export class CronHandler implements JobHandler {
  constructor(private readonly deps: CronHandlerDeps) {}

  /**
   * engine 调入口（fire-and-forget，engine 不 await）。
   * 串行：gate0 sessionExists（orphan clean）→ enabled 双保 → busy → squad budget → deliverTo
   *   → 成功才 engine.updateJobLastFiredAt + cronStore.upsertJob（保续接语义）。
   * 异常 try/catch 自吞（不阻塞 engine 下 tick；engine 已 .catch 兜底 reject）。
   */
  async fire(job: Job, now: Date): Promise<void> {
    if (job.type !== 'cron') return;
    const p = job.payload as CronPayload;
    try {
      // gate0: session 仍存在（防 archived session 残留 job 触发；spec §8）
      if (!(await this.deps.sessionExists(p.sessionId))) {
        // orphan 自动清理（claude-code teammate 模式）：删 cron.json entry + engine 注销
        await this.deps.cronStore.removeJob(p.sessionId, job.id);
        this.deps.engine.unregister(job.id);
        return;
      }
      // engine 已 check enabled，handler 双保（防 enabled 在 fire 期间被改）
      if (!job.enabled) return;
      // gate1: busy（防 enqueue 不可撤致堆 tick，与 heartbeat gate3 同语义）
      if (await this.deps.isSessionBusy(p.sessionId)) return;
      // gate2: squad budget（仅 squad session；playground=payload.squadId=null 时 skip）
      if (p.squadId !== null) {
        const remaining = await this.deps.squadBudgetRemaining(p.squadId);
        if (remaining !== null && remaining <= 0) return; // 无 budget
      }
      // 全通过 → 投递 cron Message（spec §4 buildCronUserMessage）
      await this.deps.deliverTo(
        p.sessionId,
        buildCronUserMessage(p, now.toISOString()),
      );
      // fire 成功才更新 engine 内存 lastFiredAt（gate skip 保旧值，下 tick 重试）
      this.deps.engine.updateJobLastFiredAt(job.id, now.toISOString());
      // cron.json 落盘 lastFiredAt（与 scheduler.json writeRole 同语义）
      await this.deps.cronStore.upsertJob(p.sessionId, {
        ...job,
        lastFiredAt: now.toISOString(),
      });
    } catch {
      // best-effort：异常不阻塞 engine 下 tick（spec §2 注释）
    }
  }
}
