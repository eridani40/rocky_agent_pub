/**
 * router-helpers — router 共享 helper（路径匹配 / deps 构造 / JSON 响应）
 *
 * 纯 move 自 router.ts（v0.0.156 结构性拆分）。函数体 100% copy-paste，签名 + 内部逻辑不变。
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §4.8 + INV-R-1
 *
 * 含：bootstrapCache + getBootstrap + json + sessionDeps + matchSessionPath +
 *   dispatchSessionPut + isExcludedApiPath + buildCronRouteDeps + buildConsolidationTestDeps
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径；dataDir 作入参。
 */
import { bootstrapBuiltinPlugins, type BootstrapResult } from '../bootstrap';
import type { SessionHandlerDeps } from '../handlers/session';
import type { CronRouteDeps } from '../handlers/cron-handler';
import type { TodoRouteDeps } from '../handlers/todo-handler';
import type { TestConsolidationRunDeps } from '../handlers/test-consolidation-run';
import type { ConsolidationRunDeps } from '../handlers/consolidation-run';
import { handleSessionItem } from '../handlers/session';
import { handleSessionUpdate } from '../handlers/session-update';

export const HEALTH_PATH = '/health';

/** dataDir → bootstrap Promise 缓存（同进程复用 Registry/service/agent，避免重复 await） */
const bootstrapCache = new Map<string, Promise<BootstrapResult>>();

/** 取（缓存）某 dataDir 的 bootstrap 实例（async：loadAll 内部动态 import impl 模块） */
export function getBootstrap(dataDir: string): Promise<BootstrapResult> {
  let p = bootstrapCache.get(dataDir);
  if (!p) {
    p = bootstrapBuiltinPlugins(dataDir);
    bootstrapCache.set(dataDir, p);
  }
  return p;
}

/** 构造 JSON Response */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 从 bootstrap 构造 session handler 依赖集合（router 透传用） */
export function sessionDeps(bs: BootstrapResult, dataDir: string): SessionHandlerDeps {
  return {
    store: bs.store,
    agentManager: bs.agentManager,
    appConfig: bs.appConfig,
    pluginManager: bs.pluginManager,
    // [v0.0.89] devConfig 字段合并入 appConfig（同源 service；原 dev_config group 直迁 app_config）
    contextEngine: bs.contextEngine,
    // SessionTypePolicy → session-config（buildSessionConfigFromDeps tools 解析必填；debug 端点等同链）
    sessionTypePolicy: bs.sessionTypePolicy,
    // [v0.0.55] SessionTaskLock → session-compact 409 判定 + session-clear markFailed
    taskLock: bs.taskLock,
    dataDir,
    workspaceManager: bs.workspaceManager,
    // [v0.0.23] connectorManager → session-config → browser tool mode=attach（真实实例替换 Task4 桩）
    connectorManager: bs.connectorManager,
    // [v0.0.105] computerNativePort → session-config → screenshot tool（走主进程原生能力，去连接器语义）
    computerNativePort: bs.computerNativePort,
    // [v0.0.23] browserDriverRegistry → session-config → web_fetch headless + browser headless/managed-profile
    browserDriverRegistry: bs.browserDriverRegistry,
    // [v0.0.264] browserInstanceManager → session-config → browser 非 attach 前置校验 + DELETE 兜底清理
    browserInstanceManager: bs.browserInstanceManager,
    // [v0.0.30] logWriter → session-config → SessionConfig（llm/tool hook 注入）
    logWriter: bs.logWriter,
    // [v0.0.47] metaBroadcaster → PUT /session/:id title 后直调 broadcast（前端列表实时刷新 title）
    metaBroadcaster: bs.sessionMetaBroadcaster,
    // [v0.0.47] autoNamingService → handleMessagesPost 内 fire-and-forget 触发 AI 起名
    autoNamingService: bs.autoNamingService,
    // [v0.0.223] TodoStore → todo 工具经 rtc.sessionDeps.todoStore 读取
    todoStore: bs.todoStore,
  };
}

/**
 * 匹配 /session/:id 下的子路径，拆 id + 子段（+ 可选 :enqueueId）。
 * 合法子路径：无子段（CRUD）/ messages / messages/:eid/cancel / summary / abort /
 * usage / compact / clear / workspace/{tree,open,pick-directory}（v0.0.17）/
 * workspace/{watch,unwatch}（v0.0.139 懒监听）。
 */
export function matchSessionPath(pathname: string): {
  id: string;
  sub?: string;
  enqueueId?: string;
} | null {
  // /session/:id/messages/:enqueueId/cancel（更具体的先匹配）
  const cancel = pathname.match(/^\/session\/([^/]+)\/messages\/([^/]+)\/cancel$/);
  if (cancel) return { id: cancel[1]!, sub: 'messages_cancel', enqueueId: cancel[2] };
  // [v0.0.17] /session/:id/workspace/{tree|open|pick-directory}
  // [v0.0.139] 加 watch|unwatch（懒监听 acquire/release，api §2.6.5）
  // [v0.0.177] 加 save-image（粘贴图片落盘，api §2.6.6）
  // [v0.0.227] 加 file（GET 读）/file/save（POST 存，两段优先匹配）（内置 md editor 用，api §2.6.7）
  //   file/save 含 '/'：放在 alternation 最前并替换为 '-'，sub 归一为 workspace_file-save
  // [v0.0.271] 加 watch-set（声明式替换关注集合，api §2.6.5）
  const ws = pathname.match(
    /^\/session\/([^/]+)\/workspace\/(file\/save|tree|open|pick-directory|watch|watch-set|unwatch|save-image|file)$/,
  );
  if (ws) return { id: ws[1]!, sub: `workspace_${ws[2]!.replace('/', '-')}` };
  // [v0.0.21] /session/:id/debug/system-prompt（test gate）
  const dbg = pathname.match(/^\/session\/([^/]+)\/debug\/(system-prompt)$/);
  if (dbg) return { id: dbg[1]!, sub: `debug_${dbg[2]}` };
  // [v0.0.27] 加 read 子段（POST /session/:id/read 标读，spec api 04-agent-session.md §2.3.1）
  // [v0.0.28] 加 children 子段（GET /session/:id/children，spec api 10-multi-agent.md §3）
  // [v0.0.69.test_refactor] 加 run 子段（POST /session/:id/run，test-only 同步 wrapper）
  // [v0.0.97] 加 inbox 子段（GET /session/:id/inbox，enqueue 排队项只读）
  // [v0.0.101] 加 pending-tool-call 子段（GET /pending-tool-call，HITL 悬挂队首 peek）
  // [v0.0.216] 加 chrome 子段（GET /session/:id/chrome，装饰同构接口，api 04a）
  const m = pathname.match(
    /^\/session\/([^/]+)(?:\/(messages|summary|abort|usage|compact|clear|read|children|run|inbox|pending-tool-call|chrome))?$/,
  );
  if (!m) return null;
  return { id: m[1]!, sub: m[2] };
}

/**
 * [v0.0.17] PUT /session/:id 分流：body 含 workspaceDir → handleSessionUpdate；
 * 否则（title/provider/model）→ handleSessionItem（原 PUT 路径）。
 * Request.body 只能读一次，故重建 Request 传给下游 handler。
 */
export async function dispatchSessionPut(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  let rawText = '';
  try {
    rawText = await req.text();
  } catch {
    rawText = '';
  }
  let hasWorkspaceDir = false;
  if (rawText.length > 0) {
    try {
      const parsed = JSON.parse(rawText) as { workspaceDir?: unknown };
      hasWorkspaceDir =
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof parsed.workspaceDir === 'string';
    } catch {
      // 非法 JSON → 走原 handler（它会再报 400）
    }
  }
  const newReq = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: rawText,
  });
  if (hasWorkspaceDir) {
    return handleSessionUpdate(newReq, method, id, deps);
  }
  return handleSessionItem(newReq, method, id, deps);
}

/**
 * 判断 path 是否被 api hook 排除（spec dev-logs §3.3）：
 *   - /sse 与 /sse/*（SSE 长连接流，不适用 req/resp JSON 模型）
 *   - /health（健康检查，高频无业务含义）
 *   OPTIONS 预检在 http-server 层已 204 短路，不进 router，天然不写
 */
export function isExcludedApiPath(path: string): boolean {
  return path === HEALTH_PATH || path === '/sse' || path.startsWith('/sse/');
}

/**
 * [v0.0.58 T4 + T6] 从 bootstrap 构造 CronRouteDeps（cronStore + engine + sessionStore + squadStore）。
 * T6 装配后 BootstrapResult.cronStore + schedulerEngine 已 required，直接读取（不再 503 兜底）。
 */
export function buildCronRouteDeps(bs: BootstrapResult): CronRouteDeps {
  return {
    cronStore: bs.cronStore,
    engine: bs.schedulerEngine,
    sessionStore: bs.store,
    squadStore: bs.squadStore,
    statusBus: bs.sessionStatusBus,
  };
}

/**
 * [v0.0.223] 从 bootstrap 构造 TodoRouteDeps（todoStore + sessionStore）。
 * bs.todoStore 由 bootstrap 无条件装配（独立 store，无 engine 依赖），直接读取。
 */
export function buildTodoRouteDeps(bs: BootstrapResult): TodoRouteDeps {
  return {
    todoStore: bs.todoStore,
    sessionStore: bs.store,
  };
}

/**
 * 从 bootstrap 构造 handleTestConsolidationRun 依赖。
 * bs.consolidationAdapter 理论恒有效（bootScheduler 无条件装配）；仅防御性处理装配失败场景，
 * 返回 null 时 router 层降级 503（不接触 consolidation 业务逻辑）。
 */
export function buildConsolidationTestDeps(
  bs: BootstrapResult,
  dataDir: string,
): TestConsolidationRunDeps | null {
  if (!bs.consolidationAdapter) return null;
  return {
    appConfig: bs.appConfig,
    pluginManager: bs.pluginManager,
    agentManager: bs.agentManager,
    sessionStore: bs.store,
    dataDir,
    adapter: bs.consolidationAdapter,
  };
}

/**
 * [v0.0.164] 组装 handleConsolidationRun 依赖（生产端点 POST /consolidation/run）。
 * 与 buildConsolidationTestDeps 区别：额外挂 AppTaskLock（撞车保护）。
 * bs.consolidationAdapter/appTaskLock 缺任一 → null，router 降级 503（不接触业务逻辑）。
 */
export function buildConsolidationRunDeps(
  bs: BootstrapResult,
  dataDir: string,
): ConsolidationRunDeps | null {
  if (!bs.consolidationAdapter || !bs.appTaskLock) return null;
  return {
    appConfig: bs.appConfig,
    pluginManager: bs.pluginManager,
    agentManager: bs.agentManager,
    sessionStore: bs.store,
    dataDir,
    adapter: bs.consolidationAdapter,
    appTaskLock: bs.appTaskLock,
  };
}
