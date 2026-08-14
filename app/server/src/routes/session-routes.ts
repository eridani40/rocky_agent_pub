/**
 * session-routes — /session* 路由组（含 session collection / :id / 子路径 / :sid/cron*）
 *
 * 纯 move 自 router.ts（v0.0.156 结构性拆分）。路由顺序 + 前缀匹配逻辑 100% copy-paste。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.8 + INV-R-1
 *
 * 路径分发顺序（INV-R-1 严格保留）：
 *   1. /session collection
 *   2. matchSessionPath 结果（含 /messages /abort /usage /compact /clear /read /children 等）
 *   3. /session/:sid/cron*（cron UI 端点，与 agent cron_* 工具正交）
 *
 * 未命中返 null，主分发继续尝试下一个路由组。
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径。
 */
import type { BootstrapResult } from '../bootstrap';
import {
  sessionDeps, matchSessionPath, dispatchSessionPut, buildCronRouteDeps, buildTodoRouteDeps, json,
} from './router-helpers';
import { handleSessionCollection, handleSessionItem } from '../handlers/session';
import { handleSessionMessages } from '../handlers/session-messages';
import { handleSessionInbox } from '../handlers/session-inbox';
import { handleSessionPendingToolCall } from '../handlers/session-pending-tool-call';
import { handleSessionChrome } from '../handlers/session-chrome';
// [v0.0.216] chrome 端点 memberStore（无状态封装随用随建，与 session-debug 同模式）
import { MemberStore } from '../stores/squad-store';
import { handleSessionRun } from '../handlers/session-run';
import { handleSessionAbort, handleSessionMessageCancel } from '../handlers/session-abort';
import { handleSessionChildren } from '../handlers/session-children';
import { handleSessionUsage } from '../handlers/session-usage';
import { handleSessionCompact } from '../handlers/session-compact';
import { handleSessionClear } from '../handlers/session-clear';
import { handleSessionRead } from '../handlers/session-read';
import { handleSessionSummary } from '../handlers/session';
import {
  handleWorkspaceTree, handleWorkspaceOpen, handleWorkspacePickDirectory,
} from '../handlers/session-workspace';
import { handleWorkspaceWatch, handleWorkspaceWatchSet, handleWorkspaceUnwatch } from '../handlers/session-workspace-watch';
import { handleWorkspaceSaveImage } from '../handlers/session-workspace-save-image';
import { handleWorkspaceFileRead, handleWorkspaceFileSave, handleWorkspaceStat } from '../handlers/session-workspace-file';
import { handleWorkspaceSearch } from '../handlers/session-workspace-search';
import { handleSessionDebugSystemPrompt } from '../handlers/session-debug';
import { handleCronRoute } from '../handlers/cron-handler';
import { handleTodoRoute } from '../handlers/todo-handler';

/**
 * /session* 路由组分发。命中返 Response；未命中返 null（主分发继续下个 group）。
 *
 * @param url       URL（用于 query 参数透传）
 * @param method    HTTP method（大写）
 * @param path      pathname
 * @param bs        bootstrap 实例
 * @param dataDir   绝对路径
 */
export async function dispatchSessionRoutes(
  req: Request,
  url: URL,
  method: string,
  path: string,
  bs: BootstrapResult,
  dataDir: string,
): Promise<Response | null> {
  // /session collection（POST / GET）
  if (path === '/session') {
    return handleSessionCollection(req, method, sessionDeps(bs, dataDir));
  }

  const sessionMatch = matchSessionPath(path);
  if (sessionMatch) {
    const deps = sessionDeps(bs, dataDir);
    if (!sessionMatch.sub) {
      // [v0.0.17] PUT /session/:id：body 含 workspaceDir → 切目录走 handleSessionUpdate；
      // 否则（title/provider/model）走原 handleSessionItem。GET/DELETE 不变。
      if (method === 'PUT') {
        return dispatchSessionPut(req, method, sessionMatch.id, deps);
      }
      return handleSessionItem(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'messages') {
      return handleSessionMessages(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'inbox') {
      // [v0.0.97] GET /session/:id/inbox（enqueue 排队项只读 seed，前端 onInit + 切 session 拉）
      return handleSessionInbox(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'pending-tool-call') {
      // [v0.0.101 T4] GET /session/:id/pending-tool-call（HITL 悬挂队首 peek，recover 用）
      return handleSessionPendingToolCall(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'chrome') {
      // [v0.0.216] GET /session/:id/chrome（装饰同构接口，api 04a）。
      // 独立 SessionChromeDeps 就地组装（不膨胀 SessionHandlerDeps）；
      // memberStore 无状态封装随用随建（与 session-debug 同模式）。
      return handleSessionChrome(req, method, sessionMatch.id, {
        store: bs.store,
        appConfig: bs.appConfig,
        squadStore: bs.squadStore,
        memberStore: new MemberStore({ root: dataDir }),
        academyStore: bs.academyStore,
      });
    }
    if (sessionMatch.sub === 'messages_cancel') {
      // v0.0.12：POST /session/:id/messages/:enqueueId/cancel
      return handleSessionMessageCancel(
        req, method, sessionMatch.id, sessionMatch.enqueueId!, deps,
      );
    }
    if (sessionMatch.sub === 'abort') {
      return handleSessionAbort(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'usage') {
      return handleSessionUsage(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'compact') {
      return handleSessionCompact(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'clear') {
      return handleSessionClear(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'read') {
      // [v0.0.27] POST /session/:id/read 标读（CAS unread=false + emit session_read_update）
      return handleSessionRead(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'children') {
      // [v0.0.28] GET /session/:id/children（spec api 10-multi-agent.md §3）
      return handleSessionChildren(req, method, sessionMatch.id, deps, url);
    }
    if (sessionMatch.sub === 'run') {
      // [v0.0.69.test_refactor] POST /session/:id/run（test-only 同步 wrapper）
      // 非 test env → 404（生产绝不暴露）。handler 内有双重 gate（防绕过直接调）。
      if (process.env.NODE_ENV !== 'test') return json(404, { error: 'Not Found' });
      return handleSessionRun(req, method, sessionMatch.id, deps);
    }
    // [v0.0.17] workspace 端点组
    if (sessionMatch.sub === 'workspace_tree') {
      return handleWorkspaceTree(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'workspace_open') {
      return handleWorkspaceOpen(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'workspace_pick-directory') {
      return handleWorkspacePickDirectory(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'workspace_watch') {
      // [v0.0.139] POST /session/:id/workspace/watch（懒监听 acquire，api §2.6.5）
      return handleWorkspaceWatch(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'workspace_watch-set') {
      // [v0.0.271] POST /session/:id/workspace/watch-set（声明式替换关注集合，api §2.6.5）
      return handleWorkspaceWatchSet(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'workspace_unwatch') {
      // [v0.0.139] POST /session/:id/workspace/unwatch（懒监听 release，api §2.6.5）
      return handleWorkspaceUnwatch(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'workspace_save-image') {
      // [v0.0.177] POST /session/:id/workspace/save-image（粘贴图片落盘，api §2.6.6）
      return handleWorkspaceSaveImage(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'workspace_file') {
      // [v0.0.227] GET /session/:id/workspace/file（读文本文件，内置 md editor 用，api §2.6.7）
      return handleWorkspaceFileRead(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'workspace_file-save') {
      // [v0.0.227] POST /session/:id/workspace/file/save（覆盖写文本文件，last-write-wins，api §2.6.7）
      return handleWorkspaceFileSave(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'workspace_search') {
      // [v0.0.320] GET /session/:id/workspace/search?q=（递归全量搜索文件名/文件夹名，api v0.0.320 §1.3）
      return handleWorkspaceSearch(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'workspace_stat') {
      // [v0.0.339] GET /session/:id/workspace/stat?path=（文件大小判定，供前端打开分流；api v0.0.339）
      return handleWorkspaceStat(req, method, sessionMatch.id, deps);
    }
    if (sessionMatch.sub === 'debug_system-prompt') {
      // [v0.0.21] GET /session/:id/debug/system-prompt（test gate，handler 内 404）
      return handleSessionDebugSystemPrompt(req, method, sessionMatch.id, deps);
    }
    // sub === 'summary'
    return handleSessionSummary(req, method, sessionMatch.id, deps);
  }

  // [v0.0.58 T4 + T6] /session/:sid/cron* 路由组（6 UI 端点，与 agent cron_* 工具正交）
  // T6 bootstrap 装配 cronStore + schedulerEngine 后必填。
  if (/^\/session\/[^/]+\/cron(\/|$)/.test(path)) {
    const cronDeps = buildCronRouteDeps(bs);
    return handleCronRoute(req, method, path, cronDeps);
  }

  // [v0.0.223] /session/:sid/todos* 路由组（7 UI 端点，与 todo 工具正交）
  if (/^\/session\/[^/]+\/todos(\/|$)/.test(path)) {
    const todoDeps = buildTodoRouteDeps(bs);
    return handleTodoRoute(req, method, path, todoDeps);
  }

  return null;
}
