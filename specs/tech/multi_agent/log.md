---
type: log
title: Multi-Agent KB 变更记录
updated: 2026-08-07
---

# Multi-Agent KB 变更记录（ISO 倒序，最新在前）

## 2026-08-07 · v0.0.273（squad_agents_status 统一全员状态块取代 reachable_agents + squad_team_status）

- **`[P1]a2a_protocol.md`**：§3 `reachable_agents` → `squad_agents_status`（统一全员状态块）——可达性派生表不变（squad/leader/mate/subagent/standalone 5 行）+ 新增「全员列出」语义（running + idle 都保留，做完的 mate 不消失）+ 板块格式改 `[squad:agents]`（成员行 = 可达性 + running/idle + presence 三合一）；v0.0.270 enableGroupChat 门控描述从「squadChatRef 构造」改「SquadChat 行渲染」；§7 section 表 + §8 边界表引用同步。**可达性语义不变**（name + sessionId 仍在统一块，a2a 对端信息不丢）。
- **`index.md`**：核心概念表 + 导航表 reachable_agents → squad_agents_status（曾名标注）。
- **`[P1]subagent_derivation.md §5`**：send_message 校验 `caller.reachable_agents` → `caller.squad_agents_status`；拓扑编码引用表名同步。
- **代码↔spec 核实（doc-modifier 阶段 5）**：① `squad_agents_status.ts` L67-79 readSessionType 5 种分派（standalone [] / subagent [parent] / squad 全员 / leader SquadChat+mates / mate SquadChat+leader+peers）✅；② L111-116 逐 member 查 running 但**不过滤**（全员列出，idle 保留）✅；③ L93-94 270 门控 `enableGroupChat !== false` + L151 benched 过滤 `state !== 'benched'` ✅；④ L211-218 成员行格式 `- {name} ({role}, sessionId: {sid}) · {running|idle} · presence: {text|(无 presence)}` ✅；⑤ 旧文件 reachable_agents.ts / squad_team_status.ts / 旧测试已删 + plugin.json 删二加一 + 生产代码零残留 ✅。
- 详情：`specs/tech/version_logs/v0.0.273/change_plan.md`（8 裁决 R1-R8）+ `change_log.md`

## 2026-08-06 · v0.0.270（enableGroupChat 门控 — reachable_agents 单点 + resolveSquadAlias 返 null）

- **`[P1]a2a_protocol.md §3`**：reachable_agents 派生表补 `enableGroupChat` 门控注记——`squadChatRef` 构造条件 `squadChatSid && squad.enableGroupChat !== false`（`!== false` 语义：undefined/缺省=开，仅显式 false 关）；同 provider 供 system prompt + system_reminder 两头（一处管、两头同时无）；关态下 `send_message('squadchat')` 报「cannot resolve target」类错误（resolveSquadAlias 返 null，全私聊语义）。
- **`index.md`**：核心概念表加「enableGroupChat 群聊门控（注入 + 别名解析双关）」行（见下）。
- **代码↔spec 核实（doc-modifier 阶段 5）**：① `reachable_agents.ts:93-106` duck-type + `squadChatRef = squadChatSid && squad.enableGroupChat !== false ? {...} : null` ✅；② `runtime-context.ts:275-286` resolveSquadAlias 'squadchat' 分支 `=== false` 返 null ✅；③ resolveAgentRefWithSquad fallback 拦截（coder3 偏离 ①：squad 分支 resolveSquadAlias 返 null 且 ref==='squadchat' 时直接返 null，不 fallback 直传 'squadchat' 字串——否则 send_message 报「session not found」而非契约「cannot resolve target」；'leader'/member name 保持原 fallback）✅；④ a2a_protocol 板块格式补「`← [v0.0.270] enableGroupChat=false 时不渲染此行`」✅。
- 详情：`specs/tech/version_logs/v0.0.270/change_plan.md` + `change_log.md`

## 2026-08-04 · v0.0.255（async subagent 回报兜底 — 系统代发 + 判据 A 履约追踪）

- **`[P1]subagent_derivation.md §4`**：「结果送达语义」async 条从「best-effort 无内置通知」改述为「系统代发兜底（回报可靠性 = 代码保证）」——child run 结束（`onRunEnd` stopReason≠tool_pending / `onInterrupted`）扫本 run drain 的 needReply=true 请求，判据 A 未履约则以 child 身份代发（成功=final text / 失败=结局通知，needReply=false，inReplyTo 指回最新 M.id）；tool_pending stash 跨 run 携带；仅 main && derivation='subagent' 装配；ensureSendMessage 主路径保留。§4 伪码注释 + §9 边界表行同步。
- **`[P1]a2a_protocol.md §4.2`**：needReply 表 async 行补「LLM 未回时系统代发兜底」；新增「系统代发兜底」段——判据 A（`A2aReplyTracker` 出站投递追踪：deliverTo 成功记 from→to seq + run 装配 baseline epoch 快照 + `hasDeliverySince` 判定；成立根基 = §6 subagent 仅可达 parent 硬约束；不依赖 LLM 自觉、不翻 transcript、不对账 inReplyTo）+ tool_pending stash/take + 装配边界 + best-effort。
- **`index.md`**：核心概念表加「async 回报兜底（系统代发）」行；原则 #8 新增「async 回报可靠性 = 代码保证（判据 A）」。
- **代码↔spec 偏离核实（doc-modifier 阶段 5）**：`agent-manager.ts:387-393 deliverTo` 成功后 `markDelivery(sender.agent.ref.sessionId, sessionId)`（失败不 mark、user/system 不记）；`build-run-deps.ts:158-166` 仅 isMain && kind.isSubagent 装配 replySettle（baseline/carried 装配点快照/取出）；`run-lifecycle-port.ts` onRunEnd（persistRun/CAS 后 tool_pending→stash / 其余→settle）+ onInterrupted（代发旁路，transcript 收尾仍归 abort api）；`agent-loop-stage-pre.ts:162-167` drain 收集用 reissue 后 id；`loop-stage-context.ts:61-62` 跨轮累积。coder 2 处偏离 change_plan（buildFallbackMessage 补 targetSid 参 / `ReplySettleReason` 类型编译期钉死 tool_pending 排除）合理，已记 version_logs change_log §2。
- 详情：`specs/tech/version_logs/v0.0.255/change_plan.md` + `change_log.md`

## 2026-08-03 · v0.0.246（D8 inherit 改用 parent resolved — spawn 取 resolveConfigBySid 具体模型，修 ModelNotConfiguredError）

- **`[P1]subagent_derivation.md §4`**：D8 resolution 块澄清 `parent.modelId` = parent **运行时 resolved 具体 modelId**（runSpawn 经 `agentManager.resolveConfigBySid(parentSid)` 取 parentConfig.modelId，**非** `session.modelId` raw hint）；附原因（raw hint 常 `'default'`/空 + subagent 被 `isStudioMainSession` 切断 squad/classroom default 链 → fallback 跑空抛 `ModelNotConfiguredError`）。`childConfig.modelId` 注释同步补「parent resolved 来源」。
- **`[P1]subagent_templates.md §4`**：D8 resolution 伪码注释 + 新增 bullet 同步澄清 `parent.modelId` 来源（spawn 不可覆盖语义不变，仅来源从 raw hint 变 resolved）；附 `providerId` 同源 parentConfig（`client.getInfo().providerId`，SessionConfig 顶层不导出）说明。
- **代码↔spec 偏离核实（doc-modifier 阶段 5）**：`agent-tool.ts:214 runSpawn` 调 `resolveConfigBySid(parentSid)` 取 parentConfig（resolved），`parentModelId=parentConfig.modelId`（:215）/ `parentProviderId=parentConfig.client.getInfo().providerId`（:216，**偏离 change_plan**——SessionConfig 顶层无 providerId 字段，详见 version_logs/v0.0.246/change_log.md）；`spawn-action.ts:116 childConfig.providerId=ctx.parentProviderId`（resolved 透传）；`agent-tool.ts:329 createChildSessionImpl` 落库 `providerId: input.childConfig.providerId`（替代旧 `parent?.providerId` raw hint）；`agent-tool.ts:317` 仍 `store.getSession` 读 parent 取 biz/role/squadId/workspaceDir（非 model 维度，保留）；`template-loader.ts:92` `template?.modelId ?? parentModelId` 不改（parentModelId 现已是 resolved，D8 语义自然成立）。无新偏离（除 providerId 访问路径，见 change_log）。
- 详情：`specs/tech/version_logs/v0.0.246/change_plan.md` + `change_log.md`

## 2026-07-30 · v0.0.222（subagent tools 三态 — undefined 继承 profile toolBound，修 `?? []` 降级 bug）

- **`[P1]subagent_derivation.md §4`**：`SpawnAgentInput.tools` 字段注释补三态语义；resolution 注释块补「eff.tools=undefined → 落库 subAgentConfig.tools=undefined → resolveToolSet 走 `new Set(bound)` 全集分支」+ 历史 bug 说明；`childConfig.tools` 落库注释改述三态透传（不降级）。
- **`[P1]subagent_templates.md §4`**：resolution 规则后补「eff.tools 三态」bullet——undefined=继承 bound 全集（默认）/ []=显式空 / 非空=∩ bound；附历史 bug 说明（`?? []` 降级致零工具）。
- **`../agent/tools/[P1]agent_tools.md §2.2`**：subagent 实例 override 行从「最终 = instanceOverride.tools ∩ bound」（漏 undefined 分支）改述为完整三态 `instanceOverride.tools !== undefined ? (∩ bound) : new Set(bound)`；优先级描述补「前两者均不传时落到 profile bound 全集，而非空集」。
- **代码↔spec 偏离核实（doc-modifier 阶段 5）**：`agent-tool.ts:332` 透传 `input.childConfig.tools`（无 `?? []`，注释 328-329 记三态）；`session-type-policy.ts:92-94` `instanceOverride?.tools !== undefined ? filter(∩bound) : new Set(bound)` 三态一致；`session-config.ts:289` `policy.resolveToolSet(kind, { tools: subAgentConfig?.tools })` 可选链一致；`session-config.ts:167` `buildSessionConfigFromDeps` 形参 `subAgentConfig.tools` 已改可选（coder deviation，change_plan 原列漏，已补）；`session-store-types.ts:153` `tools?: string[]` 可选；`template-loader.ts:100` `input.tools ?? template?.tools` undefined 语义本就正确；`spawn-action.ts:113` 透传 `eff.tools`。无新偏离。
- 详情：`specs/tech/version_logs/v0.0.222/change_plan.md`

## 2026-07-28 · v0.0.208 academy 板块整体删除（影响：knowledge_learning_trainer builtin 模板 + academyBinding 字段删除）

- **`[P1]subagent_templates.md §5`**：删 `knowledge_learning_trainer` builtin 模板（§5.2 整段删）+ 预配清单只留 `explorer`；保留通用 spawn 泛化机制（SubAgentTemplate.role/derivation 字段、SpawnAgentInput.workspaceDir）。
- **`[P1]subagent_derivation.md §4`**：`SpawnAgentInput` 删 `academyBinding?: { taskId, studentId, classroomId }` 字段（academy 专属，已随板块删除）；保留 `workspaceDir?: string` 通用字段。
- **`index.md` 原则 6**：spawn 泛化机制保留为通用能力描述（不再以 trainer 为唯一用例）。

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-24 · v0.0.204（spawn 泛化 — SubAgentTemplate 加 role/derivation + trainer 独立 parent + scope 字段语义重述）

- **`[P1]subagent_templates.md §2 数据结构`**：`SubAgentTemplate` 加两可选字段 `role?: Role` + `derivation?: Derivation`（v0.0.204 spawn 泛化）；缺省 = `parent.role`（bloodline）+ `'subagent'`；显式指定 = 拉起非 subagent 形态的 child（trainer 是首用例：`role:'trainer', derivation:'parent'` 独立身份）。
- **`[P1]subagent_templates.md §4 resolution`**：spawn 时 eff.role/eff.derivation 走模板显式指定（如 trainer）；§5.2 新增 `knowledge_learning_trainer` builtin 模板（academy 用，spawn 拉起 trainer = `academy-trainer:parent:main` 独立身份，profile.userReachable:false + ephemeral:true 承载「不可触达/临时/回收」语义）。
- **`[P1]subagent_derivation.md §4 spawn 泛化`**：`spawn-action.ts resolveEffective` 加 role+derivation 解析；`createChildSessionImpl` derivation/role/biz 从 eff 读（trainer 不挂 parentSessionId；academy 绑定 taskId/studentId/classroomId 由 SpawnAgentInput.academy 在 create 时落 record 顶层，替代 v0.0.203 patchChildAcademyBinding post-spawn patch）。
- **`index.md`**：核心概念表「scope」项重述（v0.0.56 scope 字段已删；v0.0.204 起 profile.toolBound 承载工具可见集，subagent.bound 不含 agent → 不可再派生）；原则 5「scope=EP」更新（profile.toolBound 替代 TOOL_POLICY）；导航 subagent_templates 描述更新（含 role+derivation 字段）。
- **forked 命名退役**：spec 描述「forked = 复用上下文的衍生 run」改为「runKind=summary/consolidate（同 session 的旁路 run，snapshot 可选输入）」；详见 `../agent/agent_interface_and_loop/`。
- 详情：`specs/tech/version_logs/v0.0.204/change_plan.md`

## 2026-07-24 · v0.0.203.learning_agent_fix（SpawnAgentInput 加 workspaceDir + academyBinding 两可选字段）

- **`[P1]subagent_derivation.md §4`**：`SpawnAgentInput` 加两可选字段（caller-provided，不传时既有行为不变）：
  - `workspaceDir?: string` — 透传到 `createChildSessionImpl`，child session.workspaceDir = input.workspaceDir ?? parent.workspaceDir。典型场景：academy trainer workspace = draft 版本目录（caller 先 copyVersionDir(base→draft)，trainer 在目录内改 prompt.md、写 SKILL.md）。
  - `academyBinding?: { taskId, studentId, classroomId }` — 原子写入 child session.subAgentConfig.academy（在 createChildSessionImpl 写 record 时一次性落库，与 workspaceDir 同路径）。替代旧「spawn 后 patchChildAcademyBinding」路径——agentToolContext 在 activate 时一次性快照不刷新，patch 在 spawn 返回后才跑 → trainer rtc 读到 undefined 链路断（v0.0.203 BUG-002 修复）。patchChildAcademyBinding 函数已删。
- `executeSpawn` + `createChildSession` 透传链对齐：两字段仅在 input 提供时透传（undefined 不影响默认继承）。
- 详情：`specs/tech/version_logs/v0.0.203/change_log.md`

## 2026-07-08 · v0.0.89（sub_agent_templates 存储迁入 app_config — dev_config 废弃）

- **`[P1]subagent_templates.md §3`**：模板存储从 `dev_config.sub_agent_templates` 迁入 `app_config.sub_agent_templates`（dev_config entity 废弃，所有 group 迁入 app_config，详见 `../config/[P0]app_config.md §3.11`）。group/key 名零变更，仅 entity 名改（dev_config → app_config）；record id/key/data 透传保完整。
- **CRUD 路径迁移**：原 `/config/dev/sub_agent_templates` DELETE/PUT 经专用 handler 改路径 `/config/app/sub_agent_templates`（在 `/config/app` 之前注册防前缀覆盖）；GET 仍走通用 `/config/app?group=sub_agent_templates`。**handler 文件改名** `handlers/dev-config-template-handlers.ts` → `app-config-template-handlers.ts`（svc 类型 DevConfigService → AppConfigService）；builtin explorer 保护逻辑保留（builtin:true 拒 403 + group!==sub_agent_templates 拒 403 group_not_deletable）。
- **template-store.ts 函数名保留偏离**：`loadTemplateFromDevConfig` / `listTemplates` / `upsertExplorerTemplate` / `makeLoadTemplate` 形参 `devConfig: DevConfigService` 改 `appConfig: AppConfigService`；**函数名 `loadTemplateFromDevConfig` 保留**（避免下游 import 大规模改名，已 verified reasonable；spec 同步实际，仅注释级文档语义切换）。
- **预配 builtin explorer**：bootstrap `upsertExplorerTemplate` 写入 app_config（idempotent，每次启动 check + 写缺）；数据迁移由 `scripts/migrate-dev-to-app.v0.0.89.sh` 处理（保 record id+key，builtin:true 项 idempotent 跳过）。
- **§6 边界同步**：模板存储后端引用从 `[P0]dev_config.md` 改 `[P0]app_config.md §3.11`；新增「专用 DELETE/PUT handler + 路由」一行指向 `app-config-template-handlers.ts` + `router.ts:/config/app/sub_agent_templates`。

详情：`specs/tech/version_logs/v0.0.89/change_log.md`

## 2026-07-03 · v0.0.56（SessionKind 统一 session 身份维度）

- **`[P1]subagent_derivation.md §2`**：旧 SessionType enum（含 'subagent'）删除；Session interface 的 type/scope 字段改为 role/derivation/biz（必填）；spawn 写入路径 §4 同步更新（type:"subagent"→role:parent.kind.role, derivation:"subagent", biz:parent.kind.biz）。
- **`[P1]a2a_protocol.md §2`**：AgentRef.type `'session'`→`'rocky'`（对齐 Role 枚举）；§2.0 type 映射表从 session.type→role；mapSessionTypeToAgentRefType 更新（undefined→'rocky'）。

详情：`specs/tech/version_logs/v0.0.56-session_type/change_log.md`

## 2026-07-03 · v0.0.56 hotfix（capByParent 从 kind 纯派生 + scope→derivation 校验维度）

- **`[P1]subagent_derivation.md §2`**：补 hotfix 注——capByParent 不读 parent session（`kind.parentToolPolicyRole` 直接派生），删 `subAgentConfig.parentRole` 字段。§2 type 与 subAgentTemplateType 正交→derivation 与 subAgentTemplateType 正交。§4 spawn 伪码 `resolveTools({role, parentRole})`→`resolveTools({kind})`。
- **`[P1]a2a_protocol.md §2`**：AgentRef.type 来自 `session.role + session.derivation`（旧 session.type 已删）。§6 工具层校验 `caller.scope`→`caller.kind.isSubagent`（scope 字段已删）；send-message-tool.ts 改读 `rtc.parentScope`（透传 kind.derivation）。

详情：`specs/tech/version_logs/v0.0.56-session_type/change_log.md`（hotfix 节）

## 2026-07-02 · v0.0.50 doc-sync（AgentRef.type 加 'session' 占位 + 独立 parent ref.name/ref.type 派生说明）

- §2 AgentRef.type 枚举补 `'session'`（顶层 standalone parent 占位，v0.0.45 起 `mapSessionTypeToAgentRefType` 已把 `undefined` / `'rocky'` 映射为 `'session'`，spec 此前未同步）。
- §2.0 新增小节明确 type='session' 的语义（playground 主会话 spawn 出 subagent 时，parent 自身非 squad 角色 → ref.type='session' 占位）；name 派生规则（subagent 用 templateType / 其他用 session.title）；独立 parent ref 派生路径（`parentAgentRef(ctx)` + `enrichForInbox` 反查覆盖）。
- 不引入新概念（'session' type 在 v0.0.31 types.ts 已声明、v0.0.45 enrich 已映射），本版仅补 spec 描述对齐代码现状。

详情：`specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md`

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`；`overall.md` 内容按类拆流并入 index 后归档至 `soft_deleted/`。
- 全部 4 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理 inline `[vX.Y]` / `[vX.Y modified]` / 顶 `> version:` blockquote / 尾部 `## 版本` 段 → 正文 = 现状。
- 直改 spec 错误：`overall.md §4` 与 `startup_reconcile.md §2.1/§3` 的 `bootstrap.ts:145/300` 行号漂移订正（实际 `:277` reconcile / `:322` setResolveConfig）——纯笔误，随迁移顺手修。
- 审计结论：spec↔code 高度一致（deliverTo 新签名 / ChildrenIndex / scope 门控 / send-message scope 校验 / D8 model resolution 全对齐）；multi_agent 不引入独立 CrudStore entity，无 entity→dir 命名偏离类 BUG。

## 2026-06-28 · v0.0.33.2（squad 复用 a2a）

- a2a 从 parent↔subagent 扩展到 squad clique：同 squad 的 squad/leader/mate 互发，跨 squad 拒，subagent 仍只可达 parent。
- subagent identity 修复：`subAgentConfig.systemPrompt → SessionConfig.systemPrompt → identity mapper` 生效。
- 工具层按 session record + `selfSquadId` 硬约束（防 LLM 幻觉目标穿透）；`send_message` 支持 sessionId/`parent`/`squadchat`/`leader`/同 squad member.name 别名。

详情：`specs/tech/version_logs/v0.0.33.2/change_log.md`

## 2026-06-28 · v0.0.31（a2a 协议对齐）

- inbox 成为 a2a 上下文中枢：`enrichForInbox` 在 deliverTo 层反查发送方补 `AgentRef.type/name` + `needReply` 必填 + `inReplyTo` 透传。
- **sender 严格判别联合**（按 source 分流 4 变体；`needReply` = source='agent' a2a 专属）。
- **deliverTo 去 config 重构**（方案 A 无 cache）：`enqueue(sessionId)/activate(sessionId)/deliverTo(sessionId, msg)` 新签名，manager 内部 `resolveConfigBySid`。
- `MessageSource` enum `'scheduled'` 并入 `'system'`（heartbeat/cron/reminder 由 system.kind 承载）；InboxEntry 两变体补 `enqueuedAt`。
- list_children 正向索引 `ChildrenIndex`（`session-children-index.ts`）替代全量 scan——O(children) 替代 O(N)（subagent 无限膨胀优化）。
- KNOWN-ISSUE BUG-034：explorer 模板 systemPrompt 未引导 child 用 send_message 回 a2a（**非协议 bug，机制全工作**，留后续版本修模板）。

详情：`specs/tech/version_logs/v0.0.31/change_log.md`

## 2026-06-28 · v0.0.30（list_children 索引优化）

- `list_children` 实现用内存正向索引 `Map<parentSid, Set<childSid>>`（lazy 建 + create/delete 增量维护）替代全量 scan。

详情：`specs/tech/version_logs/v0.0.30/change_log.md`

## 2026-06-28 · v0.0.28（实现完成：派生 + a2a + 模板 + scope=EP + UI）

- 实现完成：parent↔subagent 派生 + a2a + 模板系统 + scope=EP + subagent UI 全部上线（5 task 编码+审查 / UT 全 pass / AT 7 case 真 LLM 全 pass / ET 2 case 功能层全 pass + BUG-002 视觉保真 known-issue）。
- **D8 model 二次修订**：模板可带 `modelId`（走模板→child model=template.modelId）；自定义/inline 只能 inherit parent.modelId；spawn 入参无 modelId（不可覆盖）。解析式 `eff.modelId = template?.modelId ?? parent.modelId`。
- **scope=extension point**：subagent 无 agent 工具→不可再派生；执行层 `allowedTools` 门控 + schema 层全放开；v0.0.26 连线 bug 修复（bootstrap 注入 activationStore）。
- **agent 工具归属迁回 multi_agent 层**：`agent` 工具家族（spawn/query/abort action）在 `agent-tool.ts` 实现；`agent_tools.md` 升 1.0。
- **swarm 语义**：= parent children 集合；list_children running/terminated 分组 + UI 三段展示。
- 模板存储定 dev_config `sub_agent_templates` 组；UI 决策要点（subagent-tree 三段 + SectionChatDetail readOnly + indigo identity）。
- 真 LLM AT 暴露的 Bug 均已修复；严重避坑点（subAgentConfig 持久化 / eager answer 空→getFinalAnswer / async needReply 需 send_message）见 `design.md §5a.7`。

详情：`specs/tech/version_logs/v0.0.28/change_log.md`

## draft 0.1

- `design.md` D1-D8 决策锁定：上下文隔离（D1）/ session type+关联（D2）/ 状态分组生命周期（D3）/ spawn=create+首任务+sync·async（D4）/ send_message=通用 a2a（D5）/ abort 单向级联（D6）/ forked 内部不暴露（D7）/ model（D8）。
- O1-O6 全部已定（derivation 1.0）。
