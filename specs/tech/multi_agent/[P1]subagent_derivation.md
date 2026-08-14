---
type: spec
title: Sub-Agent 派生（multi-agent 基础设施）
priority: P1
status: active
updated: 2026-08-04
since: v0.0.28
related: [index.md, design.md, subagent_templates.md, a2a_protocol.md, ../agent/tools/[P1]agent_tools.md, ../agent/[P0]agent_manager.md]
---

# Sub-Agent 派生（multi-agent 基础设施）

> 定位：定义「一个 agent 如何派生 sub-agent」的完整契约——session 创建 / `agent` 工具（spawn/query/abort）/ 生命周期 / abort 级联 / usage 上报 / 管理工具 / a2a 通信。
> 范围：**只管 parent↔subagent 派生**。不含 squad/角色/团队层（`../squad/`）。
> 参考：`index.md`、`design.md`（D1-D8 决策）、`subagent_templates.md`（模板）；`../agent/tools/[P1]agent_tools.md`（**`agent` 工具权威 1.0**）；`../agent/{[P0]agent_manager.md, session/[P0]session_usage.md §6.2, [P0]agent_loop_side_run.md, [P0]agent_interface.md}`；调研 `specs/research/multi_agent_squad/`。session.type 完整字段（含 bizType/squadId/memberId）权威源 = `../agent/session/[P0]session_store.md §2`，本文 §2 仅保留 multi_agent 派生场景的字段语义。
> 设计对照：Claude Code `Task`（同步派生 + 隔离上下文）、CrewAI delegation（caller 暂停→callee 同步执行）。

---

## 1. 定位：sub-agent vs side run

| | **sub-agent**（本 spec） | **side run**（已有，内部） |
|---|---|---|
| 上下文 | **隔离**（fresh，只看 parent 给的 task） | **继承** parent snapshot（看全历史） |
| 持久化 | **独立 session**（transcript/state/usage 落盘） | **内存**（无 transcript，结束丢弃） |
| 暴露 | **LLM 工具** `spawn_agent` | **内部行为**（compact/memory，不暴露 LLM，D7） |
| usage | child `current` → 递归 parent `sub` | 落发起者 `forked` |

一句话：**side run 看全历史（内存·内部）；sub-agent 隔离上下文（独立 session·LLM 可派生）**。

---

## 2. Session schema（D1 隔离 / D2 类型+关联 / O4）— [v0.0.56] type/scope 字段删除

> **[v0.0.56]** 旧 `SessionType` enum（含 `'subagent'` 值）/ `Session.type` / `Session.scope` / `subAgentConfig.parentRole` 已完全删除。新字段：`role: Role` / `derivation: Derivation` / `biz: BizType`（必填）。`'subagent'` 不再是 role 值 —— 由 `derivation='subagent'` 独立表达。subagent 的 `role = parent.role`（bloodline role）。权威：`specs/tech/agent/session/[P0]session_kind.md` + `[P0]session_store.md §2`。
>
> **[v0.0.56 hotfix]** capByParent 不再读 parent session record：`resolveTools` 入参只传当前 session 的 `kind`，内部 `kind.parentToolPolicyRole`（subagent → `${biz}-${role}`）直接派生 parent ToolPolicyRole——**不需 `subAgentConfig.parentRole` 字段、不需 `parentKind` 入参**。spawn 时只写 child kind（role=parent.role, biz=parent.biz, derivation='subagent'）。
>
> **[v0.0.57] capByParent 整体删除**：`subagent.bound` 已是所有 parent.bound 的子集，第三道 `∩ parent.bound` 永远裁不掉任何东西——纯冗余。`resolveTools` subagent 分支简化为 `mainAllowedTools ∩ subagent.bound`；`SessionKind.parentToolPolicyRole` getter 同步删除（无消费者）。下文涉及 capByParent 的伪码保留作历史对照。

```typescript
// [v0.0.56] SessionKind 统一身份维度（见 session_kind.md）
type Role = 'rocky' | 'leader' | 'mate' | 'squad';    // 不含 'subagent'
type Derivation = 'main' | 'subagent';
type BizType = 'playground' | 'studio';

interface Session {
  // ...现有字段...
  role: Role;                       // [v0.0.56] 会话角色（subagent 存 parent.role bloodline）；取代旧 type 字段
  derivation: Derivation;           // [v0.0.56] 派生层级；取代旧 scope + type='subagent' 双字段
  biz: BizType;                     // [v0.0.56] 业务分区；取代旧 bizType 字段（必填，无 lazy 默认）
  parentSessionId?: string;         // 派生者 session（仅 derivation=subagent 有值）
  subAgentTemplateType?: string;    // 派生自哪个模板标签（仅 derivation=subagent 有意义）
  origin?: { spawnRunId: string; toolCallId: string };  // 由哪次 spawn 产生（审计/观测）
  subAgentConfig?: {                // effective config
    systemPrompt: string;
    tools?: string[];
    skills?: string[];
    maxIter?: number;
  };
}
```

> **parentSessionId 双位置（两处保持，非冗余降级）**：`parentSessionId` 同时存在两处——session 顶层（本字段）+ `SessionUsageMeta.parentSessionId`（session_store.md §2）。两处职责分工、互不替代：**顶层**给 child 自查 parent（如 send_message('parent') 别名解析 `a2a_protocol.md §2.2`、`bootstrap.ts` setBuildAgentToolContext 路由源）；**SessionUsageMeta.parentSessionId** 给 usage 模块递归 sub 上报（`session_usage.md §6.2`）。createSession 时由顶层值同步写入 SessionUsageMeta，代码保证一致。

- **derivation 与 subAgentTemplateType 正交**：[v0.0.56] derivation=派生层级（'subagent'），subAgentTemplateType=模板（explorer）。一个 sub-agent session = `derivation:"subagent" + subAgentTemplateType:"explorer"`（child role = parent.role bloodline）。
- **隔离**（D1）：child **不继承** parent transcript；初始 messages 仅 = `[systemPrompt, task]`。区别于 side run（继承 snapshot）。

---

## 3. 生命周期（D3 状态分组）

**不设额外生命周期标志**。child 状态复用现有 Run/SessionState：

| 分组 | 状态 | 来源 |
|---|---|---|
| **running** | session state=`running`（有 in-flight AgentRun） | child activate 后 |
| **terminated** | session state ∈ {**idle**, **error**, **interrupted**}（run 已结束：ended/max_iter/doom_loop→idle / errored→error / aborted→interrupted） | child run 结束 |

- **session（transcript/usage）持久保留**——terminated 不删 session（可审计、可复用）。
- **运行态追踪**：`manager.children: Map<parentSid, Set<childSid>>`（运行中 + 刚结束待清理；非持久，崩溃靠 state reconcile）。
- **running 并发上限**：3 个分离限制（§3.1）。
- **复用（O3）**：terminated child 可被 parent 再 `send_message` 派新活 → child inbox 进消息 → 复用 activate 三情况从 idle 转 running → drain（详见 §5）。**无需专门"复用模式"**。

### 3.1 并发上限（O5 已定 = 3 个分离限制）

三类独立计数器，各自上限可配（默认值已落：`agent-manager-children.ts:25-27` `LIMIT_GLOBAL_MAIN=8` / `LIMIT_GLOBAL_SUB=8` / `LIMIT_PER_PARENT_SUB=4`）：

| 限制 | 范围 | 计数对象 | 检查点 | 实现状态 |
|---|---|---|---|---|
| **全局主 session**（global_main） | 系统级 | running 的非-subagent session（squad/leader/mate（mate 为 B 方案命名，原 member）+ 顶层 standalone[type 待定]） | 主 session **activate 前** | **TODO/留口**——本版 spawn 只产 subagent，main 不进 children tracker；main check 留口（`agent-manager-children.ts:199-201`，计数从 store.listSessions running 数派生，未启用）。**当前只 global_sub + per_parent_sub 生效。** |
| **全局 sub-agent**（global_sub） | 系统级 | running 的 subagent session（全系统合计） | sub-agent **activate 前** | ✅ `checkRunningLimit('subagent', ...)` `agent-manager-children.ts:186-189` `tracker.globalSubCount() >= LIMIT_GLOBAL_SUB` |
| **单主 session 的 sub-agent**（per_parent_sub） | per-parent | 某 parent 下 running subagent 数 | sub-agent **activate 前**（额外查 parent 计数） | ✅ `agent-manager-children.ts:192-195` `tracker.perParentCount(parentSid) >= LIMIT_PER_PARENT_SUB` |

- **检查在 activate 实际起 run 时**（session_state 情况2 `markRunning` 成功前），不因触发路径而异——`spawn_agent`、`send_message` 重激活、用户消息都走同一 activate，都检查。
- 激活 sub-agent 须**同时**满足「全局 sub 未满」+「该 parent sub 未满」；激活主 session 须「全局主未满」（**main check 留口，未启用——见上表 TODO**）。**不满足则拒**（已定 A：caller/LLM 重试）；排队+调度器（slot 空闲自动重激活）为未来增强。
- 三限制**相互独立**，不互占额度。

### 3.2 复用 / 重激活路径（O3 已定 = 结构上免费）

**复用一个已终止 child = 再 `send_message`，走标准 enqueue + activate，无需特殊"复用模式"。** activate 三情况（`session_state.md §4.1`）覆盖所有终止态：

| child 当前 session state | send_message(child, msg) 行为 |
|---|---|
| **idle**（正常结束 / max_iter / doom_loop 后）| enqueue msg → 情况2 `markRunning` → 新 AgentRun → drain 新消息 |
| **error**（run 出错后）| 同上——error 也在情况2（CAS `state IN (idle, interrupted, error)`）→ 可重激活重试 |
| **interrupted**（被 abort 后）| 同上——interrupted 在情况2 → 可重激活 |
| **running**（仍在跑）| enqueue msg → 情况1（already_activated）→ 现有 loop 下轮 drain（"对运行中 agent 继续提问"）|
| **interrupting**（abort 收尾中，罕见）| enqueue msg → 情况3 poll-wait → 收尾完 → 情况2 激活 |

- **每次重激活 = 同一 session 上的新 AgentRun（新 runId）**；transcript 跨 run 累积持久（= child 的"工作记忆"）。
- **`lastUpdatedAt`** 在 enqueue/activate 时更新（list_children 按此倒序）。
- 复用受 §3.1 并发上限约束（重激活 = 新 running，占额度）。

---

## 4. `agent.spawn`（D4 合一 + D8 model 修订）

> **[工具收敛 v0.0.28]**：`spawn_agent` / `list_children` / `query_agent` / `abort_agent` 四件已**收敛**为单工具 **`agent`**（actions：`spawn` / `query` / `abort`）。**权威定义在 `specs/tech/agent/tools/[P1]agent_tools.md` 1.0**（multi_agent 层，不再收敛到 squad_tools）。本节为 `agent.spawn` action 的契约源——LLM 看到的是 `agent(action=spawn, input=SpawnAgentInput)`。
> 同样：本文 §7「管理工具」三件（list_children / query_agent / abort_agent）已合并为 `agent.query` + `agent.abort`，权威见 agent_tools.md §1 + 本文 §7。squad_tools §6 标注「squad 层将来复用 multi_agent agent 工具」。

**一个工具同时**：①创建 child agent ②**发首任务消息**（语义等同 send_message）③设 sync/async。

```typescript
interface SpawnAgentInput {
  // 身份/能力：templateRef（载入模板）+ 任意字段覆盖（无模板时 systemPrompt 必填）
  templateRef?: string;          // 引用模板（见 subagent_templates.md），载入 systemPrompt/tools/skills/modelId
  systemPrompt?: string;         // 覆盖模板 systemPrompt（无 templateRef 时必填）
  tools?: string[];              // 工具白名单三态：undefined=继承 subagent profile toolBound 全集（默认）/ []=显式空 / 非空=与 bound 取交集。覆盖模板 tools（含 send_message 的可达目标 = 拓扑编码）
  skills?: string[];             // 覆盖模板 skills
  // ⚠️ 无 modelId 字段——spawn 时不可覆盖 model（D8 修订）：走模板→child model=template.modelId；自定义（无 templateRef）→inherit parent.modelId
  // 首任务（语义 = send_message：内部构造 sender.agent 子结构，needReply 按 mode 设）
  task: { content: ContentBlock[] };
  // 模式
  mode: "sync" | "async";        // sync=阻塞等 final answer；async=立即返 handle
  maxIter?: number;              // 缺省 25
  // [v0.0.203] caller-provided child workspace 目录（透传到 createChildSessionImpl：
  //   child session.workspaceDir = input.workspaceDir ?? parent.workspaceDir）。
  //   不传时 child 继承 parent.workspaceDir（既有行为不变）。
  workspaceDir?: string;
}
// 解析（D8 修订）：effective = input.X ?? template.X（X ∈ systemPrompt/tools/skills）；
//   ★ model: eff.modelId = template?.modelId ?? parent.modelId（有模板用模板的；无模板 inherit parent；spawn 入参无 modelId → spawn 时不可覆盖）
//     parent.modelId = parent **运行时 resolved 具体 modelId**（runSpawn 经 `agentManager.resolveConfigBySid(parentSid)` 取 parentConfig.modelId，**非** `session.modelId` raw hint）；
//     原因：raw hint 常 `'default'`/空，subagent 被 `isStudioMainSession`（需 `derivation='parent'`）切断 squad/classroom default 链 → resolveModel fallback 跑空抛 `ModelNotConfiguredError`。
//   ★ tools 三态：eff.tools=undefined（input/template 都不传）→ 落库 subAgentConfig.tools=undefined → resolveToolSet 走 `new Set(bound)` 全集分支 = 继承 subagent profile toolBound；
//     eff.tools=[] 或非空 → resolveToolSet 走 `eff.tools ∩ bound` 交集分支（[]=显式空集 / 非空=取交集）。
//     历史 bug：`createChildSessionImpl` 落库曾用 `tools ?? []` 把 undefined 降级成 []，导致不传 tools 的 subagent 零工具（连带 tool_guidance prompt 段缺席）——已修（透传 undefined，详见 log.md v0.0.222）。
//   无 template 且无 systemPrompt → error

type SpawnAgentResult =
  | { mode: "sync";  childSessionId: string; answer: string; usage: Usage; stopReason: StopReason }
  | { mode: "async"; childSessionId: string; runId: string; status: "running" };
```
> `answer` / `usage` / `stopReason` 复用现有 `RunResult`（见 `agent_interface.md §3`：`{ answer: string; usage: Usage; stopReason; rounds }`）类型。**注意 sync answer 不是 `r.answer` 直接透传**——eager run.promise.answer 永远空（见 §4 executeSpawn sync 注释 [Bug5]），实际由 `getFinalAnswer(childSid)` 从 transcript 二次提取最后一条 assistant text 聚合。

**首任务消息的 sender 字段**（透传 a2a 信封，等价于 parent send_message 给 child）：
```typescript
firstMessage.sender = {
  source: "agent",
  agent: {
    ref: parent.ref,             // parent AgentRef（type/sessionId/name；详见 a2a_protocol §2）
    needReply: input.mode === "sync" ? false : true,   // ★ sync 硬填 false；async 默认 true
    // inReplyTo 不填（首任务无 parent message 可引用）
  }
}
```
**意义**：subagent 看到 `needReply=false`（sync）时**知道**：完成任务后**不要 send_message 回**，把结果写进 final answer 即可（spawn_agent 通过 `await run.promise` 取回 RunResult.answer）；`needReply=true`（async）时知道**完成后要 send_message 回 parent**（语义合同）。

**执行流程**（tool_execution_engine 执行，parent ReAct loop 在 sync 下 await、async 下继续）：

```typescript
agent.spawn(input):
  // 解析 effective 配置（template + 覆盖）；D8 修订：model 走模板（有）或 inherit parent（无模板）；spawn 入参无 modelId
  eff = resolve(input, template)               // eff.systemPrompt/tools/skills + eff.modelId = template?.modelId ?? parent.modelId
  // ★ [v0.0.56 hotfix] resolveTools 真实签名见 ../agent/tools/[P0]tool_policy.md §3（policy 单源 · 三层一致）：
  //   child tools/allowedTools = resolveTools({ kind: child.kind, mainAllowedTools: eff.tools, allTools })
  //   = eff.tools ∩ TOOL_POLICY['subagent'].bound
  //   入参只传 kind（role 由 kind.toolPolicyRole 派生，不读 parent session、不需 subAgentConfig.parentRole 持久化——已删）。
  //   [v0.0.57] 不再 ∩ parent.bound（capByParent 删除——subagent.bound 已是所有 parent.bound 子集，冗余）。
  //   旧伪码 resolveTools({role, parentRole, ...}) retire（被 kind 单入参替代）。
  childConfig = { systemPrompt: eff.systemPrompt,
                  modelId: eff.modelId,               // ★ D8 修订：有模板→template.modelId；无模板→parent.modelId（= parent resolved 具体 model，runSpawn 经 resolveConfigBySid 取，非 raw hint）；client 按 modelId 运行时重建
                  tools: eff.tools /* 落库 subAgentConfig.tools（三态透传 undefined/[]/非空，不降级）；buildSessionConfigFromDeps 调 resolveToolSet 算最终 allowedTools（undefined→bound 全集 / []→空集 / 非空→∩ bound） */,
                  skills: eff.skills, maxIterations: input.maxIter ?? 25,
                  loopMode: "eager-drain",
                  /* [v0.0.56] scope 字段已删除——工具可见性走 derivation='subagent' + TOOL_POLICY */ }
  // createSession：创建 child session record（type/parentSessionId/scope/workspaceDir 等，沿用 session_store 现状，不改 config 现状）。child SessionConfig 注入现有构造路径的机制 → 后续细化（Q1/Q3）
  // [v0.0.56] type/scope 字段删除，改用 role/derivation/biz
  childSid = await store.createSession({ ...childConfig, role: parent.kind.role, derivation: "subagent",
                              biz: parent.kind.biz, parentSessionId: parentSid,
                              subAgentTemplateType: input.templateRef, origin: { spawnRunId: parentRunId, toolCallId } })
  manager.children.get(parentSid)!.add(childSid)

  // 构造首任务消息（语义 = parent send_message 给 child）
  firstMsg: Message = {
    id: ulid(), sessionId: childSid, role: "user",
    content: input.task.content,
    sender: {
      source: "agent",
      agent: { ref: parent.ref, needReply: input.mode === "sync" ? false : true }
    }
  }

  // ★ 统一投递入口 deliverTo（只需 sessionId——manager 内部按 sid 持有 config；见 §4.1）
  const run = await manager.deliverTo(childSid, firstMsg)   // = enqueue(inbox) + activate → AgentRun

  if (input.mode === "sync"):
    try {
      const r = await run.promise                          // ⭐ await eager run_end（run 已 settle，child transcript 完整落盘）
      // [现状·Bug5 修复] eager run.promise.answer **永远是空串**——agent-run-registry.attachRunPromise
      //   硬填 { answer:'', ... }（run_stop 事件无 answer payload，eager-drain 不提取 final text）。
      //   改从 transcript 二次提取：getFinalAnswer(childSid) 读 store.getMessages 取最后一条 assistant
      //   message 的 text block 聚合作 answer；未注入则 fallback r.answer（保持兼容，虽空）。
      const answer = getFinalAnswer ? (await getFinalAnswer(childSid)) : r.answer
      return { mode:"sync", childSessionId: childSid, answer, usage: r.usage, stopReason: r.stopReason }
    } finally {
      manager.children.get(parentSid)!.delete(childSid)    // 成功/出错/被中断都清理 children 追踪（避免 map 泄漏）
    }
  else: // async
    run.promise.finally(() => manager.children.get(parentSid)!.delete(childSid))
    return { mode:"async", childSessionId: childSid, runId: run.runId, status:"running" }
    // async 结果回传：subagent 按 needReply=true 主动 send_message(to=parent) 回报为主路径；
    //   LLM 未自觉回报时由系统代发兜底（child run 结束且非 tool_pending 时触发，见下「结果送达语义」async 条）
```

**结果送达语义**：
- **sync = 保证送达**：parent `await run.promise` 阻塞等 child run 结束（transcript 落盘），**因 eager run.promise.answer 永远空**（见上伪代码 [Bug5] 注），改调 `getFinalAnswer(childSid)` 从 transcript 二次提取最后一条 assistant text 作 `answer` 返。首任务 `needReply=false` 告诉 subagent **不要 send_message 回**——避免与同步返回路径双重投递。
- **async = 系统代发兜底（回报可靠性 = 代码保证，非仅靠 LLM 自觉）**：subagent 看到 `needReply=true` 主动 send_message 回报仍是**主路径**（语义合同），parent 也可 `agent.query` 轮询；LLM 未自觉回报时由**系统代发兜底**——child run 结束（`RunLifecyclePort.onRunEnd` 且 `stopReason≠tool_pending`；中断走 `onInterrupted`）时，扫本 run drain 到的 `needReply=true` a2a 请求（`drainAndPartition` 收集 → `LoopState.agentReplyRequests` 跨轮累积），按 sender 去重后查**判据 A**：本 run child 未向该 sender 投递过（`A2aReplyTracker.hasDeliverySince`；数据源 = `AgentManagerImpl.deliverTo()` 成功投递后记的 from→to seq + run 装配时 baseline epoch 快照）→ 系统**以 child 身份**经 `deliverTo` 代发一条回报（`subagent-reply-fallback.ts settleAgentReplyFallback()`）：成功（no_tool_call/no_new_messages）= final text（复用 `getFinalAnswerFromStore`，空退化为通知文案）；失败/中断（error/interrupted/doom_loop/max_iterations）= 结局通知（stopReason + 一句原因）。代发消息 `needReply=false`（防回话风暴）、`inReplyTo` 指回该 sender 最新 M.id。`tool_pending`（HITL 悬挂）轮不代发——未决请求 `A2aReplyTracker.stashPending` 跨 run 携带，续跑出真结果那轮才结算。兜底仅装配于 main && derivation='subagent' 的 run（`buildRunDeps` 注入 replySettle；顶层/squad/旁路 run 不装配，全链路 noop）；best-effort——单 sender 投递失败 catch 续下一条，不阻断 run 收尾。**async 路径 executeSpawn 强制 `eff.tools` 含 `'send_message'`**（`ensureSendMessage`，Bug6 修复；scope=EP 下 subagent 排除的是 'agent' 工具，send_message 不被排除）——LLM 自觉回报的主路径仍须有回报工具。

### 4.1 `deliverTo` —— 统一投递入口（agent_manager 重构 · v0.0.31 spec 已落地）

**核心洞察**：**a2a 发消息与前端发消息同构**。前端给后端发消息只传 `{ sessionId, messageContent }`——**不传 system prompt / config**（后端 `context_engine` 在 assemble 时按 sessionId 自己组建 system prompt，见 `specs/tech/agent/context/[P0]system_prompt.md` map→reduce→build）。a2a 发消息同理：target session 激活后，**它自己的 context engine 用它自己的 config 组建 system prompt**，与前端激活它走同一条路径。

**因此 deliverTo 根本不碰 config**——只做 inbox 入队 + 激活：

```typescript
interface AgentManager {
  deliverTo(sessionId: string, message: Message): Promise<AgentRun>;  // ★ 只需 sessionId——不传 config/systemPrompt
}
// 注：createSession 是 SessionStore 的方法（session_store §2），非 AgentManager；spawn 调 store.createSession 建 session record。
// deliverTo 内部：
//   inbox.append(sessionId, message)      // 入队（与前端发消息同路径）
//   activate(sessionId)                   // target loop drain → assemble → context_engine 自己组建 system prompt
//   → 返回 AgentRun                        // （config 是 target session 自己的事，createSession 时已定，deliverTo 不取不传）
```

- **config 与 deliverTo 无关**：config 在 `createSession` 时确定（spawn 创建 child / hire 创建 role 时给定）。之后所有激活（前端 / a2a / 心跳）都复用那份，**不再传 config**。deliverTo 不需要"取 config"——target assemble 时自己组建。
- **同步等结果**：`await (await manager.deliverTo(sid, msg)).promise` → `RunResult.answer`（复用现有 `AgentRun.promise`，eager 等 `run_end`）。
- **fire-and-forget**：忽略返回的 run（如 send_message 工具）。
- **deliverTo 统一投递入口（代码已落地）**：现有 `enqueue(config, ...)` / `activate(config)` 的 config 参数不合理（外部给 session 发消息不该传 config）→ 重构为 `enqueue(sessionId, ...)` / `activate(sessionId)`，对外收敛到 `deliverTo`。**`[P0]agent_manager.md` §2-§2.4 已同步 spec + 代码实装**（enqueue/activate 签名去 config + deliverTo 内部 enrich + resolveConfigBySid 方案 A + 调用方改动清单）。代码已落地：`agent-manager.ts` enqueue/activate 新签名 + resolveConfigBySid；`session-messages.ts:243,252` 已收敛 deliverTo；`agent-manager-children.ts` ManagerChildrenOps 已改新签名（详见 agent_manager §2.4）。
- **收敛要求已落地**：所有"给 session 发消息"的调用（spawn 首任务 / a2a send_message / user 入口 / 心跳激活 / 测试 fixture）统一收敛到 `deliverTo(sessionId, msg)`——**禁止散用裸 enqueue/activate**。spec 全链 + 代码均已对齐（agent_manager §2.4 调用方清单）。

**用途**：
- `agent.spawn(mode="sync")` 内部：createSession 定 config → `await (await deliverTo(childSid, firstMsg)).promise` → answer（本节 §4）
- a2a send_message / 心跳激活 / 服务端工具 / 测试 fixture 等任何"给已存在 session 投递消息"的场景

---

## 5. `send_message` / a2a（D5 + O6 已定）= deliverTo

> **AgentRef 与回复规则的权威定义在 `[P1]a2a_protocol.md`** —— 本节聚焦 send_message **工具签名** + 流程；schema/规则细节引用 a2a_protocol.md。

**send_message 与「用户给 agent 发消息」走同一逻辑**：`manager.deliverTo(target.sessionId, msg)`（统一投递入口 = enqueue + activate）。**无独立 a2a bus**——agent→agent 投递就是普通入队 + 激活，target 的 eager-drain 正常 drain，与 user→agent 完全同路径。唯一差别：消息 `sender.source = "agent"`，承载完整 a2a 信封（见下）。

### 5.1 工具签名

```typescript
send_message({
  target: AgentRef | string,    // 完整 AgentRef，或 sessionId / 别名字串（"parent"/"squadchat"/"leader"/角色 name）
  content: ContentBlock[],      // 权威形态：array of {type:"text", text:string}；容错见下 [v0.0.331]
  needReply?: boolean,          // [v0.0.68 R5] 可选，default:true（schema default + engine default-fill 注入）
  inReplyTo?: string            // 关联原 message.id（thread；约定见 a2a_protocol §4.3）
}): Promise<{ messageId: string }>
```

> **[v0.0.331] content 容错契约（`normalizeContentBlocks`，语义唯一来源 = `app/server/src/agent/tools/send-message-tool.ts`）**：LLM 实际传参不总是权威数组形态（真实 glm/deepseek 17-20% 传缺 type 的 `[{"text":"..."}]` 或 string/object），工具侧统一经 `normalizeContentBlocks(rawContent)` 收敛为 `ContentBlock[]`：
> - array：每块校验 object + `text` 是 string，**缺 `type` 补 `type:'text'`**（未知 type 不透传，避免脏数据落库）
> - string → `[{type:'text', text:str}]`
> - object（非数组）→ `.item ?? obj` 解包；解包后仍单 block object → 包数组
> - 其他（number/null/undefined 等）→ `{ error }` 形态（调用方处理，不抛）
> - 工具 desc 含字面示例 + 强调 **Each block MUST include the "type" field**（防再生，对 glm/deepseek 部分有效）
> - **落库前同样 normalize**：agent-loop-stream `closeActive()` + replay-collector `reconstitute()` 在 `send_message` 且 arguments 非 `_raw` 时调同一函数补 `type:'text'`（新数据永不空白；`_raw` 半截路径由 `_rawTruncated` 标记，不补 content）。normalize 后进入 LLM 上下文的 tool_use.input 为补全形态，语义不变。

> **[v0.0.68 R5]** needReply 从「★ 必填」改可选 + `default:true`：
> - schema 层：`required` 移出 `needReply`；`properties.needReply.default = true`
> - 引擎层：`engine.validateInput` 末尾 default-fill 通用机制（见 `tools/[P0]tool_execution_engine.md §4.1`）注入 `input.needReply = true`
> - normalize 兜底：直接调 `run`（绕过 engine，如 UT）或 normalize 内 needReply 仍非 boolean → `?? true`
> - 显式 `false` 不被覆盖（normalize `?? true` 不动 false）

**返回**：立即返回 `{ messageId }`，**不阻塞等回复**。`send_message` 工具本身是 fire-and-forget；`needReply` 只是给对端 LLM 的语义合同（"你需要 send_message 回来"），**不是**同步 wait 标志。

**想要同步等结果？**——那不是普通 a2a 场景，是"创建 + 派活 + 等结果"：用 `agent.spawn(mode="sync")`（§4）。普通 a2a 互动不支持工具内阻塞 wait（避免长锁 + LLM 不响应风险）。

### 5.2 流程

```
send_message({ target, content, needReply, inReplyTo? }):
  → resolve target → AgentRef（按 a2a_protocol §2.2 别名解析优先级：sessionId / "parent" / "squadchat" / "leader" / 角色 name）
  → 校验 target ∈ caller.squad_agents_status（按 a2a_protocol §6 身份逻辑）
  → 构造 msg.sender = { source: "agent", agent: { ref: caller.ref, inReplyTo, needReply } }
  → manager.deliverTo(target.sessionId, msg)        // ★ 统一投递（enqueue + activate），只需 sessionId
  → 返回 { messageId }（fire-and-forget；忽略 deliverTo 返回的 run）
```

target.loop drain 看到 `sender.source = "agent"` → 按 a2a_protocol §4.1 处理（`needReply=true` 时必回；通过 `send_message(to = sender.agent.ref)` 回）。

**信封显示名 targetName 语义（[v0.0.340 决策 1]）**：工具结果含 targetName（供前端 out 信封渲染），`resolveTargetDisplayName` 优先级 = ① AgentRef.name（LLM 已填）→ ② **memberStore 反查实时成员名**（target session 有 squadId+memberId 且 `rtc.memberStore`；成员名权威源 = memberStore，`getMember(squadId, memberId)?.name` 非空即返回）→ ③ session.title（subagent/squad chat/standalone 等 non-squad-member fallback）→ ④ undefined。**改名后信封显示新名、与 roster 永远一致**（不再读创建时 title 快照）；member 反查失败（member 已删/读失败）静默 fallback 不抛错；不改 target 解析/路由逻辑（名字不参与寻址）。

### 5.3 拓扑编码

sub-agent 的 `send_message` 可达目标 = `[parent]`（工具层校验收窄到 parent；别名 `"parent"`）。child 结构上无法编址其他 agent。详见 a2a_protocol §3 squad_agents_status 表。与 side run 的 `allowedTools` 同一机制。

---

## 6. abort 级联（D6 单向）

```typescript
// parent 被 abort 时（manager.abort 的 finalize 钩子追加）：
for childSid in manager.children.get(parentSid) where sessionState(childSid) === "running":
  manager.abort(childSid, childRunIdOf(childSid), "current")   // child 用【自己独立】的 controller 退出
// ⭐ 传递性：manager.abort(child) 再入此钩子 → 级联到 grandchild…直到无 in-flight 后代（全树收尾）

// child 自身 abort / error：不级联 parent
//   → parent 的 spawn_agent(sync) 把 result/error 作为 tool result 继续 ReAct
```

**为何不共享 controller**：共享会让 child 出错/中断**连坐 parent**（双向）。需求是单向——parent 中断 → child 跟着停（省 token、无 orphan）；child 自己挂了不该杀 parent。故 child 有独立 controller + 单向联动。

---

## 7. 管理工具（O2 已定 + 筛选/限量 — `agent.query` / `agent.abort`）

> **工具归属**：管理工具（list_children/query_agent/abort_agent）已合并为 `agent.query` + `agent.abort`，**权威定义在 `specs/tech/agent/tools/[P1]agent_tools.md` 1.0**（multi_agent 层）。本表保留各 action 的入参/返回/语义契约；squad 层（squad_tools §6）将来复用。

| 工具 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `list_children` | `(parentSid?, filter?: { status?, templateType?, limit? })` | `[{childSid, subAgentTemplateType, status, lastUpdatedAt}]` | 列出自己派生的 child，**支持状态筛选 + 限量** |
| `query_agent` | `(agentRef)` | `{status, usage: SessionUsageView, lastUpdatedAt, ...}` | 查单个可达 agent 详情 |
| `abort_agent` | `(agentRef)` | ack | **主动中断**指定 child（走 manager.abort；parent 用它停烧钱的 child） |

**list_children 筛选/限量**（角色后期会累积大量 sub-agent 历史）：
- `filter.status?`：按 **session state** 筛——`running` / `terminated`（terminated=idle|error|interrupted，见 §3）；或细分 `idle`/`error`/`interrupted`。缺省=全部。
- `filter.templateType?`：按模板筛（如只看 `explorer`）。
- `filter.limit?`：最多返回 N 条（缺省如 20）；**按 `lastUpdatedAt` 倒序**（最近活跃优先）→「最新 N 个 sub-agent」。
- 未来可加 `cursor` 分页。
- **实现：正向索引（v0.0.30）**——parent→children 关系靠 child record 的 `parentSessionId` 反向字段（**无专门 children 表**）。`store.listChildren(id)` 之前取 listSessions 全量 + 内存筛 `parentSessionId===id`（O(N)，N=所有 session）。subagent 无限膨胀 → 每次 `GET /session/:id/children` + children tree 刷新轮询都全量扫描，越来越慢。**v0.0.30 优化**：session-store 持内存正向索引 `Map<parentSid, Set<childSid>>`（`session-children-index.ts` `ChildrenIndex`），lazy 建（首次 listChildren 扫一次全量）+ `createSession`/`deleteSession` 增量维护；listChildren 查索引 O(children)。一致性保证：`parentSessionId` 创建后不可变（无改 parent 路径），故只需 create/delete 维护。
- **swarm 语义（v0.0.28 multi_agent 语境）**：list_children 返回的 children 集合 = parent 派生的 **swarm**（running/terminated 两组）。UI 分组展示（会话列表项展开：① running subagent 列表 → ② 分割线「非运行中 (N)」 → ③ terminated subagent 列表灰显，见 UI spec）。**不引入 squad 团队/角色概念**——swarm 在 multi_agent 语境 = parent 的 children 集合。

- `abort_agent` 至少对 parent LLM 可用；`list_children`/`query_agent` 亦对 LLM 开放（观测+决策）。
- 可达性同 send_message 拓扑编码（sub-agent 只对 parent 可达）。

---

## 8. usage 上报（零新机制，复用 session_usage §6.2）

```
child loop LLM 返回 → ContextEngine.accumulateUsage(childSid, "current", usage)
  → SessionStore 内部：累加 child.current；见 parentSessionId=parentSid
  → 递归 accumulateUsage(parentSid, "sub", usage)   ✅ 已实现
parent.getUsageView().sub = 聚合所有 child（含 child 的 child，递归）
```

---

## 9. 边界 + 衔接现有 spec

| 零件 | 归属 |
|---|---|
| sub-agent 派生契约（session/spawn/lifecycle/abort/usage/管理） | 本文 ✅ |
| async 回报兜底语义（判据 A 履约判定 + 系统代发契约） | 本文 §4「结果送达语义」+ `a2a_protocol.md §4.2`；lifecycle 挂点/装配见 `../agent/agent_interface_and_loop/[P0]agent_loop_unified.md §3.2` |
| `agent` 工具权威定义（spawn/query/abort action 表 + scope 工具可见性） | `[P1]agent_tools.md` 1.0 ✅（multi_agent 层） |
| a2a 信封 + send_message | 本文 §5（O6 细化） |
| sub-agent 模板（用户配置 + explorer + modelId） | `subagent_templates.md` |
| scope = extension point（工具可见集管理） | `[P1]agent_tools.md §2` + `[P0]ext_impl_scope.md`（v0.0.26 体系） |
| 递归 sub usage 上报机制 | `session_usage.md §6.2`（复用，零改） |
| child 的 eager-drain ReAct 执行 | `agent_loop_eager_drain.md`（复用） |
| child activate/abort/subscribe 句柄 + 并发闸门 | `agent_manager.md`（复用 + 加 children map + 级联钩子 + activate 内嵌 §3.1 三限检查） |
| side run（内存旁路） | `agent_loop_side_run.md`（内部，不入本文 LLM 工具集） |
| 工具调度执行 | `tool_execution_engine.md`（agent/send_message 经它调度） |
| squad 层 agent 工具复用 | `specs/tech/squad/[P1]squad_tools.md §6`（引用 agent_tools.md，不重复定义） |

---

## 10. 待定（继续探讨）

- **剩余小 TBD（非阻断）**：`spawn_agent` 命名（候选 `task`/`delegate`）；**global_main 并发上限 check 留口未启用**（§3.1，本版 spawn 只产 subagent）。
