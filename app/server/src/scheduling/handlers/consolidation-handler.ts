/**
 * ConsolidationJobHandler —— type='consolidation' 的 JobHandler 实现（纯调度 glue）。
 * 参考: specs/tech/scheduling/[P1]consolidation_job.md §4（gate chain + fire() 语义）
 *       specs/tech/agent/memory/[P0]consolidation_tier2.md §5（runConsolidationTier2 分层说明）
 *
 * 设计（与 CronHandler/HeartbeatHandler 对偶，但 gate 链极短）：
 *   - 无 busy/budget/window 业务 gate（consolidation 是 app 级单例任务，无 session/squad 归属）
 *   - 模型反查 + skip 判定全部内聚在 runConsolidationTier2 内部，本类只做：
 *     读 app_config（gate1）→ 调 runner → 写 lastResult → 推进 lastFiredAt
 *   - lastFiredAt 推进语义显式偏离 scheduling/index.md §④ 原则2（"gate skip 不更新 lastFiredAt"）：
 *     consolidation 唯一的"跳过"路径（模型未配置）本身是 PRD 认定的合法执行结果（"到点必执行一次"），
 *     故几乎每次 fire 都推进 lastFiredAt；只有读 app_config 本身抛异常（基础设施故障级）才不推进，
 *     留给下一 tick 自然重试。
 */
import type { Job, JobHandler } from '../types';
import type { SchedulerEngine } from '../engine';
import type { AppConfigService } from '../../config/app-config-service';
import type { PluginManager } from '../../plugin/plugin-manager';
import type { AgentManagerImpl } from '../../agent/agent-manager';
import type { SessionStore } from '../../agent/session-store';
import { runConsolidationTier2 } from '../../agent/consolidation-tier2/runner';
import type { ConsolidationPersistenceAdapter } from '../persistence/consolidation-adapter';
import type { AppTaskLock } from '../../agent/app-task-lock';

/** [v0.0.164] app 级任务类型固定值——cron + 手动 POST /consolidation/run 共享同 taskType 撞车保护 */
const CONSOLIDATION_TASK_TYPE = 'tier2_consolidation';

/** ConsolidationJobHandler 依赖（构造注入；boot.ts 装配，UT 用 mock） */
export interface ConsolidationJobHandlerDeps {
  appConfig: AppConfigService;
  pluginManager: PluginManager;
  agentManager: AgentManagerImpl;
  sessionStore: SessionStore;
  /** app 数据根（绝对路径） */
  dataDir: string;
  /** consolidation/state.json 持久化（写 lastResult + upsertJob 保 lastFiredAt 续接） */
  adapter: ConsolidationPersistenceAdapter;
  /** engine 反向引用（fire 后 updateJobLastFiredAt；engine 不感知 handler 存在） */
  engine: SchedulerEngine;
  /**
   * [v0.0.164] AppTaskLock 单例（bootstrap 层构造）——gate2 acquire('tier2_consolidation')
   * 撞车保护（cron + 手动 POST /consolidation/run 共享同 taskType）。
   *
   * 缺省 undefined 时 fire 走既有无 lock 路径（既有 UT 兼容，"到点必执行一次" 语义不变）；
   * 提供时 acquire fail 静默跳过 + 不推进 lastFiredAt（"本窗口别人在跑" 无需重复 fire）。
   */
  appTaskLock?: AppTaskLock;
}

/**
 * ConsolidationJobHandler —— consolidation job 的纯调度 glue（不重复实现模型反查/skip 判定）。
 * engine.tick 内 `void handler.fire(job, now)`；handler 完成读配置 + 调 runner + 落盘 + 推进锚点。
 */
export class ConsolidationJobHandler implements JobHandler {
  constructor(private readonly deps: ConsolidationJobHandlerDeps) {}

  /**
   * engine 调入口（fire-and-forget，engine 不 await）。
   * gate1：读 app_config.consolidation 本身抛异常（灾难性）→ 不推进 lastFiredAt，直接 return（下 tick 重试）。
   * 否则调 runConsolidationTier2（内聚模型反查 + skip 判定 + 三段串行）→ 写 lastResult →
   *   无论内部成败（含"模型未配置"合法 skip）都推进 lastFiredAt（本类对 index.md 原则2 的显式例外）。
   */
  async fire(job: Job, now: Date): Promise<void> {
    if (job.type !== 'consolidation') return;
    try {
      // gate1：仅验证读配置本身不抛异常（真正的 modelId 反查/skip 判定内聚在 runner 内部）
      this.deps.appConfig.get('consolidation', 'default');
    } catch {
      // 灾难性失败（连配置都读不出）：不推进 lastFiredAt，留给下 tick 重试
      return;
    }
    // [v0.0.164] gate2：AppTaskLock acquire('tier2_consolidation') 撞车保护（PRD 定案 3）。
    //   engine per-job inFlight 只防同 Promise 重入，不防跨触发源（cron + 手动 POST）碰撞；
    //   AppTaskLock 才是「cron 到点」+「手动 POST 已在跑」并发唯一保护。
    //   acquire 失败 = 本窗口已被别人（手动触发）承担，静默跳过 + **不推进 lastFiredAt**
    //   （下 tick 再评估；手动完成后 acquire 成功。runConsolidationTier2 三段串行远快于 24h 窗口）。
    //   lock 缺省时（appTaskLock=undefined，既有 UT 兼容）走无 lock 路径，语义不变。
    const lock = this.deps.appTaskLock;
    if (lock && !lock.acquire(CONSOLIDATION_TASK_TYPE, 'cron:' + now.toISOString())) {
      return;
    }
    try {
      const result = await runConsolidationTier2({
        appConfig: this.deps.appConfig,
        pluginManager: this.deps.pluginManager,
        agentManager: this.deps.agentManager,
        sessionStore: this.deps.sessionStore,
        dataDir: this.deps.dataDir,
        // 窗口起点 = 上次真实 fire 时刻（tier2 spec §3.1）；首次 fire（lastFiredAt=null）
        // 缺省不传，由 runner 内部回退 now-24h
        ...(job.lastFiredAt !== null ? { windowStart: job.lastFiredAt } : {}),
      });
      this.deps.adapter.writeLastResult({ lastRunAt: now.toISOString(), summary: result.summary });
      if (lock) lock.markDone(CONSOLIDATION_TASK_TYPE);
    } catch (err) {
      // best-effort：runner 内部已 try/catch 吞异常，理论不应到达此处；防御性兜底不阻塞推进锚点。
      // [v0.0.164] lock 存在时必 markFailed（否则锁永不释放——spec app_task_lock.md §4）。
      if (lock) {
        const msg = err instanceof Error ? err.message : String(err);
        lock.markFailed(CONSOLIDATION_TASK_TYPE, msg);
      }
    }
    // 无论上面 try 块是否异常（含"模型未配置"这类合法 skip），都推进 lastFiredAt——
    // "到点必执行一次"的调度语义（显式偏离 index.md 原则2，理由见文件头注释）。
    // 例外：gate2 acquire fail 分支上面已 return，不到达此处；lastFiredAt 不推进（"本窗口别人承担"）。
    this.deps.engine.updateJobLastFiredAt(job.id, now.toISOString());
    await this.deps.adapter.upsertJob(job.owner, { ...job, lastFiredAt: now.toISOString() });
  }
}
