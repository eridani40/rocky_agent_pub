/**
 * squad-routes — /squad* 路由组（含 member / budget / scheduler 子路径）
 *
 * 纯 move 自 router.ts（v0.0.156 结构性拆分）。路由顺序 + 前缀匹配逻辑 100% copy-paste。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.8 + INV-R-1
 *
 * 子路径分发顺序：
 *   1. /squad/:id/member[/:mid[/{deploy,bench}]] → handleMemberRoute
 *   2. /squad/:id/budget/usage → handleBudgetUsageRoute
 *   3. /squad/:id/scheduler/history → handleSchedulerHistoryRoute
 *   4. /squad + /squad/:id → handleSquadRoute（CRUD）
 *
 * 未命中返 null，主分发继续尝试下一个路由组。
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径。
 */
import type { BootstrapResult } from '../bootstrap';
import { handleSquadRoute, type SquadHandlerDeps } from '../handlers/squad';
import { handleSquadTemplateRoute } from '../handlers/squad-template-handler';
import { handleMemberRoute } from '../handlers/member';
import { handleBudgetUsageRoute } from '../handlers/squad-budget-handler';
// [v0.0.194] token-stats 子路径分发
import { handleTokenStatsRoute } from '../handlers/squad-token-stats-handler';
import { handleSchedulerHistoryRoute } from '../handlers/squad-scheduler-handler';
// [v0.0.189] panorama 子路由分发（/squad/:id/panorama/*）
import { handlePanoramaRoute } from '../squad/panorama/http/routes';

/**
 * /squad* 路由组分发。命中返 Response；未命中返 null（主分发继续下个 group）。
 *
 * @param req      原始 Request
 * @param method   HTTP method（大写）
 * @param path     pathname
 * @param bs       bootstrap 实例
 * @param dataDir  绝对路径
 */
export async function dispatchSquadRoutes(
  req: Request,
  method: string,
  path: string,
  bs: BootstrapResult,
  dataDir: string,
): Promise<Response | null> {
  // /squad-templates 前缀分发——MUST 在 /squad 匹配之前
  //（`/squad-templates` startsWith `/squad` 会被下方 /squad CRUD 吞掉返 404）
  if (path === '/squad-templates') {
    return handleSquadTemplateRoute(method, dataDir);
  }

  if (path !== '/squad' && !path.startsWith('/squad/')) {
    return null;
  }

  const sd: SquadHandlerDeps = {
    sessionStore: bs.store,
    dataDir,
    // [v0.0.33.4 T5] 注入 squadRuntime + budgetAggregator（PATCH reload + heartbeat/budget/scheduler handlers）
    squadRuntime: bs.squadRuntime,
    budgetAggregator: bs.budgetAggregator,
    // [v0.0.194] token 用量聚合（sqlite 装配失败时 undefined → handler 返 503）
    ...(bs.tokenUsageAggregator ? { tokenUsageAggregator: bs.tokenUsageAggregator } : {}),
    // [v0.0.36] 注入 appConfig（modelDefault/model 写入校验 fail-fast）
    appConfig: bs.appConfig,
  };

  // member 子路径：/squad/:id/member / :mid / :mid/{deploy,bench}（squadId 由 sub-handler 从 path 解析）
  // [v0.0.116] /squad/:id/member/:mid/heartbeat 端点已废弃删除，路径不再分发（返 404）
  if (path.startsWith('/squad/') && /\/member(\/|$)/.test(path)) {
    return handleMemberRoute(req, method, path, sd);
  }
  // [v0.0.33.4 T5] budget-usage 子路径：GET /squad/:id/budget/usage（api §4）
  if (path.startsWith('/squad/') && /\/budget\/usage$/.test(path)) {
    return handleBudgetUsageRoute(req, method, path, sd);
  }
  // [v0.0.194] token-stats 子路径：GET /squad/:id/token-stats（api 11c §1）
  if (path.startsWith('/squad/') && /\/token-stats$/.test(path)) {
    return handleTokenStatsRoute(req, method, path, sd);
  }
  // [v0.0.33.4 T5] scheduler-history 子路径：GET /squad/:id/scheduler/history（api §5）
  if (path.startsWith('/squad/') && /\/scheduler\/history$/.test(path)) {
    return handleSchedulerHistoryRoute(req, method, path, sd);
  }
  // [v0.0.189] panorama 子路径：/squad/:id/panorama/*（schema + 实体 CRUD + transition + events）
  if (path.startsWith('/squad/') && /\/panorama(\/|$)/.test(path)) {
    return handlePanoramaRoute(req, method, path, { dataDir, panoramaBus: bs.panoramaBus });
  }
  // /squad + /squad/:id 走 squad CRUD handler
  return handleSquadRoute(req, method, path, sd);
}
