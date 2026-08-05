/**
 * squad-scheduler-handler — GET /squad/:id/scheduler/history
 * 参考: specs/api/version_logs/v0.0.33.4/change_log.md §5（SchedulerHistoryEntry schema + ?limit/?roleId）
 *       specs/tech/squad/[P1]scheduler.md §8（history ring buffer + jsonl + getHistory 倒序）
 *
 * 职责（1 端点，纯只读）：
 *   - GET /squad/:id/scheduler/history?limit&roleId → 读 squadRuntime.getScheduler(squadId).getHistory
 *     → 200 { items: SchedulerHistoryEntry[] }（倒序最新在前）。
 *
 * schema 丰富（api §5 SchedulerHistoryEntry 要求 id/squadId/roleName，内部 HistoryEntry 仅
 *   roleId/at/reason/result/actionSummary?）：handler 层补 id（确定性合成）+ squadId（path）
 *   + roleName（memberStore 查名）。
 *
 * 依赖：SquadHandlerDeps.squadRuntime.getScheduler（不存在返空 items）+ memberStore（roleName 解析）。
 */
import { SquadStore, MemberStore } from '../stores/squad-store';
import type { MemberEntity } from '../stores/squad-store';
import type { HistoryEntry } from '../squad/scheduler/scheduler-history';
import type { SquadHandlerDeps } from './squad';

/** JSON Response 构造（与现有 handler 一致） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/** 缺省 limit（api change_log §5：缺省 50） */
const DEFAULT_LIMIT = 50;
/** 上限（api change_log §5：max 200，超 → 400） */
const MAX_LIMIT = 200;

/**
 * 合成确定性 history entry id（跨请求一致 + testid 安全）。
 * spec auto-work-history.md 期望 id=ulid；但 HistoryEntry 自身无 id 字段，handler 层合成。
 *   若用随机 ulid → 同一 entry 每次 GET 返不同 id，ET step3 GET 拿到的 id 与 step4 UI 渲染 id 错位 → `auto-work-item-{id}` 找不到。
 *   若用原始 `${at}_${roleId}_${idx}`（at 为 ISO 含 `:`/`-`/`.`）→ testid 含 CSS attribute selector 特殊字符，querySelector 易解析失败。
 *   若 id 含 idx（数组索引）→ history 增长（新 fire append）后同 entry 在倒序列表中 idx 偏移 → 跨 GET id 不稳定。
 * 故用 entry 自身稳定唯一键 `${at}_${roleId}`（scheduler 1s 轮询，同 role 不会同毫秒触发两次 → at+roleId 唯一）
 *   + sanitize 非 [A-Za-z0-9_] 为 `_`：保证跨请求 id 一致 + testid 仅含安全字符。
 *   backlog：让 HistoryEntry 自带 ulid（schema + jsonl 持久化改动，后续版本）。
 */
function makeHistoryEntryId(at: string, roleId: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_');
  return `${safe(at)}_${safe(roleId)}`;
}

/** api §5 SchedulerHistoryEntry（HTTP 出参；比核心 HistoryEntry 多 id/squadId/roleName） */
export interface SchedulerHistoryEntry {
  id: string;
  squadId: string;
  roleId: string;
  roleName: string;
  at: string;
  reason: 'heartbeat';
  result: string;
  actionSummary?: string;
}

/**
 * GET /squad/:id/scheduler/history 路由分发（仅 GET；其他方法 405）。
 *
 * @param req     入站 Request（读 ?limit / ?roleId query）
 * @param method  HTTP 方法（大写）
 * @param path    URL pathname（/squad/:id/scheduler/history，squadId 由本函数解析）
 * @param deps    handler 依赖（dataDir + squadRuntime）
 */
export async function handleSchedulerHistoryRoute(
  req: Request,
  method: string,
  path: string,
  deps: SquadHandlerDeps,
): Promise<Response> {
  const m = path.match(/^\/squad\/([^/]+)\/scheduler\/history$/);
  if (!m) return json(404, { error: 'Not Found' });
  if (method !== 'GET') return json(405, { error: 'Method Not Allowed' }, 'GET');
  return handleGetSchedulerHistory(req, m[1]!, deps);
}

/** GET /squad/:id/scheduler/history — 读 scheduler.getHistory + schema 丰富（api change_log §5） */
async function handleGetSchedulerHistory(
  req: Request,
  squadId: string,
  deps: SquadHandlerDeps,
): Promise<Response> {
  // 解析 ?limit（缺省 50）/ ?roleId（可选过滤）
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 0) return json(400, { error: 'limit must be a non-negative integer' });
    if (n > MAX_LIMIT) return json(400, { error: `limit must be <= ${MAX_LIMIT}` });
    limit = n;
  }
  const roleId = url.searchParams.get('roleId') ?? undefined;

  // squad 存在（404 优先）
  const squadStore = new SquadStore({ root: deps.dataDir });
  const squad = await squadStore.getSquad(squadId);
  if (!squad) return json(404, { error: 'squad not found' });

  // 读 history（scheduler 未启动 → 空；启动后 getHistory 读内存 ring 或 jsonl 兜底）
  const sched = deps.squadRuntime?.getScheduler(squadId);
  const raw: HistoryEntry[] = sched ? sched.getHistory(limit, roleId) as HistoryEntry[] : [];

  // roleName 解析（memberId → member.name）；不存在的 roleId 兜底用 roleId 本身
  const memberStore = new MemberStore({ root: deps.dataDir });
  const members = await memberStore.listMembers(squadId);
  const nameMap = new Map<string, string>();
  for (const mm of members as MemberEntity[]) nameMap.set(mm.id, mm.name);

  // schema 丰富：补 id（确定性 sanitize，at+roleId 稳定键）/ squadId / roleName
  const items: SchedulerHistoryEntry[] = raw.map((e) => ({
    id: makeHistoryEntryId(e.at, e.roleId),
    squadId,
    roleId: e.roleId,
    roleName: nameMap.get(e.roleId) ?? e.roleId,
    at: e.at,
    reason: e.reason,
    result: e.result,
    ...(e.actionSummary !== undefined ? { actionSummary: e.actionSummary } : {}),
  }));
  return json(200, { items });
}
