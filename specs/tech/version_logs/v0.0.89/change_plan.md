# v0.0.89 变更计划书 — 配置页 tab 化 + 模型选择器迁移 + dev→app 合并

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 输入：PRD `specs/prd/version_logs/v0.0.89/` 5 工作块 + `design-brief.md` 8 决策。设计稿 `demo.html` 视觉契约。
> 核心约束（codereviewer 清单 G）：① 保留字 `default`=未选/跟随默认（不抛错）；② page-tab 级保存（非 per-group），provider 编辑器独立 dirty；③ studio 完全不读 `app_config.default_models`；④ dev→app 零命名冲突直迁，`dev_config/llm_request` 两死数据丢弃；⑤ model resolve 优先级链见 §3 各表；⑥ session.modelId 不加 flag 字段（用 string 保留字）；⑦ 单文件 ≤300 行；⑧ UI 复用既有 token/utility（不发明新样式）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径（worktree 根为相对基） |
| 函数/符号 | 函数名/符号名（行粒度=符号；新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT 钉死边界 |
| 参考 | spec 路径+章节 / 项目原则编号 |
| 预计影响行 | +N / -M |

## 变更清单

### A. config_schema — schema 层（squad/session/dev_config）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| config_schema | app/server/src/agent/schema_defs/squad/squad.ts | SquadSchema.fields.summaryModelDefault | 新增 | squad 默认整理模型 ModelRef 字段：`{ type: 'string', required: false }`。空=回退 modelDefault | MUST optional；MUST NOT 加非空校验（允许 squad 不配整理模型）；comment 注明 N4 + 回退链 | PRD 03 §3.2；specs/tech/squad/[P1]data_model.md §1.1；design-brief §6.2 | +6 |
| config_schema | app/server/src/config/schema_defs/dev_config.ts | DevConfigSchema | 删除 | 整个 schema 文件移除（entity dev_config 不再注册） | MUST 与 dev-config-service.ts 同批删（保持 import 收敛）；MUST NOT 残留 schema 引用 | PRD 05 §3.1.A；specs/tech/config/[P0]dev_config.md 标 deprecated | -50 |
| config_schema | app/server/src/config/schema_defs/app_config.ts | AppConfigSchema | 修改 | 注释 / 文档串更新（schema 本身 group 不枚举无需改）；新增 group 形状说明落到 spec 文档（不改 schema 代码） | MUST NOT 在 schema 加 group 白名单（保持通用 KV） | specs/tech/config/[P0]app_config.md §3.4 + 新增 §3.7-§3.13 | +0 |

### B. config_service — 服务层（resolver/validation/app-config-template-handler）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| config_service | app/server/src/services/model-resolver.ts | ModelNotConfiguredError | 新增 | class extends Error；含 detail `{ sessionType, task }`；HTTP 400 映射 | MUST 在 resolve 链跑空时抛；MUST NOT 被 catch 后静默兜底首个 enabled provider | PRD 03 §5.1；原则#12 spec↔code 一致 | +20 |
| config_service | app/server/src/services/model-resolver.ts | resolveModel | 新增 | 统一 model resolve 入口：入参 `{ appConfigService, session, squad?, member?, task: 'chat'\|'summary' }` → `{ providerId, modelId }` 或 throw；内部按 PRD 03 §2.1 表 6 行 fallback 链分支 | MUST 区分 playground / studio chat / studio leader-mate × chat/summary 4+2 链；MUST `default`/`undefined` 等价视为「继续 fallback」；MUST NOT studio 读 app_config.default_models；MUST 具体 modelId 不命中（disabled/not found）视为 fallback 链该步未命中继续 | PRD 03 §2.1 表 + §2.2 + §2.3；design-brief §3；原则#11 概念先行 | +120 |
| config_service | app/server/src/services/model-validation.ts | validateModelId | 修改 | 白名单加保留字 `"default"`：`if (modelId === 'default') return { ok: true }`（在空串放行分支之后） | MUST 保留字 default 放行；MUST NOT 改具体 modelId 校验逻辑（仍走 listEnabledProvidersForValidation）；空串 "" 仍放行（member inherit 语义不变） | PRD 03 §2.2 + §2.3；specs/api/overall/02-llm-chat.md §5 | +3 |
| config_service | app/server/src/handlers/dev-config-template-handlers.ts | handleKvConfigDevDelete / handleKvConfigDevPut / checkBuiltinProtection | 修改（重命名+迁移） | 文件改名 `app-config-template-handlers.ts`；签名 `svc: DevConfigService` 改 `svc: AppConfigService`；逻辑（builtin 保护、原子拒绝、403/404 分支）整体保留；路由前缀 `/config/dev` 改 `/config/app/sub_agent_templates`（详见 F 段） | MUST 保留 builtin:true 拒 403 + group!==sub_agent_templates 拒 403 group_not_deletable；MUST NOT 改 secret redact 路径（observability/web secret 走 kv-config-handlers）；MUST 文件 ≤300 行 | PRD 05 §3.1.C；specs/api/overall/10-multi-agent.md §5.2/§5.3 | +5/-5 |
| config_service | app/server/src/agent/tools/template-store.ts | loadTemplateFromDevConfig / listTemplates / upsertExplorerTemplate / makeLoadTemplate | 修改 | 形参 `devConfig: DevConfigService` 改 `appConfig: AppConfigService`；内部 `devConfig.get/set(SUB_AGENT_TEMPLATES_GROUP, ...)` 改 `appConfig.get/set(...)`；explorer 预配改写 app_config | MUST 仅改 service 类型 + 参数名；MUST NOT 改 SUB_AGENT_TEMPLATES_GROUP 常量值（"sub_agent_templates"）；MUST NOT 改 SubAgentTemplate 形态 | PRD 05 §3.1.D；specs/tech/multi_agent/[P1]subagent_templates.md §3 | +8/-8 |

### C. session_handler — session 持久化与 resolve 调用

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| session_handler | app/server/src/handlers/session.ts | handleSessionCollection（POST 分支） | 修改 | 新建 session 默认写 `modelId: 'default'`（替代当前不写）；body.modelId 提供→仍校验+覆盖；body.modelId 缺省→落 `"default"` | MUST 创建路径默认 `"default"`（非 undefined）；MUST body 显式传 modelId 仍校验命中（含保留字 `"default"` 放行）；MUST NOT 在此抛 ModelNotConfigured（resolve 阶段才抛） | PRD 03 §3.1 + §4；session_store.md §2 | +6/-2 |
| session_handler | app/server/src/handlers/session.ts | handleSessionItem（PUT 分支 body.modelId） | 修改 | body.modelId 接受 `"default"` / 具体 ModelRef / `"none"`（等价 default）；校验阶段保留字放行（不查 provider 命中） | MUST 保留字 default/none 落盘；MUST NOT 校验保留字时调用 validateModelId（白名单已加但仍走一层：保留字短路）；MUST NOT 改 providerId 校验逻辑 | PRD 04 §5.2 API；03 §2.2 | +5 |
| session_handler | app/server/src/handlers/session-config.ts | buildSessionConfigFromDeps | 修改 | 调 `resolveModel(...)` 替代直接 `resolveProviderModel(...)`：传入 task='chat' + session/squad/member；studio 分支保留 member.model/squad.modelDefault 回退；保留 systemPrompt/tools/skills/workdir/maxIter 装配逻辑 | MUST task='chat' 走 resolveModel；MUST NOT 在此读 app_config.default_models.summary（chat 任务不读 summary）；MUST 保留 devConfig.maxIter 兜底（迁移期 devConfig 仍存在→迁移完后该路径改读 appConfig） | PRD 03 §2.1 第 1/3/5 行；03 §4 调用点；原则#10 | +25/-15 |
| session_handler | app/server/src/handlers/session-compact.ts | handleSessionCompact | 修改 | 调用点改 buildSessionConfigFromDeps 时传 task 标志（或在 buildSessionConfigFromDeps 内区分 chat/summary）；compact 入口按 summary 链走（playground: default_models.summary→session.modelId(具体)→default_models.chat；studio: squad.summaryModelDefault→member.model→squad.modelDefault） | MUST compact 走 summary 链；MUST 在 ModelNotConfiguredError 时返 400 `{code:"MODEL_NOT_CONFIGURED"}`；MUST fire-and-forget 不变（仍 `void contextEngine.compact(...)`） | PRD 03 §2.1 第 2/4/6 行 + §5.1；design-brief §3 | +12/-3 |
| session_handler | app/server/src/handlers/session-messages.ts | handleSessionMessages（POST /session/:id/messages 入口） | 修改 | resolveModel 取代 resolveProviderModel；bodyOverride 仍优先；ModelNotConfiguredError catch 返 400 + toast link | MUST bodyOverride.modelId 优先；MUST `"default"` bodyOverride 视为未覆盖继续走 fallback；MUST 保留 SSE 流式响应不变 | PRD 03 §4 调用点；04 §5.2 | +10/-3 |
| session_handler | app/server/src/handlers/session-run.ts | handleSessionRun（POST /session/:id/run 入口） | 修改 | 同 session-messages.ts：改用 resolveModel；错误体加 MODEL_NOT_CONFIGURED | MUST 与 session-messages 错误体格式一致 | PRD 03 §4；04 §5.2 | +8/-3 |
| session_handler | app/server/src/handlers/session-provider-utils.ts | resolveProviderModel | 修改（保留为内部 helper） | 改为 model-resolver.ts 的内部辅助：仍做「显式 providerId/modelId + 默认取首个 enabled provider」机械解析；不再被 handler 直接调用（handler 走 resolveModel）；签名保留但 export 收敛 | MUST 保留为 listEnabledProviders/findProvider/findFirstWithModels 单点出口；MUST NOT 删（model-resolver 复用其机械解析）；可标 `@internal` | PRD 03 §4；现状代码 session-provider-utils.ts:54 | +6/-2 |
| session_handler | app/server/src/handlers/member.ts | handleMemberCreate/HireMember/PatchMember（validateModelId 调用点） | 修改 | validateModelId 已加 default 白名单，本处不改逻辑；仅注释更新（member.model 可为 `"default"`，与空串"" 同效 inherit） | MUST NOT 改校验入口；MUST 注释澄清 default=inherit | PRD 03 §2.3；data_model.md §1.2 | +2 |
| session_handler | app/server/src/handlers/squad.ts | handleCreateSquad（POST /squad, 行 196） | 修改 | body 接受 `summaryModelDefault?: string`；提供值→validateModelId 校验（保留字 default 放行）；空串/undefined=不配；写入 createSquadService 入参 CreateSquadInput；201 响应经 toDetail 回显字段 | MUST 响应 body 含 summaryModelDefault（即便 undefined 也回显）；MUST NOT 默认值兜底 | PRD 03 §3.2；specs/api/overall/11a-squad-endpoints.md §1.1 | +6/-1 |
| session_handler | app/server/src/handlers/squad.ts | handlePatchSquad（PATCH /squad/:id, 行 254） | 修改 | body 接受 `summaryModelDefault?`：undefined=不修改；空串""=清空（patch 写 undefined）；具体值→validateModelId 校验；写 patch.summaryModelDefault | MUST PATCH 可单独清（写 undefined，不影响 modelDefault）；MUST 响应 toDetail 回显；MUST NOT 强制每次都传 | PRD 03 §3.2；specs/api/overall/11a-squad-endpoints.md §1.4 | +6/-1 |
| session_handler | app/server/src/handlers/squad.ts | SquadDetail interface（行 98）+ toDetail（行 139） | 修改 | interface 加 `summaryModelDefault?: string`；toDetail 序列化加 `summaryModelDefault: s.summaryModelDefault` | MUST optional；MUST 即便 undefined 也回显字段（不省 key） | PRD 03 §3.2；N4 | +3 |

### D. squad_service — squad 业务层

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad_service | app/server/src/services/squad-service.ts | CreateSquadInput interface（行 59）+ createSquadService（行 118） | 修改 | CreateSquadInput 加 `summaryModelDefault?: string`；createSquadService 内部 store.createSquad 写入该字段（透传，无默认兜底） | MUST optional 透传；MUST NOT 改 charter/budget/timezone 等其它字段逻辑；MUST NOT 在 service 层校验（校验在 handler） | PRD 03 §3.2；data_model.md §1.1；specs/api/overall/11a-squad-endpoints.md §1.3 | +4 |
| squad_service | app/server/src/stores/squad-store.ts | SquadStore class + SquadEntity type（行 39 + 29） | 不动（自动派生） | SquadEntity = StoredRecord<typeof SquadSchema>，A 段 schema 加字段后类型自动同步；store 是 CrudStore 包装无需手动改 | MUST NOT 在 store 加业务校验（dumb CRUD）；MUST 类型派生链：SquadSchema → SquadEntity → SquadStore.create/update | A 段 squad.ts schema；data_model.md §1.1 | +0 |

### E. config_routes — 路由层（dev→app handler 迁移 + 新 group handler）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| config_routes | app/server/src/router.ts | `/config/dev` 分支 | 删除 | 整段移除（router.ts:429-435） | MUST 删 devConfig 注入；MUST NOT 残留 devConfig 引用（详见 F 段 bootstrap） | PRD 05 §3.1.C；05 §3.1.E | -7 |
| config_routes | app/server/src/router.ts | `/config/app/sub_agent_templates` 分支 | 新增 | 路由精确匹配（在 `/config/app` 之前）：DELETE → handleKvConfigAppTemplateDelete；PUT → handleKvConfigAppTemplatePut | MUST 注册顺序：sub_agent_templates 须在 `/config/app` 之前（防前缀覆盖）；MUST NOT 改 GET/POST 形态（GET 走通用 handleKvConfig ?group=sub_agent_templates） | PRD 05 §3.1.C；specs/api/overall/10-multi-agent.md §5.2/§5.3 | +10 |
| config_routes | app/server/src/handlers/kv-config-handlers.ts | redactGet / mergePut / handleKvConfig / handleKvConfigPut | 修改 | service 类型 union 去 `DevConfigService`（仅 `AppConfigService`）；secret redact 路径（observability/web）保留，group 名不变（runtime/web/sub_agent_templates 都已迁 app_config） | MUST 不改 observability/web secret 逻辑（isObservabilityKV 仍按 group='runtime'+key='observability' 判定）；MUST NOT 加新 secret 字段 | PRD 05 §3.1.D；dev_config §3.4.1（secret 套路） | +2/-2 |
| config_routes | app/server/src/handlers/llm_request_config.ts | handleLlmRequestConfigGet / handleLlmRequestConfigPut | 不动 | 路径 `/config/app/llm_request` 保持；前端走相同端点；UI 仅暴露 stall_tool_s + max_attempts 两子字段（前端 GET→改两字段→PUT 完整 data） | MUST 后端不动（仍是完整 record PUT）；MUST NOT 改 DEFAULT_LLM_REQUEST_CONFIG | PRD 02 §2.2；specs/tech/agent/llm_caller/[P0]llm_request_config.md §1 | +0 |

### F. dev_config_consumer_migration — devConfig 消费方改读 appConfig

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| consumer_migration | app/server/src/bootstrap.ts | createBootstrap 返回的 `bs.devConfig` 字段 | 删除 | 字段从 BootstrapServices 接口删；new DevConfigService(...) 移除；LogWriter 改用 appConfig；ObservabilityManager 构造改读 appConfig.get('runtime','observability')；loadTemplate 改读 appConfig；upsertExplorerTemplate 改 appConfig | MUST ObservabilityManager 凭证源唯一改 app_config（不再读 LANGFUSE_*）；MUST LogWriter `devConfigService.get('logs', ...)` 改 `appConfig.get('logs', ...)`；MUST sub_agent_templates builtin explorer 预配迁 app_config（idempotent）；MUST NOT 改 connectorConfig/pluginConfig（无关） | PRD 05 §3.1.D；specs/tech/dev-logs/[P0]overall.md §2.5；observability/[P0]observability_manager.md §6/§7 | +30/-30 |
| consumer_migration | app/server/src/agent/context-engine.ts | ContextEngineOpts.devConfig / ContextEngine.devConfig 字段 | 修改（重命名+迁移） | 字段改名 `appConfig`（同源 maxIter/maxOutputTokens 读取）；类型 DevConfigLike 改为 AppConfigLike（或共用同一最小接口 `{ get(group, key): unknown \| undefined }`） | MUST 形参 / 字段同步改名；MUST NOT 改 compact/assemble 逻辑（仅依赖读取入口） | PRD 05 §3.1.D；context/[P0]context_engine.md | +8/-8 |
| consumer_migration | app/server/src/agent/context-usage-calc.ts | getMaxOutputTokens / calcContextWindowUsage | 修改 | `devConfig.get('context','maxOutputTokens')` 改 `appConfig.get('context','maxOutputTokens')`；形参改名；DEFAULT_MAX_OUTPUT_TOKENS=20000 兜底不变 | MUST 20000 兜底语义不变（estimated output 常量，非 model 字段）；MUST NOT 把 20000 当 model.maxOutputTokens | PRD 05 §3.1.D；memory estimated-output-constant-semantics | +5/-5 |
| consumer_migration | app/server/src/agent/context-types.ts | AgentContextConfig.devConfig | 修改（重命名） | 字段改名 appConfig；类型签名同步；UT 中 mock 注入同步改名 | MUST NOT 改字段语义（仍是 KV 读取入口） | PRD 05 §3.1.D | +3/-3 |
| consumer_migration | app/server/src/agent/agent-manager.ts | setResolveConfig 注入的 buildSessionConfigFromDeps 通路 | 修改 | 内部 deps.devConfig 改 deps.appConfig（buildSessionConfigFromDeps 签名同步见 C 段） | MUST 与 C 段 buildSessionConfigFromDeps 同步改签名 | PRD 05 §3.1.D | +2/-2 |
| consumer_migration | app/server/src/handlers/session-deps.ts | SessionHandlerDeps.devConfig | 修改（重命名） | 字段改名 appConfig（与 appConfig 字段合并：本就有 appConfig，devConfig 字段冗余→删 devConfig 字段，所有读取改 appConfig） | MUST 与各 handler 调用点同步；MUST NOT 漏改任意 devConfig 引用（grep 兜底） | PRD 05 §3.1.D；原则#16 grep 兜底 | +3/-3 |
| consumer_migration | app/server/src/tools/types.ts | ToolDeps.devConfig | 修改（重命名） | 字段改名 appConfig（或合并到既有 appConfig 字段） | MUST 与 web_fetch tool 同步 | PRD 05 §3.1.D | +2/-2 |
| consumer_migration | app/server/src/tools/web-fetch/tool.ts | createWebFetchTool（deps.devConfig）/ readWebDevConfig | 修改 | deps 参数改名；readWebDevConfig → readWebAppConfig；内部 devConfig.get('web', ...) 改 appConfig.get('web', ...) | MUST web.jinaApiKey secret 处理仍走 kv-config-handlers redact（jinaApiKey 仍是 secret）；MUST NOT 改 jina 默认值（jinaEnabled=true / jinaTimeoutMs=20000） | PRD 05 §3.1.D；dev_config §3.5 | +8/-8 |
| consumer_migration | app/server/src/tools/web-fetch/race-runner.ts | FetchContentOptions.devConfig 字段 | 修改（重命名） | 字段改名 appConfig（仍是 JinaDevConfig 子结构，仅 owner service 切换） | MUST 形态不变（仅语义从 dev→app） | PRD 05 §3.1.D | +1/-1 |
| consumer_migration | app/server/src/tools/web-fetch/jina-fetcher.ts | JinaDevConfig 类型注释 | 修改（注释） | 注释更新「dev_config web group」→「app_config web group」；代码不动 | MUST NOT 改类型形态 | PRD 05 §3.1.D | +1/-1 |
| consumer_migration | app/server/src/observability/index.ts | buildObservabilityManager | 修改 | 凭证源改 app_config：`appConfig.get('runtime','observability')` 替代 devConfig；签名改注入 appConfig | MUST 永不读 LANGFUSE_* ENV（已在 v0.0.x 移除，保持）；MUST record 缺失视为 0 child（Noop） | PRD 05 §3.1.D；observability/[P0]observability_manager.md §6 | +3/-3 |
| consumer_migration | app/server/src/observability/observability-manager.ts | ObservabilityConfigItem 类型 + createObservabilityManager | 不动 | 类型定义保持（注释说明 data 落 app_config）；构造入参列表 data 不变 | MUST NOT 改 ObservabilityConfigItem 字段（id/name/type/baseUrl/publicKey/secretKey/enabled/desc/logPhysical） | specs/tech/config/[P0]app_config.md（迁后落 §3.X runtime） | +0 |
| consumer_migration | app/server/src/dev-logs/log-writer.ts | LogWriter 构造（devConfig 注入）/ shouldWrite（devConfig.get('logs', ...)） | 修改 | 构造形参 devConfig 改 appConfig；shouldWrite 读取改 appConfig.get('logs', ...) | MUST 读路径仅切 service，4 个 key 名（enableLlmRequestLog/enableToolResultLog/enableAppApiLog/enableEventLog）不变；MUST NOT 改 hook 注入位置 | PRD 05 §3.1.D；dev-logs/[P0]overall.md §2.5 | +3/-3 |
| consumer_migration | app/server/src/config/dev-config-service.ts | DevConfigService 类 | 删除 | 整文件移除 | MUST 与 schema_defs/dev_config.ts 同批删；MUST NOT 残留 re-export（config/index.ts 同步删 export） | PRD 05 §3.1.B | -40 |
| consumer_migration | app/server/src/config/index.ts | DevConfigSchema / DevConfigRecord re-export | 删除 | 两行 export 移除 | MUST 与 dev-config-service 同批；MUST NOT 删 AppConfigSchema/connector  | PRD 05 §3.1.B | -2 |
| consumer_migration | app/server/src/config/kv-config-service.ts | KvConfigService 基类 | 不动 | 通用 KV 基类保持（AppConfigService 继承） | MUST NOT 改基类（仍共享） | specs/tech/config/[P0]app_config.md §5 | +0 |

### G. i18n — locale 迁移到 appearance group

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| i18n | app/web/src/i18n/change-language.ts | changeLanguage | 修改 | PUT URL 从 `?group=locale` 改 `?group=appearance`；body items 仍 `[{key:'language', data: lng}]`（key 名不变）；items 数组改为含 theme + language 两 key（read-modify-write：先 GET appearance group → 改 language → PUT 整组） | MUST 整组 PUT（含 theme + language，避免覆盖 theme）；MUST NOT 删 theme（read-modify-write 路径必走）；切即生效语义保持 | PRD 01 §4.2 + §4.3；specs/tech/i18n/[P0]i18n_overview.md §5.4 | +12/-3 |
| i18n | app/web/src/i18n/locale-init.ts | initI18nFromConfig | 修改 | GET URL 从 `?group=locale&key=language` 改 `?group=appearance&key=language`；fallback zh-CN 不变 | MUST 仅切 group 名；MUST NOT 改 fallback 逻辑 | PRD 01 §4.2；i18n_overview.md §5.2 | +1/-1 |
| i18n | app/web/src/components/app-dev-config-page/component-locale-card.tsx | ComponentLocaleCard（行 37） | 修改 | 删除（合并到通用 key-select in 外观 group）；或保留组件但 onChange 调 changeLanguage（仍切即生效，不走 page dirty，与 v0.0.59 同语义）；切 language 路径走 appearance group | MUST 切即生效保持（不进 page dirty，design-brief §1.2 + 既有 v0.0.59 决策）；MUST NOT 强制走 page-tab 级保存（语言切换实时生效是硬约束）；MUST PUT appearance group 走 read-modify-write（含 theme + language） | PRD 01 §4.3 + §3.2 例外；design-brief §1.2 | +5/-3 |

### H. config_page_ui — 应用设置页 tab 化（web/src）

> design-brief §1 + PRD 01。组件 spec 由 coder 编码前置产出（先 spec 后实现，规范见 `specs/ui/components/_conventions.md`）。本表仅列代码层改动；组件 spec 文件清单见文末「L. ui_specs」段。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| config_page_ui | app/web/src/components/app-dev-config-page/page-app-settings-merged.tsx | PageAppSettingsMerged | 修改（大改） | flat sidebar group-list 改 tab 竖排导航树：通用区 4 tab（通用/模型/工具/记忆）+ 系统设置收起区 2 tab（可观测性/插件）；右栏按选中 tab 渲染对应 section 集合；page-tab 级 save-bar（dirty 检测 + 保存/取消）；provider 编辑器例外（独立 dirty）；切 tab dirty 弹确认 modal | MUST 文件 ≤300 行（超则拆 component-tab-tree-item + component-tab-save-bar 到独立文件）；MUST tab 切换 dirty 弹 modal（不静默丢）；MUST 系统设置收起时当前选中 ∈ {可观测性/插件} → 回落「通用」；MUST 清硬编码 hex 全替 token；MUST 字体 weight 仅 400/600；MUST NOT 改既有 testid `app-settings-system-toggle`；MUST NOT 触发 provider 编辑器 dirty | PRD 01 §2/§3.1/§3.2；design-brief §1；specs/ui/components/app-dev-config-page/page-app-settings-merged.md（coder 前置改） | +180/-90 |
| config_page_ui | app/web/src/components/app-dev-config-page/component-tab-tree-item.tsx | TabTreeItem | 新增 | 单个 tab item 组件（label + icon + selected 态 + disabled 态），从 page 拆出 | MUST 单一职责；MUST NOT 自管 selected state（受控）；MUST ≤80 行 | PRD 01 §2；design-brief §1.1 | +60 |
| config_page_ui | app/web/src/components/app-dev-config-page/component-tab-save-bar.tsx | TabSaveBar | 新增 | page-tab 级 sticky 底部 save-bar：dirty 状态 + 保存按钮 + 取消按钮（仅 dirty 可见） | MUST sticky bottom 不随滚动消失；MUST 取消按钮 visibility:hidden 预留空间（避免位移）；MUST 保存按钮在 dirty 时高亮 | PRD 01 §3.2；design-brief §3.2 | +80 |
| config_page_ui | app/web/src/components/app-dev-config-page/app-settings-config-defs.ts | KV_GROUPS（行 19）+ GroupDef interface（行 11）+ 新增 APP_SETTINGS_TABS 常量 | 修改 | 改 KV_GROUPS：删 `locale` group 定义（合并到 appearance 的 language key）；appearance group key 列表加 language；新增 default_models group 定义（chat/summary 两 key + type='model'）；新增 llm_request group 的 key 暴露定义（stall_tool_s + max_attempts，type='number'，仅暴露子字段）；logs/runtime/web/sub_agent_templates 改读 app_config 端点（PUT 路径前缀 /config/app）；新增 APP_SETTINGS_TABS 常量（通用区 4 tab + 系统设置区 2 tab 收起） | MUST 通用区 4 tab + 系统设置区 2 tab；MUST default_models 两 key 均 optional（type=model）；MUST NOT 加 degradation/length/fallback_chain 子字段；MUST appearance group 含 theme + language 两 key | PRD 01 §3 + 02 §2 + 05 §3.1.E | +60/-15 |
| config_page_ui | app/web/src/components/app-dev-config-page/use-app-settings-config.ts | useAppSettingsConfig hook | 修改 | 多 group snapshot/draft 管理（按 tab 聚合）；page-tab 级 dirty 检测；保存 = 当前 tab 全部 group 依次 setGroup 原子提交（多 group 时按数组顺序 PUT）；取消 = 重置 draft 到 snapshot | MUST snapshot/draft 按 tab 隔离（避免 tab 间串扰）；MUST dirty 检测按 tab 整体；MUST NOT provider 编辑器进 dirty（独立流）；MUST observability/user_memory/web_search 例外不走 page-tab dirty | PRD 01 §3.2 | +60/-20 |
| config_page_ui | app/web/src/components/app-dev-config-page/section-default-models-and-request.tsx | SectionDefaultModelsAndRequest | 新增 | 模型 tab 第二+第三 group 渲染：playground 默认模型 group（chat/summary key-model-picker + x 清除）+ 请求设置 group（stall_tool_s + max_attempts key-number） | MUST key-model-picker 选了显示 x 清除（写 undefined 不删 record）；MUST key-number 默认值显示来自 DEFAULT_LLM_REQUEST_CONFIG（灰提示）；MUST 改两子字段保存时 PUT 完整 data（不丢其他字段）；MUST 文件 ≤300 行 | PRD 02 §3 + 02 §2.2；design-brief §1.4 | +180 |
| config_page_ui | app/web/src/components/common/component-key-model-picker.tsx | KeyModelPicker | 新增 | primitive：trigger button + dropdown（按 provider 分组）+ x 清除按钮；菜单按 enabled provider × enabled 文本 model 过滤；trigger 显「未配置」/「provider label / model label」 | MUST trigger 样式与 key-select 一致（variant=outline, height=32）；MUST x 点击 onChange(undefined)；MUST NOT 显示 disabled provider/model；MUST 复用既有 chat ModelPicker 的 provider/model 列表读取逻辑（提取到 lib/providers 或 hooks） | PRD 02 §3.3；design-brief §1.4 | +150 |
| config_page_ui | app/web/src/components/app-dev-config-page/section-config-layout.tsx | SectionConfigLayout | 修改 | 适配 tab 化（接收 group 列表渲染）；secret redact 路径不改 | MUST NOT 改 key-card 容器（保持 component-key-card 复用） | PRD 01 §3.1（清硬编码 hex） | +20/-10 |
| config_page_ui | app/web/src/components/app-dev-config-page/component-group-save-bar.tsx | GroupSaveBar | 修改（保留为 per-group 例外） | 仅 provider 编辑器 + observability list+detail + 各自 section 内使用（不进 page-tab dirty）；其它 section 走 page-tab save-bar | MUST 保留 per-group save-bar 在 provider/observability 场景；MUST NOT 在多 group tab 强制使用 | PRD 01 §3.2 例外 | +5/-2 |
| config_page_ui | app/web/src/components/app-dev-config-page/component-key-card.tsx | KeyCard | 修改 | 清硬编码 hex + 字体 weight 收敛（仅 400/600）；样式走 token | MUST NOT 改 props 接口；MUST testid 前缀 `key-card-*` 保持 | PRD 01 §3.1 视觉规范 | +10/-10 |
| config_page_ui | app/web/src/components/app-dev-config-page/section-web-search-config.tsx | SectionWebSearchConfig | 修改（仅搬位置） | section 内部交互不动；仅挂载点改到「工具 tab」 | MUST NOT 改 choice-cards 交互（type 选择保留） | PRD 01 §3 tab 映射 | +2/-2 |
| config_page_ui | app/web/src/components/app-dev-config-page/section-user-memory.tsx | SectionUserMemory | 修改（仅搬位置） | 挂载点改到「记忆 tab」 | MUST NOT 改 saveMode='item' | PRD 01 §3 tab 映射 | +2/-2 |
| config_page_ui | app/web/src/components/app-dev-config-page/observability-config/section-observability.tsx | SectionObservability | 修改（仅搬位置 + 端点改） | 挂载点改「可观测性 tab → langfuse group」；GET/PUT URL 从 `/config/dev?group=runtime&key=observability` 改 `/config/app?...`（同 group/key 名） | MUST secret redact 路径不变；MUST list+detail 独立 save-bar 保留 | PRD 05 §3.1.E；dev_config §3.4.1 | +5/-5 |

### I. chat_input_bar_model_picker — chat 模型选择器迁移（web/src）

> PRD 04 + design-brief §2。从 chat-topbar 挪到 chat-input-bar；菜单左上延伸；默认a + 完整列表 a 重复（双项语义）；subagent readOnly 不挂载。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| chat_input_model_picker | app/web/src/components/chat-page/component-input-model-picker.tsx | InputModelPicker | 新增 | chat-input-bar 内的模型图标 trigger：24×24 button + 16px icon + tooltip 三态（a(默认)/未配置/具体 b）+ 菜单左上延伸（菜单底部右下角对齐 trigger 左上角 + 4px gap）+ 双场景（配了 default→顶部分割区 a(默认) + 完整列表 a 重复；未配→仅完整列表） | MUST trigger `position: absolute; left:12px; bottom:8px` 不占排版流；MUST 菜单 width 280 max-height 400；MUST 选「a(默认)」→ onChange("default")；MUST 选列表里 a → onChange("<pid>:<aId>")；MUST session running 时 disabled；MUST 文件 ≤300 行；MUST tooltip 不导致位移；MUST testid 沿用 `chat-model-picker`（trigger）+ 新增 `model-picker-menu`/`model-picker-default-item`/`model-picker-item-<pid>-<mid>` | PRD 04 §2；design-brief §2；specs/ui/components/chat-page/component-input-model-picker.md（coder 前置产出） | +280 |
| chat_input_model_picker | app/web/src/components/chat-page/section-chat-detail.tsx | SectionChatDetail | 修改 | topbar 内 ModelPicker（非 readOnly 分支）移除；chat-input-bar div 内挂 `<InputModelPicker/>`；subagent readOnly 分支保持 chat-model-tag 在 topbar 不变 | MUST subagent readOnly 不挂 InputModelPicker；MUST playground + studio leader/mate 都迁移；MUST chat-input-bar testid 保持；MUST NOT 删 chat-model-tag（readOnly 分支仍用） | PRD 04 §2.1 + §3；chat-page/_overview.md §4 | +20/-15 |
| chat_input_model_picker | app/web/src/components/chat/ModelPicker.tsx | ModelPicker（默认导出） | 修改（保留为通用 primitive） | 保留为通用 primitive（供 squad 编辑页、default_models picker 等场景复用）；保留 chat-model-picker testid 给 InputModelPicker 沿用；不在 chat-topbar 直接挂载 | MUST NOT 删（仍被 squad 编辑页/key-model-picker 等复用）；MUST 默认 a + 完整列表 a 重复逻辑**只属于 InputModelPicker**（不在通用 ModelPicker 实现） | PRD 04 §5.1 复用；02 §3.3 | +5/-2 |
| chat_input_model_picker | app/web/src/components/chat-page/use-model-restore.ts | useModelRestore | 修改 | session.modelId === "default" 时 trigger 显示「默认 a」或「未配置」（按 default_models.chat 配置判定）；其余逻辑保持 | MUST 保留字 "default" 不视为具体 modelId；MUST resolve 显示用 default_models.chat（playground）/ squad.modelDefault（studio） | PRD 04 §2.4 三态；03 §2.1 | +8/-2 |
| chat_input_model_picker | app/web/src/components/studio-page/squad-edit-page.tsx (路径待 coder 确认) | SquadEditPage（summaryModelDefault picker） | 修改 | 加 summaryModelDefault 编辑器：key-model-picker + x 清除；PATCH /squad/:id 单独提交该字段 | MUST 单独 PATCH（不影响 modelDefault）；MUST x 清除写 undefined | PRD 03 §3.2；design-brief §3 | +30 |

### J. migration_script — 数据迁移脚本（merge 后用户执行）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| migration_script | scripts/migrate-dev-to-app.v0.0.89.sh | main | 新增 | bash 脚本：遍历 `dev_config/{group}/*.json` → 拷到 `app_config/{group}/`（保 id+key）；显式 skip `llm_request/stall_timeout_s` + `llm_request/max_retry_times` 死数据（log warn）；backup dev_config 到 `dev_config.backup-<ts>/`；rollback 失败已迁文件；exit 1 on fail；summary log `migrated: N, skipped: 2, failed: 0` | MUST 保 id + key 不变（ULID 全局唯一不需 regen）；MUST skip 死数据 + log warn；MUST 失败 rollback + backup；MUST NOT 自动删 dev_config（用户验证后手删）；MUST log 仅 record id（不 log data，防 secret 泄露） | PRD 05 §3.2；design-brief §4 | +120 |

### K. tech_specs — tech spec 文档更新（architect 阶段产出，N1-N8 落点）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tech_specs | specs/tech/config/[P0]app_config.md | §3 group 集合 + §3.7 default_models + §3.8-§3.13 迁组 + §3.1/§3.3 appearance 合并 | 修改 | §3 末尾 group 集合改 `{ appearance(含 language), providers, llm_request, user_memory, web_search, default_models(new), logs, runtime(observability), web, sub_agent_templates, agent, context }`；新增 §3.7 default_models shape；§3.8 logs shape；§3.9 runtime/observability shape（迁自 dev）；§3.10 web shape；§3.11 sub_agent_templates shape；§3.12/§3.13 agent/context shape；§3.1 改 appearance 含 theme+language 两 key；§3.3 locale 标 deprecated 后删 | MUST 与代码同步（doc-modifier 阶段 5 终态对齐）；MUST NOT 推翻既有 §3.2/§3.4/§3.5/§3.6（providers/llm_request/user_memory/web_search 不动） | PRD 02 §5.2 N1；05 §5.2 N2/N3 | +120/-15 |
| tech_specs | specs/tech/config/[P0]dev_config.md | 全文 | 修改（标 deprecated） | 文件顶部加 `> ⚠️ DEPRECATED（v0.0.89 起）：dev_config entity 已废弃，所有数据迁入 app_config（见 [P0]app_config.md）`；正文保留作历史 spec；index.md 删 dev_config 导航 | MUST 标 deprecated 但保留文档（历史参考）；MUST NOT 删文件（违反 doc-modifier 阶段 5 责任，仅 architect 阶段标 deprecated） | PRD 05 §5.2 | +5 |
| tech_specs | specs/tech/config/index.md | 导航 | 修改 | 删 DevConfigService 链接导航（或移到「历史」段）；AppConfig 加新 group 导航 | MUST 与 [P0]app_config.md §3 集合同步 | PRD 05 §5.2 | +3/-3 |
| tech_specs | specs/tech/config/log.md | v0.0.89 entry | 新增 | 加版本日志条目（dev_config deprecated + app_config 扩组 + default_models 新增 + appearance 合并 locale） | MUST 与 doc-modifier 终态对齐 | 原则#12 | +10 |
| tech_specs | specs/tech/squad/[P1]data_model.md | §1.1 squad interface | 修改 | interface 加 `summaryModelDefault?: string`（optional，空=回退 modelDefault）；§2 resolve 链注释（summary task fallback） | MUST optional；MUST 注明回退 modelDefault | PRD 03 §3.2 N4 | +5 |
| tech_specs | specs/tech/agent/session/[P0]session_store.md | §2 Session interface（modelId 字段注释） | 修改 | modelId 字段注释加：保留字 `"default"`=未手动选（跟随默认）；新建 session 默认 `"default"`；resolve 视为 undefined 继续走 fallback | MUST 仅注释更新（schema 类型不变，仍 string? optional） | PRD 03 §3.1 N5 | +3 |
| tech_specs | specs/tech/agent/providers_and_models/[P0]model_resolve.md | 全文 | 新增 | model resolve 统一抽象 spec：定义 resolveModel 函数签名 + 6 行 fallback 表（PRD 03 §2.1）+ ModelNotConfiguredError + `"default"` 保留字语义 + studio 不读 app_config 原则 | MUST 落 session 或 providers KB（任一即可，本表选 providers_and_models）；MUST 6 行表完整覆盖 playground/studio × chat/summary；MUST 含错误体 schema | PRD 03 §2/§5 N6；原则#11 | +120 |
| tech_specs | specs/tech/agent/providers_and_models/log.md | v0.0.89 entry | 新增 | 加 model_resolve.md 新建日志 | 原则#12 | +5 |
| tech_specs | specs/tech/agent/providers_and_models/index.md | 导航 | 修改 | 加 [P0]model_resolve.md 链接 | 原则#12 | +1 |
| tech_specs | specs/tech/agent/session/log.md | v0.0.89 entry | 新增 | session.modelId 保留字 default 注释更新 | 原则#12 | +3 |
| tech_specs | specs/tech/i18n/[P0]i18n_overview.md | §5.4 + §6 | 修改 | locale 改归 appearance group（GET/PUT 路径更新）；§6 后端 locale 链路结论保持 | MUST 与代码同步（changeLanguage 路径已改） | PRD 01 §4 | +5/-3 |

### L. ui_specs — UI 组件 spec 清单（coder 编码前置产出）

> 本段列 architect 阶段定的 spec 清单（不写具体 spec，由 coder 在编码前置阶段产出 `.md` + `.tsx` spec，规范见 `specs/ui/components/_conventions.md`）。N1/N7/N8 落点。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui_specs | specs/ui/components/app-dev-config-page/page-app-settings-merged.md | 全文 | 修改（大改） | sidebar flat list → tab 竖排导航树；page-tab 级 save-bar；外观 group 合并；新模型/工具/记忆 tab 映射 | MUST 与代码 page-app-settings-merged.tsx 同步；MUST 含 testid 契约（沿用 app-settings-system-toggle + 新增 tab-tree-item + tab-save-bar） | PRD 01 §6.2 N8；design-brief §1 | +60/-30 |
| ui_specs | specs/ui/components/app-dev-config-page/component-tab-tree-item.md | 全文 | 新增 | tab item primitive spec（label/icon/selected/disabled） | MUST primitive 规范；MUST testid `tab-tree-item-<id>` | PRD 01 §6.2 N8 | +30 |
| ui_specs | specs/ui/components/app-dev-config-page/component-tab-save-bar.md | 全文 | 新增 | page-tab 级 save-bar spec | MUST testid `tab-save-bar` + `tab-save-button` + `tab-cancel-button` | PRD 01 §3.2 | +30 |
| ui_specs | specs/ui/components/app-dev-config-page/section-default-models-and-request.md | 全文 | 新增 | 模型 tab 第二+第三 group section spec | MUST 含 default_models + 请求设置两 group 渲染规则 | PRD 02 §5.2 N1/N5 | +40 |
| ui_specs | specs/ui/components/common/component-key-model-picker.md | 全文 | 新增 | key-model-picker primitive spec（trigger + dropdown + x 清除） | MUST primitive 规范；MUST testid `key-model-picker-*` | PRD 02 §3.3 N1 | +50 |
| ui_specs | specs/ui/components/chat-page/component-input-model-picker.md | 全文 | 新增 | chat-input-bar 内模型选择器 spec（trigger 三态 + 菜单双场景 + 左上延伸 + 双项语义） | MUST 含三态语义表；MUST testid `chat-model-picker` 沿用 + `model-picker-menu` 等；MUST 视觉基线字段对齐 demo.html（如有） | PRD 04 §5.2 N7；design-brief §2 | +80 |
| ui_specs | specs/ui/components/chat-page/_overview.md | §4.X（input-bar 内 ModelPicker） | 修改 | 加条：input-bar 内挂 InputModelPicker（替代 topbar ModelPicker 在非 readOnly 分支）；§4.3 chat-model-tag（readOnly）保持 | MUST 与 _components.md 清单同步 | PRD 04 §5.2 N7 | +5 |
| ui_specs | specs/ui/components/chat-page/_components.md | 组件清单 | 修改 | 加 `component-input-model-picker` 条目 | 与 _overview.md 同步 | PRD 04 §5.2 N7 | +1 |
| ui_specs | specs/ui/components/_conventions.md | §9 视觉基线（如需） | 修改 | 加 v0.0.89 设计稿视觉基线字段规范（如有 demo.html 视觉契约） | MUST 仅增量更新（不推翻既有） | 原则#15；design-brief §6 | +5 |

### M. api_specs — API 文档同步（architect 阶段 + doc-modifier 阶段）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| api_specs | specs/api/version_logs/v0.0.89/change_log.md | 全文 | 新增 | API 增量：squad POST/PATCH/GET 加 summaryModelDefault；POST /session/:id/chat 错误体加 MODEL_NOT_CONFIGURED；PUT /session/:id body.modelId 接受 "default"；/config/dev 全部废弃；/config/app/sub_agent_templates 新增 | MUST 列全部废弃 + 新增端点；MUST 含示例 | PRD 03 §3.2 + §5.1 + 04 §5.2 + 05 §3.1.E | +120 |
| api_specs | specs/api/overall/11a-squad-endpoints.md | POST /squad + PATCH /squad/:id + GET /squad/:id（SquadDetail） | 修改 | body/response 加 `summaryModelDefault?: string` 字段；§1.1/§1.3/§1.4 同步 | MUST optional；MUST 响应体含字段（即使 undefined 也回显） | PRD 03 §3.2；N4 | +6 |
| api_specs | specs/api/overall/02-llm-chat.md | POST /session/:id/chat 错误体 + PUT /session/:id body.modelId | 修改 | 错误体加 `{code:"MODEL_NOT_CONFIGURED", message, detail}`（HTTP 400）；body.modelId 接受保留字 "default"/"none" | MUST 错误码闭合（code 字符串 enum 加 MODEL_NOT_CONFIGURED） | PRD 03 §5.1；04 §5.2 | +8 |
| api_specs | specs/api/overall/10-multi-agent.md | §5.2/§5.3 路由路径 | 修改 | `/config/dev/sub_agent_templates` → `/config/app/sub_agent_templates`；其它 dev 路由标 deprecated | MUST 路径前缀改 /config/app；MUST builtin 保护逻辑不变 | PRD 05 §3.1.C | +5/-5 |

## 影响面评估

### 跨模块影响顺序（依赖方向，底层先于上层）

1. **schema 层**（A 段）→ 独立，无依赖；先行
2. **service 层**（B 段 model-resolver + model-validation）→ 依赖 A；resolver 是新抽象，不动既有 handler 直接签名
3. **dev_config 消费方迁移**（F 段）→ 依赖 A（schema 删）；批量改读 appConfig；与 E 段路由删同步
4. **handler 改调用 resolveModel**（C 段）→ 依赖 B；6 处调用点（session-config/session-compact/session-messages/session-run/member/squad）
5. **路由层**（E 段）→ 依赖 F；删 /config/dev、加 /config/app/sub_agent_templates
6. **UI 层**（G/H/I 段）→ 依赖后端 API（M 段）；i18n → config_page → chat_input 顺序
7. **迁移脚本**（J 段）→ 独立 bash 脚本，merge 后用户执行
8. **spec 文档**（K/L/M 段）→ architect 阶段产出 tech + api；coder 编码前置产出 ui spec；doc-modifier 阶段 5 同步 overall

### 破坏性变更

- **dev_config entity 废弃**：所有 devConfig 消费方需同批迁移完成（F 段），不可分批；失败回退策略：保留 dev_config 文件（脚本不自动删，用户验证后手删）
- **/config/dev 路由废弃**：前端任何残留调用（DEV_GROUPS 已不在代码，但旧浏览器缓存/书签可能命中）→ 后端返 404；AT 覆盖验证
- **session.modelId 保留字**：旧 session `modelId=undefined` 视为 `"default"`（resolve 链统一处理，无 schema migration）；新建强制写 `"default"`

### 风险点

| 风险 | 缓解 |
|---|---|
| devConfig 消费方漏改（grep 兜底仍可能漏） | coder 阶段 `grep -rn 'devConfig\|dev_config\|DevConfigService' app/server/src --include='*.ts'` 必须为空（除 deprecated spec 文档）；CI typecheck 兜底 |
| resolveModel fallback 链顺序错（playground summary 第 2 步 session.modelId 须排除 "default"） | UT 覆盖 6 行表每行至少 1 case；AT 覆盖 P7/P8/P9 路径 |
| page-tab 级 save 按钮误把 provider 编辑器改动也提交 | provider 编辑器走独立 diff-save（POST/PUT/DELETE 三端点），不进 page-tab dirty 状态机；E2E UC-1.7 验证 |
| 迁移脚本误覆盖 app_config 已有 record | 脚本检测目标 record 已存在时跳过 + log warn（不覆盖）；backup dev_config |
| InputModelPicker 与既有 chat-model-tag（readOnly）共存冲突 | SectionChatDetail 分支：readOnly 分支挂 chat-model-tag（不变）；非 readOnly 挂 InputModelPicker；testid 命名空间隔离 |
| 外观合并 i18n 切即生效 vs page-tab 级保存语义冲突 | component-locale-card 保持切即生效（不走 page-tab dirty），其余 theme key 走 page-tab 流 |

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现 spec 概念与代码不符（如 DEV_GROUPS 实际已不在代码）→ 按代码实际调整 + 汇报偏离 → orchestrator 记 doc-sync 待办 → doc-modifier 阶段 5 统一修 spec（本表 K/L 段已对齐：DEV_GROUPS 仅在 dev_config.md 历史段落保留作 deprecated 注释）
