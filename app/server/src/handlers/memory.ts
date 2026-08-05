/**
 * memory UI HTTP handlers（scope 介质分流 → per-entry dir store）
 * 参考: specs/api/overall/15-memory-ui.md §3-§10（端点契约）
 *       specs/tech/agent/memory/[P0]memory_definition.md §2（介质）
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A4（dir store + session ws 解析）
 *
 * scope 对外统一命名（不变量#1）：HTTP path `:scope` = `global` | `session`（memory-helpers.parseScope 直通）。
 *
 * 介质分流（v0.0.205 per-entry 统一）：
 *   - global  → `<dataDir>/memory/`（global 介质根；app_config user_memory record 已退役不回读）
 *   - session → `<session.workspaceDir>/.rocky/memory/`（session ws 由 sessionStore.getSession 解析；
 *     session not found → 404；workspaceDir 缺省回退 `<dataDir>/workspace`）
 *
 * 与 agent `memory_manage` 工具的边界（spec §10）：
 *   - UI 端点（HTTP）和 agent 工具（LLM tool_use）是两条独立路径，共享底层 dir store + 文件锁
 *
 * 共享 helpers 在 memory-helpers.ts（json/parseScope/resolveSessionId/coerceEntryInput/mergeEntry 等）。
 */
import { join } from 'node:path';
import { resolveDataDir } from '../config';
import type { SessionStore } from '../agent/session-store';
import {
  globalMemoryDir,
  listEntries,
  readEntry,
  wsMemoryDir,
  type MemoryWriteInput,
} from '../memory/memory-dir-store';
import { archiveEntry, createEntry, writeEntry } from '../memory/memory-dir-write';
import { MemoryQuotaExceededError } from '../memory/policy';
import type { AppConfigService } from '../config/app-config-service';
import {
  json,
  nowIso,
  parseScope,
  resolveSessionId,
  coerceEntryInput,
  validateWhyHow,
  mergeEntry,
  charLimitTo400,
  quotaTo400,
} from './memory-helpers';

/** 按 scope 取介质目录（session 分支由 caller 先解析 sessionWsDir 传入） */
function scopeDir(scope: 'global' | 'session', dataDir: string, sessionWsDir?: string): string {
  return scope === 'global' ? globalMemoryDir(dataDir) : wsMemoryDir(sessionWsDir!);
}

/**
 * 解析 session scope 的 ws 根：sessionStore.getSession(sid) → workspaceDir。
 * session not found → null（caller 转 404）；workspaceDir 缺省回退 `<dataDir>/workspace`。
 */
async function resolveSessionWsDir(
  sessionStore: SessionStore,
  dataDir: string,
  sid: string,
): Promise<string | null> {
  const session = await sessionStore.getSession(sid);
  if (!session) return null;
  const ws = typeof session.workspaceDir === 'string' ? session.workspaceDir.trim() : '';
  return ws || join(dataDir, 'workspace');
}

/** 给 session 分支 entry stamp scope（保持 UI 契约：session entries 带 scope:'session'） */
function stampSessionScope<T>(e: T): T & { scope: 'session' } {
  return { ...e, scope: 'session' };
}

// ============================================================
// 4 个端点 handler —— 按 scope 分流（global/session → dir store）
// ============================================================

/**
 * GET /memory/:scope — 列 entry（spec §3）。
 * scope=session 必须带 sessionId（query）。默认排除 archived；includeArchived=true 返全。
 * 返回完整 entry（含 body/why/howToApply，供 UI 展示）——与 agent list（仅 metadata）不同。
 */
async function handleMemoryList(
  sessionStore: SessionStore,
  url: URL,
  scopeParam: string,
): Promise<Response> {
  const scope = parseScope(scopeParam);
  if (!scope) return json(400, { error: `invalid scope: ${scopeParam}` });
  const includeArchived = url.searchParams.get('includeArchived') === 'true';
  const dataDir = resolveDataDir();

  if (scope === 'global') {
    const entries = listEntries(scopeDir('global', dataDir), { includeArchived });
    return json(200, { entries });
  }

  // scope === 'session'
  const sid = url.searchParams.get('sessionId') ?? undefined;
  if (!sid) return json(400, { error: 'sessionId required for scope=session' });
  const wsDir = await resolveSessionWsDir(sessionStore, dataDir, sid);
  if (!wsDir) return json(404, { error: 'session not found' });
  const entries = listEntries(wsMemoryDir(wsDir), { includeArchived }).map(stampSessionScope);
  return json(200, { entries });
}

/**
 * POST /memory/:scope — 新建 entry（spec §4）。
 * body: { sessionId?, entry: {...} }。scope=session 必需 sessionId。
 * 同 scope 同 name 已存在 → 409（createEntry 锁内 exists 判定，防 TOCTOU）。
 * type=feedback|project 强制 why+howToApply。
 */
async function handleMemoryCreate(
  sessionStore: SessionStore,
  req: Request,
  url: URL,
  scopeParam: string,
  appConfig: AppConfigService | null,
): Promise<Response> {
  const scope = parseScope(scopeParam);
  if (!scope) return json(400, { error: `invalid scope: ${scopeParam}` });
  let body: { sessionId?: unknown; entry?: unknown };
  try {
    body = (await req.json()) as { sessionId?: unknown; entry?: unknown };
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }
  let parsed;
  try {
    parsed = coerceEntryInput(body.entry);
  } catch (e) {
    return json(400, { error: e instanceof Error ? e.message : 'invalid entry payload' });
  }
  const whyErr = validateWhyHow(parsed.type, parsed.why, parsed.howToApply);
  if (whyErr) return json(400, { error: whyErr });

  const payload: MemoryWriteInput = {
    name: parsed.name,
    intro: parsed.intro,
    type: parsed.type,
    body: parsed.body,
    why: parsed.why,
    howToApply: parsed.howToApply,
  };

  const dataDir = resolveDataDir();
  // UI 新建：defaultEvolvable=false（用户资产，防 agent 擅改）；不传 enforceEvolvable（UI 不 gate）
  // UI POST origin=user：source='user' 盖戳（仅 create 生效）
  //   字符硬限（intro≤50/body≤500）在 dir store write 层强制 → MemoryCharLimitError → 400；updatedAt 由 store 落盘并回显
  let dir: string;
  if (scope === 'global') {
    dir = scopeDir('global', dataDir);
  } else {
    const sid = resolveSessionId(url, body);
    if (!sid) return json(400, { error: 'sessionId required for scope=session' });
    const wsDir = await resolveSessionWsDir(sessionStore, dataDir, sid);
    if (!wsDir) return json(404, { error: 'session not found' });
    dir = wsMemoryDir(wsDir);
  }
  try {
    // store: {scope, appConfig} 透传给 writeLocked create 分支做存储配额检查（v0.0.247）
    //   scope 由 HTTP path 推（'global'|'session'；UI 不暴露 group tab）；appConfig 由 router DI 注入
    const written = await createEntry(dir, payload, {
      defaultEvolvable: false,
      source: 'user',
      store: { scope, appConfig },
    });
    return json(201, { entry: scope === 'session' ? stampSessionScope(written) : written });
  } catch (e) {
    if (e instanceof Error && /already exists/i.test(e.message)) {
      return json(409, { error: 'entry already exists', name: parsed.name });
    }
    // 配额错 → 400（quotaTo400）；否则走 charLimitTo400（charLimit 错 → 400 / 其余重抛）
    if (e instanceof MemoryQuotaExceededError) return quotaTo400(e);
    return charLimitTo400(e);
  }
}

/**
 * PATCH /memory/:scope/:name — 更新 entry（spec §5）。
 * body: { sessionId?, entry: partial }。除 name 外字段都可改。
 * name 不存在 → 404。merge 后仍要过 type=feedback|project 的 why+howToApply 约束。
 */
async function handleMemoryUpdate(
  sessionStore: SessionStore,
  req: Request,
  url: URL,
  scopeParam: string,
  name: string,
): Promise<Response> {
  const scope = parseScope(scopeParam);
  if (!scope) return json(400, { error: `invalid scope: ${scopeParam}` });
  let body: { sessionId?: unknown; entry?: Record<string, unknown> };
  try {
    body = (await req.json()) as { sessionId?: unknown; entry?: Record<string, unknown> };
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }
  const partial = body.entry;
  if (!partial || typeof partial !== 'object') return json(400, { error: 'entry payload required' });
  // UI PATCH：setEvolvable 携带用户改动（省略=保留原值，resolvePersistedEvolvable 兜底既有）；
  //   不传 enforceEvolvable（UI 全开可改 evolvable，不变量#3）。反归档由 write 落盘恒 archived=false 保证。
  // PATCH 不传 source：保留既有 origin（不可变）；updatedAt 由 store 落盘刷新并回显
  const setEvolvable = typeof partial.evolvable === 'boolean' ? partial.evolvable : undefined;

  const dataDir = resolveDataDir();
  let dir: string;
  if (scope === 'global') {
    dir = scopeDir('global', dataDir);
  } else {
    const sid = resolveSessionId(url, body);
    if (!sid) return json(400, { error: 'sessionId required for scope=session' });
    const wsDir = await resolveSessionWsDir(sessionStore, dataDir, sid);
    if (!wsDir) return json(404, { error: 'session not found' });
    dir = wsMemoryDir(wsDir);
  }

  let existing;
  try {
    existing = readEntry(dir, name);
  } catch {
    return json(404, { error: 'entry not found' });
  }
  const merged = mergeEntry(existing, partial);
  const whyErr = validateWhyHow(merged.type, merged.why, merged.howToApply);
  if (whyErr) return json(400, { error: whyErr });
  try {
    const written = await writeEntry(dir, merged, { setEvolvable });
    return json(200, { entry: scope === 'session' ? stampSessionScope(written) : written });
  } catch (e) {
    return charLimitTo400(e);
  }
}

/**
 * DELETE /memory/:scope/:name — 归档 entry（spec §6，不真删）。
 * 标 archived=true；name 不存在 → 404。
 * UI 全开不 gate（不变量#3）：archive **不传** enforceEvolvable，
 *   与 agent `memory_manage.archive`（传 enforceEvolvable:true）正交。
 */
async function handleMemoryDelete(
  sessionStore: SessionStore,
  url: URL,
  scopeParam: string,
  name: string,
): Promise<Response> {
  const scope = parseScope(scopeParam);
  if (!scope) return json(400, { error: `invalid scope: ${scopeParam}` });
  const dataDir = resolveDataDir();

  let dir: string;
  if (scope === 'global') {
    dir = scopeDir('global', dataDir);
  } else {
    const sid = url.searchParams.get('sessionId') ?? undefined;
    if (!sid) return json(400, { error: 'sessionId required for scope=session' });
    const wsDir = await resolveSessionWsDir(sessionStore, dataDir, sid);
    if (!wsDir) return json(404, { error: 'session not found' });
    dir = wsMemoryDir(wsDir);
  }
  try {
    await archiveEntry(dir, name);
  } catch {
    return json(404, { error: 'entry not found' });
  }
  return json(200, { ok: true, archivedAt: nowIso() });
}

/**
 * /memory/* 路由分发入口（router 调用）。
 * 路由形态：
 *   /memory/:scope           → GET（列表）/ POST（新建）
 *   /memory/:scope/:name     → PATCH（更新）/ DELETE（归档）
 *
 * appConfig 由 router 经 bootstrap DI 注入（misc-routes 透传 bs.appConfig），仅 POST 新建
 *   路径需要（create 分支配额检查）；GET/PATCH/DELETE 忽略。默认 null（向后兼容 5-arg caller）。
 */
export async function handleMemoryRoute(
  req: Request,
  method: string,
  path: string,
  url: URL,
  sessionStore: SessionStore,
  appConfig: AppConfigService | null = null,
): Promise<Response> {
  const m = path.match(/^\/memory\/([^/]+)(?:\/([^/]+))?$/);
  if (!m) return json(404, { error: 'Not Found' });
  const scope = m[1]!;
  const name = m[2];
  if (!name) {
    // /memory/:scope
    if (method === 'GET') return handleMemoryList(sessionStore, url, scope);
    if (method === 'POST') return handleMemoryCreate(sessionStore, req, url, scope, appConfig);
    return json(405, { error: 'Method Not Allowed' }, { allow: 'GET,POST' });
  }
  // /memory/:scope/:name
  if (method === 'PATCH') return handleMemoryUpdate(sessionStore, req, url, scope, name);
  if (method === 'DELETE') return handleMemoryDelete(sessionStore, url, scope, name);
  return json(405, { error: 'Method Not Allowed' }, { allow: 'PATCH,DELETE' });
}
