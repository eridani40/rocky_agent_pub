/**
 * session-workspace-watch handlers —— 懒监听 watch/unwatch 端点（v0.0.139 新增）
 * 参考: specs/api/overall/04-agent-session.md §2.6.5（watch/unwatch 契约）
 *       specs/tech/agent/session/[P0]session_workspace_manager.md（懒监听权威源）
 *
 * 拆出独立文件（而非并入 session-workspace.ts）：coder 决策——handlers/session-workspace.ts
 * 加完这两个端点会超单文件 ≤300 行硬上限，故拆分，复用其 json/whitelistResolve（已 export）。
 * 与 change_plan 模块3「handlers/session-workspace.ts 新增 handleWorkspaceWatch/Unwatch」文件
 * 归属有偏离——符号/契约不变，仅物理落点变化，已汇报 orchestrator。
 *
 * 两个端点：POST watch（acquire，展开目录/打开 tab 调）/ POST unwatch（release，收起目录 /
 *   卸载 tab / 切 session 调，path 省略=release-all）。安全：白名单校验同 session-workspace.ts
 *   （resolve + 链式授权解析，v0.0.263 起 symlink 段 realpath 授权，见 session-workspace-path.ts），
 *   但「目标不存在」在此静默 200（非 404/400，manager 幂等容忍）。
 */
import { realpathSync } from 'node:fs';
import type { SessionHandlerDeps } from './session';
import { json } from './session-workspace';
import { whitelistResolve } from './session-workspace-path';

/** watch/unwatch 请求体解析结果（clientId 必填，path 按端点语义可选） */
interface WatchUnwatchBody {
  clientId: string;
  path?: string;
  hasPath: boolean; // 区分「path 省略」vs「path 显式传空串」（unwatch release-all 语义分界）
}

/** 解析 watch/unwatch 共用 body：`{clientId, path?}`；非法 JSON → null（caller 返 400）。 */
async function parseBody(req: Request): Promise<WatchUnwatchBody | null> {
  try {
    const parsed = (await req.json()) as { clientId?: string; path?: string };
    const clientId = typeof parsed.clientId === 'string' ? parsed.clientId : '';
    const hasPath = typeof parsed.path === 'string';
    return { clientId, path: hasPath ? parsed.path : undefined, hasPath };
  } catch {
    return null;
  }
}

/** realpath session.workspaceDir，供 whitelistResolve 用作 realRoot 基准。 */
function resolveRoot(workspaceDir: string): { ok: true; realRoot: string } | { ok: false } {
  try {
    return { ok: true, realRoot: realpathSync(workspaceDir) };
  } catch {
    return { ok: false };
  }
}

/** watch/unwatch 共用的目标解析结果：ok=true 带 realRoot+relDir；ok=false 带现成 Response。 */
type WatchTarget =
  | { ok: true; realRoot: string; relDir: string }
  | { ok: false; res: Response };

/**
 * 解析并校验 watch/unwatch 目标（两端点共用，消除重复的 resolve+白名单块）：
 * workspaceDir 缺失/不可读 → 500；穿越 → 400；目标不存在 → 静默 200；合法 → { realRoot, relDir }。
 */
function resolveWatchTarget(workspaceDir: string | undefined, path: string | undefined): WatchTarget {
  if (!workspaceDir) return { ok: false, res: json(500, { error: 'session has no workspaceDir' }) };
  const rootResult = resolveRoot(workspaceDir);
  if (!rootResult.ok) return { ok: false, res: json(500, { error: 'workspaceDir not readable' }) };
  const relDir = path ?? '';
  const wl = whitelistResolve(rootResult.realRoot, relDir);
  if (!wl.ok) {
    if (wl.reason === 'traversal') {
      return { ok: false, res: json(400, { error: 'path out of workspace (path traversal denied)' }) };
    }
    return { ok: false, res: json(200, { ok: true }) }; // not_found：目标不存在，静默 no-op
  }
  return { ok: true, realRoot: rootResult.realRoot, relDir };
}

/**
 * POST /session/:id/workspace/watch —— 懒监听 acquire（spec api §2.6.5）。
 * body { clientId, path }；缺 clientId→400；path resolve 后不在 workspaceDir 内→400（穿越）；
 * 目标不存在/非目录 → manager 内部静默忽略，本端点仍返 200（容忍前端与 fs 短暂不一致）。
 */
export async function handleWorkspaceWatch(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'POST') return json(405, { error: 'Method Not Allowed' }, 'POST');
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'invalid json body' });
  if (!body.clientId) return json(400, { error: 'clientId required' });

  const target = resolveWatchTarget(got.workspaceDir, body.path);
  if (!target.ok) return target.res;

  await deps.workspaceManager?.watch(id, body.clientId, target.realRoot, target.relDir);
  return json(200, { ok: true });
}

/**
 * POST /session/:id/workspace/unwatch —— 懒监听 release（spec api §2.6.5）。
 * body { clientId, path? }；path 省略 = 回收该 tab 全部监听（release-all，走 releaseTab，
 * 不需白名单校验——release 不依赖目标当前是否存在）；有 path 则同 watch 校验后走 unwatch。
 */
export async function handleWorkspaceUnwatch(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'POST') return json(405, { error: 'Method Not Allowed' }, 'POST');
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'invalid json body' });
  if (!body.clientId) return json(400, { error: 'clientId required' });

  if (!body.hasPath) {
    await deps.workspaceManager?.releaseTab(id, body.clientId);
    return json(200, { ok: true });
  }

  const target = resolveWatchTarget(got.workspaceDir, body.path);
  if (!target.ok) return target.res;

  await deps.workspaceManager?.unwatch(id, body.clientId, target.realRoot, target.relDir);
  return json(200, { ok: true });
}

/**
 * POST /session/:id/workspace/watch-set —— 声明式替换该 tab 关注集合（v0.0.271 裁决 R1/R5）。
 * body { clientId, paths: string[] }（完整集合，非增量）；缺 clientId → 400；paths 非数组 → 400；
 * 逐 path 白名单校验（同 watch 的 resolveWatchTarget：越界 400 / 不存在静默跳过）；
 * 合法 relDirs → manager.applyWatchSet（全量 diff，不在新集合一律 close）。
 * ⚠️ 不建议与 watch/unwatch 增量端点混用同一 tab（声明式 diff 基于旧集合，混用状态不一致）。
 */
export async function handleWorkspaceWatchSet(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'POST') return json(405, { error: 'Method Not Allowed' }, 'POST');
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });

  let parsed: { clientId?: string; paths?: unknown };
  try {
    parsed = (await req.json()) as { clientId?: string; paths?: unknown };
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  const clientId = typeof parsed.clientId === 'string' ? parsed.clientId : '';
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!Array.isArray(parsed.paths)) return json(400, { error: 'paths array required' });
  const paths = parsed.paths.filter((p): p is string => typeof p === 'string');
  if (paths.length !== parsed.paths.length) return json(400, { error: 'paths must be strings' });

  // workspaceDir 缺失 → 500（同 watch；空数组也需有根基准语义一致）
  if (!got.workspaceDir) return json(500, { error: 'session has no workspaceDir' });
  const rootResult = resolveRoot(got.workspaceDir);
  if (!rootResult.ok) return json(500, { error: 'workspaceDir not readable' });
  const realRoot = rootResult.realRoot;

  // 逐 path resolve：越界 400 / 不存在静默跳过（同 watch 单 path 语义）
  const relDirs: string[] = [];
  for (const path of paths) {
    const target = resolveWatchTarget(got.workspaceDir, path);
    if (!target.ok) {
      if (target.res.status === 400) return target.res; // 穿越，直接 400
      continue; // 不存在 → 静默跳过
    }
    relDirs.push(target.relDir);
  }

  await deps.workspaceManager?.applyWatchSet(id, clientId, realRoot, relDirs);
  return json(200, { ok: true });
}
