# v0.0.217 变更计划书 — 工具白名单交集逻辑统一 resolveToolSet 单源（纯重构）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。
> coder 对实现细节有最终决策权；偏离本表须向 orchestrator 汇报。事后偏差写进 `change_log.md`。

## 架构决策（核心约束）

主链 `SessionTypePolicy.resolveToolSet(kind, instanceOverride)` 与旁路 `filterAllowedTools(allToolNames, toolWhitelist)` 是两份同构的「bound ∩ 动态集」实现（v0.0.204 历史分叉）。本版本把旁路（summary/consolidate）allowedTools 派生统一走 `resolveToolSet(effectiveKind, { tools: snapshot.tools 名表 })`，删除 `tool-policy.ts`。

**不变量（MUST 保持，reviewer 按此查）**：
1. **旁路 toolDefinitions = snapshot.tools 全集原样**（cache 契约，不裁剪）——resolveToolSet 产的 `tools`/`toolDefinitions`（registry 序全集子集）**绝不给旁路用**，只取 `allowedTools`。
2. summary `allowedTools=[]` 全拦、consolidate `=[skill_manage,memory_manage] ∩ snapshot` 行为不变（由 profile yaml toolBound 驱动，交集语义同构）。
3. engine.execute Layer C 门控契约不变（allowedTools 转 Set 查询）。

**顺序差异说明（已论证可安全统一）**：`resolveToolSet` 保**注册序**（遍历 allTools），`filterAllowedTools` 保 **snapshot 序**。allowedTools 全部消费点 = engine.execute 转 Set 查询 + side-run reminder 文案 `join(', ')`——均顺序无关（consolidate reminder 里两工具名顺序可能翻转，纯文案无契约）。

**语义差异说明（更严格，安全）**：resolveToolSet 结果额外 ∩ registry 全集（snapshot 名如不在 registry 会被剔除）；snapshot.tools 本就源自 registry，生产等价。

**符号核对（architect 已 grep 全仓）**：`filterAllowedTools` 引用点仅 3 处——`build-run-deps.ts:28,100`（import+调用，本版本改）、`side-run-reminder-injector.ts:12,22`（纯注释）、`tool-policy.ts` 自身（删）。**无独立 UT 文件**（无 `tool-policy.test.ts`；交集/剔幽灵名/保序断言已由 `session-type-profile-loader.test.ts:367-450` 的 resolveToolSet UT 承担）。全部测试 policy mock 均已带 `resolveToolSet` 字段（interface 必填，typecheck 强制），预期零 mock 补齐。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（行粒度 = 符号）|
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-loop | app/server/src/agent/build-run-deps.ts | buildRunDeps() | 修改 | 旁路 else 分支（现 L96-105）：`({ allowedTools } = opts.sessionTypePolicy.resolveToolSet(kind, { tools: toolDefinitions.map((d) => d.name) }))` 替换 `filterAllowedTools(...)` 调用；删 L28 `import { filterAllowedTools } from './tool-policy'`；同步 L86/L97 分支注释（「toolBound 过滤」→「resolveToolSet 单源」） | MUST 只取 `allowedTools` 一件；MUST NOT 用 resolveToolSet 返回的 `tools`/`toolDefinitions`（registry 序全集破 cache 契约）；MUST `toolDefinitions = providedSnapshot.tools` 赋值原样保留；MUST 用 `kind`（= caller 传入的 effectiveKind，agent-side-run.ts:97-111 已派生，本文件不重新派生）；`profile.toolBound` 不再直读于此分支（resolveToolSet 内部读 profile） | specs/tech/agent/tools/[P0]tool_policy.md §3/§4.2；context.md findings（toolDefinitions 禁用 resolveToolSet 产出） | +3/-6 |
| agent-loop | app/server/src/agent/tool-policy.ts | FilterAllowedToolsResult | 删除 | interface 删除（随整文件删除） | MUST 先确认全仓无残留 import（architect 已核对：仅 build-run-deps.ts 一处，本版本同步删）| req.md 需求2 | -5 |
| agent-loop | app/server/src/agent/tool-policy.ts | filterAllowedTools() | 删除 | 函数删除；**文件整体删除**（文件内仅此两符号 + 头注释） | MUST `git rm` 整文件，不留空壳；MUST NOT 保留 re-export 兼容层（原则：不遗留死代码） | req.md 需求2；architect 原则2 | -31 |
| agent-loop | app/server/src/agent/side-run-reminder-injector.ts | 头注释不变量3 + SideRunReminderInput.allowedTools doc | 修改 | L12-13 头注释「filterAllowedTools 实际结果」+ L22 字段 doc「buildRunDeps 的 allowedTools = snapshot.tools ∩ profile.toolBound」改述为「resolveToolSet(effectiveKind, {tools: snapshot.tools 名表}) 产出（= snapshot ∩ toolBound，注册序）」 | MUST NOT 改任何运行时代码（纯注释同步）；不变量3语义（reminder 广告工具 = 实际可执行）不变 | specs/tech/agent/agent_interface_and_loop/[P0]forked_reminder.md §6 | +3/-3 |
| agent-tests | app/server/src/agent/__tests__/build-deps-three-layer.test.ts | describe「旁路 allowedTools = resolveToolSet 单源」 | 新增 | 新增 UT（复用现有 summaryProfile/summaryPolicy fixture，L246-284 已带 resolveToolSet mock）：① 断言旁路装配时 `resolveToolSet` 被调且入参 = `(summaryKind, { tools: snapshot.tools 名表 })`；② `spec.allowedTools` === mock 返回的 allowedTools（如 mock 返 `['skill_manage','memory_manage']` 模拟 consolidate）；③ `spec.toolDefinitions` 仍 === snapshot.tools 原样（cache 契约，不被 mock 返回值污染）；④ summary mock 返 `[]` → `spec.allowedTools=[]` 全拦 | MUST 覆盖 req 等价断言（summary=[] / consolidate 两工具 / toolDefinitions 不裁剪）；交集、剔幽灵名、保注册序语义 MUST NOT 在此重复测（session-type-profile-loader.test.ts:367-450 已有 resolveToolSet 专项 UT，单源后天然共享覆盖） | req.md 验收；session-type-profile-loader.test.ts §4 | +45 |
| specs | specs/tech/agent/tools/[P0]tool_policy.md | §4.2 调用点表 reminder 行 | 修改 | row4「allowedTools = buildRunDeps 的 filterAllowedTools 实际结果 = snapshot.tools ∩ profile.toolBound」改为「allowedTools = buildRunDeps 经 resolveToolSet(effectiveKind, {tools: snapshot.tools 名表}) 产出」；§3 加一句旁路调用形态说明（override.tools = snapshot 名表）。注：§4.2 row3 已写「allowedTools=resolveToolSet 产出」（spec 先行），本版本代码落地对齐 | MUST NOT 改 log.md 历史条目（v0.0.204 条目里的 filterAllowedTools 是史实）；本行可由 coder 顺手改或留 doc-modifier 阶段5，二选一但必须落地 | req.md 需求4；[P0]tool_policy.md §4.2 | +3/-2 |

## 影响面评估

**跨模块**：仅 agent-loop 子系统（build-run-deps + tool-policy 删除）+ 注释/spec/UT 同步。纯内部重构，零用户可感知变化 → 免 PRD、不新增 AT/ET case（铁律），回归 = `bun run typecheck` + `bun run test`。

**破坏性变更**：无。
- `SessionTypePolicy` interface 零改动（resolveToolSet 签名不变，旁路只是新增一个调用点）。
- 全部测试 mock policy 已实现 `resolveToolSet`（interface 必填），预期存量 UT 零修改即绿：`side-run-loop.test.ts:187` mock 返 `allowedTools=toolBound`，L289 断言 `['search']` 在新链路下仍成立；`agent-side-run.test.ts:52` mock 返 `[]`，该文件无 allowedTools 断言。若有存量 UT 因「实际交集 → mock 返回值」的取值来源变化而红，修 mock 返回值而非产品代码。
- 生产 yaml 路径（真 profile）行为等价：summary toolBound=[] → 空交集；consolidate=[skill_manage,memory_manage] ∩ snapshot → 同旧结果（仅顺序变注册序，顺序无关已论证）。

**依赖顺序**：build-run-deps.ts 改调用 → 删 tool-policy.ts（同一 commit 内完成，避免中间态 typecheck 红）→ 注释/UT/spec 同步。单 task 可完成。

**风险点**：
1. reminder 文案 consolidate 两工具名顺序可能从 snapshot 序变注册序——纯文案，无断言依赖（side-run-reminder-handler UT 只测模板变量替换）。
2. resolveToolSet 内部 `this.profile(kind)` 重复读 profile（buildRunDeps 已有局部 `profile` 变量）——loader 有缓存，零成本；MUST NOT 为省一次读而给 resolveToolSet 加 profile 入参（扩 interface 面）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现更优实现可合理偏离本表具体行，但 MUST 向 orchestrator 汇报偏离项 + 理由 + 影响范围
