# v0.0.151.t2_consolidate 变更计划书 — 天级 t2 整理任务

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 上游依据：`specs/prd/version_logs/v0.0.151.t2_consolidate/change_log.md`（PRD v1.1）+ `states/user_query.md` v0.0.151 段（用户裁决）+ `specs/tech/agent/memory/[P0]consolidation_tier2.md`（业务设计）+ `specs/tech/scheduling/[P1]consolidation_job.md`（调度接线，含 §7 test-only 端点架构落点）+ `specs/tech/config/[P0]app_config.md §3.16`（config schema）+ `specs/api/overall/03-config-center.md §2.6/§2.7`（生产 API 契约）+ `specs/api/version_logs/v0.0.151.t2_consolidate/change_log.md`（test-only 端点契约，AT 可测性补充，orchestrator 2026-07-15 追加要求）。

## 变更清单

### 模块：memory/consolidation_tier2（tier2 业务逻辑，新目录）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| memory/consolidation_tier2 | `app/server/src/agent/consolidation-tier2/runner.ts` | `runConsolidationTier2(deps): Promise<ConsolidationTier2Result>` | 新增 | 自洽业务函数——第一步调 `resolveConsolidationModel` 做 skip 判定，可用时三段串行编排：`await consolidateGlobalSkills → await consolidateGlobalMemory → for session of eligible: await consolidateSessionMemory`；汇总 `summary` 一句话文本 | MUST 严格串行（不 `Promise.all`）；MUST NOT 并行任何一段；单个 session 失败 try/catch 吞掉继续下一个（best-effort）；MUST 被 `ConsolidationJobHandler.fire()` 与 `handleTestConsolidationRun` 两条调用方共同复用（不重复实现 skip 逻辑） | `[P0]consolidation_tier2.md §3/§5` | +95 |
| memory/consolidation_tier2 | `app/server/src/agent/consolidation-tier2/global-skill.ts` | `consolidateGlobalSkills(deps): Promise<BlockResult>` | 新增 | 预取 `SkillResolver.resolveAll(dataDir, undefined, enabledStore)` 全量 entry → 构造 synthetic snapshot/config → `agentManager.forkedRun({sessionId:'consolidation:global', ...})` | MUST 用虚拟哨兵 sessionId；MUST NOT 走 `buildSessionConfigFromDeps`（会触发 skill catalog 注入） | `[P0]consolidation_tier2.md §5` + `agent_loop_forked.md` | +70 |
| memory/consolidation_tier2 | `app/server/src/agent/consolidation-tier2/global-memory.ts` | `consolidateGlobalMemory(deps): Promise<BlockResult>` | 新增 | 预取 `new UserMemoryService(appConfig).list({includeArchived:true})` 全量 entry → 同构 forkedRun 调用（虚拟哨兵 sessionId） | 同上 | `[P0]consolidation_tier2.md §5` | +65 |
| memory/consolidation_tier2 | `app/server/src/agent/consolidation-tier2/session-memory.ts` | `consolidateSessionMemory(deps, session): Promise<BlockResult \| 'skipped'>` | 新增 | 双重 skip 判定（Skip A：`session.updatedAt` 早于窗口起点；Skip B：`listEntries(dataDir, sid, {includeArchived:true})` 为空）→ 未 skip 时预取全文+`sessionStore.getSummary(sid)` → forkedRun（真实 sessionId） | MUST 在调用 LLM 前完成两个 skip 判定（零 LLM 调用路径）；MUST 用真实 session id（memory_manage scope=session 依赖 `ctx.config.sessionId`） | `[P0]consolidation_tier2.md §3/§5.2` | +85 |
| memory/consolidation_tier2 | `app/server/src/agent/consolidation-tier2/model-resolve.ts` | `resolveConsolidationModel(appConfig): {providerId, modelId} \| null` | 新增 | 读 `appConfig.get('consolidation','default')?.modelId` → `listEnabledProviders(appConfig).find(p => p.models.some(m => m.modelId === modelId))` 反查 providerId；未配置/反查失败返 `null` | MUST NOT 复用 `resolveModel()`（session/squad/member 语境不适用）；MUST 复用既有 `listEnabledProviders`（`handlers/session-deps.ts`，不改其签名） | `[P0]consolidation_tier2.md §5.4` | +25 |
| memory/consolidation_tier2 | `app/server/src/prompts/handlers/consolidation-tier2-handler.ts` | `ConsolidationTier2PromptHandler`（class，extends `PromptHandler`） | 新增 | 读 `consolidation_tier2.md` content 文件 + 替换占位符（域清单/session 全文/summary/容量上限数字）产出三种工作块各自的 task message；`build()` 支持按 `ctx.vars.block` 分支拼不同数据段 | MUST extends `PromptHandler`（复用 `readContent`/`fillTemplate`，不重实现文件缓存）；MUST NOT 复用 tier1 `ConsolidationHandler`/`consolidation.md`（职责不同） | `[P0]consolidation_tier2.md §6` + `prompts/prompt-handler.ts` | +50 |
| memory/consolidation_tier2 | `app/server/src/prompts/content/consolidation_tier2.md` | （prompt 正文资源，无代码符号） | 新增 | 4 阶段文案（Orient/Gather/Consolidate/Prune）+ 安全约束文案（never 物理删除，只 archive/disable）+ `{{domain}}`/`{{entries_list}}`/`{{capacity_limit}}`/`{{session_memory_full}}`/`{{session_summary}}` 占位符 | MUST 沿用「只 archive/disable，不物理删除」措辞（与 tier1 `consolidation.md` 一致） | `[P0]consolidation_tier2.md §6` | +45 |

### 模块：scheduling/consolidation_job（调度层接线）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| scheduling/consolidation_job | `app/server/src/scheduling/payloads.ts` | `ConsolidationPayload`（interface） | 新增 | 新增空 payload 类型（`{}`——三段工作输入现读 app_config，不进 payload 快照） | MUST 保持空（不缓存 modelId/容量上限到 payload） | `[P1]consolidation_job.md §2` | +8 |
| scheduling/consolidation_job | `app/server/src/scheduling/handlers/consolidation-handler.ts` | `ConsolidationJobHandler`（class，implements `JobHandler`） | 新增 | `fire(job, now)`：纯调度 glue——读 app_config→调 `runConsolidationTier2`（内部含模型反查/skip 判定）→写 `lastResult`→推进 `lastFiredAt`（gate chain 见 §4） | MUST 除"读 app_config 本身失败"外，几乎每次 fire 都调 `engine.updateJobLastFiredAt`（显式偏离 `scheduling/index.md §④ 原则2`，见参考）；MUST try/catch 自吞异常；MUST NOT 在本类里重复实现模型反查/skip 判定（已内聚进 `runConsolidationTier2`） | `[P1]consolidation_job.md §4` + `scheduling/index.md §④ 原则13` | +50 |
| scheduling/consolidation_job | `app/server/src/handlers/test-consolidation-run.ts` | `handleTestConsolidationRun(deps): Promise<Response>` | 新增 | test-only 同步触发：调 `runConsolidationTier2(deps)` → 写 `lastResult`（`ConsolidationPersistenceAdapter.writeLastResult`）→ 200 返回完整 `ConsolidationTier2Result` | MUST NOT 触碰 `Job.lastFiredAt`（防止静默扰动真实调度 job 的下次到点计算）；MUST 在 handler 层再做一次 `NODE_ENV!=='test'` gate（防被绕过 router 直调）；MUST NOT 接受任何覆盖 `app_config.consolidation` 的请求参数 | `specs/api/version_logs/v0.0.151.t2_consolidate/change_log.md` + `[P1]consolidation_job.md §7` | +35 |
| scheduling/consolidation_job | `app/server/src/router.ts` | 路由分发（新增 `path.startsWith('/test/consolidation')` 分支） | 修改 | `NODE_ENV!=='test'`→404；`path==='/test/consolidation/run' && method==='POST'` → `handleTestConsolidationRun` | MUST 放在既有 `/test/stub`/`/test/llm-mode` 分支旁（同款 gate 位置，`router.ts:484-502`）；MUST NOT 影响这两个既有分支的匹配顺序 | `specs/api/version_logs/v0.0.151.t2_consolidate/change_log.md` + `router.ts:487-502`（既有 `/test/llm-mode`/`/test/stub` 分支，模式参考） | +10 |
| scheduling/consolidation_job | `app/server/src/scheduling/persistence/consolidation-adapter.ts` | `ConsolidationPersistenceAdapter`（class，implements `PersistenceAdapter`） | 新增 | 落盘 `{dataDir}/consolidation/state.json`；额外方法 `readLastResult()`/`writeLastResult({lastRunAt, summary})`（供 §2.7 状态端点 + handler 写入用） | MUST 与 `app_config.consolidation`（用户配置）完全分离存储（防 UI 保存覆盖系统状态） | `[P1]consolidation_job.md §2.1` | +55 |
| scheduling/consolidation_job | `app/server/src/scheduling/consolidation-cron.ts` | `dailyTimeToCron(dailyTime: string): string` | 新增 | `"HH:mm"` → `"M H * * *"` 固定公式转换（同 `component-cron-freq-picker.md` 每天预设公式） | MUST NOT 引入通用 cron 构造器（YAGNI，只做这一种固定形态） | `[P1]consolidation_job.md §5` | +12 |
| scheduling/consolidation_job | `app/server/src/scheduling/boot.ts` | `BootSchedulerDeps`（interface） | 修改 | 新增字段 `appConfig: AppConfigService`、`pluginManager: PluginManager`、`dataDir: string`（consolidation 装配需要，heartbeat/cron 现有字段不变） | MUST NOT 改动现有字段语义 | `[P1]consolidation_job.md §6` | +6 |
| scheduling/consolidation_job | `app/server/src/scheduling/boot.ts` | `bootScheduler(deps): Promise<BootSchedulerResult>` | 修改 | 新增第 6 步：读 `deps.appConfig.get('consolidation','default')`；`enabled===true` 时 `resolveConsolidationModel` 校验通过后构造 `Job`（`registry.register('consolidation', handler)` + `engine.register(job)`）；`enabled` 非 true 或模型不可用**仍注册 job**（modelId 缺失是 handler 内部业务 skip，非 boot 门槛——见 tier2 spec §5.4 例外） | MUST 仅在 boot 时执行一次（不监听后续配置变化，boot-time-only）；MUST NOT 在 `enabled===false` 时注册 job | `[P1]consolidation_job.md §3` | +40 |
| scheduling/consolidation_job | `app/server/src/bootstrap.ts` | `bootScheduler(...)` 调用点 | 修改 | 调用处透传新增依赖 `appConfig`/`pluginManager`/`dataDir`（均已在 bootstrap 作用域内构造，非新构造） | MUST NOT 新建重复的 `AppConfigService`/`PluginManager` 实例（复用 bootstrap 既有单例） | `[P1]consolidation_job.md §6` | +5 |

### 模块：api/consolidation-status（新端点）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| api/consolidation-status | `app/server/src/handlers/consolidation-status.ts` | `handleConsolidationStatus(adapter: ConsolidationPersistenceAdapter): Response` | 新增 | 调 `adapter.readLastResult()` → `{lastRunAt, summary}`（无历史返 `{lastRunAt:null, summary:null}`） | MUST NOT 抛 404（"无历史"是合法状态）；仅读，无副作用 | `specs/api/overall/03-config-center.md §2.7` | +20 |
| api/consolidation-status | `app/server/src/router.ts` | 路由分发（新增 `if (method==='GET' && path==='/consolidation/status')` 分支） | 修改 | 挂载新路由，对齐既有 `GET /history/search` 同款直接分支模式（`bs.<adapter>` 装配缺失时可仿 503 兜底） | MUST 放在通用 404 兜底之前；MUST NOT 影响既有 `/config/app`、`/session/*` 等路由匹配顺序 | `specs/api/overall/03-config-center.md §2.7` + `router.ts:658` 既有模式 | +8 |

### 模块：config/app_config（schema，已落 spec，无独立后端类型文件——沿用 default_models 的裸 KV 读模式）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| config/app_config | `app/server/src/scheduling/handlers/consolidation-handler.ts` | `ConsolidationAppConfig`（inline interface，colocate 在 handler 文件） | 新增 | `{enabled:boolean; dailyTime:string; modelId?:string}`——本地类型断言，非导出契约（沿用 `default_models`/`model-resolver.ts` 的裸 KV 内联 cast 惯例，不新建独立 schema 文件） | MUST NOT 新建独立 `consolidation-config-types.ts`（YAGNI，与 default_models 同惯例） | `[P0]app_config.md §3.16` | +8 |

### 模块：ui/app-dev-config-page（前端 tab + section）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui/app-dev-config-page | `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts` | `TabId`（type union） | 修改 | 新增 `'consolidation'` 成员 | MUST 保持既有 7 个成员不变（`general\|session\|models\|tools\|memory\|observability\|plugin`） | `page-app-settings-merged.md` testid 表 | +1 |
| ui/app-dev-config-page | `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts` | `ConsolidationData`（interface） | 新增 | `{enabled: boolean; dailyTime: string; modelId?: string}`（镜像 `DefaultModelsData` 结构） | — | `section-consolidation-config.md §Props` | +6 |
| ui/app-dev-config-page | `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts` | `APP_SETTINGS_TABS`（const array） | 修改 | 新增一项 `{id:'consolidation', labelKey:'tab.consolidation.label', groups:['consolidation'], inSystemArea:true}`（插入 observability 之后、plugin 之前） | MUST `inSystemArea:true`（系统设置收起区，同 observability/plugin） | `page-app-settings-merged.md` tab→group 映射表 | +2 |
| ui/app-dev-config-page | `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts` | `SYSTEM_TABS`（const Set） | 修改 | 新增 `'consolidation'` | MUST 与 `APP_SETTINGS_TABS` 的 `inSystemArea` 标记保持一致 | 同上 | +1 |
| ui/app-dev-config-page | `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts` | `TAB_KV_GROUPS`（const record） | 修改 | 新增 `consolidation: ['consolidation']`（自渲染 group，参与 dirty 跟踪但不进 `KV_GROUPS` 网格，同 `session` tab 里 `default_models` 的既有模式） | MUST NOT 把 `consolidation` 加入 `KV_GROUPS`（那是通用网格渲染，consolidation 走自渲染 section） | `section-consolidation-config.md` | +1 |
| ui/app-dev-config-page | `app/web/src/components/app-dev-config-page/use-app-settings-config.ts` | `useAppSettingsConfig()` | 修改 | 新增 `consolidationSnapshot`/`consolidationDraft` state + `handleConsolidationChange(key, value)`；`dirtyOfTab`/`saveTab`/`cancelTab` 内新增 `gid === 'consolidation'` 分支（镜像既有 `gid === 'default_models'` 分支结构） | MUST 镜像 `default_models` 分支写法（不引入新的 dirty 检测范式） | `use-app-settings-config.ts:178-195`（既有 `default_models` 分支参考实现） | +45 |
| ui/app-dev-config-page | `app/web/src/components/app-dev-config-page/app-settings-persist.ts` | `loadAppConfig(): Promise<LoadResult>` | 修改 | `LoadResult` 新增 `consolidation: ConsolidationData` 字段；函数体新增 `GET /config/app?group=consolidation&key=default` 拉取 | MUST 缺失 record 时回退 `{enabled:false, dailyTime:'04:00', modelId:undefined}` | `app_config.md §3.16` | +10 |
| ui/app-dev-config-page | `app/web/src/components/app-dev-config-page/app-settings-persist.ts` | `persistGroup(ctx): Promise<{...}>` | 修改 | 新增 `groupId==='consolidation'` 分支：`PUT /config/app {group:'consolidation', key:'default', data: consolidationDraft}` → 返回 `newConsolidationSnapshot` | MUST 镜像既有 `groupId==='default_models'` 分支写法 | `app-settings-persist.ts:94-115`（既有 default_models 分支参考实现） | +12 |
| ui/app-dev-config-page | `app/web/src/components/app-dev-config-page/section-consolidation-config.tsx` | `SectionConsolidationConfig`（component） | 新增 | 渲染 enabled toggle + dailyTime 输入 + modelId picker（`common/component-key-model-picker`）；只读区块展示 `GET /consolidation/status` 的 lastRunAt+summary（可拆子组件） | MUST ≤200 行；MUST NOT 提供手动触发整理按钮（PRD 明确排除） | `section-consolidation-config.md`（骨架，coder 编码前须先补全 testid 契约） | +130 |
| ui/app-dev-config-page | `app/web/src/components/app-dev-config-page/page-app-settings-merged.tsx` | `PageAppSettingsMerged`（component） | 修改 | 系统设置收起区渲染新增 `consolidation` tab（`tab-tree-item-consolidation` + `group-item-consolidation` 容器包 `SectionConsolidationConfig`） | MUST 收起/回落逻辑覆盖 `consolidation`（收起时选中态 ∈ {observability,consolidation,plugin} 回落 general） | `page-app-settings-merged.md`（已更新的 tab→group 映射表） | +15 |
| ui/app-dev-config-page | `app/web/src/i18n/locales/zh-CN/app-dev-config.json` | `schema.default_models.summary.label` | 修改 | 值「默认整理模型」→「默认上下文压缩模型」 | MUST NOT 改动同文件其他 key；MUST NOT 触及 `studio.json` 的 `manageTab.summaryModelLabel`（不同概念，squad `summaryModelDefault`，out of scope） | `section-default-models-and-request.md`（已更新的变更说明段） | +1 |
| ui/app-dev-config-page | `app/web/src/i18n/locales/en/app-dev-config.json` | `schema.default_models.summary.label` | 修改 | 值 "Default Summary Model" → "Default Context Compaction Model"（或等价措辞，coder 定稿英文用词） | 同上 | 同上 | +1 |
| ui/app-dev-config-page | `app/web/src/i18n/locales/{zh-CN,en}/app-dev-config.json` | `tab.consolidation.label` + `schema.consolidation.*` | 新增 | tab 标签「整理」/"Consolidation" + enabled/dailyTime/modelId 三字段的 label/desc key | MUST 两语言（zh-CN + en）同步新增，不遗漏一侧（i18n key 添加两确认纪律） | `section-consolidation-config.md` | +16 |

## 影响面评估

- **跨模块**：`agent/consolidation-tier2/`（新目录，业务逻辑，依赖 `agentManager.forkedRun` + 既有 skill/memory 工具）→ `scheduling/`（调度接线，依赖 tier2 runner + 既有 `SchedulerEngine`/`JobHandlerRegistry`/`PersistenceAdapter` 契约，`JobType` 是开放字符串枚举，本次改动**不需要**改 `engine.ts`/`registry.ts`/`types.ts` 本体）→ `bootstrap.ts`（装配 wiring）→ `router.ts` + 新 handler（只读状态端点）→ 前端 `app-dev-config-page`（新 tab + section + hook 扩展 + i18n）。
- **依赖顺序（建议 task 切分参考）**：① tier2 业务逻辑（含 prompt handler）② 调度接线（依赖①的 `runConsolidationTier2` 签名）③ bootstrap 装配 + 状态端点（依赖①②的类型/adapter）④ 前端 tab/section/i18n（依赖③的 API 契约已冻结，可与①②③并行开发，只要 §2.6/§2.7 契约不变）。
- **破坏性变更**：无。所有改动均为新增 job type / 新增 app_config group / 新增只读端点 / 新增 UI tab，不修改任何既有 API 响应形状、既有 job type（heartbeat/cron）行为、既有 skill_manage/memory_manage 工具接口。`section-default-models-and-request.md` 的 `summary` 字段仅 i18n 文案变更，contract 零变化。
- **主要风险**：
  1. **`updatedAt` 代理指标的精度**——用 `session.updatedAt` 判断"今天有无新对话"是启发式简化，理论上非消息触发的状态转换也可能碰巧刷新它（如未来新增的非对话类 CAS 转换），需 coder 在实现时确认当前 `markRunning`/`markIdle` 触发路径确实只对应真实消息驱动的运行。
  2. **boot-time-only 注册的用户体感**——用户在 UI 切换 `enabled` 或改 `dailyTime` 后不会立即生效，需在 §2.7 状态区块或 section 内有清晰的"重启后生效"提示文案，否则用户会误以为改动无效（既有 observability 先例的 UI 提示措辞可直接参考）。
  3. **三次独立 `forkedRun` 调用的整体运行时长**——若某天全局 skill/memory 各有大量条目 + 很多 session 有新对话，天级任务总耗时可能较长（分钟级），需确认 `SCHEDULER_TICK_MS`（默认 30s）+ engine per-job inFlight 守卫组合下不会与下一天的 fire 产生非预期交叠（理论上 24h 周期远大于预期任务时长，风险低但需 coder 编码时留意日志可观测性，便于运维发现异常拖长的情形）。
  4. **`evolvable=false` 导致的"收敛不动"是否需要更强的用户可见性**——当前设计只把这类情况写进 `lastResult.summary` 一句话摘要，若某域长期因为大量不可进化条目卡在超限状态，用户可能需要更明显的提示（本版本按 PRD 范围暂不处理，留作后续版本观察点）。
  5. **test-only 端点与真实调度并存时的数据交叠**——`POST /test/consolidation/run` 不检查 `enabled`、不看调度 job 是否存在即可执行；若 AT 环境恰好也 seed 了 `enabled=true`（真实 job 已注册），两条路径可能在同一进程内先后/交替写同一批 skill/memory 数据。这不产生数据损坏（既有存储层锁足够，同 tier1/tier2 互斥论证），但 AT case 设计时应注意：断言"整理结果"前，最好保证同一时间窗口内没有真实调度 job 也在跑（AT env 默认 `enabled=false`，一般不会撞上，但需 test-designer 知悉此边界）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
