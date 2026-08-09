/**
 * SessionHandlerDeps + 请求体类型 + provider/model 校验
 * 参考: states/v0.0.46.connector_opt/design.md §5（DELETE 兜底 disconnect deps.connectorManager）
 *
 * 承载：
 *   - SessionHandlerDeps 接口（session.ts / session-messages.ts / router.ts 共享）
 *   - CreateSessionBody / UpdateSessionBody 请求体类型
 *   - listEnabledProviders / findProvider / validateProviderModel 校验 helper
 *
 * session.ts 通过 `export * from './session-deps'` 或显式 re-export 保持外部导入路径稳定。
 */
import type { AppConfigService } from '../config/app-config-service';
import type { PluginManager } from '../plugin/plugin-manager';
import type { ProviderInstance } from './provider';
import type { AgentManagerImpl } from '../agent/agent-manager';
import type { SessionStore } from '../agent/session-store';
import type { ContextEngine } from '../agent/context-engine';
import type { SessionTaskLock } from '../agent/session-task-lock';
import type { SessionWorkspaceManager } from '../agent/session-workspace-manager';
import type { OpenKind, OpenResult } from '../platform/workspace-open';
import type { PickResult } from '../platform/workspace-dialog';
import type { ConnectorManager } from '../tools/browser/connector-manager';
import type { BrowserInstanceManager } from '../tools/browser/instance-manager';
import type { ComputerNativePort } from '../platform/computer/native-port';
import type { SessionMetaBroadcaster } from '../agent/session-meta-broadcaster';
import type { AutoNamingService } from '../agent/auto-naming-service';
import type { SessionTypePolicy } from '../agent/session-type-policy';
// 保留字判定 helper（modelId 校验统一权威）
import { isReservedModelId } from '../services/model-validation';
import type { AgentRun } from '../agent/agent-interface';
import { ModelNotConfiguredError } from '../services/model-resolver';

/** providers 组名（与 provider handler 一致；POST /session 校验用） */
export const PROVIDERS_GROUP = 'providers';

/**
 * 解析 error-shell AgentRun → HTTP 响应结果（session-run / session-messages 共享）。
 *
 * activate 失败时 deliverTo 返 state==='error' 的 run（非 throw）。本 helper 统一处理：
 *   1. 同步挂 noop catch 消费已 reject 的 promise（error 已由 state 表达，
 *      promise 不应再变 unhandled rejection 击穿 Bun 进程——见 memory
 *      `makeErrorRun-unhandled-rejection-crash`）；
 *   2. makeErrorRun 透传的原 Error 经 instanceof 识别 ModelNotConfiguredError → 语义化 400；
 *   3. 其余（session not found / buildMainDeps throw）→ 500 兜底。
 *
 * 集中到此处的目的：① 新增 handler 时无需重写 4 行 instanceof + body，也漏不掉 catch 护栏；
 *   ② `{code, message, detail}` 错误体形态单点维护避免 drift。
 */
export function resolveErrorRunResult(agentRun: AgentRun): { status: number; body: unknown } {
  void agentRun.promise.catch(() => {});
  const err = agentRun.error;
  if (err instanceof ModelNotConfiguredError) {
    return { status: 400, body: { code: err.code, message: err.message, detail: err.detail } };
  }
  return { status: 500, body: { error: `activate failed for runId: ${agentRun.runId}` } };
}

/**
 * handler 依赖注入集合（router 从 bootstrap context 取实例构造）。
 * 用具体类型（便于 handler 直接调方法）；单测可注入真实实例（tmpdir）或 fake。
 */
export interface SessionHandlerDeps {
  store: SessionStore;
  agentManager: AgentManagerImpl;
  appConfig: AppConfigService;
  pluginManager: PluginManager;
  /**
   * ContextEngine —— POST /session/:id/compact 手动触发端点需调
   * contextEngine.compact 执行路径（复用 forked agent + SessionTaskLock CAS）。
   */
  contextEngine: ContextEngine;
  /**
   * SessionTaskLock —— POST /session/:id/compact 409 判定读 lock.getState(sid,'compact')。
   * 缺省 undefined → 视为 idle 放行（旧 UT 兼容；生产由 bootstrap 注入）。
   * 参考: specs/tech/agent/session/[P0]session_task_lock.md §5
   */
  taskLock?: SessionTaskLock;
  /** DATA_DIR 绝对路径（派生 workdir=<DATA_DIR>/workspace） */
  dataDir: string;
  /**
   * SessionWorkspaceManager —— workspace 懒监听 watcher（目录级非递归 + tab 引用计数）。
   * DELETE session 时调 recycleSession 回收该 session 全部 tab 监听（与 SSE unsubscribe 兜底路径互补）。
   * 可选：旧测试 / 不涉及 DELETE 的 handler 路径可不注入。
   */
  workspaceManager?: SessionWorkspaceManager;
  /**
   * workspace open spawn 注入点（测试 mock 避免真实 spawn 弹系统 GUI；生产留空 → 默认）。
   */
  openWorkspaceItem?: (kind: OpenKind, absPath: string) => OpenResult;
  /**
   * workspace pick-directory dialog 注入点（测试 mock 避免弹原生 dialog；生产留空 → 默认）。
   */
  pickWorkspaceDirectory?: (currentDir: string | undefined) => PickResult;
  /**
   * ConnectorManager —— 连接器开关门禁 + UI 状态（v0.0.266 瘦身）。
   * 由 router 从 bootstrap.connectorManager 注入；缺省 → session-config 走 noop（attach fail-closed）。
   * attach session 生命周期已归 BrowserInstanceManager；DELETE /session 兜底走 browserInstanceManager.releaseSession。
   */
  connectorManager?: ConnectorManager;
  /** BrowserInstanceManager —— headless/managed-profile 常驻浏览器实例（v0.0.264）：注入 ctx.config + DELETE 兜底 releaseSession（幂等，catch 不阻塞 204） */
  browserInstanceManager?: BrowserInstanceManager;
  /**
   * ComputerNativePort —— computer use 原生能力端口（screenshot 等 tool 读，走主进程能力）。
   * 由 router 从 bootstrap.computerNativePort 注入 → session-config 注入 ctx.config.computerNativePort。
   * 缺省 undefined → screenshot tool fail-closed 返「仅桌面 App 可用」。
   * 去连接器语义：无 owner/connect/disconnect（DELETE /session 不再兜底断开）。
   */
  computerNativePort?: ComputerNativePort;
  /**
   * BrowserDriverRegistry —— 含 PlaywrightDriver（web_fetch headless 兜底 + browser headless/managed-profile）。
   * 由 router 从 bootstrap.browserDriverRegistry 注入；缺省 → web_fetch 跳过 headless、browser headless 报未注册。
   */
  browserDriverRegistry?: unknown;
  /**
   * LogWriter —— dev 调试日志（llm/tool hook 注入）。
   * 由 router 从 bootstrap.logWriter 注入；buildSessionConfigFromDeps 透传进 SessionConfig.logWriter，
   * llm 经 stage-llm/forked-agent 透传到 InvokeContext，tool 经 engine.executeOne 取用。
   * 缺省 undefined → 不写日志（开关 false 也早 return，零开销）。
   */
  logWriter?: unknown;
  /**
   * SessionMetaBroadcaster —— PUT /session/:id title 路径写完后直调 broadcast
   * （让前端列表实时刷新 title）。缺省 undefined → PUT title 不广播（旧测试可省）。
   * 与 unreadRuntime / AutoNamingService 共享同一实例（bootstrap 注入）。
   * 参考: specs/tech/agent/auto_naming/[P0]auto_naming_service.md §6（PUT title 协作）
   */
  metaBroadcaster?: SessionMetaBroadcaster;
  /**
   * AutoNamingService —— handleMessagesPost 内 fire-and-forget 触发 AI 起名。
   * 缺省 undefined → 不触发（旧测试可省）。参考 specs/tech/agent/auto_naming/
   */
  autoNamingService?: AutoNamingService;
  /**
   * cron 工具运行时依赖（cronStore + engine + sessionStore/squadStore 取 tz）。
   * 由 bootstrap 从 bootScheduler 产出透传到 SessionHandlerDeps；buildSessionConfigFromDeps 透传到
   * ctx.config.cronToolDeps（cron 工具读，action: create/list/update/disable/enable/delete）。
   * 缺省 undefined → cron 工具报 RUNTIME_ERROR（isError=true + [cron:*] reason）。
   * 类型用 unknown（鸭子类型；实际形状由 tools/cron/cron-tool-shared.ts CronToolDeps 定义，避免本文件耦合 scheduling 模块）。
   */
  cronToolDeps?: unknown;
  /**
   * [v0.0.126] history_search / history_get_context 工具运行时依赖（{ searchEngine, sessionStore }）。
   * 由 bootstrap 装配后透传；buildSessionConfigFromDeps 透传到 ctx.config.historyToolDeps（两工具读取）。
   * 缺省 undefined → 两工具报 RUNTIME_ERROR（isError=true + [history_*] reason）。
   * 类型用 unknown（鸭子类型；实际形状由 tools/history-search-tool.ts HistoryToolDeps 定义，避免本文件耦合 persistence 模块）。
   */
  historyToolDeps?: unknown;
  /**
   * [v0.0.223] TodoStore — session 级双层 todo 持久化（独立 store，仿 cron）。
   * 由 bootstrap 装配后透传；todo 工具经 rtc.sessionDeps.todoStore 读取
   * （todo session 级，主 item + 步骤，状态 free-form；todo_tools.md §4）。
   * 缺省 undefined → todo 工具报 runtime error（todoStore not injected）。
   * 类型用 unknown（鸭子类型；实际形状由 agent/todo/todo-store.ts TodoStore 定义，避免本文件耦合 todo 模块）。
   */
  todoStore?: unknown;
  /**
   * SessionTypePolicy — profile yaml 单源驱动工具解析。
   * 由 bootstrap 装配 SessionTypeProfileLoader + Validator 后注入（router.sessionDeps 透传 +
   * setResolveConfig 闭包 deps 直注）。
   * buildSessionConfigFromDeps 消费时必填（未注入 fail-fast）。
   */
  sessionTypePolicy?: SessionTypePolicy;
}

/** POST /session 请求体（specs/api §2.1） */
export interface CreateSessionBody {
  title?: string;
  providerId?: string;
  modelId?: string;
  /** 可选，caller 预建的工作目录（绝对路径，提供则校验后用；缺省自动建 <DATA_DIR>/workspaces/<sid>） */
  workspaceDir?: string;
}

/** PUT /session/:id 请求体（部分更新） */
export interface UpdateSessionBody {
  title?: string;
  providerId?: string;
  modelId?: string;
  /**
   * [v0.0.148] session 级 effort 推理强度（canonical 语义键，4 档）。
   * 非法 enum 值由 validateEffortApproval 校验返 400。
   */
  effort?: 'default' | 'low' | 'high' | 'max';
  /**
   * [v0.0.148] session 级审批模式（normal/greenlight）。
   * 非法 enum 值由 validateEffortApproval 校验返 400。
   * alwaysApprovedKeys 不进 body（仅 ApprovalManager 内部写，防客户端任意改写）。
   */
  approvalMode?: 'normal' | 'greenlight';
  /**
   * [v0.0.231] 会话置顶（true=置顶 / false=取消，部分更新语义未提供不覆盖）。
   * 提供但非 boolean → 400（validatePinned，同 validateEffortApproval 风格）。
   * 写后 handler 直调 metaBroadcaster.broadcast → session_meta 广播多端归位。
   * pinned-only 更新不推进 updatedAt（置顶是纯标记，用户裁决 2026-08-01）。
   * 不进 CreateSessionBody（新建无置顶语义）。
   */
  pinned?: boolean;
}

/** [v0.0.148] effort 合法档位集合（canonical 语义键） */
const EFFORT_LEVELS = ['default', 'low', 'high', 'max'] as const;
/** [v0.0.148] approvalMode 合法值集合 */
const APPROVAL_MODES = ['normal', 'greenlight'] as const;

/**
 * [v0.0.148] 校验 effort/approvalMode enum 值（闭合 enum，非法返错误 string）。
 * caller（PUT handler）收到非 null 返 400。undefined = 不改（放行，不校验）。
 * 对齐既有 validateProviderModel 风格（返 string | null，caller 转 400）。
 */
export function validateEffortApproval(body: UpdateSessionBody): string | null {
  if (
    body.effort !== undefined &&
    !EFFORT_LEVELS.includes(body.effort as (typeof EFFORT_LEVELS)[number])
  ) {
    return `invalid effort: ${body.effort}; must be one of ${EFFORT_LEVELS.join('/')}`;
  }
  if (
    body.approvalMode !== undefined &&
    !APPROVAL_MODES.includes(body.approvalMode as (typeof APPROVAL_MODES)[number])
  ) {
    return `invalid approvalMode: ${body.approvalMode}; must be one of ${APPROVAL_MODES.join('/')}`;
  }
  return null;
}

/**
 * [v0.0.231] 校验 pinned 类型（提供但非 boolean → 错误 string，caller 转 400）。
 * undefined = 不改（放行，部分更新语义）。同 validateEffortApproval 风格返 string | null。
 * fail-fast 防「client 传 'true' 字符串静默无效」。
 */
export function validatePinned(body: UpdateSessionBody): string | null {
  if (body.pinned !== undefined && typeof body.pinned !== 'boolean') {
    return `invalid pinned: ${String(body.pinned)}; must be a boolean`;
  }
  return null;
}

/**
 * 取全部启用的 provider 实例（过滤 _deleted tombstone，对齐 provider handler listProviders）。
 * session-messages.ts 复用此函数，故 export。
 */
export function listEnabledProviders(svc: AppConfigService): ProviderInstance[] {
  return svc
    .listGroup(PROVIDERS_GROUP)
    .map((r) => r.data as ProviderInstance)
    .filter(
      (p) =>
        p &&
        !(p as unknown as { _deleted?: boolean })._deleted &&
        p.enabled !== false,
    );
}

/** 校验 providerId 是否命中 app_config providers 组。export 供 session-messages 复用 */
export function findProvider(
  svc: AppConfigService,
  providerId: string,
): ProviderInstance | undefined {
  return listEnabledProviders(svc).find((p) => p.id === providerId);
}

/**
 * 校验 (providerId, modelId) 组合是否命中 app_config providers。
 * 三种合法形态：
 *   - 都不传（不改 model）
 *   - 只传 providerId：providerId 必须命中 enabled providers
 *   - 同时传 providerId + modelId：providerId 命中 + 该 provider 下有此 modelId
 * 保留字 'default'/'none'/'' 短路放行（不查 provider 命中）：
 *   caller（PUT handler）规范化为 'default' 落盘，resolve 链走 fallback（PRD 03 §2.2）。
 * 校验失败返回 Error（caller 转 400）。
 */
export function validateProviderModel(
  deps: SessionHandlerDeps,
  body: UpdateSessionBody,
): string | null {
  if (body.providerId === undefined && body.modelId === undefined) return null;
  // 保留字短路：modelId 是 default/none/空串 → 放行（不查 provider 命中）
  const reserved = isReservedModelId(body.modelId);
  if (reserved && body.providerId === undefined) return null;
  const providers = listEnabledProviders(deps.appConfig);
  // providerId 必填（任一存在时）；保留字 modelId 时若同时给 providerId 仍校验 providerId
  const pid = body.providerId;
  if (!pid) {
    if (reserved) return null; // 保留字 + 无 providerId → 放行
    return 'providerId required when modelId is provided';
  }
  const p = providers.find((it) => it.id === pid);
  if (!p) return `provider ${pid} not found`;
  if (
    body.modelId !== undefined &&
    !reserved &&
    !p.models.some((m) => m.modelId === body.modelId)
  ) {
    return `model ${body.modelId} not found in provider ${pid}`;
  }
  return null;
}
