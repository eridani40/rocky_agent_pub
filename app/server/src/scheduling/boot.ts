/**
 * bootScheduler —— T6 装配 SchedulerEngine 进程单例（heartbeat + cron handler + 双源 loadJobs）。
 * 参考: specs/tech/scheduling/[P0]engine.md §6（重启续接 boot loader 伪码）
 *       specs/tech/scheduling/[P1]cron_subsystem.md §8（session 销毁 hook wiring）
 *       specs/tech/scheduling/index.md §③ 装配图 + §④ 9 大原则
 *       specs/tech/squad/[P1]scheduler.md §5（budget cache refresh side-effect 模式，v0.0.33.4 保留）
 *
 * 设计（独立子模块，避免 bootstrap.ts 超 300 行）：
 *   1. createEngine()：构造 registry（空）+ engine（不 start）+ cronStore，先返 engine
 *      —— 必须在 squadRuntime 之前（squadRuntime 需要 engine 注入 registerHeartbeatJobs）
 *   2. bootScheduler()：注册 handlers + 双源 loadJobs + onSessionDestroyed wire + trap + start
 *
 * Two-phase init 动机：squadRuntime 持 engine ref（heartbeat 双源 loadJobs 之一），而 HeartbeatHandler
 *   依赖 squadRuntime.stateStore/history。bootstrap 调 createEngine → 用 engine 构造 squadRuntime → 调
 *   bootScheduler(squadRuntime, engine)，打破循环。
 *
 * budget sync cache（v0.0.33.4 行为对齐）：HeartbeatHandlerDeps.budgetRemaining 是 sync 契约，
 *   budgetAggregator.squadBudgetRemaining 是 async（含 refresh side-effect），故 boot 提供 sync 包装：
 *   boot 时 prime cache（拉全 squad 一次）+ 30s setInterval(refreshAll).unref() 后台刷新；
 *   cache.get(sid) ?? Infinity（缺省放行，对齐 null-budget）。
 *
 * T2/T3/T4 交接点（T6 全部 resolved）：
 *   - T2 SquadRuntimeDeps.engine optional → T6 注入真实 engine
 *   - T3 sessionStore.onSessionDestroyed hook → T6 注入 callback（避免 session-store→scheduling 循环依赖）
 *   - T4 BootstrapResult.cronStore/schedulerEngine optional → T6 装配后 required（router 不再 503）
 *   - T4 SessionHandlerDeps.cronToolDeps → T6 装配好后透传（agent cron_* 工具读 ctx.config.cronToolDeps）
 */
import { CronPersistenceAdapter } from './persistence/cron-adapter';
import { HeartbeatHandler } from './handlers/heartbeat-handler';
import { CronHandler } from './handlers/cron-handler';
import { SchedulerEngine } from './engine';
import { JobHandlerRegistry } from './registry';
import type { CronPayload } from './payloads';
import type { SquadStore, SquadEntity } from '../stores/squad-store';
import type { SessionStore } from '../agent/session-store';
import type { AgentManagerImpl } from '../agent/agent-manager';
import type { BudgetAggregator } from '../squad/budget/budget-aggregator';
import type { SquadRuntime } from '../squad/squad-runtime';
import { projectSquadSnapshot } from '../squad/squad-runtime-helpers';
// consolidation job（app 级单例，boot-time-only 注册；装配逻辑见 consolidation-boot.ts）
import type { AppConfigService } from '../config/app-config-service';
import type { PluginManager } from '../plugin/plugin-manager';
import { registerConsolidationJob } from './consolidation-boot';
import type { ConsolidationPersistenceAdapter } from './persistence/consolidation-adapter';
import type { AppTaskLock } from '../agent/app-task-lock';

/** createEngine 返回（bootScheduler 入参 + BootstrapResult 字段） */
export interface CreateEngineResult {
  /** 公共调度引擎进程单例（heartbeat + cron 共享；registry 暂空，bootScheduler 注册 handlers） */
  engine: SchedulerEngine;
  /** JobHandlerRegistry 引用（bootScheduler 注册 HeartbeatHandler + CronHandler 用） */
  registry: JobHandlerRegistry;
  /** cron.json 持久化（session 级分片） */
  cronStore: CronPersistenceAdapter;
}

/** bootScheduler 依赖（bootstrap 装配；UT 用 mock） */
export interface BootSchedulerDeps {
  /** createEngine() 产出的 engine（已 wire 给 squadRuntime） */
  engine: SchedulerEngine;
  /** createEngine() 产出的 registry（bootScheduler 注册 handlers 用） */
  registry: JobHandlerRegistry;
  /** createEngine() 产出的 cronStore（同生命周期） */
  cronStore: CronPersistenceAdapter;
  /** squad runtime（提供 stateStore/history 给 HeartbeatHandler；其内部 heartbeatAdapter 双源之一） */
  squadRuntime: SquadRuntime;
  /** squad store（HeartbeatHandler.getSquad 取 enableHeartBeat/budget/timezone + budget cache prime 用） */
  squadStore: SquadStore;
  /** session store（CronHandler.sessionExists + onSessionDestroyed hook wire + 双源扫 listSessions） */
  sessionStore: SessionStore;
  /** agent manager（HeartbeatHandler/CronHandler 共用 isSessionBusy + deliverTo） */
  agentManager: AgentManagerImpl;
  /** budget aggregator（HeartbeatHandler sync cache prime + CronHandler async squadBudgetRemaining gate） */
  budgetAggregator: BudgetAggregator;
  /** UT seam：单一时间源（缺省 () => new Date()） */
  now?: () => Date;
  /** UT seam：注入 setInterval（避免真实 timer） */
  setInterval?: typeof setInterval;
  /** UT seam：注入 clearInterval（避免真实 timer） */
  clearInterval?: typeof clearInterval;
  /** consolidation job 装配需要（三者均可选；缺任一则跳过 consolidation 注册步骤，
   *  heartbeat/cron 两既有 job type 不受影响；dataDir=app 数据根绝对路径） */
  appConfig?: AppConfigService;
  pluginManager?: PluginManager;
  dataDir?: string;
  /**
   * [v0.0.164] AppTaskLock 单例（bootstrap 层构造）——透传到 registerConsolidationJob
   * 供 ConsolidationJobHandler.fire 加 gate2 acquire('tier2_consolidation') 撞车保护。
   * 缺省时 registerConsolidationJob 跳过 lock 接入（既有测试兼容）。
   */
  appTaskLock?: AppTaskLock;
}

/**
 * createEngine —— 构造 SchedulerEngine + 空 registry + CronPersistenceAdapter。
 *
 * 必须在 squadRuntime 构造之前调（squadRuntime 需要 engine 注入 registerHeartbeatJobs）。
 * registry 暂空 —— bootScheduler 内部注册 HeartbeatHandler + CronHandler。
 * engine 不 start —— bootScheduler 内部 start。
 *
 * now 透传（v0.0.64 P3 BUG-002 修复）：测试侧声明 now（窗外）必须真实到达 engine.tick → isDue/handler.fire 的 gate1，
 * 否则 engine fallback 真实墙上时间，R2 在真实窗口内时间跑时 gate1 误过 → flaky。
 * now=undefined（生产 bootstrap.ts 调用）→ engine fallback 真实时间（spec [P0]engine.md §2 line 42 UT seam 契约）。
 *
 * @param dataDir fs root（CronPersistenceAdapter 落 {root}/sessions/{sid}/cron.json）
 * @param sessionStore sessionStore 引用（cronStore.resolveSquadId 从 sessionStore.getSession 派生 squadId）
 * @param now UT seam：单一时间源（缺省 undefined → engine 内部 fallback `() => new Date()`）
 */
export function createEngine(
  dataDir: string,
  sessionStore: SessionStore,
  now?: () => Date,
): CreateEngineResult {
  const registry = new JobHandlerRegistry();
  // 透传 now：测试侧 now 必须到达 engine，否则 BUG-002 时间注入泄露（engine 用真实墙上时间）
  const engine = new SchedulerEngine({ registry, ...(now !== undefined ? { now } : {}) });
  const cronStore = new CronPersistenceAdapter({
    fsRoot: dataDir,
    // squadId 派生从 sessionStore.getSession（避免 scheduling → agent → scheduling 循环依赖，spec §8）
    resolveSquadId: async (sessionId) => {
      const s = await sessionStore.getSession(sessionId);
      return s?.squadId ?? null;
    },
  });
  return { engine, registry, cronStore };
}

/** bootScheduler 返回（bootstrap 写入 BootstrapResult 的 cronToolDeps + shutdown 字段；engine/cronStore 已在入参） */
export interface BootSchedulerResult {
  /**
   * CronToolDeps（agent cron_* 工具读 ctx.config.cronToolDeps；router → session-config 透传）。
   * 形态对齐 tools/cron/cron-tool-shared.ts CronToolDeps（鸭子类型）。
   */
  cronToolDeps: {
    cronStore: CronPersistenceAdapter;
    engine: SchedulerEngine;
    sessionStore: SessionStore;
    squadStore: SquadStore;
  };
  /** shutdown hook（process exit 时调；trap 已自动挂，bootstrap 一般不需手动调，UT 显式 stop 用） */
  shutdown: () => void;
  /** consolidation/state.json 持久化适配器（app 级单例，无条件构造不依赖 enabled）；test-only
   *  端点 + GET /consolidation/status 经此读写 lastResult；deps 缺字段时为 undefined。 */
  consolidationAdapter?: ConsolidationPersistenceAdapter;
}

/**
 * bootScheduler —— 装配 SchedulerEngine（注册 handlers + 双源 loadJobs + start + trap + onSessionDestroyed wire）。
 *
 * 装配顺序（spec engine.md §6）：prime budget cache → 注册 handlers → squadRuntime.startAll（heartbeat 源）
 *   → 扫 sessionStore.listSessions 装载 cron jobs → wire onSessionDestroyed → SIGTERM trap → engine.start
 *
 * 前置条件：caller（bootstrap）必须先 createEngine() → 用 engine 构造 squadRuntime → 再调本函数。
 *
 * 幂等性：本函数假定 bootstrap 调一次（cronStore/engine 进程单例）。重复调会被 caller（bootstrap）防抖。
 */
export async function bootScheduler(deps: BootSchedulerDeps): Promise<BootSchedulerResult> {
  const {
    engine, registry, cronStore, squadRuntime, squadStore, sessionStore, agentManager, budgetAggregator,
  } = deps;
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;
  const nowFn = deps.now ?? (() => new Date());

  // ── 1. prime budget sync cache（首次拉全 squad + 30s 后台刷新） ──
  // v0.0.33.4 行为对齐：HeartbeatHandlerDeps.budgetRemaining 是 sync 契约；
  // budgetAggregator.squadBudgetRemaining 是 async（含 refresh side-effect），故 boot 提供 sync 包装。
  const budgetCache = new Map<string, number>();
  const refreshBudgetCache = async (): Promise<void> => {
    try {
      const squads = await squadStore.listSquads();
      await Promise.all(
        squads.map(async (s: SquadEntity) => {
          if (s.budget === null || s.budget === undefined) return; // null-budget 不入 cache（gate short-circuit）
          try {
            const remaining = await budgetAggregator.squadBudgetRemaining(s.id, nowFn());
            budgetCache.set(s.id, remaining);
          } catch {
            // best-effort：单 squad 失败不阻塞其他（cache 缺值时 sync read 返 Infinity 放行）
          }
        }),
      );
    } catch {
      // best-effort：listSquads 失败忽略（cache 留空，gate 退化放行）
    }
  };
  await refreshBudgetCache();
  const budgetRefreshHandle = setIntervalFn(() => {
    void refreshBudgetCache();
  }, 30_000);
  // .unref() 防孤立进程（test-process-cleanup-or-crash 教训）
  const unrefHandle = budgetRefreshHandle as unknown as { unref?: () => void };
  if (typeof unrefHandle.unref === 'function') unrefHandle.unref();

  // ── 3. 注册 HeartbeatHandler + CronHandler（engine 反向引用同一实例） ──
  const heartbeatHandler = new HeartbeatHandler({
    getSquad: async (squadId) => {
      const squad = await squadStore.getSquad(squadId);
      return squad ? projectSquadSnapshot(squad) : undefined;
    },
    // listMembers 委托 squad-runtime（内部持 memberStore，投影 MemberSnapshot[]；逐成员展开）
    listMembers: (squadId) => squadRuntime.listMembersSnapshot(squadId),
    // sync cache read（gate2 仅在 squad.budget!==null 时调，cache 缺值返 Infinity 放行）
    budgetRemaining: (squadId) => budgetCache.get(squadId) ?? Number.POSITIVE_INFINITY,
    isSessionBusy: (sid) => agentManager.isSessionBusy(sid),
    deliverTo: (sid, msg) => agentManager.deliverTo(sid, msg),
    stateStore: squadRuntime.getStateStore(),
    history: squadRuntime.getHistoryStore(),
    engine,
  });
  registry.register('heartbeat', heartbeatHandler);

  const cronHandler = new CronHandler({
    sessionExists: async (sid) => {
      const s = await sessionStore.getSession(sid);
      return !!s;
    },
    isSessionBusy: (sid) => agentManager.isSessionBusy(sid),
    squadBudgetRemaining: async (squadId) => {
      // budget=null 放行（playground）；非 null && <=0 skip
      const squad = await squadStore.getSquad(squadId);
      if (!squad || squad.budget === null || squad.budget === undefined) return null;
      return budgetAggregator.squadBudgetRemaining(squadId, nowFn());
    },
    deliverTo: (sid, msg) => agentManager.deliverTo(sid, msg),
    cronStore,
    engine,
  });
  registry.register('cron', cronHandler);

  // ── 4. heartbeat 双源之一：squadRuntime.startAll（内部 load heartbeat jobs → engine.register） ──
  // best-effort：单 squad 启动失败不阻塞；handler PATCH 后 reloadSquad 兜底 lazy 上线
  await squadRuntime.startAll().catch(() => {
    // 启动失败忽略：cron 装配不应被 heartbeat 故障阻塞
  });

  // ── 5. cron 双源：扫 sessionStore.listSessions → cronStore.loadJobs per session ──
  // best-effort：单 session 读 cron.json 失败不阻塞其他
  try {
    const sessions = await sessionStore.listSessions();
    for (const s of sessions) {
      try {
        const jobs = await cronStore.loadJobs(s.id);
        for (const job of jobs) {
          engine.register(job);
        }
      } catch {
        // best-effort：单 session 失败不阻塞其他
      }
    }
  } catch {
    // listSessions 失败忽略（理论上不应失败；防御性兜底）
  }

  // ── 6. wire sessionStore.onSessionDestroyed → cronStore.removeAllJobs + engine.unregister loop ──
  // fs cascade（rm -rf sessions/<sid>/）已删 cron.json 文件，cronStore.removeAllJobs 为 no-op（idempotent 安全）；
  // 主要做 engine.unregister（清内存 job），spec [P1]cron_subsystem.md §8。
  // 注入式 callback（避免 session-store → scheduling → session-store 循环依赖，spec §8）
  sessionStore.onSessionDestroyed = async (sessionId) => {
    try {
      await cronStore.removeAllJobs(sessionId);
    } catch {
      // best-effort：fs cascade 已删 cron.json，此处 no-op 安全
    }
    // 扫内存 cron job table，注销该 session 全部 cron job
    const snapshot = engine.snapshot();
    for (const job of snapshot.values()) {
      if (job.type !== 'cron') continue;
      const p = job.payload as CronPayload;
      if (p.sessionId === sessionId) {
        engine.unregister(job.id);
      }
    }
  };

  // ── consolidation job（app 级单例，boot-time-only 注册；装配逻辑见 consolidation-boot.ts）──
  // deps 缺 appConfig/pluginManager/dataDir 任一则优雅跳过（兼容未传新字段的既有调用方/测试）。
  const consolidationAdapter = await registerConsolidationJob({
    engine, registry, agentManager, sessionStore, now: nowFn,
    ...(deps.appConfig ? { appConfig: deps.appConfig } : {}),
    ...(deps.pluginManager ? { pluginManager: deps.pluginManager } : {}),
    ...(deps.dataDir !== undefined ? { dataDir: deps.dataDir } : {}),
    ...(deps.appTaskLock ? { appTaskLock: deps.appTaskLock } : {}),
  });

  // ── 7. 注册 SIGTERM/SIGINT trap → engine.stop + budget refresh clear ──
  // 与 squad-runtime.registerShutdownTrap 同模式；幂等 global flag 防重复挂载
  const shutdown = (): void => {
    try {
      engine.stop();
    } catch {
      // trap 内吞错（防进程退出时抛 uncaught）
    }
    try {
      clearIntervalFn(budgetRefreshHandle);
    } catch {
      // best-effort
    }
  };
  registerSchedulerEngineShutdownTrap(shutdown);

  // ── 8. engine.start（boot 启，1s setInterval.unref） ──
  engine.start();

  return {
    cronToolDeps: {
      cronStore,
      engine,
      sessionStore,
      squadStore,
    },
    shutdown,
    ...(consolidationAdapter ? { consolidationAdapter } : {}),
  };
}

/**
 * 注册 SIGTERM/SIGINT trap → engine.stop（与 squad-runtime.registerShutdownTrap 同模式）。
 * 幂等 global flag 防重复挂载（test-process-cleanup-or-crash 教训：避免 trap 重复挂导致测试泄漏）。
 */
function registerSchedulerEngineShutdownTrap(shutdown: () => void): void {
  if (globalThis.__schedulerEngineShutdownTrapRegistered) return;
  globalThis.__schedulerEngineShutdownTrapRegistered = true;
  const handler = (): void => {
    try {
      shutdown();
    } catch {
      // trap 内吞错（防进程退出时抛 uncaught）
    }
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}

// 模块级标记位（与 squad-runtime / session-workspace-manager 同模式：避免 trap 重复挂载）
declare global {
  // eslint-disable-next-line no-var
  var __schedulerEngineShutdownTrapRegistered: boolean | undefined;
}
