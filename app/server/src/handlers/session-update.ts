/**
 * session-update handler —— PUT /session/:id 切 workspaceDir
 * 参考: specs/api/overall/04-agent-session.md §2.5（PUT /session/:id 契约）
 *       specs/tech/agent/session/[P0]session_workspace.md §4（切换流程 recycle→set）
 *       specs/tech/agent/session/[P0]session_workspace_manager.md §9（switchDir 编排）
 *
 * 职责（仅处理 PUT 的 workspaceDir 字段切换，与 session.ts 的 title/provider/model PUT 分离）：
 *   - 校验 newDir：绝对路径 + 存在 + 是目录 → 否则 400（spec §4.1 step2）
 *   - 调 SessionWorkspaceManager.switchDir（懒监听编排：recycleSession 旧目录全部监听 → setDirCb）
 *     · setDirCb 内调 store.setWorkspaceDir（更新字段 + 持久化 + emit dir_changed）
 *     · 不重启新目录监听（前端收 dir_changed 后重新 watch 新根，spec §9）
 *   - 返更新后的 Session
 *
 * 边界：
 *   - title/providerId/modelId 的 PUT 仍在 session.ts handleSessionItem 处理（router 分流：
 *     body 含 workspaceDir → 本 handler；否则原 session.ts PUT 路径）。
 *   - 不在本文件：GET / POST / DELETE / 其他字段 PUT。
 */
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionHandlerDeps } from './session';
// 复用 seed.ts 的 validateCallerWorkspaceDir（单一权威：POST /session + PUT /session/:id 切目录共用 §4.1 校验）
import { validateCallerWorkspaceDir } from './session-workspace-seed';

/** 构造 JSON Response（可选 Allow 头） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * best-effort 复制 `<oldWs>/.rocky/` → `<newWs>/.rocky/`（session ws 切换时 memory/skills/state 跟走）。
 * oldWs 无 `.rocky` → skip；复制异常 try/catch warn 不阻塞 PUT；
 * `force:false` 不覆盖新 ws 既有 `.rocky` 内容（新 ws 既有文件胜出）。
 */
function copyRockyDirBestEffort(oldWs: string, newWs: string): void {
  if (oldWs === newWs) return;
  const src = join(oldWs, '.rocky');
  if (!existsSync(src)) return;
  try {
    cpSync(src, join(newWs, '.rocky'), { recursive: true, force: false, errorOnExist: false });
  } catch (e) {
    console.warn(`[session-update] 复制 .rocky 失败（不阻塞切换）: ${src} → ${join(newWs, '.rocky')}:`, e);
  }
}

/**
 * 应用 title 更新：同步置 titled=true + 触发 metaBroadcaster.broadcast。
 *
 * 抽出此 helper 因两个分支（仅 title / workspaceDir+title）写法完全一致（spec auto_naming §6）。
 * 注：SessionMetaBroadcaster.broadcast 是同步 void 且内部已 try/catch 吞异常（spec decision.md
 * §5），故调用层无需再 try/catch、无需 await。
 */
async function applyTitleUpdate(
  deps: SessionHandlerDeps,
  id: string,
  title: string,
): Promise<void> {
  await deps.store.updateSession(id, { title, titled: true });
  if (deps.metaBroadcaster) deps.metaBroadcaster.broadcast(id);
}

/**
 * PUT /session/:id（仅 workspaceDir 字段切换）。
 *
 * 行为（spec session_workspace.md §4.1 + manager.md §9）：
 *   1. session 不存在 → 404
 *   2. body.workspaceDir 必填（无 → 400）
 *   3. 校验 newDir：isAbsolute + existsSync + isDirectory → 否则 400
 *   4. manager.switchDir(sid, newDir, setDirCb)：
 *        - 内部 recycleSession 回收旧目录全部监听（相对路径基准变了，旧监听失效）
 *        - 调 setDirCb = store.setWorkspaceDir（更新字段 + 持久化 + emit session_workspace_dir_changed）
 *        - 不重启新目录监听（前端收 dir_changed 后重新 watch 新根，spec §9）
 *   5. 返 200 + 更新后的 Session
 *
 * 错误：404 session；400 workspaceDir 缺失 / 非绝对路径 / 不存在 / 非目录。
 */
export async function handleSessionUpdate(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'PUT') {
    return json(405, { error: 'Method Not Allowed' }, 'PUT');
  }
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });

  // body 解析（spec §2.5：UpdateSessionBody { workspaceDir?, title? }）
  let bodyWorkspaceDir: string | undefined;
  let bodyTitle: string | undefined;
  try {
    if (req.body !== null && req.body !== undefined) {
      const parsed = (await req.json()) as { workspaceDir?: string; title?: string };
      if (typeof parsed.workspaceDir === 'string') bodyWorkspaceDir = parsed.workspaceDir;
      if (typeof parsed.title === 'string') bodyTitle = parsed.title;
    }
  } catch {
    return json(400, { error: 'invalid json body' });
  }

  // 无 workspaceDir 且无 title → 视作空更新（spec §2.5 允许部分字段；本 handler 至少要有一个）
  if (bodyWorkspaceDir === undefined && bodyTitle === undefined) {
    return json(400, { error: 'empty update (provide workspaceDir or title)' });
  }

  // 处理 title（简单字段更新，不经 manager）
  // 同步置 titled=true（防 AI 名返回时 CAS 覆盖；spec auto_naming §6）
  if (bodyTitle !== undefined && bodyWorkspaceDir === undefined) {
    await applyTitleUpdate(deps, id, bodyTitle);
    const updated = await deps.store.getSession(id);
    return json(200, updated);
  }

  // 以下：bodyWorkspaceDir 必有（spec §2.5 切目录主路径）
  const newDir = bodyWorkspaceDir!;

  // 校验 newDir：绝对路径 + 存在 + 是目录（spec §4.1 step2，复用 validateCallerWorkspaceDir 单一实现）
  const dirErr = validateCallerWorkspaceDir(newDir);
  if (dirErr) {
    return json(400, { error: dirErr });
  }

  // manager.switchDir（v0.0.139 懒监听编排：recycleSession(旧目录全部监听) → setDirCb；
  // 不重启 watch，前端收 dir_changed 后重新 watch 新根，spec session_workspace_manager.md §9）。
  // setDirCb = store.setWorkspaceDir（含 emit session_workspace_dir_changed）
  // 若 workspaceManager 未注入（旧测试）→ 直接调 store.setWorkspaceDir（无 watch 联动）
  const oldWs = got.workspaceDir && got.workspaceDir.trim()
    ? got.workspaceDir
    : join(deps.dataDir, 'workspace');
  if (deps.workspaceManager) {
    await deps.workspaceManager.switchDir(id, newDir, (sid, dir) =>
      deps.store.setWorkspaceDir(sid, dir),
    );
  } else {
    await deps.store.setWorkspaceDir(id, newDir);
  }

  // session ws 可变：切换成功后把 `<oldWs>/.rocky/` 复制到 `<newWs>/.rocky/`
  // （memory/skills/state 跟 ws 走；best-effort——复制失败 warn 不阻塞 PUT；
  //   force:false 不覆盖新 ws 既有内容，2 session 挤同一 ws = 一份不阻止，新 ws 既有文件胜出）
  copyRockyDirBestEffort(oldWs, newDir);

  // 同时 title 更新（spec §2.5 UpdateSessionBody 允许 workspaceDir + title 同传）
  // 同步置 titled=true + 触发 broadcast（与仅 title 路径一致，spec auto_naming §6）
  if (bodyTitle !== undefined) {
    await applyTitleUpdate(deps, id, bodyTitle);
  }

  const updated = await deps.store.getSession(id);
  return json(200, updated);
}
