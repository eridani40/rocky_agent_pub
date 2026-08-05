/**
 * squad-budget-handler — GET /squad/:id/budget/usage
 * 参考: specs/api/version_logs/v0.0.33.4/change_log.md §4（BudgetUsage schema + budget=null→-1 仅 Display）
 *       specs/tech/squad/[P1]scheduler.md §5（budget helper + Display/Gate 分离）
 *
 * 职责（1 端点，纯只读）：
 *   - GET /squad/:id/budget/usage → budgetAggregator.displayUsage(squadId, now) → 200 + BudgetUsage
 *     全字段（squadId/limit/window/consumed/remaining/windowStart/windowEnd/perSession/timezone）。
 *
 * 语义：budget=null（未配）→ limit=-1/remaining=-1 consumed 照算（仅 Display，不进 scheduler gate）。
 *   详见 budget-aggregator.ts（displayUsage）。
 *
 * 依赖：SquadHandlerDeps.budgetAggregator（router 从 bootstrap 注入）；squad 存在性 handler 自查。
 */
import { SquadStore } from '../stores/squad-store';
import type { BudgetUsage } from '../squad/budget/budget-aggregator';
import type { SquadHandlerDeps } from './squad';

/** JSON Response 构造（与现有 handler 一致） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * GET /squad/:id/budget/usage 路由分发（仅 GET；其他方法 405）。
 *
 * @param req     入站 Request（保留兼容签名，本端点不读 body/query）
 * @param method  HTTP 方法（大写）
 * @param path    URL pathname（/squad/:id/budget/usage，squadId 由本函数解析）
 * @param deps    handler 依赖（dataDir + budgetAggregator）
 */
export async function handleBudgetUsageRoute(
  _req: Request,
  method: string,
  path: string,
  deps: SquadHandlerDeps,
): Promise<Response> {
  const m = path.match(/^\/squad\/([^/]+)\/budget\/usage$/);
  if (!m) return json(404, { error: 'Not Found' });
  if (method !== 'GET') return json(405, { error: 'Method Not Allowed' }, 'GET');
  return handleGetBudgetUsage(m[1]!, deps);
}

/** GET /squad/:id/budget/usage — 调 budgetAggregator.displayUsage（api change_log §4） */
async function handleGetBudgetUsage(squadId: string, deps: SquadHandlerDeps): Promise<Response> {
  // squad 存在性（404 优先；budget-aggregator.compute 内 getSquad 抛错会被吞为 500，故前置查）
  const squadStore = new SquadStore({ root: deps.dataDir });
  const squad = await squadStore.getSquad(squadId);
  if (!squad) return json(404, { error: 'squad not found' });

  if (!deps.budgetAggregator) return json(500, { error: 'budget aggregator not wired' });

  let usage: BudgetUsage;
  try {
    // now = 进程 UTC 瞬时单一时间源（与 scheduler.md §3 一致；daily 窗口按 squad.timezone 切分）
    usage = await deps.budgetAggregator.displayUsage(squadId, new Date());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: 'compute budget usage failed', detail: msg });
  }
  return json(200, usage);
}
