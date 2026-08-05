/**
 * registerConsolidationJob —— consolidation job 的 boot-time-only 装配（拆出 boot.ts，避免超 300 行）。
 * 参考: specs/tech/scheduling/[P1]consolidation_job.md §3（boot 装配语义）§6（文件级变更清单）
 *
 * 设计：
 *   - consolidationAdapter 无条件构造（不依赖 enabled）——router 层 test-only 端点（POST
 *     /test/consolidation/run）+ GET /consolidation/status（Task3）均需经此实例读写 lastResult，
 *     即便 enabled=false 也要能用。
 *   - 仅 `enabled===true` 才把 job 注册进 registry/engine；modelId 未配置不是 boot 门槛
 *     （handler 内业务级 skip，见 spec §3 例外）。
 *   - lastFiredAt/createdAt 续接：重启后读回上次持久化值（同 cron/heartbeat 的 at-most-once 范式）。
 *   - deps.appConfig/pluginManager/dataDir 任一缺失 → 直接返回 undefined（跳过整个装配，
 *     兼容未传这三个可选字段的既有调用方/测试）。
 */
import type { SchedulerEngine } from './engine';
import type { JobHandlerRegistry } from './registry';
import type { Job } from './types';
import type { AppConfigService } from '../config/app-config-service';
import type { PluginManager } from '../plugin/plugin-manager';
import type { AgentManagerImpl } from '../agent/agent-manager';
import type { SessionStore } from '../agent/session-store';
import type { ConsolidationAppConfigData } from '../agent/consolidation-tier2/model-resolve';
import { ConsolidationPersistenceAdapter } from './persistence/consolidation-adapter';
import { ConsolidationJobHandler } from './handlers/consolidation-handler';
import { dailyTimeToCron } from './consolidation-cron';
import type { AppTaskLock } from '../agent/app-task-lock';

/** consolidation job 固定 id（app 级单例，全局唯一） */
const CONSOLIDATION_JOB_ID = 'consolidation:app';

/** registerConsolidationJob 依赖（bootScheduler 调用注入） */
export interface RegisterConsolidationJobDeps {
  engine: SchedulerEngine;
  registry: JobHandlerRegistry;
  agentManager: AgentManagerImpl;
  sessionStore: SessionStore;
  /** 单一时间源（UT seam；bootScheduler 透传其 nowFn） */
  now: () => Date;
  /** consolidation 装配需要的三个可选字段——任一缺失则跳过整个装配（见文件头注释） */
  appConfig?: AppConfigService;
  pluginManager?: PluginManager;
  dataDir?: string;
  /**
   * [v0.0.164] AppTaskLock 单例（bootstrap 层构造）——透传到 ConsolidationJobHandler 供 cron
   * fire 时 gate2 acquire('tier2_consolidation') 撞车保护（cron + 手动 POST /consolidation/run 撞车）。
   * 缺省 undefined 时 handler 走无 lock 分支（既有测试兼容 + 既有 lastFiredAt 推进语义）。
   */
  appTaskLock?: AppTaskLock;
}

/**
 * 装配 consolidation job（boot-time-only）。返回无条件构造的 ConsolidationPersistenceAdapter
 * （即便 enabled=false 也返回，供 test-only 端点/状态端点使用）；deps 缺关键字段返 undefined。
 */
export async function registerConsolidationJob(
  deps: RegisterConsolidationJobDeps,
): Promise<ConsolidationPersistenceAdapter | undefined> {
  if (!deps.appConfig || !deps.pluginManager || deps.dataDir === undefined) return undefined;
  const { appConfig, pluginManager, dataDir } = deps;

  const adapter = new ConsolidationPersistenceAdapter({ fsRoot: dataDir });
  const cfg = appConfig.get('consolidation', 'default') as ConsolidationAppConfigData | undefined;
  // enabled!==true（含 record 缺失）→ boot 时根本不注册 job（引擎 jobs Map 里没有它，等价关闭）
  if (!cfg || cfg.enabled !== true) return adapter;

  // 续接上次持久化的 lastFiredAt/createdAt（重启后 at-most-once 补偿语义，同 cron/heartbeat）
  const persisted = await adapter.loadJobs('app');
  const existingJob = persisted.find((j) => j.id === CONSOLIDATION_JOB_ID);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const job: Job = {
    id: CONSOLIDATION_JOB_ID,
    type: 'consolidation',
    schedule: { kind: 'cron', expr: dailyTimeToCron(cfg.dailyTime), tz },
    payload: {},
    lastFiredAt: existingJob?.lastFiredAt ?? null,
    enabled: true,
    createdAt: existingJob?.createdAt ?? deps.now().toISOString(),
    owner: 'app',
  };
  const handler = new ConsolidationJobHandler({
    appConfig,
    pluginManager,
    agentManager: deps.agentManager,
    sessionStore: deps.sessionStore,
    dataDir,
    adapter,
    engine: deps.engine,
    // [v0.0.164] 可选 lock 透传：present 时 handler.fire 加 gate2 acquire；absent 时走既有无 lock 路径
    ...(deps.appTaskLock ? { appTaskLock: deps.appTaskLock } : {}),
  });
  deps.registry.register('consolidation', handler);
  deps.engine.register(job);
  return adapter;
}
