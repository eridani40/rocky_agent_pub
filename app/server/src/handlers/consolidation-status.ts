/**
 * GET /consolidation/status —— 天级二级整理任务只读状态端点。
 * 参考: specs/api/overall/03-config-center.md §2.7（端点契约）
 *       specs/tech/scheduling/[P1]consolidation_job.md §2.1（ConsolidationPersistenceAdapter 设计）
 *       specs/tech/agent/session/[P0]app_task_lock.md §3.1（AppTaskLock 超时接管）
 *
 * 职责：只读 `adapter.readLastResult()` + AppTaskLock 内存态，无副作用；从未整理过
 * （job 未注册，或注册后从未到点触发过）返回 `{lastRunAt:null, summary:null, status:'idle', startedAt:null}`，
 * 不是 404——"没有历史"是合法状态。
 * 仅当读状态文件本身异常（如 state.json 损坏 / IO 错误）时才兜底 500（spec §2.7 错误响应）。
 *
 * [v0.0.205.t2_cons] 响应加 status/startedAt（源自 AppTaskLock 内存态）：
 *   status 三态 = lock running→'running' / failed→'failed' / 其余（idle/done）→'idle'
 *   （done 归 idle——完成态由 lastResult.lastRunAt 承载）；startedAt = lock state.startedAt ?? null。
 *   前端 onInit 据此初始化 running 态（修切走切回按钮可点 UX bug）。
 */
import type { ConsolidationPersistenceAdapter } from '../scheduling/persistence/consolidation-adapter';
import type { AppTaskLock } from '../agent/app-task-lock';

/** 与 consolidation-run.ts / scheduling/handlers/consolidation-handler.ts 同模式：本文件自持 taskType 常量 */
const CONSOLIDATION_TASK_TYPE = 'tier2_consolidation';

/** 标准 JSON 响应工具（各 handler 文件各自持一份，同 test-consolidation-run.ts / history-search.ts 惯例） */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * GET /consolidation/status handler（端点入口，spec §2.7 契约）。
 * 同步——`ConsolidationPersistenceAdapter.readLastResult()` 与 `AppTaskLock.getState()` 均是同步方法。
 *
 * @param adapter consolidation 状态持久化适配器（bootstrap 装配注入）
 * @param appTaskLock app 级任务内存锁（bootstrap 装配注入；提供当前 running/failed 实时态）
 * @returns JSON Response（200 含 lastRunAt+summary+status+startedAt / 500 读状态文件异常）
 */
export function handleConsolidationStatus(
  adapter: ConsolidationPersistenceAdapter,
  appTaskLock: AppTaskLock,
): Response {
  try {
    const result = adapter.readLastResult();
    const lockState = appTaskLock.getState(CONSOLIDATION_TASK_TYPE);
    // 三态映射（spec §2.7）：running→'running' / failed→'failed' / idle|done→'idle'（done 归 idle）
    const status: 'running' | 'idle' | 'failed' =
      lockState.status === 'running' ? 'running' : lockState.status === 'failed' ? 'failed' : 'idle';
    return json(200, { ...result, status, startedAt: lockState.startedAt ?? null });
  } catch (err) {
    // 理论上应极少发生：state.json 被外部损坏（非法 JSON）/ 文件系统 IO 异常
    const msg = err instanceof Error ? err.message : String(err);
    return json(500, { error: 'internal_error', message: msg });
  }
}
