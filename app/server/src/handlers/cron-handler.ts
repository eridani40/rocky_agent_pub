/**
 * cron UI HTTP handler — 6 端点（与 agent cron 工具正交，共享 cronStore + engine）。
 * 参考: specs/api/overall/16-cron.md §2（6 UI 端点契约 + status/body schema/错误码）
 *       specs/tech/scheduling/[P1]cron_subsystem.md §7（UI 端点 vs agent 工具正交）
 *
 * 设计：
 *   - 路由形态：/session/:sessionId/cron[/:jobId[/{disable,enable}]]
 *   - 与 agent 工具完全正交：共享 CronPersistenceAdapter + SchedulerEngine，互不感知（spec §3.3）
 *   - tz 来源：UI HTTP body.timezone（client local Intl）优先 → resolveTz fallback（cron_subsystem §5）
 *   - nextFireAt 现算（computeNextCronRunMs；enabled=false → null，spec §4）
 *   - 鉴权与 /session/:id/memory 同模式：session 存在校验；不含 user 权限（同 memory）
 *
 * 与 agent 工具共享 helper（spec §3.3 两路径同底层 schema，避免重复实现）：
 *   toSummary / resolveTz / buildCronJob / isValidCronExpr — 见 tools/cron/cron-tool-shared.ts
 */
import type { SchedulerEngine } from '../scheduling/engine';
import type { CronPersistenceAdapter } from '../scheduling/persistence/cron-adapter';
import type { SessionStore } from '../agent/session-store';
import type { SquadStore } from '../stores/squad-store';
import type { Job } from '../scheduling/types';
import type { CronPayload } from '../scheduling/payloads';
import { parseCronExpression } from '../scheduling/cron-expr';
import {
  toSummary,
  resolveTz,
  buildCronJob,
  isValidCronExpr,
  findJobById,
} from '../tools/cron/cron-tool-shared';
import type { CronJobSummary, CreateCronBody, UpdateCronBody } from '../tools/cron/types';

/** CronRouteDeps（router 注入；bootstrap 装配后透传） */
export interface CronRouteDeps {
  cronStore: CronPersistenceAdapter;
  engine: SchedulerEngine;
  sessionStore: SessionStore;
  squadStore: SquadStore;
}

/** JSON Response 构造（与现有 handler 一致） */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * 取 cron job（loadJobs 内含 sessionId 过滤）；不在 → null。
 *
 * 健壮化匹配：UI 端 `disableCronJob(sessionId, job.id)` 把 `cron:sid:eid`
 * 整体当 URL path segment，`encodeURIComponent` 把 `:` 编码成 `%3A`，但 router 用
 * `new URL(req.url).pathname` 不解码 → 这里收到 `cron%3Asid%3Aeid`。直接 `j.id === jobId`
 * 与 decoded j.id 不等 → "job not found"。用 findJobById helper（兼容 encoded / suffix）。
 */
async function findJob(
  deps: CronRouteDeps,
  sessionId: string,
  jobId: string,
): Promise<Job | null> {
  const jobs = await deps.cronStore.loadJobs(sessionId);
  return findJobById(jobs, jobId);
}

// ============================================================
// 6 端点实现
// ============================================================

/**
 * GET /session/:sessionId/cron — 列 cron jobs（spec §2.1）。
 * 响应 200 + { items: CronJobSummary[] }（含 nextFireAt 现算）。
 * 错误 404 session 不存在。
 */
async function handleList(deps: CronRouteDeps, sessionId: string): Promise<Response> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) return json(404, { error: `session not found: ${sessionId}` });
  const jobs = await deps.cronStore.loadJobs(sessionId);
  const items: CronJobSummary[] = jobs.map(toSummary);
  return json(200, { items });
}

/**
 * POST /session/:sessionId/cron — 新建 cron job（spec §2.2）。
 * 行为：校验 cron expr + prompt 非空 → 取 tz → 生成 jobId → engine.register + cronStore.upsertJob。
 * tz 来源：body.timezone（UI HTTP 传 client local，Intl IANA）优先；
 *   否则 resolveTz fallback（session.timezone → squad.timezone → server 进程本地）。
 * squadId 始终派生自 session（payload.squadId 用于 budget gate），与 tz 来源独立。
 * 响应 201 + CronJobSummary；错误 400（cron 非法 / prompt 空 / body 非法）/ 404 session。
 */
async function handleCreate(
  deps: CronRouteDeps,
  req: Request,
  sessionId: string,
): Promise<Response> {
  let body: Partial<CreateCronBody>;
  try {
    body = (await req.json()) as Partial<CreateCronBody>;
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }
  const cron = typeof body.cron === 'string' ? body.cron.trim() : '';
  if (!cron) return json(400, { error: 'cron required' });
  if (!isValidCronExpr(cron)) {
    return json(400, { error: `cron expr invalid: ${cron}` });
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json(400, { error: 'prompt required' });
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : prompt.slice(0, 30);
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : true;
  // UI 建 cron 时显式传 client local tz；trim 后空串视为缺省
  const bodyTz =
    typeof body.timezone === 'string' && body.timezone.trim() ? body.timezone.trim() : undefined;

  // resolveTz 始终调：①验 session 存在 ②取 squadId 派生（payload.squadId 用于 budget gate）
  const tzInfo = await resolveTz(deps, sessionId);
  if (!tzInfo) return json(404, { error: `session not found: ${sessionId}` });
  // tz 优先级：body.timezone（UI HTTP client local）> resolveTz fallback（session→squad→server）
  const tz = bodyTz ?? tzInfo.tz;
  const { squadId } = tzInfo;

  const job = buildCronJob({ sessionId, cron, prompt, name, enabled, tz, squadId });
  try {
    deps.engine.register(job);
    await deps.cronStore.upsertJob(sessionId, job);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return json(500, { error: `cron create failed: ${reason}` });
  }
  return json(201, toSummary(job));
}

/**
 * PATCH /session/:sessionId/cron/:jobId — 更新（spec §2.3）。
 * 行为：read-modify-write；enabled 不在 PATCH；tz 不可改（绑 session）。
 * 响应 200 + CronJobSummary；错误 400（cron 非法）/ 404（session/job 不存在）。
 */
async function handleUpdate(
  deps: CronRouteDeps,
  req: Request,
  sessionId: string,
  jobId: string,
): Promise<Response> {
  let body: Partial<UpdateCronBody>;
  try {
    body = (await req.json()) as Partial<UpdateCronBody>;
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) return json(404, { error: `session not found: ${sessionId}` });
  const job = await findJob(deps, sessionId, jobId);
  if (!job) return json(404, { error: `job not found: ${jobId}` });

  const schedule = job.schedule as { kind: 'cron'; expr: string; tz: string };
  if (typeof body.cron === 'string' && body.cron.trim()) {
    const newCron = body.cron.trim();
    if (!isValidCronExpr(newCron)) {
      return json(400, { error: `cron expr invalid: ${newCron}` });
    }
    schedule.expr = newCron;
  }
  const p = job.payload as CronPayload;
  if (typeof body.prompt === 'string' && body.prompt.trim()) p.prompt = body.prompt.trim();
  if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim();

  const updated: Job = { ...job, schedule: { ...schedule }, payload: { ...p } };
  try {
    deps.engine.register(updated);
    await deps.cronStore.upsertJob(sessionId, updated);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return json(500, { error: `cron update failed: ${reason}` });
  }
  return json(200, toSummary(updated));
}

/**
 * POST /session/:sessionId/cron/:jobId/disable 或 /enable — toggle（spec §2.4/§2.5）。
 * 行为：engine.register({...job, enabled}) + cronStore.upsertJob；不重置 lastFiredAt（保续接）。
 * 响应 200 + { id, enabled }；错误 404（session/job 不存在）。
 */
async function handleToggle(
  deps: CronRouteDeps,
  sessionId: string,
  jobId: string,
  enabled: boolean,
): Promise<Response> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) return json(404, { error: `session not found: ${sessionId}` });
  const job = await findJob(deps, sessionId, jobId);
  if (!job) return json(404, { error: `job not found: ${jobId}` });
  const updated: Job = { ...job, enabled };
  try {
    deps.engine.register(updated);
    await deps.cronStore.upsertJob(sessionId, updated);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return json(500, { error: `cron toggle failed: ${reason}` });
  }
  // id 用 job.id（canonical decoded），与 GET list summary.id 一致；不回传入参（可能 encoded）
  return json(200, { id: job.id, enabled });
}

/**
 * DELETE /session/:sessionId/cron/:jobId — 永久删（spec §2.6）。
 * 行为：engine.unregister + cronStore.removeJob；永久删除（非归档）。
 * 响应 200 + { id, deleted:true }；错误 404（session/job 不存在）。
 */
async function handleDelete(
  deps: CronRouteDeps,
  sessionId: string,
  jobId: string,
): Promise<Response> {
  const session = await deps.sessionStore.getSession(sessionId);
  if (!session) return json(404, { error: `session not found: ${sessionId}` });
  const job = await findJob(deps, sessionId, jobId);
  if (!job) return json(404, { error: `job not found: ${jobId}` });
  try {
    // engine/cronStore 用 job.id（canonical decoded）；入参 jobId 可能 encoded/suffix
    deps.engine.unregister(job.id);
    await deps.cronStore.removeJob(sessionId, job.id);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return json(500, { error: `cron delete failed: ${reason}` });
  }
  // id 用 job.id（canonical decoded），与 GET list summary.id 一致
  return json(200, { id: job.id, deleted: true });
}

// ============================================================
// 路由分发入口（router 调）
// ============================================================

/**
 * /session/:sessionId/cron* 路由分发入口。
 * 路由形态：
 *   /session/:sid/cron                    → GET（列表）/ POST（新建）
 *   /session/:sid/cron/:jobId             → PATCH（更新）/ DELETE（删除）
 *   /session/:sid/cron/:jobId/disable     → POST（禁用）
 *   /session/:sid/cron/:jobId/enable      → POST（启用）
 *
 * @returns 503 当 cronStore/engine 未注入（bootstrap 未装配时；正常生产路径不应到达）
 */
export async function handleCronRoute(
  req: Request,
  method: string,
  path: string,
  deps: CronRouteDeps | null,
): Promise<Response> {
  if (!deps) {
    return json(503, { error: 'cron subsystem not bootstrapped (cronStore/engine missing)' });
  }
  // /session/:sid/cron
  const rootMatch = path.match(/^\/session\/([^/]+)\/cron$/);
  if (rootMatch) {
    const sid = rootMatch[1]!;
    if (method === 'GET') return handleList(deps, sid);
    if (method === 'POST') return handleCreate(deps, req, sid);
    return json(405, { error: 'Method Not Allowed' }, { allow: 'GET,POST' });
  }
  // /session/:sid/cron/:jobId/disable | /enable
  const toggleMatch = path.match(/^\/session\/([^/]+)\/cron\/([^/]+)\/(disable|enable)$/);
  if (toggleMatch) {
    const [, sid, jobId, action] = toggleMatch;
    if (method !== 'POST') {
      return json(405, { error: 'Method Not Allowed' }, { allow: 'POST' });
    }
    return handleToggle(deps, sid!, jobId!, action === 'enable');
  }
  // /session/:sid/cron/:jobId
  const jobMatch = path.match(/^\/session\/([^/]+)\/cron\/([^/]+)$/);
  if (jobMatch) {
    const sid = jobMatch[1]!;
    const jobId = jobMatch[2]!;
    if (method === 'PATCH') return handleUpdate(deps, req, sid, jobId);
    if (method === 'DELETE') return handleDelete(deps, sid, jobId);
    return json(405, { error: 'Method Not Allowed' }, { allow: 'PATCH,DELETE' });
  }
  return json(404, { error: 'Not Found' });
}
