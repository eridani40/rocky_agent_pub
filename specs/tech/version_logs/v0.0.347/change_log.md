# v0.0.347 change_log — 模型路由降级（组合方案 + attempt 内路由 + 三态熔断）

> 权威契约：`specs/tech/version_logs/v0.0.347/change_plan.md`（frozen）。
> 本文件按 change_plan 顶部合同记录**编码/评审期偏差**；change_plan 本身不可改。
> 引用：req `5af017f0b` · arch `b9c8e9467` · test-plan `204848d61` · T3 前端 `8113b1f62` · T1 补录 `4c716b755` · T2 补录 `529945438` · BUG-001 修复 `3a0651e4f` · UI v2 change_plan `e4582e87b` · T4 实施 `acf9b4b83`/`bebf504cc` · review 收尾 `25b7c0b45` · 验证产物 `e9ba7c3a9` · ET 适配 `a93984b21` · T5 滑窗 `27634c93d` · T6 架构修正 `6dbb8ee50` · T6 实施 `4488c49ba`/Minor `cd17031f7` · T6 ET case `6123f58df`。

## 变更摘要

| 层 | 内容 |
|---|---|
| 后端配置层 T1（coder） | 方案校验/存储（model-routing-validation / model-routing-store）+ kv-config DELETE 白名单 + PUT 校验钩子 + squad.modelRoutingPlanId 三语义 + status 端点（T1 空 registry 基态） |
| 后端路由层 T2（coder2） | resolve 分支 2（resolveModelRoutingPlan 合成候选链）+ routing_loop attempt 内路由 + routingRetryPolicy 差异化重试 + CircuitBreakerRegistry 三态熔断 + clientFactory 真实化 + 透传链接线 |
| 前端 T3（coder3） | 方案库 section + 方案编辑器 + 时间控件自研 + 红绿灯 + squad 挂载下拉 + i18n |
| 前端 T4（coder3） | UI v2 改版（demo v2 冻结视觉契约：两层结构 + 7 列行 + 弹层草稿态）+ 试玩补丁（方案详情独立页 + provider 对称 + 语义三分）+ blocking 闪回修复（骨架恒定） |
| 后端 T5（coder2） | 熔断错误率滑动窗口（环形 buffer 默认 20 + minRequests 语义重定义 + snapshot 窗口口径 + 校验两条 + i18n 标签）`27634c93d` |
| 前端+校验 T6（coder3） | 默认模型/方案合并单 select 严格互斥（ModelOrPlanPicker + 双向清 + squad PATCH 双非空 400 + 回退链重定义）`4488c49ba` |

## 实现核对（T1 后端配置层）

| 计划项 | 实现一致性 |
|---|---|
| model-routing-validation.ts | ✅ validateModelRoutingPlan 全规则纯函数：name/items 非空；每条目 providerId+modelId 指向 enabled provider 的 enabled model；同模型按启用条目分组 ≤2 条/禁 2 带时间/禁 2 不带时间/带时间在上；priority 正整数唯一；enabled 缺省 true |
| model-routing-store.ts | ✅ listPlans（缺失=[]）/ getPlan（undefined=未配置）/ savePlan（校验先跑，违规 throw）/ deletePlan（解除 squad + playground 引用先于删 record，返 detached 清单）/ getPlaygroundPlanId + setPlaygroundPlanId（planId 非空校验存在） |
| kv-config-handlers.ts | ✅ DELETE 分支：group 白名单（仅 model_routing_plans 放行，其他 405）→ deletePlan；PUT 分发前 group 特判：model_routing_plans → validateModelRoutingPlan（违规 400 + message）；model_routing → setPlaygroundPlanId 校验（planId 不存在 400） |
| squad.ts | ✅ schema + PATCH 三语义（undefined 不写 / null 清空 / 非空校验 plan not found）+ SquadDetail 回显 modelRoutingPlanId |
| model-routing-status.ts | ✅ GET /model-routing/plans/:planId/status：只读内存快照 + D16 presentation 映射 + remainingSeconds（T1 端口 EmptyCircuitRegistry，T2 接真实 registry） |

## 实现核对（T2 后端路由层）

| 计划项 | 实现一致性 |
|---|---|
| routing_loop.ts | ✅ routingAttemptLoop 主循环：时间过滤→enabled→熔断 Open skipped+banned→banned 去重→attemptLoop 单次调用复用+差异化重试→成功 recordSuccess 返回/失败 recordFailure+降级→耗尽聚合错误；ABORTED 不算失败；换模型 0 sleep |
| routing_retry_policy.ts | ✅ 纯函数 LlmErrorCategory→{inModelRetries, directOpen}：429/529/401/403/请求类=0 次；瞬态=1 次；AUTH=directOpen |
| circuit_breaker_registry.ts | ✅ 三维 Map 三态机：连续失败≥4 或 total≥10 且 errorRate≥0.6→Open / AUTH directOpen / 到期 Open→HalfOpen 限流 1 并发 permit 归还 / 半开连续成功≥2→Closed / 半开探测失败立即回 Open；默认 4/2/60/0.6/10，方案级 circuit 覆盖 |
| session-config.ts 分支 2 | ✅ resolveModelRoutingPlan：先查挂载（studio=squad.modelRoutingPlanId / playground=model_routing.default.playgroundPlanId）→ 有挂载产出候选链 + 生效熔断参数（不 resolveModel）；无挂载分支 1 零改动；**academy 排除**（isAcademy 参数） |
| llm_caller.ts | ✅ InvokeContext.routingPlan/circuitRegistry + invokeCore 检测 ctx.routingPlan → routingAttemptLoop 路由分支（L223）；无 routingPlan → 现有循环零改动 |
| build_invoke_context.ts | ✅ 透传 + clientFactory 真实化（clientBuilder 双分支：有→真实构造 / 无→占位回退 input.client） |
| 透传链 | ✅ agent-loop-base CallLLMInput.routingPlan/clientBuilder（可选）→ agent-loop-call-via-invoker 透传 → loop-stage-llm 条件注入（config.modelRoutingPlan 存在时） |
| misc-routes.ts | ✅ EmptyCircuitRegistry → getCircuitBreakerRegistry 单例替换 |

## 实现核对（T3 前端）

| 计划项 | 实现一致性 |
|---|---|
| component-hour-grid-picker.tsx | ✅ 自研 24 格（0-23）网格：拖拽连续段（mousedown 起点 + mouseenter 扩展 + mouseup 结束）、多段加选（已选段外新起点 = 追加）、已选段内反向拖拽 = 减选、清空=全天按钮（hours:[]）、hover tooltip「02:00-03:00」（跟随鼠标）、受控 value/onChange、disabled 整体禁用、`normalizeHours`（0-23 白名单去重升序）。testid：hour-grid / hour-cell-{h} / hour-grid-clear / hour-grid-tooltip |
| component-circuit-status.tsx | ✅ CircuitStatusBadge 三态呈现（D16）：normal→🟢正常 / abnormal→🔴异常带倒计时 remainingSeconds（本地每秒递减）/ observing→🟡观察中（无倒计时）；data-testid="circuit-status" + data-presentation；导出 CircuitPresentation |
| component-model-routing-plan-editor.tsx | ✅ 方案名 + 有序条目列表（#priority + ↑/↓ 越界禁用 + enabled 开关 + ✕ 删除）+ ModelPicker 复用 + 时间条件入口（不限/只在以下小时可用→HourGridPicker）+ 同模型约束本地预检（validatePlanLocal：≤2 条/禁 2 带时间/禁 2 不带时间/带时间在上，按启用条目统计）+ 熔断高级区（5 参数缺省 4/2/60/0.6/10）+ 服务端 400 透传（serverError）。纯函数：validatePlanLocal / moveItem / reindexPriorities / DEFAULT_CIRCUIT |
| section-model-routing-plans.tsx | ✅ 方案库列表：新建（ulid + 方案 N 直接进编辑）/ 复制（副本独立 id 深拷贝）/ 重命名（input 态）/ 删除（ConfirmModal 提示解除挂载 + detached 提示）+ 红绿灯状态（statusMap 并行拉 status 端点）+ 保存（reindexPriorities + circuit 空对象清理） |
| section-tab-panel.tsx + app-settings-config-defs.ts | ✅ models tab providers section 下追加 `<SectionModelRoutingPlans />`（mt-8 包裹）；`MODEL_ROUTING_PLANS_GROUP_ID = 'model_routing_plans'` 常量（自渲染范式，不进 KV_GROUPS/TAB_KV_GROUPS） |
| studio squad 管理面板 | ✅ component-manage-tab.tsx：routingPlanId state（null=未挂载）+ 拉 listModelRoutingPlans + dirty 判定 + save 透传 `modelRoutingPlanId: routingPlanId ?? null` + Dropdown（nullable + NULL_VALUE）+ cancel 同步；squad-types.ts 加 `modelRoutingPlanId?: string` + `PatchSquadBody.modelRoutingPlanId?: string \| null` |
| i18n | ✅ app-dev-config.json（zh-CN/en）：group.model_routing_plans.label + modelRouting 命名空间（list/editor/validate 7 条/status 3 词/delete/detachedHint/time）；studio.json（zh-CN/en）：manageTab.routingPlanLabel |
| 组件测试 | ✅ component-hour-grid-picker.test.tsx（9 例：24 格/回显/拖拽连续段/多段加选/段内减选/清空=全天/hover 显示/hover 消失/normalizeHours）；component-model-routing-plan-editor.test.tsx（19 例：条目增删/上移下移/enabled/时间条件打开收起/熔断高级区/400 透传/validatePlanLocal 全规则/停用不占额度/moveItem/reindexPriorities/DEFAULT_CIRCUIT）。**均绿** |

## 实现偏差（T1 后端配置层）

| # | 计划项 | 偏差内容 | 原因/依据 | 状态 |
|---|--------|----------|-----------|------|
| 1 | squad-service 改 squad 元信息 | **squad-service 无需改**——PATCH 落盘在 handler 层既有模式（squad.ts handler 直接写），service 层无改动点 | 架构核对：PATCH /squad/:id 三语义（undefined/null/非空校验）在 handler 层实现即可 | ✅ 核对成立 |
| 2 | status 端点接真实熔断注册表 | T1 用 **EmptyCircuitRegistry 端口**（基态：无方案/无调用 → closed） | T2 才产出 CircuitBreakerRegistry；T1 端口隔离，T2 仅换注入处（misc-routes 单例替换） | ✅ 核对成立 |

## 实现偏差（T2 后端路由层）

| # | 计划项 | 偏差内容 | 原因/依据 | 状态 |
|---|--------|----------|-----------|------|
| 1 | clientFactory.getClient 直取 client | **clientFactory 真实化需 clientBuilder 注入**：`buildInvokeContext` 的 clientFactory 双分支——`input.clientBuilder` 存在 → `clientBuilder(provider.id, model.modelId)` 真实构造（buildLlmClient 按 providerId/modelId 组装，loop-stage-llm 从 SessionConfig.appConfig+pluginManager 构造）；无 clientBuilder（= 无 routingPlan）→ 占位回退恒返回 `input.client`（与 T2 前行为逐字节等价） | 多候选模型需按 (providerId, modelId) 真实组装 client，不能只按 modelId | ✅ 已报 leader |
| 2 | 透传链 | **3 个表外文件最小接线**：agent-loop-base `CallLLMInput.routingPlan/clientBuilder`（可选）→ agent-loop-call-via-invoker `buildInvokeContext` 透传 → loop-stage-llm 从 `config.modelRoutingPlan` 注入 | 装配链穿透所需；无 routingPlan 时 clientBuilder 键不存在 → 零影响 | ✅ 已报 leader |
| 3 | 半开探测失败 | **半开探测失败立即回 Open**（circuit_breaker_registry.ts recordFailure half_open 分支） | 探测失败说明下游仍异常，不必等超时 | ✅ 已报 leader |

## Major 修复（code-review 发现）

| # | 层 | 问题 | 修复 |
|---|---|---|---|
| T1 Major-1 | validation | 保留字 modelId `default`/`none` 穿透方案校验（validateModelId 保留字白名单对方案条目不适用） | `isReservedModelId` 前置拦截 → 400 `model not found or disabled`；补 2 UT（default/none 拒绝） |
| T2 Major-1 | circuit 时序 | routing_loop `getState`/`tryAcquirePermit` 不传 cfg → entry 首次创建用默认 cfg，后续 `recordFailure(plan.circuit)` 因 entry 已存在被忽略（**UI 高级区 5 参数全失效**；已实证 failureThreshold=2 下 2 次失败仍 closed） | routing_loop 所有 registry 触点（getState/tryAcquirePermit/recordSuccess/recordFailure）一律传第 4 参 `plan.circuit` + registry `entry()` 已存在时同步更新 cfg；补 UT（failureThreshold=2 方案 2 次失败→open，覆盖真实 routing 时序） |
| T2 Major-2 | academy 排除 | resolveModelRoutingPlan 无 kind 参数，academy 会话（isStudio=false）误走 playground 挂载，绕过 classroom 三档链（违反 tech「academy 集成=非目标」） | 加 `isAcademy` 参数（`isAcademySessionKind(kind)`），academy 会话直接分支 1；补 2 UT（resolve 层 + buildSessionConfigFromDeps 层走 classroom 链） |
| T3 M1 | HourGridPicker | 单击未选中格不生效（select 模式不立即 applyRange，toggleHour 死代码） | handleMouseDown 起点立即 applyRange(h,h,mode)；补 2 单击用例（选中/取消） |
| T3 M2 | handleSave | 未本地拦截 validatePlanLocal → 不合法也 PUT | 保存前查 errors，不合法不 PUT（throw 由编辑器 400 区展示） |
| T3 m2 | i18n | title tooltip 含熔断词（en "circuit open countdown" 违反 MUST NOT） | 改为「模型异常，N 秒后自动恢复」/ "temporarily unavailable, retry in Xs" |
| T3 m3 | Dropdown | nullable label 未参数化 | nullableLabel prop（挂载方案上下文传「未挂载」替代「野生/不挂 KR」） |

## 实现偏差（T3 前端，coder3）

| # | 计划项 | 偏差内容 | 原因/依据 | 状态 |
|---|--------|----------|-----------|------|
| 1 | 时间控件依赖 react-availability-grid v2.x | 实际 npm 最新为 **0.2.1**（无 2.x 版本） | change_plan 选型写 v2.x 有误；装 ^0.2.1 | ✅ leader 批准（2026-08-14 11:58） |
| 2 | 时间控件封装 TimeGrid 单日视图 | **主选集成失败 → 自研 HourGridPicker**（决策⑧ 兜底条款） | react-availability-grid 0.2.1 内部 hours 生成用 `latestEnd.hour()`（0-23 数字）+ 日期比较：`hour(24)` 进位成 0 → hours 数组空（0 格）；`hour(23)` 只能渲染 23 格（缺 23 点）。**硬限制无法 hack 出「每天重复 24 小时格」语义**。备选 react-available-times 1.4.0 peerDependencies `react ^0.14\|\|^15\|\|^16`，React 19 不可用，7 年未维护。兜底：自研 ~150 行小组件，交互满足选型标准 4 条（拖拽连续段/多段加选/清空=全天/hover 提示），输出恒 `{hours:number[]}` 0-23 白名单 | ✅ leader 批准（决策⑧ 兜底，2026-08-14 11:58） |
| 3 | 依赖 react-availability-grid + dayjs | **两者均移除**（package.json 无残留） | 自研组件不依赖外部库；dayjs 无其他引用 | ✅ 符合 leader 要求「package.json 不要留 react-availability-grid」 |
| 4 | i18n `settings.json` 加 modelRouting 命名空间 | 实际加到 **`app-dev-config.json`**（zh-CN/en） | 项目 i18n 无 settings.json；models tab 现用命名空间为 app-dev-config.json（group.providers.label 等均在此），按现有范式落地 | ✅ leader 批准（2026-08-14 11:58） |
| 5 | 时间条件展开态 | `timeOpenIndex` 初始化为**第一个带时间条件的条目**（而非默认 null） | 打开已有时间条件的条目时用户应能看到已选小时格；否则有 timeCondition 却不可见 | 实现细节，合理偏离 |

## BUG-001 修复（vite proxy 漏配，ET-3 实证）

- **现象**：dev 前端拉 `model-routing/plans/:id/status` 被 vite 当 SPA 路由吞成 index.html（text/html，HTTP 200）→ 红绿灯恒不渲染；后端直连正常（application/json）。packaged 不受影响。
- **根因**：`app/web/vite.config.ts` dev server proxy 漏配 `/model-routing` 前缀（同类先例已 6 次：/skill、/squad、/mention、/memory、/consolidation、/academy）。
- **修复（全量排查一次修全）**：后端 routes 全量前缀提取（startsWith + match 正则）vs proxy 列表 + 前端真实请求比对，补 3 个漏配前缀：
  1. `/model-routing`：本次根因（status 红绿灯端点 + 方案 CRUD）
  2. `/skills`（复数）：v0.0.166 skill 市场 `/skills/market/*`，misc-routes 注释明确复数≠单数，`/skill` proxy 前缀覆盖不到（潜伏同类 bug）
  3. `/bootstrap`：v0.0.150 `/bootstrap/status` 启动迁移错误提示（app-shell 拉取，潜伏同类 bug）
- **回归固化**：`app/web/src/vite-config.test.ts` REQUIRED_PROXIES 从 8 项扩到 15 项（补 /mention /memory /consolidation /academy /model-routing /skills /bootstrap），新增端点必须补 proxy + 补断言。
- **验证**：ET vite（45347，API 43347）自动重启后：
  - `GET /model-routing/plans/nonexistent/status` → **404 application/json**（修复前 text/html 200；与后端直连一致）
  - `GET /skills/market/search` → 400 application/json（与后端直连一致）
  - `GET /bootstrap/status` → 500 application/json（与后端直连一致）
  - 对照未配路径 `/nonexistent-xyz` → 仍 text/html 200（SPA 兜底成立，证明透传差异来自 proxy 配置）

## BUG-002 修复（方案重命名无效，ET-4 blocking）

- **现象**：ET-4 发现方案重命名无效——输入新名 + Enter 后名称不变（变回原 ULID）。
- **根因**：`section-model-routing-plans.tsx` 重命名 input 用 `defaultValue` + `autoFocus` 但**无 onChange**（用户输入不进入任何 state）；`handleRename` 读 `renameDraft?.trim()`，但 renameDraft 只有 null/plan.id 两个值（编辑态标记），**用户输入值从不被读取** → Enter 后 name=plan.id（ULID）→ 名称不变。
- **修复**：
  1. `renameDraft` 从 `string | null`（只存 planId）改为 `{ planId, value }`（编辑态 + 受控输入值）
  2. input 改受控：`value={renameDraft.value}` + `onChange` 同步输入值
  3. `handleRename` 读 `renameDraft?.value.trim()`（空/未变更不 PUT，校验保持）
  4. 点重命名按钮 → `setRenameDraft({ planId: p.id, value: p.name })`（初始值为原名）
- **测试**：新增 `section-model-routing-plans.test.tsx` 5 例（受控回显 / 新名 Enter → PUT 带新名 id 不变 / 空白不 PUT / 同名不 PUT / Escape 取消不 PUT），全绿；回归 hour-grid 11/11 + plan-editor 19/19；web tsc 0 error。

## 装配链集成回归（T2 收尾）

- **修复前**：routing 分支接入后 agent-loop 等 6 文件 **25 例失败**（client 构造链路断裂）。
- **修复后**：agent-loop 等 6 文件 **60/60 全绿** + build_invoke_context.test.ts **5 例** + routing_loop **11 例** + circuit_breaker **12 例** + 全量 agent+llm **1819 tests 零回归**。
- 2 个 Minor 观察项（不阻塞）：llm_caller 无 invoke 级集成用例（装配链以 build_invoke_context/loop-stage-llm 单测覆盖）；`as never` 类型逃生舱（占位回退分支）。

## 测试结果

- T1：新增 4 文件 48 例全绿（validation 21 / kv-config 14 / squad patch 6 / status 7）+ 回归 156 例；复验 50/50（含 Major-1 补 2 例）；server tsc -b 0 error
- T2：新增 3 文件 31 例全绿（circuit_breaker 12 / routing_loop 10 / session-config 分支2 9）+ llm_caller/session-config 回归 433 例；复验 34/34 + 45/45 + 88/88；server tsc -b 0 error
- T3：`bun --bun x vitest run` hour-grid-picker **9/9** + plan-editor **19/19**；独立复审复验 hour-grid **11/11** + plan-editor **19/19** + app-dev-config-page 全目录 **238 passed** + studio 相关 **20 passed**；web tsc **0 error**
- AT：**4/4 pass**（mr_tc1 CRUD+400 / mr_tc2 / mr_tc3 / mr_tc4 35s LLM 调用）；错误形状 `.error` 断言（对齐全仓 KV 错误统一形状）
- ET：见 e2e 报告（与 doc-sync 并行，合并前门禁）

## 文档同步清单

- tech：`specs/tech/agent/providers_and_models/[P0]model_routing.md`（§4 academy 排除 + client 组装 / §5 装配链 + 方案级 circuit 覆盖 / §9 时间控件自研已发生 + UI v2 弹层化）
- tech：`specs/tech/config/[P0]app_config.md`（group 集合补 model_routing_plans + model_routing）
- api：`specs/api/overall/21-model-routing.md`（§2.2 错误形状 message→body.error + §4 错误码表）
- api：`specs/api/overall/11a-squad-endpoints.md`（PatchSquadBody.modelRoutingPlanId + SquadDetail 回显 + 错误行）
- ui：新建 `component-hour-grid-picker.md` / `component-circuit-status.md` / `component-model-routing-plan-editor.md` / `section-model-routing-plans.md` + `06-studio.md §3.2`（挂载下拉）；**T4 UI v2 后**：前 4 个 spec 按实际代码重写（两层结构/7 列行委托/弹层草稿态）+ 新建 `component-plan-card.md` / `component-plan-item-row.md` / `model-routing-plan-lib.md`
- version logs：`specs/prd/version_logs/v0.0.347-model-routing.md` + `specs/api/version_logs/v0.0.347/change_log.md` + providers_and_models/log.md + config/log.md

## Task 4：UI v2 改版（demo v2 视觉契约落地）

- **交付**：两层结构（方案卡片列表 → 详情）+ 7 列条目行 + 弹层化 HourGridPicker（草稿态 + 语义翻转 + footer）+ 挂载徽章 + 熔断区常显 + i18n 增删 + 3 测试文件重写 46 例。
- **验证**：3 测试文件 46/46 绿；app-dev-config-page 全目录回归 224/224 零回归；web tsc 0 error；单文件最大 289 行（≤300 门禁）。
- **偏离 1（契约缺口）**：change_plan 决策⑯ 前提「SquadSummary 已含 modelRoutingPlanId」不成立——server `toSummary` 不返回该字段（仅 toDetail）。`listPlanMounts` 改为 listSquads + 逐 squad getSquad（N+1 前端聚合，catch→null 降级），不动后端（守冻结边界）。代码注释已记录。
- **偏离 2（300 行门禁拆分，风险点 6 授权）**：
  - `model-routing-plan-lib.ts`（新）：validatePlanLocal / reindexPriorities / DEFAULT_CIRCUIT 从 editor 迁出（纯函数归位）；
  - `component-plan-item-row.tsx`（新）：7 列行展示组件（editor 227 行达标）；
  - `component-plan-card.tsx`（新）：方案卡片展示组件（section 289 行达标）。
- **删除**：moveItem 死代码（拖拽排序替代）；v1 时间模式 select / inline picker / name input / 格子 hover tooltip / editor 级红绿灯区。
- **i18n**：新增 list.modelsCount/mountedTo/unmounted/moreActions、editor.detailTitle/degradeOrder/timeCondition/defaultHint、time.popoverHeader/unselected/clearSchedule/confirm/errEmpty/errFull、deleteItem.*；删除 editor.nameLabel/timeLabel/timeAny/timeHours、time.helper/clearAll（zh/en 同步）。
- **偏离 3（契约项未实现）**：change_plan ui-v2 行契约列了 `mount.playground` i18n key——实现时挂载下拉上下文硬编码 'Playground'（demo 一致，v1 同形态），未加 key；已从 change_plan 契约行删除该 key。T4 code-review 知悉项确认（task.json Task 4 codeReview 记录）。
- **Minor-1 修复（review 收尾 `25b7c0b45`）**：hour-grid-picker 补 document mouseup 兜底清 dragRef——拖出网格松开（grid onMouseUp 收不到）后 dragRef 残留，鼠标无按键移回格子被 handleMouseEnter 误判为继续拖拽扩段；现为 grid onMouseUp 与 document mouseup 双清。

## T4 补丁：方案详情独立页 + provider 对称修复（老板试玩反馈，2026-08-14）

- **问题 1（结构性）**：进方案详情时 models tab 的 provider 列表残留上方。老板拍板「需要是个独立页面，详情页！」→ 修法升级为独立页独占：`SectionModelRoutingPlans` 加 `onViewLevelChange` 上抛（provider v0.0.140 机制同款，useEffect deps `[view.level, onViewLevelChange]` 含挂载初始 list）；`section-tab-panel` models case 持 `providerViewLevel`/`plansViewLevel` 双态，任一 detail 态时**独占渲染**（另一 section + 两 group 标题全隐藏；互斥由构造保证——detail 态下另一 section 列表不可见）；切 tab 重置防 stale（obsInDetail 先例同款 effect）。
- **对称修复 provider**：v0.0.140 机制存在但 tab panel L135 `<SectionProviders />` 未传 `onViewLevelChange`（接线断，leader 核查发现）——本次补上，provider 详情态同样隐藏方案库 group（含 h3 标题）。
- **问题 2（风格）**：老板原话「风格需要绝对一致……质量低下」→ 新建 `component-plan-detail.tsx`（拆分报备：section 300 行门禁 + 对称 provider 的 section/detail 文件结构），逐项照抄 `component-provider-detail.tsx`：面包屑（可点父级名 mono muted + `/` + 标题）/ logo 首字母块（w-12 h-12 rounded-[12px] bg-sage-bg text-sage）+ 16px 标题 + mono 副标题 / 底部 sticky `SaveBar variant="detail"`。
- **语义三分（provider detail 对齐）**：SaveBar 保存 = PUT → 清快照回列表（风险点 1 语义不变）；SaveBar 取消（`plan-editor-cancel`，dirty 可见）= 重置回快照**留详情页**（新 resetToSnapshot）；面包屑回退（`detail-back`）= 快照回滚（isNew 移除）退列表——决策⑨「取消 = 快照回滚」语义保留在面包屑路径。
- **SaveBar additive props**：`saveTestId`/`cancelTestId` 可选测试锚点（不传 = 无 testid，既有消费方零影响）；plan detail 传 `plan-editor-save`/`plan-editor-cancel`。
- **lib 新增**：`isPlanDirty(snapshot, draft)`（JSON 内容比对，dirty 判定语义对齐 provider isDirty）。
- **i18n 删除**：editor.back/save/cancel/detailTitle（旧 detail header 按钮组废弃；SaveBar 走 common ns，面包屑走 group.model_routing_plans.label，zh/en 同步）。
- **验证**：受影响 UT 适配（section 12 例 + merged 新增 2 例 detail 独占断言）全绿；app-dev-config-page 全目录 + SaveBar 回归 240/240；`tsc -b` 0 error；单文件最大 284 行（≤300 门禁）。
- **spec 同步**：`section-model-routing-plans.md`（detail 独立页契约 + viewLevel 上抛 + 语义三分）/ 新建 `component-plan-detail.md` / `model-routing-plan-lib.md`（isPlanDirty）；ET case et1/et3/et4 同步（detail-cancel 废弃 → SaveBar/面包屑语义，et2/et5 干净）。

## T4 补丁 blocking 回归修复：详情闪回进不去（ET 报障，2026-08-14）

- **根因（ET executor 源码定位 + 复核确认）**：69a41aed6 的 models case list 态渲染 `[div(h3+SectionProviders), div(SectionModelRoutingPlans)]`，detail 态却裸 return `<Section/>` —— children 同位置节点类型从 div 变 Section 组件 → React reconciliation 整树卸载重挂 → Section 内部 view state 丢失重置 list → 挂载 effect 上抛 list → 详情闪回。console 静默无报错；补丁前 a93984b21 同操作正常（69a41aed6 引入）。
- **修法（骨架恒定契约）**：顶层恒为 `[div, div]` 两容器，detail 态只用条件 null 置空槽位内容（slot 类型恒定：div0 = [h3|null, SectionProviders|null]、div1 = [SectionModelRoutingPlans|null]），保证 list↔detail 切换 Section 实例不重挂。plans detail 态 div1 去 mt-8（详情独占页顶对齐，与 provider 详情一致；className 条件化不影响 reconciliation）。
- **补 UT（教训：240 例绿但单 section 直渲染测不出 reconciliation 回归）**：section-tab-panel.test 新增 2 例集成测试——mock Section 用**真实 useState** 持内部 view state + 挂载计数器 + 挂载上抛 list（同真实机制），经真实 SectionTabPanel 树 list→detail 切换断言：① detail 态保持不闪回（level 仍 detail）② mountCount 不变（未重挂）③ 独占渲染正确。
- **验证**：tab-panel 6/6 + 全目录回归 242/242 绿 + tsc -b 0 error。

## T5：熔断错误率滑动窗口（coder2，老板 2026-08-14 20:51 拍板「20 次失败 12 次就不请求」）

- **决策源**：change_plan 增量段决策⑱-㉔。错误率轨道改**最近 windowSize(默认 20) 次请求**的滑动窗口失败率（环形 buffer），取代终身累计——修复长跑钝化（老成功稀释新失败）与坏历史粘性（恢复后 1 败即回炉）。
- **实现**（`27634c93d`，7 files +232/-13）：`circuit_breaker_registry.ts` CircuitEntry 窗口四字段（boolean[] 环形 buffer + windowPos 指针 + windowCount 已填样本 + windowFailures O(1) 维护）+ pushWindow 环形写入（槽满覆盖最旧并修正计数）+ entry() 生效 windowSize 变化重建窗口（终身计数/consecutiveFailures 保留）+ recordFailure/recordSuccess 记窗口（directOpen 探测也记）+ Closed 判定两轨道 OR（连续失败≥4 ∥ 窗口有效样本≥minRequests 且窗口失败率≥errorRateThreshold）+ snapshot.errorRate 改窗口口径（样本 0→0；failureCount/totalRequests 终身口径保留）；`model-routing-validation.ts` 两条新校验（windowSize 整数 [1,1000] / 生效 minRequests≤windowSize——窗口永不满=错误率轨道永久沉默，病态配置硬拒 400）；`model-routing-status.ts` 注释分界两口径；i18n circuitMinRequests 标签 →「窗口样本数」/「Min Window Samples」（唯一前端改动行）。
- **零改动边界**：既有 14 例 registry UT 兼容零改（最长 10 样本 < 20 窗口且两口径同值，已实证）；routing_loop / routing_retry_policy 零触碰。
- **review**：`verify/review/code-review-t5.md` **PASSED**（无 Critical/Major/Minor——契约表 11 行逐行对齐）。独立复跑：registry **16/16**（新 4 例：滑窗滚动第 21 次滚出/窗口未满沉默+连续失败兜底/恢复不清窗旧失败随成功滚出/窗口重建生命周期）+ validation **26/26**（新 3 例）+ 相关回归 611/611 + **全量 874 files 10609/10613 零回归** + tsc -b 0 error。
- **spec 同步（4 文件，架构期完成）**：tech model_routing.md §2.1/§6.1 + api 21 §2.2 校验表 +2 行 / §2.6 快照口径 + PRD 全文 §2.7 + ui editor spec 滑窗注记。
- **偏离**：无（review 零 Minor）。

## T6：默认模型/方案合并单 select 严格互斥（coder3，老板 21:44「二选一单 select」+ 22:22「必须只保留一个有效的」）

- **决策源**：change_plan v1 段（决策㉕-㉝）+ **修正段 `6dbb8ee50` 严格互斥（决策㉛-㉞；v1 决策㉖/㉗ 休眠方案作废）**——休眠=幽灵状态不可预期，非法状态必须不可表示。
- **实现**（`4488c49ba`，24 files +1153/-112）：
  - 新组件 `common/component-model-or-plan-picker.tsx`（253 行，骨架恒定）：trigger 复用 ModelPickerTrigger；panel 上组「模型」下组「方案」两组恒显（方案空→空态文案）；搜索两组同过滤；双向高亮（模型比 providerId+modelId、方案比 planId，aria-selected）。
  - squad manage-tab：pick state 合一（**方案优先初值**对齐 resolve 真值）；严格互斥载荷——选方案显式清空 `modelDefault`+`modelDefaultProviderId`（非省略）、选模型带 `modelRoutingPlanId: null`（UT 字段级断言）；删旧挂载 Dropdown 块。
  - playground：`savePlaygroundMount`/`getPlaygroundMount`（PUT /config/app group=model_routing key=default）+ hook 双向清（选方案清 chat / 选模型清挂载）+ **saveTab 先清后写**（崩溃安全：中断落双空合法态，永不落双设非法态）。
  - **后端唯一改动（偏离记录）**：`handlers/squad.ts` **+8 行**——PATCH 载荷双非空（modelDefault+modelRoutingPlanId 同非空）→ 400 `modelDefault and modelRoutingPlanId are mutually exclusive`（400 优先于 404）。超出 v1 段「纯前端」承诺，22:35 修正段已重拍板记录（决策㉝）；resolve 链零 diff（git 实证唯一后端文件）。
  - i18n：modelOrPlan.* 5 keys 双 ns（app-dev-config + studio，zh/en 同构）；既有 routingPlanLabel/routingPlanNone 保留（别处消费）。
  - ET et2/et4/et5 适配合并 select 交互（解除挂载=切回模型）。
- **回退链重定义（决策㉜）**：方案删除 → 解挂 → 分支 1 → session 显式模型 → **未设置态 400 引导**（无休眠模型接管）；compact 障碍消解实证（build_invoke_context L181 无条件透传 routingPlan，挂方案时 compact 同走方案链，v1「清 chat 断 compact」系误判，后端零 compact 改动）。
- **存量数据**：双设不迁移（resolve 方案优先兼容、UI 方案优先呈现、触碰即收敛、deletePlan 解挂兜底）。
- **UT**：picker 15 例新增 + manage-tab 互斥载荷 5 例（14/14）+ hook mount 6 例（先清后写字段级）+ squad 400 4 例（10/10）；**全量 874 files 10639 passed** + tsc -b 0 error。报告 `verify/unit-test/t6-model-or-plan-mutex.md`。
- **review**：`verify/review/code-review-t6.md` **PASSED**（无 Critical/Major；1 Minor=作废段决策编号注释残留 3 处，直接修复 `cd17031f7`）。十死磕点全过：双向清字段级断言 / 先清后写崩溃安全推演 / squad 400 优先 404 / resolve 链零 diff / 无休眠残留 / 组件 253 行骨架恒定 / spec consumers / UT 独立复跑 / ET 口径 / i18n 同构。
- **ET**：ET-6/7/8 全 **PASS blocking=0**（et6 合并 select 往返互斥+API 佐证单值落盘；et7 删方案回退 placeholder 无幽灵接管+chat 清空佐证；et8 双入口 DOM 实测同构+独立存储不串扰；留证 `verify/e2e/et6|et7|et8` + REPORT）。ET case 补写 `6123f58df`（et6/et7/et8 case.md 新建 + et2/et5 stale 引用顺手修：component-manage-tab.md 不存在 → 改指 06-studio.md §3.2 + 组件 spec）。
- **spec 同步（6 处，architect `6dbb8ee50` + coder3 补）**：PRD §2.4+UC-3 / api 21 §2.5 严格互斥 400 / tech model_routing §2.2 挂载互斥段 / 06-studio §3.2 合并 select / `section-default-models-and-request.md` 改写 / 新建 `common/component-model-or-plan-picker.md`（含 consumers 两处）。
- **遗留（不阻塞）**：BUG-003 SaveBar 首存 dirty 残留（二次点击收敛，落盘正确）/ BUG-004 删方案后 trigger 短暂显 planId（reload 收敛）——均 Minor，留 349/350 批修。
