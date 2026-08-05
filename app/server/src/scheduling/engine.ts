/**
 * SchedulerEngine — 公共调度引擎（进程单例，默认 30s 轮询，fire-and-forget）。
 * 参考: specs/tech/scheduling/[P0]engine.md §2-§7（权威契约）
 *       specs/tech/scheduling/index.md §④ 9 大核心原则（纯度 / fire-and-forget / lastFiredAt 锚 / reschedule from now）
 *
 * 设计：
 *   - 进程单例：1 个 setInterval(tick, SCHEDULER_TICK_MS).unref() 遍历 Map<jobId, Job>
 *   - 默认 tick 间隔 30_000ms（30s）：最小调度粒度分钟级（heartbeat ≥5min/cron 分钟粒度），
 *     30s 保证每分钟至少一次检查；isDue 是 `now >= 到点` 比较，拉长 tick 只影响最坏迟到 30s，无漏拍。
 *   - 可配：SCHEDULER_TICK_MS 环境变量（测试环境设 1000 避免超时，见 tests/test.env）
 *   - isDue 纯函数（双分支 interval/cron），engine 不持 nextFireAt 内存
 *   - tick 同步函数不返 Promise；对每个 due job `void handler.fire(job, now)`
 *   - handler 内部 gate 通过 deliverTo 成功后调 engine.updateJobLastFiredAt
 *   - interval.unref() 防孤立进程（test-process-cleanup-or-crash 教训）
 *
 * 引擎纯度（硬性 grep 约束）：本文件不含业务层语义字样。
 * 业务 gate 全下沉 handler（heartbeat-handler / cron-handler）。
 */
import type { Job } from './types';
import type { JobHandlerRegistry } from './registry';
import { withinActiveWindow } from './active-window';
import { computeNextCronRunMs } from './cron-expr';

type NowFn = () => Date;
type SetIntervalFn = typeof setInterval;
type ClearIntervalFn = typeof clearInterval;

/**
 * 默认 tick 间隔：30s（可通过 SCHEDULER_TICK_MS 环境变量覆盖）。
 * 测试环境在 tests/test.env 设 SCHEDULER_TICK_MS=1000，避免 AT 心跳 case 干等超时。
 */
const DEFAULT_TICK_MS = (() => {
  const envVal = typeof process !== 'undefined' && process.env['SCHEDULER_TICK_MS'];
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 30_000;
})();

export interface SchedulerEngineDeps {
  registry: JobHandlerRegistry;
  /** 单一时间源（UT seam；缺省 () => new Date()） */
  now?: NowFn;
  /**
   * tick 间隔毫秒（default = SCHEDULER_TICK_MS env var ?? 30_000）。
   * UT 注入 intervalMs=1000 可跳过环境变量（显式优先）。
   */
  intervalMs?: number;
  /** 注入 setInterval（UT seam；防真实 timer） */
  setInterval?: SetIntervalFn;
  /** 注入 clearInterval（UT seam） */
  clearInterval?: ClearIntervalFn;
}

type RunState = 'running' | 'stopped';

/**
 * isDue 判定纯函数（双 schedule kind）。
 * 参考: [P0]engine.md §4（权威伪码 + 双分支语义）
 *
 * interval 分支（heartbeat 模式）：
 *   - lastFiredAt=null：首次排法——activeWindow 内则首 tick 即触发（TBD8）；无 activeWindow 恒真
 *   - lastFiredAt!=null：now >= lastFiredAt + schedule.ms
 *
 * cron 分支（cron 模式）：
 *   - anchor = lastFiredAt ?? createdAt（at-most-once 不追溯）
 *   - next = computeNextCronRunMs(expr, anchor, tz)；next <= now 则 due
 *
 * @param job  待判定 job（caller 保证 schedule 已对齐 kind）
 * @param now  单一时间源
 */
export function isDue(job: Job, now: Date): boolean {
  switch (job.schedule.kind) {
    case 'interval': {
      if (job.lastFiredAt === null) {
        if (job.schedule.activeWindow) {
          return withinActiveWindow(
            job.schedule.activeWindow,
            now,
            job.schedule.tz ?? 'UTC',
          );
        }
        return true; // 无 activeWindow 的 interval（预留场景）
      }
      const lastMs = Date.parse(job.lastFiredAt);
      if (Number.isNaN(lastMs)) return false;
      return now.getTime() >= lastMs + job.schedule.ms;
    }
    case 'cron': {
      // 锚 lastFiredAt ?? createdAt；computeNext 严格大于 anchor 的下一次到点
      const anchorIso = job.lastFiredAt ?? job.createdAt;
      const anchorMs = Date.parse(anchorIso);
      if (Number.isNaN(anchorMs)) return false;
      const next = computeNextCronRunMs(
        job.schedule.expr,
        new Date(anchorMs),
        job.schedule.tz,
      );
      if (next === null) return false;
      return next <= now.getTime();
    }
  }
}

/**
 * SchedulerEngine — 进程级单例调度引擎。
 * 默认 30s 轮询 Map<jobId, Job>（可配 SCHEDULER_TICK_MS），到点 fire-and-forget 调对应 handler。
 * [v0.0.116] per-job inFlight 不可重入守卫：同一 job 上一次 fire 未结束绝不二次 fire。
 */
export class SchedulerEngine {
  private readonly jobs = new Map<string, Job>();
  /** per-job inFlight 守卫集合（job 级不可重入：fire 期间再次到点跳过本 tick） */
  private readonly inFlight = new Set<string>();
  private intervalHandle: ReturnType<SetIntervalFn> | null = null;
  private runState: RunState = 'stopped';
  private readonly deps: Required<SchedulerEngineDeps>;

  constructor(deps: SchedulerEngineDeps) {
    this.deps = {
      registry: deps.registry,
      now: deps.now ?? (() => new Date()),
      // 优先使用 deps 显式注入（UT/createEngine 可覆盖），否则读环境变量（默认 30s）
      intervalMs: deps.intervalMs ?? DEFAULT_TICK_MS,
      setInterval: deps.setInterval ?? setInterval,
      clearInterval: deps.clearInterval ?? clearInterval,
    };
  }

  /** 启动 tick 循环（建 interval.unref()）；幂等（已 running 时 no-op）。 */
  start(): void {
    if (this.runState === 'running') return;
    this.intervalHandle = this.deps.setInterval(() => this.tick(), this.deps.intervalMs);
    // .unref() 防孤立进程（test-process-cleanup 教训；Bun/Node 都支持）
    const handle = this.intervalHandle as unknown as { unref?: () => void };
    if (typeof handle.unref === 'function') handle.unref();
    this.runState = 'running';
  }

  /** 停止 tick；幂等（已 stopped 时 no-op）。 */
  stop(): void {
    if (this.runState === 'stopped') return;
    if (this.intervalHandle !== null) {
      this.deps.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.runState = 'stopped';
  }

  /** 当前运行状态（UT introspect）。 */
  getRunState(): RunState {
    return this.runState;
  }

  /** 注册/替换 job（reload / cron action=create / action=update 调）。 */
  register(job: Job): void {
    this.jobs.set(job.id, job);
  }

  /** 注销 job（cron action=delete / owner 销毁 调）；不存在静默 no-op。 */
  unregister(jobId: string): void {
    this.jobs.delete(jobId);
  }

  /** 是否注册（UT introspect）。 */
  has(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  /** 取单 job（UT introspect + handler reload 用）。 */
  getJob(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /** 全量快照（UT introspect + owner 销毁扫 owned job 用）。 */
  snapshot(): ReadonlyMap<string, Job> {
    return this.jobs;
  }

  /**
   * handler fire 成功后调，更新内存 lastFiredAt（reschedule from now）。
   * 落盘由 handler 内部 PersistenceAdapter 自处（engine 不感知 PersistenceAdapter）。
   */
  updateJobLastFiredAt(jobId: string, iso: string): void {
    const existing = this.jobs.get(jobId);
    if (!existing) return;
    this.jobs.set(jobId, { ...existing, lastFiredAt: iso });
  }

  /**
   * 主循环（fire-and-forget，不 await）。
   * 间隔由 SCHEDULER_TICK_MS 环境变量决定（默认 30s，测试环境 1s）。
   * 快照防 register/unregister 在 fire 期间并发改 Map（spec §3 关键点 1）。
   *
   * [v0.0.116] per-job inFlight 守卫：
   *   同一 job 上一次 fire 未结束（promise 未 settle）→ 本 tick 跳过（不堆 fire）。
   *   fire promise finally → inFlight.delete（无论 resolve/reject）。
   *   这是分发去重，不是业务 gate（engine 仍不感知业务语义）。
   */
  private tick(): void {
    if (this.runState !== 'running') return;
    const now = this.deps.now();
    const snapshot = Array.from(this.jobs.values());
    for (const job of snapshot) {
      if (!job.enabled) continue;
      if (!isDue(job, now)) continue;
      // per-job inFlight 守卫：上次 fire 未完成 → 跳过本 tick（job 级不可重入）
      if (this.inFlight.has(job.id)) continue;
      const handler = this.deps.registry.get(job.type);
      if (!handler) continue; // 未注册 type handler 跳过（best-effort）
      // fire-and-forget：不 await；finally 无论 resolve/reject 都清 inFlight
      this.inFlight.add(job.id);
      void handler.fire(job, now)
        .catch(() => {
          // best-effort：handler 异常已被其内部 try/catch 兜底；此处兜 rejected promise
        })
        .finally(() => {
          this.inFlight.delete(job.id);
        });
    }
  }

  /** inFlight 集合大小（UT introspect 用） */
  getInFlightCount(): number {
    return this.inFlight.size;
  }
}
