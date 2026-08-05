---
type: spec
title: Agent Inbox / Enqueue / Cancel（入队机制权威）
priority: P0
status: active
updated: 2026-07-17
since: v0.0.12
---

# Agent Inbox / Enqueue / Cancel — 入队机制权威文档

> 引用关系：
> - 主事件定义：`[P0]agent_event.md` §3/§4.3/§8/§9（`MessageEnqueued / EnqueuedMessageProcessed / EnqueuedMessageCanceled`）
> - 入口方法：`[P0]agent_manager.md` §2 `enqueue / cancel / deliverTo`
> - drain 消费：`[P0]agent_loop_eager_drain.md` §4 ① Pre-Process
> - HTTP 契约：`specs/api/overall/04-agent-session.md` §3.x
> - 与中断对照：`[P0]agent_interrupt.md`

---

## 1. Inbox 机制

**Inbox 是 session 级别的独立消息队列**，与 SessionStore（主对话 transcript）解耦：

| 维度 | Inbox | SessionStore |
|------|-------|---------------|
| 内容 | 待消费的 enqueued 条目（message + cancel） | 已 ingest 的 transcript（assistant / tool / user） |
| 生命周期 | 由 `enqueue/cancel` 写入；由 `drain` 一次性读光清空 | 永久持久化（ULID 顺序、可回放） |
| 写入者 | AgentManager.enqueue / cancel | AgentLoop（drain 后 ingest）/ abort api 收尾 |
| 读取者 | AgentLoop drain | LLM context assemble / 前端 messages 查询 |
| 触发 LLM | ❌（仅排队） | ✅（assemble 后送 LLM） |

**为什么独立**：
1. enqueue 不应触发持久化（用户可能改主意 cancel） — inbox 不写主 store，drain 时再决定是否 ingest。
2. cancel 不需要修改 transcript — 只在 inbox 内配对作废即可。
3. drain 是 loop 的入口，inbox 是它的"输入缓冲"，与 transcript（已确定的历史）天然不同。

**life-cycle 概览**：

```
[enqueue] ─→ inbox.append(message)  ─┐
[cancel]  ─→ inbox.append(cancel)  ─→│─→ [drain]（agent_loop ① Pre-Process）
                                      │     ├─→ 同批 message+cancel 配对 → 作废 + emit canceled
                                      │     └─→ 无 cancel 的 message → 正常 processed + ingest 到主 store
                                      │
                                  inbox 被 drain 清空
```

---

## 2. InboxEntry 类型

inbox 条目是联合类型（定义在 `[P0]agent_manager.md` §5 实现细节）：

```typescript
type InboxEntry =
  | { enqueueId: string; kind: "message"; message: Message; enqueuedAt: string }
  | { enqueueId: string; kind: "cancel"; cancelFor: string; enqueuedAt: string };
```

- **`kind: "message"`**：常规入队消息（`AgentManager.enqueue` 写入）。`message` 字段携带真身 Message（含 content/role/sender）。
- **`kind: "cancel"`**：取消信号（`AgentManager.cancel` 写入）。
  - `cancelFor: enqueueId` —— 指向被取消的原 message 的 enqueueId。
  - **不是对话 Message**（不进主 store、不参与 assemble），仅作 drain 时的「作废信号」。
  - 与原 message 条目**同存 inbox**（同 enqueueId 的 message 条目和 cancel 条目都在 inbox 里，等待同批 drain）。
- **`enqueuedAt: string`（isoDate）**：条目 append 时由 inbox 注入（ULID 分配同步），表示「进 inbox 的时刻」。message 条目和 cancel 条目各自独立分配。

> **[v0.0.31·代码已落地]**：spec + 代码均已含 `enqueuedAt`（§2）。`app/server/src/agent/inbox.ts` `InboxEntry` 联合两变体均带 `enqueuedAt: string`；`InboxStore.append` / `appendCancel` 注入 `new Date().toISOString()`（append 整批共享同一时刻）。UT/AT 校验落库条目含 enqueuedAt（isoDate 格式）。

---

## 2.5 inbox 入口 enrich（a2a 上下文中枢 · 入口侧）

> inbox 是 a2a 上下文中枢：**入口 enrich（normalize 补全完整 a2a 形态）** + 出口消费（drain 透传 sender.agent + prompt 渲染前缀）。本节定义入口侧。

**位置**：`AgentManager.deliverTo(sessionId, message)` 内部、`enqueue` 之前（所有进 inbox 的 a2a message 必经此步）。`deliverTo` 是 a2a / 外部给 session 发消息的统一入口（见 `[P0]agent_manager.md §2 deliverTo`），所有进入 inbox 的 a2a message 都经此路径。

**职责**：对 `sender.source === 'agent'` 的 message normalize——确保 sender.agent 形态完整（type/name 反查发送方 session record 补全 + needReply 必填 + inReplyTo 透传）；调用方传了 type/name 则用反查结果校验，不一致 warn 不阻断。

**本质（程序构造性）**：enrich 是**程序构造 sender 信封**的环节——sender 信封由程序组装、非 LLM 构造（见 `[P0]agent_message_interface.md §5` 程序构造性原则），程序在 deliverTo 投递时补全 type/name，完全程序内控制。LLM 入口（`agent.spawn`/`send_message`）只传 AgentRef + 工具入参，sender 由程序组装。

### 2.5.1 enrich 函数签名

```typescript
/**
 * inbox 入口 enrich：对 source='agent' 的 message normalize（a2a 形态补全）。
 * - sender.source !== 'agent' → 原样返回（user/system/approval 无 agent 子结构，判别联合保证）
 * - sender.source === 'agent' → 校验 + 补全 sender.agent.ref（sessionId 路由权威；type/name 反查发送方 session record）
 *
 * @param message  待入队的 message（可能 sender.agent.ref 不完整：仅 sid 无 type/name）
 * @param store    SessionStore（反查发送方 session record 用）
 * @returns normalize 后的 message（enrich 完成后送 enqueue）
 * @throws Error 当 source='agent' 且 sender.agent.ref.sessionId 缺失（路由权威不可缺失）
 */
async function enrichForInbox(
  message: Message,
  store: SessionStore,
): Promise<Message>
```

### 2.5.2 enrich 逻辑（伪代码）

```
enrichForInbox(message, store):
  if message.sender?.source !== 'agent':
    return message                                   // user/system/approval 不 enrich（判别联合保证无 agent 子结构）

  agent = message.sender.agent                       // 窄化后必有（判别联合 source='agent' → agent 必填）
  ref = agent.ref

  // ── 路由权威：sessionId 必填 ──
  if !ref.sessionId:
    throw Error("enrich: source='agent' but sender.agent.ref.sessionId missing (route authority)")

  // ── 反查发送方 session record ──
  senderSession = await store.getSession(ref.sessionId)
  if !senderSession:
    throw Error(`enrich: sender session not found: ${ref.sessionId}`)

  // 反查补全 type（按发送方 session.type；顶层 standalone type=undefined → 'session'）
  expectedType = mapSessionTypeToAgentRefType(senderSession.type)  // subagent→'subagent'; undefined→'session'; 'leader'/'mate'/'squad' 同名（[v0.0.33.1] member→mate）
  // 反查补全 name（req2.md §5 name 规则）
  expectedName = deriveAgentRefName(senderSession)                 // subagent→subAgentTemplateType; parent/顶层→session.title || 'parent'

  // ── 防幻觉契约：调用方传了 → 校验 warn 不一致；没传 → 反查补全 ──
  finalType = ref.type
  if ref.type:
    if ref.type !== expectedType:
      logger.warn(`enrich: sender.agent.ref.type mismatch (caller=${ref.type}, actual=${expectedType}); using actual`)
    finalType = expectedType                          // 反查结果覆盖（sessionId 权威原则延伸：type/name 不参与路由，以反查为准）
  else:
    finalType = expectedType

  finalName = ref.name
  if ref.name:
    if ref.name !== expectedName:
      logger.warn(`enrich: sender.agent.ref.name mismatch (caller=${ref.name}, actual=${expectedName}); using actual`)
    finalName = expectedName
  else:
    finalName = expectedName

  // ── needReply：a2a 必填（调用方未填 → error；enrich 不补默认值，由调用方按场景定）──
  // 注：spawn sync/async 首任务的 needReply 在 buildFirstTaskMessage 阶段已定（spawn-action.ts:184）；
  //     send_message 工具的 needReply 由 LLM 必填（send-message-tool.ts:36 inputSchema required）。
  //     enrich 只校验「已存在」不补默认——保持调用方责任清晰。
  if typeof agent.needReply !== 'boolean':
    throw Error("enrich: source='agent' but sender.agent.needReply missing (required for a2a)")

  // ── inReplyTo：可选（thread 线索；首任务无 parent message 不填）──
  // enrich 不干预，原样透传

  // ── 返回 normalize 后的 message ──
  return {
    ...message,
    sender: {
      ...message.sender,
      agent: {
        ref: { type: finalType, sessionId: ref.sessionId, name: finalName },
        needReply: agent.needReply,
        ...(agent.inReplyTo ? { inReplyTo: agent.inReplyTo } : {}),
      },
    },
  }
```

### 2.5.3 name 反查规则（deriveAgentRefName）

| 发送方 session.type | name 取值 | 示例 |
|---------------------|----------|------|
| `subagent` | `session.subAgentTemplateType`（如 "explorer"）；为空 → `"subagent"` | `"explorer"` |
| `undefined`（顶层 standalone parent）/ 其他 | `session.title`；无标题 → `"parent"` | `"探查代码任务"` / `"parent"` |

**约束**：
- name = 渲染用人类可读字段，**不参与路由**（路由只靠 sessionId）。
- **不要求全局唯一**（唯一性靠 sessionId）。
- **不取 sessionId 片段**（如 `01K...` 前缀）——必须是人类可读语义。

### 2.5.4 source='user' / 'system' / 'approval' 不 enrich

判别联合（见 `agent_message_interface §5`）保证：`source !== 'agent'` 的 sender 无 agent 子结构。enrich 函数对这些 source **原样返回**，不补任何 agent 字段。这是 type 层钉死防「user 消息误读 needReply」的关键。

### 2.5.5 出口消费（drain 透传 + prompt 渲染）—— A 的对偶

入口 enrich 完成后，**drain 必须透传 sender.agent 给消费者**（agent_loop ① Pre-Process → prompt assemble）：

| 环节 | 现状 | v0.0.31 要求 |
|------|------|-------------|
| drain（`agent-loop-stage-pre.ts:74`） | 只读 `entry.message.sender?.source` 做 user/非 user 分流，**丢弃 sender.agent** | drain 透传完整 sender（含 agent）给 ingest；newMessages 携带原始 sender，不重新构造 |
| prompt assemble（context-engine / assemble-pipeline） | messages 按 role 直送 LLM provider，**零渲染 sender 前缀** | 新增 `inbox_from_marker` section（a2a_protocol §5）：对 `sender.source='agent'` 渲染 `[Message from <name> (<type>, needReply=<bool>)]: <content>`；user→`[User]:`；system→`[System (<kind>)]:`。详见 `[P1]a2a_protocol.md §5` |

> **drain 透传约束（代码已落地）**：`drainAndPartition`（agent-loop-stage-pre.ts）`toMessageInput(entry.message)` 透传整个 message（含 sender）；`userMessages`/`processed` 路径对 sender.source !== 'user' 的 message 重新生成 messageId（接收方 session 落新 id，不复用发送方 session 的 id）——messageId 重写保留，sender 字段透传不丢（不重新构造 sender）。prompt assemble 阶段从落库的 message 读 sender 渲染前缀。

---

## 3. enqueue 消息（写侧）

```typescript
// 旧签名（v0.0.31 去 config 重构后改为 sessionId；详见 [P0]agent_manager.md §2）
AgentManager.enqueue(sessionId: string, messages: Message[]): Promise<string[]>
```

**单元**：
1. `InboxStore.append(sessionId, messages)` 为每条消息分配 enqueueId（ULID）+ 注入 `enqueuedAt`（§2），写入 inbox（**不写主 store**）。
2. 逐条 `bus.emit("session_id:<sid>_amt:current", message_enqueued)`（带 enqueueId + 完整 content + sender.source）。
3. 返回 enqueueId 数组（与 messages 等长、同序）。

**deliverTo 链路 enrich 位置（a2a 必经）**：`AgentManager.deliverTo(sessionId, msg)` 内部调用顺序为 `enrichForInbox(msg, store)` → `enqueue(sessionId, [enriched])` → `activate(sessionId)`。enrich 在 enqueue 前，确保落库 inbox 的 message 形态完整（见 §2.5）。

**特点**：
- enqueue 不触发推理（仅排队）—— 调用方可批量 enqueue 后单次 activate。
- enqueue 可在 session 任何状态调用（idle / running / interrupting）：
  - idle: 排队等 activate。
  - running: loop 下一轮 drain 自动消费。
  - interrupting: 排队等 abort 收尾完成后新 loop drain。

**`message_enqueued` 事件**（详见 `[P0]agent_event.md §4.3`）：

```
{ type: "message_enqueued", enqueueId, role, content, source }
```

前端 enqueue view 据此渲染待处理项。`source` 来自 `message.sender.source`（user/agent/system/approval）。

---

## 4. enqueue cancel（写侧）

```typescript
AgentManager.cancel(sessionId: string, enqueueId: string): Promise<void>
```

**核心约束**：**cancel 不是删除 inbox，而是 enqueue 一条「cancel 消息」到 inbox**（design 板块 3.4）。

**为什么不删 inbox**：
1. inbox 与 SessionStore 主对话 store 解耦——删除 inbox 需要新的「按 enqueueId 删条目」API，引入并发风险（drain 与 cancel 竞争）。
2. enqueue cancel 消息复用现有 inbox append + drain 通路，**原子性自然**（同批 drain 一起判定，无需加锁）。
3. cancel 条目本身无害（不是对话 Message，drain 时自然丢弃）。

**调用细节**（v0.0.13 同步移除 + v0.0.15 简化路径，见 §6）：cancel 实际是「同步 removeMessage 尝试 + appendCancel 兜底」两步。详见 §6 竞态表。

---

## 5. 三事件生命周期（建 | 终结）

一条 enqueued message 的生命周期：

| 事件 | 时机 | 副作用 | 客户端行为 |
|------|------|--------|-----------|
| `message_enqueued`（**建**） | AgentManager.enqueue 同步 emit | 分配 enqueueId、写入 inbox | enqueue view 新增项 |
| `enqueued_message_processed`（**正常终结**） | drain 时该 message **无配对 cancel** | 生成 messageId、ingest 主 store、进对话流 | 从 enqueue view 移除，关联 messageId |
| `enqueued_message_canceled`（**取消终结**） | drain 同批 message + cancel（同 enqueueId） **或** AgentManager.cancel 同步移除（v0.0.13） | 不生成 messageId、不写主 store、不进对话流 | 从 enqueue view 移除 |

**互斥**：同 enqueueId 的 `processed` 与 `canceled` **只可能到达其一**（drain 时二选一判定 / 同步移除路径 emit canceled 后 message 已不在 inbox）。前端收到任一都按 enqueueId 移除 enqueue view 条目（已乐观移除则无操作）。

---

## 6. drain 侧 cancel 配对（消费语义）

`AgentLoop` ① Pre-Process drain 流程的**详细伪代码与 ①②③④ 编排见 `[P0]agent_loop_eager_drain.md §4 ①`**。本节聚焦 inbox/cancel 的消费语义。

**消费语义**：drain 是一次性读光 inbox 并清空（per-session 锁内）；同批 message+cancel 在内存中配对判定。

```
drain inbox（加锁读取全部 message + cancel 条目）→ 清空 inbox → 解锁

cancel 配对判定（原子，本批内一次性完成）：
  1. 扫本批所有 cancel 条目，建 cancelSet = Set<cancelFor 集合>
  2. 逐条处理 message 条目：
     if (message.enqueueId ∈ cancelSet):
       → 作废：不生成 messageId / 不 ingest / 不 emit processed
       → emit enqueued_message_canceled（enqueueId）
     else:
       → 正常 processed：**重新生成 messageId=ulid()**（不论 source=user/agent/system/approval，与 §6.4 对称）
         → emit message_* + emit enqueued_message_processed(enqueueId, newId, role) + ingest 用新 id
  3. cancel 条目本身在判定后丢弃（不进任何 store）

assemble → ...
```

> **[v0.0.161]** user query 分支从「保留原 id + emit message_* + emit enqueued_message_processed + ingest 原消息」改为「与 agent/system/approval 对称化：**reissue messageId=ulid()** → emit message_* + emit enqueued_message_processed(enqueueId, newId, role) → ingest 用新 id」。write-in 时刻（POST /messages / channel plugin）分配的 id 是 throwaway 占位（inbox schema 非空约束），drain 时被丢弃。详见 §6.4 msgId 分配契约。

**原子性**：cancel 配对判定在本批 drain 内一次性完成（inbox 已被 drain 清空，无需加锁/删除）。同一批读到的 message+cancel 一起判；不同批的不冲突（前批已 processed 的 message，后批的 cancel 找不到配对 → 丢弃）。

### 6.1 cancel 同步移除路径（v0.0.13 引入 / v0.0.15 简化）

**问题（v0.0.12 原路径）**：纯 appendCancel + drain 配对在真 LLM 下有竞态——agent_loop 处理速度快，
`POST /cancel` 到达 inbox 前 message 可能已被 drain 消费（cancel 来晚 → drain 找不到配对 →
cancel 条目无害丢弃，但 message 已落库）。这破坏 cancel 核心语义（让排队消息不要被处理）。

**v0.0.13 修复**（`AgentManager.cancel` 增强为两步，**v0.0.15 保留此 T1 核心修复**）：
1. **同步移除**：`inbox.removeMessage(sessionId, enqueueId)` 同步从 inbox 移除对应 message 条目。
   - 移除成功（message 还在 inbox，cancel 早于 drain）→ 立即 `emit enqueued_message_canceled` → 返回。
   - 移除失败（message 已被 drain 消费 / 不存在）→ 走第 2 步兜底。
2. **drain 兜底**：`inbox.appendCancel(cancelFor=enqueueId)` 追加 cancel 条目。若 message 已被
   同步移除，drain 时 cancel 找不到配对自然丢弃（幂等无害）；若 message 还在 inbox（理论上不会，
   因第 1 步已移除），drain 同批配对作废（v0.0.12 路径）。

**v0.0.15 简化**：移除 v0.0.13 引入的 `POST /messages` body.cancelEnqueueId 原子参数（多余概念），
cancel 统一走专用端点 `POST /session/:id/messages/:enqueueId/cancel` → `AgentManager.cancel`。
AT 测试用 `POST /messages` body 的 `activate=false`（**NODE_ENV=test 守卫**）构造确定性 inbox 队列
（q1/q2 留 inbox 不被 drain），cancel POST 在任何时序下都能命中仍在 inbox 的 q1——配合同步移除
保证 cancel 早于 drain。生产 cancel 走同端点（用户在 enqueue view 点取消按钮）。

**效果**：cancel 在任何时序下都生效——要么同步移除立即 emit canceled，要么 message 已 processed
（前端已收 processed 移除 enqueue view）。两条路径互斥，`enqueued_message_canceled` 与
`enqueued_message_processed` 只到达其一（幂等保证不变）。

### 6.2 幂等 / 竞态表

| 竞态场景 | 行为 | 事件 | 前端 |
|---------|-----------|------|------|
| cancel 早于 drain（message 还在 inbox） | **同步移除** message 条目 + 立即 emit canceled | `enqueued_message_canceled` | 按 enqueueId 移除 |
| cancel 晚于 drain（message 已 processed） | removeMessage 返 false → appendCancel 追加 cancel 条目 → 下轮 drain 找不到配对丢弃 | 无事件（message 已 emit processed） | 已按 processed 移除（幂等） |
| message + cancel 同批 drain（v0.0.12 路径，理论上 removeMessage 已先行） | drain 配对作废（兜底） | `enqueued_message_canceled` | 按 enqueueId 移除 |
| 同 enqueueId 多次 cancel | 首次同步移除生效；后续 removeMessage 返 false → appendCancel 幂等 | 仅首个 emit canceled | 已移除（幂等） |

### 6.3 端到端调用链

```
[前端] enqueue-view 点 enqueue-item-{enqueueId}-cancel
    ↓ [v0.0.97] x 立即转圈（component-enqueue-view 本地 canceling Set，1s 恢复，转圈期禁点；不进 store）
    ↓ POST /session/:id/messages/:enqueueId/cancel（fire-and-forget）
[server] SessionHandler → AgentManager.cancel(sessionId, enqueueId)
    ↓ inbox.removeMessage（同步尝试）→ 命中则立即 emit canceled
    ↓ 否则 inbox.appendCancel（兜底）→ 返 202
    ↓ ... 等待 agent_loop 下一轮 drain ...
[agent_loop] ① Pre-Process drain
    ↓ 同批读到 message（enqueueId）+ cancel（cancelFor=enqueueId）
    ↓ message 作废（不生成 messageId / 不 ingest / 不 emit processed）
    ↓ emit enqueued_message_canceled（enqueueId）
[前端] SSE 收 enqueued_message_canceled → reducer 按 enqueueId 移除（队列移项唯一真相源 = SSE，不乐观移除、不进 store）
```

### 6.4 msgId 分配契约（v0.0.161 — enqueueId ↔ msgId 严格独立）

> **v0.0.161 bug 根因**：drain 时 user 分支保留 write-in 时刻的 throwaway id，其他分支 reissue drain 时刻 ulid。user msg 的 id 时钟锚在 HTTP-in，其他消息的 id 时钟锚在 drain——**transcript 按 id 升序排列时 user msg 位置错乱**（早入队 late-drain 的 user id < 上一 run 末尾 assistant id）→ context assemble 按 id 切割时该 user msg 落在切割点之前被永久漏掉，从此不进 LLM context。修复：user 分支也 reissue → 单调化到 drain 时钟。

**三条 invariant**（drain 必守）：

- **I1（严格独立）**：`enqueueId` 与 `messageId` 是**两个独立 ULID**——
  - `enqueueId` = **inbox 队列 key + UI 排队感知 key**（inbox append 时分配；`GET /inbox` 返、`message_enqueued`/`enqueued_message_processed`/`enqueued_message_canceled` SSE 携带；供前端 enqueue-view 定位排队项）。
  - `messageId` = **transcript key + LLM context key**（drain 时刻 `ulid()`；进 `SessionStore.appendMessages`；供 assemble/reducer/logical-view/observability 锚定）。
  - 二者语义不同、生命周期不同（enqueueId 在 emit canceled/processed 后 UI 移项即完；messageId 落库随 transcript 永存），一消息 = 两 ID。

- **I2（write-in 时刻 msgId 是 throwaway，不外泄）**：
  - `POST /session/:id/messages` 分配的 `msgId` 只为满足 inbox schema 非空约束——**HTTP 响应仅返 `{runId, enqueueId}` 不含 msgId**。
  - `message_enqueued` SSE 事件 payload 为 `{type, enqueueId, role, content, source}`——**不带 msgId 字段**（源码 `agent-manager.ts::emitMessageEnqueued`）。
  - `GET /session/:id/inbox` 返 `InboxItemView = {enqueueId, content, enqueuedAt}`——**不带 msgId 字段**（§10.2）。
  - feishu / 其他 channel plugin 入口构造 message 时分配的 msg.id 同样是 throwaway，drain 时被 reissue（与 POST /messages 路径一致）。

- **I3（drain 后 msgId 通过 emitEnqueuedProcessed 通知 UI）**：drain 里所有正常 processed 分支（user/agent/system/approval）产出 `newId=ulid()`，通过 `emitEnqueuedProcessed(enqueueId, newId, role)` 事件外泄给前端建立 `enqueueId ↔ msgId` 映射（agent/system/approval 分支早已在跑此路径，v0.0.161 起 user 分支同轨）。前端 enqueue-view reducer 收到 `enqueued_message_processed(enqueueId, messageId, role)` 移除该 enqueue 项，同时把 messageId 归属到即将/已到达的 transcript message 上。

**代码定位**：
- drain 侧对称化 reissue：`app/server/src/agent/agent-loop-stage-pre.ts::drainAndPartition` line 124-152（user 分支 line 124-139 三处 push（userMessages/processed/newMessages）用同一 `newId`；agent/system/approval 分支 line 140-152 同 newId 三处一致）。
- HTTP-in 时刻的 throwaway msgId：`app/server/src/handlers/session-messages.ts` line 228-235（分配 msgId 满足 inbox schema，不进响应体）。
- channel-in 时刻的 throwaway msgId：`app/plugins/builtins/feishu/feishu-channel.ts` line 265 附近（sender.source='user' 消息构造，走同一 drain reissue 路径）。
- `emitEnqueuedProcessed` emit：`app/server/src/agent/agent-loop-emitters.ts::emitEnqueuedProcessed(ctx, enqueueId, messageId, role)` line 174-187。

**tool_reply 分支例外**：source='tool_reply' 消息在 drain 独立分流（agent-loop-stage-pre.ts line 114-123），不入 userMessages/systemMessages/newMessages（不作为 transcript 条目 ingest）；其 message.id 通过 `emitEnqueuedProcessed(enqueueId, entry.message.id, role)` 通知前端完成占位 block 编辑归属（INV-6，见 `../message/[P0]agent_message_interface.md §7`）。tool_reply 的 message.id **不 reissue**（编辑既有占位而非追加新 message，id 无 ordering 依赖）。

---

## 7. 与 abort 的区别

| 机制 | 作用对象 | 触发者 | 执行者 | 副作用 |
|------|---------|--------|--------|--------|
| **cancel**（本文档） | 排队中尚未被消费的 enqueued message | 用户点 enqueue-item 取消按钮 | AgentManager.cancel（同步移除 + drain 配对兜底） | message 作废（轻量：未 ingest、未写主 store、未进对话流） |
| **abort**（见 `[P0]agent_interrupt.md`） | 正在进行的 run（可能已 emit 部分事件、已 ingest 部分消息） | 用户点 chat-abort 按钮 | AgentManager.abort（4 步收尾：persist half-data / 补 interrupted message / clearReplay / emit run_stop） | run 终止 + half-data 持久化（重量：需补 interrupted tool_result、重组 partial message） |

cancel 处理「未开始」的消息（仅在 inbox）；abort 处理「进行中」的 run（已部分进入主 store）。两者正交。

---

## 8. 测试覆盖要点

- **UT**：
  - drain 同批 message+cancel（同 enqueueId）→ message 作废（不生成 messageId / 不 ingest）+ emit canceled；无 cancel 的正常 processed。
  - removeMessage 命中 → 立即 emit canceled 不进 drain；removeMessage 未命中 → fallthrough 到 appendCancel。
- **AT（黑盒 API）**：running 时发 2 条 → `POST /session/:id/messages/:enqueueId1/cancel`（202）→ drain 后第 1 条 emit canceled 不落库、第 2 条正常 processed 落库 → `GET /session/:id/messages` 断言只有第 2 条。
- **ET（黑盒 E2E）**：run 中发 2 条 → 点第 1 条 `enqueue-item-{enqueueId1}-cancel` → [v0.0.97] x 转圈 → SSE 到达后该项消失 → 第 2 条处理后入对话区；第 1 条不出现。

---

## 10. 前端只读 API：GET /session/:id/inbox（v0.0.97 新增）

> enqueue view 队列状态唯一真相源 = **GET /inbox（seed）+ SSE `message_enqueued`/`enqueued_message_processed`/`enqueued_message_canceled`（增量）**（INV-1）。POST /messages 响应、cancel POST 响应都不进前端 reducer（多端一致性 INV-5）。

### 10.1 为什么需要 GET /inbox

inbox **非 sticky**（无 SSE replay，drain 一次性清空）。切到某 running session 时，新订阅者从空开始 → 看不到该 session inbox 中既有排队项。GET /inbox 提供只读快照，让前端 `useMessages` onInit 在 GET /messages 之后 seed `enqueueItems`——与「GET /messages 拉 transcript 基线」一致性原则对齐（切到任何 session 都看到该 session 真实状态）。

### 10.2 端点契约

详见 `specs/api/overall/04-agent-session.md §3.5`。要点：
- `GET /session/:id/inbox` → `200 { items: InboxItemView[] }`
- `InboxItemView = { enqueueId, content: ContentBlock[], enqueuedAt }`（content 与 `message_enqueued` SSE 同形，INV-2）
- 过滤 `kind:'message'`（cancel 条目是 drain 内部信号，不暴露）
- 按 `enqueuedAt` 升序；只读无副作用（不 drain / 不 emit / 不锁）
- handler 浅拷贝快照 `[...peek]` 防 drain `splice(0)` 改已返引用（peek 返直接引用，见 §10.3）

### 10.3 peek 快照语义（O1 裁决）

`InboxStore.peek(sid)` 返**直接引用**（`this.buckets.get(sid) ?? []`）；`drain` 用 `bucket.splice(0)` **改同一数组**。若 GET handler 返直接引用 + drain 并发执行 → 已返数组的元素被清空。**裁决**：GET handler 浅拷贝 `[...peek]` 在调用时刻快照，**不改 `peek` 本身**（peek 既有 normal-mode 外层循环 live-ref 调用方依赖实时视图）。

### 10.4 前端消费链（useMessages onInit，subscribe-first D8）

```
onInit(sessionId):
  1. subscribe('agent_loop', ...) + subscribe('session_panel', ...)     ← MUST 在 GET 前（D8）
  2. GET /messages?limit=50 → seed ctx.messages
  3. GET /inbox → items.map({ enqueueId, content: contentBlocksToPreviewText(it.content) }) → seed ctx.enqueueItems
     （GET /inbox 失败 → enqueueItems 降级空，不阻塞主对话流）
  4. return { ctx, buffer }
```

**幂等**：GET /inbox seed 后，SSE `message_enqueued`（同 enqueueId）到达时 reducer `some(enqueueId)` 去重（chat-slice-reducer.ts:336），GET seed 与 SSE 增量不双计。

**切 session**：useLifecycle deps 变（sessionId 变）→ onDestroy 旧订阅 → onInit 重走双 GET + subscribe → 新 session enqueueItems 从该 session inbox 快照重新 seed（不残留旧 session 的）。

### 10.5 队列真相源总结（v0.0.97 INV-1/INV-5）

| 操作 | 是否驱动 enqueueItems | 说明 |
|------|----------------------|------|
| GET /inbox（onInit seed） | ✅ 加项（初始） | 切 session 时拉该 session inbox 快照 |
| SSE `message_enqueued` | ✅ 加项（reducer 幂等去重） | 后端 enqueue 同步 emit |
| SSE `enqueued_message_processed` | ✅ 移项（reducer 按 enqueueId） | drain 正常消费 |
| SSE `enqueued_message_canceled` | ✅ 移项（reducer 按 enqueueId） | cancel 同步移除 / drain 配对作废 |
| POST /messages 响应 `{runId, enqueueId}` | ❌ 不进 reducer | 仅关联 run；enqueueId 不用于 UI（向后兼容 INV-6） |
| cancel POST 响应 | ❌ 不进 reducer | fire-and-forget；移项靠 SSE |
| 本地 `canceling: Set` | ❌ 不进 store/ctx | component-enqueue-view 瞬态反馈（x→转圈），INV-3 |


## 9. （版本史见 `log.md`）