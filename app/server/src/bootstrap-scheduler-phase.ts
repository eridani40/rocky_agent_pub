/**
 * bootstrap-scheduler-phase — Phase 9 装配：SquadRuntime + BudgetAggregator + SchedulerEngine
 *
 * 纯 move 自 bootstrap.ts（v0.0.156 结构性拆分）。函数体 100% copy-paste，签名 + 内部逻辑不变。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.1 Phase 9 + §4.2 第五行
 *
 * 装配顺序（INV-C-1 + two-phase init 打破 engine ↔ squadRuntime 循环引用）：
 *   1. budgetState 先建（无 engine 依赖）
 *   2. budgetAggregator（注入 squadStore/memberStore + getUsageTotalTokens(store, budgetState)）
 *   3. createEngine()：构造 SchedulerEngine（registry 空 + 不 start）+ CronPersistenceAdapter
 *   4. squadRuntime 构造（engine wired；heartbeat 双源 loadJobs 之一）
 *   5. squadRuntime.registerShutdownTrap（SIGTERM/SIGINT trap）
 *   6. bootScheduler()：注册 HeartbeatHandler/CronHandler + 双源 loadJobs +
 *      onSessionDestroyed wire + SIGTERM trap + engine.start
 *
 * 关键时序：cronToolDeps 在 bootScheduler 完成后才产出（agent activate 时已读 lateBound.cronToolDeps.value）。
 * SIGTERM trap 必须 engine.start 前挂（engine.stop + squadRuntime.stopAll）。
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径；dataDir 作入参。
 */
import type { SessionStore } from './agent/session-store';
import type { AgentManagerImpl } from './agent/agent-manager';
import type { PluginManager } from './plugin';
import type { AppConfigService } from './config/app-config-service';
import type { SchedulerEngine } from './scheduling/engine';
import type { CronPersistenceAdapter } from './scheduling/persistence/cron-adapter';
import type { ConsolidationPersistenceAdapter } from './scheduling/persistence/consolidation-adapter';
import type { AppTaskLock } from './agent/app-task-lock';
import type { ReplayableEventBus } from './agent/event-bus';
// SquadRuntime + BudgetAggregator + BudgetState —— squad scheduler 生命周期 glue
import { SquadRuntime, makeGetUsageTotalTokens } from './squad/squad-runtime';
import { BudgetAggregator } from './squad/budget/budget-aggregator';
import { BudgetState } from './squad/budget-state';
import { SquadStore, MemberStore } from './stores/squad-store';
// scheduling 装配（bootScheduler 在 scheduling/boot.ts）
import { bootScheduler, createEngine } from './scheduling/boot';

/**
 * Phase 9 装配：SquadRuntime + BudgetAggregator + SchedulerEngine + bootScheduler。
 *
 * @returns squadRuntime + budgetAggregator + budgetState + schedulerEngine + cronStore +
 *          cronToolDeps（透传给 lateBound.cronToolDeps.value）+ consolidationAdapter? + squadStore
 */
export async function bootstrapSchedulerPhase(deps: {
  dataDir: string;
  store: SessionStore;
  agentManager: AgentManagerImpl;
  appConfig: AppConfigService;
  pluginManager: PluginManager;
  /**
   * session_panel topic 的 bus（来自 bus-phase）。
   * 透传到 bootScheduler → cronToolDeps.statusBus，cron 写操作后 emit session_cron_changed。
   */
  sessionStatusBus?: ReplayableEventBus;
  /**
   * [v0.0.164] AppTaskLock 单例（bootstrap 层构造）——透传到 ConsolidationJobHandler
   * 供 cron fire 时 gate2 acquire('tier2_consolidation') 撞车保护。
   * 缺省 undefined 时 registerConsolidationJob 会跳过 lock 接入（保持既有测试兼容）。
   */
  appTaskLock?: AppTaskLock;
}): Promise<{
  squadRuntime: SquadRuntime;
  budgetAggregator: BudgetAggregator;
  budgetState: BudgetState;
  schedulerEngine: SchedulerEngine;
  cronStore: CronPersistenceAdapter;
  cronToolDeps: unknown;
  consolidationAdapter?: ConsolidationPersistenceAdapter;
  squadStore: SquadStore;
}> {
  const { dataDir, store, agentManager, appConfig, pluginManager, appTaskLock, sessionStatusBus } = deps;

  const budgetState = new BudgetState(dataDir);
  const squadStoreForRuntime = new SquadStore({ root: dataDir });
  const memberStoreForRuntime = new MemberStore({ root: dataDir });
  const budgetAggregator = new BudgetAggregator({
    squadStore: squadStoreForRuntime,
    memberStore: memberStoreForRuntime,
    getUsageTotalTokens: makeGetUsageTotalTokens(store, budgetState),
  });
  // two-phase init：先 createEngine，再 squadRuntime 持 engine ref，再 bootScheduler
  const { engine: schedulerEngine, registry: schedulerRegistry, cronStore } = createEngine(dataDir, store);
  const squadRuntime = new SquadRuntime({
    root: dataDir,
    squadStore: squadStoreForRuntime,
    memberStore: memberStoreForRuntime,
    sessionStore: store,
    agentManager,
    engine: schedulerEngine,
  });
  squadRuntime.registerShutdownTrap();
  // bootScheduler 装配 handlers + 双源 loadJobs + onSessionDestroyed wire + trap + start。
  // 内部调用 squadRuntime.startAll（heartbeat 双源 loadJobs），故无需再单独 fire-and-forget 启动。
  // 注：bootScheduler 内已 engine.start（1s setInterval.unref），并挂 SIGTERM trap（engine.stop）。
  const bootSchedulerResult = await bootScheduler({
    engine: schedulerEngine,
    registry: schedulerRegistry,
    cronStore,
    squadRuntime,
    squadStore: squadStoreForRuntime,
    sessionStore: store,
    agentManager,
    budgetAggregator,
    // sessionStatusBus 透传到 cronToolDeps.statusBus（cron 写操作后 emit session_cron_changed）
    ...(sessionStatusBus ? { sessionStatusBus } : {}),
    // consolidation job 装配需要——透传 bootstrap 既有单例（不新建重复的
    // AppConfigService/PluginManager 实例，见 consolidation_job.md §6）
    appConfig,
    pluginManager,
    dataDir,
    // [v0.0.164] appTaskLock 透传到 registerConsolidationJob（handler cron fire gate2 用）
    ...(appTaskLock ? { appTaskLock } : {}),
  });

  return {
    squadRuntime,
    budgetAggregator,
    budgetState,
    schedulerEngine,
    cronStore,
    cronToolDeps: bootSchedulerResult.cronToolDeps,
    ...(bootSchedulerResult.consolidationAdapter
      ? { consolidationAdapter: bootSchedulerResult.consolidationAdapter }
      : {}),
    squadStore: squadStoreForRuntime,
  };
}
