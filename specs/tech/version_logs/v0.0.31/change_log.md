# v0.0.31 Tech Change Log — a2a 协议对齐（inbox 中枢 + AgentRef 上下文兑现）

> version: 1.0 · 2026-06-28
> 范围红线（严守）：**只 multi_agent a2a 协议对齐**（parent↔subagent）。严禁碰 squad 层（leader/member/SquadChat 未实现）；不引入跨 squad 寻址；heartbeat/cron/reminder 仅 enum 对齐（投递逻辑后续）。
> 权威输入：PRD `specs/prd/version_logs/v0.0.31/change_log.md`；需求 `reqs/v0.0.31/req2.md`。
> 概念权威源：`[P1]a2a_protocol.md`（§2 AgentRef / §4 needReply / §5 渲染前缀）+ `[P0]agent_inbox_enqueue.md`（§2 InboxEntry / §2.5 enrich）+ `agent/message/[P0]agent_message_interface.md §5`（判别联合）+ `[P0]agent_manager.md`（§2 deliverTo / §2.3 resolveConfigBySid / §2.4 调用方清单）+ `[P1]subagent_derivation.md §4.1`。

---

## 1. 概述

本版本交付 **a2a 通信协议的上下文兑现**：让 inbox 成为 a2a 上下文中枢——**入口 enrich（normalize 补全完整 a2a 形态）** + **出口消费（drain 透传 sender.agent + prompt 渲染前缀）**；`deliverTo` 彻底去 config（agent_manager 重构）；user POST 收敛 deliverTo；MessageSource enum 对齐 spec；inbox 补 `enqueuedAt`；sender 改判别联合。

**spec 层全链已落地**（本版架构产出）；**代码同步在本版编码阶段执行**（每处 spec 标「代码待同步」）。

---

## 2. 文件变更清单

| 文件 | 操作 | 核心变更 |
|------|------|---------|
| `specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md` | 修改 | §2 InboxEntry 标 `enqueuedAt` 代码待同步；**§2.5 新增「入口 enrich」章节**——`enrichForInbox(message, store)` 签名 + 伪代码 + name 反查规则（deriveAgentRefName）+ 防幻觉契约（caller 传了校验 warn / 没传反查补全 / sessionId 路由权威必填 / needReply a2a 必填）；§2.5.5 出口消费（drain 透传 sender.agent + inbox_from_marker section 渲染前缀）；§9 版本 bump 2.2 |
| `specs/tech/agent/message/[P0]agent_message_interface.md` | 修改 | §5 `MessageSender` 从「optional 子结构 + 文档约束」**升级为严格 TS 判别联合**（按 source 分流，4 变体：user/agent/system/approval）；`MessageSource` enum `'scheduled'` → `'system'`；定夺结论 + 理由 + 同步清单（types.ts / user POST handler / agent_event §4.3 / emit message_enqueued）+ 历史注；修 enrich 交叉引用 §3.1→§2.5 |
| `specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md` | 修改 | §2 `enqueue(sessionId)/activate(sessionId)/deliverTo(sessionId, msg)` 去 config 新签名；§2.3 新增 resolveConfigBySid（**方案 A**：无 cache，复用 bootstrap.ts:300 setResolveConfig）+ 方案选型对比表（A 采纳 / B 备选）+ 内部获取伪代码；§2.4 调用方改动清单（user POST / deliverTo 内部 / ManagerChildrenOps / 心跳占位 / 测试 fixture / spawn-action / send-message-tool / forkedRun）；§3 deliverTo 链路 enrich 位置注 |
| `specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md` | 修改 | §4.3 source 行为表 `'scheduled'` → `'system'` + v0.0.31 代码待同步注（enum 对齐 + a2a enrich 后形态完整） |
| `specs/tech/multi_agent/[P1]a2a_protocol.md` | 现状化确认 | §2 AgentRef / §4 needReply / §5 渲染前缀（inbox_from_marker section）已是 v0.0.31 权威源（不需改）；本版验证 spec 与代码现状一致（drain consumer 丢 sender.agent 是代码待同步，非 spec 缺陷） |
| `specs/tech/multi_agent/[P1]subagent_derivation.md` | 修改 | §4.1 标题改「v0.0.31 spec 已落地」；[重构方向]/[收敛要求] 标 v0.0.31 已落地 + 代码待同步；§9 TBD「agent_manager deliverTo 重构」勾掉；§11 版本 bump 1.0c |
| `specs/tech/version_logs/v0.0.31/change_log.md` | 新增 | 本文件 |

---

## 3. 两个定夺结论

### 3.1 sender 改严格判别联合（discriminated union by `source`）

**定夺**：**严格 TS 判别联合**（非 optional 子结构 + 文档约束）。

**理由**：
1. PRD 诉求（needReply = a2a 专属，user/system/approval 不存在此字段）类型层钉死，防「user 消息误读 needReply」。
2. 窄化路径清晰：`if (sender.source === 'agent') sender.agent.needReply` 无歧义，TS 编译时检查。
3. inbox enrich / prompt 渲染按 source 分流的代码强类型化（compile-time 检查穷尽性）。
4. 与 ContentBlock（agent_message_interface §4.11）已是判别联合的设计风格统一。

**TS 类型表**（`agent_message_interface §5` 权威）：

```typescript
type MessageSender =
  | { source: "agent"; agent: { ref: AgentRef; needReply: boolean; inReplyTo?: string } }
  | { source: "user" }
  | { source: "system"; system: { kind: string; refId?: string } }
  | { source: "approval"; approval: { toolCallId: string; decision: "allow"|"allow_always"|"deny"; ... } };
```

- `source='agent'`：agent 子结构必填（ref + needReply 必填，inReplyTo 可选）。
- `source='user'`：只有 `{ source: 'user' }`（无任何 agent 字段）。
- `source='system'`：system 子结构（kind="heartbeat"|"cron"|"reminder"|...）。
- `source='approval'`：approval 子结构（toolCallId + decision）。

### 3.2 deliverTo 去 config 的内部 config 获取方案

**定夺**：**方案 A（务实先行）**——对外签名去 config，manager 内部每次调 `resolveConfigBySid(sessionId)` 复用 `bootstrap.ts:300 setResolveConfig` 注入的 `buildSessionConfigFromDeps`，**无 cache**。

**理由**：
1. **对外签名干净是 C 的本质目标**——enqueue/activate/deliverTo 不再要 caller 传 config，调用方改动小。
2. **改动最小**——resolveConfig 通路 v0.0.28 已铺好（bootstrap.ts:300 + agent-manager-children.ts deliverTo wrapper 已用）。
3. **无失效问题**——每次取最新 session 持久字段（provider/model/scope/subAgentConfig），session config 变更自动生效。
4. **性能可接受**——enqueue/activate 不是高频热路径；spawn a2a 已走此路径（已验证可行）。
5. **cache（方案 B）作后续优化**——subagent config 首次构建后基本不变（不动态改配置），cache 价值有限且引入失效复杂度，A 务实先行。

**方案对比**（agent_manager §2.3 完整表）：方案 B（config cache）需处理失效（session config 变更）+ 缓存一致性复杂，复杂度收益不匹配。

---

## 4. 关键设计落地（spec 层）

### 4.1 inbox 入口 enrich（`agent_inbox_enqueue §2.5`）

**位置**：`AgentManager.deliverTo(sessionId, message)` 内部、`enqueue` 之前（所有进 inbox 的 a2a message 必经）。

**函数签名**：

```typescript
async function enrichForInbox(message: Message, store: SessionStore): Promise<Message>
```

**逻辑要点**：
- `sender.source !== 'agent'` → 原样返回（判别联合保证无 agent 子结构，user/system/approval 不 enrich）。
- `sender.source === 'agent'`：
  - `ref.sessionId` 必填（路由权威，缺失 → throw）。
  - 反查 `store.getSession(ref.sessionId)` → 补全 `ref.type`（mapSessionTypeToAgentRefType：subagent→'subagent'；undefined→'session'）+ `ref.name`（deriveAgentRefName：subagent→subAgentTemplateType；parent/顶层→session.title||'parent'）。
  - **防幻觉契约**：caller 传了 type/name → 用反查结果校验，不一致 warn（不阻断）+ 用反查结果覆盖；没传 → 反查补全。
  - `needReply`：a2a 必填（缺失 → throw；enrich 不补默认值，由调用方按场景定——spawn sync 首任务系统硬填 false / async 默认 true / send_message LLM 必填）。
  - `inReplyTo`：可选，原样透传。

**name 反查规则**（deriveAgentRefName）：

| 发送方 session.type | name 取值 | 示例 |
|---------------------|----------|------|
| `subagent` | `subAgentTemplateType`（如 "explorer"）；为空 → `"subagent"` | `"explorer"` |
| `undefined`（顶层 standalone parent）/ 其他 | `session.title`；无标题 → `"parent"` | `"探查代码任务"` / `"parent"` |

约束：name = 渲染用人类可读字段，**不参与路由**（路由只靠 sessionId），**不取 sessionId 片段**。

### 4.2 deliverTo 去 config（`agent_manager §2-§2.4`）

**新签名**：

```typescript
enqueue(sessionId: string, messages: Message[]): Promise<string[]>;
activate(sessionId: string): Promise<AgentRun>;
deliverTo(sessionId: string, message: Message): Promise<AgentRun>;
```

**deliverTo 内部链路**：

```
deliverTo(sessionId, message):
  enriched = await enrichForInbox(message, this.store)    // §2.5（user/system/approval 原样透传）
  await this.enqueue(sessionId, [enriched])
  return this.activate(sessionId)
```

**manager 内部 config 获取**（resolveConfigBySid，方案 A）：

```
class AgentManagerImpl:
  resolveConfig?: (sessionId: string) => Promise<SessionConfig>   // bootstrap.ts:300 setResolveConfig 注入

  private async resolveConfigBySid(sessionId): Promise<SessionConfig>:
    if !this.resolveConfig: throw Error("resolveConfig not injected")
    return this.resolveConfig(sessionId)              // 内部调 buildSessionConfigFromDeps

  enqueue(sessionId, messages):
    config = await this.resolveConfigBySid(sessionId)  // 仅取 sessionId 用
    ...
  activate(sessionId):
    config = await this.resolveConfigBySid(sessionId)
    agent = agentByMode(config.loopMode ?? "eager-drain")
    ...
```

**调用方改动清单**（agent_manager §2.4 完整表）：

| 调用方 | 现状（旧签名） | v0.0.31 改动 |
|--------|---------------|-------------|
| user POST /messages（`session-messages.ts:235,250`） | 裸 enqueue(config)+activate(config) + 自行 buildSessionConfigFromDeps | 收敛 deliverTo(sessionId, userMsg) |
| deliverTo 内部（`agent-manager-children.ts:116-124`） | deliverTo(deps, sid, msg) 接收旧签名注入 | managerDeliverTo(sessionId, msg) 直接调 manager 方法 + enrichForInbox |
| ManagerChildrenOps（`agent-manager-children.ts:207-218`） | enqueue(config)/activate(config)/resolveConfig 旧签名 | 改 enqueue(sessionId)/activate(sessionId)；resolveConfig 保留（内部用） |
| 心跳激活（占位） | 未实现 | 后续走 deliverTo(sessionId, heartbeatMsg)（source='system'） |
| 测试 fixture | 多处 enqueue(config)+activate(config) | 改 enqueue(sessionId)+activate(sessionId) 或 deliverTo |
| spawn-action.ts:125 / send-message-tool.ts:111 | 已走 deliverTo | 不变（签名不变，内部 impl 改） |
| forkedRun | opts 不含 config | 不变（forked 不消费 inbox） |

### 4.3 出口消费（drain 透传 + prompt 渲染，`agent_inbox_enqueue §2.5.5`）

| 环节 | 现状（代码待同步） | v0.0.31 要求 |
|------|------|-------------|
| drain（`agent-loop-stage-pre.ts:74`） | 只读 sender.source 做分流，丢 sender.agent | drain 透传完整 sender（含 agent）给 ingest；newMessages 携带原始 sender 不重新构造（保留 messageId 重写，确保 sender 不丢） |
| prompt assemble | messages 按 role 直送 LLM，零渲染 sender 前缀 | 新增 `inbox_from_marker` section（a2a_protocol §5）：`sender.source='agent'` → `[Message from <name> (<type>, needReply=<bool>)]: <content>`；user → `[User]:`；system → `[System (<kind>)]:` |

---

## 5. 代码待同步清单（编码阶段执行）

| 文件 | 改动 |
|------|------|
| `app/server/src/message/types.ts` | ①MessageSource enum `'scheduled'` → `'system'`；②MessageSender 改判别联合（删扁平 agentName/agentId/agent optional，4 变体 union） |
| `app/server/src/agent/inbox.ts:30-46` | InboxEntry 联合两变体各加 `enqueuedAt: string`；append/appendCancel 注入 `new Date().toISOString()` |
| `app/server/src/handlers/session-messages.ts:224-250` | user POST 收敛 deliverTo（删自行 buildSessionConfigFromDeps + 裸 enqueue/activate）；sender 改 `{ source: 'user' }`（清扁平残留） |
| `app/server/src/agent/agent-manager-children.ts:100-103,207-218,223-237` | ManagerChildrenOps 改 enqueue(sessionId)/activate(sessionId)；managerDeliverTo 直接调 manager 方法 + enrichForInbox |
| `app/server/src/agent/agent-manager.ts` | enqueue/activate 签名去 config；deliverTo impl 加 enrichForInbox + resolveConfigBySid（方案 A） |
| `app/server/src/agent/agent-loop-stage-pre.ts:74-94` | drain 透传完整 sender（不重新构造，保留 messageId 重写） |
| prompt builder（assemble-pipeline / system_prompt_builder） | 新增 inbox_from_marker section 渲染前缀（按 sender.source 分流） |
| emit message_enqueued 处 | 硬编码 `'scheduled'` → `'system'` |

---

## 6. 与 PRD / req2 对齐确认

逐条核对 PRD §3.1（A-F）+ req2.md §6（6 项）：

| PRD/req 项 | spec 落地点 | 对齐 |
|-----------|------------|------|
| A. inbox 入口 enrich | `[P0]agent_inbox_enqueue.md §2.5`（enrichForInbox 签名 + 伪代码 + name 规则 + 防幻觉契约） | ✅ |
| B. user POST 收敛 deliverTo | `[P0]agent_manager.md §2.4` 调用方清单 + `04-agent-session.md §3.2` v0.0.31 注 | ✅ |
| C. enqueue/activate 去 config | `[P0]agent_manager.md §2-§2.4`（新签名 + resolveConfigBySid 方案 A + 调用方清单） | ✅ |
| D. MessageSource enum 对齐 | `agent_message_interface §5`（'system' 权威）+ `agent_event §4.3`（行为表 'system'） | ✅ |
| E. sender 判别联合 | `agent_message_interface §5`（判别联合 4 变体 + 定夺结论 + 同步清单） | ✅ |
| F. inbox 补 enqueuedAt | `[P0]agent_inbox_enqueue.md §2`（已含字段 + 代码待同步注） | ✅ |

**关键用户路径覆盖**（PRD §5 / req2 §7）：
- 路径 1（async spawn 回报渲染）→ enrich 兜底 needReply + drain 透传 + inbox_from_marker 渲染
- 路径 2（sync spawn 取 answer）→ spawn sync 首任务 needReply=false 系统硬填
- 路径 3（a2a 提问 + 回复）→ needReply=true 透传 + 渲染前缀
- 路径 4（user 入口收敛）→ deliverTo 收敛 + sender `{source:'user'}` 判别联合 + 渲染 `[User]:`

---

## 7. 新发现的 spec 间矛盾（已修正）

1. **enrich 交叉引用错误**：`agent_message_interface §5` 同步清单 ⑤ 原写「见 `[P0]agent_inbox_enqueue.md §3.1`」，实际 enrich 在 §2.5（§3.1 是 enqueue 写侧章节）。**已修正**为 §2.5。
2. **agent_event §4.3 source 行为表落后**：仍用 `'scheduled'`，与 agent_message_interface §5 的 `'system'` 不一致。**已修正**为 `'system'` + v0.0.31 代码待同步注。
3. **subagent_derivation §4.1 / §9 TBD**：原标「[重构方向] 待同步」，与 agent_manager v0.0.31 已落地的新签名不一致。**已修正**标「v0.0.31 spec 已落地」+ §9 TBD 勾掉。

无 PRD/req2 与现有 spec 的新矛盾（PRD 引用的概念 spec 全部对齐，3 个新概念在 tech spec 落地后回链确认一致）。

---

## 8. 版本

version: 1.0（v0.0.31 首版：a2a 协议对齐 tech spec 全链落地。①`[P0]agent_inbox_enqueue.md` §2.5 新增「入口 enrich」+ §2 enqueuedAt 代码待同步 + §2.5.5 出口消费；②`agent_message_interface §5` sender 判别联合 + MessageSource enum 对齐；③`[P0]agent_manager.md` §2-§2.4 去 config 重构（方案 A）+ 调用方清单；④`agent_event §4.3` source 行为表对齐；⑤`subagent_derivation §4.1` 标 v0.0.31 已落地 + §9 TBD 勾掉；⑥修正 enrich 交叉引用 §3.1→§2.5。严守范围：只 multi_agent parent↔subagent，不碰 squad）。
