# v0.0.340 tech change log — squad 默认关群聊 + 成员改名信封旧名修复

> 对应需求：`reqs/[working] v0.0.340.squad-default-groupchat-off.md` + `reqs/[working] v0.0.340.bug-rename-envelope-stale-name.md`。
> 权威契约：`specs/tech/version_logs/v0.0.340-squad-defaults-and-rename/change_plan.md`（3 决策，frozen）。
> bug 报告：`states/v0.0.340/bug-member-rename-envelope-old-name-2026-08-12.md`。

## 变更摘要

### 需求 1：新团队默认关群聊（纯技术默认值改动，跳 PRD）

- `squad-service.ts createSquadService` 建队 `enableGroupChat: true → false`（一行默认值，[v0.0.270] 注释同步更新）。
- **存量 squad 无字段读 `?? true` 兜底不变**（handlers/squad.ts toSummary/toDetail `?? true` 未动）——存量团队不受影响，保持现状（开）。
- 管理面板 toggle（v0.0.270 已有）可手动开启；群聊实体恒存在语义不变（开关只控可见性）。

### 需求 2：成员改名后信封旧名 bug（决策 1 + 决策 2 + 决策 3）

**根因**：信封 targetName = `resolveTargetDisplayName` 优先级② `session.title`（创建成员时快照旧名，改名后不同步）；in 信封 sender 名 / 系统提示 selfName 同源旧名。roster 读 memberStore（新名）vs 信封读 session.title（旧名）→ 不一致。

**决策 1（读单一源 = memberStore）**：成员名权威源 = memberStore（squad 内唯一、人类可读寻址符）。所有「读成员名」路径统一从 memberStore 反查（Session 已有 squadId/memberId → MemberStore.getMember），**不再把 session.title 当成员名读**：

| 读取路径 | 改后 |
|---|---|
| 信封 targetName（send-message-tool `resolveTargetDisplayName`） | ① AgentRef.name → ② memberStore 反查（target session 有 squadId+memberId 且 rtc.memberStore）→ ③ session.title（subagent/squad chat/standalone 等 non-squad-member fallback）→ ④ undefined |
| in 信封 sender name（inbox-enrich `deriveAgentRefName`，改 async） | subagent 分支优先（templateType 语义不变）→ squad 成员（squadId+memberId 且 lookup.memberStore）memberStore 反查实时名 → 否则 title fallback |
| 系统提示 selfName/parentName（bootstrap buildAgentToolContext 闭包） | session.memberId+squadId → memberStoreForCtx 反查实时名；否则 `session?.title ?? 'session'` |

注入面：`EnrichSessionLookup.memberStore?`（inbox-enrich）+ `AgentManagerOptions.memberStore?`（agent-manager，缺省 undefined → 原行为测试兼容）+ **bootstrap 装配**（`bootstrap-agent-phase.ts` new AgentManagerImpl 补 `memberStore: new MemberStore({ root: dataDir })`，对齐 setSquadReminderDeps 同款模式——inbox sender 名反查生产生效）。装配级回归：`bootstrap-memberstore-injection.test.ts`（白盒断言 bs.agentManager.memberStore 非 undefined + MemberStore 契约方法齐全）。

**决策 2（写时全同步 = 方案 A + CAS/titled 保护）**：`patchMemberService` 改名同步关联 session.title：
- `MemberMutationDeps` 加 `sessionStore: SessionStore`（必填；两调用方 handler/team-tool 均持有：SquadHandlerDeps.sessionStore / rtc.store）。
- 同步判据：`patch.name !== undefined && (改名发生 || 关联 session.title !== patch.name)`——既覆盖正常改名，也覆盖「上次部分失败后重试」（重试同名 patch 也能补同步）。
- 顺序：putMember（主操作）成功 → getSession → updateSession(title)（附属同步）；updateSession 失败 → 抛错透传（部分失败可见，重试可修复——「改彻底 + 诚实上报」老板原则）。
- 保护：`titled === true`（AI 起名/用户自定义标题）**不覆盖**；`updateSession` 只传 `{ title }` 不传 `titled`（保留 existing 值，CAS 语义不破坏）。
- 路径：`handlers/member.ts` PATCH /squad/:id/member/:mid + `team-write-actions.ts` teamEditAction（同一 service 单源）。

**决策 3（存量脏数据不迁移）**：dev 已有残留（姚順雨/Rocky、研究员小甲/研究院小甲）——**判定不迁移**。理由：① 决策 1 实施后所有「读成员名」路径全走 memberStore，残留 title 不再被当成员名读取（读时免疫）；② session.title 保留「会话标题」独立语义（titled 机制允许 AI 起名/用户自定义）；③ 启动 reconcile 侵入启动路径，复杂度与风险不成比例。

### 边界与铁律落实情况

- **不改 send_message 路由逻辑**（名字不参与寻址，只改显示名解析）✓
- 不引入前端 C 方案（后端返回实时名，前端 build-render-rows 自然正确）✓
- 存量 squad `?? true` 兜底不动（需求 1 只改新建默认值）✓
- titled=true 自定义名永不覆盖（CAS gate）✓

## 关键文件变更

### 需求 1（新团队默认关群聊）

| 文件 | 变更 |
|---|---|
| `app/server/src/services/squad-service.ts` | createSquadService `enableGroupChat: true → false`（+ 注释） |

### 需求 2（决策 1 读单一源 + 决策 2 写时全同步）

| 文件 | 变更 |
|---|---|
| `app/server/src/services/member-mutations.ts` | MemberMutationDeps 加 sessionStore；patchMemberService 改名同步 title（判据 + CAS/titled 保护 + 失败抛错） |
| `app/server/src/handlers/member.ts` | PATCH member 调用传 `sessionStore: deps.sessionStore` |
| `app/server/src/agent/tools/team-write-actions.ts` | teamEditAction 调用传 `sessionStore: rtc.store` |
| `app/server/src/agent/tools/send-message-tool.ts` | resolveTargetDisplayName 优先级② memberStore 反查实时名（non-squad-member fallback title；失败静默） |
| `app/server/src/agent/inbox-enrich.ts` | EnrichSessionLookup.memberStore?；deriveAgentRefName 改 async + squad 成员反查（subagent 分支优先） |
| `app/server/src/agent/agent-manager.ts` + `agent-manager-children.ts` | AgentManagerOptions.memberStore?；managerDeliverTo lookup 带 memberStore |
| `app/server/src/bootstrap-agent-phase.ts` | AgentManagerImpl 补 `new MemberStore({root:dataDir})`；buildAgentToolContext 闭包 deriveMemberName（selfName/parentName） |

### 测试

| 文件 | 变更 |
|---|---|
| `app/server/src/services/__tests__/member-mutations.test.ts` | titled=false 同步 / titled=true 不覆盖 / 同名重试补同步 / 同步失败抛错 |
| `app/server/src/services/__tests__/squad-service.test.ts` | 建队默认 enableGroupChat=false 断言同步翻转 |
| `app/server/src/handlers/__tests__/squad-handler.test.ts` | 2 个建队默认断言同步翻转 |
| `app/server/src/agent/tools/__tests__/send-message-tool.test.ts` | 信封名反查：member 存在→实时名 / member 已删→fallback title / subagent→title |
| `app/server/src/agent/__tests__/inbox-enrich.test.ts` | deriveAgentRefName async 适配 + member 反查 / 无 memberStore 行为不变 |
| `app/server/src/bootstrap-memberstore-injection.test.ts` | 装配级回归（memberStore 非 undefined + 契约方法齐全） |

## 验证结论

- typecheck：tsc -b 0 error；全量 UT 10411 passed | 4 skipped 零失败（worktree 跑）
- AT 全绿：`tests/api/squad/member_rename_envelope_tc2/` + `tests/api/squad/squad_default_groupchat_tc1/`
- ET 验证中（e2e-test-executor：新建团队默认关群聊 + 改名后 out/in 信封新名）

## doc 同步（doc-modifier2，合并前完成）

- `specs/tech/squad/[P1]data_model.md §1.1`：enableGroupChat 默认值语义（新建 false=关 / 存量 ?? true 不变）
- `specs/tech/squad/[P1]squad_tools.md §2`：team.edit 改名写时全同步（sessionStore 注入 + CAS 保护）
- `specs/tech/squad/[P1]prompt_sections.md` + `[P1]squad_reminder_providers.md`：门控描述补新团队默认关
- `specs/tech/squad/index.md`：enableGroupChat 概念行补默认关
- `specs/tech/multi_agent/[P1]a2a_protocol.md §2/§3`：name 派生表补 memberStore 反查 + 决策 1 注记 + 门控默认关
- `specs/tech/multi_agent/[P1]subagent_derivation.md §5`：send_message targetName 语义（实时 member 名）
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md §2.5.3`：name 反查规则表 + 伪代码同步
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md §2.3`：AgentManagerImpl memberStore 字段 + deliverTo enrich 带 memberStore
- `specs/api/overall/11a-squad-endpoints.md`：§1.3 enableGroupChat 回显默认关 + §2.2 PATCH member 改名同步 title
- `specs/ui/overall/06-studio.md` + `00-app-guide.md`：群聊开关默认关描述
- `specs/ui/components/studio-page/component-group-chat-toggle.md`：默认关描述
- `specs/ui/components/chat-page/component-a2a-envelope.md`：out targetName 语义（实时 member 名）
- `specs/tech/app/start_up/log.md`：bootstrap-agent-phase 装配 memberStore 记录
- KB log：squad/log.md + multi_agent/log.md + agent_interface_and_loop/log.md
