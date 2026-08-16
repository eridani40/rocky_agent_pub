# v0.0.349 变更计划书 — provider 删除入口 + 方案 dangling 双语义

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 需求：`reqs/v0.0.349.provider-delete-and-dangling-plan-items.md`（老板 2026-08-14 22:00 拍板，无 PRD 环节）· 老板拍板语义：runtime 拿不到就跳过（容错）+ 重新编辑有失效 item 拦保存（严格）。参考记忆 `boss-dangling-ref-runtime-skip-edit-block`。
> 基线：dev1@ef36c64b6（含 v0.0.347 T6 全部代码）。

## 现状调研结论（源码实证，2026-08-15）

| # | 现状 | 实证位置 |
|---|------|---------|
| S1 | `DELETE /provider/:id` API **已存在**：tombstone 软删（`_deleted:true` 覆写 record），GET/PUT 不可见；**无引用检查、无 UI 入口**（`deleteProvider` 前端函数存在但零调用方） | `app/server/src/handlers/provider.ts` L171-179；`api-client.ts` L365；grep 全 web 零消费方 |
| S2 | **runtime 跳过已存在**：routing_loop 候选决策⑤ 构建 target 时 provider/model/key 拿不到即 `continue`（防御 provider 被删，注释明示） | `routing_loop.ts` L147-153 |
| S3 | **全 dangling 崩口**：挂载方案所有候选 dangling 时 `buildClientFromCandidates` 循环全 throw → 未捕获 500 | `session-config.ts` L193-213 + L352-356 |
| S4 | **编辑拦保存已存在**：PUT `model_routing_plans` 走 `validateModelRoutingPlan`，条目非 enabled provider 的 enabled model → 400（provider 删除后条目天然命中） | `model-routing-validation.ts` L113-141；`kv-config-handlers.ts` L148 |
| S5 | 失效条目 trigger 呈现已存在：`formatModelDisplay` provider 未命中 → 「模型不可用: modelId」（v0.0.43 P0-3） | `lib/providers.ts` L172-187 |
| S6 | 本地预检（`validatePlanLocal`）**不查** provider/model 存在性——失效条目本地预检不出，仅服务端 400 透传；编辑器无逐条失效视觉（红圈仅熔断态） | `model-routing-plan-lib.ts` L39-78 |
| S7 | 单模型被删 dangling 链已有兜底：resolveModel 不命中继续 fallback、ModelNotConfiguredError 终态 | `model-resolver.ts` L255-273 |
| S8 | 引用先例：`deletePlan` 扫 squad + playground 解挂返 detached 清单 | `model-routing-store.ts` L75-101 |

## 架构决策结论

| # | 决策点 | 结论 |
|---|--------|------|
| ① | UI 删除入口位置 | provider **二级详情页** SaveBar 右侧「删除」危险按钮 + ConfirmModal（老板 UI 铁律：不自创风格，同页已有 ConfirmModal 先例）。列表卡片**不加入口**（详情页承载 destructive 操作，与方案删除先例一致——方案也是详情级删除）。`deleteProvider` id 存在才渲染 |
| ② | 删除引用提示 | 删除确认弹层展示**通用警示文案**（「删除后引用该 provider 模型的组合方案条目将失效；正在使用其模型的会话将自动切换/回退其他模型」）。**不做删除前实时引用扫描 API**（新端点+新查询面=超范围成本；dangling 双语义已兜底容错+收敛，老板语义里删除是低仪式感操作）。提示放 i18n key |
| ③ | 删除调用链 | ConfirmModal ok → `DELETE /provider/:id`（既有端点零改动）→ `reload()` → 回 list（复用 section 既有 reload；删除即时生效不进 draft/diff-save，ConfirmModal 即确认，零误触风险） |
| ④ | runtime 全 dangling 容错 | `buildClientFromCandidates` caller 段（分支 2 client 组装处）try/catch：**全候选 throw → 降级 throw `ModelNotConfiguredError`**（携带区分性 message「方案内所有模型不可用…」；消费链已核实：agent-manager 透传 structured error code/detail → HTTP 400 MODEL_NOT_CONFIGURED，academy cores 已 catch 同类）。与分支 1「跑空 resolveModel → ModelNotConfiguredError」同构，时机同点（buildSessionConfigFromDeps，chat/run 入口）。**MUST NOT**：静默回退默认模型（违反 D11 方案优先不隐式兜底）。部分 dangling → 既有循环取首可用候选（零改动） |
| ⑤ | 本地预检补 provider/model 存在性 | `validatePlanLocal(plan, providers)` 加第二参：条目 (providerId, modelId) 未命中 enabled provider + enabled model → `modelRouting.validate.itemModelInvalid`（实时显示在本地预检区=编辑拦保存 UI 面）。**MUST NOT** 逐条行内错误标记（demo 冻结点无此视觉，memory ui-demo-must-freeze-visual-level） |
| ⑥ | PlanItemRow 失效视觉 | ModelPicker trigger 已天然显「模型不可用: mid」（S5），**再加红色 danger 描边**（`border-danger`，编辑器风格语言已有 danger token）——失效一眼可辨。样式由 PlanItemRow 内联判定（providers.find + models.find 双命中才正常） |
| ⑦ | BUG-003（SaveBar 首存 dirty 残留） | **纳入**：同域（设置页 dirty 聚合），修复=首存完成后回填 draft=snapshot（见契约行）。守 memory react-dirty-aggregation-state-not-ref（state 上报非 ref 查询） |
| ⑧ | BUG-004（删方案后 trigger 显 planId） | **纳入**：修复=删方案返回 detached 含 `playground` 时清本地 `mountDraft`/`pick` 对应态（数据侧已正确，纯前端 state 同步）。修在 section-model-routing-plans 删除回调 + squad 列表刷新路径 |
| ⑨ | 后端零改动范围 | provider DELETE 端点、tombstone 过滤、PUT 校验、routing_loop S2 防御、resolve 链——**全部零改动**（调研实证语义已达成）。后端本版仅 1 处改动（决策④ session-config）。tombstone→真删留待 persistence 层版本，对外语义不变 |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-providers | `app/web/src/components/providers/component-provider-detail.tsx` | `ComponentProviderDetail` | 修改 | SaveBar 行右端加「删除」danger 按钮（`provider` prop 非 null 才渲染）+ ConfirmModal（通用警示文案）；onOk → 调 `onDeleted()` 新回调（不调 onSaved） | MUST 删除按钮 danger 配色；MUST 新建态（provider=null）不渲染删除入口；MUST NOT 复用保存 dirty 通道 | 决策①②③；spec `02-llm-chat.md` §5 | +35 |
| ui-providers | 同上 | `ComponentProviderDetailProps` | 修改 | 加 `onDeleted?: () => void`（删除完成回调，父级负责 DELETE+reload） | MUST 可选保持向后兼容 | 决策③ | +2 |
| ui-providers | `app/web/src/components/providers/section-providers.tsx` | `SectionProviders` | 修改 | 实现 `handleDeleted(pid)`：调 `deleteProvider(pid)`（api-client 既有）→ `reload()` → `setView({level:'list'})` | MUST 失败走既有 error 通道；MUST 删除后回 list | 决策③ | +15 |
| ui-providers | `app/web/src/i18n/locales/{zh-CN,en}/providers.json` | `detail.delete` / `detail.deleteTitle` / `detail.deleteBody` | 新增 | zh：「删除」/「删除提供商」/「删除后引用该 provider 模型的组合方案条目将失效；正在使用其模型的会话将自动切换或回退其他模型。确定删除？」；en 同步 | MUST zh/en 同 key；MUST 文案含方案条目失效警示 | 决策② | +6 |
| ui-plan-editor | `app/web/src/components/app-dev-config-page/model-routing-plan-lib.ts` | `validatePlanLocal(plan, providers?)` | 修改 | 加可选第二参 `providers: ProviderItem[]`：每条目 (providerId, modelId) 未命中 enabled provider 的 enabled model → push `modelRouting.validate.itemModelInvalid`（停在本地预检区，不逐行标记） | MUST 未传 providers 时不做存在性检查（向后兼容旧调用/UT）；MUST NOT 复制服务端 message（本地 i18n 中文） | 决策⑤；api 21 §2.2 表语义 | +18 |
| ui-plan-editor | `app/web/src/components/app-dev-config-page/component-model-routing-plan-editor.tsx` | `ModelRoutingPlanEditor` | 修改 | 调 `validatePlanLocal(value, providers)`；props 加 `providers?: ProviderItem[]` 透传；本地预检区自动渲染新 error key | MUST 不新增 UI 结构（预检区已有 map errors） | 决策⑤⑥ | +6 |
| ui-plan-editor | `app/web/src/components/app-dev-config-page/section-model-routing-plans.tsx` | 详情渲染区 | 修改 | section 持 `useProviders()`（或既有数据通道）把 providers 传给 editor；删除方案回调里：DELETE 响应 detached 含 `playground` → 通知挂载方清态（回调/事件按现有结构，BUG-004 前端侧） | MUST providers 只读透传；MUST NOT 在 section 层重复存在性校验 | 决策⑤⑧ | +12 |
| ui-plan-editor | `app/web/src/components/app-dev-config-page/component-plan-item-row.tsx` | `PlanItemRow` | 修改 | props 加 `invalid?: boolean`；true 时 ModelPicker 外层容器加 `border-danger` 红描边（trigger 本身已显「模型不可用」） | MUST 仅描边不加新图标/行内文案（冻结视觉契约） | 决策⑥；PRD demo v2 冻结 | +6 |
| runtime-fix | `app/server/src/handlers/session-config.ts` | `buildClientFromCandidates`（caller 段 try/catch） | 修改 | 分支 2 client 组装处包 try/catch：全候选 throw → 降级 throw `new ModelNotConfiguredError(...)`（message 区分「方案内所有模型不可用，请编辑方案或检查 provider」）；部分命中零改动（既有循环） | MUST：不静默回退模型（D11）；MUST：error 时机与分支 1 同点（buildSessionConfigFromDeps，消费链 agent-manager 透传 code/detail → HTTP 400 MODEL_NOT_CONFIGURED 已核实）；MUST NOT：改 buildClientFromCandidates 函数本体签名（catch 在 caller） | 决策④；tech `[P0]model_routing.md` §4；S3/S7 | +12 |
| bug-003 | `app/web/src/components/app-dev-config-page/use-app-settings-config.ts`（实际归属以 BUG-003 复现点为准，见 `states/v0.0.347/bugs/BUG-003-*.md`） | saveTab（default tab 保存收尾） | 修改 | 首存双 PUT（先清后写）完成后把 draft 回填 snapshot（或等价的 state 上报收敛），消除「有未保存的改动」残留；二次点击收敛语义消除 | MUST dirty 聚合走 state 上报（memory react-dirty-aggregation-state-not-ref）；MUST 先写 UT 复现再修（红→绿） | 决策⑦；BUG-003 报告 | +15 |
| bug-004 | `app/web/src/components/app-dev-config-page/section-model-routing-plans.tsx` + squad 管理面板消费方 | 删除方案后的挂载态同步 | 修改 | DELETE detached 含 `playground` → 清 playground 挂载本地态（mountDraft/mountSnapshot 归 null）；squad 侧：squad 列表刷新使 pick 重建（方案删除后 pick 引用 planId 不存在 → 回退显示） | MUST 数据侧零改动（已正确）；MUST NOT 引入全局事件总线 | 决策⑧；BUG-004 报告 | +12 |
| tests | `app/web/src/components/providers/__tests__/component-provider-detail.test.tsx` | describe（删除流） | 新增 | 已存 provider 渲染删除按钮 / 新建态不渲染 / ConfirmModal 确认触发 onDeleted / 取消不触发 | MUST 沿既有测试文件风格 | 决策①③ | +40 |
| tests | `app/web/src/components/app-dev-config-page/__tests__/`（editor/section 既有 UT 文件内追加） | describe（dangling 预检 + 失效行） | 新增 | validatePlanLocal 二参：dangling 条目出 `itemModelInvalid` / 正常条目不出 / providers 缺省兼容；PlanItemRow invalid=true 红描边；section 传 providers 透传断言 | MUST 覆盖编辑拦保存本地面 | 决策⑤⑥ | +50 |
| tests | `app/server/src/__tests__/`（session-config 既有 UT 追加或新建） | describe（全 dangling 降级） | 新增 | 挂载方案所有条目 provider 已删 → buildSessionConfigFromDeps throw ModelNotConfiguredError（code=MODEL_NOT_CONFIGURED，message 含方案提示）；部分 dangling → 首可用候选正常 | MUST 覆盖决策④双分支 | 决策④ | +45 |
| tests | BUG-003 复现 UT | saveTab 首存 dirty 收敛 | 新增 | 模型↔方案切换 → 保存 → 断言 dirty 立即收敛（原红测转绿） | MUST 修复前先跑红 | 决策⑦ | +30 |
| spec-sync | `specs/api/overall/02-llm-chat.md` §5.2 | 版本注记 | 修改 | 加 v0.0.349 段：DELETE 语义补「返回后 UI 需 reload」无契约变化；错误码表无变化（引用提示为 UI 层警示非 API 契约） | MUST 无行为变更仅注记 | S1；api 惯例 | +4 |
| spec-sync | `specs/api/overall/21-model-routing.md` | 版本注记 | 修改 | 加 v0.0.349 段：runtime 全 dangling 降级 ModelNotConfiguredError（400 MODEL_NOT_CONFIGURED）语义补记；编辑拦保存 = §2.2 既有校验无变化 | MUST 补记不推翻 | 决策④；S4 | +5 |
| spec-sync | `specs/tech/agent/providers_and_models/[P0]model_routing.md` §4 | 分支 2 全 dangling 段 | 修改 | 补「全候选不可组装 → client 置空 + ModelNotConfiguredError；chat 时 routing_loop 跳过全 dangling 候选 → NO_AVAILABLE_MODEL」 | MUST 与代码对齐 | 决策④ | +6 |
| spec-sync | `specs/ui/components/providers/component-provider-detail.md` | 删除入口段 | 修改 | 补删除按钮 + ConfirmModal + onDeleted 回调（消费方 section-providers） | MUST 记录消费方（团队原则 10） | 决策① | +8 |
| spec-sync | `specs/ui/components/app-dev-config-page/component-model-routing-plan-editor.md` + `component-plan-item-row.md` | dangling 呈现段 | 修改 | 补 providers 透传 + itemModelInvalid 预检 + invalid 红描边（消费方 section） | MUST 记录消费方 | 决策⑤⑥ | +10 |
| spec-sync | `specs/tech/version_logs/v0.0.349/change_log.md` + `specs/api/version_logs/v0.0.349/change_log.md` | 变更记录 | 新增 | 按 change_log 惯例记录本版全部条目 | MUST 两处均落 | 惯例 | +2 文件 |

## 影响面评估

- **后端仅 1 处改动**（session-config 全 dangling 容错）；provider DELETE API、tombstone、PUT 校验、routing_loop、resolve 链全部零改动（实证语义已达成）。
- **前端集中 providers 详情页（删除入口）+ 方案编辑器（dangling 预检/视觉）**，均为既有文件小改；无新组件、无新依赖。
- BUG-003/004 批修纳入（同域设置页），各自独立可回退。
- **依赖顺序**：无跨层依赖（后端修复与前端入口完全独立，可并行）。
- **风险点**：
  1. session-config client=null 语义需核对全部消费方（S 调研已核 session-debug 次要 caller；coder 实施时再 grep `SessionConfig.client` 全消费方确认）——若发现未按 null-able 处理的消费方，修复并记 change_log。
  2. BUG-003 归属文件按复现路径定位（T6 后 use-app-settings-config 结构可能有微移），修复前先写复现 UT。
  3. validatePlanLocal 加参后既有 UT 调用（单参）必须全绿（缺省不做存在性检查兼容）。
  4. tombstone 数据留存（不真删）为既有妥协，本版不动；老板若问「删除是否彻底」答对外语义=已删。

## 反馈回路

- UT：上表 4 组测试全绿（`bun run test`）。
- AT：既有冒烟集回归（model-routing 用例不新增；本版无新 API 面——21 spec 仅注记）。改后端逻辑（session-config）默认走 AT：跑既有 mr_* 冒烟确认无回归。
- ET：版本验证标准——UI 改动看一眼 ET：① 删 provider → 列表消失 + 引用方案编辑时红描边+预检拦保存；② 删 provider 后挂载方案 chat →「当前无可用模型」错误提示（非 500）；③ BUG-003 复现步骤首存即显「已保存」。

## 与 350 边界（MUST NOT）

- 渠道 native、余额查询相关零改动（350 内容）。
- provider 真删（tombstone 清理）不在本版。
