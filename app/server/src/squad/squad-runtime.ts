/**
 * SquadRuntime — squad scheduler 生命周期 glue（boot 启 / shutdown 停 / SIGTERM trap）。
 * 参考: specs/tech/scheduling/[P1]heartbeat_handler.md §5（[v0.0.116] squad 级改造点）
 *       specs/tech/squad/[P1]scheduler.md §9（多 squad 隔离）/ §10（trap 清理）
 *
 * [v0.0.116] per-member → squad 级心跳：
 *   - heartbeatAdapter deps 改注入 getHeartbeatConfig（去 listHeartbeatRoles）
 *   - registerHeartbeatJobs 向 engine 注册 0/1 squad 级 job
 *   - startAll/reloadSquad 对每个 squad 恒注册（不静态拦 enableHeartBeat；killswitch 走 handler gate0 动态）
 *   - 新增私有 getHeartbeatConfig（读 squad → projectSquadHeartbeatConfig）
 *   - 删 listHeartbeatRoles / reloadRole（per-member 废弃）
 *   - getScheduler facade 去 reloadRole（只透传 getHistory）
 *   - reloadSquad 保持为心跳配置唯一实时刷入口（PATCH /squad 后调）
 *   - MUST NOT 自建 timer/setInterval（单一调度器 invariant）
 *
 * engine?: T2 可选（UT mock），T6 bootstrap 注入；未注入时跳过 register。
 */
import type { SquadStore, MemberStore, MemberEntity } from '../stores/squad-store';
import type { SessionStore } from '../agent/session-store';
import type { AgentManagerImpl } from '../agent/agent-manager';
import type { SchedulerEngine } from '../scheduling/engine';
import { HeartbeatPersistenceAdapter } from '../scheduling/persistence/heartbeat-adapter';
import { SchedulerStateStore } from './scheduler/scheduler-state';
import { SchedulerHistory } from './scheduler/scheduler-history';
import type { MemberSnapshot } from './scheduler/types';
import {
  projectSquadSnapshot,
  projectSquadHeartbeatConfig,
  heartbeatJobId,
  makeSchedulerFacade,
  type SchedulerFacade,
} from './squad-runtime-helpers';

// 重新导出 makeGetUsageTotalTokens（保持公共 API；从 squad-budget-wiring 迁出，bootstrap 仍从此处导入）
export { makeGetUsageTotalTokens } from './squad-budget-wiring';

/** SquadRuntime deps（构造注入，bootstrap 装配；UT 用 mock） */
export interface SquadRuntimeDeps {
  /** data_dir（stateStore/history 路径 root） */
  root: string;
  squadStore: SquadStore;
  memberStore: MemberStore;
  sessionStore: SessionStore;
  agentManager: AgentManagerImpl;
  /** [v0.0.58 T2] 公共调度引擎（进程单例；T6 bootstrap 注入，T2 可选用于 UT mock） */
  engine?: SchedulerEngine;
}

/**
 * SquadRuntime — squad scheduler 生命周期 glue（boot 启 / shutdown 停 / SIGTERM trap）。
 * 持 Set<squadId>（已 ensure 标记，幂等）+ Map<squadId, Set<jobId>>（跟踪本 squad 注册的 job）。
 */
export class SquadRuntime {
  /** squadId → 已 ensure 标记（幂等防重复 register） */
  private readonly ensuredSquads = new Set<string>();
  /** squadId → 本 squad 注册的 job ids（stopAll 仅卸这些，不动其他 squad / cron job） */
  private readonly registeredJobIds = new Map<string, Set<string>>();
  /** squadId → thin facade（getScheduler 返回，handler 兼容；缓存避免每次 new） */
  private readonly schedulerFacades = new Map<string, SchedulerFacade>();
  private readonly deps: SquadRuntimeDeps;
  private readonly stateStore: SchedulerStateStore;
  private readonly history: SchedulerHistory;
  private readonly heartbeatAdapter: HeartbeatPersistenceAdapter;

  constructor(deps: SquadRuntimeDeps) {
    this.deps = deps;
    this.stateStore = new SchedulerStateStore(deps.root);
    this.history = new SchedulerHistory(deps.root);
    this.heartbeatAdapter = new HeartbeatPersistenceAdapter({
      stateStore: this.stateStore,
      // [v0.0.116] 读 squad.heartbeatConfig + timezone（去 listHeartbeatRoles）
      getHeartbeatConfig: (squadId) => this.getHeartbeatConfig(squadId),
    });
  }

  /** 暴露 stateStore（T6 bootstrap 构造 HeartbeatHandler deps 用） */
  getStateStore(): SchedulerStateStore {
    return this.stateStore;
  }

  /** 暴露 history（T6 bootstrap 构造 HeartbeatHandler deps 用） */
  getHistoryStore(): SchedulerHistory {
    return this.history;
  }

  /**
   * boot 接入：扫 listSquads() → 对每个存在的 squad ensureScheduler；best-effort（spec §9）。
   * [v0.0.116 架构裁决] enableHeartBeat 开关不在 loadJobs/startAll 静态拦——killswitch 是
   * handler.tryFire gate0 每 tick 现取的动态 gate；恒注册确保开关切换 ≤1s 生效、history 有记录。
   */
  async startAll(): Promise<void> {
    const squads = await this.deps.squadStore.listSquads();
    await Promise.all(
      squads.map(async (s) => {
        try {
          await this.ensureScheduler(s.id);
        } catch {
          // best-effort：单 squad 启动失败不阻塞其他
        }
      }),
    );
  }

  /** lazy 注册 heartbeat jobs（幂等）；engine 未注入时仅打 ensure 标记（T2 兼容）。 */
  async ensureScheduler(squadId: string): Promise<void> {
    if (this.ensuredSquads.has(squadId)) return;
    if (this.deps.engine) {
      await this.registerHeartbeatJobs(squadId);
    }
    this.ensuredSquads.add(squadId);
  }

  /**
   * [v0.0.116] 私有：读 squad → projectSquadHeartbeatConfig（含 tz），供 heartbeatAdapter 注入。
   * null = squad 不存在。
   */
  private async getHeartbeatConfig(
    squadId: string,
  ): Promise<{ config: import('./scheduler/types').SquadHeartbeatConfig; tz: string } | null> {
    const squad = await this.deps.squadStore.getSquad(squadId);
    return projectSquadHeartbeatConfig(squad ?? null);
  }

  /**
   * 加载 squad 级 heartbeat job（0 或 1 个）→ engine.register（跟踪 jobId）。
   * [v0.0.116] loadJobs 返 0/1 squad job；不设 schedule.activeWindow（activeWindows 下沉 handler）。
   */
  private async registerHeartbeatJobs(squadId: string): Promise<void> {
    const engine = this.deps.engine;
    if (!engine) return;
    const jobs = await this.heartbeatAdapter.loadJobs(squadId);
    const tracked = new Set<string>();
    this.registeredJobIds.set(squadId, tracked);
    for (const job of jobs) {
      engine.register(job);
      tracked.add(job.id);
    }
  }

  /** 读 squad timezone（IANA；不存在 squad 兜底 UTC） */
  private async getSquadTimezone(squadId: string): Promise<string> {
    const squad = await this.deps.squadStore.getSquad(squadId);
    return squad ? (projectSquadSnapshot(squad).timezone ?? 'UTC') : 'UTC';
  }

  /** 卸本 squad 全量 heartbeat jobs（stopAll / reloadSquad diff 用；不 engine.stop） */
  private unregisterHeartbeatJobs(squadId: string): void {
    const engine = this.deps.engine;
    if (!engine) return;
    const tracked = this.registeredJobIds.get(squadId);
    if (!tracked) return;
    for (const jid of tracked) {
      engine.unregister(jid);
    }
    this.registeredJobIds.delete(squadId);
  }

  /**
   * PATCH /squad 后刷新：已 ensure → unregister+register（reload jobs）；未 ensure → ensure。
   * [v0.0.116] 成为 heartbeatConfig/enableHeartBeat/budget/tz 变更唯一实时刷入口（取代 reloadRole）。
   * enableHeartBeat 变更不需要 unregister job——killswitch 是 handler gate0 动态判，job 恒注册。
   */
  async reloadSquad(squadId: string): Promise<void> {
    if (this.ensuredSquads.has(squadId)) {
      // 已 ensure：diff reload（unregister 旧 → register 新，含 tz / heartbeat 配置变更）
      this.unregisterHeartbeatJobs(squadId);
      if (this.deps.engine) {
        await this.registerHeartbeatJobs(squadId);
      }
      return;
    }
    // 未 ensure：squad 存在即 ensure（不判 enableHeartBeat，killswitch 走 gate0 动态）
    await this.ensureScheduler(squadId);
  }

  /**
   * 暴露 thin facade（handler 查 history 用；[v0.0.116] 去 reloadRole）。
   * 不存在返 undefined（squad 未 ensure）。
   */
  getScheduler(squadId: string): SchedulerFacade | undefined {
    if (!this.ensuredSquads.has(squadId)) return undefined;
    let facade = this.schedulerFacades.get(squadId);
    if (!facade) {
      facade = makeSchedulerFacade(
        (limit, roleId) => this.history.getHistory(squadId, limit, roleId),
      );
      this.schedulerFacades.set(squadId, facade);
    }
    return facade;
  }

  /**
   * [v0.0.116] listMembers 投影 MemberSnapshot[]（HeartbeatHandler.listMembers 注入用）。
   * 供 boot.ts bootScheduler 构造 HeartbeatHandler deps 时注入。
   */
  async listMembersSnapshot(squadId: string): Promise<MemberSnapshot[]> {
    const members = await this.deps.memberStore.listMembers(squadId);
    return members.map((m: MemberEntity) => ({
      id: m.id,
      sessionId: m.sessionId ?? undefined,
      state: (m as MemberEntity & { state?: 'deployed' | 'benched' }).state ?? 'deployed',
      role: (m as MemberEntity & { role?: string }).role ?? '',
    }));
  }

  /** shutdown：卸本 runtime 注册的 heartbeat jobs（不 engine.stop，进程单例）；幂等。 */
  stopAll(): void {
    for (const squadId of this.ensuredSquads) {
      this.unregisterHeartbeatJobs(squadId);
    }
    this.ensuredSquads.clear();
    this.schedulerFacades.clear();
  }

  /**
   * [v0.0.111] disposeSquad —— per-squad 运行时 teardown（team 硬删的前置步骤）。
   * 停掉该 squad 内存里的调度/在跑 run，根除「潜伏调度」。
   * 幂等：未 ensure / squad 不存在 / 无 run 均安全 no-op。MUST NOT engine.stop（进程单例）。
   */
  async disposeSquad(squadId: string): Promise<void> {
    // abort 在跑的 leader/mate loop（枚举 squadChatSession + 各 member session；best-effort）
    const squad = await this.deps.squadStore.getSquad(squadId);
    const members = await this.deps.memberStore.listMembers(squadId);
    const sessionIds = new Set<string>();
    if (squad?.squadChatSessionId) sessionIds.add(squad.squadChatSessionId);
    for (const m of members) {
      if (m.sessionId) sessionIds.add(m.sessionId);
    }
    for (const sid of sessionIds) {
      try {
        await this.deps.agentManager.abortSession(sid);
      } catch {
        // best-effort
      }
    }
    // 注销本 squad heartbeat jobs
    this.unregisterHeartbeatJobs(squadId);
    // 清 per-squad 状态（不 engine.stop，进程单例）
    this.ensuredSquads.delete(squadId);
    this.schedulerFacades.delete(squadId);
  }

  /** 注册 SIGTERM/SIGINT trap（spec §10）；幂等 global flag 防重复挂载。 */
  registerShutdownTrap(): void {
    if (globalThis.__squadRuntimeShutdownTrapRegistered) return;
    globalThis.__squadRuntimeShutdownTrapRegistered = true;
    const handler = (): void => {
      try {
        this.stopAll();
      } catch {
        // trap 内吞错（防进程退出时抛 uncaught）
      }
    };
    process.on('SIGTERM', handler);
    process.on('SIGINT', handler);
  }

  /** 读 squad heartbeat job id（UT introspect 用） */
  getHeartbeatJobId(squadId: string): string {
    return heartbeatJobId(squadId);
  }

  /** UT seam：读 squad timezone（供测试验证 tz 注入） */
  getSquadTimezoneForTest(squadId: string): Promise<string> {
    return this.getSquadTimezone(squadId);
  }
}

// 模块级标记位（避免 trap 重复挂载）
declare global {
  // eslint-disable-next-line no-var
  var __squadRuntimeShutdownTrapRegistered: boolean | undefined;
}
