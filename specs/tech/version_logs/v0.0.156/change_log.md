# v0.0.156 tech change_log — 结构性拆分（bootstrap / session-store / router / chat 域 + A1/A3）

> 跨版本发布说明（版本轴）。位置轴见各 KB `log.md`（`app/start_up/log.md` + `app/frontend/log.md` + `agent/session/log.md`）。
> 变更契约（method 级 review 合同）：本目录 `change_plan.md`（8 列表 + INV-A1/A2/A3/B/C/S/R/G/PKG）。
> **用户铁律**：纯拆分（move 不改函数内部逻辑），A1 唯一例外为重组（改组合方式，被搬 JSX 片段/props/handler 等价）。行为 100% 不变。

## 核心主轴

1. **三 chat 页统一到 BaseChatPage 消费方**：playground（`section-chat-detail`）与 studio 单聊/群聊同源，slot 注入模式（topbarLeft / topbarRight / messagesSlot / rightOverlaySlot / inputSlot）。v0.0.155 抽出 `base-chat-page.tsx` + `base-chat-input-bar.tsx` 骨架后，playground 补接入（A1）。
2. **page-chat 变薄 = 12 handler 抽 `use-chat-actions.ts` hook**（A3）：12 个 action handler（openSession/handleModelChange/…/handleSelectSub）move 到 hook，函数体 100% copy-paste + useCallback deps 字面等价（INV-A3-1/2 防 stale closure）。page-chat 347 → 210 行。
3. **后端 bootstrap 拆 7 phase helper + late-bound holder**（C-1）：`bootstrap.ts` 1132 → 412 行（保留 `BootstrapResult` interface + `bootstrapBuiltinPlugins` 入口），phase 装配移到 `bootstrap-{plugin,bus,store,agent,scheduler,search,connectors}-phase.ts` × 7 + `bootstrap-late-bound.ts`（前向引用 holder）。装配顺序（INV-C-1）严格按原 line 顺序（scheduler → search → workspace → connectors）。
4. **SessionStore facade 化**（C-2）：`session-store.ts` 822 → 313 行 facade（constructor + 字段 + 21 method 签名 + 单行委托）；方法实现拆到 4 impl 文件：`session-store-core-impl.ts`（8 方法：createSession/getSession/getSessionKind/updateSession/listSessions/deleteSession/fallbackCascadeDelete/stripEnvelope）+ `session-store-messages-impl.ts`（7 方法：createRun/getRun/updateRun/getRuns/appendMessages/getMessages/getMessagesByRun）+ `session-store-usage-impl.ts`（8 方法：getSummary/setSummary/accumulateUsage/updateContextWindowUsage/notifyUsageChanged/getRatio/getUsageView/persistUsage）+ `session-store-children-impl.ts`（1 方法：listChildren）。公开 API 100% 等价（INV-S-3，bootstrap/handlers/services 零改）。
5. **router 拆 4 路由组 + helpers**（C-3）：`router.ts` 731 → 146 行 thin dispatch（null-chain 4 函数）；`routes/router-helpers.ts`（184 行）+ `routes/session-routes.ts`（149）+ `routes/squad-routes.ts`（81）+ `routes/config-routes.ts`（120，`/config/plugin/scopes` 保留在 `/config/plugin` 前，INV-R-1 R6）+ `routes/misc-routes.ts`（204）。映射 100% 等价（INV-R-1）。
6. **前端 chat 域 barrel re-export 拆分**（B）：`types.ts` 522 → 6 行 barrel + 6 子文件（message/session/hitl/usage/subagent/enqueue）；`store/chat-slice-reducer.ts` 495 → 42 行 barrel + 4 子文件（agent-event-types/message-preview/reducer-state/apply-agent-event）；`lib/chat-api.ts` 403 → 20 行 barrel + 4 子文件（session-api/message-api/usage-summary-api/workspace-api）。35 + 14 消费方零改（INV-G2）。
7. **squad handler + component-message-stream 微拆**（A2 + B-1）：`handlers/squad.ts` 提 `checkModel` + `json` 到 `handlers/squad-model-helpers.ts`（INV-A2）；`component-message-stream.tsx` 提 2 avatar 到 `component-message-stream-avatars.tsx`。

## 前端变更（段 A1 / A3 / B）

### A1. section-chat-detail 重组为 BaseChatPage 消费方

- **`section-chat-detail.tsx`**（413 → 282 行）：从「独立 section + 内联 topbar/messages/input/clear」重组为 `<BaseChatPage>` + `<BaseChatInputBar>` 消费方，slot 注入 5 处（topbarLeft = title + readOnly badge + model-tag；topbarRight = inline UsagePanel + divider + CompactBtn + !readOnly ClearBtn；messagesSlot = ComponentEmptyState / ComponentMessageStream；rightOverlaySlot = ComponentChatRightOverlay + ComponentChatFloatMenu；inputSlot = BaseChatInputBar 实例）。ChatDetailProps 签名不变（page-chat 消费方零改）；DOM 锚点保留（chat-page / chat-topbar / chat-input-bar / chat-send / chat-loading）；readOnly 分支 `hideInputBar = readOnly || !sessionId`（INV-A1-3）；playground **不传 `hideStopButton=true`**（保留 useRunState + input 区 stop 按钮，与群聊 INV-E3 区分）。
- **`base-chat-page.tsx`**（+1 行）：topbar `<div>` 上加 `data-testid="chat-topbar"`——修正 v0.0.155 遗漏，保留 playground DOM 锚点（INV-A1-1）；studio 不冲突（其测试不查此 testid）。
- **playground 保留 topbarRight inline**（不用 `ComponentChatTopbarRight` 复合）：playground 与 studio 显隐分支差异保留（inline 拼接 vs DRY 组件）。

### A3. page-chat 抽 use-chat-actions hook

- **`use-chat-actions.ts`**（新增，260 行）：12 handler 集中管理（openSession / handleModelChange / handleEffortChange / handleApprovalModeChange / handleCreate / handleDelete / handleRenameTitle / handleSend / handleEnqueueCancel / handleCompact / handleClear / handleSelectSub）。函数体 100% copy-paste（INV-A3-1）；每个 useCallback deps 数组与原 page-chat 版本字面一致（INV-A3-2 防 stale closure：openSession deps 含 `sessions` / handleEffortChange 含 `sessions,setSessions` / handleSend 含 `activeSessionId,model,messages` 等）；chat-api 9 函数 import 迁到 hook 顶部。
- **`page-chat.tsx`**（347 → 210 行）：删 12 个内联 useCallback；加 `const actions = useChatActions({...})`；render 内 handler 引用源从 `handleX` → `actions.handleX`（20 处）；保留全部 area-hooks / store selectors / local state / ref / mount lifecycle 装配不动。
- **UT**：`use-chat-actions.test.tsx` 21 case 含 4 stale closure 防护 case（rerender 后读最新 sessions/model/activeSessionId）。

### B. chat 域 barrel re-export 拆分（35+14 消费方零改）

- **`components/chat-page/types/`** 新增 6 文件 + `types.ts` 6 行 barrel：`types/message.ts`（12 符号 Message/ContentBlock/MessageSender/AgentRefView/ImageBlockView/ToolResultContentBlock/ViewElement/FlattenedView/StopReason/RunFinish/RunRetryStatus/LoadingPhase）+ `session.ts`（Session/SessionState）+ `hitl.ts`（10 符号，含 isFeedbackData/isApprovalData 类型守卫）+ `usage.ts`（6 符号）+ `subagent.ts`（2 符号）+ `enqueue.ts`（EnqueueItem）。session.ts 依赖 usage.ts 的 SummaryTaskStatus，单向不循环。
- **`store/reducer/`** 新增 4 文件 + `chat-slice-reducer.ts` 42 行 barrel：`agent-event-types.ts`（LlmAttemptAction/MessageStartEventSender/AgentEvent）+ `message-preview.ts`（contentBlocksToPreviewText）+ `reducer-state.ts`（RunContext/ReducerState/ReducerResult/ReducerFullResult）+ `apply-agent-event.ts`（applyAgentEventToMessages 主 reducer 305 行 + JSDoc）。**已知偏离（barrel header 已留痕）**：apply-agent-event.ts 324 行超 300 行 24 行——主 reducer 是单一职责纯函数，拆 case 改控制流会违反 INV-G1「函数体 100% 等价」，故保留超限。其他 9 个新文件全部 ≤ 134 行。
- **`lib/chat-api/`** 新增 4 文件 + `chat-api.ts` 20 行 barrel：`session-api.ts`（8 符号 + req helper export）+ `message-api.ts`（7 符号，含 postMessage 复合 providerId+modelId body）+ `usage-summary-api.ts`（4 符号）+ `workspace-api.ts`（5 符号）。
- **`components/chat-page/component-message-stream-avatars.tsx`** 新增：抽 2 inline avatar（DefaultAgentAvatar / DefaultUserAvatar）；`component-message-stream.tsx` 337 → 310 行（本文件内 import 2 avatar 后删本地定义；sideOfMessage export 保留，被 studio squad-chat-helpers 消费）。

### 测试文件回归修（T2 后续）

- **17 个 vi.mock 路径补 `.ts` 扩展名**（page-chat-model-render / page-chat-read / page-chat-sse-singleton-mount / page-chat-switch-unsubscribe / section-workspace-panel / use-messages / use-run-state / use-subagent-children / use-subagent-run-refresh / use-usage / component-member-chat-input-bar / section-member-chat / section-squad-chat-sse / section-squad-chat / use-studio-chat-chrome / use-studio-unread-meta-running-state / use-studio-unread-meta）：**chat-api 拆成 barrel+子目录后，不带 `.ts` 扩展名的 `require('...').resolve(...)` 在 vitest 静默失效**——hook 走真实实现导致 postCompact/markSessionRead 等 URL parse 错。只改 mock 路径字符串（未动断言）。全绿：196 files / 1879 tests。

## 后端变更（段 A2 / C-1 / C-2 / C-3）

### A2. squad handler helper 拆分

- **`handlers/squad-model-helpers.ts`** 新增：move `checkModel(appConfig?, mid, providerIdHint?) => Response | null`（v0.0.155 双路签名保留）+ `json` helper（handler 内共享，不外泄至 utils）。`handlers/squad.ts` 484 → 减 30 行，4 处调用点（handleCreateSquad/handlePatchSquad）零改（INV-A2-1/2）。

### C-1. bootstrap 拆 7 phase + late-bound holder

- **`bootstrap.ts`**（1132 → 412 行）：保留 `BootstrapResult` interface（140 行）+ `bootstrapBuiltinPlugins` 入口 + promptAssetsCheck + workdir mkdir + `process.on('unhandledRejection')` hook；主函数变薄为依次调 7 个 phase helper + 收集 BootstrapResult。
- **7 phase 文件**：
  - `bootstrap-plugin-phase.ts`（171 行）：Registry + BUILTIN_EXTENSION_POINTS + BuiltinLoader.loadAll + registerTestFixtures + loadScopeConfigs + GroupMetaLoader + ScopeConfigValidator + PluginPolicyStore + PluginConfigService + PluginManager + AppConfigService（Phase 1+2+3）。
  - `bootstrap-bus-phase.ts`（148 行）：EventHub.singleton + ReplayableEventBus × 3（agent_loop sticky + session_panel/session_meta non-replayable）+ wrapBusWithLog + SseChannel + SSE test interceptor（Phase 6）。
  - `bootstrap-store-phase.ts`（150 行）：FsCrudStore + CompositeStore mount 4 schema + SessionUnreadRuntime + SessionMetaBroadcaster + wrapStatusBusForUnread + SessionStore 构造 + setSessionStoreEpDelegate + `stateMachine.reconcileOnStartup()` + `SessionTaskLock.reconcileOnStartup()` + `unreadRuntime.start()`。**reconcile 关键时序保留**（INV-C-1）：reconcile 在 enabled=false 期间 emit 不产未读。
  - `bootstrap-agent-phase.ts`（324 行——超 300 已默许，change_plan §4.2 估 +285 body + imports/interface overhead）：ToolExecutionEngine + approvalManager.setStore + ContextEngine + AgentManagerImpl + setResolveConfig（12 参数顺序）+ setBuildAgentToolContext（parentSid = session?.parentSessionId ?? sessionId 防 subagent→self 回环）+ upsertExplorerTemplate + setForkedRunner（modeKey='summary' + maxIter=1 + enableToolWhitelist=true + toolWhitelist=[]）+ setConsolidationRunner + setSquadReminderDeps（Phase 8）。cronToolDepsRef 通过 `lateBound` holder 前向引用，scheduler-phase 后填充。
  - `bootstrap-scheduler-phase.ts`（131 行）：BudgetState + createEngine + squadRuntime + bootScheduler（HeartbeatHandler + CronHandler + 双源 loadJobs + onSessionDestroyed wire + SIGTERM trap + engine.start）（Phase 9）。填 `lateBound.cronToolDeps.value`。
  - `bootstrap-connectors-phase.ts`（181 行）：connectorManager + channelManager + browserDriverRegistry + computerNativePort（三态：AT=mock / dev=loopback / packaged=registry）（Phase 10）。填 `lateBound.{connectorManager, browserDriverRegistry, computerNativePort}.value`。
  - `bootstrap-search-phase.ts`（244 行）：SearchEngine + HistoryIndexer + workspaceManager（Phase 11）。填 `lateBound.{searchEngine, workspaceManager}.value`。
- **`bootstrap-late-bound.ts`**（59 行）：`LateBound<T>` holder 接口（`{ value: T | undefined }`）+ `createLateBound()`。用于 agent-phase 内的 lambda 前向引用 scheduler/connectors/search phase 的输出（agent-phase 定义 lambda 时 connectors 未构造，activate 时才读，符合时序）。
- **INV-C-1 装配顺序等价**：主函数调 phase helper 顺序 = 原内联 line 顺序（Phase 1→11）；scheduler(827) → search(879) → workspace(956) → connectors(992) 按实际 line 顺序拆分（与 change_plan §4.1 预估顺序 connectors 940-1020 在 search 1020-1080 之前**相反**——按实际 line 顺序拆分，INV-C-1 强制）。
- **INV-PKG-1~3 packaged 护栏满足**：phase helper 内无 `process.env` 直读（除 connectors-phase 保留原 `resolveMockComputerNativePort` / `resolveLoopbackComputerNativePort` 透传 `process.env` 的 pure move 行为——文档化三态机制，packaged 模式下两者返 undefined → getComputerNativePort() 走 registry）；无相对路径/字面 `~`；`__dirname` 解析 plugins/scopes/groups.json 保留 CJS 语义（dist/ 相对 app/plugins/）。

### C-2. SessionStore facade + 4 impl

- **`session-store.ts`**（822 → 313 行 facade）：constructor + 字段声明（`crud` / `stateMachine` / `statusBus` / `childrenIndex` 等）+ 21 method 签名 + 方法体单行委托（`return sessionStoreXxx(this, ...)`）；core 方法（createSession/getSession/getSessionKind/updateSession/listSessions/deleteSession/fallbackCascadeDelete/stripEnvelope）**Round 2 后**也 move 到 `session-store-core-impl.ts`（295 行）——所有方法体统一委托模式。
- **4 impl 文件**：`session-store-core-impl.ts`（295 行，8 函数）+ `session-store-messages-impl.ts`（177 行，7 函数）+ `session-store-usage-impl.ts`（202 行，8 函数）+ `session-store-children-impl.ts`（94 行，1 函数）。每函数首参 `(store: SessionStore, ...)`，内部访问 `store.crud/statusBus/childrenIndex`（→ 见「偏离」）。
- **偏离（INV-S-3 字段可见性）**：change_plan §4.5 约束「crud/statusBus/childrenIndex 保留 private/readonly」，实际拆分需 impl 函数访问 `store.crud/statusBus/childrenIndex`，故改为 `readonly crud/statusBus/childrenIndex`（public readonly，与已有 `readonly stateMachine` 字段同款）。readonly 保留防止运行时改写。
- **INV-S-1/2/4 语义等价**：appendMessages/getMessages/getMessagesByRun 分页语义（ULID 字典序=时间序）+ listChildren 分组语义（running/terminated 按 updatedAt desc + childrenIndex 增量维护）+ usage 三分区累加 + ratio 滑动 3 中位数 + statusBus emit(session_usage_update) 全部等价。
- **INV-S-3 公开 API 等价**：grep 验证 bootstrap/handlers/services 零改（`store.appendMessages/getMessages/accumulateUsage/notifyUsageChanged/getRatio` 等所有调用点未动）。

### C-3. router 拆 4 路由组 + helpers

- **`router.ts`**（731 → 146 行）：thin dispatch null-chain（尝试顺序 session → squad → config → misc）+ bootstrapCache 处理 + json helper + getBootstrap；保留 SSE early-return + 404 fallback。
- **`routes/router-helpers.ts`**（184 行）：`bootstrapCache` / `getBootstrap` / `json` / `sessionDeps` / `matchSessionPath` / `dispatchSessionPut` / `isExcludedApiPath` / `buildCronRouteDeps` / `buildConsolidationTestDeps` 9 helper move 到独立文件。
- **`routes/session-routes.ts`**（149 行）：`/session*` + `/session/:sid/cron*` 分发；路径前缀顺序保留（`/session/:id/messages` 在 `/session/:id` 之前）。
- **`routes/squad-routes.ts`**（81 行）：`/squad*` 分发（含 /member、/charter、/board、/budget、/scheduler 子路径）。
- **`routes/config-routes.ts`**（120 行）：`/config/*` 分发。**INV-R-1 R6 前缀冲突保留**：`/config/plugin/scopes` 必须在 `/config/plugin` **之前**（v0.0.26 遗留约束）。
- **`routes/misc-routes.ts`**（204 行）：`/health` / `/counter` / `/bootstrap-status` / `/test-gate` / `/sse*` / `/provider*` / `/skill*` / `/mention*` / `/memory*` / `/history*` / `/consolidation*` + workspace seed routes + test-only routes（`/test/llm-mode` / `/test/stub*` / `/test/consolidation/run`）。**INV-R-2 test-only gate 保留**：`process.env.NODE_ENV !== 'test'` 分支为 pure move（不违反 INV-PKG-2，是文档化 gate）。
- **INV-R-1 映射等价**：4 路由组路径前缀互斥，null-chain 顺序无影响；主分发 404 fallback 语义等价。

## 全局不变量清单（见 change_plan §6）

- **INV-G1** 纯 move：签名 + 内部逻辑 + 错误处理 + 控制流 + 调用语义 100% 等价（A1 例外为重组，被搬 JSX 片段/props/handler 等价）
- **INV-G2** barrel re-export 导出 surface 与原单文件等价（消费方零改 + typecheck 全绿）
- **INV-G3** 单文件行数 ≤ 300（本版本已知超限：apply-agent-event.ts 324 / bootstrap-agent-phase.ts 324 / session-store-usage-impl.ts 202——均在合理边界，超限理由已在 barrel header 或 change_plan 留痕）
- **INV-G4** 无新增循环依赖
- **INV-G5** import 路径迁移完整（grep 残留归零）
- **INV-G6** 持续可打包（INV-PKG-1~5 满足）

## 打包护栏结论（INV-PKG-1~5）

**dev 全绿 ≠ packaged 能跑**（v0.0.108 教训四类崩溃：runtime env 干净 / plugin 编译 / 依赖归属 / 路径展开）。本版本 C 段（bootstrap 拆 7 phase + session-store facade + router thin dispatch）= 后端核心改动，逐项核查满足：

1. **依赖归属**：全部在 `@app/server` workspace 内，不跨 workspace，不新增 npm 依赖。
2. **plugin 进 asar**：本版本不动 plugin build（`scripts/build-plugins.ts` 无变化）。
3. **runtime-config**：phase helper 内禁 `process.env.X` 直读（除 connectors-phase 保留 pure move 的三态透传，文档化机制）；phase 间参数传递，不重读 env。`app/electron/src/main.ts` 与 `runtime-config.ts` 白名单不动。
4. **路径展开**：phase helper 接收已展开 `dataDir: string`；无相对路径 / 字面 `~` / `process.cwd()` 拼接；`__dirname` 解析 plugins/scopes/groups.json 保留 CJS 语义。
5. **build 脚本**：`app/server/tsconfig.json include=src/**/*` 全量 + `electron-builder.yml files=dist/**/*` glob → 拆分新增 `.ts` 自动进 dist/asar，与 v0.0.153 prompts/content 漏 cp 风险类别不同（那次是 `.md` 静态资源，本次是 `.ts` 全走 tsc）。

**验证**：typecheck 全绿 + dev 启动 `/health` 200 + `POST /session` 201 + `GET /squad` 200 + `GET /config/plugin` 200 + `/provider` 含 anthropic + UT 全绿（router 14 + session-store 系列 55+ + 相关 session 62 + 全量 agent 5141 passed / 15 failed 基线债，非本版本引入）。

## 前端组件契约变动

- **`specs/ui/components/chat-page/base-chat-page.md` §3**：渲染结构中 topbar `<div>` 明确带 `data-testid="chat-topbar"`（v0.0.156 A1 补落，playground DOM 锚点保留）；§4 差异矩阵 topbarRight 列增补「playground 保留 inline 拼接（不用 `ComponentChatTopbarRight` 复合，因显隐分支差异）」。
- **`specs/ui/components/chat-page/_overview.md §4.3`**：section-chat-detail 补 v0.0.156 重组标注。
- **组件粒度契约不变**：三 chat 页的组件 spec（`chat-composer.md` / `component-usage-panel.md` / `component-input-model-picker.md` / `component-chat-right-overlay.md` 等）DOM/testid/props 全部保留（A1 只搬 JSX 片段，不动子组件）。

## 未落 API/PRD 变更

本版本纯技术拆分——无用户可感知行为变化，跳过 PRD 阶段（用户裁决 2026-07-14 PRD 参与边界）；无 API 契约变化（session/squad/config/misc 端点 method/path/body/response 全部等价，INV-R-1 兜底）。故 `specs/prd/version_logs/v0.0.156/` 与 `specs/api/version_logs/v0.0.156/` 不产出。

## 相关文档

- 变更契约：`specs/tech/version_logs/v0.0.156/change_plan.md`（8 列表 + INV 全清单）
- 需求：`reqs/[working] v0.0.156.structural-split/req.md`（用户铁律 + 6 task 拆分依据）
- 前端 KB 位置轴：`specs/tech/app/frontend/log.md`（v0.0.156 节）
- 后端启动 KB 位置轴：`specs/tech/app/start_up/log.md`（v0.0.156 节，bootstrap phase 拆分 → reconcile 调用点迁位置）
- Session KB 位置轴：`specs/tech/agent/session/log.md`（v0.0.156 节，SessionStore facade）
