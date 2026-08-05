/**
 * POST /test/consolidation/run —— test-only 同步触发端点（AT 可测性补充，v0.0.151.t2_consolidate）。
 * 参考: specs/tech/scheduling/[P1]consolidation_job.md §7（架构落点 + 设计理由）
 *       specs/api/version_logs/v0.0.151.t2_consolidate/change_log.md（完整请求/响应契约）
 *
 * 设计：
 *   - PRD 明确排除手动"立即整理"触发（生产 UI 无此入口）；AT（黑盒 HTTP，wait/poll 上限 60s）
 *     无法可靠等一个 HH:mm 粒度的到点，故新增本端点：直接调 runConsolidationTier2(deps) 并
 *     await 到完成，同步返回完整结果，不经调度器（SchedulerEngine/ConsolidationJobHandler.fire）
 *   - 双重 gate：router 层 + handler 层（对齐 session-run.ts 范式，防绕过路由层直接调）
 *   - 不动 Job.lastFiredAt（真实调度锚点，测试触发若推进会静默扰动同进程内真实 job 的下次到点计算）；
 *     会写 lastResult（AT 典型验证序列"seed → 触发 → 断言 status"需要能看到本次结果）
 *   - 不接受任何覆盖 app_config.consolidation 的请求参数（本端点只读现有 config，非隐藏配置入口）
 */
import { runConsolidationTier2, type ConsolidationTier2Deps } from '../agent/consolidation-tier2/runner';
import type { ConsolidationPersistenceAdapter } from '../scheduling/persistence/consolidation-adapter';

/** handleTestConsolidationRun 依赖（runner 依赖 + lastResult 落盘 adapter） */
export interface TestConsolidationRunDeps extends ConsolidationTier2Deps {
  adapter: ConsolidationPersistenceAdapter;
}

/** 标准 JSON 响应工具（各 test-only handler 文件各自持一份，同 stub-handler.ts 惯例） */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * POST /test/consolidation/run —— 同步跑一次 runConsolidationTier2，await 到完成后返回完整结果。
 * 双重 gate（router 层已 gate 一次，此处二次防绕过直调）；不解析请求体（不接受配置覆盖参数）。
 */
export async function handleTestConsolidationRun(
  _req: Request,
  method: string,
  deps: TestConsolidationRunDeps,
): Promise<Response> {
  if (process.env.NODE_ENV !== 'test') return json(404, { error: 'Not Found' });
  if (method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  try {
    const result = await runConsolidationTier2(deps);
    // 写 lastResult（供 GET /consolidation/status 可见）；不触碰 Job.lastFiredAt（本端点不经调度器）
    deps.adapter.writeLastResult({ lastRunAt: new Date().toISOString(), summary: result.summary });
    return json(200, result);
  } catch (err) {
    // runner 内部已 best-effort 吞异常，理论不应到达此处；兜底 500（api change_log 契约）
    const msg = err instanceof Error ? err.message : String(err);
    return json(500, { error: 'internal_error', message: msg });
  }
}
