---
type: spec
title: Agent 间通信协议（a2a_protocol）
priority: P1
status: active
updated: 2026-08-04
since: v0.0.28
related: [subagent_derivation.md, design.md, ../agent/message/[P0]agent_message_interface.md, ../squad/squad_definition.md]
---

# Agent 间通信协议（AgentRef + 回复规则 + reachable_agents）

> 定位：定义 a2a 通信的**协议层**——**寻址结构**（AgentRef）+ **回复规则**（基于 sender.source）+ **可达集**（reachable_agents）。
> 范围：跨 multi_agent（subagent）与 squad（角色）两层共享。
> 参考：`agent/message/[P0]agent_message_interface.md §5`（MessageSender schema）、`multi_agent/[P1]subagent_derivation.md §4/§5`（spawn_agent/send_message）、`../squad/squad_definition.md`、`../squad/agent_squad_chat.md` / `agent_leader.md` / `agent_member.md`（各角色 rules）。

---

## 1. 设计哲学

**a2a (agent ↔ agent) 和 user ↔ agent 是两个完全不同的通道**：

| 通道 | 机制 | 工具 |
|---|---|---|
| **user → agent** | user 在某 session UI 打字 → 进**该 session inbox**（`sender.source = "user"`） | 无（chat UI 直发） |
| **agent → user** | agent 在**自己 session 内**出 final text → UI 渲染给 user | 无（agent loop 输出） |
| **agent → agent** | `send_message(to=AgentRef)` → 对端 session inbox + activate（`sender.source = "agent"`） | `send_message` 工具 ✅ |

**核心规则**（写进所有 agent 的 `rules` section）：

> **消息从哪儿来，就回到哪儿去。**
> - `sender.source === "agent"` → 想回 → `send_message(to = sender.agent.ref)`；`needReply=true` 必回（即便简短确认）。
> - 其他来源（`user` / `system` / `approval`）→ 想回 → **在当前 session 内出 final text**；不调 send_message。
> - 你要**主动问 user**（非回复语境）：
>   - 单人 session（user 在你这）→ 直接出 final text；
>   - 群聊（user 在 SquadChat session）→ `send_message(to=SquadChat)`，群聊 UI 直接展示该 inbox 消息（SquadChat agent 不创作 answer，<EOS> 设定不变）。

---

## 2. AgentRef（a2a 寻址结构）

```typescript
interface AgentRef {
  type: "leader" | "mate" | "subagent" | "squad" | "rocky";  // [v0.0.56] 'session'→'rocky'（old 'session' = 顶层 standalone parent 占位；现用 Role）；mate（B 方案，避免与 squad 层 member entity 名撞）。'subagent' 保留（a2a 拓扑需区分 derivation）
  sessionId: string;     // ★ 路由主键（inbox 在该 sessionId 下）
  name: string;          // 人类可读名（leader/mate member 的 Member.name；squad/subagent 用系统名；standalone parent 用 session.title）
}
```

- **type** 来自该 session 的 `session.role` + `session.derivation`（[v0.0.56] 旧 `session.type` 字段已删；经 `inbox-enrich.ts:mapSessionTypeToAgentRefType` 映射：subagent→`'subagent'`，其他→`session.role` 直通）；告诉 LLM "我在跟什么角色对话"。**mate**（B 方案命名：避免与 squad 层 member entity 名撞；spec 层术语统一，旧称 member）。
- **sessionId** = a2a 的**路由权威字段**——`send_message` 工具按 sessionId 走 `manager.deliverTo` 投递。
- **name** = 人类可读地址；Member.name 在 **squad 内唯一**（用户拍板 / squad_definition §3）。

### 2.0 type='rocky' 的语义（[v0.0.56] 'session'→'rocky'）

> **[v0.0.56]** `mapSessionTypeToAgentRefType`: `undefined`→`'rocky'`（旧`'session'`）；`'rocky'`/`'leader'`/`'mate'`/`'squad'`/`'subagent'`→同名直通。

| session.role | AgentRef.type | 说明 |
|---|---|---|
| `'subagent'` | `'subagent'` | 子 agent（derivation='subagent'） |
| `'leader'` / `'mate'` / `'squad'` | 同名 | squad 角色 |
| `'rocky'`（playground 主会话） | **`'rocky'`** | 顶层非角色 session（最常见的「parent」场景：playground 主会话 spawn 出 subagent，parent 自身不是任何 squad 角色） | |

**name 派生**（`inbox-enrich.ts:deriveAgentRefName`）：
- subagent → `subAgentTemplateType`（如 `"explorer"`）；缺省 → `"subagent"`
- 其他（含 standalone parent / leader / mate / squad）→ `session.title`；无 title → `"parent"`

> **顶层 standalone parent 派生 spawn 上下文**：playground 主会话（[v0.0.56] role='rocky'）调 `agent.spawn` 派生子 agent 时，子 agent 收到的首任务 message `sender.agent.ref` 由 `parentAgentRef(ctx)` 派生（`runtime-context.ts`）：`type=ctx.parentType ?? 'subagent'` 占位（顶层 undefined → 占位 'subagent'，仅 runtime 用；进 inbox 前 `enrichForInbox` 会按发送方 session record 反查覆盖为真实 type，[v0.0.56] 即 `'rocky'`，旧 `'session'` 已废弃）；`name=ctx.parentName`（= `session.title ?? 'session'`）。AT `logical_view_prefix_tc1` 真实场景：parent=playground 主会话 → ref.type 经 enrich 后 = `'rocky'`（[v0.0.56]，旧 `'session'`）、ref.name = 派生 spawn 时的 session 描述（如「异步派生 explorer 子 agent」类 title）。本表权威：`inbox-enrich.ts:mapSessionTypeToAgentRefType` + `deriveAgentRefName`。

### 2.1 LLM 输入与系统补齐

LLM 调 `send_message(target, ...)` 时，`target` 可填：
1. 完整 `AgentRef` struct（最严格）
2. `sessionId` 字符串（直命中）
3. 别名字符串（`"parent"` / `"squadchat"` / `"leader"` / 角色 name）

工具层按 §2.2 优先级解析 → **canonical 化为完整 AgentRef** → 写入 message.sender.agent.ref。**存储永远是完整 struct**（无歧义）。

### 2.2 别名解析优先级

| 优先级 | 形式 | 解析 |
|---|---|---|
| 1 | sessionId（ULID 形如 `01K...`） | 直接命中 session_store |
| 2 | `"parent"` | sub-agent 专用：取自 caller.parentSessionId |
| 3 | `"squadchat"` | squad 内固定别名：caller squad 的 SquadChat session |
| 4 | `"leader"` | squad 内固定别名：caller squad 的 leader session |
| 5 | 角色 name | squad 内 RoleSpec.name 唯一查找 |

冲突时（如 LLM 写 sessionId 同时给了 name 但 name 错）：**sessionId 权威**，name/type 用 registry 真实值覆盖；记 warning。

### 2.3 跨 squad / 顶层 standalone

- **跨 squad 寻址**：当前**不支持**（一个 agent 只跟自己 squad / 自己 parent 通信，拓扑硬约束）。将来如需，加 squadId 前缀（待定）。
- **standalone session**（顶层非-squad）：reachable_agents 为空，无 a2a 对端。

---

## 3. reachable_agents（曾名 reachable_peers）— [v0.0.56] 改读 SessionKind

每次 prompt assemble 时由 context engine 动态构建并注入。**按 caller SessionKind 派生**：

| caller SessionKind | reachable_agents 列表 | 备注 |
|---|---|---|
| **derivation='subagent'** | `[parent]` | 仅 parent，拓扑硬约束（multi_agent） |
| **role='squad'**（SquadChat） | `[leader, ...all mates]` | 群聊路由对端 |
| **role='leader'** | `[squadchat, ...all mates]` | 协调 |
| **role='mate'** | `[squadchat, leader, ...peers]` | 含同 squad 其他 mate（peer 协作 Q2）+ 自己派的 sub-agent（agent 工具内对接）。mate（B 方案：原 member，避免与 squad member entity 名撞） |
| **role='rocky', derivation='main'** | `[]` | 顶层独立 session 无 a2a 对端 |

**重要约束**：**user 不在任何 reachable_agents 列表里**——agent ↔ user 不走 send_message（user 在每个 session UI 旁；agent 想答 user 出 final text，agent 想主动找 user 看 §1 群聊路径）。

**板块格式**（注入 system message）：
```
[Reachable agents — you can `send_message` to:]
- leader: <leaderName> (sessionId: <id>)
- members: <m1Name> (id1), <m2Name> (id2), ...
- squadchat: SquadChat (sessionId: <id>)
（sub-agent 场景仅 parent；standalone 场景为空）
```

- **不持久化到 RoleSpec**——团队人员变动（hire/bench/edit）下次 assemble 即生效。
- 注入位置：作为 system_prompt 的固定 section（每次重组），或作为 system reminder 高频更新（参考 v0.0.22 prompt builder section 体系）。

---

## 4. 回复规则与 needReply（消息从哪来到哪去）

### 4.1 回复方向 = 消息来源方向

agent loop 处理 inbox 一条消息时（伪代码）：

```
switch (message.sender.source):
  case "agent":  // a2a 消息
    回复方式 = send_message(to = sender.agent.ref, ...)
    必须回吗？= sender.agent.needReply === true
  case "user":
  case "system":      // heartbeat / cron / reminder
  case "approval":
    回复方式 = 在当前 session 内出 final text（user/触发者在该 session UI 看见）
    必须回吗？= 由 LLM 业务判断（user 通常需回；heartbeat tick 可静默；reminder 看情形）
```

### 4.2 needReply 字段语义（发送方决定，透传给接收方）

> **[v0.0.68 R5]** `send_message` 工具的 needReply 从「★ 必填」改可选 + `default:true`（schema required 移出 + properties.needReply 加 `default:true` + normalize `?? true` 兜底）。引擎层 default-fill 通用机制见 `specs/tech/agent/tools/[P0]tool_execution_engine.md §4.1`。下表「LLM 显式填」语义不变；缺省 = 视为 true（符合「通常需回复」语义）。

| 发送场景 | needReply | 接收方应做 |
|---|---|---|
| `spawn_agent(mode="sync")` 首任务 | **系统硬填 false** | subagent 完成 → 把结果写进 final answer → spawn_agent 通过 `await run.promise` 取 `RunResult.answer` 作返回值；**不调 send_message 回** |
| `spawn_agent(mode="async")` 首任务 | **默认 true**（LLM 可显式覆盖为 false） | subagent 完成 → `send_message(to=parent.agent.ref)` 回报；**LLM 未回时系统代发兜底**（见下「系统代发兜底」） |
| `send_message` 提问 / 协作（[v0.0.68] 缺省 = true） | LLM 显式填 true（或省略 → default-fill 注入 true） | 接收方必须回（即便简短 ack） |
| `send_message` fyi / 通知 | LLM 显式填 false | 接收方通常不回（**MUST NOT** 被默认值覆盖——normalize `?? true` 不动 false） |

**LLM prompt 中渲染**：
```
[Message from <ref.name> (<ref.type>, needReply=true)]: <content>
```
LLM 一眼看见就知道是否要回。

**系统代发兜底（async subagent 的回报可靠性 = 代码保证，非仅靠 LLM 自觉）**：subagent 的 run 结束（`stopReason ≠ 'tool_pending'`，中断走 `onInterrupted` 同入此机制）时，若本 run drain 到 `needReply=true` 的 a2a 消息且 child 未向该 sender 回投 → 系统以 **child 身份**代发一条回报消息：成功（`no_tool_call`/`no_new_messages`）content=final text（复用 `getFinalAnswerFromStore` 读 transcript，取不到退化为结局通知文案）；失败/中断（`error`/`interrupted`/`doom_loop`/`max_iterations`）content=结局通知（stopReason + 一句原因）。代发消息 `needReply=false`（防回话风暴，成功/失败同）、`inReplyTo` 指回该 sender 最新 M.id、`sender.agent.ref.sessionId=childSid`（以 child 身份，type/name 占位由 `enrichForInbox` 反查补全）。

- **履约判定 = 判据 A（target 判据）**：查进程内 `A2aReplyTracker` 的出站投递记录——`AgentManagerImpl.deliverTo()` 成功投递后按 message 自身 sender 记 `fromSid→toSid` 最新 seq（全局单调 epoch），child run 装配时（`buildRunDeps`）快照 baseline epoch，run 收尾 `hasDeliverySince(childSid, senderSid, baseline)` 判本 run 有无履约。**成立根基 = §6 工具层硬约束「subagent 仅可达 parent」**：drain 批里的 needReply sender 实践中只有 parent，「child→sender 有无投递」是无歧义是/否 → **不依赖 LLM 自觉、不翻 transcript、不对账 inReplyTo**（inReplyTo 链因 drain reissue 新 id 断裂，精确对账属未来增强）。
- **tool_pending（HITL 悬挂）不结算**：悬挂轮无真结果（等审批续跑），未决请求 `stashPending` 跨 run 携带（take 即清防双 run 重复结算），续跑出真结果那轮才合并结算。
- **装配边界**：仅 `main && derivation='subagent'` 的 run 装配（顶层/squad/旁路 run 天然 noop）；best-effort——单 sender 投递失败不阻断 run 收尾；tracker 纯内存不持久化（崩溃靠后续 run 自然重建，最坏多代发一次不丢）。

实现：`agent/subagent-reply-fallback.ts settleAgentReplyFallback()` + `agent/a2a-reply-tracker.ts`；挂点 `agent/run-lifecycle-port.ts onRunEnd/onInterrupted`；装配 `agent/build-run-deps.ts`（见 `../agent/agent_interface_and_loop/[P0]agent_loop_unified.md §3.2`）。

### 4.3 reply 消息字段填充约定

agent 调 `send_message` 回复某条 a2a 消息时：
- `sender.agent.ref` = self.ref（发送方= 自己）
- `sender.agent.inReplyTo` = 原 message.id（thread）
- `sender.agent.needReply` = 由 LLM 当前判断（可能要追问 = true / 也可能 fyi 收尾 = false）

### 4.4 主动找 user（非回复语境）

- **单人 session**（user 当前在你 session）：直接出 final text。
- **群聊**（user 在 SquadChat session，你不在）：`send_message(to=SquadChat, needReply=false)` → SquadChat inbox 收到 a2a 消息 → **群聊 UI 直接渲染该消息**（"alice: …"）→ user 在群聊看见。**SquadChat agent 本身不需要处理该消息**（其 system prompt 已知 a2a 转发由 UI 透传；可直接 <EOS> 收尾）。

---

## 5. 消息归属 = sender.source 分流（取代旧 §3）

接收方 agent 在 prompt 中看到的"谁发的"完全由 `message.sender` 承载：

| sender.source | prompt 渲染前缀 | 接收方判断 |
|---|---|---|
| `"user"` | `[User]: <content>` | user 在本 session；想回出 final text |
| `"agent"` | `[Message from <ref.name> (<ref.type>, needReply=<bool>)]: <content>` | a2a 消息；按 4.1 / 4.2 处理 |
| `"system"` `kind="heartbeat"` | `[System (heartbeat tick)]: <content>` | 心跳激活，按 prompt rules 决定是否产出 |
| `"system"` `kind="reminder"` | `[System reminder]: <content>` | 系统提示，按需处理 |
| `"approval"` | `[Approval result]: <content>` | 用户审批回流 |

---

## 6. 工具层校验（轻量）

`send_message` 工具收到 `(caller, target, content, needReply)` 时按 caller 的 **derivation**（派生层级维度，由 session 持久化字段 `session.derivation` 派生 → `SessionKind.isSubagent`，见 `[P1]agent_tools.md §2` / `[P1]subagent_derivation.md §2`）校验：

```
sendMessage(caller, target, ...):
  if caller.kind.isSubagent:      // ★ 用 derivation（session.derivation 派生 → kind.isSubagent），非 caller.scope（已删）
    if target !== caller.parent: reject "subagent can only send to parent"
  else:                           // parent / 顶层 standalone / squad 角色
    // 本版 multi_agent 仅 parent↔subagent：非 subagent 不拦（拓扑校验留 squad 层）
    // squad 层：squad/leader/mate 按 caller.kind.role ∈ {squad/leader/mate} + squad.members 拓扑校验（mate B 方案）
  manager.deliverTo(target.sessionId, msg)   // 统一投递（enqueue + activate），只需 sessionId
```

> **[v0.0.56 hotfix 现状对齐]** 旧 `caller.scope`（session 持久化字段）已删除（v0.0.48 后实质废弃）。实现层 `app/server/src/agent/tools/send-message-tool.ts` 改读 `rtc.parentScope === 'subagent'`（parentScope = caller `kind.derivation` 经 runtime context 透传，值同 `'subagent'`/`'session'`/undefined）。校验维度权威是 **`kind.isSubagent`**（= `derivation === 'subagent'`）——`derivation` 取代了旧的 `scope` + `type='subagent'` 双字段。

- 无须 RoleSpec 字段记录可达集——动态查 caller.kind（+ squad 层补 caller.kind.role / squad.members）即可。
- 校验 = 软兜底；reachable_agents 板块（§3）已让 LLM 知道合法目标。

---

## 7. 与 prompt builder section 集成（v0.0.22）

| section 名 | 角色可见 | 内容来源 |
|---|---|---|
| `reachable_agents` | 全员（含 subagent） | 本文 §3 |
| `charter` | 仅 leader | `squad_definition.md §5` |
| `tasks`（含 source 血缘） | 仅 member | `squad_workitems.md` |
| `team_roster`（花名册） | squad / leader / member | members.yaml |
| `inbox_from_marker` | 全员 | a2a 消息渲染前缀（§5 表） |
| `reply_rules` | 全员 | §4.1 "消息从哪来到哪去 + needReply" |

---

## 8. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| AgentRef 结构 + 别名解析 + reachable_agents + 回复规则 + needReply 语义 | 本文 ✅ |
| MessageSender schema（含 sender.agent 子结构）| `agent/message/[P0]agent_message_interface.md §5` |
| send_message 工具 schema（含 needReply 入参） | `multi_agent/[P1]subagent_derivation.md §5` / `squad/[P1]squad_tools.md`（队级别工具入口） |
| spawn_agent sync 模式实现（deliverTo + run.promise） | `multi_agent/[P1]subagent_derivation.md §4` |
| 校验逻辑实现 | tool_execution_engine（send_message 工具内） |
| prompt builder section 注册 | v0.0.22 prompt builder |

> **多层引用澄清**：`send_message` 工具的**多层复用**——
> - **multi_agent 层**：本版实现，`agent` 工具家族同层提供 `send_message`（与 spawn/query/abort 一起在 agent-tool 注册时挂出，见 `[P1]agent_tools.md §1` + `[P1]subagent_derivation.md §5`）。subagent 与 parent 的 a2a 通信走此路径，**不依赖 squad_tools**。
> - **squad 层**：将来实现，squad 层的 leader/member/SquadChat 间通信会复用本文 send_message 契约 + 校验（§6）；届时 `squad/[P1]squad_tools.md` 会引用本文，不重复定义。
> - 本版 squad 层未实现 → multi_agent 的 send_message 由 agent 工具家族（agent-tool.ts:runSendMessage）独立提供；a2a §6 校验逻辑（caller.type 派生）对 multi_agent 场景同样适用（subagent 仅可达 parent 的硬约束已在该校验中）。

---

## 9. 待定

- 角色 `name` 字段唯一性（squad 内）强约束实现层 + 命名冲突报错。
- `reachable_agents` 大团队（10+ members）列表过长是否需要裁剪/分组。
- 跨 squad 寻址（squadId 前缀）何时引入。
