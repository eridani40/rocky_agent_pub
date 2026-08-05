/**
 * JobHandlerRegistry 实现 — Map<type, JobHandler> 注册表。
 * 参考: specs/tech/scheduling/[P0]job_registry.md §3
 *       specs/tech/scheduling/index.md §④ 原则 3（type 决定 handler）
 *
 * 设计：
 *   - boot 时按 type 注册 handler（'heartbeat' / 'cron' / 后续可扩）
 *   - engine.tick 按 job.type 路由 handler；未注册 type → engine 跳过（best-effort）
 *   - 同 type 覆盖（reload 用）
 */
import type { JobHandler, JobType } from './types';

export class JobHandlerRegistry {
  private readonly handlers = new Map<JobType, JobHandler>();

  /** 注册 handler；同 type 覆盖（reload 场景）。 */
  register(type: JobType, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /** 取 type 对应 handler；未注册返 undefined（engine tick 跳过）。 */
  get(type: JobType): JobHandler | undefined {
    return this.handlers.get(type);
  }

  /** 判定 type 是否已注册（boot 自检用）。 */
  has(type: JobType): boolean {
    return this.handlers.has(type);
  }
}
