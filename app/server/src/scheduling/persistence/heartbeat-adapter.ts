/**
 * HeartbeatPersistenceAdapter — 包装 SchedulerStateStore 适配 PersistenceAdapter 接口。
 * 参考: specs/tech/scheduling/[P1]heartbeat_handler.md §3（权威契约 + scheduler.json v2 schema）
 *       specs/tech/scheduling/[P0]job_registry.md §1（PersistenceAdapter 接口）
 *
 * [v0.0.116] squad 级改造：
 *   - deps 去 listHeartbeatRoles，改 getHeartbeatConfig(squadId)（读 squad.heartbeatConfig + timezone）
 *   - loadJobs：返 0/1 squad 级 job；null 心跳配置走默认 interval=15/[]/all 仍建 1 job
 *   - enableHeartBeat 开关不在 loadJobs 静态拦（killswitch 是每-tick 现取的动态 gate0，避免切换需 reload）
 *   - upsertJob：走 stateStore.writeSquad（squad 级）
 *   - removeJob/removeAllJobs：no-op（不删 lastFiredAt，保续接语义；teardown 走 disposeSquad）
 *
 * 注：schedule.tz 由 caller squad-runtime registerHeartbeatJobs 后处理注入，本 adapter 不设。
 */
import type { Job, PersistenceAdapter } from '../types';
import type { SchedulerStateStore } from '../../squad/scheduler/scheduler-state';
import type { SquadHeartbeatConfig } from '../../squad/scheduler/types';

/** HeartbeatPersistenceAdapter 依赖（构造注入） */
export interface HeartbeatPersistenceAdapterDeps {
  /** scheduler.json 读写（squad 级分片） */
  stateStore: SchedulerStateStore;
  /**
   * 读 squad 心跳配置（squad-runtime 注入：projectSquadHeartbeatConfig）。
   * null = squad 不存在 → loadJobs 返 []。
   * heartbeatConfig=null 时 config 走默认值（interval15/[]/all），仍建 1 job。
   */
  getHeartbeatConfig(squadId: string): Promise<{ config: SquadHeartbeatConfig; tz: string } | null>;
}

/**
 * HeartbeatPersistenceAdapter — heartbeat job 的持久化适配器。
 * 不直接读写 scheduler.json 文件——包装 SchedulerStateStore（原子写 + read-modify-write 语义）。
 */
export class HeartbeatPersistenceAdapter implements PersistenceAdapter {
  constructor(private readonly deps: HeartbeatPersistenceAdapterDeps) {}

  /**
   * 读 squad heartbeat job（boot loader / squad-runtime.ensureScheduler 调）。
   * [v0.0.116] 返 0/1 squad 级 job：
   *   - getHeartbeatConfig 返 null（squad 不存在）→ []
   *   - 否则建 1 job（heartbeatConfig=null 走默认 interval15/[]/all）
   * enableHeartBeat 开关不在此拦（killswitch 走 handler gate0 动态，避免切换需 reload）。
   */
  async loadJobs(squadId: string): Promise<Job[]> {
    const hb = await this.deps.getHeartbeatConfig(squadId);
    // null = squad 不存在 → 无 job
    if (!hb) return [];
    const { config, tz } = hb;
    // 读 scheduler.json v2 squad 级状态（续接 lastFiredAt）
    const state = this.deps.stateStore.readSquad(squadId);
    const lastFiredAt = state?.lastFiredAt ?? null;
    const job: Job = {
      id: `heartbeat:${squadId}`,
      type: 'heartbeat',
      schedule: {
        kind: 'interval',
        // interval 单位分钟 → ms
        ms: (config.interval ?? 15) * 60_000,
        // tz 由 squad-runtime registerHeartbeatJobs 后处理注入（不在 adapter 设）
        tz,
      },
      payload: { squadId },
      lastFiredAt,
      enabled: true,
      createdAt: lastFiredAt ?? new Date().toISOString(),
      owner: squadId,
    };
    return [job];
  }

  /**
   * 写/替单 job（fire 后 lastFiredAt 更新时调）。
   * scheduler.json 只存 lastFiredAt/lastResult；schedule/payload 由 squad.heartbeatConfig 单一源驱动。
   */
  async upsertJob(owner: string, job: Job): Promise<void> {
    this.deps.stateStore.writeSquad(owner, {
      lastFiredAt: job.lastFiredAt,
      lastResult: 'fired',
    });
  }

  /**
   * 删单 job（squad 级配置变更 diff reload 时由 squad-runtime 调；stateStore 不删 lastFiredAt）。
   * engine.unregister 由 caller（squad-runtime）处理；enableHeartBeat 关不触发此路径（job 恒注册）。
   */
  async removeJob(_owner: string, _jobId: string): Promise<void> {
    // no-op：scheduler.json 保留 lastFiredAt（续接语义）
  }

  /**
   * 删 owner 全部 jobs（PersistenceAdapter 兼容接口）。
   * squad 硬删的 teardown 走 SquadRuntime.disposeSquad（按 registeredJobIds 精确注销），不经本适配器。
   */
  async removeAllJobs(_owner: string): Promise<void> {
    // no-op：teardown 由 disposeSquad 走 engine.unregister
  }
}
