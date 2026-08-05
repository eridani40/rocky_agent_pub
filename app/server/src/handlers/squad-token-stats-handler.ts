/**
 * squad-token-stats-handler — GET /squad/:id/token-stats
 * 参考: specs/api/overall/11c-token-stats.md §1-§6（端点完整契约）
 *       specs/tech/version_logs/v0.0.194/change_plan.md 模块 D
 *
 * 职责（1 端点，纯只读）：
 *   - GET /squad/:id/token-stats → tokenUsageAggregator.query(squadId, opts) → 200 + TokenUsageQueryResult
 *   - query 参数：from/to (YYYY-MM-DD) / scope (team|memberId) / granularity (day|hour) /
 *     providerId + modelId（可选 model 筛选，必须同时提供）
 *   - squad 不存在 → 404；sqlite 未就绪 → 503（不 500）；query 参数非法 → 400
 *
 * 依赖：SquadHandlerDeps.tokenUsageAggregator（router 从 bootstrap 注入；sqlite 装配失败时 undefined）。
 */
import { SquadStore } from '../stores/squad-store';
import { squadTimezone } from '../squad/budget/budget-aggregator';
import type { SquadHandlerDeps } from './squad';
import type { AppConfigService } from '../config/app-config-service';
import type { AvailableModel } from '../squad/token-usage/token-usage-aggregator';

/** providers 组名（app_config KV 组；与 session-deps.ts PROVIDERS_GROUP 同值） */
const PROVIDERS_GROUP = 'providers';

/**
 * 用 app_config providers 组把 availableModels 的 label 从 `${providerId}/${modelId}`
 * 改写为 `${providerLabel} / ${modelId}`（providerId 是 ULID 不可读，用户要看 provider 名字）。
 * 映射口径：listGroup 全量（含 disabled——历史统计可能引用已停用 provider），
 * 跳过 _deleted 墓碑与无 label 的 record；未命中 / '__unknown__' 保持原 label。
 * appConfig 未注入（旧测试/装配缺失）→ 原样返回。
 */
function enrichModelLabels(
  models: AvailableModel[],
  appConfig: AppConfigService | undefined,
): AvailableModel[] {
  if (!appConfig || models.length === 0) return models;
  const labelByProviderId = new Map<string, string>();
  for (const r of appConfig.listGroup(PROVIDERS_GROUP)) {
    const p = r.data as { id?: string; label?: string; _deleted?: boolean } | undefined;
    if (!p || p._deleted || !p.id || !p.label) continue;
    labelByProviderId.set(p.id, p.label);
  }
  return models.map((m) => {
    const providerLabel = m.providerId !== '__unknown__' ? labelByProviderId.get(m.providerId) : undefined;
    return providerLabel ? { ...m, label: `${providerLabel} / ${m.modelId}` } : m;
  });
}

/** JSON Response 构造（与现有 handler 一致） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/** YYYY-MM-DD 日期格式校验 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /squad/:id/token-stats 路由分发（仅 GET；其他方法 405）。
 */
export async function handleTokenStatsRoute(
  req: Request,
  method: string,
  path: string,
  deps: SquadHandlerDeps,
): Promise<Response> {
  const m = path.match(/^\/squad\/([^/]+)\/token-stats$/);
  if (!m) return json(404, { error: 'Not Found' });
  if (method !== 'GET') return json(405, { error: 'Method Not Allowed' }, 'GET');
  return handleGetTokenStats(m[1]!, req, deps);
}

/**
 * GET /squad/:id/token-stats — 调 tokenUsageAggregator.query（API §5）。
 *
 * 错误码（API §6）：
 *   - 400：query 参数非法（from>to / 日期格式错 / providerId+modelId 未同时提供）
 *   - 404：squad 不存在
 *   - 503：sqlite 未就绪（tokenUsageAggregator undefined，装配失败容忍）
 *   - 200：成功 + TokenUsageQueryResult
 */
async function handleGetTokenStats(
  squadId: string,
  req: Request,
  deps: SquadHandlerDeps,
): Promise<Response> {
  // squad 存在性（404 优先）
  const squadStore = new SquadStore({ root: deps.dataDir });
  const squad = await squadStore.getSquad(squadId);
  if (!squad) return json(404, { error: 'squad not found' });

  // sqlite 未就绪（装配失败容忍 → 503，不 500）
  if (!deps.tokenUsageAggregator) return json(503, { error: 'token stats unavailable (sqlite not ready)' });

  // query 参数解析
  const url = new URL(req.url);
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const scope = url.searchParams.get('scope') ?? undefined;
  const granularity = (url.searchParams.get('granularity') as 'day' | 'hour' | null) ?? undefined;
  const providerId = url.searchParams.get('providerId') ?? undefined;
  const modelId = url.searchParams.get('modelId') ?? undefined;

  // 参数校验（API §2 约束）
  if (from && !DATE_RE.test(from)) return json(400, { error: 'from must be YYYY-MM-DD' });
  if (to && !DATE_RE.test(to)) return json(400, { error: 'to must be YYYY-MM-DD' });
  if (from && to && from > to) return json(400, { error: 'from must be <= to' });
  // providerId / modelId 必须同时提供或同时缺失
  if ((providerId && !modelId) || (!providerId && modelId)) {
    return json(400, { error: 'providerId and modelId must be both provided or both omitted' });
  }

  const timezone = squadTimezone(squad);
  try {
    const opts = {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(scope ? { scope } : {}),
      ...(granularity ? { granularity } : {}),
      ...(providerId && modelId ? { providerId, modelId } : {}),
    };
    const result = deps.tokenUsageAggregator.query(squadId, opts, timezone);
    // distinct model 列表（前端 model 筛选下拉数据源）
    // 一次请求拿数据 + model 列表（省独立端点）；range 与 query 同口径
    const rawModels = deps.tokenUsageAggregator.queryDistinctModels(squadId, {
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    });
    // label 里的 providerId（ULID 不可读）改写为 provider 名字（app_config providers.label）
    const availableModels = enrichModelLabels(rawModels, deps.appConfig);
    return json(200, { ...result, availableModels });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: 'token stats query failed', detail: msg });
  }
}
