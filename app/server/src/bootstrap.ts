/**
 * bootstrap — 经 BuiltinLoader 扫描 builtins/&#42;/plugin.json 登记内置 plugin + 扩展点
 * 参考: specs/api/overall/02-llm-chat.md §2.2（pluginId=llm_anthropic）
 *       specs/tech/plugin_system/[P0]builtin_plugins_directory.md §2/§3
 *       specs/tech/plugin_system/[P0]plugin_manager_interface.md §3.4
 *
 * 设计：
 *   - 扫描 plugin.json 登记而非硬编码程序化注册（避免 pluginId 双源不一致）。
 *   - 走 BuiltinLoader.loadAll 扫描 app/plugins/builtins/&#42;/plugin.json，
 *     impl 模块（provider.ts/protocol.ts re-export impl 类）
 *     由 loader 动态 import 取 default export 登记入 registry。
 *   - 注册内置扩展点（llm_provider / llm_protocol）。
 *   - 启动期构造 EventHub.singleton() + ReplayableEventBus(replayable:true) +
 *     registerTopic("agent_loop", bus)；构造 SessionStore（4 schema 委托 CrudStore）/
 *     ToolExecutionEngine / ContextEngine / AgentManager / SseChannel 注入 router。
 *   - 返回 Registry + PluginManager + 三域 config service + agent/sse 实例集合，
 *     供 router/handler 复用同一组实例。
 *
 * 注意：loadAll 为 async（动态 import impl 模块），故本函数为 async。
 * router 端 getBootstrap 用 Promise 缓存避免重复 await。
 */
import * as path from 'node:path';
import { mkdirSync } from 'node:fs';
// 类型 import（BootstrapResult interface 用；运行时实例由各 phase helper 构造返回）
import type {
  Registry,
  PluginManager,
  PluginConfigService,
  PluginPolicyStore,
} from './plugin';
import type { AppConfigService } from './config/app-config-service';
import type { EventHub, ReplayableEventBus } from './agent/event-hub';
import type { SessionStore } from './agent/session-store';
import type { SessionTaskLock } from './agent/session-task-lock';
import type { AppTaskLock } from './agent/app-task-lock';
import type { SseChannel } from './sse/sse-channel';
import type { ConnectorManager } from './tools/browser/connector-manager';
import type { ComputerNativePort } from './platform/computer/native-port';
import type { ChannelManager } from './channel/channel-manager';
import type { DriverRegistry } from './tools/browser/pick-driver';
import type { ContextEngine } from './agent/context-engine';
import type { AgentManagerImpl } from './agent/agent-manager';
import type { SessionTypePolicy } from './agent/session-type-policy';
import type { InboxStore } from './agent/inbox';
import type { SessionWorkspaceManager } from './agent/session-workspace-manager';
import type { SessionUnreadRuntime } from './agent/session-unread-runtime';
import type { SessionMetaBroadcaster } from './agent/session-meta-broadcaster';
import type { AutoNamingService } from './agent/auto-naming-service';
import type { ObservabilityManager } from './observability/index';
import type { MentionProviderRegistry } from './mention';
import type { SquadStore } from './stores/squad-store';
import type { SquadRuntime } from './squad/squad-runtime';
import type { BudgetAggregator } from './squad/budget/budget-aggregator';
// [v0.0.194] token 用量聚合查询
import type { TokenUsageAggregator } from './squad/token-usage/token-usage-aggregator';
import type { CronPersistenceAdapter } from './scheduling/persistence/cron-adapter';
import type { SchedulerEngine } from './scheduling/engine';
import type { ConsolidationPersistenceAdapter } from './scheduling/persistence/consolidation-adapter';
// [v0.0.223] TodoStore — session 级双层 todo 持久化（独立 store，仿 cron）
import type { TodoStore } from './agent/todo/todo-store';
import type { SearchEngine } from './persistence/search-engine';
import type { HistoryIndexer } from './persistence/history-indexer';
// [v0.0.210] Academy —— AcademyStore + TrainingEngine 装配
import type { AcademyStore } from './academy/academy-store';
import type { TrainingEngine } from './academy/training-engine';
// Value import（main 仍直接用）
import { LogWriter } from './dev-logs/log-writer';
import { setSlowQuerySink } from './persistence/slow-query';
import { setHangSink } from './observability/hang-sink';
import { MigrationManager } from './migration';
import { checkPromptContentAssets } from './prompts/prompt-handler';
import { bootstrapMentionRegistry } from './mention/bootstrap-mention';
// MemberStore — mentionRegistry 装配用（mention 走 MemberStore 注入）
import { MemberStore } from './stores/squad-store';
// Phase helpers（v0.0.156 拆分）
import { bootstrapPluginPhase } from './bootstrap-plugin-phase';
import { bootstrapBusPhase } from './bootstrap-bus-phase';
import { bootstrapStorePhase } from './bootstrap-store-phase';
import { bootstrapAgentPhase } from './bootstrap-agent-phase';
import { createLateBoundRefs } from './bootstrap-late-bound';
import { bootstrapSchedulerPhase } from './bootstrap-scheduler-phase';
import { bootstrapSearchPhase } from './bootstrap-search-phase';
import { bootstrapConnectorsPhase } from './bootstrap-connectors-phase';
// [v0.0.210] Academy —— TrainingEngine 构造 + LlmCaller→AcademyLlmPort adapter
import { TrainingEngine as TrainingEngineImpl } from './academy/training-engine';
import { createAcademyLlmPort } from './academy/llm-caller-adapter';
// [v0.0.223] TodoStore 实例化（独立 store，仿 CronPersistenceAdapter；fsRoot=dataDir 经 resolveDataDir 展开）
import { TodoStore as TodoStoreImpl } from './agent/todo/todo-store';

/** bootstrap 返回的共享实例集合（router/handler 全程复用） */
export interface BootstrapResult {
  registry: Registry;
  pluginManager: PluginManager;
  pluginConfigService: PluginConfigService;
  appConfig: AppConfigService;
  policyStore: PluginPolicyStore;
  // ── agent/sse 实例集合（router session/sse handler 注入） ──
  /** 全局单例事件路由表 */
  hub: EventHub;
  /** agent_loop topic 的 replayable bus（AgentManager emit/subscribe 用） */
  bus: ReplayableEventBus;
  /** session 持久化统一存储 */
  store: SessionStore;
  /** session 级 agent 管理器（enqueue/activate/subscribe） */
  agentManager: AgentManagerImpl;
  /** SessionTypePolicy — profile yaml 单源驱动工具解析（router.sessionDeps 透传给 debug 端点等） */
  sessionTypePolicy: SessionTypePolicy;
  /**
   * ContextEngine —— 手动 compact 端点（POST /session/:id/compact）需调
   * contextEngine.compact 执行路径（复用 forked agent + SessionTaskLock CAS）。
   * sideRunner 由 bootstrap 在 manager 创建后回写（见 setSideRunner）。
   */
  contextEngine: ContextEngine;
  /**
   * SessionTaskLock —— 统一 per-session × per-task 内存锁（subsumes summaryTask CAS）。
   * handler 经 router 透传读 lock.getState(sid,'compact') 判 409；contextEngine.compact 内部
   * acquire/markDone/markFailed。bootstrap 持单例注入各消费方。spec session_task_lock.md §1 §6。
   */
  taskLock: SessionTaskLock;
  /**
   * [v0.0.164] AppTaskLock —— app 级 × per-task 内存锁（tier2_consolidation 撞车保护）。
   * handler 经 router 透传：cron ConsolidationJobHandler.fire + POST /consolidation/run 手动触发
   * 共享该锁 acquire('tier2_consolidation', runId)；acquire 失败 = 别人正在跑 → 静默跳过（cron）/ 409（HTTP）。
   * bootstrap 持单例注入 agent-phase（setAppTaskBus）+ scheduler-phase（handler deps）+ router（handler deps）。
   * spec app_task_lock.md §1 §6。
   */
  appTaskLock: AppTaskLock;
  /** [v0.0.189] panorama topic bus（业务全景看板 SSE 广播；router 透传给 squad-routes + agent-phase rtc） */
  panoramaBus: ReplayableEventBus;
  /** SSE 桥后端对象（GET /sse / subscribe / unsubscribe） */
  sseChannel: SseChannel;
  /**
   * SessionWorkspaceManager —— workspace 文件 watch 生命周期（lazy，
   * SSE subscribe/unsubscribe 钩子触发启停）。router 透传给 session DELETE/PUT handler。
   */
  workspaceManager: SessionWorkspaceManager;
  /**
   * ConnectorManager —— 连接器运行时双状态机（switch intent + connection 实时态）。
   * browser tool mode=attach 经 session-config 注入；GET/PUT /config/connectors 经 router 注入。
   */
  connectorManager: ConnectorManager;
  /**
   * ComputerNativePort —— computer use 原生能力端口（screenshot 等 tool 经 session-config 注入直调）。
   * 三态：AT=mock / dev=loopback / packaged=registry 直调；非 electron/无通道 → undefined
   * （tool fail-closed 返「仅桌面 App 可用」）。去连接器语义（无 toggle/owner/connect）。
   */
  computerNativePort?: ComputerNativePort;
  /**
   * ChannelManager —— IM 渠道接入层管家（飞书等 IM 长连接 + binding + outbound 累积）。
   * 注入时机：agentManager + agent_loop bus 就绪后（connect fire-and-forget 不阻塞 server）。
   * GET/POST/PUT/DELETE /config/channels 经 router 注入；构造失败 → undefined（不阻塞 server）。
   * 参考: specs/tech/channel/[P0]channel_manager.md §4
   */
  channelManager?: ChannelManager;
  /**
   * BrowserDriverRegistry —— 含 PlaywrightDriver（web_fetch headless 兜底 +
   * browser tool headless/managed-profile）。attach 不走 registry（由 connectorManager 持 chromeDriver）。
   */
  browserDriverRegistry: DriverRegistry;
  /**
   * LogWriter —— dev 调试日志（4 开关各写一个 JSONL 文件）。
   * router api hook 经 bs.logWriter 取用；event hook 由 wrapBusWithLog proxy 内部持引用。
   */
  logWriter: LogWriter;
  /**
   * SquadRuntime —— squad scheduler 生命周期 glue（Map<squadId,SquadScheduler>
   * + boot 启 / shutdown 停 / SIGTERM trap）。handler 调 reloadSquad（PATCH /squad
   * heartbeatConfig/enableHeartBeat/budget/tz 变更实时刷 job）+ getScheduler(id).getHistory；
   * budget baseline-delta 接 BudgetAggregator。
   * 参考: specs/tech/squad/[P1]scheduler.md §9/§10
   */
  squadRuntime: SquadRuntime;
  /**
   * BudgetAggregator —— squad 级 budget 横向聚合（Display/Gate 分离）。
   * GET /squad/:id/budget/usage handler 经 router 注入调用 displayUsage（api §4）。
   */
  budgetAggregator: BudgetAggregator;
  /**
   * [v0.0.194] TokenUsageAggregator —— squad token 用量聚合查询（raw SQL GROUP BY SUM）。
   * GET /squad/:id/token-stats handler 经 router 注入调用 query（api 11c）。
   * sqlite 装配失败时 undefined → handler 返 503。
   */
  tokenUsageAggregator?: TokenUsageAggregator;
  /**
   * MentionProviderRegistry —— @ mention 搜索（FileProvider + SkillProvider）。
   * handler GET /mention/search 经 router 注入调用 search(providerName, ctx)。
   */
  mentionRegistry: MentionProviderRegistry;
  /**
   * SessionMetaBroadcaster —— PUT /session/:id title 路径 + AI 起名 CAS 应用后
   * 直调 broadcast（让前端列表实时刷新 title）。与 unreadRuntime / AutoNamingService 共享同一实例。
   */
  sessionMetaBroadcaster: SessionMetaBroadcaster;
  /**
   * AutoNamingService —— handleMessagesPost 内 fire-and-forget 触发 AI 起名。
   * 参考: specs/tech/agent/auto_naming/[P0]auto_naming_service.md
   */
  autoNamingService: AutoNamingService;
  /**
   * SquadStore（顶层共享句柄，无状态封装读 {root}/squads/*）。
   * cron handler / agent cron_* 工具取 squad.timezone fallback 时用（cron_subsystem §5）。
   * 与 setBuildAgentToolContext 内部 squadStoreForCtx 复用同一句柄。
   */
  squadStore: SquadStore;
  /**
   * [v0.0.223] TodoStore — session 级双层 todo 持久化（独立 store，仿 cron）。
   * router buildTodoRouteDeps 读此字段注入 handleTodoRoute；todo 工具经 rtc.sessionDeps.todoStore 读；
   * reminder provider 经 ReminderCtx.todoStore 读（todo_tools.md §4/§6）。
   * fsRoot=dataDir（resolveDataDir 已展开绝对路径，packaged cwd=/ 护栏）。
   */
  todoStore: TodoStore;
  /**
   * CronPersistenceAdapter — cron.json 持久化（session 级分片）。
   * 由 bootScheduler 装配；router buildCronRouteDeps 读此字段 + schedulerEngine
   * 注入 handleCronRoute；agent cron_* 工具经 session-config.cronToolDeps 读。
   */
  cronStore: CronPersistenceAdapter;
  /**
   * SchedulerEngine — 公共调度引擎进程单例（heartbeat + cron 共享）。
   * 由 bootScheduler 装配 + start + SIGTERM trap stop。
   */
  schedulerEngine: SchedulerEngine;
  /**
   * ConsolidationPersistenceAdapter —— consolidation/state.json 持久化（app 级单例，与
   * app_config.consolidation 用户配置分离存储）。由 bootScheduler 无条件装配（不依赖 enabled）；
   * router 层 test-only 端点（POST /test/consolidation/run）+ GET /consolidation/status 均经此
   * 实例读写 lastResult。
   */
  consolidationAdapter?: ConsolidationPersistenceAdapter;
  /**
   * CronToolDeps — agent cron_* 工具运行时依赖（cronStore + engine + sessionStore/squadStore）。
   * 由 bootScheduler 装配；router/handler 经 session-config 透传到 ctx.config.cronToolDeps。
   * 形态对齐 tools/cron/cron-tool-shared.ts CronToolDeps（鸭子类型 unknown 注入，避免本文件耦合 scheduling 模块）。
   */
  cronToolDeps: unknown;
  /**
   * [v0.0.126] SearchEngine — GET /history/search endpoint + history_search tool 共用检索引擎。
   * 持 SqlDriver（search.sqlite）+ titleResolver（SessionStore ref 取 session title）。
   * bootstrap 装配后注入 router.history-search handler；session-config 透传给 history_search tool。
   * 装配失败（search.sqlite 损坏）→ undefined（router 返 503，tool 报 RUNTIME_ERROR）。
   */
  searchEngine?: SearchEngine;
  /**
   * [v0.0.126] HistoryIndexer — search.sqlite 写入队列 + reconcile/rebuild 兜底。
   * bootstrap 装配后注入 search_indexing handler（EP delegate holder）+ onSessionDestroyed 链。
   * 装配失败 → undefined（search_indexing handler no-op）。
   */
  historyIndexer?: HistoryIndexer;
  /**
   * [v0.0.150] 迁移错误收集——MigrationManager.run() 跑各 handler 抛错（含 lock 冲突）
   * 时进此数组；前端 GET /bootstrap/status 拉取后渲染 modal 提示。空数组表示无错。
   * 不阻塞 bootstrap（即使有 errors 也继续启动）。
   */
  migrationErrors: Array<{ id: string; message: string; stack?: string }>;
  /**
   * [v0.0.210] AcademyStore —— academy 域 7 entity CrudStore facade。
   * manage-task / manage-classroom 工具经 agentToolContext 读取；handler 经 router 透传。
   */
  academyStore: AcademyStore;
  /**
   * [v0.0.210] TrainingEngine —— academy 训练引擎主入口（runTurn 状态机 + 生命周期委派）。
   * bootstrap 末尾 fire-and-forget 调 resumeOnStartup 断点续跑。
   */
  trainingEngine: TrainingEngine;
}

/**
 * 在指定 dataDir 下引导内置 plugin + 扩展点 + 三域 config service + agent/sse 装配。
 * 多次调用产出独立实例（每次 new Registry / new *Service）；EventHub 为进程级单例
 * （EventHub.singleton()），registerTopic 幂等覆盖（重复 bootstrap 安全）。
 *
 * 内置 plugin 目录相对 server/src 的位置：app/plugins/builtins。
 * `__dirname` 在编译后是 app/server/&#42;/，回退两级到 app/，再进 plugins/builtins。
 *
 * @param dataDir 数据根目录绝对路径
 */
export async function bootstrapBuiltinPlugins(dataDir: string): Promise<BootstrapResult> {
  // prompt content 打包完整性自检——仅 log，不中断启动（dev/test 下
  // CONTENT_DIR 解析到 src/prompts/content 且文件齐全，不会误报；packaged 若 build
  // 期资源复制缺失才会命中，此时显式 error log 暴露问题而非静默降级空 system prompt）。
  const promptAssetsCheck = checkPromptContentAssets();
  if (!promptAssetsCheck.ok) {
    console.error(
      `[bootstrap] prompt content assets missing (packaging/deploy broken): contentDirExists=${promptAssetsCheck.contentDirExists}, missing=${JSON.stringify(promptAssetsCheck.missing)}`,
    );
  }

  // Phase 1+2+3 装配（plugin registry + scope config + policy/config stores）。
  // 纯 move 到 bootstrap-plugin-phase.ts（v0.0.156 结构性拆分）。
  const { registry, pluginManager, pluginConfigService, appConfig, policyStore } =
    await bootstrapPluginPhase(dataDir);

  // [v0.0.150] MigrationManager —— 启动期数据迁移主控。
  //   位置：AppConfigService 之后、业务 store（MemberStore/SessionStore）之前，
  //   与旧 ad-hoc 迁移同位置替换（旧迁移已 task1 删除）。
  //   run() 内部 catch 所有错误（含 lock 冲突 + 各 handler 抛错）进 summary.errors，
  //   **不阻塞 bootstrap**——即使有 errors 也继续启动，errors 经 BootstrapResult.migrationErrors
  //   透传给 GET /bootstrap/status 端点供前端展示。
  //   dataDir 由调用方走 resolveDataDir 解析（packaged cwd=/ 安全）。
  const migrationSummary = await new MigrationManager({ dataDir, appConfig }).run();
  const migrationErrors = migrationSummary.errors;

  // MentionProviderRegistry —— @ mention 搜索（FileProvider + SkillProvider + MemberProvider[MemberStore]）。
  // 详见 bootstrap-mention.ts。
  // store 实例化需早于 mention 注册——此处 MemberStore 与
  // setBuildAgentToolContext 闭包内句柄同根（root=dataDir），无状态封装可重复 new 共享。
  const memberStoreForMention = new MemberStore({ root: dataDir });
  const mentionRegistry = bootstrapMentionRegistry(
    dataDir,
    appConfig,
    memberStoreForMention,
  );

  // LogWriter —— dev 调试日志（spec dev-logs §2.5 装配点）。
  // 模块级单例：进程内缓存 dataDir + appConfig；ensure logs 目录（mkdir recursive）。
  // hook 注入路径：event hook（wrapBusWithLog 闭包持引用）+ api hook（router 取 bs.logWriter）
  // + llm/tool hook（session-config 装配进 SessionConfig）。
  const logWriter = new LogWriter(dataDir, appConfig);

  // 慢查询性能日志：persistence 底座只暴露 sink 注册点（不反向依赖 dev-logs，
  // 依赖方向保持 上层→底座），此处注入 LogWriter 适配。FsCrudStore/SqliteCrudStore 的
  // query 超 SLOW_QUERY_MS 即经此上报；开关 logs.enablePerformanceLog 门禁在
  // LogWriter.write 内部（false = 零开销早 return），UI 改开关下次 write 即生效。
  setSlowQuerySink((info) => logWriter.write('performance', info));

  // 卡顿 episode 性能日志：同上范式，event-loop-monitor tick() 超阈值/恢复 → 上报 kind:'hang'。
  setHangSink((record) => logWriter.write('performance', record));

  // [dev-logs] 全局 error 兜底：未捕获的 Promise rejection → logs/error.log
  // （受 logs.enableErrorLog 开关控制；只记录不改退出语义，uncaughtException 保持默认崩溃不吞）
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logWriter.write('error', {
      source: 'unhandledRejection',
      message: msg,
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    console.error('[unhandledRejection]', reason);
  });

  // ── agent/sse 装配 ──

  // Phase 6 装配（EventHub + ReplayableEventBus + SseChannel + SSE test interceptor）。
  // 纯 move 到 bootstrap-bus-phase.ts（v0.0.156 结构性拆分）。
  const { hub, bus, sessionStatusBus, sessionMetaBus, appTaskBus, panoramaBus, sseChannel } =
    await bootstrapBusPhase(logWriter);

  // workdir=<DATA_DIR>/workspace（启动期建；handler 也会幂等 mkdir 防外部删）
  const workdir = path.join(dataDir, 'workspace');
  try {
    mkdirSync(workdir, { recursive: true });
  } catch {
    // 忽略：已存在或权限（运行时再报）
  }

  // [v0.0.223] TodoStore — session 级双层 todo 持久化（独立 store，仿 cron）。
  // fsRoot=dataDir（resolveDataDir 已展开绝对路径，packaged cwd=/ 护栏，todo_tools.md §4）。
  // 无依赖可早建；setTodoStore 注入 contextEngine 在 agent-phase 产出 contextEngine 之后。
  // 注入 wrap 前 raw sessionStatusBus（bus-phase 产出，时序先于 store-phase 的
  // wrapStatusBusForUnread）——session_todo_changed 天然不过 broadcaster/unreadRuntime，
  // 不触发 session_meta broadcast（session_event.md §3a.4）。
  const todoStore = new TodoStoreImpl({ fsRoot: dataDir, statusBus: sessionStatusBus });

  // Phase 7 装配（SessionStore + SessionUnreadRuntime + SessionMetaBroadcaster + SessionTaskLock + AcademyStore）。
  // 纯 move 到 bootstrap-store-phase.ts（v0.0.156 结构性拆分）。
  // 关键时序（INV-C-1）：reconcileOnStartup 必须在 unreadRuntime.start 前——reconcile 期间
  // enabled=false 挡住 emit 不产未读（spec 不变量 4）。
  const { store, unreadRuntime, sessionMetaBroadcaster, taskLock, appTaskLock, tokenUsageAggregator, academyStore } =
    await bootstrapStorePhase(dataDir, sessionStatusBus, sessionMetaBus, sseChannel, logWriter);

  // Phase 8 装配（ToolEngine + ContextEngine + AgentManager + 三个 runner 注入）。
  // 纯 move 到 bootstrap-agent-phase.ts（v0.0.156 结构性拆分）。
  // lateBound = 前向引用 holder 集合（connectorManager/browserDriverRegistry/computerNativePort/
  // searchEngine/workspaceManager/cronToolDeps 在后续 phase 填充；lambdas 在 agent activate 时读 .value）。
  const lateBound = createLateBoundRefs();
  // [v0.0.210] lateBound.academyStore 立即填充（store-phase 已产出，agent-phase lambdas activate 时读取）
  lateBound.academyStore.value = academyStore;
  const {
    agentManager, contextEngine, inbox, observabilityManager, toolEngine, toolDefinitions,
    squadStoreForCtx, sessionTypePolicy,
  } = await bootstrapAgentPhase({
    dataDir, workdir, store, bus, pluginManager, appConfig, logWriter,
    sessionStatusBus, taskLock, appTaskLock, appTaskBus, panoramaBus, lateBound,
    // [v0.0.223] todoStore（先于 agent-phase 创建，直接传参注入 rtc.sessionDeps.todoStore）
    todoStore,
  });
  // [v0.0.223] TodoStore 注入 reminder 链（TodoReminderProvider 经 ctx.todoStore 读 session todo 进度）
  contextEngine.setTodoStore(todoStore);

  // Phase 9 装配（SquadRuntime + BudgetAggregator + SchedulerEngine + bootScheduler）。
  // 纯 move 到 bootstrap-scheduler-phase.ts（v0.0.156 结构性拆分）。
  // 关键时序：cronToolDeps 在 bootScheduler 完成后才产出，后置填入 lateBound.cronToolDeps.value。
  const schedulerResult = await bootstrapSchedulerPhase({
    dataDir, store, agentManager, appConfig, pluginManager, appTaskLock,
  });
  lateBound.cronToolDeps.value = schedulerResult.cronToolDeps;

  // Phase 11 装配（SearchEngine + HistoryIndexer + WorkspaceManager）。
  // 纯 move 到 bootstrap-search-phase.ts（v0.0.156 结构性拆分）。
  // search.sqlite 装配失败不阻塞 server 启动（返 undefined）。
  const searchResult = await bootstrapSearchPhase({
    dataDir, store, sessionStatusBus, sseChannel,
  });
  if (searchResult.searchEngine) lateBound.searchEngine.value = searchResult.searchEngine;
  if (searchResult.workspaceManager) lateBound.workspaceManager.value = searchResult.workspaceManager;

  // Phase 10 装配（ConnectorManager + ComputerNativePort + ChannelManager + BrowserDriverRegistry + AutoNaming）。
  // 纯 move 到 bootstrap-connectors-phase.ts（v0.0.156 结构性拆分）。
  // computerNativePort 三态 precedence：AT env-mock > dev-loopback > packaged registry（降级 undefined）。
  const connectorsResult = await bootstrapConnectorsPhase({
    dataDir, agentManager, store, registry, pluginManager,
    sessionMetaBroadcaster, observabilityManager,
  });
  lateBound.connectorManager.value = connectorsResult.connectorManager;
  lateBound.browserDriverRegistry.value = connectorsResult.browserDriverRegistry;
  if (connectorsResult.computerNativePort) {
    lateBound.computerNativePort.value = connectorsResult.computerNativePort;
  }

  // [v0.0.210] TrainingEngine 装配（academy 训练引擎）。
  // 依赖 agentManager（deliverTo 推事件）+ academyStore（持久化）+ taskLock（per-task 锁）+
  //   AcademyLlmPort（LlmCaller→窄端口 adapter；E 节偏离：替代 spec 的 llmCaller 直绑）。
  // 装配时机：agentManager 就绪之后、return 之前；dataDir 已 resolveDataDir 展开（PACKAGED-GUARD-2）。
  const academyLlmPort = createAcademyLlmPort({ appConfig, pluginManager });
  const trainingEngine = new TrainingEngineImpl({
    academyStore,
    llmPort: academyLlmPort,
    sessionTaskLock: taskLock,
    deliverTo: (sessionId, message) => agentManager.deliverTo(sessionId, message),
    dataDir,
  });
  // [v0.0.210] lateBound.trainingEngine 填充（agent-phase lambdas activate 时读取）
  lateBound.trainingEngine.value = trainingEngine;
  // 断点续跑（spec training_engine §6）：扫 status=running 的 task 恢复。
  // fire-and-forget 不阻塞 bootstrap.listen；失败 fail-silent（引擎内 catch 兜底）。
  void trainingEngine.resumeOnStartup().catch((e) => {
    console.warn('[bootstrap] trainingEngine.resumeOnStartup failed (non-blocking):', e);
  });

  return {
    registry,
    pluginManager,
    pluginConfigService,
    appConfig,
    policyStore,
    hub,
    bus,
    store,
    agentManager,
    sessionTypePolicy,
    contextEngine,
    // SessionTaskLock 单例（router 透传给 session handler）
    taskLock,
    // [v0.0.164] AppTaskLock 单例（router 透传给 consolidation-run handler + cron handler）
    appTaskLock,
    panoramaBus,
    sseChannel,
    workspaceManager: searchResult.workspaceManager,
    connectorManager: connectorsResult.connectorManager,
    ...(connectorsResult.computerNativePort ? { computerNativePort: connectorsResult.computerNativePort } : {}),
    // ChannelManager（可选：构造失败 → undefined）
    ...(connectorsResult.channelManager ? { channelManager: connectorsResult.channelManager } : {}),
    browserDriverRegistry: connectorsResult.browserDriverRegistry,
    logWriter,
    squadRuntime: schedulerResult.squadRuntime,
    budgetAggregator: schedulerResult.budgetAggregator,
    // [v0.0.194] token 用量聚合（sqlite 装配失败时 undefined → handler 返 503）
    ...(tokenUsageAggregator ? { tokenUsageAggregator } : {}),
    mentionRegistry,
    // AI 起名 + meta 广播
    sessionMetaBroadcaster,
    autoNamingService: connectorsResult.autoNamingService,
    // squadStore 顶层共享（cron handler 取 squad.timezone fallback 用）；
    // 与 setBuildAgentToolContext 闭包外预建的 squadStoreForCtx 复用同一句柄。
    squadStore: squadStoreForCtx,
    // [v0.0.223] TodoStore（router buildTodoRouteDeps 读注入 handleTodoRoute；
    // todo 工具经 rtc.sessionDeps.todoStore 读；reminder 经 ctx.todoStore 读）
    todoStore,
    // cronStore + schedulerEngine + cronToolDeps 由 bootScheduler 装配（two-phase init）；
    // router buildCronRouteDeps 读 cronStore + schedulerEngine 注入 handleCronRoute；
    // session-config 透传 cronToolDeps 到 ctx.config.cronToolDeps（agent cron_* 工具读）。
    cronStore: schedulerResult.cronStore,
    schedulerEngine: schedulerResult.schedulerEngine,
    cronToolDeps: schedulerResult.cronToolDeps,
    // 装配失败/字段缺省时为 undefined（理论上 dataDir 恒有效，此实例应恒可用；
    // 沿用 searchEngine 的可选透传范式防御性处理）
    ...(schedulerResult.consolidationAdapter
      ? { consolidationAdapter: schedulerResult.consolidationAdapter }
      : {}),
    // [v0.0.126] history_search：装配失败时为 undefined（router endpoint 返 500，tool no-op）
    ...(searchResult.searchEngine ? { searchEngine: searchResult.searchEngine } : {}),
    ...(searchResult.historyIndexer ? { historyIndexer: searchResult.historyIndexer } : {}),
    // [v0.0.150] 迁移错误收集（空数组表示无错；GET /bootstrap/status 透传给前端）
    migrationErrors,
    // [v0.0.210] AcademyStore + TrainingEngine（manage-task/manage-classroom 工具经 rtc 读取）
    academyStore,
    trainingEngine,
  };
}

/** session_panel topic group 形如 `session_id:<sid>`，提取 sid（spec §3 group 约定） */
function extractSessionIdFromGroup(group: string): string | null {
  const prefix = 'session_id:';
  if (!group.startsWith(prefix)) return null;
  const sid = group.slice(prefix.length);
  return sid.length > 0 ? sid : null;
}

// 模块级标记位（避免 shutdown hook 重复挂载）
declare global {
  // eslint-disable-next-line no-var
  var __workspaceManagerShutdownHookRegistered: boolean | undefined;
  // eslint-disable-next-line no-var
  var __channelManagerShutdownHookRegistered: boolean | undefined;
}
