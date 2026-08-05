/**
 * panorama HTTP 路由分发（panorama_http.md §1 / 14-panorama-endpoints.md）.
 *
 * 9 端点挂在 /squad/:squadId/panorama/* 下。dispatch 按 method+path 正则分流到 routes-impl.
 * squad 存在性校验在此层（404）；端点级 payload/响应/错误码权威 = 14-panorama-endpoints.md.
 *
 * 端点实现（schema/entity CRUD/transition/events）在 panorama-routes-impl.ts（单文件 ≤300 行）.
 *
 * @param req     入站 Request
 * @param method  HTTP 方法（大写）
 * @param path    URL pathname（/squad/:id/panorama/...）
 * @param deps    panorama handler 依赖（dataDir + panoramaBus）
 */
import type { ReplayableEventBus } from '../../../agent/event-hub';
import { SquadStore } from '../../../stores/squad-store';
import { json } from './http-helpers';
import {
  handleGetSchema, handlePutSchema, handleValidateSchema,
  handleListEntities, handleCreateEntity, handleGetEntity, handlePatchEntity,
  handleTransition, handleEvents,
} from './panorama-routes-impl';

/** panorama handler 依赖（dispatchSquadRoutes 注入） */
export interface PanoramaHandlerDeps {
  dataDir: string;
  panoramaBus?: ReplayableEventBus;
}

/** URL path 段容错 decode。router.ts 不解 url.pathname → 正则捕获的 entity/id 仍 encoded，
 *  非 ASCII id（如中文）须在此 decode 才匹配 store；非法 % 序列返回原值不抛。 */
function decodeSeg(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** /squad/:id/panorama/* 路由分发。命中返 Response；未命中返 null（主分发继续） */
export async function handlePanoramaRoute(
  req: Request,
  method: string,
  path: string,
  deps: PanoramaHandlerDeps,
): Promise<Response | null> {
  const m = path.match(/^\/squad\/([^/]+)\/panorama\/(.*)$/);
  if (!m) return null;
  const squadId = m[1]!;
  const sub = m[2]!;

  // 校验 squad 存在（panorama_http.md §5 squad_not_found 404）
  const squad = await new SquadStore({ root: deps.dataDir }).getSquad(squadId);
  if (!squad) return json(404, { error: 'squad_not_found' });

  const ctx = { dataDir: deps.dataDir, squadId, bus: deps.panoramaBus };

  // ── schema 面 ─────────────────────────────────────────
  if (sub === 'schema' && method === 'GET') return handleGetSchema(ctx);
  if (sub === 'schema' && method === 'PUT') return handlePutSchema(req, ctx);
  if (sub === 'schema/validate' && method === 'POST') return handleValidateSchema(req, ctx);

  // ── 事件流 ─────────────────────────────────────────────
  if (sub === 'events' && method === 'GET') return handleEvents(req, ctx);

  // ── 实体 CRUD ──────────────────────────────────────────
  // POST /entities/:entity
  const createMatch = sub.match(/^entities\/([^/]+)$/);
  if (createMatch && method === 'GET') return handleListEntities(req, ctx, decodeSeg(createMatch[1]!));
  if (createMatch && method === 'POST') return handleCreateEntity(req, ctx, decodeSeg(createMatch[1]!));

  // POST /entities/:entity/:id/transition
  const transMatch = sub.match(/^entities\/([^/]+)\/([^/]+)\/transition$/);
  if (transMatch && method === 'POST') return handleTransition(req, ctx, decodeSeg(transMatch[1]!), decodeSeg(transMatch[2]!));

  // GET/PATCH /entities/:entity/:id
  const oneMatch = sub.match(/^entities\/([^/]+)\/([^/]+)$/);
  if (oneMatch && method === 'GET') return handleGetEntity(ctx, decodeSeg(oneMatch[1]!), decodeSeg(oneMatch[2]!));
  if (oneMatch && method === 'PATCH') return handlePatchEntity(req, ctx, decodeSeg(oneMatch[1]!), decodeSeg(oneMatch[2]!));

  return json(404, { error: 'Not Found' });
}
