/**
 * ContextEngine 对外类型（v0.0.8 简化版）
 * 参考: specs/tech/agent/context_and_memory/[P0]context_engine.md §2/§3
 *       specs/tech/agent/context_and_memory/[P0]context_snapshot_interface.md §2
 *       specs/tech/version_logs/v0.0.8/change_log.md §5
 *
 * 从 context-engine.ts 拆出（≤300 行约束）。本文件只含类型，无运行时逻辑。
 *
 * 类型决策：
 *   - SummaryInfo 复用 session-store-types.ts 已有定义（不重复）
 *   - ContextWindowUsage 复用 message/types.ts 已有 3 字段简化版（不重复）
 *   - ContextSnapshot / SessionConfig 为本模块首次定义
 */
import type { LlmClient } from '../llm/client';
import type { Message, ContextWindowUsage } from '../message/types';
import type { SummaryInfo } from './session-store-types';
import type { BizType, SessionKind, SessionContext } from '@app/shared';
import type { ObservabilityAdapter } from '../observability/adapter';
import type { ToolDefinition } from '../tools/types';
// [v0.0.21] skill catalog 注入（skills mapper 拼 L0 + skill 工具寻址共用）
import type { SkillCatalog } from '../skills/types';
// [v0.0.33.2] studio 4 scope：studioContext 携带 squad/member entity（team_roster/reachable_agents mapper
// + studio 分支取 systemPrompt/tools/skills/model/workdir 用）。schema_defs 是叶子类型文件，无循环。
import type { SquadRecord, MemberRecord } from './schema_defs/squad';
// [v0.0.144] llm_request config 装配接线：SessionConfig 承载生效的 llmRequestConfig + allProviders，
// 供 stage-llm 透传到 baseCallLLM → invoke（修 v0.0.25 装配断链，见 [P0]llm_caller.md §3 / [P0]llm_request_config.md §1.2）。
import type { LlmRequestConfig } from '../config/llm_request_config';
import type { LlmProviderConfig } from '../llm/provider-types';

/**
 * ContextSnapshot — assemble 产出的不可变快照（v0.0.8 简化）。
 * 完整形态见 context_snapshot_interface.md §2（含 system/messages/tools/summary/
 * contextWindowUsage/inputCharCount）；v0.0.8 不实现 tools 透传（agent-loop task-5
 * 自行从 config.tools 构造 CanonicalRequest），故 tools 字段省略。
 */
export interface ContextSnapshot {
  /** system prompt（role="system" 的 Message） */
  system: Message;
  /** 发送给 LLM 的消息列表（已选取 / 已插入 summary 占位） */
  messages: Message[];
  /** input 侧 char 总数（picked messages + system 字符数累加） */
  inputCharCount: number;
  /** 当前 context window token 用量（char × 1.0 估算，简化版 3 字段） */
  contextWindowUsage: ContextWindowUsage;
  /** 摘要信息（来自 store.getSummary；无则 content/summaryUpTo 为 null） */
  summary: SummaryInfo | null;
  /**
   * 工具定义集（policy 裁剪后的 ToolDefinition[]，与 main run spec.toolDefinitions 同源）。
   * spec §2 完整形态本含 tools，v0.0.8 简化时省略，现恢复：
   * assemble 时从 config.tools 派生；forked 读 snapshot.tools 作为 wire body tools，
   * 保证 forked 与 main 的 tools 段前缀一致（cache 契约）。
   */
  tools: ToolDefinition[];
}

/**
 * [v0.0.16] AppConfig 最小依赖（避免 context-engine → config / context-usage-calc 循环 import）。
 * 只需 `get(group, key)` 路径，由 bootstrap 注入 AppConfigService（鸭子类型兼容）。
 * 定义在本文件（类型权威源），供 context-engine / context-usage-calc 共享引用。
 *
 * 历史：v0.0.89 dev_config 废弃前称 DevConfigLike；迁移后改名 AppConfigLike（语义切 app_config）。
 */
export interface AppConfigLike {
  get(group: string, key: string): unknown;
}

/**
 * SessionConfig — ContextEngine 各方法的 session context（v0.0.8 简化）。
 * 参考 context_engine.md §2 + agent_manager.md §2：复用 SessionConfig 作 session context，不另造类型。
 *
 * 本文件是**全系统唯一的 SessionConfig 权威定义**（task-4 ToolSessionConfigLike /
 * task-5 agent-loop 均复用此类型，不另造）。
 *
 * v0.0.8 ContextEngine 实际读取字段：
 *   - sessionId：圈定 transcript 范围
 *   - systemPrompt：作为 snapshot.system 的 content
 *   - client：提供 contextWindow（tokenLimit 来源）；compact 用 client.call 发压缩请求
 *   - modelId：compact 调 client.call 时作为 CanonicalRequest.modelId
 *
 * task-4 / task-5 消费字段（ContextEngine 不读取，仅透传/路由）：
 *   - tools：工具数组（toolEngine.execute 从 config.tools 按 name 路由；task-5 assemble 时透传 definition）
 *   - workdir：bash/file 工具默认根（toolEngine 传给 ctx.workdir，bash 派生 <workdir>/workspace）
 *   - maxIterations：agent-loop ReAct 上限（来源 buildSessionConfigFromDeps：appConfig.get('agent','maxIterations') ?? DEFAULT_MAX_ITERATIONS；subagent = spawn 入参 maxIter）
 *
 * 采用结构化类型：task-4 的 ToolSessionConfigLike 与本类型天然兼容（鸭子类型），
 * task-5 构造完整 SessionConfig 后可直接传给 contextEngine 和 toolEngine。
 */
export interface SessionConfig {
  sessionId: string;
  systemPrompt: string;
  client: LlmClient;
  /** compact 调 LLM 时传入 CanonicalRequest.modelId */
  modelId: string;
  /** [v0.0.351] client 对应的 providerId，运行中按 session 最新 providerId/modelId 重建 client 用 */
  providerId: string;
  /** 工具数组（task-4 引擎按 definition.name 路由；task-5 assemble 时透传 definition） */
  tools?: unknown[];
  /** 工作目录（task-4 bash/file 默认根；task-5 设为 <DATA_DIR>/workspace） */
  workdir?: string;
  /**
   * ReAct 最大迭代数（task-5 消费）。类型可选，但运行时由 buildSessionConfigFromDeps 总是赋值（maxIterOf 读取时 ! 断言非空）。
   * 来源：顶层/studio/squad = DEFAULT_MAX_ITERATIONS（agent-loop-lifecycle.ts）；subagent = spawn 入参 maxIter（spawn-action.ts，独立默认）。
   */
  maxIterations?: number;
  /**
   * v0.0.15 T6：loop mode（agent_manager §2.2 + §4 agentByMode）。
   * - 'eager-drain'（默认）：主对话每轮 drain inbox
   * - 'lazy-drain'：[P2] future，本版本不实现（排除项，路由 fallback 到 eager）
   */
  loopMode?: 'eager-drain' | 'lazy-drain';
  /**
   * 可观测性 adapter（v0.0.10 引入，agent_manager.md §2 + observability/overall §7）。
   * 缺省 = NoopAdapter（loop 无条件调，无 if 分支；未配置零开销）。
   * 注入由 AgentManager 构造期据 dev_config.observability 决定（见 bootstrap / observability/index.ts）。
   */
  observability?: ObservabilityAdapter;
  /**
   * [v0.0.21] skill catalog 摘要（仅 enabled 项），供 skills mapper 拼 system prompt L0
   * + skill 工具寻址。一次 resolve（buildSessionConfigFromDeps）多处消费，避免每 turn 扫盘。
   * 见 specs/tech/agent/skills/[P0]skill_architecture.md §7。
   */
  skills?: SkillCatalog;
  /**
   * [v0.0.23] PluginManager 引用（web_search 等需读 exclusive EP provider 的工具消费）。
   * 由 session-config 构造期注入（与 buildLlmClient 同源 deps.pluginManager）。
   * 缺省 undefined → web_search 返「未配置任何 provider」（isError）。类型用 unknown
   * 避免本类型文件耦合 plugin-manager（PluginManager 实例鸭子类型传入）。
   */
  pluginManager?: unknown;
  /**
   * [v0.0.23] web_fetch 等读 app_config web group（jinaEnabled/jinaApiKey/jinaTimeoutMs）。
   * 历史：v0.0.89 dev_config 废弃前字段名为 devConfig（dev_config web group）；
   * 迁移后 group/key 名零变更直迁 app_config，本字段合并入下方 appConfig（同源服务，
   * 避免冗余注入）。web_fetch 工具改读 ctx.config.appConfig（specs/tech/config/[P0]app_config.md）。
   */
  /**
   * [v0.0.23] ConnectorManager 引用（browser tool mode=attach 读 attach session 门禁复用）。
   * 由 session-config 构造期注入；缺省 → browser attach 返「未连接」引导 isError。
   * 类型用 unknown 避免本文件耦合 tools/browser（ConnectorManager 实例鸭子类型传入）。
   */
  connectorManager?: unknown;
  /**
   * [v0.0.105] ComputerNativePort 引用（screenshot 等 computer use 工具读，走主进程原生能力）。
   * 由 session-config 构造期注入（从 deps.computerNativePort）；缺省 → screenshot tool fail-closed
   * 返「仅桌面 App 可用」。类型用 unknown 避免耦合 platform/computer（鸭子类型：checkPermissions/screenshot）。
   */
  computerNativePort?: unknown;
  /**
   * [v0.0.23] BrowserDriverRegistry 引用（含 PlaywrightDriver，供 web_fetch headless 兜底渲染
   * + browser tool mode=headless/managed-profile 启 driver 用）。
   * 由 session-config 构造期注入；缺省 → web_fetch 跳过 headless、browser headless 报「未注册」。
   * 类型用 unknown 避免本文件耦合 tools/browser（鸭子类型，仅需 get(mode)）。
   */
  browserDriverRegistry?: unknown;
  /**
   * [v0.0.264] BrowserInstanceManager 引用（headless/managed-profile 常驻浏览器实例管理器）。
   * browser tool 非 attach 前置校验读；由 session-config 构造期注入；
   * 缺省 → browser headless/managed-profile 报「未注册」isError。
   * 类型用 unknown 避免本文件耦合 tools/browser（鸭子类型）。
   */
  browserInstanceManager?: unknown;
  /**
   * [v0.0.204 T2-B2] SessionConfig.scope 死字段已删（零消费；spec agent_tools §2.2/2.3 描述的
   * agent-loop stageToolExecution 按 scope 过滤 allowedTools 已不存在——profile toolBound 已全权）。
   * subagent 不可见 agent 工具由 profile `playground-rocky.subagent.main.yaml` toolBound 不含 'agent' 保证。
   */
  /**
   * [v0.0.28] agent 工具运行时上下文（spawn/query/abort + send_message 用）。
   * 由 agent-loop 构造期注入：parent runId（origin.spawnRunId 审计）+ parent AgentRef
   * （首任务 sender.agent.ref）+ agentManager/store/sessionDeps 句柄。
   * agent-tool / send-message-tool 经 ctx.config.agentToolContext 读这些依赖。
   * 缺省 undefined → agent 工具 run 时抛「未注入」（subagent scope 工具不注册，门控前置）。
   */
  agentToolContext?: unknown;
  /**
   * [v0.0.30] LogWriter 引用（dev 调试日志）。
   * 由 session-config 构造期注入（与 appConfig 同源；v0.0.89 dev_config 废弃，logs group 直迁 app_config）。
   * - llm hook：经 stage-llm/forked-agent 透传到 InvokeContext.logWriter，invoke 末尾写 logs/llm.log。
   * - tool hook：engine.executeOne 经 ctx.config.logWriter 取用，写 logs/tool.log。
   * 缺省 undefined → 不写日志（开关 false 也早 return，零开销）。类型用 unknown（鸭子类型，
   * 仅需 write(type, record)），避免本文件耦合 dev-logs 模块。
   */
  logWriter?: unknown;
  /**
   * Session 身份维度统一对象（biz/role/derivation/runKind 4 字段）。
   * 由 buildSessionConfigFromDeps 构造期产出，供下游 mapper/router 统一读派生 getter：
   *   - kind.role：'rocky'|'squad'|'leader'|'mate'
   *   - kind.isStudio / isSubagent / isMainRun
   *   - kind.canonicalId()：scopeId 纯拼接（scopeIdOf）
   *
   * 实例 ID（squadId/memberId/parentSessionId）拆 SessionContext。
   *
   * 缺省 undefined = 旧 config 未迁移 / 注入链不完整。
   * 与旧 bizType/squadId/memberId 共存一期过渡（bizType 仍用于 GET /sessions 过滤；后续版本废弃）。
   */
  kind?: SessionKind;
  /**
   * [v0.0.204] SessionContext（实例 ID 投影；与 kind 同构造点产出，分离承载）。
   * 缺省 undefined = 旧 config / caller 未透传。
   */
  sessionContext?: SessionContext;
  /**
   * [v0.0.33.2] @deprecated v0.0.56 起 kind.isStudio 替代；一期过渡保留（handler 层 GET /sessions 过滤用）。
   */
  bizType?: BizType;
  squadId?: string;
  memberId?: string;
  /**
   * [v0.0.33.2] studio session 的 squad/member entity（bootstrap 注入，非 session record 镜像）。
   * team_roster/reachable_agents mapper（T3）+ studio 分支取 systemPrompt/tools/skills/model 用。
   * 缺省 undefined = standalone/subagent（subagent 走 subAgentConfig 分支，无 studioContext）。
   */
  studioContext?: StudioContext;
  /**
   * [v0.0.210] academy session 上下文（由装配层注入 academyStore 相关数据）。
   * academy mapper 经 ctx.config.academyContext 读 classroom/task/turns/datasets/graders/students 等
   * 实体（鸭子类型，避免本文件耦合 academy-store 模块）。
   * 缺省 undefined = 非 academy session / 装配层未注入 → academy mapper 降级返空。
   * 形状见 app/plugins/builtins/rocky_context/prompt/academy-shared.ts AcademyContextLike。
   */
  academyContext?: unknown;
  /**
   * [v0.0.51] app 数据根（绝对路径）。由 buildSessionConfigFromDeps 从 deps.dataDir 注入。
   * skill_manage 工具经 ctx.config.dataDir 读 app 数据根（写 <dataDir>/skills/<name>/SKILL.md）。
   * 与 tools/types.ts ToolSessionConfigLike.dataDir 镜像（结构化类型兼容）。
   */
  dataDir?: string;
  /**
   * AppConfigService 引用。由 buildSessionConfigFromDeps 从 deps.appConfig 注入。
   * 消费方：
   *   - memory_manage 工具（maxMemoryInject 等 session 组配额读源）
   *   - memory_user/memory_session/memory_group system_prompt mapper（maxMemoryInject 读源）
   *   - [v0.0.89] web_fetch 工具读 app_config web group（jinaEnabled/jinaApiKey/jinaTimeoutMs，
   *     自 dev_config 迁移至此同源服务，避免冗余注入）
   * 缺省 undefined → memory mapper 用内置默认配额；web_fetch 走代码默认。
   * 类型用 unknown 避免本文件耦合 config 模块（鸭子类型，仅需 get/set）。
   */
  appConfig?: unknown;
  /**
   * [v0.0.58] cron 工具运行时上下文（cronStore + engine + sessionStore/squadStore 取 tz）。
   * 由 buildSessionConfigFromDeps 从 deps.cronToolDeps 注入（T6 装配好后透传）。
   * cron 工具（action: create/list/update/disable/enable/delete）经 ctx.config.cronToolDeps 读。
   * 缺省 undefined → cron 工具报 RUNTIME_ERROR（isError=true + [cron:*] reason）。
   * 类型用 unknown 避免本文件耦合 scheduling 模块；实际形状由 tools/cron/cron-tool.ts CronToolDeps 定义。
   */
  cronToolDeps?: unknown;
  /**
   * [v0.0.144] 生效的 llm_request config（含 retry/timeout/degradation/length/fallbackChain）。
   * 由 buildSessionConfigFromDeps 调 `new LlmRequestConfigService(appConfig).get()` 加载注入，
   * 经 stage-llm（callLLMForSpec / callLLMForMain）透传到 baseCallLLM → InvokeContext.config。
   * 缺省 undefined → invoke 命中 `ctx.config ?? DEFAULT_LLM_REQUEST_CONFIG` 回退默认（向后兼容零回归）。
   * 修 v0.0.25 装配断链：此前生产 loop 从不加载 config，max_attempts/timeout 恒为默认（llm_caller §3）。
   */
  llmRequestConfig?: LlmRequestConfig;
  /**
   * [v0.0.144] 全部启用的 provider 实例（fallback_chain 非空时 invoke.resolveTarget 查找用）。
   * 由 buildSessionConfigFromDeps 调 `listEnabledProviders(appConfig)` 加载注入。
   * 缺省 undefined / 空 chain → invoke 只用 client 派生的单 target 兜底（向后兼容）。
   */
  allProviders?: LlmProviderConfig[];
  /**
   * [v0.0.148] session 级 effort 推理强度（canonical 语义键，4 档）。
   * 由 buildSessionConfigFromDeps 从 session.effort 注入；stage-llm 透传到 CallLLMInput.effort
   * → encode 注入 anthropic wire output_config.effort。
   * 缺省 undefined → encode 走 default 档（不注入 output_config，厂商默认行为）。
   * 源头唯一 = session record（无 per-request 覆盖语义）。
   */
  effort?: 'default' | 'low' | 'high' | 'max';
  /**
   * [v0.0.148] session 级审批模式（绿灯）。
   * 由 buildSessionConfigFromDeps 从 session.approvalMode 注入；engine.execute ask 分支直读。
   * - 'greenlight' → ask 短路（fall through 视同 allow，不渲染审批卡）
   * - 'normal'（缺省）/ undefined → 现状（ask 未批准悬挂审批卡）
   * 安全 invariant：绿灯只动审批层；deny（策略层）+ 执行层沙箱不受影响。
   */
  approvalMode?: 'normal' | 'greenlight';
  /**
   * [v0.0.347] 模型路由方案（分支 2 才有；分支 1 = undefined → invoke 走现有路径）。
   * 由 buildSessionConfigFromDeps 每次 run 现拉：先查挂载（studio=squad.modelRoutingPlanId /
   * playground=model_routing.default.playgroundPlanId）→ 有挂载读方案实体合成候选链产出。
   * 参考: specs/tech/agent/providers_and_models/[P0]model_routing.md §4（resolve 双分支）
   */
  modelRoutingPlan?: {
    planId: string;
    /** [v0.0.353 T5 D8] 方案名（resolveModelRoutingPlan 从方案实体带出；logical gen metadata 记录） */
    planName?: string;
    /** 合成后的候选链（session 显式模型已 priority 0 插入顶部；default/none/undefined = 方案 items 原序） */
    items: import('../services/model-routing-validation').RoutingItem[];
    /** 生效熔断参数（默认值填充后；方案 circuit 覆盖缺省用默认） */
    circuit: import('../services/model-routing-validation').CircuitConfig;
  };
}

/**
 * [v0.0.33.2] studio session 的 squad/member entity 包（[P1]session_config_studio.md §2）。
 * 由 bootstrap setResolveConfig 闭包按 session.squadId/memberId 从 SquadStore/MemberStore 取 entity 注入。
 * - leader/mate：member + squad + members 批量都填（team_roster/tools/skills/model/workdir 全要用）。
 * - squad：填 squad + members 批量（无 member entity；systemPrompt 用硬编码路由器；reachable_agents/team_roster 需全队花名册）。
 * - subagent：不走 studio 分支，不注入 studioContext。
 *
 * [v0.0.33.2 round-3 BUG-3 修] members 批量字段：bootstrap 一次性拉齐 squad 全部 member entity 注入。
 * team_roster / reachable_agents mapper 据此派生花名册 + 路由对端列表（user 永不在）。
 * 修前 mappers 读 sc.members 一直空（bootstrap 没注）→ SquadChat reachable_agents 空 → 路由断（自循环）。
 */
export interface StudioContext {
  squad?: SquadRecord;
  member?: MemberRecord;
  /** squad 全队 member entity 批量（bootstrap listMembers 一次性注入；team_roster/reachable_agents 派生用） */
  members?: MemberRecord[];
}
