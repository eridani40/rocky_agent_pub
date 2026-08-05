/**
 * POST /consolidation/run —— 手动触发一次二级整理（生产端点，v0.0.164.memory_opt 新建）。
 * 参考: specs/tech/version_logs/v0.0.164.memory_opt/change_plan.md 模块 G
 *       specs/tech/agent/session/[P0]app_task_lock.md §4（HTTP 端点契约）
 *       specs/tech/agent/memory/[P0]consolidation_tier2.md §7（撞车语义）
 *
 * 设计（与 test-only /test/consolidation/run 分离）：
 *   - fire-and-forget UX：acquire 成功立即 202 + runId，不 await runner（用户不等）
 *   - AppTaskLock 撞车保护：与 cron ConsolidationJobHandler 共享同 taskType='tier2_consolidation'
 *     * acquire 成功 → 202 {ok:true, runId}；spawn 后台 runConsolidationTier2
 *     * acquire 失败 → 409 {error:'consolidation_in_progress'}（前端按钮 disabled 提示）
 *   - runId 固定形如 'manual:<ulid>'（观测/lock state 用；与 cron 'cron:<iso>' 区分）
 *   - 后台 promise 结果处理：成功 markDone + 写 lastResult；失败 markFailed（否则锁永不释放）
 *   - **不触碰 Job.lastFiredAt**：本端点不经调度器（Job.lastFiredAt 只由 cron 推进）
 */
import { runConsolidationTier2, type ConsolidationTier2Deps } from '../agent/consolidation-tier2/runner';
import type { ConsolidationPersistenceAdapter } from '../scheduling/persistence/consolidation-adapter';
import type { AppTaskLock } from '../agent/app-task-lock';
import { ulid } from '../config/ulid';

/** [v0.0.164] app 级任务类型固定值（与 ConsolidationJobHandler 同源，撞车保护同一 taskType） */
const CONSOLIDATION_TASK_TYPE = 'tier2_consolidation';

/** handleConsolidationRun 依赖（runner 依赖 + lastResult 落盘 adapter + AppTaskLock） */
export interface ConsolidationRunDeps extends ConsolidationTier2Deps {
  adapter: ConsolidationPersistenceAdapter;
  appTaskLock: AppTaskLock;
}

/** 标准 JSON 响应工具（各 handler 各自持一份，同 handlers/ 惯例） */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * POST /consolidation/run 主 handler。
 *
 * 语义：
 *   - method !== 'POST' → 405
 *   - acquire('tier2_consolidation', 'manual:'+ulid) 成功 → 202 {ok, runId}
 *     并 fire-and-forget spawn runConsolidationTier2；then markDone + writeLastResult；catch markFailed
 *   - acquire 失败（已 running）→ 409 {error:'consolidation_in_progress'}
 */
export function handleConsolidationRun(
  _req: Request,
  method: string,
  deps: ConsolidationRunDeps,
): Response {
  if (method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const runId = 'manual:' + ulid();
  const acquired = deps.appTaskLock.acquire(CONSOLIDATION_TASK_TYPE, runId);
  if (!acquired) {
    // 已有 tier2 在跑（cron 或另一手动触发）→ 409（前端 UI 展示"正在整理"）
    return json(409, { error: 'consolidation_in_progress' });
  }

  // fire-and-forget：立即返 202，spawn 后台 runner；结果通过 SSE consolidation_task_update 通知前端
  void runConsolidationTier2(deps)
    .then((result) => {
      try {
        deps.adapter.writeLastResult({
          lastRunAt: new Date().toISOString(),
          summary: result.summary,
        });
      } catch (writeErr) {
        // best-effort：写 lastResult 失败不阻塞 markDone（锁必须释放）
        const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
        console.warn(`[consolidation-run] writeLastResult failed (suppressed): ${msg}`);
      }
      deps.appTaskLock.markDone(CONSOLIDATION_TASK_TYPE);
    })
    .catch((err) => {
      // runner 内部已 best-effort 吞异常；catch 分支必须 markFailed 否则锁永不释放
      const msg = err instanceof Error ? err.message : String(err);
      deps.appTaskLock.markFailed(CONSOLIDATION_TASK_TYPE, msg);
    });

  return json(202, { ok: true, runId });
}
