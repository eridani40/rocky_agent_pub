# Multi-Agent HTTP API（parent↔subagent 派生 — v0.0.28）

> version: 1.1 · 引入版本 v0.0.28 · **[v0.0.89 modified]** sub_agent_templates 路径迁 `dev_config` → `app_config`
> 管什么：v0.0.28 multi_agent 基础设施涉及的 **HTTP** 端点契约——Session schema 增量字段（type/parentSessionId/scope/subAgentTemplateType/origin）+ subagent 只读会话接口 + children/swarm 列表接口 + sub_agent_templates 模板组（**v0.0.89 迁入 app_config**）+ agent 工具（LLM tool call，非 HTTP，schema 引用）+ scope 连线影响。
> 不管什么：squad/角色/团队层（→ 后续版本）；agent_loop/SSE/session_state 内部机制（→ `04-agent-session.md` + tech specs）；UI 渲染（→ `specs/ui/`）；LLM tool call 内部协议（→ `[P1]agent_tools.md`）。
> **本文件是 AT（API Test）multi_agent 域的唯一依据**：api-verifier 黑盒 curl，不读代码。
>
> 范围红线（严守）：**只 multi_agent（parent↔subagent 派生 + a2a + 模板 + scope + subagent UI）**。严禁碰 squad/角色/团队层。
>
> **权威概念源**：`specs/tech/multi_agent/` 五件 + `specs/tech/agent/tools/[P1]agent_tools.md` 1.0 + `specs/ui/components/chat-page/{_overview.md §4.2/§4.2a/§4.3, component-subagent-tree.md, _components.md}`。
>
> **[v0.0.89 modified] sub_agent_templates 模板组存储迁移**：原 `dev_config.sub_agent_templates` 整组迁入 `app_config.sub_agent_templates`（dev_config entity 废弃）。**专用 DELETE/PUT 路由** `/config/dev/sub_agent_templates` → `/config/app/sub_agent_templates`（在 `/config/app` 之前注册防前缀覆盖）；GET 仍走通用 `/config/app?group=sub_agent_templates`。**handler 改名** `dev-config-template-handlers` → `app-config-template-handlers`（svc 切 AppConfigService）；builtin explorer 保护逻辑保留（`builtin:true` 拒 403 + `group!==sub_agent_templates` 拒 403 `group_not_deletable`）。详见 §5.2/§5.3 + `specs/api/version_logs/v0.0.89/change_log.md §1`。

## 1. 概述

v0.0.28 不新增独立的 subagent HTTP 域——**最大化复用现有 session/messages/usage/config 接口机制**。本文件变更分四类：

| 类型 | 说明 |
|------|------|
| **A. Session schema 增量字段** | 现有 `GET /session` / `GET /session/:id` 响应 Session 增 5 个 optional 字段（§2）。subagent session 通过这些字段在现有列表/详情接口**直接暴露**（不另起一套）。 |
| **B. 新增 HTTP 端点** | 仅 `GET /session/:id/children`（§3）——供前端 `component-subagent-tree` 展开 swarm 树。其他（只读会话/usage/messages/标读/模板 CRUD）**全部复用现有接口**（§4/§5）。 |
| **C. agent 工具 = LLM tool call（非 HTTP）** | spawn/query/abort 经 tool_execution_engine 调度，不经 HTTP（§6）；HTTP 仅暴露其副作用（§2/§3 GET 端点可观测）。 |
| **D. scope 连线（记录，非独立 API）** | buildSessionConfigFromDeps 加 scope + bootstrap 注入 activationStore，不暴露端点（详见 10a）。 |

**核心原则**：subagent session 是一等 session——`POST /session/:id/messages`、`GET /session/:id/messages`、`GET /session/:id/usage`、`POST /session/:id/read`、`GET /session/:id`、`GET /session` 全部对 subagent session 生效；subagent 的写入/读取路径与 parent 同构，仅在 `POST /messages`（user-source）一个语义点上收窄（§4.2）。

## 2. Session schema 增量字段（§A — v0.0.28）

`Session` 接口（定义见 `04-agent-session.md §2.1`）新增 5 个 optional 字段：

```typescript
interface Session {
  // ...现有字段（id/title/state/running/currentRunId/workspaceDir/unread/createdAt/updatedAt）...
  // ⭐ [v0.0.28 显式标注·spec_clarifications[0]] modelId（v0.0.9 已在 Session，GET /session + GET /session/:id 均返回；
  //    AT 路径 2/3 D8 model 验证依赖——读 child.modelId 断言 inherit vs template.modelId）
  modelId: string;                                      // session 使用的 LLM model（创建时定；POST /session 定，POST /messages 不回写）
  // ── [v0.0.56] SessionKind 统一身份维度（替代旧 type/scope/bizType）──
  role: "rocky" | "leader" | "mate" | "squad";        // [v0.0.56] 替代旧 type 字段（subagent 存 parent.role bloodline）
  derivation: "main" | "subagent";                      // [v0.0.56] 替代旧 scope + type='subagent' 双字段
  biz: "playground" | "studio";                         // [v0.0.56] 替代旧 bizType 字段（必填）
  parentSessionId?: string;                            // [v0.0.28] 派生者 session（权威）；仅 derivation=subagent 有值
  subAgentTemplateType?: string;                       // [v0.0.28] 派生自哪个模板（如 "explorer"）；仅 derivation=subagent 有意义
  origin?: { spawnRunId: string; toolCallId: string }; // [v0.0.28] 由哪次 spawn 产生（审计/观测）
  // 注：subAgentConfig 是内部字段（持久化 effective config），不暴露 HTTP（仅 buildSessionConfigFromDeps 读）。
}
```
> **[v0.0.56]** 旧 `type`/`scope` 字段已从 HTTP 响应删除。前端迁移映射见 `specs/api/version_logs/v0.0.56-session_type/change_log.md §1.1`。

> **[v0.0.28 spec_clarifications[0] 显式标注]**：`modelId` 字段 v0.0.9 已在 Session，GET /session + GET /session/:id 均返回。AT 路径 2（async spawn inherit）+ 路径 3（模板带 modelId）的 D8 model 验证依赖此字段——断言 child.modelId = template.modelId（走模板）或 parent.modelId（自定义 inherit）。**modelId 在 POST /session 时定（spawn 时由 `eff.modelId = template?.modelId ?? parent.modelId` 解析传入），POST /messages 不回写 session record 的 modelId**（这是设计语义，非 bug——session 级配置不变）。

### 2.1 字段语义与取值（[v0.0.56] type/scope→role/derivation/biz）

| 字段 | 顶层 standalone session | subagent session | squad/role session |
|------|------------------------|------------------|------------------------|
| `role` | `"rocky"` | parent.role（bloodline） | `"squad"/"leader"/"mate"` |
| `derivation` | `"main"` | `"subagent"` | `"main"` |
| `biz` | `"playground"` | 跟 parent.biz | `"studio"` |
| `parentSessionId` | `undefined` | 派生者 sessionId | `undefined`（仅 subagent 有） |
| `subAgentTemplateType` | `undefined` | 模板 `name`（如 `"explorer"`）或 `null`（inline spawn 无 templateRef） | 不适用 |
| `origin` | `undefined` | `{ spawnRunId, toolCallId }` | 不适用 |

### 2.2 在 GET /session 与 GET /session/:id 中的暴露

- **`GET /session`**（列表，见 `04-agent-session.md §2.2`）：响应 `items: Session[]` 中**包含**这 6 个字段。subagent session 与 parent session **混在同一列表**（按 `updatedAt` desc 排序），前端据 `derivation === "subagent"` + `parentSessionId` 决定渲染位置（挂到 parent conv-item 的 subagent-tree，不作为顶层独立项展示，详见 `component-subagent-tree.md`）。
- **`GET /session/:id`**（详情，见 `04-agent-session.md §2.3`）：返回完整 Session，含这 6 个字段。**纯读无副作用**（沿用 v0.0.27 纯读语义）。

> **设计选择**：subagent session **不另起一套 GET 端点**。复用现有 GET /session + GET /session/:id 即可观测 subagent 全部 meta。前端展开树用专用 `GET /session/:id/children`（§3）拿「parent→children」分组视图（列表端点按 updatedAt desc 平铺，UI 需要树形分组所以另起 children 端点）。

### 2.3 字段可见性 vs session_meta 广播

- **HTTP 响应**：`GET /session` / `GET /session/:id` 返回完整 Session（含 role/derivation/biz/parentSessionId/subAgentTemplateType/origin）。
- **SSE `session_meta_update` 广播**（v0.0.27，topic=`session_meta`，group=`_all`，payload=`SessionMetaView`）：`SessionMetaView` shape 与 GET /session 返回 Session 对齐（详见 `specs/tech/agent/session/[P0]session_event.md §3a.3`），**同步包含 [v0.0.56] 新字段 role/derivation/biz**（替代旧 type/scope/bizType）。subagent session 创建/状态变更时会话列表订阅者通过 SSE 收其 meta（含 derivation/parentSessionId），前端 reducer 据此把 subagent 挂到对应 parent 的 tree。

## 3. `GET /session/:id/children` — children/swarm 列表（§B 新增）

| 方法 | 路径 | 语义 | query | 成功响应 |
|------|------|------|-------|---------|
| `GET` | `/session/:id/children` | 列出 sessionId 派生的 children（subagent），按 state 分 running/terminated 两组，组内按 `updatedAt` desc | `status?` / `limit?` | `200` + `ChildrenView` |

### 3.1 查询参数

| 参数 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `status` | `"running" \| "terminated"` | 不传=返回两组 | `running` = 仅 running 组；`terminated` = 仅 terminated 组（含 idle/error/interrupted） |
| `limit` | number | `20` | 单组最多返回 N 条（按 `updatedAt` desc 截断）；缺省 20 |

> `templateType` 筛选**本版不暴露** HTTP query（保留 agent.query LLM 工具的入参）；UI 仅需 running/terminated 分组展示，无需模板筛选。

### 3.2 响应结构

```typescript
interface ChildrenView {
  parentSessionId: string;
  running: ChildSummary[];       // state === "running" 的 child（按 updatedAt desc）
  terminated: ChildSummary[];    // state ∈ {idle, error, interrupted} 的 child（按 updatedAt desc）
}
interface ChildSummary {
  sessionId: string;
  name: string;                  // subagent 显示名（如 "explorer"）；inline = subAgentTemplateType ?? "subagent"
  state: "idle" | "running" | "interrupting" | "interrupted" | "error";  // 对齐 Session.state
  subAgentTemplateType: string | null;  // 模板标签（null = inline spawn）
  updatedAt: string;             // isoDate，活跃时间（排序依据）
}
```

- **running / terminated 分组语义**：与 `[P1]subagent_derivation.md §3` 状态分组一致——`running` = 有 in-flight AgentRun（含 abort 收尾中的 interrupting，frontend 视觉暂显运行态）；`terminated` = run 已结束（idle=正常结束 / error=出错 / interrupted=被 abort）。
- **name 来源**：`subAgentTemplateType`（有模板）→ "explorer" 等；inline spawn（无 templateRef）→ "subagent"（默认占位）。
- **按 updatedAt desc**：复用现有 `Session.updatedAt`（不另立 lastUpdatedAt 字段，与 derivation §2 一致）。child 被 send_message 重激活/被 abort/落 transcript 时 updatedAt 推进。

### 3.3 行为与错误

- **数据源**：`list_children(parentSid)` 逻辑（与 agent.query LLM 工具同源，见 derivation §7）——查 `parentSessionId === :id` 的全部 child session，按 state 分组。
- **`limit` 截断**：每组（running/terminated）独立按 updatedAt desc 取前 N 条；后续可加 `cursor` 分页（本版 OUT）。
- **`status` 指定时**：未请求的组返 `[]`（减少负载）；不传时两组都按 `limit` 各取。
- **错误**：`404` parent session 不存在；`400` `status` 非 running/terminated；`400` `limit` 非 [1,100]。

### 3.4 与 agent.query（LLM tool call）的区分（MANDATORY — 严防混淆）

| 维度 | `GET /session/:id/children`（HTTP，本文 §3） | `agent(action=query)`（LLM tool call，§6） |
|------|----------------------------------------------|--------------------------------------------|
| **调用者** | 前端 UI（component-subagent-tree 展开 swarm 树） | parent agent LLM（决策时观测自己派的 swarm） |
| **入口** | HTTP GET，curl 可调 | LLM tool call，经 tool_execution_engine |
| **数据源** | **相同**（`list_children` 逻辑 + list_children 筛选/限量规则） | 相同 |
| **响应结构** | `ChildrenView`（running/terminated 分组，UI 友好） | 单详情 或 列表（LLM 友好，含 usage/lastUpdatedAt） |
| **筛选** | `status` + `limit`（HTTP query） | `filter: {status?, templateType?, limit?}`（tool input） |

> 两者数据源相同、入口不同——HTTP 给 UI 用，tool call 给 LLM 用。**不要把 HTTP children 端点当 LLM 工具入口**，也不要把 agent.query 当前端 API。

## 4. subagent 只读会话接口（§复用现有 — 语义收窄）

subagent session 在现有接口上的语义：

| 现有端点 | 对 subagent session 的语义 |
|----------|---------------------------|
| `GET /session/:id` | ✅ 完全适用——返回 subagent Session（含 type=subagent/parentSessionId/scope/subAgentTemplateType/origin）。纯读。 |
| `GET /session/:id/messages` | ✅ 完全适用——subagent transcript 分页（systemPrompt + parent 投递的 task + subagent assistant 回复）。前端 subagent 只读页用此拉消息流。 |
| `GET /session/:id/usage` | ✅ 完全适用——subagent 的 `current`（自身主对话累加）；`sub` 一般为零（subagent 不可再派生，无 child）。前端只读页的 usage-panel 用此拉 context usage。 |

### 4.0a `GET /usage` + `usage.sub` 结构（spec_clarifications[1]）

**parent session 的 `usage.sub`** 复用现有 `session_usage §6.2` `subAgentAccumulatedUsage`（零新机制）：

- **`GET /session/:parentSid/usage`** 返回 `SessionUsageView`，其中 `sub` 字段聚合所有 child（含 child 的 child，递归）的累加 usage。
- **`sub` 字段结构**：`Record<string, number>`（非强类型对象，v0.0.16 spec drift 修正已确认——见 `04-agent-session.md §3`），真实字段集合为 `{ input_cache_read, input_cache_write, input_no_cache, input_total_tokens, output_response, output_reasoning, output_total_tokens, total_tokens, cost, inputCharCount, outputCharCount, llmCallCount }`。

```typescript
interface SessionUsageView {
  current: Record<string, number>;   // 自身主对话累加（subagent 也有，subagent 自己跑 ReAct 的 LLM tokens）
  sub: Record<string, number>;       // [v0.0.28] sub-agent 递归累加（parent session 才有；subagent 的 sub 通常为零）
  forked: Record<string, number>;    // compact/memory 旁路累加
  total: Record<string, number>;     // current + sub + forked
}
```

> **[v0.0.69 字段名修正]** 本节之前写 `AccumulatedUsage.inputTokens`（驼峰、理想化命名）与代码实际不符——真实字段是 `input_total_tokens`（下划线，见上）。发现于 AT 迁移（`tests/api/multi_agent/spawn_sync_explorer_tc1`）读真实 `GET /session/:id/usage` 响应核对。`llmCallCount`/`inputCharCount`/`outputCharCount` 是仅有的驼峰字段，其余均下划线——与 `04-agent-session.md §3` 保持一致（该文件命名一直准确，本文件此前的 idealized sketch 已对齐修正）。

- **AT 验证**：路径 1/2（spawn）断言 `GET /session/<parentSid>/usage` 返回 `sub.llmCallCount > 0` + `sub.input_total_tokens > 0`（证明 child 真跑过 LLM，且 usage 递归上报 parent.sub 正确）。
- **subagent session 的 `sub`**：subagent 不可再派生（scope 硬约束），其 `sub` 通常为零（除非结构上未来允许更深层级——本版 scope 严防）。
- **权威源**：`specs/tech/agent/session/[P0]session_usage.md §6.2`（递归 subAgentAccumulatedUsage 机制，v0.0.28 零改复用）。
| `GET /session/:id/summary` | ✅ 适用——subagent 若触发 compact 也产生 summary（结构同 parent）。 |
| `POST /session/:id/read` | ✅ 适用——subagent session 也有 unread 标读语义（用户切到 subagent 只读页时标读，与 parent 同走 v0.0.27 标读端点）。 |

### 4.1 subagent session 的 SSE 订阅

subagent session 的流式事件走现有 SSE 通道，topic/group 与 parent 同构：`agent_loop:session_id:<subagentSid>_amt:current`（run 流式消息）/ `session_panel:session_id:<subagentSid>`（state/running/currentRunId 实时更新）/ `session_meta:_all`（meta 变更含 type/parentSessionId，会话列表据此更新 tree）。前端只读页订阅前两个 group 拿消息流 + state；会话列表订阅第三个 group 拿 tree 增量。

**a2a 消息在 transcript 中的标记（spec_clarifications[2]）**：

subagent transcript（`GET /session/:subagentSid/messages`）中的 a2a 消息（parent 投递的 task / send_message 内容）通过 **`message.sender.source === "agent"`** 标记（权威见 `[P1]a2a_protocol.md §5`）。前端据此渲染：a2a 消息显示「[Message from <parentName> (<parentType>, needReply=...)]: <content>」前缀（区别于 `[User]:` 前缀的 user-source 消息）。

```typescript
// subagent transcript 中的 a2a 消息示例（parent spawn 首任务投递）
{
  id: "<ulid>",
  sessionId: "<subagentSid>",
  role: "user",                              // a2a 消息 role=user（drain 时正常处理）
  content: [{ type: "text", text: "<task content>" }],
  sender: {
    source: "agent",                         // ⭐ a2a 消息标记（区别 user/source=user 的用户直发）
    agent: {
      ref: { type: "<parentType>", sessionId: "<parentSid>", name: "<parentName>" },
      needReply: false,                      // sync spawn 首任务硬填 false（subagent 完成不 send_message 回）
      inReplyTo: undefined                   // 首任务无 parent message 可引用
    }
  }
}
```

- **AT 验证**：路径 2（async spawn + send_message 回报）断言 `GET /session/<parentSid>/messages` 含一条 `sender.source === "agent"` + `sender.agent.ref.sessionId === <childSid>` 的消息（subagent 完成后 send_message 回报 parent，落 parent transcript）。
- **a2a deliverTo 不经 HTTP POST /messages**：a2a 消息经 AgentManager.deliverTo（内部 inbox.append + activate）投递，不走 HTTP `/session/:id/messages` 端点。HTTP POST /messages 仅拦外部 user 直发（对 subagent 返 403 subagent_readonly）。

> **[v0.0.31 a2a 协议对齐]** sender 改**严格判别联合**（按 source 分流，详见 `specs/tech/agent/message/[P0]agent_message_interface.md §5`）：
> - `source='agent'`（a2a）变体含 `agent.{ref, needReply, inReplyTo?}` 子结构（needReply a2a 专属必填）。
> - `source='user'` 变体 = `{source:'user'}`（**无 agentName/agentId 扁平残留**，无 agent 子结构）；**[v0.0.107]** IM 渠道入站的 user 消息带可选 `channel: { type, instanceId, conversationId, imUserId, imUserName }`（`type`=implId 如 `'feishu'`，标识来源渠道种类；web client 直发无 channel）。类型权威见 `specs/tech/channel/[P0]channel_impl_interface.md §5.1`。GET /messages 返回的 user 消息据此携带 `sender.channel.type`（跨渠道来源标识 + client「来自 X」徽标 + IM echo 屏蔽用）。
> - `source='system'` 变体含 `system.{kind, refId?}`（heartbeat/cron/reminder 由 system.kind 承载，`'scheduled'` 并入 `'system'`）。
> - `source='approval'` 变体含 `approval.{toolCallId, decision}`。
> - **inbox 入口 enrich**（`[P0]agent_inbox_enqueue.md §2.5`）：deliverTo 内、enqueue 前对 `source='agent'` message 反查发送方 session record 补全 ref.type/name（subagent→templateType；parent→title||'parent'）+ needReply 必填校验 + inReplyTo 透传；调用方传 type/name 则校验 warn 不一致。
> - **出口消费**（`a2a_protocol §5`）：prompt assemble 渲染 a2a 消息前缀 `[Message from <name> (<type>, needReply=<bool>)]:` / `[User]:` / `[System (<kind>)]:`；drain 透传完整 sender 给 ingest。
> - **HTTP 契约不变**——sender 形态变化只在落库 message 上（AT 黑盒断言 sender 判别联合形态，详见 `specs/api/version_logs/v0.0.31/change_log.md §3.2`）。
> - **[KNOWN-ISSUE BUG-034]** explorer builtin 模板的 systemPrompt 未引导 child 用 send_message 回复 a2a（child 收到 a2a 提问时倾向直接出 final text 而非 send_message 回）。**非协议 bug**（判别联合 + enrich + drain 透传 + 渲染前缀机制全工作，AT 路径 1/3 真 LLM 验证通过——subagent prompt 含 `[Message from ... (..., needReply=...)]` 前缀已确认）；是模板/使用层引导问题，留后续版本修 explorer systemPrompt。

### 4.2 `POST /session/:id/messages` — subagent 拒绝 user-source（语义收窄）

| 方法 | 路径 | 对 subagent session 的语义 |
|------|------|---------------------------|
| `POST` | `/session/:id/messages` | **拒绝 user-source 投递**（subagent 是只读会话，不接受用户直发消息） |

**行为**：当 `:id` 指向 `session.type === "subagent"` 的 session 时，端点返 **`403 Forbidden`** + `{ "error": "subagent_readonly" }`。

**理由**（对齐 PRD §2.1.9 + `[P1]subagent_derivation.md`）：subagent 是 parent 派生的隔离上下文子 agent，前端 readOnly mode 隐藏 input-bar/send/abort/enqueue（用户结构上无法在 UI 输入）。后端语义对齐：subagent session 的消息入口仅接受 **a2a deliverTo 投递**（parent 经 agent.spawn 首任务 / agent.query 后续 send_message）；**HTTP 层拒绝 user-source POST** 是双层防护——即便前端被绕过（curl 直接打），后端也拒绝，保证 subagent 消息流始终来自 parent（a2a）而非用户。

**错误码**：`403` + `{ "error": "subagent_readonly" }`（`:id` 是 subagent session 时）；现有 `400`/`404`（content 空 / session 不存在）保持不变。

> **a2a deliverTo 不经此端点**——deliverTo 是 AgentManager 内部方法（`manager.deliverTo(sessionId, msg)`，经 agent.spawn / agent.query LLM 工具触发），不走 HTTP POST /messages。HTTP 拒绝仅针对「外部 user 经 HTTP 直发」，不影响 a2a 内部投递。

### 4.3 其他写端点对 subagent 的语义（约定）

| 端点 | 对 subagent session |
|------|---------------------|
| `POST /session/:id/abort` | **拒绝**（403 `subagent_readonly`）——前端只读页隐藏 abort，用户不可手动中断 subagent；abort 仅经 parent agent.abort LLM 工具触发（走 AgentManager.abort 内部路径，不经 HTTP）。 |
| `POST /session/:id/compact` | **✅ 适用**（**v0.0.54 修订**，原 403 `subagent_readonly` 已移除）——subagent 长跑上下文同样会爆炸，必须支持手动 + 自动 compact（共用同一 forked agent 路径）。前端 subagent 只读页面对应放开 CompactBtn。触发条件同 parent session（state/idle 检查 + 双保险，详见 `04-agent-session.md §7`）。 |
| `POST /session/:id/clear` | **拒绝**（403 `subagent_readonly`）——subagent transcript 是审计/观测依据，不可被用户手动清空。 |
| `DELETE /session/:id` | ✅ 适用——subagent session 可被删除（用户清理 swarm 历史，级联清 transcript/runs/usage）。 |
| `PUT /session/:id` | ✅ 适用（仅 workspaceDir/title 可变；type/parentSessionId/scope 不可改）。 |

> **设计权衡**：subagent 是「观测对象」非「操作对象」——「用户主动操作 agent 行为」端点（发消息/中断/清空）对 subagent 收窄只读；「session 实体管理」端点（删除/改 title）保留。UI readOnly mode 隐藏清单在后端有对等语义防护。**[v0.0.54 修订]** compact 例外：subagent 必须 support compact（上下文爆炸风险等同 parent），从 readonly 收窄清单移除。

## 5. sub_agent_templates 模板 CRUD（§v0.0.89 迁入 app_config）

**不另起一套模板端点**——复用现有 `/config/app` group 机制（见 `03-config-center.md §2`）。模板作为 app_config 的 `sub_agent_templates` group 存储。

> **[v0.0.89 迁移]**：原 v0.0.28 落 `dev_config`，本版整组迁入 `app_config`（dev_config entity 废弃）；group/key 名零变更，仅 entity 名改。`scripts/migrate-dev-to-app.v0.0.89.sh` 处理历史 record 迁移（保 id+key）。

### 5.1 group 定义

`sub_agent_templates` 是 app_config 的一个 group（**v0.0.89 前在 dev_config**）：
- **group** = `"sub_agent_templates"`（由宿主固定，v0.0.28 新增；v0.0.89 entity 迁移）
- **key** = 模板 `name`（组内唯一，如 `"explorer"`、`"code-reviewer"`）
- **data** = `SubAgentTemplate` 结构（见 `[P1]subagent_templates.md §2`）

```typescript
interface SubAgentTemplate {
  name: string;            // = key（组内唯一）
  description: string;
  systemPrompt: string;
  tools: string[];         // 工具白名单（如 ["read","web_search","web_fetch","send_message"]）
  skills?: string[];
  modelId?: string;        // 缺省=inherit parent（null/undefined）
  builtin?: boolean;       // explorer=true，只读可复制
}
```

### 5.2 CRUD 接口（**v0.0.89 路径迁 `/config/app/sub_agent_templates`**）

| 操作 | 端点 | 行为 |
|------|------|------|
| **list** | `GET /config/app?group=sub_agent_templates` | 返回 `{ "items": [{ "key": "<name>", "data": <SubAgentTemplate> }, ...] }`（含 builtin explorer） |
| **get** | `GET /config/app?group=sub_agent_templates&key=<name>` | 返回 `{ "value": <SubAgentTemplate> }`；不存在 → `value: null` |
| **create** | `PUT /config/app/sub_agent_templates` body `{ "group": "sub_agent_templates", "key": "<新name>", "data": <SubAgentTemplate> }` | 单 key PUT（专用 handler `app-config-template-handlers`）；新建模板。**禁止 builtin:true**（builtin 仅系统预配）。 |
| **copy** | 两步：GET explorer → 改 name/builtin=false → PUT 新 key | builtin explorer copy 衍生为私有模板（builtin 改 false） |
| **update** | `PUT /config/app/sub_agent_templates` 单 key PUT（同 create 形态，覆盖） | 改已有模板字段。**禁止改 builtin 模板**（builtin=true 的 key PUT → 403 `builtin_readonly`）。 |
| **delete** | `DELETE /config/app/sub_agent_templates` body `{ "group": "sub_agent_templates", "key": "<name>" }` | 见 §5.3 |

> **v0.0.89 路径迁移要点**：专用 PUT/DELETE 路由 `/config/dev/sub_agent_templates` → `/config/app/sub_agent_templates`（**注册顺序在 `/config/app` 之前**防前缀覆盖）；GET 仍走通用 `/config/app?group=sub_agent_templates`。handler 改名 `dev-config-template-handlers` → `app-config-template-handlers`（svc 切 AppConfigService，逻辑保留）。

### 5.3 `DELETE /config/app/sub_agent_templates` — 删除模板（**v0.0.89 路径迁移自 `/config/dev`**）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `DELETE` | `/config/app/sub_agent_templates` | 删除 app_config.sub_agent_templates 指定 key record | `{ "group": "sub_agent_templates", "key": "<name>" }` | `200` + `{ "ok": true }` |

**约束**：
- **builtin 模板不可删**：`data.builtin === true` 的 record → `403` + `{ "error": "builtin_readonly" }`（explorer 等 builtin 模板只读，可 copy 不可删）。
- **group/key 不存在** → `404` + `{ "error": "Not Found" }`。
- 删除是物理删除（落盘 record 移除）；spawn 引用已删模板 → 解析阶段 error（`loadTemplate` 找不到 → spawn 拒绝，符合 `[P1]subagent_templates.md §4`）。

**请求示例**：

```bash
# 删除私有模板
curl -X DELETE http://127.0.0.1:3710/config/app/sub_agent_templates \
  -H "Content-Type: application/json" \
  -d '{"group":"sub_agent_templates","key":"my-explorer-copy"}'
# → 200 {"ok":true}

# 删 builtin explorer → 拒绝
curl -X DELETE http://127.0.0.1:3710/config/app/sub_agent_templates \
  -H "Content-Type: application/json" \
  -d '{"group":"sub_agent_templates","key":"explorer"}'
# → 403 {"error":"builtin_readonly"}
```

**错误**：`400` body 非法/缺字段；`403` builtin 不可删 / `group !== sub_agent_templates`（拒 `group_not_deletable`）；`404` record 不存在。

> **范围限制**：DELETE `/config/app/sub_agent_templates` 端点**仅对 `sub_agent_templates` group 生效**（其他 app group 不允许删——这些是配置项，删除=未配置即可）。`body.group !== "sub_agent_templates"` → `403` + `{ "error": "group_not_deletable" }`。

> **[v0.0.89] `/config/dev` 路由全删**：旧 `/config/dev` GET/PUT/DELETE 路由整段删（返 404）；所有原 dev group（含 sub_agent_templates）改走 `/config/app`。详见 `03-config-center.md`（v0.0.89 modified 标）。

### 5.4 builtin explorer 预配

系统启动时确保 `sub_agent_templates` group 存在 `explorer` 记录（`builtin: true`）：
```yaml
name: explorer
description: 探索型子 agent——只读探查、广撒网收集信息，不做写操作
systemPrompt: |
  你是 explorer 子 agent。你的职责是【只读探索】：调研、搜索、读取、汇总信息。
  不执行任何写/改/删除操作。完成后用简明结构化方式把发现回报给调用者。
tools: [read, web_search, web_fetch, send_message]
skills: []
modelId: null   # inherit parent
builtin: true
```

- bootstrap 时 upsert（idempotent）：探测 builtin=true 的 explorer record 存在即跳过（不回写用户改的字段）；不存在才写入预配值。保证 builtin 标记不被篡改，同时允许用户「复制 explorer」改私有版本。

## 6. agent 工具 + scope 连线（参考，非 HTTP — 见 10a）

> **本节内容拆至姊妹文件 `10a-multi-agent-tool-ref.md`**——spawn/query/abort 是 LLM tool call（非 HTTP）+ scope 连线是实现层变更（非 API surface）。本文聚焦 HTTP 端点契约；agent 工具 schema 权威源 + 与 HTTP children 区分 + scope 工具注册规则 + UT 覆盖 + agent_manager deliverTo 旧签名问题，详见 `10a-multi-agent-tool-ref.md` §1-§3。

**要点速览**（详细见 10a）：
- agent.spawn/query/abort 经 tool_execution_engine 调度，**不经 HTTP**；其副作用（subagent session 落库 / transcript / state 转移）通过本文 §2/§3 GET 端点可观测（GET /session/:childSid + /messages + /usage + /session/:parentSid/children）。
- scope 门控：session scope 注册 agent 工具；subagent scope 不注册（结构不可再派生）。UT 覆盖（PRD 路径 8 要求）。
- **[v0.0.31 已落地]** agent_manager enqueue/activate 已去 config 新签名（`enqueue(sessionId)/activate(sessionId)/deliverTo(sessionId, msg)`），与 multi_agent spec 的 `deliverTo(sessionId, msg)` 一致——详见 `10a-multi-agent-tool-ref.md §3`。

## 7. 错误码汇总

| HTTP | 场景 |
|------|------|
| `400` | `GET /session/:id/children` `status`/`limit` 非法；`DELETE /config/app/sub_agent_templates` body 缺字段 |
| `403` | `POST /session/:id/messages` 对 subagent session（`subagent_readonly`）；`POST /:id/abort|clear` 对 subagent（`subagent_readonly`）；`DELETE /config/app/sub_agent_templates` builtin 模板（`builtin_readonly`）；`DELETE /config/app/sub_agent_templates` 非 sub_agent_templates group（`group_not_deletable`）；`PUT /config/app/sub_agent_templates` 改 builtin 模板（`builtin_readonly`）。（**v0.0.54**：`POST /:id/compact` 对 subagent 不再 403——subagent 允许 compact；**`[v0.0.89]` 模板 CRUD 端点迁 `/config/app/sub_agent_templates`，见 §5.2/§5.3**） |
| `404` | session 不存在（GET /children / GET /messages 等沿用）；`DELETE /config/app/sub_agent_templates` record 不存在 |

## 8. AT 覆盖映射（PRD 9 路径 → API）

| PRD 路径 | API 端点组合 | 验证点 |
|----------|-------------|--------|
| **路径 1（sync spawn 模板）** | （agent.spawn LLM 工具触发）→ `GET /session/<childSid>` 断言 type=subagent/parentSessionId/scope=subagent/subAgentTemplateType=explorer + `GET /session/<childSid>/usage` current 非零 + `GET /session/<parentSid>/children` running→terminated | subagent session 落库可观测；sync answer 经 LLM tool result（非 HTTP，靠 transcript 落库查 GET messages） |
| **路径 2（async spawn + inherit model）** | （agent.spawn async + send_message LLM 工具）→ `GET /session/<childSid>` 断言 subAgentTemplateType=null（inline）+ `GET /session/<parentSid>/children` running→terminated + `GET /session/<childSid>/messages` 断言 send_message 回报消息落库 | async handle 经 LLM 工具（非 HTTP）；HTTP 验落库 + 状态转移 |
| **路径 3（模板带 modelId）** | `PUT /config/app/sub_agent_templates` body group=sub_agent_templates/key=新模板/data 含 modelId → （agent.spawn 用新模板）→ `GET /session/<childSid>` 断言 subAgentTemplateType=新模板 | 模板 PUT 落库 + spawn 引用经 LLM 工具（`[v0.0.89]` 端点迁 `/config/app/sub_agent_templates`） |
| **路径 4（query swarm）** | （agent.query LLM 工具，与 HTTP children 同源）→ `GET /session/<parentSid>/children` 断言 running/terminated 分组 + updatedAt desc + limit 截断 | agent.query 是 LLM 工具（非 HTTP）；HTTP children 是 UI 入口，AT 可直接 curl 验 |
| **路径 5（abort child）** | （agent.abort LLM 工具触发）→ `GET /session/<childSid>` state=interrupted + `GET /session/<parentSid>/children` 该 child 落 terminated 组 | abort 经 LLM 工具（非 HTTP）；HTTP 验 state 转移 |
| **路径 6（UI 展开 swarm）** | `GET /session/<parentSid>/children`（UI 数据源） + `GET /session`（列表含 subagent session，type=subagent 挂 parent tree） | ET 主覆盖；AT 可验 children 端点响应结构 |
| **路径 7（UI subagent 只读页）** | `GET /session/<subagentSid>` + `GET /session/<subagentSid>/messages` + `GET /session/<subagentSid>/usage` + `POST /session/<subagentSid>/read`（标读） | ET 主覆盖；AT 可验 subagent session 经现有 GET 接口可读 |
| **路径 8（scope 结构约束）** | （UT 白盒，engine.ts:46-73 门控）+ HTTP 层验 `GET /session/<childSid>` scope=subagent + `POST /session/<childSid>/messages` 返 403 subagent_readonly | UT 验 allowedTools 排除 agent；AT/HTTP 验 subagent 拒绝 user POST（侧面证明只读隔离） |
| **路径 9（模板管理）** | `GET /config/app?group=sub_agent_templates`（list，含 builtin explorer）→ `GET /config/app?group=sub_agent_templates&key=explorer`（get builtin）→ `PUT /config/app/sub_agent_templates`（copy 新模板）→ `GET`（验落库）→ `PUT /config/app/sub_agent_templates`（update 私有模板）→ `DELETE /config/app/sub_agent_templates`（删私有）→ `DELETE /config/app/sub_agent_templates` key=explorer（验 403 builtin_readonly） | AT 直接 curl 全 CRUD；builtin 只读语义（`[v0.0.89]` GET 走 `/config/app?group=`，PUT/DELETE 走 `/config/app/sub_agent_templates`，见 §5.2） |

> **关键说明**：PRD 9 路径中，**路径 1/2/3/5 的核心动作是 LLM tool call**（agent.spawn/query/abort + send_message），**不经 HTTP**——AT 验证其**副作用**（session 落库 / state 转移 / transcript 落库）通过现有 GET 端点可观测。路径 4/6/7 的 UI 数据源是 HTTP children / session / messages / usage 端点。路径 8 的 scope 门控主要是 UT。路径 9 的模板 CRUD 是纯 HTTP（`[v0.0.89]` 走 `/config/app` — GET `?group=sub_agent_templates`、PUT/DELETE `/config/app/sub_agent_templates`）。

## 9. 文件变更清单（planner/coder 依据）

> **v0.0.28 历史记录**（当年建 `/config/dev` 模板路由/handler）；**`[v0.0.89]` 已迁 `/config/app`**：`config.ts` DELETE handler + `router.ts` 路由 + handler 文件均改走 `/config/app/sub_agent_templates`（handler 改名 `app-config-template-handlers`），`dev-config.ts` → `AppConfigService`。当前契约以 §5.2/§5.3 为准。

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/handlers/session.ts` | 修改 | `Session` 响应序列化加 `type?/parentSessionId?/scope?/subAgentTemplateType?/origin?`（GET /session + GET /session/:id）；新增 `GET /session/:id/children` handler（调 list_children 逻辑，返 ChildrenView）；`POST /session/:id/messages` + `POST /:id/abort` + `POST /:id/clear` 加 subagent 403 拒绝（`type === "subagent"` 时返 `subagent_readonly`）；`POST /:id/compact` 对 subagent **不**拒绝（**v0.0.54** 移除 subagent guard，详见 `04-agent-session.md §7`） |
| `app/server/src/handlers/config.ts` | 修改 | 新增 `DELETE /config/dev` handler（仅 sub_agent_templates group 允许；builtin 拒绝 403；其他 group 拒绝 403 `group_not_deletable`） |
| `app/server/src/router.ts` | 修改 | 新增路由：`GET /session/:id/children` + `DELETE /config/dev` |
| `app/server/src/session-store.ts` | 修改 | Session schema 加 5 个 optional 字段（type/parentSessionId/scope/subAgentTemplateType/origin，持久化）；新增 `listChildren(parentSid)` 查询方法（按 parentSessionId 筛 + state 分组 + updatedAt desc + limit） |
| `app/server/src/dev-config.ts`（或 dev-config-service） | 修改 | 新增 `sub_agent_templates` group 注册；DELETE record 方法（仅 sub_agent_templates group） |
| `app/server/src/bootstrap.ts` | 修改 | upsert builtin explorer 模板到 sub_agent_templates group（idempotent，仅 builtin=true 标记保证）；**v0.0.26 连线 bug 修复**：PluginManager 注入 activationStore/scopeStore/policyStore |
| `app/server/src/agent/build-session-config.ts` | 修改 | `buildSessionConfigFromDeps` 加 `scope` 参数；subagent 传 'subagent'；allowedTools 按 scope 过滤 |
| `app/server/src/handlers/sse.ts` | 修改 | `SessionMetaView` 序列化加 5 个新字段（type/parentSessionId/scope/subAgentTemplateType/origin），对齐 GET /session 响应 |
| `app/server/src/agent/session-meta-broadcaster.ts` | 修改 | broadcast 时组装 SessionMetaView 含新字段（subagent session 创建/状态变更时广播含 type/parentSessionId，会话列表据此更新 tree） |

> **agent 工具实现**（`app/server/src/agent/tools/agent-tool.ts` 新增）不在本 HTTP spec 文件展开——LLM tool call 经 tool_execution_engine 调度，契约见 `[P1]subagent_derivation.md §4/§7` + `[P1]agent_tools.md §1`。

## 10. 待定（非阻断）

- 顶层非-squad session 的 type 归属（squad 层定；本版顶层 standalone 不填 type）。
- `agent` 工具 LLM-facing schema 细化（action enum + 各 action input schema）→ coder 实现时按 derivation §4/§7 落地（非 HTTP concern）。
- **[v0.0.31 已落地]** agent_manager deliverTo 去 config 重构（enqueue/activate 新签名 `enqueue(sessionId)/activate(sessionId)`，全调用收敛 deliverTo）已落地，详见 `10a-multi-agent-tool-ref.md §3`。

## 11. 版本

version: 1.0 `[v0.0.28]`（首版：①Session schema 增量字段 §2 type/parentSessionId/scope/subAgentTemplateType/origin + 在 GET /session + GET /session/:id + session_meta 广播暴露；②新增 §3 `GET /session/:id/children`（children/swarm 列表，running/terminated 分组，UI 树数据源，与 agent.query LLM 工具区分）；③§4 subagent 只读会话接口（复用 GET session/messages/usage/summary/read + §4.2 POST messages 对 subagent 拒绝 403 subagent_readonly + §4.3 abort/compact/clear 同拒；DELETE/PUT session 保留）；④§5 sub_agent_templates 模板 CRUD（复用 /config/dev group + §5.3 新增 DELETE /config/dev 仅 sub_agent_templates group + builtin 拒绝）；⑤§6 agent 工具 + scope 连线拆至 `10a-multi-agent-tool-ref.md`（LLM tool call 非 HTTP + scope 实现层 + agent_manager deliverTo 旧签名记录）；⑥§8 PRD 9 路径 → API 覆盖映射——路径 1/2/3/5 核心动作为 LLM tool call，AT 验其副作用经现有 GET 端点可观测）。
version: 1.0b `[v0.0.31]`：①§4.1 追加 v0.0.31 a2a 协议对齐注（sender 严格判别联合 4 变体 + inbox 入口 enrich 反查补 ref.type/name + needReply a2a 专属 + 出口 prompt 渲染前缀 + drain 透传；HTTP 契约不变，仅落库 sender 形态变化；BUG-034 explorer 模板引导 known-issue 非协议 bug）；②§6 + §10「agent_manager deliverTo 重构待同步」更新为「v0.0.31 已落地」（enqueue/activate 去 config 新签名）。
version: 1.0a `[v0.0.28 实现后勘误·doc-modifier 阶段5同步]`：①§2 Session 显式列 **modelId** 字段（spec_clarifications[0]——v0.0.9 已在 Session，AT 路径 2/3 D8 验证依赖；澄清 POST /session 定 modelId / POST /messages 不回写，非 bug）；②§4.0a 新增 **GET /usage + usage.sub 结构**（spec_clarifications[1]——复用 session_usage §6.2 subAgentAccumulatedUsage，零新机制）；③§4.1 新增 **a2a 消息 sender.source='agent' 标记**（spec_clarifications[2]——transcript 中 a2a 消息标记 + AT 验证路径 2 send_message 回报落库；a2a deliverTo 不经 HTTP POST /messages）。
