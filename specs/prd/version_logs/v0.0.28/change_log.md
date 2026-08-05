# v0.0.28 PRD 变更日志 — Multi-Agent（parent↔subagent 派生 + a2a）

## 概述

本版本交付 **multi_agent 基础设施**：一个 parent agent 可以**派生 sub-agent**（隔离上下文、独立 session），并与之 **a2a 通信**；前端在会话列表**展开 subagent swarm**（running/terminated 分组）+ **subagent 只读页面**。同时引入 **sub-agent 模板**（用户配置，预配 `explorer`，存 dev_config）+ **scope = extension point**（subagent 无 agent 工具 → 结构上不可再派生）。

**严守范围红线**：**只 multi_agent（parent↔subagent 派生 + a2a + 模板 + scope + subagent UI）**。**严禁碰 squad/角色/团队层**（leader/member/SquadChat/charter/RoleSpec/团队 budget 等不在本版本）。设计稿 `reqs/v0.0.28/easy-opc-squad-v10.html` 是 squad 外壳，**只取 subagent 相关部分**（`.sq-sub / .sq-subitem / .sq-divider / .id-dot.id-subagent` + SquadChat kind=subagent 只读）。

技术方案已在概念 spec 定稿（multi_agent/ 五件 + agent_tools.md 1.0 + chat-page 三处组件 spec）。本 PRD 仅做产品化表达 + 关键用户路径，**不重新设计、不发明概念**。

权威输入：`reqs/v0.0.28/req.md`；概念权威源：见 §5 对齐确认。

---

## 1. 用户故事

> 一个 parent agent 在执行用户任务时，遇到「需要隔离上下文做子任务」的场景（如：探查代码、并行调研、专项重试）→ parent LLM 调 `agent(action=spawn, templateRef=explorer, mode=sync)` → 系统创建一个 **explorer subagent**（只读探查、隔离 session、用模板配置）→ subagent 跑完把结果写进 final answer → parent 拿到 answer 继续 ReAct。用户在**会话列表展开 parent 项** → 看到 subagent 列表（running 在前 / terminated 灰显在后）→ **点 subagent 子项** → 进入 **subagent 只读页面**（消息流 + context usage，**无输入框/无压缩/无 clear**），观测子 agent 在做什么。

**核心价值**：
1. **能力分身**——parent 可派生隔离上下文的子 agent 做专项子任务，主上下文不被污染。
2. **观测透明**——subagent 是一等 session，可在 UI 展开/只读观测其消息流和 usage，不是黑盒。
3. **结构安全**——subagent 无 agent 工具（scope 硬约束），**不可无限套娃**；token 烧得起的 child 可被 parent abort。
4. **复用便利**——模板（explorer 等）让 spawn 一行派生，无需 inline 重写 systemPrompt。

---

## 2. 功能范围

### 2.1 IN SCOPE

1. **agent 工具**（`agent` 单工具 3 action）：`spawn`（创建+首任务+sync/async）/ `query`（list_children swarm 列表 + 单 child 详情，按 updatedAt 倒序）/ `abort`（中断自己派的 child）。权威 `[P1]agent_tools.md` 1.0 + `subagent_derivation.md §4/§7`。
2. **subagent session 派生**：`type:"subagent"` + `parentSessionId` + `scope:"subagent"` + `subAgentTemplateType` + `origin`；隔离上下文（fresh，仅 `[systemPrompt, task]`）；复用现有 session_usage §6.2 递归 sub 上报（零改）。
3. **a2a 通信**：`send_message`（needReply 必填 + inReplyTo thread；subagent 拓扑仅可达 parent）；统一投递入口 `manager.deliverTo(sessionId, msg)`。权威 `[P1]a2a_protocol.md` 0.3 + `subagent_derivation.md §5`。
4. **生命周期 + abort 单向级联**：状态分组 running/{terminated: idle|error|interrupted}；parent abort → in-flight child 级联 abort（单向，child 挂不连坐 parent）；terminated child 可被再 send_message 重激活（结构免费）。
5. **scope = extension point**：subagent scope 的工具可见集**不含 agent 工具** → 结构上不可再派生。本版实现=allowedTools 白名单过滤（subagent scope `disabledTools=['agent']`），复用 engine.ts:46-73 门控；**修 v0.0.26 连线 bug**（bootstrap.ts 注入 activationStore + buildSessionConfigFromDeps 加 scope 参数）。权威 `[P1]agent_tools.md §2`。
6. **sub-agent 模板**：dev_config `sub_agent_templates` 配置组（list/copy/edit/delete，builtin explorer 只读可复制衍生）；预配 `explorer`（tools=[read/web_search/web_fetch/send_message]，无 modelId=inherit parent）。权威 `[P1]subagent_templates.md` 1.0。
7. **D8 model 解析**：模板可带 `modelId`（走模板→child model=template.modelId）；自定义/inline（无 templateRef）只能 inherit parent.modelId；**spawn 入参无 modelId 字段**（spawn 时不可覆盖）。解析式 `eff.modelId = template?.modelId ?? parent.modelId`。
8. **会话列表 subagent 展开树**：parent conv-item 有 subagent → twisty 可展开 → 三段（running 列表 / 分割线「非运行中 (N)」+ 展开按钮 / terminated 灰显列表）。权威 `component-subagent-tree.md` + `_overview.md §4.2/§4.2a`。
9. **subagent 只读页面**：SectionChatDetail readOnly mode（session.type=subagent 时）——**隐藏** input-bar（含 send/abort/enqueue）+ CompactBtn + ClearBtn；**保留** ComponentUsagePanel（context usage）+ 消息流（user 右气泡 / subagent 左气泡带 indigo identity）+ topbar（subagent name + model-tag **不可点选** + 子AGENT·只读 tag）。权威 `_overview.md §4.3`。
10. **视觉契约**：subagent identity = **indigo dot（11px rounded-3px `#3730A3`，terminated opacity 0.4）**；id-tag.id-subagent `rgba(55,48,163,0.12)` 底 + indigo 字 + JetBrains Mono 9px/600 uppercase「子AGENT · 只读」；tokens 新增 `--color-indigo`（light `#3730A3` / dark `#818CF8`）。对照 `easy-opc-squad-v10.html`（squad 外壳，仅取 subagent 相关 CSS）。

### 2.2 OUT OF SCOPE（NON-GOALS）

| 排除项 | 理由 |
|--------|------|
| **squad / 角色 / 团队层**（leader/member/SquadChat/charter/RoleSpec/团队 budget/team/task/goal 工具） | 范围红线——squad 层后续版本；本版只 multi_agent parent↔subagent 派生原语 |
| **agent_manager deliverTo 重构**（enqueue/activate 去 config 参数） | spec 标为重构方向（subagent_derivation §4.1），非阻断 TBD；本版 spawn/send_message 内部用 deliverTo 语义，agent_manager.md 待 doc-modifier 同步 |
| **工具全量 EP impl 化**（每 tool 注册为 EP impl，scope 走 getExtensionImpls 双重载） | 未来增强（agent_tools §2.2）；本版用 allowedTools 白名单实现 scope，风险可控 |
| **跨 squad 寻址 / squadId 前缀** | a2a 拓扑硬约束（subagent 仅可达 parent）；跨 squad 待 squad 层 |
| **顶层非-squad session 的 type 归属**（main/member?） | TBD，待 squad 层定；本版顶层 standalone session 的 type 字段不填 |
| **swarm 视图的「团队」语义** | swarm 在 multi_agent 语境 = parent 的 children 集合（list_children running/terminated 分组），**不引入 squad 团队概念** |
| **spawn_agent 命名最终化**（候选 task/delegate） | 非阻断 TBD；本版 LLM-facing 工具名 = `agent`（action=spawn） |

---

## 3. 关键用户路径（MANDATORY — = 测试最低覆盖要求）

每条路径至少一个 API 或 E2E case。verifier 不得低于此覆盖。无 mock（遵循 memory `no-mock-api-e2e-tests`：真 LLM + 真服务，subagent 实际写数据并查真落库）。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 1【sync spawn 模板】**：parent sync spawn explorer → 阻塞等 answer | parent session 对话 → LLM 调 `agent(action=spawn, templateRef=explorer, mode=sync, task=...)` → 创建 explorer subagent（type=subagent/scope=subagent/隔离上下文/只读工具集）→ sync 阻塞 `await run.promise` → subagent 跑完把结果写进 final answer（needReply=false 不 send_message 回）→ parent 拿 `SpawnAgentResult.sync.answer` 继续 ReAct；usage 递归 sub 上报 parent | `agent.spawn` · createSession(type=subagent/scope) · deliverTo · run.promise · usage §6.2 | AT（spawn_sync_explorer） |
| **路径 2【async spawn 自定义 + inherit model】**：parent async spawn 自定义 systemPrompt → subagent inherit parent model → send_message 回报 | parent 调 `agent(action=spawn, systemPrompt=自定义, mode=async)` → **subagent 用 inherit parent.modelId**（无 templateRef→eff.modelId=parent.modelId）→ 立即返 handle `{runId, status:running}` → subagent 完成后 `send_message(to=parent, needReply=false)` 回报结果（首任务 needReply=true 引导）→ parent `agent.query` 可查 | spawn async · D8 inherit · send_message 回报 · agent.query 轮询 | AT（spawn_async_inherit + send_message_reply） |
| **路径 3【模板带 modelId】**：spawn 走带 modelId 的模板 → child model = template.modelId（非 inherit） | 用户先在 dev_config copy explorer → 编辑改 modelId 存为新模板 → parent 调 `agent(spawn, templateRef=新模板, ...)` → child model = **template.modelId**（非 parent.modelId）→ subagent 按模板 model 跑 | dev_config 模板 CRUD · D8 解析式 `eff.modelId = template?.modelId ?? parent.modelId` | AT（template_with_modelId） |
| **路径 4【query swarm】**：parent query → 列出 children（running/terminated 分组） | parent 派生多个 child（有 running 有 terminated）→ 调 `agent(action=query, filter={status?, limit?})` → 返回 children 列表（按 updatedAt 倒序，swarm 视图），可按 status 筛 running/terminated | `agent.query` list_children · 状态分组 · lastUpdatedAt 排序 | AT（query_swarm_groups） |
| **路径 5【abort child】**：parent abort → 中断在跑的 child | parent 调 `agent(action=abort, ref=child)` → child controller 退出 → child state running→interrupted；parent 自身不受影响（单向）；parent abort 时 in-flight child 级联 abort | `agent.abort` · D6 单向级联 · state interrupted | AT（abort_child + abort_cascade） |
| **路径 6【UI 展开 swarm】**：会话列表展开 parent → running/terminated 三段 | parent 项有 subagent → 点 `conv-item-{id}-twisty` 展开 `subagent-tree` → running 段显示 → 点 `subagent-tree-terminated-toggle` 展开分割线「非运行中 (N)」→ terminated 灰显列表（opacity 0.4） | conv-item-twisty · subagent-tree 三段 · indigo dot · terminated 灰显 | ET（UC-28.1） |
| **路径 7【UI subagent 只读页】**：点 subagent 子项 → 只读页面 | 点 `subagent-item-{sessionId}` → 切到该 subagent session → SectionChatDetail readOnly mode：**隐藏** input-bar + CompactBtn + ClearBtn；**保留** usage-panel + 消息流（subagent 左气泡 indigo identity）+ topbar（subagent name + model-tag 不可点 + 子AGENT·只读 tag） | readOnly mode · 隐藏/保留清单 · id-tag.id-subagent · model-tag 不可点 | ET（UC-28.2） |
| **路径 8【scope 结构约束】**：subagent session 内 LLM 看不到 agent 工具 → 无法再 spawn | spawn 创建 subagent（scope=subagent）→ subagent session 的 allowedTools = 全集 \ {agent} → subagent LLM 工具列表无 spawn/query/abort → **结构上不可再派生**（非 prompt 劝说） | scope=subagent · allowedTools 白名单 · engine.ts:46-73 门控 | AT（scope_no_agent_tool）+ UT（engine 门控） |
| **路径 9【模板管理】**：dev_config list/copy explorer → 编辑 → 新模板可用 | 用户进 dev_config `sub_agent_templates` 组 → list 看到内置 explorer → copy explorer → 改名/改 systemPrompt/改 tools/改 modelId → 保存为新模板 → parent spawn 引用新模板正常派生 | dev_config 模板 CRUD · explorer builtin 只读可复制 · resolution 规则 | AT（template_crud + spawn_with_custom_template） |

---

## 4. E2E Use Cases（subagent UI 视觉 + 功能）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-28.1 | 在 parent session 触发 spawn（产生 running + terminated child 各若干）→ 回会话列表 → 点 parent 项的 twisty → 截图 | 展开 subagent-tree：① running 段显示 running child（indigo 11px rounded-3px dot + name fg-2）；② 分割线「非运行中 (N)」JetBrains Mono 10px muted + 展开按钮；点 toggle → ③ terminated 段灰显（dot + name opacity 0.4） |
| UC-28.2 | 承接 UC-28.1（parent 已展开）→ 点某 subagent 子项 → 截图 subagent 只读页面 | 切到 subagent session：topbar 显 subagent name + model-tag（不可点）+ 「子AGENT · 只读」id-tag（rgba(55,48,163,0.12) 底 + indigo 字）；消息流显示（user 右气泡 / subagent 左气泡 indigo identity）；context usage 圆环可见；**无** input-bar / send / abort / enqueue-view / CompactBtn / ClearBtn |
| UC-28.3 | subagent 在 running → 点 parent twisty 展开 → 等其跑完 → 截图 | running 段的该 subagent 消失（已转 terminated）→ 自动落入 terminated 段灰显（需重新展开 toggle 可见） |
| UC-28.4 | parent 主动 abort 一个 running subagent → 截图会话列表 | 该 subagent 转 interrupted → 出现在 terminated 段灰显（state=interrupted）；parent 项本身不挂（单向级联） |

> E2E 用 `vision_check.py`（单图功能检查 + 有设计稿时 compare 视觉保真度）断言：subagent-tree 三段结构 / indigo dot 11px rounded-3px / terminated opacity 0.4 / readOnly mode 隐藏清单 / id-tag.id-subagent 视觉。设计稿 = `easy-opc-squad-v10.html`（squad 外壳，compare 时仅对 subagent 相关区域 `.sq-sub/.sq-subitem/.sq-divider/.id-dot.id-subagent/.id-tag.id-subagent`）。

---

## 5. PRD ↔ 概念 spec 对齐确认（MANDATORY）

逐条引用概念 spec，声明 PRD 与之**无矛盾**——PRD 是概念的产品化表达，不发明新概念。

| PRD 概念 | 概念 spec 权威源 | 对齐确认 |
|----------|------------------|---------|
| `agent` 单工具 3 action（spawn/query/abort） | `specs/tech/agent/tools/[P1]agent_tools.md §1`（工具表） | ✅ 一致——PRD 路径 1/4/5 引用同一工具名 + action，不发明 spawn_agent/query_agent/abort_agent 旧名 |
| `SpawnAgentInput`（无 modelId 字段，task+mode+templateRef/systemPrompt 覆盖）+ `SpawnAgentResult`（sync 返 answer/usage/stopReason；async 返 runId/status） | `[P1]subagent_derivation.md §4`（spawn 契约）+ `[P1]subagent_templates.md §4`（resolution） | ✅ 一致——PRD 路径 1/2/3 引用同一入参/返回；sync 返 answer 非 result:Message |
| **D8 model 解析**：模板带 modelId→走模板；自定义→inherit parent；spawn 入参无 modelId | `[P1]subagent_templates.md §1/§4`（D8 修订）+ `[P1]subagent_derivation.md §4`（解析式 `eff.modelId = template?.modelId ?? parent.modelId`） | ✅ 一致——PRD 路径 2（inherit）+ 路径 3（模板 modelId）精确映射；不引入 spawn 时覆盖 model |
| `Session.type="subagent"` + `parentSessionId` + `scope:"subagent"` + `subAgentTemplateType` + `origin` | `[P1]subagent_derivation.md §2`（Session schema，scope 字段 v0.0.28 新增） | ✅ 一致——PRD 引用同一字段集；type 是角色概念（非模板标签），与 subAgentTemplateType 正交 |
| 状态分组 running/{terminated: idle\|error\|interrupted} + D6 abort 单向级联 | `[P1]subagent_derivation.md §3`（生命周期）+ `§6`（abort 级联） | ✅ 一致——PRD 路径 4/5 + UC-28.3/28.4 映射同分组 + 单向语义 |
| 复用 = terminated child 再 send_message 重激活（activate 三情况覆盖 idle/error/interrupted） | `[P1]subagent_derivation.md §3.2`（复用路径） | ✅ 一致——PRD 不发明「复用模式」 |
| running 并发上限（全局主 / 全局 sub / 单主 sub 三限制） | `[P1]subagent_derivation.md §3.1`（O5 三限） | ✅ 一致——PRD 不引入新并发语义 |
| `send_message`（needReply 必填 + inReplyTo thread；fire-and-forget；同步用 spawn mode=sync） | `[P1]subagent_derivation.md §5`（send_message 工具签名）+ `[P1]a2a_protocol.md §4`（needReply 语义）+ `§5`（回复规则） | ✅ 一致——PRD 路径 2 send_message 回报映射 needReply=true（async 首任务）/=false（fyi） |
| subagent 拓扑仅可达 parent（reachable_agents=[parent]） | `[P1]a2a_protocol.md §3`（reachable_agents 表）+ `§6`（工具层校验） | ✅ 一致——PRD 不引入跨 parent / 跨 squad 寻址 |
| `manager.deliverTo(sessionId, msg)` 统一投递（enqueue+activate，不碰 config） | `[P1]subagent_derivation.md §4.1`（deliverTo 契约） | ✅ 一致——PRD 不发明独立 a2a bus |
| **scope = extension point**：subagent scope 工具可见集不含 agent 工具 → 结构上不可再派生 | `[P1]agent_tools.md §2`（scope 概念 + 可见性表）+ `§2.2`（allowedTools 白名单实现） | ✅ 一致——PRD 路径 8 引用同一概念；本版实现=allowedTools 过滤（非 EP impl 化，标未来增强） |
| v0.0.26 连线 bug 修复（bootstrap 注入 activationStore + buildSessionConfigFromDeps 加 scope） | `[P1]agent_tools.md §2.3`（连线修复） | ✅ 一致——PRD 路径 8 依赖此修复 |
| list_children swarm 语义（running/terminated 分组 = parent children 集合，非 squad 团队） | `[P1]subagent_derivation.md §7`（list_children swarm 注释） | ✅ 一致——PRD 路径 4 + UI 路径 6 引用同语义；不引入 squad 团队概念 |
| dev_config `sub_agent_templates` 组（list/copy/edit/delete，builtin 只读可复制） | `[P1]subagent_templates.md §3`（存储定 dev_config）+ `§5`（explorer 预配） | ✅ 一致——PRD 路径 9 引用同一存储 + CRUD；explorer tools=[read/web_search/web_fetch/send_message] 无通配符 |
| 会话列表 subagent 展开树（三段：running / 分割线「非运行中 (N)」/ terminated 灰显） | `specs/ui/components/chat-page/component-subagent-tree.md`（独立 spec）+ `_overview.md §4.2/§4.2a`（conv-item twisty + subagent-tree 概要） | ✅ 一致——PRD UC-28.1 引用同一三段结构 + Props + testid |
| subagent 只读页面（SectionChatDetail readOnly mode：隐藏 input-bar/CompactBtn/ClearBtn；保留 usage-panel/消息流） | `specs/ui/components/chat-page/_overview.md §4.3`（readOnly mode）+ `_components.md`（section-chat-detail） | ✅ 一致——PRD UC-28.2 引用同一隐藏/保留清单 + model-tag 不可点 |
| subagent identity 视觉（indigo dot 11px rounded-3px `#3730A3`；terminated opacity 0.4；id-tag.id-subagent） | `component-subagent-tree.md`（视觉基线）+ `_overview.md §4.2a/§4.3/§8`（tokens 新增 --color-indigo） | ✅ 一致——PRD UC-28.x 引用同一视觉基线；对照设计稿 `.id-dot.id-subagent/.id-tag.id-subagent` |
| usage 递归 sub 上报（child current → parent sub，零改复用 session_usage §6.2） | `[P1]subagent_derivation.md §8` + `specs/tech/agent/session/[P0]session_usage.md §6.2` | ✅ 一致——PRD 不发明新 usage 机制 |

> **无新概念引入**：本版本所有概念（agent 工具 3 action / SpawnAgentInput·Result / Session.type+scope / D8 model 解析 / send_message needReply / deliverTo / scope=EP / dev_config 模板 / subagent-tree / readOnly mode / indigo identity）均已在概念 spec 定稿（multi_agent/ 五件 + agent_tools.md 1.0 + chat-page 三处组件 spec）。PRD 仅做产品化表达。

> **发现的 spec 问题（反馈 orchestrator，未擅自大改）**：
> 1. `[P1]subagent_derivation.md §4` SpawnAgentInput 注释提到 `manager.deliverTo` 但 agent_manager.md 仍是 `enqueue(config)/activate(config)` 旧签名——doc-modifier 阶段 5 需同步 agent_manager.md（spec 自标「待重构同步」，非本版阻断）。
> 2. `[P1]a2a_protocol.md §7` 引用 `squad/[P1]squad_tools.md` 的 send_message 入口，但本版 squad 层未实现——PRD 路径 2 的 send_message 走 multi_agent `agent` 工具同层（不依赖 squad_tools），与 a2a_protocol §8 边界表一致。
> 3. `[P1]subagent_templates.md §6` 边界表引用 `specs/ui/components/app-dev-config-page/`（模板 UI 复用 config 页），该目录 spec 存在性待 coder 实现时核对——本版 PRD 不发明新页面，复用既有 dev-config-page。

---

## 6. 不覆盖项及理由

| 不覆盖项 | 理由 |
|----------|------|
| **E2E 不覆盖 agent_manager deliverTo 重构的内部实现** | spec 标为重构方向（非阻断 TBD）；E2E 黑盒只验 spawn/send_message 行为正确（路径 1/2），不验内部 enqueue/activate 签名 |
| **E2E 不覆盖跨 squad 寻址** | 范围红线——subagent 拓扑仅可达 parent；跨 squad 待 squad 层 |
| **E2E 不覆盖 squad/角色/team/task/goal 工具** | 范围红线——squad 层后续版本 |
| **UT 覆盖 scope 门控（engine.ts:46-73 allowedTools 过滤）** | 路径 8 要求 UT 验证 subagent scope 的 allowedTools 排除 agent 工具（白盒，coder 单测） |
| **视觉保真度 compare 仅对 subagent 相关区域** | 设计稿是 squad 外壳；compare 时仅对 `.sq-sub/.sq-subitem/.sq-divider/.id-dot.id-subagent/.id-tag.id-subagent` 区域，忽略 squad/role/team 层（避免 squad 未实现导致整体 compare FAIL 假象） |

---

## 7. 版本

v0.0.28（multi_agent 基础设施：parent↔subagent 派生 + a2a + 模板 + scope + subagent UI。**严守范围红线：只 multi_agent，不碰 squad/角色/团队层**。功能：①`agent` 单工具 3 action（spawn/query/abort，权威 agent_tools.md 1.0）；②subagent session 派生（type=subagent/parentSessionId/scope=subagent/隔离上下文/usage 递归 sub 上报零改）；③a2a send_message（needReply 必填 + 拓扑仅可达 parent + deliverTo 统一投递）；④生命周期状态分组 + D6 abort 单向级联 + terminated 重激活；⑤scope=extension point（subagent 无 agent 工具→结构不可再派生，allowedTools 白名单实现 + 修 v0.0.26 连线 bug）；⑥dev_config `sub_agent_templates` 模板组（list/copy/edit/delete，builtin explorer 只读可复制）；⑦D8 model 解析（模板带 modelId→走模板；自定义→inherit parent；spawn 不可覆盖）；⑧会话列表 subagent 展开树（三段 running/分割线/terminated 灰显，indigo dot 11px rounded-3px）；⑨subagent 只读页面（SectionChatDetail readOnly mode，隐藏 input-bar/CompactBtn/ClearBtn，保留 usage-panel/消息流）。设计稿 `easy-opc-squad-v10.html` 仅取 subagent 相关视觉契约。技术权威 `specs/tech/multi_agent/` 五件 + `specs/tech/agent/tools/[P1]agent_tools.md` 1.0；UI 权威 `specs/ui/components/chat-page/{_overview.md §4.2/§4.2a/§4.3/§8, component-subagent-tree.md, _components.md}`；API 待 arch 细化 `specs/api/overall/`）。

**v0.0.28 实现完成状态**（doc-modifier 阶段 5 同步）：5 task 编码+审查全 pass / UT 2614 pass / AT 7 case 真 LLM 全 pass / ET 2 case 功能层全 pass（DOM 权威全 pass + border/color PASS）+ **BUG-002 视觉保真 layout/font known-issue**（vision_check 模型 px/字体测量疑似误判，实现代码对齐 spec 待用户人工复核）。真 LLM AT 验证发现 Bug1-4 已修复（agent 工具 inputSchema 补全 / subAgentConfig 持久化字段 / session modelId 持久化机制澄清 / bootstrap parentSessionId 路由），技术决策留痕见 `specs/tech/multi_agent/design.md §5a.7` + `specs/tech/version_logs/v0.0.28/change_log.md §3`。spec 同步：multi_agent 五件 + agent_manager.md v5.2（deliverTo wrapper）+ API spec v1.0a（modelId/usage.sub/sender.source 标记）+ UI spec（component-subagent-tree + _overview §4.2/4.2a/4.3）。
