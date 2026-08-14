# v0.0.340 变更计划书 — squad 默认关群聊 + 成员改名信封旧名修复

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 需求与流程判定

- **需求 1（新团队默认关群聊）**：纯技术默认值改动（无用户可感知变化）→ 跳 PRD，直接架构（对齐团队 AGENTS.md「纯技术改动跳 PRD」）。
- **需求 2（成员改名后信封旧名 bug）**：信封显示名是既有 UI 行为的**修复**（非新 UI 交互/新元素），信封 UI 结构不变，仅数据源改正确；无 UI spec 变化 → **无需 PRD，直出架构**。依据：PRD 参与边界 = 用户可感知的**新功能/新交互**；本需求是修复既有行为正确性 + 后端读取链路重构（读单一源）。

## 根因（bug-analyst 报告 + 代码核实）

1. 信封 targetName = `send-message-tool.ts:133 resolveTargetDisplayName`（:318-336）优先级② `session.title`——创建成员时快照（member-service.ts:224 / squad-service.ts:156 `title: eff.name / input.leader.name`），改名后不同步。
2. 改名链路 `patchMemberService`（member-mutations.ts:137-190）只 `putMember`（更新 memberStore.name），不同步 session.title。
3. in 信封 sender 名 = `inbox-enrich.ts:65-76 deriveAgentRefName` → 顶层取 `session.title`（同源快照）；系统提示 selfName/parentName = `bootstrap-agent-phase.ts:328-329 session.title ?? 'session'`（同源快照）。
4. session.title 有独立语义：titled=true = AI 起名/用户自定义（session-store-types.ts:99-107 CAS gate），**不得被成员名同步覆盖**。

## 架构决策

### 决策 1：单一权威源（读时单一源 = 方案 B）

**成员名权威源 = memberStore**（squad 内唯一、人类可读寻址符，MemberSchema.name）。所有「读成员名」路径统一从 memberStore 反查，**不再把 session.title 当成员名读**：

| 读取路径 | 现状 | 改后 |
|---|---|---|
| 信封 targetName（send-message-tool） | ② session.title | ① AgentRef.name → ② memberStore 反查（target session 有 squadId+memberId 时）→ ③ session.title（subagent/squad chat/standalone 等 non-squad-member fallback）→ ④ undefined |
| in 信封 sender name（inbox-enrich deriveAgentRefName） | session.title | sender session 有 squadId+memberId → memberStore 反查；否则 title（subagent templateType 分支不变） |
| 系统提示 selfName/parentName（bootstrap） | session.title | session.memberId+squadId → memberStore 反查；否则 title |

- 反查通道：Session 已有 `squadId`/`memberId` 字段（session-store-types.ts:180/186）；MemberStore.getMember(squadId, memberId)（squad-store.ts:105）。
- **不改 send_message 路由逻辑**（名字不参与寻址，只改显示名解析）✓ 边界。
- 不引入前端 C 方案（tool_result.targetName 后端返回实时名，前端 build-render-rows.ts:129-130 自然正确）✓ 边界。

### 决策 2：写时全同步（方案 A + CAS/titled 保护）

`patchMemberService` 改名时同步关联 session.title（仅 `titled !== true` 的默认标题；titled=true 自定义标题**不覆盖**）：

- `MemberMutationDeps` 注入 `sessionStore`（两调用方 handler/team-tool 均已持有：SquadHandlerDeps.sessionStore / rtc.store）。
- 同步判据：`patch.name !== undefined && (改名发生 || 关联 session.title !== patch.name)`——既覆盖正常改名，也覆盖「上次部分失败后重试」场景（重试同名 patch 也能补同步）。
- 顺序：putMember（主操作）成功 → updateSession(title)（附属同步）；updateSession 失败 → 抛错上报（部分失败可见，重试可修复——「改彻底 + 诚实上报」老板原则）。
- updateSession 只传 `{ title }` 不传 `titled`（保留 existing 值 → titled=false 维持 false，CAS 语义不破坏）。

### 决策 3：存量脏数据处置（不迁移）

dev 已有残留（姚順雨/Rocky、研究员小甲/研究院小甲：memberStore.name 已新、session.title 旧）。**判定：不迁移**。理由：

1. 方案 B 实施后，所有「读成员名」路径（信封/sender/selfName）全走 memberStore → 残留 title 不再被当成员名读取，信封 bug 自然修复（读时免疫）。
2. session.title 保留「会话标题」独立语义（titled 机制允许 AI 起名/用户自定义）——残留旧 title 只作为会话标题展示，不属于「成员名旧名残留」bug 范畴。
3. 启动 reconcile 侵入启动路径（bootstrap/http-server 装配），复杂度与风险不成比例；未来如需清理可手工/脚本，非本版本范围。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad | app/server/src/services/squad-service.ts | putSquad | 修改 | 建队 `enableGroupChat: true → false`（一行默认值；[v0.0.270] 注释同步更新） | MUST NOT 改 `handlers/squad.ts:202/298` 存量兜底 `?? true`；MUST NOT 动管理面板 toggle（handlers/squad.ts:497 PATCH 已有） | reqs/[working] v0.0.340.squad-default-groupchat-off.md；runtime-context.ts:307 门控已就绪 | 1 |
| member-mutations | app/server/src/services/member-mutations.ts | MemberMutationDeps | 修改 | 加 `sessionStore: SessionStore`（必填） | MUST NOT 引入 squadStore（不读 squad）；两调用方均持有 sessionStore | member-mutations.ts:24-25；handlers/squad.ts:65 SquadHandlerDeps.sessionStore | +1 |
| member-mutations | app/server/src/services/member-mutations.ts | patchMemberService | 修改 | 改名同步 title：patch.name 提供且（改名 || 关联 session.title !== patch.name）时 → getSession(existing.sessionId) → 若 session 存在且 `session.titled !== true` → updateSession(sessionId, { title: patch.name })；putMember 成功后再同步；同步失败抛错 | MUST：titled===true 不覆盖；MUST：updateSession 只传 title 不传 titled；MUST：先 putMember 后同步；MUST NOT 改 bench/deploy 路径 | 决策 2；session-store-types.ts:99-107 CAS；session-store.ts:137 updateSession | +12 |
| member-mutations | app/server/src/handlers/member.ts | PATCH /squad/:id/member/:mid | 修改 | patchMemberService 调用传 `sessionStore`（makeStores 处或调用处补 deps.sessionStore） | MUST：handler deps 已有 sessionStore，直接透传 | handlers/member.ts:151；SquadHandlerDeps.sessionStore | +1 |
| member-tools | app/server/src/agent/tools/team-write-actions.ts | teamEditAction（patchMemberService 调用） | 修改 | 调用传 `sessionStore: rtc.store` | MUST：rtc.store 是 SessionStore（runtime-context.ts:154） | team-write-actions.ts:217 | +1 |
| send-message | app/server/src/agent/tools/send-message-tool.ts | resolveTargetDisplayName | 修改 | 优先级② 反查 memberStore：getSession(targetSid) → 若 session.squadId+memberId 且 rtc.memberStore → getMember(squadId, memberId)?.name 非空则返回；member 不存在/无 memberId → ③ session.title fallback | MUST：non-squad-member（subagent/squad chat/standalone）保持 title fallback；MUST：member 反查失败（member 已删）静默 fallback 不抛错；MUST NOT 改 target 解析/路由 | 决策 1；send-message-tool.ts:318-336；rtc.memberStore?（runtime-context.ts:55） | +6 |
| inbox-enrich | app/server/src/agent/inbox-enrich.ts | EnrichSessionLookup | 修改 | 加可选 `memberStore?: MemberStore`（注入则 sender 名可反查） | MUST：缺省 undefined → 行为不变（测试/纯 helper 场景） | inbox-enrich.ts:22-29 | +1 |
| inbox-enrich | app/server/src/agent/inbox-enrich.ts | deriveAgentRefName | 修改 | 改 async：senderSession 有 squadId+memberId 且 lookup.memberStore → getMember 反查实时名（非空覆盖 title）；否则原逻辑（subagent templateType / title / 'parent'） | MUST：subagent 分支优先于反查（templateType 语义不变）；MUST：反查失败 fallback title | 决策 1；inbox-enrich.ts:65-76；调用处 :125 改 await | +5 |
| inbox-enrich | app/server/src/agent/inbox-enrich.ts | enrichForInbox | 修改 | 签名加可选 `memberStore`（或经 lookup 携带）；deriveAgentRefName 调用 await | MUST：EnrichSessionLookup 最小接口扩展，不引入完整 SessionStore 依赖 | inbox-enrich.ts:94-96；agent-manager-children.ts:127-131 | +2 |
| agent-manager | app/server/src/agent/agent-manager.ts | AgentManagerOptions | 修改 | 加可选 `memberStore?: MemberStore`（enrich sender 名反查注入面） | MUST：缺省 undefined → 行为不变（测试兼容） | agent-manager.ts:53-110 | +1 |
| agent-manager | app/server/src/agent/agent-manager-children.ts | managerDeliverTo | 修改 | lookup 构造时带 memberStore（从 ops/this 透传） | MUST：lookup.getSession 不变（ops.getFullSession）；memberStore 缺省 → 不反查 | agent-manager-children.ts:246-262 | +2 |
| bootstrap | app/server/src/bootstrap-agent-phase.ts | buildAgentToolContext 闭包 | 修改 | selfName/parentName：session.memberId+squadId 且 memberStoreForCtx → getMember 反查实时名非空覆盖；否则 `session?.title ?? 'session'` | MUST：闭包内已有 memberStoreForCtx（:275）直接复用，不新增依赖；MUST：反查失败 fallback title；MUST NOT 改 parentType/selfType | 决策 1；bootstrap-agent-phase.ts:328-329/274-275 | +4 |
| 测试 | app/server/src/services/__tests__/member-mutations.test.ts | 改名同步用例 | 新增 | titled=false 同步 title / titled=true 不覆盖 / 同名重试补同步 / 同步失败抛错 | MUST：mock sessionStore 断言 updateSession 调用参数 | 决策 2 | +40 |
| 测试 | app/server/src/services/__tests__/squad-service.test.ts | 建队默认值用例 | 修改 | 断言新队 enableGroupChat=false；存量读取兜底不受影响 | MUST：只加断言不改既有断言 | 需求 1 | +3 |
| 测试 | app/server/src/agent/tools/__tests__/send-message-tool.test.ts | 信封名反查用例 | 新增 | member 存在 → 实时名；member 已删 → fallback title；subagent → title | MUST：mock rtc.memberStore | 决策 1 | +30 |
| 测试 | app/server/src/agent/__tests__/inbox-enrich.test.ts | deriveAgentRefName 反查用例 | 修改 | async 适配 + member 反查 / 无 memberStore 行为不变 | MUST：既有用例改 await 适配 | 决策 1 | +15 |

## 影响面评估

- **模块**：squad-service（需求 1 一行）→ member-mutations/handlers/team-tools（A 写时同步）→ send-message-tool/inbox-enrich/agent-manager/bootstrap（B 读单一源）。
- **破坏性变更**：无 API schema 变化（信封 targetName 是 send_message tool_result 内容语义变化：快照名 → 实时名，非 schema 字段）；无协议变化。
- **依赖顺序**：A 与 B 相互独立（写路径 vs 读路径，文件域不重叠）→ 可拆并行 task。
- **风险点**：deriveAgentRefName 改 async 波及 enrichForInbox + 既有测试（适配成本可控）；B 的注入面（AgentManagerOptions/ManagerChildrenOps）需谨慎缺省兼容（undefined → 原行为）。
- **API 契约**：无端点/字段变化；doc 同步时在 send_message tool 文档注明 targetName 语义（实时 member 名，non-squad-member fallback title）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
