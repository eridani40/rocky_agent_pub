# v0.0.347 变更计划书 — 模型路由降级（组合方案 + attempt 内路由 + 三态熔断）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD：`specs/prd/model-routing-PRD-2026-08-14.md`（§2.1-2.8 + §3 关键路径 + §4 验收）· 方案设计 v3.2（D1-D17 拍板）：`specs/prd/model-routing-方案设计-2026-08-14.md` · tech：`specs/tech/agent/providers_and_models/[P0]model_routing.md` · api：`specs/api/overall/21-model-routing.md`

## 架构决策结论

| # | 决策点 | 结论 |
|---|--------|------|
| ① | 方案存储 | app_config 新增 `model_routing_plans` group（key=planId，权威值组多实例）+ `model_routing` group（key=default，playground 挂载单实例）；squad 实体加 `modelRoutingPlanId?`（required:false，PATCH !== undefined 才写）。**不做独立 entity**（复用 KV sharding，零迁移） |
| ② | resolve 改造 | `buildSessionConfigFromDeps` 每次 run 现拉：先查挂载（studio=squad.modelRoutingPlanId / playground=model_routing.default.playgroundPlanId）→ 有挂载走分支 2 产出 `SessionConfig.modelRoutingPlan`（含合成候选链 + 生效熔断参数，**不 resolveModel**）；无挂载走分支 1 现有 resolveModel 原链**零改动**（D11/D12） |
| ③ | attempt 改造 | `llm_caller.invokeCore` 检测 `ctx.routingPlan` → 走新 `routing_loop.ts` 路由循环（时间过滤→enabled→熔断→banned→调用→失败决策）；**复用现有 attemptLoop 单次调用**（看门狗/classify/buildRequest overlay 全保留），仅在其上层加候选决策。无 routingPlan → 现有循环零改动 |
| ④ | 熔断存储 | 进程内存 `CircuitBreakerRegistry`（globalThis 单例，DI 注入），key=(planId, providerId, modelId) 三维；不持久化（重启丢失可接受）；默认 4/2/60/0.6/10，方案级 circuit 覆盖 |
| ⑤ | 差异化重试 | 新纯函数 `routingRetryPolicy(category)` 按 error_normalization 分类产 `{ inModelRetries, directOpen }`；attempt 循环按表决策（429/529 0 次快速降级、瞬态 1 次、401/403 直接 Open、ABORTED 不计） |
| ⑥ | 删除方案 | 通用 KV DELETE + group 白名单（仅 `model_routing_plans`）；删除时扫描解除挂载（squad.modelRoutingPlanId + playgroundPlanId 清空），挂载方回退默认模型（分支 1 天然生效） |
| ⑦ | 状态查询 | 新增 `GET /model-routing/plans/:planId/status`（只读内存快照，返回 circuitState + presentation 映射 + remainingSeconds）；UI 红绿灯消费 presentation（D16） |
| ⑧ | 时间控件选型 | **主选 `react-availability-grid`**（v2.x，~20KB gzipped，TypeScript，原生拖拽连续段选中 + 多段加选，2024-2025 活跃维护，React 16.8+ hooks）——封装适配层（单日视图=每天重复 24 小时格、外层「清空=全天」按钮、hover hour 提示），输出 `{ hours: number[] }`。**备选** `react-available-times`（recurring 模式支持周内重复但 7 年未维护，仅当主选集成失败时评估）。**兜底**：若两成熟组件与「每天重复小时格」模型冲突过大（需 hack 内部），以 demo 交互协议为基准自研 ~100 行小组件（**记录偏离 + 需老板确认**，交互必须满足选型标准 4 条：拖拽连续段/多段加选/清空=全天/hover 提示） |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| model-routing-core | `app/server/src/services/model-routing-validation.ts` | `validateModelRoutingPlan(plan, providers)` | 新增 | 纯函数校验：name/items 非空；每条目 providerId+modelId 必须指向 enabled provider 的 enabled model（复用 model-validation）；同模型（providerId+modelId）按**启用条目**分组：≤2 条、禁 2 带时间、禁 2 不带时间、带时间必须排在不带时间上面；priority 正整数且唯一；enabled 缺省 true 兼容 | MUST：纯函数无副作用；MUST：校验信息可映射到明确 400 提示（中文文案由前端 i18n，后端 message 英文）；MUST NOT：改 model-validation.ts | tech §2.3 + api §2.2 | +90 |
| model-routing-core | `app/server/src/services/model-routing-store.ts` | `listPlans(svc)` | 新增 | 读 `model_routing_plans` 整组 → ModelRoutingPlan[]（按 createdAt 排序） | MUST：缺失 = [] | tech §8.1 | +12 |
| model-routing-core | 同上 | `getPlan(svc, planId)` | 新增 | 读单 key → ModelRoutingPlan \| undefined | MUST：undefined = 未配置（不抛） | 同上 | +8 |
| model-routing-core | 同上 | `savePlan(svc, plan)` | 新增 | 校验（validateModelRoutingPlan 先跑，违规 throw）→ `svc.set('model_routing_plans', plan.id, plan)` | MUST：校验失败必 throw（handler 转 400）；MUST：全量覆盖语义 | api §2.2 | +10 |
| model-routing-core | 同上 | `deletePlan(svc, planId, deps)` | 新增 | ① 扫描全部 squad（squadStore.list）清 `modelRoutingPlanId === planId`；② 读 `model_routing.default` 清 playgroundPlanId；③ `svc.set('model_routing_plans', planId, undefined)`（或底层 delete） | MUST：解除引用先于删 record；MUST：返回 detached 清单（`["squad:<id>", "playground"]`）；MUST NOT：删方案时删 squad | tech §8.3 + api §2.3 | +30 |
| model-routing-core | 同上 | `getPlaygroundPlanId(svc)` / `setPlaygroundPlanId(svc, planId \| undefined)` | 新增 | 读写 `model_routing.default.playgroundPlanId`（undefined=解除，data={}） | MUST：planId 非空时校验方案存在（不存在 throw 400） | api §2.4 | +15 |
| config-handler | `app/server/src/handlers/kv-config-handlers.ts` | `handleKvConfig` | 修改 | GET 分支：`model_routing_plans` / `model_routing` 两 group 走通用整组 GET（零特判）；**新增 DELETE 分支**：`method==='DELETE'` 时 group 白名单检查（仅 `model_routing_plans` 允许；其他 group → 405）→ 调 model-routing-store.deletePlan | MUST：DELETE 仅 model_routing_plans 放行；MUST：其他 group 405 不落盘；MUST NOT：改 GET/PUT 既有语义 | api §2.1/§2.3 | +25 |
| config-handler | 同上 | `handleKvConfigPut` | 修改 | PUT 分发前对 group 特判：`model_routing_plans` → 调 validateModelRoutingPlan（违规返 400 + message）；`model_routing` → setPlaygroundPlanId 校验（planId 不存在 → 400）；其他透传不变 | MUST：校验失败 400 不落盘；MUST NOT：改其他 group 行为 | api §2.2/§2.4 | +15 |
| squad | `app/server/src/agent/schema_defs/squad/squad.ts` | `SquadSchema.fields.modelRoutingPlanId` | 新增 | `{ type: 'string', required: false }`（挂载方案引用；required:false 容忍存量） | MUST：required:false；MUST NOT：改 modelDefault 语义 | tech §2.2 | +3 |
| squad | `app/server/src/handlers/squad.ts` | `PatchSquadBody` | 修改 | 加 `modelRoutingPlanId?: string`（PATCH 透传） | MUST：`!== undefined` 才写；显式 null = 清空 | api §2.5 | +2 |
| squad | 同上 | `handleSquadPatch`（校验区） | 修改 | `modelRoutingPlanId` 非空时校验方案存在（model-routing-store.getPlan 非 undefined，否则 400 `plan not found`） | MUST：校验失败 400；MUST NOT：阻塞 modelDefault 既有校验 | api §2.5 | +8 |
| squad | `app/server/src/services/squad-service.ts` | `patchSquad`（或对应落盘函数） | 修改 | `modelRoutingPlanId` 透传落盘（`!== undefined` 才写；null 清空字段） | MUST：与 effortDefault 同模式（PATCH !== undefined 才写） | 同 effortDefault 先例 | +4 |
| resolve | `app/server/src/handlers/session-config.ts` | `buildSessionConfigFromDeps` | 修改 | resolveModel 前**先查挂载**：studio（studioContext.squad.modelRoutingPlanId）/ playground（model_routing.default.playgroundPlanId）→ 有挂载 → 读方案实体 → 合成候选链（session 显式 modelId 非保留字 → priority 0 插入顶部；default/none/undefined → 方案 items 原序）→ 填 `SessionConfig.modelRoutingPlan`（planId + items + 生效 circuit 默认值填充）；无挂载 → 现有 resolveModel 原链（零改动） | MUST：分支 2 不 resolveModel（不隐式兜底 D4）；MUST：session 显式模型合成不写回方案实体；MUST：熔断键 = planId + providerId + modelId（含合成模型）；MUST NOT：改分支 1 行为 | tech §4 + api §2.5 | +30 |
| resolve | `app/server/src/agent/context-types.ts` | `SessionConfig.modelRoutingPlan` | 新增 | `modelRoutingPlan?: { planId: string; items: RoutingItem[]; circuit: CircuitConfig }`（分支 2 才有；缺省 = 分支 1） | MUST：可选字段；MUST：类型引用 model-routing 数据模型 | tech §4 | +6 |
| llm-routing | `app/server/src/llm/caller/llm_caller.ts` | `InvokeContext.routingPlan` | 新增 | `routingPlan?: SessionConfig['modelRoutingPlan']`（invoke 入口透传） | MUST：可选；缺省走现有路径 | tech §5 | +3 |
| llm-routing | 同上 | `invokeCore` | 修改 | 开头检测 `ctx.routingPlan`：有 → 调 `routingAttemptLoop(plan, ctx, ...)`（返回 InvokeResponse / throw）；无 → 现有循环（零改动） | MUST：分支清晰（routingPlan ? routing loop : 现有 loop）；MUST NOT：重构现有循环 | tech §5 | +10 |
| llm-routing | `app/server/src/llm/caller/routing_loop.ts` | `routingAttemptLoop` | 新增 | 路由主循环：① 时间过滤（本地小时 ∉ hours → skipped）② enabled==false → skipped ③ circuitRegistry(planId,pid,mid).state==Open → skipped + bannedModels.add ④ bannedModels 命中 → skipped ⑤ 调 attemptLoop（复用：watchdog/classify/buildRequest overlay）+ 按 routingRetryPolicy 模型内重试 N 次 ⑥ 成功 → recordSuccess（熔断 + health）返回；失败 → recordFailure（熔断 escalate）+ 按策略降级/直接 Open ⑦ 循环耗尽 → 候选空「当前无可用模型」/ 全失败「所有候选模型不可用」（聚合错误）| MUST：时间过滤/enabled 不消耗尝试不计熔断；MUST：去重键 = providerId+modelId（bannedModels）；MUST：换模型降级 0 sleep；MUST：ABORTED_BY_USER 直接返回不算失败；MUST：AUTH 直接 Open + banned；MUST NOT：调 resolveTarget（方案链不走 fallback_chain） | tech §5/§7 + PRD §2.5/§2.6 | +140 |
| llm-routing | `app/server/src/llm/caller/routing_retry_policy.ts` | `routingRetryPolicy(category)` | 新增 | 纯函数：LlmErrorCategory → `{ inModelRetries: 0\|1; directOpen: boolean }`——429/529/401/403/请求类=0 次；网络/超时/5xx/流断/空响应/MAX_TOKENS_TOO_HIGH=1 次；401/403 directOpen=true；ABORTED_BY_USER 不计（调用方处理） | MUST：纯函数；MUST：与 PRD §2.6 表逐行一致；MUST NOT：改 error_normalization | tech §7 | +40 |
| llm-routing | `app/server/src/llm/caller/circuit_breaker_registry.ts` | `CircuitBreakerRegistry` | 新增 | 进程内存 Map<`planId\|providerId\|modelId`, CircuitEntry>：getState / recordFailure（连续失败 ≥ failureThreshold 或 total ≥ minRequests 且 errorRate ≥ errorRateThreshold → Open；AUTH directOpen 直达 Open）/ recordSuccess（半开连续成功 ≥ successThreshold → Closed）/ 到期 Open→HalfOpen（限流 1 并发探测，permit 归还）/ snapshot（供 status 端点）；默认参数 4/2/60/0.6/10 | MUST：key 三维 (planId, providerId, modelId)；MUST：HalfOpen 限流 1 + permit 归还；MUST：不持久化；MUST NOT：与 ProviderHealthRegistry 混用 | tech §6 + PRD §2.7 | +110 |
| llm-routing | `app/server/src/llm/caller/build_invoke_context.ts` | `buildInvokeContext` | 修改 | 透传 `routingPlan`（来自 SessionConfig） | MUST：缺省 undefined 不改变现有行为 | tech §5 | +3 |
| api-handler | `app/server/src/handlers/model-routing-status.ts` | `handleModelRoutingStatus` | 新增 | `GET /model-routing/plans/:planId/status`：读方案 + circuitRegistry.snapshot → items[]（按 priority 去重同模型多 item 只出一条）映射 presentation（closed→normal / open→abnormal+remainingSeconds / half_open→observing） | MUST：只读内存态；MUST：planId 不存在 → 404；MUST：presentation 映射为权威（D16） | api §2.6 | +50 |
| api-handler | `app/server/src/index.ts`（或 router 注册处） | 路由注册 | 修改 | 注册 `/model-routing/plans/:planId/status` GET | MUST：路径与 api spec 一致 | api §2.6 | +2 |
| ui-settings | `app/web/src/components/app-dev-config-page/section-model-routing-plans.tsx` | `SectionModelRoutingPlans` | 新增 | 「模型组合方案库」区块（models tab）：方案列表（新建/重命名/删除/复制）+ 选中方案进入编辑页；删除确认（提示解除挂载）；红绿灯状态（拉 status 端点） | MUST：新建默认名「方案 N」；复制 = 「<原名> 副本」独立 id；MUST：删除走 DELETE 端点并刷新挂载方提示；MUST NOT：改 providers 既有 section | PRD §2.1/§2.4 | +120 |
| ui-settings | `app/web/src/components/app-dev-config-page/component-model-routing-plan-editor.tsx` | `ModelRoutingPlanEditor` | 新增 | 方案编辑：有序条目列表（上移/下移=priority，禁用首条上移/末条下移）+ 每条目 provider/model picker（复用 ModelPicker）+ enabled 开关（停用保留配置）+ 时间条件入口（「不限」/「只在以下小时可用」→ HourGridPicker）+ 同模型校验实时提示（保存时服务端二次校验，400 展示 message）+ 熔断参数高级区（5 参数，缺省默认） | MUST：同模型约束本地预检（阻止保存并提示）+ 服务端 400 透传；MUST：enabled 默认 true；MUST：priority 上移/下移语义 = 交换相邻；MUST NOT：条目删除二次确认（可恢复性由「未保存即丢弃」保障） | PRD §2.1/§2.2/§2.8 | +160 |
| ui-settings | `app/web/src/components/app-dev-config-page/component-hour-grid-picker.tsx` | `HourGridPicker` | 新增 | 时间控件适配层：封装 `react-availability-grid` TimeGrid（单日视图 = 每天重复 24 小时格 0-23）+ 外层「清空=全天」按钮 + hover hour tooltip（「02:00-03:00」）+ 受控 value `{ hours: number[] }` | MUST：输出恒为 `{ hours: number[] }`（0-23 白名单）；MUST：清空 = `hours: []`（等价不配置）；MUST：满足选型标准 4 条（拖拽连续段/多段加选/清空=全天/hover 提示）；MUST：依赖加 package.json（react-availability-grid + dayjs） | 方案设计 §1.5 + tech §2.1 | +90 |
| ui-settings | `app/web/src/components/app-dev-config-page/component-circuit-status.tsx` | `CircuitStatusBadge` | 新增 | 红绿灯状态呈现：消费 status 端点 presentation——normal=🟢 正常 / abnormal=🔴 异常（带倒计时 remainingSeconds）/ observing=🟡 观察中（无倒计时） | MUST：呈现映射 = D16 权威表（正常/异常/观察中，不给熔断器词）；MUST：abnormal 显示倒计时（每秒刷新）；MUST NOT：展示内部熔断词 | PRD §2.7 + tech §6.2 | +50 |
| ui-settings | `app/web/src/components/app-dev-config-page/section-tab-panel.tsx` | `models` tab 渲染 | 修改 | models tab 在 providers section 下追加 `SectionModelRoutingPlans`（方案库） | MUST：不动 providers 渲染；MUST：tab 结构零变更 | 现 section-tab-panel L128 | +5 |
| ui-settings | `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts` | `models` tab 配置 | 修改 | models tab groups/渲染加 `model_routing_plans`（page-tab dirty 参与保存；方案编辑保存 = PUT model_routing_plans 单 key） | MUST：dirty 聚合遵循现有范式 | 现 app-settings-config-defs L101 | +8 |
| ui-settings | `app/web/src/components/studio-page/`（squad 管理面板，具体文件 coder 按现有 modelDefault 配置区定位） | squad 方案挂载选择 | 修改 | squad 管理面板模型设置区加「默认模型/方案」选择：ModelPicker（默认模型，现有）+ 方案下拉（挂载 model_routing_plans 列表 / 无=不挂载）；保存走 PATCH /squad/:id modelRoutingPlanId | MUST：与现有 modelDefault 配置并列不冲突；MUST：解除挂载 = PATCH null；MUST：academy 场景不渲染（本期仅 studio/playground） | PRD §2.4 + api §2.5 | +40 |
| ui-settings | `app/web/src/i18n/locales/zh-CN/settings.json` + `en/settings.json` | modelRouting 命名空间 | 新增 | 文案：方案库 CRUD 按钮、enabled 开关、时间条件（「不限」/「只在以下小时可用」）、同模型校验提示（3 条）、状态词（正常/异常/观察中）、删除确认、挂载选择 | MUST：zh 文案对齐 PRD 用户可见词（如「带时间条目必须在不带时间条目上面」）；MUST：双语同 key | PRD §2.8 | +30 |
| deps | `app/web/package.json` | dependencies | 修改 | 加 `react-availability-grid` + `dayjs`（时间控件选型主选） | MUST：版本锁定；MUST：若集成失败走兜底方案（记录偏离） | 决策⑧ | +2 |
| tests | `app/server/src/services/__tests__/model-routing-validation.test.ts` | 新增测试 | 新增 | validateModelRoutingPlan 全规则：合法通过 / 2 带时间拒绝 / 2 不带时间拒绝 / 带时间在下拒绝 / provider 不存在 / model disabled / priority 非法 / enabled 缺省兼容 | MUST：覆盖 PRD UC-21/22/23 + 校验 9 条 | PRD §2.8 | +80 |
| tests | `app/server/src/llm/caller/__tests__/routing_loop.test.ts` | 新增测试 | 新增 | routingAttemptLoop：时间过滤跳过 / enabled=false 跳过 / 熔断 Open 跳过 / banned 去重（同模型多 item 只试一次）/ 429 快速降级 / 网络 1 次重试 / 401 直接 Open / 全失败聚合错误 / ABORTED 直接返回 / 候选空报「当前无可用模型」 | MUST：覆盖 PRD UC-6/10/14/15/16/17 + 验收 5/8 | PRD §2.5/§2.6 | +120 |
| tests | `app/server/src/llm/caller/__tests__/circuit_breaker_registry.test.ts` | 新增测试 | 新增 | 三态机：连续 4 失败 Open / 60s 后 HalfOpen / 限流 1 探测 / 连续 2 成功 Closed / 探测失败回 Open / 三维隔离（方案 A 熔断方案 B 正常）/ 默认参数 / 参数覆盖 | MUST：覆盖 PRD UC-18/19/20 | PRD §2.7 | +90 |
| tests | `app/web/src/components/app-dev-config-page/__tests__/component-model-routing-plan-editor.test.tsx` | 新增测试 | 新增 | 条目增删/上移下移/enabled 开关/同模型本地预检（2 带时间/2 不带/带时间在下）/时间条件打开 HourGridPicker/熔断高级区展开 | MUST：覆盖 P-A 关键路径配置交互 | PRD §3 P-A | +70 |
| tests | `app/web/src/components/app-dev-config-page/__tests__/component-hour-grid-picker.test.tsx` | 新增测试 | 新增 | 拖拽选中连续段 / 多段加选 / 清空=全天(hours:[]) / hover 提示 / value 受控输出 {hours} | MUST：输出语义 hours[] 白名单；MUST：清空等价不配置 | PRD UC-8/9 | +50 |

## 影响面评估

- **模块**：model-routing-core（新，validation + store）+ config-handler（kv-config DELETE/校验钩子）+ squad（schema + handler + service）+ resolve（session-config 分支 2 + context-types）+ llm-routing（routing_loop + retry_policy + circuit_registry + llm_caller 接线）+ api-handler（status 端点）+ ui-settings（方案库面板/编辑器/时间控件/状态徽章/models tab/squad 挂载/i18n）+ tests。
- **破坏性变更**：**无**。分支 1（无挂载方案）resolve 原链零改动 + invoke 无 routingPlan 走现有循环；所有新字段 optional（SessionConfig.modelRoutingPlan / InvokeContext.routingPlan / squad.modelRoutingPlanId / 方案 data 形状）；通用 KV 只加 group 白名单 DELETE（其他 group 405 非破坏）。
- **依赖顺序**：① model-routing-validation + store（底层，无依赖）→ ② squad schema/handler + kv-config DELETE/校验 + status 端点（依赖 ①）→ ③ session-config 分支 2 + llm_caller 接线 + routing_loop + circuit registry（依赖 ① 的 store 读取，可并行 ②）→ ④ 前端（依赖 ② 的 CRUD/挂载 API + ③ 的 status 端点）。**编码任务拆分**：T1=①+②（后端配置层，owner coder），T2=③（后端路由层，owner coder2，依赖 T1 的 store），T3=④（前端，owner coder3，依赖 T1+T2）。T2 与 T3 在 T1 后并行。
- **风险点**：
  1. **routing_loop 与现有 attemptLoop 的边界**：路由循环**复用** attemptLoop 单次调用（client.stream + watchdog + classify），决策（重试 N 次/降级/熔断）在 routing_loop 上层——严禁在 attemptLoop 内塞路由逻辑（它会破坏现有单模型路径）。
  2. **resolve 分支 2 不 resolveModel**：方案链优先，session 显式模型只是 priority 0 合成（临时）——严禁把合成写回方案实体 / 严禁在方案候选耗尽后 fallback 单模型（D4 不隐式兜底）。
  3. **去重键 = providerId+modelId 非 item**（D14）：bannedModels 必须在「模型配置」维度，session 合成 + 带时间 + 无条件同模型条目共享去重。
  4. **时间过滤/enabled 语义**：跳过 ≠ 尝试失败（不消耗尝试、不计熔断失败）；熔断 Open 跳过 ≠ 时间过滤跳过（Open 要进 bannedModels，时间过滤不进）。
  5. **半开 permit 必须归还**（防卡死，对齐 cc-switch release_half_open_permit）。
  6. **时间控件选型风险**：react-availability-grid 的 TimeGrid 面向「日期区间调度」（startDate/endDate），适配「每天重复 24 小时格」需单日视图裁剪——若发现需 hack 内部，走备选/兜底（决策⑧，记录偏离需老板确认）。
  7. **删除方案引用解除**：必须先解除 squad/playground 挂载再删 record；漏解除会导致挂载方指向幽灵方案（运行时视为未挂载可接受但 UI 应提示）。
  8. **前端 models tab dirty 聚合**：方案库编辑保存 = PUT 单 key（非 page-tab 整组），需遵循既有例外范式（provider 独立 save 流先例），避免误进 page-tab dirty 丢改动。
- **环境**：worktree 首次使用需 `bun install`（node_modules 独立，且新增 react-availability-grid/dayjs 依赖需重装）；架构期不起 dev（UT 用 vitest）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- 时间控件选型偏离（主选集成失败走备选/兜底）必须 change_log 记录 + 向 leader 汇报，禁止静默自研

---

# UI v2 改版（追加 2026-08-14 老板拍板 demo v2 为视觉契约）

> **背景**：T3 第一版 UI 老板否决（布局丑/交互不对），demo v2（`specs/prd/model-routing-demo-v2.html`，两轮迭代拍板）为冻结视觉契约。**纯前端重构**：后端 API / 数据模型 / 路由逻辑 / 校验全部零改动。冻结三点 = ①两层结构（方案卡片列表 → 详情）②item 多列行 ③时间弹层交互（草稿态 + 语义翻转 + footer）。
> **任务**：Task 4（owner coder3，依赖 T3 已交付的实现基座）。

## UI v2 决策结论

| # | 决策点 | 结论 |
|---|--------|------|
| ⑨ | 两层结构 + 快照回滚 | 外层方案卡片列表（demo 形态：名称 / N 个模型 / 模型名列表 `·` 连接 / 挂载徽章 / chevron）→ 点卡片进详情；进详情时 `structuredClone` 深拷贝快照，**取消 = 恢复快照回列表**（v1 无回滚，本地编辑直接污染列表 state——v2 修复），保存 = 既有 PUT 流程 + 回列表 |
| ⑩ | plan 级操作收进卡片 ⋯ 菜单 | demo 列表卡片无 rename/copy/delete 入口，但 PRD UC-1~4（含复制）不可回退 → 卡片右侧 ⋯ more-menu（重命名（v1 renameDraft inline 模式保留）/ 复制 / 删除（v1 ConfirmModal 保留））；**demo 未画 ≠ 禁止**，不属冻结三点，最小扩展 |
| ⑪ | item 7 列行布局 | col-handle（DragHandle，唯一拖拽源）/ col-order（序号=idx+1，拖拽后 reindexPriorities 重算）/ col-model（**复用 ModelPicker**：选中后触发按钮固定显示模型名，点击重开下拉；demo 下拉内搜索框不属冻结三点且 ModelPicker 无搜索能力——不实现，记可接受偏离）/ col-time（32×32 时钟 icon：active=已配 hours / inactive 灰；active 时 hover tooltip 显示 `fmtHours` 如 `02:00-08:00, 21:00-24:00`）/ col-circuit（**复用 CircuitStatusBadge 零改动**，按 providerId+modelId 从 status 匹配）/ col-toggle（**复用 ToggleSwitch primitive** 替 v1 checkbox）/ col-more（⋯ menu → 删除 → ConfirmModal「删除路由条目？」）。禁用行整体 opacity-60 |
| ⑫ | 时间弹层草稿态 | 打开 = `timeDraft` 拷贝既有 hours（无配置即全灰）；**格子点击 toggle + 拖拽连续段/多段加选全部操作 draft，不写回**；确定 = 1-23 格校验（0 格「至少选择 1 个小时」/ 24 格「全选=全天可用，直接清除定时」报错不关闭）→ 写回 `timeCondition.hours`；清除定时 = 直接写回 `hours:[]`（icon 变灰）+ 关闭；**点空白 = 丢弃草稿关闭**（document click listener + contains 检查）。hours 数据语义零变化（白名单/[]=全天无 timeCondition） |
| ⑬ | 格子视觉语义翻转 | 默认全灰（bg-surface-2 浅灰=关）→ 选中变深（**bg-fg 深色=该小时可用**，替 v1 accent 色）；纯视觉翻转，`normalizeHours` 输出语义不变。v1 的格子 hover tooltip 删除（demo 用 footer 实时已选时段替代） |
| ⑭ | 拖拽冲突修复 | 拖拽源 **仅 grip 手柄**：DragHandle 自带 draggable（dragstart 冒泡到 wrapper 挂 onDragStart/onDragEnd），**行本身 draggable=false** 只挂 onDragOver/onDrop（对齐 demo，防弹层内格子拖选把行/弹层拖走）；时间弹层容器 draggable=false + onDragStart/onDragOver/onDrop 全 preventDefault+stopPropagation + onMouseDown stopPropagation；格子 mousedown preventDefault+stopPropagation |
| ⑮ | 熔断高级区常显 | demo 无折叠：常显「熔断参数（高级）」标题 + 5 参数网格，每参数 label + number input + 默认值 hint（「默认 4」等）；空串=回默认逻辑（patchCircuit）不变 |
| ⑯ | 挂载徽章数据源 | 前端新函数 `listPlanMounts()`：`listSquads()`（SquadSummary.modelRoutingPlanId 已有字段）+ `getConfigGroup('app','model_routing')`（playgroundPlanId）→ `Record<planId, string[]>`（squad 名 / 'Playground'）；徽章 `已挂载到 A、B` / `未挂载`；列表拉一次，失败不阻断（徽章隐藏） |
| ⑰ | 状态红绿灯位置 | 列表卡片**不放**红绿灯（demo 如此）；进详情时拉一次 `getModelRoutingStatus(planId)` 供 item 行 col-circuit 匹配（v1 列表全量拉 → 简化为详情单方案拉）；CircuitStatusBadge 自带 1s tick 倒计时 |

## UI v2 变更清单（method 级）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-v2 | `app/web/src/components/app-dev-config-page/section-model-routing-plans.tsx` | `SectionModelRoutingPlans` | 修改(重写) | 两层视图：list（demo plan-card：name/meta(N 个模型+模型名 · join)/mount-badge/chevron/⋯ 菜单(rename inline+copy+delete ConfirmModal)/+新建方案）+ detail（detail-header：← + 「方案：name」 + 取消/保存 + editor + item 区）。新增 `detailSnapshot` state（openDetail 深拷贝 / cancelDetail 恢复 / handleSave 成功后清快照回 list）。reload 增挂载拉取（listPlanMounts，失败降级空）；删列表红绿灯区，detail 打开时 useEffect 拉 status（statusMap 仅当前方案） | MUST：取消=快照回滚（丢弃未保存编辑）；MUST：卡片点击整卡进详情；MUST：文件 ≤300 行（超了拆 plan-card 子组件）；MUST NOT：动 handleSave PUT 载荷/handleDelete 流程；MUST NOT：改 studio squad 挂载下拉 | demo v2 L526-581 + L386-414 | ~330→重写 |
| ui-v2 | 同上 | `openDetail` / `cancelDetail` | 新增 | openDetail(p)：snapshot=structuredClone(p)、view=detail；cancelDetail：plans[i]=snapshot 回滚、清快照、回 list | MUST：进详情必建快照；MUST：取消必回滚 | demo openDetail/cancelDetail | +20 |
| ui-v2 | `app/web/src/components/app-dev-config-page/component-model-routing-plan-editor.tsx` | `ModelRoutingPlanEditor` | 修改(重写) | 条目区改 7 列横排行（决策⑪）：DragHandle wrapper(onDragStart/onDragEnd)+序号+ModelPicker(triggerClassName w-[220px])+时钟 icon btn(active/inactive+hover tooltip)+CircuitStatusBadge(match by pid+mid)+ToggleSwitch(value/onChange/actionKey)+⋯ menu(删除→ConfirmModal)。新增弹层互斥 state：`openTimeIdx`/`openMoreIdx`/`pendingDeleteIdx`（单开，openTime 打开时 timeDraft 拷贝基线）；拖拽：行 onDragOver/onDrop(splice+reindexPriorities+closeAllPopovers)；熔断高级区常显+默认值 hint；新增条目按钮保留。**删除**：↑↓ moveItem 按钮、时间模式 select(不限/只在以下小时)、inline HourGridPicker 展开、name input（改名走列表卡片 ⋯）、v1 格子 hover tooltip 逻辑 | MUST：拖拽源仅手柄（行 draggable=false）；MUST：禁用行 opacity-60；MUST：时间弹层打开=草稿基线 copy；MUST NOT：改 validatePlanLocal/reindexPriorities/patchCircuit 语义；MUST NOT：改 Props 契约(value/onChange/serverError/disabled)；MUST：文件 ≤300 行 | demo renderDetail L773-871 | ~373→~300 |
| ui-v2 | 同上 | `moveItem` | 删除 | 拖拽排序替代按钮排序，moveItem 零引用死代码必删 | MUST：删除后 grep 零引用 | 死代码原则 | -14 |
| ui-v2 | `app/web/src/components/app-dev-config-page/component-hour-grid-picker.tsx` | `HourGridPicker` | 修改(重写) | 从 inline 受控组件改为**弹层内容组件**：Props 改 `{ value: number[]; onConfirm: (hours:number[])=>void; onClear: ()=>void }`（受控基线+确定/清除回调，关闭由父级管理）；内部 `draft` state（useState(value) 初始化，弹层由父级条件渲染=每次打开重置基线）；格子点击 toggle+拖拽连段/多段加选操作 draft（v1 applyRange 逻辑保留，target 改 draft）；格子视觉翻转（on=bg-fg text-bg 深 / off=bg-surface-2 浅灰）；header「选择可用小时（拖拽连续段 / 点击单格）· 深色 = 该小时可用」；footer 左=errEmpty/errFull 错误或 `fmtHours(draft)` 实时（none 样式「未选择」）+右「清除定时」「确定」；确定=1-23 校验（demo 文案）合法才 onConfirm(sorted)；清除定时=onClear；格子 onMouseDown preventDefault+stopPropagation；容器 draggable=false+DnD 三事件 preventDefault+stopPropagation | MUST：确定前零写回（draft 隔离）；MUST：0/24 格报错不关闭不回调；MUST：清除定时语义=写回 []（全天）；MUST NOT：改 normalizeHours 输出语义；MUST：小时白名单语义不变（hours 仍是可用白名单） | demo L614-672 | ~175→~190 |
| ui-v2 | 同上 | `hoursToRanges` / `formatRanges` / `fmtHours` | 新增 | demo 同名工具函数：连续小时合并成 [start,end+1] 段 → `02:00-08:00, 21:00-24:00` 格式；export 供时钟 icon tooltip + footer 共用 | MUST：纯函数；MUST：[21,22,23]→`21:00-24:00`（24 补零） | demo L486-505 | +25 |
| ui-v2 | `app/web/src/components/app-dev-config-page/component-circuit-status.tsx` | `CircuitStatusBadge` | 复用零改动 | 现有组件已满足 demo badge（dot+词+倒计时 tick），直接用于 col-circuit | MUST NOT：改本文件 | 现状即契约 | 0 |
| ui-v2 | `app/web/src/components/app-dev-config-page/model-routing-api.ts` | `listPlanMounts` | 新增 | `listSquads()` + `getConfigGroup('app','model_routing')` 并行 → `Record<planId,string[]>`（squad.name / 'Playground'）；任一失败 throw（section 侧 catch 降级空） | MUST：纯前端聚合，不加后端端点；MUST：playground key=default 解析 playgroundPlanId | 决策⑯ | +28 |
| ui-v2 | `app/web/src/components/app-dev-config-page/model-routing-types.ts` | — | 零改动 | 数据形状（RoutingItem/TimeCondition 等）不变 | MUST NOT：改任何 interface | 纯前端重构边界 | 0 |
| ui-v2 | `app/web/src/i18n/locales/zh-CN/app-dev-config.json` + `en/` | `modelRouting.*` | 修改 | 新增：list.modelsCount/mountedTo/unmounted、menu(rename/copy/delete 复用 list 既有)、editor.detailTitle/degradeOrder/addItem(复用)、time.popoverHeader/unselected/clearSchedule/confirm/errEmpty/errFull、deleteItem.title/body/ok/cancel；**删除**：editor.timeLabel/timeAny/timeHours/nameLabel、time.helper/clearAll（被新交互替代） | MUST：zh/en 同步；MUST：用户可见词不用熔断器术语（沿袭 m2 修复）；MUST：demo 文案逐字（老板钦定文案逐字铁律） | demo 全文 | +30/-8 |
| ui-v2 | `app/web/src/components/app-dev-config-page/__tests__/section-model-routing-plans.test.tsx` | 全文件 | 重写 | v1 5 例(rename 回归)适配卡片 ⋯ 菜单路径 + 新增：卡片渲染（N 个模型/模型名/挂载徽章/未挂载）、点卡进详情、取消回滚快照（编辑后取消=原值）、保存流程 PUT、删除方案。目标 ~9 例 | MUST：rename BUG-002 回归语义保留（受控回显/空白不 PUT/同名不 PUT/Escape） | 既有 5 例 | 重写 |
| ui-v2 | `app/web/src/components/app-dev-config-page/__tests__/component-hour-grid-picker.test.tsx` | 全文件 | 重写 | v1 11 例改弹层语义：打开=draft 基线、单格点击 toggle、拖拽连段/多段加选、footer 实时段落文本、确定 1 格/23 格写回、0 格 errEmpty 不回调、24 格 errFull 不回调、清除定时 onClear、hoursToRanges/formatRanges 纯函数（[21,22,23]→21:00-24:00）。目标 ~13 例 | MUST：断言 onConfirm 前后 value 不变（草稿隔离） | 既有 11 例 | 重写 |
| ui-v2 | `app/web/src/components/app-dev-config-page/__tests__/component-model-routing-plan-editor.test.tsx` | 全文件 | 重写 | v1 19 例改 7 列行：grip dragstart→drop 行序变更+reindexPriorities（fireEvent+dataTransfer mock）、ToggleSwitch 翻转 enabled、时钟 icon active/inactive+tooltip 文本、打开时间弹层（draft 基线）→确定写回 timeCondition、清除定时→hours=[]、⋯→删除确认→行移除、熔断区常显+5 参数+默认 hint、空串回默认、validatePlanLocal 预检（同模型 3 条保留）。目标 ~16 例 | MUST：拖拽断言 drop 后 items 顺序 + priority 重排；MUST：validatePlanLocal 既有断言语义不丢 | 既有 19 例 | 重写 |
| ui-v2 | `app/server/**` | — | 零改动 | 后端 API/校验/路由/熔断全部不动 | MUST NOT：任何 server 文件 diff | 纯前端边界 | 0 |
| ui-v2 | `app/web/src/components/studio-page/**`（squad 挂载下拉） | — | 零改动 | 已 PASS 不在范围 | MUST NOT：动 | leader 边界 | 0 |

## UI v2 影响面与风险

- **破坏性变更**：无。后端零 diff；数据形状零 diff；PUT/DELETE/GET 端点与载荷零 diff；唯一对外变化 = 设置页视觉/交互。
- **测试基线**：`bun run test`（web）全量必须绿；3 个测试文件重写后合计 ~38 例（v1 35 例）；web tsc 0 error。
- **风险点**：
  1. **快照回滚边界**：cancelDetail 恢复的是「进详情时刻」的深拷贝——保存成功后快照必须清 null（否则下次取消回滚到旧值）；方案在详情中删除条目后取消 = 恢复（demo 语义如此）。
  2. **jsdom 拖拽测试**：项目内无 dataTransfer 测试先例，需 `fireEvent.dragStart(handle, { dataTransfer: mock })` + `fireEvent.drop(row, { dataTransfer: mock })`；若 jsdom 拒绝需构造 `{ setData(){}, setDragImage(){} }` 最小 mock。
  3. **ModelPicker 无搜索**：demo 下拉内搜索框不实现（决策⑪记偏离，非冻结点）；老板若要，后续小迭代扩展 ModelPicker。
  4. **弹层互斥与 ModelPicker 内部 state**：ModelPicker 自管下拉开合（无法外部强关），时间弹层/更多菜单与它同时开不致命（各自 stopPropagation），但不追求互斥 ModelPicker——记已知限制。
  5. **挂载徽章双源聚合**：squad 列表接口失败/playground KV 空数组都是正常态（徽章「未挂载」或隐藏），不得阻断方案列表渲染。
  6. **≤300 行硬门禁**：section 重写若超 300 行，拆 `component-plan-card.tsx` 子组件（表内已授权，拆分需报备不算偏离）。
- **环境**：无新依赖（DragHandle/ToggleSwitch/ConfirmModal/ModelPicker/CircuitStatusBadge 全现有）；worktree 已就绪无需 bun install。

---

## 增量：熔断错误率滑动窗口（老板 2026-08-14 20:51 拍板）

> 老板原话口径：「最近的若干次，比如 20 次足够了。比如 60%，20 次失败 12 次就不要请求了。要加个窗口」——错误率轨道从「终身累计」改「滑动窗口（最近 N 次请求）」，默认 N=20，窗口失败率 ≥0.6 → Open。

### 滑窗决策结论（编号接续 UI v2 段 ⑰）

| # | 决策 | 理由 |
|---|------|------|
| ⑱ | **滑窗选型：环形 buffer 记每结果**（每 key 一窗口：`window: boolean[]` 长度 windowSize + 环形指针 `windowPos` + 已填样本数 `windowCount` + 窗口失败数 `windowFailures`）。时间桶（Hystrix rolling bucket 风格）**不采** | 老板口径是「最近 N 次**请求**」计数窗口而非时间窗口，环形 buffer 精确对应且 O(1) 写入；内存评估：每 entry 20 槽 + 3 计数 ≈ 200B，数百 entry（方案数 × 条目数）≈ 数十 KB，可忽略 |
| ⑲ | **minRequests 语义重定义：窗口有效样本 ≥ minRequests 才判错误率**（样本不足 → 错误率轨道沉默，靠连续失败轨道兜底）。参数保留不改名；UI 标签「最小请求数」改「**窗口样本数**」（en "Min Window Samples"） | leader 指定方向「窗口有效样本」；参数名 minRequests 不改（避免 API 契约破坏 + 前后端类型联动改动），只改展示文案消除误导 |
| ⑳ | **windowSize 进 CircuitConfig（默认 20），UI 高级区不加字段** | 老板「比如 20 次」= 默认预期，从简优先；API 层留可配口子（未来 UI 要加只需一个输入框）；v2 demo 视觉契约刚冻结不动。前端 CircuitConfig 副本（model-routing-types.ts）不加字段——PUT 载荷缺省 windowSize → 后端 fillCircuitDefaults 填 20，零前端结构改动 |
| ㉑ | **snapshot.errorRate 改窗口口径**（windowCount>0 ? windowFailures/windowCount : 0）；totalRequests/failureCount 保留终身累计（API 字段兼容，呈现历史总量）；前端红绿灯只读 presentation + remainingSeconds（component-circuit-status.tsx 实证），展示语义零影响 | leader 指定 errorRate 窗口口径；其余字段保留避免 API 破坏性变更，api spec 注释标明口径分界 |
| ㉒ | **窗口生命周期：状态转换不清窗口**（Closed→Open→HalfOpen→Closed 全程保留，旧失败随新请求自然滚出——满足老板「恢复后窗口不清但旧失败滚出」）；仅两处重建：entry 新建（空窗）+ 方案编辑致生效 windowSize 变化（清空重积累，口径一致性优先；编辑罕见，短暂样本不足由连续失败轨道兜底，consecutiveFailures 不清） | 恢复后清窗会让模型立即「洗白」，违背熔断观察语义 |
| ㉓ | **不变项写死**：连续失败轨道（阈值 4）原样——与窗口轨道并行 OR；AUTH directOpen 原样；HalfOpen 探测/限流/恢复语义原样（探测是真实请求，**结果照常记窗口**）；Open 冷却 60s 原样；差异化重试策略（§7 表）原样；routing_loop/routing_retry_policy 零改动 | leader 边界；探测记窗口使恢复后判定反映最新真实表现 |
| ㉔ | **新增校验**：windowSize 提供时必须整数 ∈ [1,1000]（防内存滥用）；跨参校验生效值 minRequests ≤ windowSize（否则窗口永不满 → 错误率轨道永久沉默，病态配置硬拒 400） | 防配置陷阱；validateModelRoutingPlan 既有模式内加两条规则 |

### 滑窗变更清单（method 级）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| 熔断 | app/server/src/llm/caller/circuit_breaker_registry.ts | CircuitEntry | 修改 | 加窗口四字段：window: boolean[]（建 entry 时按生效 cfg.windowSize 建槽）/ windowPos / windowCount / windowFailures；**保留** totalRequests/totalFailures 终身计数（snapshot 用） | MUST：entry 新建与生效 windowSize 变化时重建窗口（清四值）；MUST NOT 删终身计数字段 | 决策⑱㉒ | +18 |
| 熔断 | 同上 | pushWindow(e, failed)（私有方法） | 新增 | 环形写入：槽满覆盖旧值并修正 windowFailures/windowCount；O(1) | MUST 纯操作 entry 无副作用 | 决策⑱ | +12 |
| 熔断 | 同上 | entry() | 修改 | 已存在条目且生效 windowSize ≠ 窗口长度 → 重建窗口（清空四值，终身计数与 consecutiveFailures 保留） | MUST 编辑后口径即时一致 | 决策㉒ | +6 |
| 熔断 | 同上 | recordFailure | 修改 | totalRequests/totalFailures++ 保留；追加 pushWindow(e,true)（directOpen 分支也记）；Closed 判定条件改：consecutiveFailures ≥ failureThreshold **或** (windowCount ≥ cfg.minRequests 且 windowFailures/windowCount ≥ cfg.errorRateThreshold) | MUST NOT 改 half_open 探测失败立即回 Open 语义；MUST 窗口样本不足时错误率分支沉默 | 决策⑲㉓ | +8/-3 |
| 熔断 | 同上 | recordSuccess | 修改 | totalRequests++ 保留；追加 pushWindow(e,false)；HalfOpen 探测成功累计回 Closed 逻辑原样（回 Closed **不清窗口**） | MUST NOT 清窗口 | 决策㉒㉓ | +3 |
| 熔断 | 同上 | snapshot | 修改 | errorRate 改 windowCount>0 ? windowFailures/windowCount : 0；failureCount/totalRequests 仍输出终身值 | MUST 字段名/形状不变 | 决策㉑ | +2/-1 |
| 校验 | app/server/src/services/model-routing-validation.ts | CircuitConfig / DEFAULT_CIRCUIT_CONFIG | 修改 | CircuitConfig 加 `windowSize?: number`；DEFAULT 加 windowSize: 20（fillCircuitDefaults 展开自动生效） | MUST 默认 20；MUST NOT 改其余默认值 | 决策⑳；model_routing.md §2.1 | +3 |
| 校验 | 同上 | validateModelRoutingPlan | 修改 | 两条新规则：windowSize 提供时非整数或 <1 或 >1000 → 400；生效值 minRequests > windowSize → 400 | MUST 错误 message 明确（api §2.2 表风格） | 决策㉔ | +10 |
| 状态 | app/server/src/handlers/model-routing-status.ts | CircuitSnapshotEntry | 修改 | 注释更新：errorRate 窗口口径（最近生效 windowSize 次）；failureCount/totalRequests 终身口径——字段形状零变化 | MUST NOT 加/删字段 | 决策㉑ | +2/-2 |
| i18n | app/web/src/i18n/locales/zh-CN/app-dev-config.json + en/ | circuitMinRequests | 修改 | zh「最小请求数」→「窗口样本数」；en "Min Requests" → "Min Window Samples" | MUST zh/en 同步；MUST NOT 动 circuit 其余 4 参数标签 | 决策⑲；editor spec 熔断区 | +2/-2 |
| UT | app/server/src/llm/caller/__tests__/circuit_breaker_registry.test.ts | +describe 滑动窗口 | 修改 | 新增三场景：① 滚动——低连续失败序列（S FF 周期，连续失败恒 <4）窗口率达阈值触发 Open；第 21 次请求后最旧样本滚出（snapshot errorRate 下降断言）；② 窗口未满沉默——样本 < minRequests 时高失败率不开闸（连续失败 <4），第 minRequests 个样本到齐才触发；③ 恢复不清窗——Open→推 60s→HalfOpen 探测成功 ×2 回 Closed，断言窗口样本仍含旧失败，后续成功推入使旧失败滚出、errorRate 下降 | MUST 既有 14 例全绿（最长序列 10 次 < 20 窗口，两口径在 10 样本内同值，预期兼容；个别断言按新口径修注释属预期适配非偏离）；MUST 覆盖决策㉒生命周期 | leader UT 三场景指定 | +80 |
| 零改动 | app/server/src/llm/caller/routing_loop.ts / routing_retry_policy.ts / 前端组件结构 / model-routing-types.ts | — | 零改动 | registry 方法签名不变 → 调用方零改动；前端不暴露 windowSize | MUST NOT：任何签名变更 | leader 边界；决策⑳ | 0 |

### 滑窗影响面与风险

- **破坏性变更**：无 API 字段增删；CircuitConfig 加**可选**字段（旧载荷零 windowSize → 默认 20）；errorRate 数值口径变（窗口）但字段名/类型不变，前端红绿灯不读它。
- **行为变化（预期）**：长跑钝化修复——老成功不再稀释新失败；坏历史粘性修复——恢复后旧失败滚出，1 败不再回炉（旧口径 totalFailures 终身高企 → 现在窗口只看最近 20 次）。
- **风险**：
  1. **i18n 与 T4 同文件**（app-dev-config.json）：T4 增删 editor.* keys，本改 circuitMinRequests 标签值——key 不重叠可自动 merge，但 T4/T5 合并顺序需先到先合后 rebase 方（task-board 备注给 leader）。
  2. **既有 UT 语义兼容已推演**：现有错误率用例最长 10 样本序列，窗口 20 未满但 ≥ minRequests=10，判定与终身口径同值——预期全绿。
  3. **windowSize 重建的短暂沉默期**：方案编辑改 windowSize → 窗口清空 → 样本 < minRequests 期间错误率轨道沉默；连续失败轨道仍在（consecutiveFailures 不清）——兜底完整。
  4. **HalfOpen 探测计入窗口**：探测成功 ×2 回 Closed 后窗口含 2 成功，若窗口原失败率高，新请求触达时仍可能立即再 Open——这是「恢复后旧失败滚出前保持警惕」的期望语义，非 bug；spec §6.1 写明。
- **spec 同步**（本 change_plan 交付内完成，由 architect 直接落）：model_routing.md §2.1 CircuitConfig + §6.1 状态机图/默认参数/窗口语义 + §8.1 示例；PRD §2.7 状态机行+默认参数；api 21-model-routing.md §2 示例+§字段注释 errorRate 口径；ui editor spec 熔断区标签行。

---

## 增量：默认模型/方案挂载合并单 select 二选一（T6，老板 2026-08-14 21:44 拍板）

**老板原话**：「配置 playground、squad 默认模型/方案，应该是二选一，或者放在一个 select 里面，比如上面是模型下面是方案」。

**现状问题**（调研实证）：① squad 侧 `component-manage-tab.tsx` 两个独立控件（ModelPicker 选 modelDefault + Dropdown 选 modelRoutingPlanId）**可同时设置**，resolve 分支 2 方案静默优先——用户感知「都能配但不二选一」；② playground 侧**方案挂载写 UI 不存在**（`model-routing-api.ts` 仅有 listPlanMounts 读徽章），挂载只能靠 API。

### T6 决策（编号接续 ㉕-㉚）

> ⚠ **22:22 老板拍板严格互斥，本节㉖/㉗ 已否决作废**（老板原话「你必须只保留一个有效的」）——互斥语义、回退链一律以下方「T6 修正段（决策㉛-㉞）」为准；契约表 use-app-settings-config / section-default-models / manage-tab / 零改动 四行同步作废。coder3 勿按㉖（选方案保留模型）/㉗（休眠回退链）实现。

| # | 决策 | 理由 |
|---|---|---|
| ㉕ | **新组件 `common/component-model-or-plan-picker.tsx`**（~150 行）：trigger 复用 `ModelPickerTrigger`（value.modelLabel 是任意串，选中模型=formatModelDisplay「provider / model」、选中方案=「方案 · <方案名>」徽章前缀区分）；panel 自绘两段——上组标题「模型」+ 模型行（复刻 ModelPickerPanel 行样式：provider 分组+modelId 副标题）+ 下组标题「方案」+ 方案行（方案名，无副标题）。方案数据经 props `plans: {id,name}[]` 传入（消费方各自拉 routingPlans），模型数据组件内 `useProviders()`（同 ModelPicker）。**不扩展** ModelPicker（5+ 消费方：chat 输入/wizard/manage-tab/hire）、**不扩展** ModelPickerPanel（common primitive，extraTopItems 仅顶部一组无 optgroup） | 老板「一个 select 上模型下方案」=双组 panel；新组件零风险不动既有；trigger 视觉复用保风格一致（老板铁律：不自创 UI，照抄既有视觉） |
| ㉖ | **存储互斥=前端写策略「选模型必清挂载，选方案保留模型」**：选模型 → squad PATCH `{modelDefault, modelDefaultProviderId, modelRoutingPlanId: null}`（**必须清挂载**，否则 resolve 方案优先模型不生效）；playground 写 `default_models.chat=mid` + 挂载清（PUT model_routing `{}`）。选方案 → squad PATCH 仅 `{modelRoutingPlanId: planId}`（modelDefault 不传=保留）；playground 仅写挂载 `{playgroundPlanId}`（default_models.chat 不动）。**后端不加互斥硬校验**：存量双设数据存在（现状允许），硬校验拒绝存量 PATCH；resolve 层方案优先天然处理共存，UI 呈现对齐 resolve 真值（有挂载显示方案） | api spec §2.5 L112 既有钦定：「挂载方案后 squad.modelDefault 仍保留（作为解除挂载后回退默认）」——保留语义是已冻结契约；resolve 分支 2 不读 default（保留零副作用）；UC-3 回退链零改动成立；「清空」方案被拒：破坏 UC-3（方案删除→回退未设置→400 断裂）+ default_models.chat 是 chat/compact 同链共享清空影响 compact |
| ㉗ | **回退链（UC-3 语义零变化）**：删除方案 → deletePlan 自动解引用（既有：squad.modelRoutingPlanId 清 + playgroundPlanId 清）→ 分支 1 → resolveModel：session 显式模型 → **保留的默认模型生效（平滑回退）** → 都无 → ModelNotConfiguredError 400 引导配置。互斥写策略下保留值永远「旧于」挂载，删除即回退，无幽灵窗口 | 用户体验：删方案→自动回退之前选的模型，远优于回退未设置态报错；链路全既有代码零改动 |
| ㉘ | **resolve 双分支零改动**：`session-config.ts` resolveModelRoutingPlan / resolveModel / 分支逻辑全不动；routing_loop / registry / 熔断零改动（不碰 T5 滑窗成果）。互斥纯属配置写入层（UI）策略 | leader 边界确认；分支 4「resolve 只改配置层」；分支 2 挂载悬空→分支 1 兜底已有 |
| ㉙ | **playground 挂载写路径新增**：`model-routing-api.ts` 加 `savePlaygroundMount(planId: string \| null)` → PUT /config/app `{group:'model_routing', key:'default', data: planId ? {playgroundPlanId: planId} : {}}`（端点既有 KV 通用，**api spec 无新契约**）；UI 侧挂载 draft 并入 default tab 的 saveTab 批量保存流（与 default_models 同一控件同一保存语义） | leader「API 尽量前端收敛」；draft 合并保证二选一控件保存行为一致（不能选模型走保存按钮、选方案即时写） |
| ㉚ | **session 级不动 + i18n**：chat 页 session model select（ModelPicker 消费方）不在范围（PRD §2.4 四级职责 session 只能 model/default 既有）；i18n 分组标题 `groupModels`「模型」/`groupPlans`「方案」+ placeholder「选择模型或方案」zh/en（app-dev-config ns + studio ns 同构 4 文件） | leader 覆盖项 5/6 |

### T6 变更清单（method 级）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| 通用组件 | app/web/src/components/common/component-model-or-plan-picker.tsx | `ModelOrPlanPicker` + `ModelOrPlanValue` 类型 | 新增 | 新组件（~150 行）。props：`{value: ModelOrPlanValue \| null, plans: {id,name}[], onPickModel(sel: ModelSelection), onPickPlan(planId: string), onClear?, actionKey?, triggerClassName?}`；`ModelOrPlanValue = {kind:'model', selection: ModelSelection} \| {kind:'plan', planId, planName}`。内部：useProviders() 拉模型 + 展平（同 ModelPicker）；trigger=ModelPickerTrigger（模型→formatModelDisplay；方案→`方案 · name`）；panel 自绘两段（组标题「模型」/「方案」+ 分隔样式复刻 extraTopItems 的 p-1 border-b 模式 + searchable 复刻过滤逻辑）；选中态高亮当前值（模型比 providerId+modelId、方案比 planId） | MUST 视觉风格照抄 ModelPicker/ModelPickerPanel 既有 class 体系（老板铁律不自创）；MUST NOT 改 ModelPicker.tsx / component-model-picker-panel.tsx；MUST 方案列表为空时方案组显示空态文案（不隐藏组标题） | 决策㉕ | +150 |
| 前端 api | app/web/src/components/app-dev-config-page/model-routing-api.ts | `savePlaygroundMount` | 新增 | `savePlaygroundMount(planId: string \| null): Promise<void>` → PUT /config/app `{group:'model_routing', key:'default', data: planId ? {playgroundPlanId: planId} : {}}`（null=清挂载写空 record） | MUST 复用既有 putConfigClient/同文件 fetch 模式；MUST NOT 新增后端端点 | 决策㉙；api spec KV 通用 PUT | +12 |
| playground | app/web/src/components/app-dev-config-page/use-app-settings-config.ts | dmSnapshot/dmDraft 旁挂载态 + saveTab | 修改 | 加 `mountSnapshot`/`mountDraft: string \| null`（playgroundPlanId）state + `handleMountChange(planId: string \| null)`；dirtyOfTab(default tab) 纳入 mount draft 比对；saveTab 在 default tab 保存时追加调 savePlaygroundMount（在 default_models PUT 之后）并回写 mountSnapshot | MUST 二选一互斥写：handleMountChange(null→model 分支由消费方组合，见下行 section 改造；handleDefaultModelsChange 写 chat 时若 mountDraft 非空须同步清 mountDraft；handleMountChange 写 planId 时若 dmDraft.chat 非空**保留** dmDraft.chat（决策㉖ 保留语义） | 决策㉖㉙；hook 注释「不进本 hook」清单更新 | +40 |
| playground | app/web/src/components/app-dev-config-page/section-default-models-and-request.tsx | DefaultModelsGroup chat 行（ModelKeyRow） | 修改 | chat 行 ModelPicker 换 ModelOrPlanPicker；draft 双向：显示值 = mountDraft ? {kind:'plan'} : dmDraft.chat ? {kind:'model'} : null（方案优先呈现，对齐 resolve 真值）；onPickModel → handleDefaultModelsChange(chat, mid) + handleMountChange(null)（互斥清挂载）；onPickPlan → handleMountChange(planId)（chat 保留）；外层 x 清除 → 两 draft 同清（真未设置态） | MUST 保存按钮单一入口（不选方案即时写）；MUST x 清除语义=全清；MUST NOT 改 llm_request 组及其余行 | 决策㉖㉙；组长 UI spec | +30/-15 |
| squad | app/web/src/components/studio-page/component-manage-tab.tsx | modelDefaultSel/routingPlanId 两 state + save 组装 + L153-183 控件区 | 修改 | 两 state 合并为 `pick: ModelOrPlanValue \| null`（初值 = detail.modelRoutingPlanId ? plan : detail.modelDefault ? model : null，方案优先）；dirty 判定改 pick 对比；save 组装：pick 是 model → `{modelDefault, modelDefaultProviderId, modelRoutingPlanId: null}`；pick 是 plan → 仅 `{modelRoutingPlanId: planId}`（不传 modelDefault 字段=保留）；控件区 L153-183 两控件换一个 ModelOrPlanPicker（plans 从 routingPlans 列表取 {id,name}） | MUST 选模型必带 modelRoutingPlanId:null（否则方案静默优先）；MUST 选方案不传 modelDefault（保留回退）；MUST 删除 Dropdown import 与 routingPlanLabel 字段标签 | 决策㉖；api 21 §2.5 | +25/-30 |
| i18n | app/web/src/i18n/locales/{zh-CN,en}/app-dev-config.json + studio.json | `modelOrPlan.groupModels` / `modelOrPlan.groupPlans` / `modelOrPlan.placeholder` / `modelOrPlan.emptyPlans` / `modelOrPlan.planPrefix`（方案徽章「方案」） | 修改 | zh：「模型」/「方案」/「选择模型或方案」/「暂无方案」/「方案」；en："Models"/"Plans"/"Select a model or plan"/"No plans yet"/"Plan"。studio.json 加同构 keys（manage-tab 消费 ns） | MUST zh/en 同步（4 文件）；MUST NOT 动既有 routingPlanLabel（T4/T5 已用） | 决策㉚ | +10 |
| UT | app/web/src/components/common/__tests__/component-model-or-plan-picker.test.tsx | describe ×2 | 新增 | ① 两组渲染+选择：panel 开→「模型」组标题+模型行、「方案」组标题+方案行；点模型行→onPickModel、点方案行→onPickPlan、高亮当前值；trigger 显示：模型=provider/model、方案=「方案 · name」；② 互斥组合逻辑（消费方级 UT 在各自 test 文件）：manage-tab save 载荷断言（选模型带 planId:null / 选方案不带 modelDefault）；section-default 挂载 draft 联动断言（选模型清 mount draft / 选方案保留 chat draft） | MUST 全绿；MUST 载荷断言精确到字段级 | leader ET 前置 | +100 |
| 零改动 | app/server/src/handlers/session-config.ts / services/model-resolver.ts / services/model-routing-store.ts / llm/caller/* | resolveModelRoutingPlan / resolveModel / resolveDefaultModel / deletePlan | 零改动 | resolve 双分支、解引用、回退链全既有；后端不校验互斥 | MUST NOT 任何签名/逻辑变更 | 决策㉘㉗ | 0 |

### T6 影响面与风险

- **spec 同步**（本交付内由 architect 直接落）：PRD §2.4 挂载层级交互细节改「二选一单 select（上模型下方案）」+ UC-3 预期补「回退到保留的默认模型」；ui spec（component_data_map / manage-tab 消费方）注新组件行；api 21 §2.5 L112 加「互斥为前端写策略」注记（契约不变）。
- **风险**：
  1. **存量双设数据**（现状允许 modelDefault+planId 同设）：UI 打开显示方案（方案优先对齐 resolve 真值），用户不动维持现状不迁移——零数据迁移成本；用户一切换即按新互斥语义写入。
  2. **manage-tab 既有 UT/ET 断言两控件的用例需适配**（ET-2「挂载下拉」→ 合并 select 方案组）：属预期口径迁移非回归；ET case 文案 T6 增量段更新。
  3. **saveTab 顺序**：playground 保存先 default_models 后挂载（两 PUT 独立 record 无事务，中间失败→ chat 已写挂载未写=回退态显示旧挂载，重试即恢复——可接受弱一致，与既有 KV 保存语义一致）。
  4. **i18n 同文件弱冲突**（app-dev-config.json T4/T5 已改）：新 keys `modelOrPlan.*` 不重叠，先到先合后 rebase 方（同 T5 风险 1 惯例）。

---

## T6 修正段：严格互斥（决策㉛-㉞，老板 22:22 拍板，本段为唯一权威）

**老板原话**：「你必须只保留一个有效的」。否决理由：休眠模型=幽灵状态（不可见但方案删除时突然接管，不可预期）；两字段同值合法化迫使所有消费方实现隐式优先级规则；**类型必须显式、非法状态不可表示**（数据里一眼可判）。

### 修正决策

| # | 决策 | 理由/解法 |
|---|---|---|
| ㉛ | **严格互斥（双向清）**：选模型 → 清挂载（不变：squad PATCH `modelRoutingPlanId:null`；playground 挂载 record 写 `{}`）；选方案 → **清默认模型（改！）**：squad PATCH 显式清空 `modelDefault`+`modelDefaultProviderId`（按 PATCH 既有清空语义）；playground 清 `default_models.chat`（PUT `{}`）。**任意时刻两字段至多一个有值**。playground 两 record 写入顺序铁律=**先清后写**（先清 chat 再写挂载 / 先清挂载再写 chat）——中途失败落「双空」合法态，永不落「双设」非法态 | 老板拍板；非法状态不可表示；先清后写是崩溃安全不变量 |
| ㉜ | **UC-3 回退链重定义 + compact 解法**：方案删除 → deletePlan 自动解挂（既有）→ 分支 1 → **session 显式模型仍优先生效** → 无则**未设置态**（ModelNotConfiguredError 400 引导重新配置）——显式、可预期、无幽灵接管。**compact 障碍已消解（实证）**：chat/compact 同链（session-config.ts L10/L322 同一 SessionConfig）+ `build_invoke_context.ts` L181 无条件透传 `routingPlan` 进 InvokeContext → 挂方案时 compact 同走方案链，不读 chat 字段；「清 chat 断 compact」是 v1 误判（当时未核实 compact invoke 载荷），**后端零改动**，compact 解析与 chat 天然一致 | 回退到「显式默认」=未设置引导，而非不可见休眠模型；compact 无需任何改動 |
| ㉝ | **后端互斥校验结论=squad PATCH 加双非空 reject（~8 行），playground 无需校验**：squad PATCH 载荷同时带非空 `modelDefault`+非空 `modelRoutingPlanId` → 400（api 契约新增一个 400 case，防 API 误用产生新双设）；playground 两字段异 group 异 record，单 PUT 天然无法双写 → 零校验。**存量双设不迁移**：UI 方案优先呈现（对齐 resolve 真值），用户一触碰即收敛为合法单值；deletePlan 自动清挂载兜底——拒绝一次性迁移脚本（危险且无必要） | 「非法状态不可表示」落实在写入边界；存量靠呈现+触碰收敛，迁移 overkill |
| ㉞ | **resolve 分支零改动（再确认）**：session-config / model-resolver / model-routing-store / routing_loop / registry 零 diff 不变；严格互斥后分支判定更干净（无双值状态）。**唯一后端改动 = squad.ts 双非空 reject（㉝）** | 分支 2 挂载悬空→分支 1 兜底既有，兼容存量与删除瞬态 |

### 契约表修订（覆盖 v1 表中 4 行；其余行——新组件/savePlaygroundMount/i18n——不变）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| 后端校验 | app/server/src/handlers/squad.ts | PATCH 校验段 | 修改 | 载荷同时含非空 `modelDefault` 与非空 `modelRoutingPlanId` → 400（message 如 `modelDefault and modelRoutingPlanId are mutually exclusive`）；null/undefined 参与的组合（如选模型带 planId:null）合法放行 | MUST 错误入 api §2.5 错误表；MUST NOT 拒绝既有存量 PATCH（只校验载荷组合，不查落库后联合状态） | 决策㉝ | +8 |
| playground | app/web/src/components/app-dev-config-page/use-app-settings-config.ts | mountDraft 联动 + saveTab | 修改 | handleMountChange 写 planId 时**同步清 dmDraft.chat（undefined）**；handleDefaultModelsChange 写 chat 时清 mountDraft（null）。saveTab 顺序改**先清后写**：选方案→先 PUT default_models `{}` 再 PUT 挂载；选模型→先 PUT 挂载 `{}` 再 PUT default_models | MUST 双向清（至多一个有值）；MUST 崩溃安全（任何中断落双空合法态） | 决策㉛㉜ | +40 |
| playground | .../section-default-models-and-request.tsx | chat 行（ModelKeyRow） | 修改 | （v1 行基础上改一处）onPickPlan → handleMountChange(planId) **+ handleDefaultModelsChange(chat, undefined)（清）**；显示值不变（mountDraft ? plan : dmDraft.chat ? model : null）；x 清除=两 draft 同清（不变） | MUST 选方案清 chat | 决策㉛ | +30/-15 |
| squad | .../studio-page/component-manage-tab.tsx | pick state + save 组装 | 修改 | （v1 行基础上改一处）pick 是 plan → PATCH `{modelRoutingPlanId: planId, modelDefault: <清空>, modelDefaultProviderId: <清空>}`（显式清，非省略）；pick 是 model → `{modelDefault, modelDefaultProviderId, modelRoutingPlanId: null}`（不变）；初值=方案优先（不变） | MUST 载荷双向清空；MUST UT 断言严格互斥载荷 | 决策㉛㉝ | +25/-30 |
| 零改动（修订） | session-config.ts / model-resolver.ts / model-routing-store.ts / llm/caller/* | resolve 链 | 零改动 | **v1「后端零改动」承诺收窄**：仅 squad.ts +8 行校验（㉝），其余后端零 diff | MUST NOT resolve 链任何变更 | 决策㉞ | +8 |

### 修正风险

- **存量双设呈现**：UI 打开显示方案（resolve 真值）；用户不动=存储保持非法双设但行为正确（方案优先）——靠触碰收敛，无迁移。
- **compact 行为变化（预期）**：挂方案时 compact 同走方案链（v1 已如此，非 T6 引入）；方案删除且未设置默认 → compact 与 chat 同报 400——显式可预期，符合老板口径。
- **ET-7 预期改写**：删除方案 → select 回**未设置态 placeholder**（非回显旧模型）；session 显式模型仍优先。
