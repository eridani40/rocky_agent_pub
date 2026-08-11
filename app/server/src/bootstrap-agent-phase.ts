/**
 * bootstrap-agent-phase — Phase 8 装配：ToolEngine + ContextEngine + AgentManager + 三个 runner 注入
 *
 * 装配顺序（INV-C-1 严格保留）：ToolEngine → approvalManager.setStore → ContextEngine + setTaskLock →
 * InboxStore + ObservabilityManager + AgentManagerImpl → setResolveConfig（**必须在 agentManager 创建后**，
 * 后置注入打破循环引用）→ setBuildAgentToolContext → upsertExplorerTemplate → setSideRunner
 * （compact 入口；runKind=summary + maxIter=1 + 零工具）→ setConsolidateRunner → setSquadReminderDeps。
 *
 * lateBound 前向引用（INV-C-1 关键）：cronToolDeps（scheduler-phase）/ connectorManager、
 * browserDriverRegistry、computerNativePort（connectors-phase）/ searchEngine（search-phase）/
 * workspaceManager（main）—— lambdas 在 agent activate 时读 lateBound.X.value（那时所有 phase 已完成）。
 *
 * packaged 护栏（INV-PKG-1/2）：不读 process.env；不拼接相对路径。
 */
import type { ReplayableEventBus } from './agent/event-hub';
import type { SessionStore } from './agent/session-store';
import type { SessionTaskLock } from './agent/session-task-lock';
import type { AppTaskLock } from './agent/app-task-lock';
import type { PluginManager } from './plugin';
import type { AppConfigService } from './config/app-config-service';
import type { LogWriter } from './dev-logs/log-writer';
import type { ConnectorManager } from './tools/browser/connector-manager';
import type { DriverRegistry } from './tools/browser/pick-driver';
import type { ComputerNativePort } from './platform/computer/native-port';
import type { SearchEngine } from './persistence/search-engine';
import type { SessionWorkspaceManager } from './agent/session-workspace-manager';
import type { Message } from './message/types';
import type { LateBoundRefs } from './bootstrap-late-bound';
import { ContextEngine } from './agent/context-engine';
import { AgentManagerImpl } from './agent/agent-manager';
import { InboxStore } from './agent/inbox';
import { ToolExecutionEngine } from './tools/engine';
import { defaultToolDefinitions } from './tools/registry';
import { approvalManager } from './tools/approval-manager';
// [v0.0.307] worker pool 单例（白名单纯 IO 工具执行挪线程）
import { createToolWorkerPool, _resetToolWorkerPoolSingleton } from './tools/worker-pool';
import type { ToolWorkerPool } from './tools/worker-pool';
import { makeLoadTemplate, upsertExplorerTemplate } from './agent/tools/template-store';
import { SquadStore, MemberStore } from './stores/squad-store';
import {
  createObservabilityManager,
  type ObservabilityConfigItem,
} from './observability/index';
import { buildSessionConfigFromDeps, type StudioSessionContext } from './handlers/session-config';
import { SessionKind, isStudioMainSession } from '@app/shared';
// [v0.0.210] academyContext 装配（academy mapper 数据源；每轮 prompt 组装走 resolveConfig 现拉）
import { AcademyStore } from './academy/academy-store';
import { buildAcademyContext, isAcademySessionKind, type AcademyContextShape } from './academy/academy-context';
// SessionTypeProfileLoader + Validator + Policy 注入（profile yaml 单源驱动）
import { SessionTypeProfileLoader } from './agent/session-type-profile-loader';
import { SessionTypeProfileValidator } from './agent/session-type-profile-validator';
import { SessionTypePolicyImpl, type SessionTypePolicy } from './agent/session-type-policy';
import { defaultTools } from './tools/registry';
// [v0.0.223] TodoStore（注入 rtc.sessionDeps.todoStore，todo 工具读；bootstrap.ts 已先于 agent-phase 创建直接传参）
import type { TodoStore } from './agent/todo/todo-store';
import * as path from 'node:path';

/**
 * Phase 8 装配：ToolEngine + ContextEngine + AgentManager + 三个 runner 注入。
 */
export async function bootstrapAgentPhase(deps: {
  dataDir: string;
  workdir: string;
  store: SessionStore;
  bus: ReplayableEventBus;
  pluginManager: PluginManager;
  appConfig: AppConfigService;
  logWriter: LogWriter;
  sessionStatusBus: ReplayableEventBus;
  taskLock: SessionTaskLock;
  appTaskLock: AppTaskLock;
  appTaskBus: ReplayableEventBus;
  /** panorama topic bus（注入 rtc.panoramaBus，panorama 工具写后 emit SSE） */
  panoramaBus: ReplayableEventBus;
  lateBound: LateBoundRefs;
  /**
   * [v0.0.223] TodoStore（session 级双层 todo 持久化）。bootstrap.ts 已先于 agent-phase 创建，
   * 直接传参（非 lateBound）——注入 rtc.sessionDeps.todoStore，todo 工具读（todo_tools.md §4）。
   */
  todoStore: TodoStore;
}): Promise<{
  agentManager: AgentManagerImpl;
  contextEngine: ContextEngine;
  inbox: InboxStore;
  observabilityManager: ReturnType<typeof createObservabilityManager>;
  toolEngine: ToolExecutionEngine;
  toolDefinitions: ReturnType<typeof defaultToolDefinitions>;
  squadStoreForCtx: SquadStore;
  sessionTypePolicy: SessionTypePolicy;
}> {
  const { dataDir, workdir, store, bus, pluginManager, appConfig, logWriter, sessionStatusBus, taskLock, appTaskLock, appTaskBus, panoramaBus, lateBound, todoStore } = deps;

  // 工具：engine + defaultToolDefinitions（workdir）；definitions 供 assemble → snapshot.tools 用。
  // SessionConfig.tools（defaultTools(workdir)）由 session-messages handler 在 POST messages 时构造。
  // [v0.0.307] worker pool 单例注入：白名单纯 IO 工具（read/write/edit/glob/grep/skill）执行挪线程。
  //   try-catch 降级：createToolWorkerPool 抛错 → 不传 workerPool，工具仍主线程跑（向后兼容）。
  //   MUST 只装配一次（进程级单池，createToolWorkerPool 内部缓存）。
  let workerPool: ToolWorkerPool | undefined;
  try {
    _resetToolWorkerPoolSingleton(); // 确保每次 bootstrap 从干净状态开始（防热重载残留旧池）
    workerPool = createToolWorkerPool();
  } catch {
    // 降级：worker 创建失败 → engine 不传 workerPool，全部走主线程原路径
    workerPool = undefined;
  }
  const toolEngine = new ToolExecutionEngine(undefined, workerPool);
  const toolDefinitions = defaultToolDefinitions(workdir);

  // SessionTypePolicy 装配（profile yaml 单源驱动工具解析）
  //   loader 扫 app/plugins/session-types/*.yaml → id 索引；validator 校验 toolBound 引用已注册工具；
  //   policy 注入 SessionHandlerDeps + buildSessionConfigFromDeps 替代旧 resolveTools 查表。
  //   失败硬抛（启动期 misconfig 暴露）：基座缺失 / yaml 解析错 / toolBound 幽灵名。
  //   打包护栏：路径用 __dirname 解析（CJS dist/ → ../../plugins/session-types/，同 scopesDir 模式）
  const sessionTypesDir = path.resolve(__dirname, '../../plugins/session-types');
  const allToolsForPolicy = defaultTools(workdir);
  const allToolDefsForPolicy = allToolsForPolicy.map((t) => t.definition);
  const profileLoader = new SessionTypeProfileLoader(sessionTypesDir);
  profileLoader.loadAll();
  new SessionTypeProfileValidator({
    loader: profileLoader,
    registered: { names: new Set(allToolDefsForPolicy.map((d) => d.name)) },
  }).validateAll();
  const sessionTypePolicy: SessionTypePolicy = new SessionTypePolicyImpl({
    loader: profileLoader,
    allTools: allToolsForPolicy,
    allToolDefinitions: allToolDefsForPolicy,
  });
  // 注入 profileLoader 到 SessionStore——createSession enabled 门用（STP §8）。
  //   post-inject（store 在 bootstrap-store-phase 早建，profileLoader 在本 phase 建）；门仅在
  //   derivation='parent' 时走，未启用类型可不建 profile yaml 文件。
  store.sessionTypeProfileLoader = profileLoader;
  // ApprovalManager 持久化装配：SessionStore 就绪后注入 ApprovalStorePort。
  // 单例 approvalManager 与 toolEngine 共用；cache-through（isApproved cache miss 读 store）。
  approvalManager.setStore(store);

  // ContextEngine + AgentManager（注入 bus/store/contextEngine/toolEngine/definitions）
  // ContextEngine 注入 pluginManager（context ordered 链）+ appConfig（maxOutputTokens 预算）。
  // compact 是纯生产者，不 emit 任何 message 序列到 bus。
  const contextEngine = new ContextEngine({ store, pluginManager, appConfig });
  contextEngine.setTaskLock(taskLock); // compact 互斥统一锁 subsumes summaryTask CAS
  // SessionTaskLock 注入 session_panel bus：CAS 状态变更后 emit summary_task_update（前端 spinner 信号）。
  // 必须在 registerTopic(SESSION_PANEL_TOPIC) 之后调（bus-phase 已 register），用同一 sessionStatusBus 实例。
  taskLock.setSessionPanelBus(sessionStatusBus);
  // AppTaskLock 注入 app_task bus：CAS 状态变更后 emit consolidation_task_update
  //   到 (app_task, _all) 广播 group（前端设置页按钮态信号）。
  //   同 SessionTaskLock 后置注入模式；必须在 bus-phase.registerTopic(APP_TASK_TOPIC) 之后调。
  appTaskLock.setAppTaskBus(appTaskBus);
  const inbox = new InboxStore(logWriter);
  // ObservabilityManager：app_config.runtime.observability 列表驱动（无 ENV 兜底）；
  // 不热更新（用户改列表 → 重启进程 / 下个 session 生效）。
  const observabilityManager = createObservabilityManager(
    appConfig.get('runtime', 'observability') as
      | ObservabilityConfigItem[]
      | undefined,
  );
  const agentManager = new AgentManagerImpl({
    bus,
    store,
    inbox,
    contextEngine,
    toolEngine,
    observability: observabilityManager,
    // sideRun 内部派生 allowedTools/maxIter（policy 单源；caller 不透传）
    sessionTypePolicy,
  });
  // 后置注入 resolveConfig + buildAgentToolContext（打破循环引用：manager 变量定义时引用自身）。
  // resolveConfig：deliverTo/spawn 按 sessionId 构造 SessionConfig（不碰 config 透传），
  // 内部调 buildSessionConfigFromDeps（与 POST /messages 同路径）+ store.getSession 取持久字段。
  agentManager.setResolveConfig(async (sessionId) => {
    const session = await store.getSession(sessionId);
    if (!session) throw new Error(`resolveConfig: session not found: ${sessionId}`);
    // slim SessionKind（身份 4 字段；实例 ID 拆 SessionContext）
    const kind = new SessionKind({
      biz: session.biz ?? 'playground',
      role: session.role ?? 'rocky',
      // derivation 归一：非 subagent 即 parent
      derivation: session.derivation === 'subagent' ? 'subagent' : 'parent',
    });
    // 实例 ID 投影 SessionContext（与 kind 同构造点产出）
    const sessionContext = {
      ...(session.squadId !== undefined ? { squadId: session.squadId } : {}),
      ...(session.memberId !== undefined ? { memberId: session.memberId } : {}),
      ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
      // [v0.0.210] academy 4 实例字段投影（SessionRecord 持久化 → SessionContext；mapper 读 classroomId/trainingTaskId）
      ...(session.academyClassroomId !== undefined ? { classroomId: session.academyClassroomId } : {}),
      ...(session.academyStudentId !== undefined ? { studentId: session.academyStudentId } : {}),
      ...(session.academyVersionId !== undefined ? { versionId: session.academyVersionId } : {}),
      ...(session.academyTrainingTaskId !== undefined ? { trainingTaskId: session.academyTrainingTaskId } : {}),
    };
    // studio session（由 isStudioMainSession 判定）。subagent 走 subAgentConfig 分支不注入。
    let studioContext: StudioSessionContext | undefined;
    if (isStudioMainSession(kind)) {
      const squadStore = new SquadStore({ root: dataDir });
      const memberStore = new MemberStore({ root: dataDir });
      const squad = session.squadId ? await squadStore.getSquad(session.squadId) : undefined;
      const members = session.squadId ? await memberStore.listMembers(session.squadId) : [];
      const member = session.squadId && session.memberId
        ? await memberStore.getMember(session.squadId, session.memberId)
        : undefined;
      studioContext = {
        role: kind.role as 'squad' | 'leader' | 'mate',
        squadId: session.squadId!,
        ...(session.memberId !== undefined ? { memberId: session.memberId } : {}),
        ...(squad !== undefined ? { squad } : {}),
        ...(member !== undefined ? { member } : {}),
        ...(members.length > 0 ? { members } : {}),
      };
    }
    // [v0.0.210] academy session：装配 academyContext（5 academy mapper 数据源）。
    //   照 studioContext 块模式——每轮 prompt 组装都走此回调 = 正确频率（task/turn 每轮变必须现拉最新）。
    //   非 academy → undefined 不注入；实体查询失败 → 字段级 undefined（不阻塞 prompt 组装）。
    let academyContext: AcademyContextShape | undefined;
    if (isAcademySessionKind(kind)) {
      // lateBound.academyStore 由 store-phase 填充（INV-C-1：activate 时已填充）；
      //   缺省兜底现实例化（无状态 facade，同 SquadStore 模式）。
      const academyStore = lateBound.academyStore.value ?? new AcademyStore({ root: dataDir });
      academyContext = await buildAcademyContext({ academyStore, kind, sessionContext });
    }
    // lateBound 读取（前向引用 holder）：connectorManager/browserDriverRegistry/computerNativePort/
    // searchEngine 在后续 phase 填充；agent activate 时（lambda 真正执行）一定已填充。
    const connectorManager = lateBound.connectorManager.value;
    const browserDriverRegistry = lateBound.browserDriverRegistry.value;
    const browserInstanceManager = lateBound.browserInstanceManager.value;
    const computerNativePort = lateBound.computerNativePort.value;
    const searchEngine = lateBound.searchEngine.value;
    return buildSessionConfigFromDeps(
      {
        store, agentManager: undefined as unknown as AgentManagerImpl,
        appConfig, pluginManager, contextEngine, dataDir,
        ...(connectorManager ? { connectorManager } : {}),
        ...(browserDriverRegistry ? { browserDriverRegistry } : {}),
        // [v0.0.264] browserInstanceManager → ctx.config.browserInstanceManager（browser 非 attach 前置校验）
        ...(browserInstanceManager ? { browserInstanceManager } : {}),
        // computerNativePort 必须在此 resolveConfig 通路透传（screenshot tool 依赖）。
        ...(computerNativePort ? { computerNativePort } : {}),
        logWriter,
        // cronToolDeps 透传到 ctx.config.cronToolDeps（cron_* 工具读）；bootScheduler 完成后填充。
        cronToolDeps: lateBound.cronToolDeps.value,
        // historyToolDeps 透传到 ctx.config.historyToolDeps（history_* 工具读）。
        ...(searchEngine ? { historyToolDeps: { searchEngine, sessionStore: store } } : {}),
        // SessionTypePolicy 经 deps 注入（profile yaml 单源驱动；buildSessionConfigFromDeps 必填）
        sessionTypePolicy,
      },
      sessionId,
      {
        providerId: session.providerId,
        modelId: session.modelId,
        effort: session.effort, // effort + approvalMode 透传（源头唯一 = session record）
        approvalMode: session.approvalMode,
      },
      kind, // pos 4：SessionKind 必传
      session.workspaceDir,
      // scope 从 derivation 派生：subagent → 'subagent'；其余 → 'session'
      session.derivation === 'subagent' ? 'subagent' : 'session',
      // subagent 派生配置（spawn 时 eff 持久化；覆盖默认 systemPrompt/tools/maxIter）
      session.subAgentConfig,
      studioContext, // studio 分支配置（与 subAgentConfig 互斥）
      // SessionContext（实例 ID）
      sessionContext,
      // [v0.0.210] academyContext（academy mapper 数据源；非 academy → undefined）
      academyContext,
      // academy classroom 默认 model 透传（resolver academy 三档链第二档）。
      //   复用 academyContext 已拉 classroom（MUST NOT 再调 academyStore.getClassroom）；
      //   defaultModel 是 json 字段，运行时形状 = {providerId?, modelId}（与创建链 AcademyModelRef 同形）。
      academyContext?.classroom?.defaultModel as
        | { providerId?: string; modelId: string }
        | undefined,
    );
  });
  // buildAgentToolContext：agent 工具运行时上下文（spawn/query/abort + send_message）。
  // 注入 loadTemplate（spawn templateRef）+ squadStore/memberStore 句柄（send_message squad clique
  // 校验 + 别名解析 + team 工具）。句柄闭包外预建共享（无状态封装）。
  const subAgentLoadTemplate = makeLoadTemplate(appConfig);
  const squadStoreForCtx = new SquadStore({ root: dataDir });
  const memberStoreForCtx = new MemberStore({ root: dataDir });
  agentManager.setBuildAgentToolContext(async (sessionId, runId) => {
    const session = await store.getSession(sessionId);
    // parentSessionId 必须取 session.parentSessionId ?? sessionId，
    // 不是直接用运行 session 的 sid。否则 subagent 调 send_message(target='parent') 时
    // resolveAgentRef('parent', rtc.parentSessionId) 解析成 subagent 自己 → 消息投递回自身，
    // parent transcript 永远收不到 a2a 回报。
    // 语义：rtc.parentSessionId = 运行 session 的「父 session」——
    //   - 顶层 parent session（无 parentSessionId）→ fallback 自身 sid
    //   - subagent session（有 parentSessionId）→ 取 parent sid（send_message('parent') 路由到真 parent）
    // parentSessionId 必须取 session.parentSessionId ?? sessionId（非运行 sid）。
    // 否则 subagent 调 send_message('parent') 时 resolveAgentRef 解析成 subagent 自己 → 消息回自身。
    // 顶层 parent → fallback 自身 sid；subagent → 取 parent sid（send_message('parent') 路由到真 parent）。
    const parentSid = session?.parentSessionId ?? sessionId;
    const deriveType = (s: typeof session): string | undefined => {
      if (!s) return undefined;
      if (s.derivation === 'subagent') return 'subagent';
      return s.role ?? undefined;
    };
    // slim SessionKind（身份 4 字段）+ SessionContext（实例 ID）注入 rtc，
    // 工具改读 rtc.kind/sessionContext 做 caller 校验。
    const rtcKind = session
      ? new SessionKind({
          biz: session.biz ?? 'playground',
          role: session.role ?? 'rocky',
          derivation: session.derivation === 'subagent' ? 'subagent' : 'parent',
        })
      : undefined;
    const rtcSessionContext = session
      ? {
          ...(session.squadId !== undefined ? { squadId: session.squadId } : {}),
          ...(session.memberId !== undefined ? { memberId: session.memberId } : {}),
          ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}),
          // [v0.0.210] academy 4 字段（manage-task/manage-classroom 工具读 rtc.sessionContext.classroomId 等）
          ...(session.academyClassroomId !== undefined ? { classroomId: session.academyClassroomId } : {}),
          ...(session.academyStudentId !== undefined ? { studentId: session.academyStudentId } : {}),
          ...(session.academyVersionId !== undefined ? { versionId: session.academyVersionId } : {}),
          ...(session.academyTrainingTaskId !== undefined ? { trainingTaskId: session.academyTrainingTaskId } : {}),
        }
      : undefined;
    // lateBound 读取（前向引用 holder）：在后续 phase 填充；agent activate 时一定已填充。
    const workspaceManager = lateBound.workspaceManager.value;
    const connectorManager = lateBound.connectorManager.value;
    const browserDriverRegistry = lateBound.browserDriverRegistry.value;
    const browserInstanceManager = lateBound.browserInstanceManager.value;
    const searchEngine = lateBound.searchEngine.value;
    return {
      parentSessionId: parentSid,
      parentRunId: runId,
      parentType: deriveType(session),
      parentName: session?.title ?? 'session',
      parentScope: session?.derivation === 'subagent' ? 'subagent' : 'session',
      selfSessionId: sessionId, // caller self 身份（send_message 发送方）
      selfType: deriveType(session),
      selfName: session?.title ?? 'session',
      ...(session?.squadId !== undefined ? { selfSquadId: session.squadId } : {}),
      ...(session?.memberId !== undefined ? { selfMemberId: session.memberId } : {}),
      squadStore: squadStoreForCtx,
      memberStore: memberStoreForCtx,
      // panorama bus（panorama 工具写后 emit SSE；缺省 undefined → 工具静默跳过 emit 不阻塞写）
      panoramaBus,
      // [v0.0.210] academyStore + trainingEngine（lateBound 读取；activate 时已填充）
      // manage-task / manage-classroom 工具经 rtc 读取；缺省 undefined → 工具不可用
      ...(lateBound.academyStore.value ? { academyStore: lateBound.academyStore.value } : {}),
      ...(lateBound.trainingEngine.value ? { trainingEngine: lateBound.trainingEngine.value } : {}),
      // kind + sessionContext（工具 caller 身份数据源）
      ...(rtcKind ? { kind: rtcKind } : {}),
      ...(rtcSessionContext ? { sessionContext: rtcSessionContext } : {}),
      agentManager,
      store,
      sessionDeps: {
        store, agentManager, appConfig, pluginManager, contextEngine, dataDir,
        // [v0.0.223] todo 工具读 rtc.sessionDeps.todoStore（bootstrap 直接传参，无 lateBound）
        todoStore,
        ...(workspaceManager ? { workspaceManager } : {}),
        ...(connectorManager ? { connectorManager } : {}),
        ...(browserDriverRegistry ? { browserDriverRegistry } : {}),
        ...(browserInstanceManager ? { browserInstanceManager } : {}),
        cronToolDeps: lateBound.cronToolDeps.value, // spec cron_subsystem §6
        ...(searchEngine ? { historyToolDeps: { searchEngine, sessionStore: store } } : {}),
      },
      loadTemplate: subAgentLoadTemplate,
    };
  });

  // upsert builtin explorer 模板到 app_config sub_agent_templates group（idempotent）。
  upsertExplorerTemplate(appConfig);

  // 注入 sideRunner：fork-1 summary 入口（compact runner 用）。
  // 透传 triggerMessageId/triggerUsage → 构造 synthetic triggerMessage（仅用 id 写旁路 run trace meta；
  // 不入旁路 buffer，buffer 由 wireInitState 显式 ingest）。
  //
  // 闭包内首行 resolveConfigBySid 自 resolve（chat/compact 同链）；
  //   toolBound/maxIter/toolDefinitions/emit 全由 agentManager.sideRun 内部从
  //   policy（summary profile toolBound=[] + maxIterDefault=1）派生。
  contextEngine.setSideRunner(async (input) => {
    // 自 resolve 配置（与 chat 同链；主 loop 也走此入口，语义等价）
    const config = await agentManager.resolveConfigBySid(input.sessionId);
    // synthetic triggerMessage：仅用 id（content 空、role=user 占位），不入旁路 in_memory store
    const triggerMessage = {
      id: input.triggerMessageId ?? '',
      sessionId: input.sessionId,
      role: 'user' as const,
      content: [],
    } as Message;
    const run = await agentManager.sideRun({
      sessionId: input.sessionId,
      config,
      runKind: 'summary',
      snapshot: input.snapshot,
      userMessage: input.userMessage,
      triggerMessage,
      triggerUsage: input.triggerUsage,
    });
    const result = await run.promise;
    return { answer: result.answer, usage: result.usage };
  });

  // 注入 consolidateRunner：fork-2 整理 agent 入口（post-compact handler 用）。
  // 与 setSideRunner 同模式（wrapper）；caller 指定 runKind='consolidate'。
  //   consolidate profile toolBound=[skill_manage,memory_manage] + maxIterDefault=10。
  // fire-and-forget 由 memory_skill_consolidation handler 负责（void promise.catch）。
  //
  // 与 setSideRunner 同——闭包内首行 resolveConfigBySid 自 resolve；
  //   runner input 不带 whitelist/maxIter/toolDefinitions（profile 派生）。
  contextEngine.setConsolidateRunner(async (input) => {
    // 自 resolve 配置（chat/compact 同链）
    const config = await agentManager.resolveConfigBySid(input.sessionId);
    const triggerMessage = {
      id: input.triggerMessageId ?? '',
      sessionId: input.sessionId,
      role: 'user' as const,
      content: [],
    } as Message;
    const run = await agentManager.sideRun({
      sessionId: input.sessionId,
      config,
      runKind: input.runKind,
      snapshot: input.snapshot,
      userMessage: input.userMessage,
      triggerMessage,
      triggerUsage: input.triggerUsage,
    });
    const result = await run.promise;
    return { answer: result.answer, usage: result.usage };
  });

  // 注入 squad reminder deps（squad_agents_status/squad_task provider 数据源）。
  // SquadStore/MemberStore 句柄复用 setResolveConfig 闭包内同类（无状态封装）。
  // panoramaDataDir = dataDir（squad_task provider 读 PanoramaEntityStore 用）
  contextEngine.setSquadReminderDeps({
    squadStore: new SquadStore({ root: dataDir }),
    memberStore: new MemberStore({ root: dataDir }),
    panoramaDataDir: dataDir,
    isSessionRunning: async (sid: string) => {
      const s = await store.getSession(sid);
      return s?.state === 'running';
    },
  });

  return { agentManager, contextEngine, inbox, observabilityManager, toolEngine, toolDefinitions, squadStoreForCtx, sessionTypePolicy };
}
