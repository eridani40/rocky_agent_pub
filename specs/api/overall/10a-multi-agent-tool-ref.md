# Multi-Agent 工具引用 + scope 连线（v0.0.28 — 参考，非 HTTP）

> version: 1.0 · 引入版本 v0.0.28
> 定位：v0.0.28 multi_agent 的 **LLM 工具调用**（spawn/query/abort，非 HTTP）+ **scope 连线**（非 API surface）的参考说明。
> 关系：本文是 `10-multi-agent.md` 的姊妹文件——主文件管 HTTP 端点契约，本文管「LLM tool call 不是 HTTP 但其副作用经 HTTP 可观测」+「scope 实现层变更不暴露 API」。api-verifier AT 时主要按主文件；本文供 planner/coder/UT 参考。
>
> 范围红线（严守）：**只 multi_agent**。不碰 squad/角色/团队层。
> 权威概念源：`specs/tech/multi_agent/` 五件 + `specs/tech/agent/tools/[P1]agent_tools.md` 1.0。

## 1. agent 工具 = LLM tool call（非 HTTP）

> **关键区分（严防混淆）**：spawn/query/abort 是 **LLM 工具**，经 `tool_execution_engine` 调度，由 parent agent LLM 在 ReAct loop 中调用。**HTTP 层不暴露这些工具**——其**副作用**（创建 subagent session / 落 transcript / 改 state）通过现有 GET 端点可观测（见 `10-multi-agent.md §2/§3`）。

### 1.1 工具 schema 权威源

| 工具 action | 入参 / 返回 / 流程 | 权威源 |
|-------------|---------------------|--------|
| `agent(action=spawn)` | `SpawnAgentInput`（无 modelId 字段，D8 修订）/ `SpawnAgentResult`（sync 返 answer/usage/stopReason；async 返 runId/status）/ 执行流程（createSession + deliverTo + await run.promise） | `[P1]subagent_derivation.md §4` |
| `agent(action=query)` | `{ ref? }` 单查（返 usage/lastUpdatedAt）或 `{ filter: {status?, templateType?, limit?} }` 列表（按 lastUpdatedAt 倒序，limit 默认 20） | `[P1]subagent_derivation.md §7` + `[P1]agent_tools.md §1` |
| `agent(action=abort)` | `{ ref }` → ack（走 manager.abort；D6 单向级联——parent abort → in-flight child 级联） | `[P1]subagent_derivation.md §6/§7` |

> 工具名收敛自 v0.0.28：原 `spawn_agent`/`list_children`/`query_agent`/`abort_agent` 四件收敛为单工具 `agent` 三 action（spawn/query/abort），权威见 `[P1]agent_tools.md §1`。

### 1.2 与 HTTP children 端点的区分（MANDATORY）

| 维度 | `GET /session/:id/children`（HTTP，主文件 §3） | `agent(action=query)`（LLM tool call） |
|------|----------------------------------------------|--------------------------------------------|
| **调用者** | 前端 UI（component-subagent-tree 展开 swarm 树） | parent agent LLM（决策时观测自己派的 swarm） |
| **入口** | HTTP GET，curl 可调 | LLM tool call，经 tool_execution_engine |
| **数据源** | **相同**（list_children 逻辑 + 筛选/限量规则） | 相同 |
| **响应结构** | `ChildrenView`（running/terminated 分组，UI 友好） | 单详情 或 列表（LLM 友好，含 usage/lastUpdatedAt） |
| **筛选** | `status` + `limit`（HTTP query） | `filter: {status?, templateType?, limit?}`（tool input） |

> 两者数据源相同、入口不同——HTTP 给 UI 用，tool call 给 LLM 用。AT 测试 HTTP children 端点直接 curl；agent.query 是 LLM 工具，AT 验其副作用（session 落库/state 转移）。

### 1.3 HTTP 可观测的副作用（spawn 后）

agent.spawn 执行后，HTTP 层通过现有端点可观测（这些是 AT 验证路径 1/2/3 的依据）：
- `GET /session/<childSid>` → 返回新建的 subagent Session（`type=subagent`/`parentSessionId`/`scope=subagent`/`subAgentTemplateType`/`origin`）。
- `GET /session/<childSid>/messages` → subagent transcript（首任务 task message + subagent assistant 回复）。
- `GET /session/<childSid>/usage` → subagent usage（current 非零；sub 为零——subagent 无 child 不可再派生）。
- `GET /session/<parentSid>/children` → swarm 树（§3，child 落 running 或 terminated 组）。

## 2. scope 连线（非 API surface — 实现层记录）

> 本节是 v0.0.26 连线 bug 修复 + v0.0.28 scope 注入的实现层记录，**不暴露 HTTP API**。HTTP 层仅通过 `Session.scope` 字段（主文件 §2）反映 subagent session 的 scope 值。详见 `[P1]agent_tools.md §2.3` + `ext_impl_scope.md §5`。

### 2.1 buildSessionConfigFromDeps 加 scope 参数

| 变更 | 影响 |
|------|------|
| `buildSessionConfigFromDeps(deps, scope?)` 加 `scope` 入参 | subagent session 传 `scope='subagent'`；其他传 `'session'`（或缺省=隐式 session） |
| `allowedTools` 从「全集」改为「按 scope 过滤」 | session scope=全集（含 agent 工具）；subagent scope=全集 \ {agent}（结构上不可再派生） |
| `getExtensionImpls(point, scopeId)` 调用方按 session.scope 传 scopeId | llm-client-factory / web-search / context-engine 调用时传 session.scope 作 scopeId |

### 2.2 bootstrap 注入 activationStore（修 v0.0.26 连线 bug）

| 变更 | 影响 |
|------|------|
| `bootstrap.ts` `new PluginManager(...)` 注入 activationStore/scopeStore/policyStore | `getExtensionImpls(point, scopeId)` 对非 default scope 不再走「未激活 → 回退 default」分支，scope 体系真正生效 |

**问题背景**：`bootstrap.ts:138` 未注入 activationStore → `getExtensionImpls(point, scopeId)` 对非 default scope 永远走「未激活 → 回退 default」分支，scope 体系形同虚设（v0.0.26 遗留 bug）。v0.0.28 必须修复，否则 subagent scope 的 allowedTools 过滤无效（subagent 仍能派生，违反结构约束）。

### 2.3 工具注册规则（scope 门控）

| scope | `agent` 工具注册 | 说明 |
|-------|------------------|------|
| `session`（parent / 顶层 standalone） | ✅ 注册（LLM tool 列表含 agent） | parent 可派生 subagent |
| `subagent` | ❌ 不注册（LLM tool 列表无 agent） | subagent 结构上不可再派生（不是 prompt 劝说，是工具层硬约束） |

**实现**：subagent session 的 `allowedTools = 全集 \ {agent}`（等价 `disabledTools = ['agent']`）→ engine.ts:46-73 已实现的 allowedTools 白名单过滤复用，本版只改 agent-loop.ts:278 处传入的 allowedTools 来源（从 scope 派生）。

**UT 覆盖**（PRD 路径 8 要求 UT）：
- subagent scope 的 `buildSessionConfigFromDeps` 返回 allowedTools 不含 `agent`。
- session scope 的 `buildSessionConfigFromDeps` 返回 allowedTools 含 `agent`。
- engine.ts:46-73 门控对 allowedTools 白名单过滤生效（subagent LLM tool 列表无 spawn/query/abort）。

**本版不实现**工具全量 EP impl 化（每 tool 注册为 EP impl，scope 走 `getExtensionImpls(point, scopeId)` 双重载）—— 标未来增强（`[P1]agent_tools.md §2.2`）。

## 3. agent_manager deliverTo 去 config 重构（v0.0.31 已落地）

**[v0.0.31 代码已落地]** 原 v0.0.28 反馈的「agent_manager enqueue/activate 旧签名 `enqueue(config,...)/activate(config)` 与 multi_agent spec 的 `deliverTo(sessionId, msg)` 不一致」问题，**v0.0.31 spec + 代码已同步解决**：

- `[P0]agent_manager.md` §2-§2.4 已改签名为 `enqueue(sessionId, ...) / activate(sessionId)`，对外收敛到 `deliverTo(sessionId, msg)`。
- manager 内部按 sessionId 获取 config（**方案 A**：每次调 `resolveConfigBySid(sessionId)` 复用 bootstrap.ts:300 `setResolveConfig` 注入的 `buildSessionConfigFromDeps`，无 cache）；方案选型对比见 agent_manager §2.3。
- deliverTo 内部链路：`enrichForInbox(message, store)` → `enqueue(sessionId, [enriched])` → `activate(sessionId)`（enrich 见 `[P0]agent_inbox_enqueue.md §2.5`）。
- 调用方改动清单（user POST / deliverTo 内部 / ManagerChildrenOps / 心跳占位 / 测试 fixture / spawn-action / send-message-tool / sideRun）见 agent_manager §2.4。

**代码落地状态**：
- `app/server/src/agent/agent-manager.ts` `enqueue(sessionId, messages)` / `activate(sessionId)` 新签名已实装；`resolveConfigBySid` 私有方法（无 cache，每次调 resolveConfigFn）。
- `app/server/src/handlers/session-messages.ts:243,252` 已收敛 deliverTo（测试守卫走 enqueue(sessionId)；默认走 deliverTo(sessionId, userMsg)）。
- `app/server/src/agent/agent-manager-children.ts` ManagerChildrenOps 已改新签名。
- `app/server/src/bootstrap.ts` resolveConfig 注入点保留（manager 内部 resolveConfigBySid 用）。

**影响**：
- spawn/send_message 内部用 deliverTo 语义（subagent_derivation §4/§5 权威）；agent_manager spec 已对齐 → 后续 agent 无 spec 间隙。
- E2E/AT 黑盒不验内部 enqueue/activate 签名（PRD §6 不覆盖项）——只验 spawn/send_message 行为正确 + sender 判别联合落库（路径 1/2/3/4）。



## 3a. `send_message` squad clique + `team` 只读工具 `[v0.0.33.2]`

### 3a.1 `send_message` target 扩展

- **核心概念**：Studio 角色复用 a2a `send_message`，同 squad 内 squad/leader/mate 互通，subagent 仍只回 parent。
- **设计思路**：把拓扑校验放工具层而非 prompt，避免 LLM 幻觉跨 squad 目标或绕过 user 不可达规则。
- **代码路径**：`app/server/src/agent/tools/runtime-context.ts.resolveAgentRef() → app/server/src/agent/tools/send-message-tool.ts.run() → app/server/src/agent/agent-manager.ts.deliverTo()`。
- **接口签名**：`send_message({ target: AgentRef|string, content: ContentBlock[], needReply: boolean, inReplyTo?: string }): { messageId: string }` —— target 允许 sessionId、`parent`、`squadchat`、`leader`、同 squad member.name；跨 squad返回 tool error。content 权威形态 = array of `{type:"text", text:string}`；LLM 异常形态（缺 type block / string / object.item 包裹）由 `normalizeContentBlocks` 容错收敛（`[v0.0.331]`，语义唯一来源见 `multi_agent/[P1]subagent_derivation.md §5.1`；落库前同函数 normalize，半截 arguments 带 `_rawTruncated` 标记）。out 信封的 `targetName` 显示名语义见 `multi_agent/[P1]a2a_protocol.md §2`（`[v0.0.340]` member 走 memberStore 实时名，改名后信封即时新名）。
- **版本演进**：`[v0.0.33.2]` AT 已覆盖 squad group/collab/spawn/identity/eos；BUG-001 是 LLM 未必主动终答回路由，不是工具契约失败。

### 3a.2 `team` 工具 v2 只读

```typescript
team({ action: 'list'|'query'|'get_charter', query?: { ref: string } }): ToolRunResult
```

- `list`：返回 `[{ id, name, role, state }]`。
- `query`：按 memberId 或 name 返回 `{ id, name, role, state, systemPromptSummary, skills, tools, model, sessionId }`。
- `get_charter`：返回 `{ goals, workingStyle, collaboration, escalation }`。

权限：leader/mate 可调；squad/subagent/standalone 拒绝。写 action（hire/deploy/bench/edit/update_charter）留 v0.0.33.3，仍走 HTTP/UI。

## 4. 版本

version: 1.3 `[v0.0.33.2]`：新增 send_message squad clique target 语义与 team(list/query/get_charter) 只读工具契约。
version: 1.2 `[v0.0.31]`：§3 标题 + 段落从「spec 已落地」更新为「代码已落地」——agent-manager.ts enqueue/activate 新签名 + resolveConfigBySid 已实装；session-messages.ts:243,252 已收敛 deliverTo；agent-manager-children.ts ManagerChildrenOps 已改新签名；bootstrap resolveConfig 注入点保留。代码层不再有「代码待同步」点（drift 修正）。
version: 1.1 `[v0.0.31]`：§3 从「deliverTo 旧签名问题（spec 待同步）」更新为「deliverTo 去 config 重构（spec 已落地）」——agent_manager.md §2-§2.4 已同步新签名 + 方案 A（resolveConfigBySid）+ 调用方清单；本节列代码待同步点（agent-manager-children.ts ManagerChildrenOps 旧签名 / session-messages.ts 裸调 / bootstrap resolveConfig 注入点保留）。
version: 1.0 `[v0.0.28]`（首版：从 `10-multi-agent.md` 拆出非 HTTP 主体内容——①§1 agent 工具 = LLM tool call 非 HTTP（schema 权威源引用 derivation §4/§7 + agent_tools.md §1 + 与 HTTP children 端点区分 + spawn 副作用经 HTTP 可观测）；②§2 scope 连线（buildSessionConfigFromDeps 加 scope + bootstrap 注入 activationStore + 工具注册规则 + UT 覆盖）；③§3 agent_manager deliverTo 旧签名问题记录（spec 待 doc-modifier 同步，非阻断））。
