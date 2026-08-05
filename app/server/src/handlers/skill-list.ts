/**
 * skill 列表端点（GET /skill）—— 从 skill.ts 拆出（单文件 300 行红线）
 * 参考: specs/api/overall/06-skill.md §3
 *       specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A6（?sessionId= 派生）
 *
 * query 两入口（sessionId 优先于 workspace）：
 *   - `?sessionId=<sid>`：按 session record 派生四层合并 catalog——workspace=session.workspaceDir
 *     （缺省回退 `<dataDir>/workspace`）、groupDir=resolveGroupWsDir(session.squadId)。
 *     session not found → 404。响应 SkillEntry.scope 值域含 'group'。
 *   - `?workspace=<abs>`：三层合并（无 group 层，向后兼容）。
 */
import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { AppConfigService } from '../config/app-config-service';
import type { SessionStore } from '../agent/session-store';
import { SkillResolver, builtinSkillRoot } from '../skills/resolver';
import { SkillEnabledStore } from '../skills/enabled-store';
import { resolveGroupWsDir } from '../agent/group-dir';

/** 构造 JSON Response（handlers 各文件局部约定，与 skill.ts 同款） */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** GET /skill —— 列表（四层合并去重）→ items[] */
export async function handleSkillList(
  url: URL,
  appConfig: AppConfigService,
  dataDir: string,
  sessionStore: SessionStore,
): Promise<Response> {
  const enabledStore = new SkillEnabledStore(appConfig);

  const sessionId = url.searchParams.get('sessionId') ?? undefined;
  if (sessionId) {
    const session = await sessionStore.getSession(sessionId);
    if (!session) return json(404, { error: 'session not found' });
    const ws = typeof session.workspaceDir === 'string' && session.workspaceDir.trim()
      ? session.workspaceDir
      : join(dataDir, 'workspace');
    const groupDir = resolveGroupWsDir(dataDir, {
      squadId: session.squadId,
    });
    // 传入 builtinSkillRoot() → catalog 含随 app 发版的内置 skill；groupDir 命中 group 层（scope='group'）
    const catalog = SkillResolver.resolve(dataDir, ws, enabledStore, builtinSkillRoot(), groupDir);
    return json(200, { items: catalog.entries });
  }

  const workspace = url.searchParams.get('workspace') ?? undefined;
  if (workspace && (!isAbsolute(workspace) || !isDir(workspace))) {
    return json(404, { error: 'workspace not found' });
  }
  // 传入 builtinSkillRoot() → catalog 含随 app 发版的内置 skill（okf-skill 等）
  const catalog = SkillResolver.resolve(dataDir, workspace, enabledStore, builtinSkillRoot());
  return json(200, { items: catalog.entries });
}
