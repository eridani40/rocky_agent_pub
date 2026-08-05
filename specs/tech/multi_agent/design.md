---
type: design
title: Multi-Agent 设计决策日志（D1-D8 + §5a 增量）
priority: P1
status: active
updated: 2026-06-30
since: v0.0.28
related: [index.md, subagent_derivation.md, subagent_templates.md, a2a_protocol.md]
---

# Multi-Agent 基础设施设计 — parent↔subagent 派生（决策日志）

> 定位：本文是 multi_agent 子系统的**决策日志**（D1-D8 + §5a v0.0.28 增量，含 rationale）。formal 契约落 `subagent_derivation.md` / `a2a_protocol.md` / `subagent_templates.md` + `../agent/tools/[P1]agent_tools.md`；本文只记「为什么这么定」，避免后人推翻又踩坑。
> 实现：parent↔subagent 派生 + a2a + 模板 + scope=EP + subagent UI **全部已实现并通过验证**（UT 全 pass / AT 真 LLM 全 pass / ET 功能层全 pass + BUG-002 视觉保真 known-issue）。真 LLM AT 暴露的 Bug 均已修复；**严重避坑点**见 §5a.7（只留会复发的坑，过程流水已删）。
> 范围：**只管 parent↔subagent 派生原语 + a2a 通信基础设施**。**不含 squad / 角色 / 团队层**（→ `../squad/`）。
> 参考：`specs/research/multi_agent_squad/{multi_agent_squad_research, crewai_research}.md`；`../agent/{agent_interface_and_loop/[P0]agent_manager.md, session/[P0]session_usage.md, tools/[P1]agent_tools.md, agent_interface_and_loop/[P0]agent_loop_side_run.md}`。
> 设计对照：Claude Code `Task` 工具（同步派生 + 隔离上下文）、CrewAI delegation（caller 暂停→callee 同步执行）、AgentScope Msg 信封。

---

## 0. 核心定位：sub-agent vs side run（必须先分清）

| | **sub-agent**（本设计主角） | **side run**（已有，内部） |
|---|---|---|
| 上下文 | **隔离**——fresh context，只看 parent 给的 task | **继承** parent snapshot（看全历史） |
| 持久化 | **独立 session**（transcript/state/usage 落盘） | **内存**（无 transcript，结束丢弃） |
| 暴露 | **LLM 工具**（spawn_agent） | **内部行为**（compact/memory 用，**不暴露给 LLM**，见 D7） |
| usage | child `current` → 递归 parent `sub` | 落发起者 `forked` |
| 对应 | Claude Code `Task` / CrewAI delegation | compact summary |

> 一句话：**side run 看全历史（内存、内部）；sub-agent 隔离上下文（独立 session、LLM 可派生）**。

---

## 1. 已定决策（D1-D8）

| # | 决策 | 内容 |
|---|---|---|
| **D1** | 上下文隔离 | sub-agent **必须隔离**——独立 session，**不继承 parent transcript**，只看 spawn 时给的 task。这是与 side run 的本质分界。 |
| **D2** | session 类型 + 关联 | session **新增 `type` 概念**（区分 main/subagent/…）+ `parentSessionId` 表关联。需核对现有 `session_store.md` Session 字段后定 schema。 |
| **D3** | 生命周期=状态分组 | **不设额外生命周期标志**。按状态分组：`{running}` vs `{terminated: ended|errored|interrupted}`。session（transcript/usage）持久保留；只对 **running 的最大并发**设上限。复用 = 对已存在（含 terminated）child 再 send_message（见 O3）。 |
| **D4** | agent 工具=创建+首任务+sync/async | **一个工具同时**：①创建 child agent ②分配第一个任务 ③设 sync/async。返回：sync→带结果；async→「child 创建成功、任务 running」handle。 |
| **D5** | send_message=通用 a2a | 异步结果汇报 / 提阻塞性问题 / 对已存在 agent 继续提问，**都走 send_message**。本阶段即定义。 |
| **D6** | abort 级联（单向） | parent abort → 其 in-flight child 级联 abort。**child 有自己独立的 controller**（非 parent 共享）；级联是**单向联动**（parent→child）。child 自身 abort/出错**不**反向影响 parent（parent 的 spawn 工具拿到 result/error 作为 tool result 继续）。 |
| **D7** | side run=内部行为 | sideRun（compact/memory）**不暴露为 LLM agent 工具**，是系统内部机制。`agent_tools.md` 的 LLM 工具集只含 spawn_agent + send_message。 |
| **D8** | model **修订 v0.0.28**（✏️ 二次修订） | ~~原「一律 inherit，模板/spawn 都不可覆盖」~~ → **模板可带 modelId**（走模板→child model = template.modelId）；**自定义/inline（无 templateRef）只能 inherit parent.modelId**；**spawn 入参无 modelId 字段**（spawn 时不可覆盖）。解析式：`eff.modelId = template?.modelId ?? parent.modelId`。理由：需求「走模板→模型走模板；走自定义→只能 inherit parent」。落 `[P1]subagent_templates.md` 1.0 + derivation §4。 |

---

## 2. 数据结构（已定，待核对 session schema）

> ⚠️ **本节代码块为早期草稿，已被 formal spec 取代，仅作历史决策记录**。权威 schema 见：
> - Session / SessionType → `[P1]subagent_derivation.md §2`（`type?` optional，enum = squad/leader/mate/subagent（mate 为 B 方案命名，避免与 squad member entity 名撞），**无 "main"**；顶层 standalone 不填 type；**加 `scope: "session"|"subagent"`**）
> - SpawnAgentInput → `§4`（**无 modelId 字段**——D8 修订 v0.0.28：model 解析式 `eff.modelId = template?.modelId ?? parent.modelId`；spawn 不可覆盖）
> - SpawnAgentResult.sync → `§4`（返 `answer: string` + `usage: Usage`，**非 result:Message / SessionUsageView**）
> - send_message → `[P1]a2a_protocol.md §5` + `derivation §5`（**needReply 必填 + inReplyTo**，**弃 waitReply/correlationId**）
> 下方旧代码块（modelId 可覆盖 / result:Message / correlationId / waitReply / SessionType="main"）均已废弃，勿据此编码。

```typescript
// 【D2】session 类型（enum 候选见 O4）
type SessionType = "main" | "subagent";   // ⚠️ 已废弃——正式 enum 见 derivation §2（squad/leader/mate/subagent，mate 为 B 方案命名）

interface Session {
  // ...现有字段...
  type: SessionType;                  // 【新增】session 类型
  parentSessionId?: string;           // 关联（SessionUsageMeta 已有，提升到 session 级）
  origin?: { spawnRunId: string; toolCallId: string };  // 【新增】由哪次 spawn 产生（审计/观测）
}

// 【D4】spawn_agent 工具入参 = 创建 + 首任务 + 模式
interface SpawnAgentInput {
  // 身份 / 能力（inline 或走 templateRef，见 O1）
  systemPrompt: string;               // child 人设
  templateRef?: string;               // 【O1】引用模板（覆盖 systemPrompt/tools/model/skill）
  allowedTools: string[];             // 工具白名单（含 send_message 的可达目标 = 拓扑编码）
  modelId?: string;                   // 【D8】缺省继承 parent；可覆盖
  skills?: string[];                  // 【O1】
  // 首任务
  task: Message;                      // 初始任务（child 唯一可见的 parent 输入）
  // 模式
  mode: "sync" | "async";             // 【D4】sync=阻塞等结果；async=立即返 handle
  maxIter?: number;                   // 缺省 25
}

// 【D4】spawn_agent 返回（联合）
type SpawnAgentResult =
  | { mode: "sync";   childSessionId: string; result: Message; usage: SessionUsageView; stopReason: StopReason }
  | { mode: "async";  childSessionId: string; runId: string; status: "running" };

// 【D5 / O6】a2a 信封
interface A2AMessage {
  from: string;                       // agentRef（sessionId 或角色名）
  to: string;
  content: Message;
  correlationId?: string;             // 关联（回复 / 追问 / 异步结果上报）
  inReplyTo?: string;
}
```

child 的 `AgentRun` **完全复用**（child session 上 modeKey="current"）。parent 侧运行时追踪：`manager.children: Map<parentSid, Set<childSid>>`（观测 + abort 级联，非持久——崩溃靠 state reconcile）。

---

## 3. 流程（已定）

### 3.1 spawn_agent（create + 首任务 + sync/async）= Claude Code Task
```typescript
// tool_execution_engine 执行 spawn_agent(input)，parent ReAct loop 在此 await（sync）或继续（async）
childSid = ulid()
await store.createSession({ id: childSid, type: "subagent", parentSessionId: parentSid,
                            origin: { spawnRunId: parentRunId, toolCallId } })
manager.children.get(parentSid)!.add(childSid)
childConfig = { sessionId: childSid, systemPrompt: input.systemPrompt,
                client: parent.client, modelId: input.modelId ?? parent.modelId,
                tools: resolveTools(input.allowedTools), loopMode: "eager-drain" }
await manager.enqueue(childConfig, [input.task])          // 首任务入 child inbox
const run = await manager.activate(childConfig)           // child 跑 eager-drain（独立 controller）

if (input.mode === "sync") {
  const r = await run.promise                            // ⭐ parent 工具点阻塞等 child final message
  manager.children.get(parentSid)!.delete(childSid)      // 运行态追踪清理（session 留盘）
  return { mode:"sync", childSessionId: childSid, result: r.finalMessage, usage, stopReason: r.stopReason }
} else {
  // async：不等，立即返 handle；child run 结束自行 cleanup 追踪（result 经 send_message 回 or parent 主动查 O2）
  run.promise.finally(() => manager.children.get(parentSid)!.delete(childSid))
  return { mode:"async", childSessionId: childSid, runId: run.runId, status:"running" }
}
```

### 3.2 send_message（a2a；异步结果 / 阻塞提问 / 追问）
```typescript
send_message(to: AgentRef, content: Message, opts?: { waitReply?: boolean; correlationId?: string })
  → 包装 A2AMessage → manager.enqueue(targetConfig, [a2aMsg])
  → target drain 时看到 role=user + a2a metadata，正常处理
  → 若需回复：target 再 send_message(to=from, correlationId) 回（异步结果上报 / 答案）
  → opts.waitReply=true 时 caller subscribe 等 target 的下一条 to=from 消息（同步语义）
// 拓扑编码：spawn 时 child 的 send_message 可达目标 = [parentRef]（sub-agent 只能找 parent）
```

### 3.3 usage 上报（零新机制，复用 session_usage §6.2）
```
child loop LLM 返回 → ContextEngine.accumulateUsage(childSid, "current", usage)
  → SessionStore 内部：累加 child.current；见 parentSessionId=parentSid
  → 递归 accumulateUsage(parentSid, "sub", usage)   ✅ 已实现
parent.getUsageView().sub = 聚合所有 child（及 child 的 child，递归）
```

### 3.4 abort 级联（D6 单向）
```
parent 被 abort（manager.abort(parentSid, runId, "current")）：
  → 额外：遍历 manager.children.get(parentSid) 中 state="running" 的 child
  → 逐个 manager.abort(childSid, childRunId, "current")（child 用自己的 controller 退出）
child 自身 abort / error：
  → 不影响 parent；parent 的 spawn_agent(sync) 把 result/error 作为 tool result 继续 ReAct
```

---

## 4. agent 工具集（LLM-facing，落 `agent_tools.md` 0.1→1.0）

| 工具 | 入参 | 返回 | 语义 |
|---|---|---|---|
| `spawn_agent` | `SpawnAgentInput` | `SpawnAgentResult`（sync/async 联合） | 创建 sub-agent + 首任务 + sync/async |
| `send_message` | `(to, content, waitReply?, correlationId?)` | ack / reply | a2a：异步结果 / 阻塞提问 / 追问 |
| ~~`fork_agent`~~ | — | — | **不暴露**（D7，sideRun 是内部 compact/memory 机制） |

---

## 5. 待探讨（占位，继续讨论）

- ✅ **O1｜sub-agent 模板**（已定，落 `[P1]subagent_templates.md`）：**用户配置**（可复制新增）+ 预配 `explorer`；模板字段 `{name, description, systemPrompt, tools, skills?}`，**无 model**（D8）；spawn 走 `templateRef + 覆盖`。存储位置待 config 子系统对齐。
- ✅ **O2｜管理工具**（已定，落 derivation §7）：`list_children` / `query_agent` / `abort_agent`，均对 parent LLM 可用。
- ✅ **O3｜复用语义**（已定，落 derivation §3.2）：复用=再 send_message 走 enqueue+activate；activate 三情况（`session_state §4.1`）覆盖 idle/error/interrupted 全终止态 → terminated child 重激活 = 新 AgentRun（同 session，transcript 累积），**结构上免费，无需复用模式**。error 态也可重激活重试。
- ✅ **O4｜session `type` enum**（已定）：`type` = **角色概念** `squad | leader | member | subagent`（不是模板！）；`subAgentTemplateType` = 模板标签（`explorer` 等），与 type 正交。side run 无 session 不入 enum。本阶段实现 subagent；squad/leader/member 后续。
- ✅ **O5｜running 并发上限**（已定）：**3 个分离限制**——全局主 session / 全局 sub-agent / 单主 session 的 sub-agent，各自独立计数、可配（落 derivation §3.1）。
- ✅ **O6｜a2a 信封**（已定，落 derivation §5 + `[P1]a2a_protocol.md` v0.2）：**AgentRef 结构化** `{type, sessionId, name}`（**type 不含 user**——user 不在 a2a 拓扑，agent↔user 走 session final text）+ **inReplyTo messageId** 线程（弃 correlationId）+ a2a 元信息**native 化进 `sender.agent` 子结构** `{ref, inReplyTo, needReply}`（早期曾挂 `Message.metadata.a2a` 子对象，已废弃）+ **回复规则="消息从哪来到哪去"+needReply**（a2a→send_message 回；非 a2a→session 内 final text）。sync 实现 = 复用现有 `AgentRun.promise`（`await run.promise` → `RunResult.answer`）；投递统一走 `manager.deliverTo(sessionId, msg)`（只需 sessionId）。
- **顶层非-squad session 的 type 归属**：待 squad 层定（候选 member / 新增 main）。

---

## 5a. v0.0.28 新决策（concept spec 优化轮）

> 用户需求 `reqs/v0.0.28/req.md` 触发 6 项决策，已全部落 formal spec。本节为决策日志 + rationale。

### 5a.1 D8 model 二次修订（与原 spec 直接冲突，必改）

- **原 spec 错**：D8「model 一律 inherit，模板/spawn 都不可覆盖」（subagent_templates.md 无 modelId 字段；derivation §4 modelId=parent.modelId）。
- **改为**：模板可带 `modelId`（走模板时 child model = template.modelId）；自定义/inline（无 templateRef）只能 inherit parent；spawn 入参无 modelId 字段（spawn 时不可覆盖）。解析式 `eff.modelId = template?.modelId ?? parent.modelId`。
- **rationale**：需求原文「如果走模板，则模型走模板；如果走自定义，那么模型只能是 inherit parent 的」。
- **落地**：`subagent_templates.md` 1.0（模板加 modelId）+ `subagent_derivation.md` 1.0 §4（解析式 + 注释）。

### 5a.2 scope = extension point（用户问「合理吗」→ 代决：合理）

- **概念**：工具是 extension point；scope ∈ {`session`, `subagent`} 管理工具可见集。**subagent scope 的工具可见集不含 agent 工具**（spawn/query/abort）→ subagent 结构上**不可再创建 subagent**（满足需求「subagent 不再可以创建 subagent」「subagent 不需要 agent 工具」）。
- **实现路径（务实选择）**：用 `allowedTools` 白名单——agent-loop 的 allowedTools 从「全集」改为「按 scope 过滤的子集」，subagent scope 禁用 agent 工具（disabledTools=['agent']）。复用已完备的 `engine.ts:46-73` 门控，**不重构 10 个硬编码工具为 EP impl**（风险大，不塞本版，作为未来增强）。
- **连线修复（v0.0.26 遗留 bug，必须修）**：`bootstrap.ts:138` new PluginManager 未注入 activationStore → 非 default scope 永远回退 default。本版修复：注入 activationStore + scope 选择逻辑接入（`buildSessionConfigFromDeps` 加 scope 参数，subagent 传 'subagent'）。
- **rationale**：v0.0.26 scope 体系已就绪（PluginScopeStore/ScopeActivationStore/PluginPolicyStore scopeId/PluginManager getExtensionImpls 双重载/PluginConfigService CRUD 全套），subagent 正是 scope 标准用例。
- **落地**：`agent_tools.md` 1.0 §2 + `subagent_derivation.md` 1.0 §2（Session 加 scope 字段）+ §4（spawn 注入 scope）。

### 5a.3 agent 工具归属迁回 multi_agent 层（不碰 squad）

- **原 spec 错**：subagent_derivation §4/§7 把 spawn/query/abort 收敛到了 `squad/[P1]squad_tools.md §6`（误把 multi_agent 工具归到 squad 层）。
- **改为**：**agent 工具定义在 multi_agent 层**（落 `agent_tools.md` 1.0）；subagent_derivation §4/§7 移除「收敛 squad_tools」措辞，改引 agent_tools.md。squad_tools §6 标注「squad 层将来复用 multi_agent agent 工具」（不展开 squad 设计）。
- **rationale**：本版严守范围红线（不碰 squad/角色层）；agent 工具是 multi_agent 派生原语，归属应在 multi_agent 层；squad 层将来「复用」而非「定义」。
- **落地**：`agent_tools.md` 1.0（新增权威定义）+ derivation §4/§7 措辞修正。

### 5a.4 swarm 语义（multi_agent 语境）

- **swarm = parent 派生的 children 集合**（list_children，running/terminated 分组）+ UI 分组展示。**不引入 squad 团队/角色概念**（leader/member/SquadChat 等都不在本版本）。
- **rationale**：需求「agent 的 swarm 和管理」——在 multi_agent 语境，swarm = parent 的 children 集合，list_children 已有 running/terminated 分组能力，UI 分组展示即可；不引入 squad 层概念避免范围蔓延。
- **落地**：`subagent_derivation.md` 1.0 §7（list_children 加 swarm 语义注释）+ UI spec（会话列表三段展开）。

### 5a.5 模板存储定 dev_config（v0.0.89 后已迁 app_config）

> **现状已迁**：v0.0.89 起 dev_config 整体废弃，模板存储迁入 `app_config.sub_agent_templates` 组（权威见 `[P1]subagent_templates.md §3` + `../config/[P0]app_config.md §3.11`）。下方为 v0.0.28 原始决策留痕。

- **原 TBD**：subagent_templates.md §3「存储位置待 config 对齐」（dev_config group vs EP 二选一）。
- **定 dev_config**：新增 `sub_agent_templates` 配置组（用户 list/copy/edit/delete，builtin explorer 只读可复制衍生），UI 复用现有 config 页。
- **explorer 工具清单对齐**：实际是 `read`/`web_search`/`web_fetch`/`send_message`，**无通配符 `read_*`**（原 spec 示意错误）。
- **rationale**：dev_config group 贴合「用户配置、可复制新增」语义；UI 复用现有 app-dev-config-page 编辑能力，零新页面。
- **落地**：`subagent_templates.md` 1.0 §3 + §5（去 TBD + 工具清单对齐）。

### 5a.6 UI 决策要点（设计稿 = 视觉契约，详见 UI spec）

- **会话列表项可折叠**（有 subagent 时）：twisty（chevronRight 10px，展开 rotate90°）+ 三段展开（① running subagent 列表 → ② 分割线「非运行中 (N)」10px mono + 展开按钮 → ③ terminated subagent 列表灰显）。
- **subagent 只读页面**：`SectionChatSession` readOnly（`chrome.readOnly=true`，后端按 `derivation==='subagent'` 判定）——隐藏 input-bar（含 send/abort/enqueue）+ ClearBtn，**保留 ComponentUsagePanel（context usage）+ 消息流 + CompactBtn**（subagent 必须 support compact——长跑上下文也会爆炸，详见 `specs/api/overall/04-agent-session.md §7`）。
- **subagent identity 视觉**：indigo dot（11px rounded-3px `#3730A3`），terminated 半透明 opacity 0.4 + name muted。
- **tokens 视觉基线**：新增 `--color-indigo` `#3730A3` + dark 映射 `#818CF8`（spec 记录，coder 实现）。
- **复用点**：ComponentUsagePanel 独立无压缩依赖可零改复用；ComponentMessageStream 通用。
- **rationale**：设计稿 `easy-opc-squad-v10.html` 是 squad 外壳，只提取 subagent 相关部分（MemberItem 三段展开 + SquadChat kind=subagent 只读），忽略 squad/角色层；功能正确 ≠ 视觉还原，二者都是验收门槛。
- **落地**：UI spec（chat-page 目录新增 subagent 组件 spec + tokens 记录）。

### 5a.7 v0.0.28 真 LLM AT 验证 Bug 留痕（精简：只留会复发的避坑点）

> v0.0.28 AT 真 LLM 验证（ROCKY_TEST_MOCK_LLM=0）暴露多个 bug，均已修复。本节**只留会复发的严重避坑点**（过程性 debug 记录已删）。Bug1（agent 工具 inputSchema 缺 properties → LLM 7 轮构造不对，已补全；runSpawn 入参容错）/ Bug3（session modelId 是 session 创建时给定，POST /messages 不回写，非 bug 是 case 修）/ Bug4（bootstrap setBuildAgentToolContext 把 parentSessionId 设成 session 自己 sid 而非 session.parentSessionId，已修）—— 这三个是 v0.0.28 实现期一次性 bug，已修且不易复发，详情略。

**【避坑点 1】subAgentConfig 持久化（Bug2，最致命，复发风险高）**：
- **坑**：`createChildSession` 若只落 session 元信息（id/type/parentSessionId/scope 等），**eff systemPrompt/tools/skills/maxIter 全丢失** → child 用 DEFAULT_SYSTEM_PROMPT + 全集工具跑，D8 model 解析 + scope 工具集全失效。任何"child 用默认配置跑起来"的现象都先查这个。
- **正确做法**：Session 加 `subAgentConfig` 字段持久化 spawn resolve 出的 effective config；`createChildSession` 写入；`buildSessionConfigFromDeps`（handlers/session-config.ts）读它覆盖 child SessionConfig 的 systemPrompt/tools/skills/maxIter。
- **落**：`[P1]subagent_derivation.md §2 subAgentConfig` + `[P0]session_store.md §2`。

**【避坑点 2】eager run.promise.answer 永远空，sync spawn 必须用 getFinalAnswer 二次提取（Bug5，复发风险高）**：
- **坑**：`spawn-action.ts` executeSpawn sync 分支若直接 `return { answer: r.answer }`，answer **永远是空字符串**——eager run（`eager-drain-agent.ts` modeKey='current'）settle 时 `agent-run-registry.attachRunPromise` 硬填 `{ answer: '', ... }`（run_end 只 emitRunEnd(stopReason)，run_stop 无 answer payload，eager-drain 不提取 final text）。任何 sync「await run.promise 取 answer」的路径都不能直接用 r.answer。
- **正确做法**：sync 分支 `await run.promise` 后（run 已 settle，child transcript 完整落盘），调 `getFinalAnswer(childSid)` 从 `store.getMessages(childSid)` 读 transcript，提取**最后一条 assistant message 的 text block 聚合**作 answer。`getFinalAnswer` 未注入/读异常 → fallback r.answer（保持兼容）。**不改 eager-drain 的 settle 语义**（影响主对话，风险大），只在 spawn sync 路径补提取。
- **落**：`[P1]subagent_derivation.md §4` sync 伪代码注释 + 实现 `spawn-action.ts:130-142` + `getFinalAnswerFromStore:223`。

**【避坑点 3】async spawn 的 needReply=true 必须配 send_message 工具（Bug6，复发风险中）**：
- **坑**：async spawn 首任务 `needReply=true`（语义合同：subagent 完成后主动 send_message 回 parent），但若 LLM 调 agent.spawn 传的 tools 没带 send_message（或模板 tools 不含），subagent **无回报工具** → parent transcript 无 a2a reply。needReply 合同无能力履行。
- **正确做法**：subagent 工具集由 `buildSessionConfigFromDeps` 按 `subAgentConfig.tools` 白名单过滤（模板/inline tools 决定），**白名单必须含 `send_message`**——这是 async needReply=true 能履行的前提（explorer 模板 `tools=[read,web_search,web_fetch,send_message]` 自带）。**不在 executeSpawn 强制追加**（曾用 `ensureSendMessage` 在 async 分支追加，已移除——白名单本身应含，server 不替配置兜底）。自定义 inline 模板/白名单若漏 send_message，async subagent 无回报工具，属配置责任。**sync 分支**靠 await run.promise + getFinalAnswer 取 answer，不依赖 send_message。注意 scope=EP 下 subagent 排除的是 'agent' 工具，send_message 不被排除（`scope-allowed-tools.ts` SUBAGENT_DISABLED_TOOL='agent'）。
- **落**：`[P1]subagent_derivation.md §4` async 流程注释 + 结果送达语义。

---

## 6. 与现有 spec 的衔接（落地时核对）

| 现有 | 衔接点 |
|---|---|
| `session_usage.md §6.2` | parentSessionId 递归 sub 上报——**直接复用**，零改 |
| `agent_manager.md` activate/abort/subscribe | child 跑独立 eager-drain，复用；新增 `children` map + abort 级联钩子 |
| `agent_manager.md §7` | "通信走 enqueue+activate"——send_message 即此定调的具体化 |
| `agent_loop_side_run.md` | sideRun 保持内部（D7），不入 agent_tools LLM 集 |
| `agent_tools.md`（0.1 占位） | 本设计的 §4 落为其 1.0 |
| `session_store.md` Session 字段 | **待核对**：加 `type` / 提升 `parentSessionId` / 加 `origin` |
