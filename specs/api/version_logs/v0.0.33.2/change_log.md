# v0.0.33.2 API 变更日志 — 4 scope 对话打通（拆 studio 403 / send_message squad clique / team 只读 / `<EOS>` 透明）

> 范围红线：本版 API 契约**主要变更是「拆限制」+「语义化」**——v0.0.33.1 占位 403 拆掉；send_message 加 squad clique 拓扑校验；新增 team 工具只读子集 v2；`<EOS>` 对 API 透明（UI/transcript/SSE 不见）；session.type 四值接 loop 后行为差异由后端内部消化，HTTP 入口仍只 `POST /session/:id/messages`。
> 权威输入：PRD `specs/prd/version_logs/v0.0.33.2/change_log.md` + tech `specs/tech/version_logs/v0.0.33.2/change_log.md`。
> 父版本：v0.0.33.1（CRUD/Studio/占位 403）；地基：v0.0.28（agent 工具 + send_message + subagent）+ v0.0.31（deliverTo 去 config + sender 判别联合 + enrich）。
> 命名：一律 **mate**（非 member）。

---

## 1. 概述

本版 API **零新 HTTP 端点**（squad/member/charter CRUD 在 .1 已落；v0.0.33.2 只让对话路径生效）。变更集中在：

| 变更类型 | 范围 | 影响 |
|---|---|---|
| **解除占位** | `POST /session/:id/messages` 对 studio session 不再返 403 | studio 4 scope（squad/leader/mate/subagent）行为差异 |
| **工具契约** | `send_message` 加 squad clique 校验语义 + `team` 新工具只读 v2 + `agent(spawn)` squad 内 parentSessionId 路由 | LLM 工具调用契约 |
| **协议透明** | `<EOS>` 对 HTTP/SSE/UI 不可见 | API surface 零增 |

---

## 2. HTTP 端点契约变更

### 2.1 `POST /session/:id/messages`（11-squad.md §4.5）

**变更**：移除 `if (bizType==='studio') return 403 'studio_chat_not_ready'` 占位。subagent 403（`subagent_readonly`）保留。

| 场景 | v0.0.33.1 | v0.0.33.2 |
|---|---|---|
| `:id` 是 playground session（bizType=playground 或空） | 沿用 `04-agent-session.md §3.2` | 同左（无改动） |
| `:id` 是 squad session（bizType=studio, type='squad'） | 403 `studio_chat_not_ready` | **202 + `{runId, enqueueId:''}`**（deliverTo 接 SquadChat loop） |
| `:id` 是 leader session（bizType=studio, type='leader'） | 403 | **202**（leader session 直接接 user，单聊路径） |
| `:id` 是 mate session（bizType=studio, type='mate'） | 403 | **202**（mate 单聊路径） |
| `:id` 是 subagent session（任意 bizType, type='subagent'） | 403 `subagent_readonly` | **403 `subagent_readonly`**（只读语义不变量） |

**请求/响应 schema 不变**：请求体仍 `{ content: string, providerId?, modelId?, activate? }`；响应仍 `{ runId: string, enqueueId: string }`（11-squad.md §4.5）。

**provider/model 覆盖**：studio session 仍走 `resolveProviderModel` 回退链——本版新增「**member.model ?? squad.modelDefault**」两层在 session 持久层之前（resolveConfigBySid 内 buildSessionConfigFromDeps 处理；API 层 `body.providerId/modelId > session persist > app_config 默认`，member/squad 注入不暴露给 HTTP 请求体）。

### 2.2 `GET /session/:id/messages`（11-squad.md §4.4 / 04 §3.4）

**变更**：studio session 拆 403 后，`GET /messages` 响应**首次有真实 transcript**（之前占位 chat 也允许读，但 transcript 空）。响应 schema 不变。

**群聊消息 sender 字段透传**（v0.0.31 已落 enrich，本版生效）：
- user 在群聊发的消息：`sender = { source: 'user' }`（判别联合 user 变体）
- leader/mate 经 send_message(to=SquadChat) 投到 squadChatSid 的消息：`sender = { source: 'agent', agent: { ref: { type:'leader'|'mate', sessionId, name }, needReply, inReplyTo? } }`

UI 据 `sender.agent.ref.name + ref.type` 渲染角色名前缀（群聊专属；单聊无前缀）。

### 2.3 SSE `agent_loop` topic（11-squad.md §6 / 02 §4）

**变更**：studio session SSE 流首次产出真实 LLM 事件（message_start / text_block_* / tool_call_* / message_end / run_end）。事件 schema 沿用 `agent_event.md`（v0.0.31 已对齐）。

**`<EOS>` 透明保证**：
- SquadChat 输出 `<EOS>` 经 stage-llm ingest 前 strip → SSE text_block 流不含 `<EOS>`
- transcript 不含 `<EOS>`
- GET /messages 不见 `<EOS>`

> 双保险：LLM caller 层 `params.stop=['<EOS>']` 让多数 provider 在 token 流中自然不输出 `<EOS>`；不支持 stop seq 的 provider 由 strip 兜底。**两条路径对 API 透明**——客户端永远看不到 `<EOS>`。

### 2.4 `GET /session`（bizType 过滤，11-squad.md §4.1）

**变更**：无（v0.0.33.1 已落 `?bizType=playground|studio` 过滤，本版保留）。UC-12 AT 回归确认拆 403 后 studio session 仍不污染 playground 列表。

---

## 3. LLM 工具契约变更

### 3.1 `send_message`（a2a_protocol §6 / subagent_derivation §5）

**签名不变**（v0.0.28 已落）：
```typescript
send_message({ target: AgentRef|string, content: ContentBlock[], needReply: boolean, inReplyTo?: string })
  → { messageId: string }
```

**变更 1（target 别名解析扩，a2a §2.2 优先级 3/4/5）**：v0.0.28 仅支持 sessionId + `'parent'`；v0.0.33.2 新增：
| 别名 | 解析 | 适用 caller |
|---|---|---|
| `'squadchat'` | caller squad 的 squadChatSessionId | squad/leader/mate |
| `'leader'` | caller squad 的 leader member.sessionId | squad/mate |
| `<角色 name>` | caller squad 内 member.name 唯一查找 | squad/leader/mate |

sessionId 仍权威；别名解析失败 → error `send_message: cannot resolve target`。

**变更 2（squad clique 拓扑校验）**：`checkReachable` 在 v0.0.28 subagent scope 拦截之外，新增 squad 内校验：

| caller.selfType | 合法 target.type | 跨 squad | 违规响应 |
|---|---|---|---|
| `'subagent'` | 仅 `'parent'`（scope 硬拦，既有） | N/A | `subagent can only send to parent` |
| `'squad'` `'leader'` `'mate'` | `{squad, leader, mate}`（同 squad 内） | 拒绝 | `cross-squad a2a not allowed` / `target not in squad clique` |
| 顶层 standalone（type=空） | 无限制（仅可达自己派的 child） | N/A | `null`（不拦） |

**返回响应不变**：成功 `{ messageId }`（fire-and-forget，`send_message` 不阻塞等回复；想同步用 `agent(spawn, mode=sync)`）。校验失败 `errorResult(...)`（tool result isError=true，LLM 看见错误提示）。

### 3.2 `team`（新工具 v2 只读子集，squad_tools §2）

**新工具**（PRD §4.2 / `squad_tools §2`）：
```typescript
team({ action: 'list'|'query'|'get_charter', ...args })
```

| action | 入参 | 谁可调 | 返回 |
|---|---|---|---|
| `list` | `filter?: { state?: 'deployed'|'benched' }` | leader/mate（squad 拒） | `[{ id, name, role: 'leader'|'mate', state, sessionId }]` |
| `query` | `{ ref: AgentRef\|string }`（sessionId 或 name） | leader/mate（squad 拒） | `{ id, name, role, state, systemPromptSummary, skills, model, sessionId }` |
| `get_charter` | `()` | leader/mate（squad 拒） | `{ goals, workingStyle, collaboration, escalation }` |

> **v3 留项**：`hire/deploy/bench/edit/update_charter` 不在 v2 LLM 工具集——仍走 HTTP（`POST /squad/:id/member` 等 .1 已落端点）+ UI 管理。

**权限校验**：tool run 时按 `rtc.selfType`：
- `squad` → reject（squadchat 不需 team 工具）
- `leader` / `mate` → 允许只读三 action；其他 action → reject `team action not allowed in v2`
- `subagent` → tool 不注册（schema 层裁剪，selfType='subagent' 看不到 team 工具）

### 3.3 `agent(spawn)` in squad（v0.0.28 复用）

**契约不变**（v0.0.28 已落）：mate session spawn subagent 的 `parentSessionId` 路由复用既有路径。subagent scope='subagent' → allowedTools 排除 agent 工具（不可再派生）。

**新增运行时差异**（无契约变化）：
- mate spawn 的 subagent session 带 `bizType='studio'`（跟 parent，`session_biztype §1`）+ `squadId=parent.squadId`（UC-12 隔离）
- subagent 仍走 type='subagent' 的 identity（explorer 人设，D9 修后生效）

### 3.4 工具集（v2 子集，PRD §4.2）

| Scope | 工具集（v2） | LLM 可见 |
|---|---|---|
| **squadchat**（type='squad'） | `send_message`（→ leader/mate） | 仅 send_message |
| **leader** | `send_message` + `team(list/query/get_charter)` 只读 | send_message + team |
| **mate** | `send_message` + `agent(spawn/query/abort)`（仅自己派的）+ `team` 只读 + 业务工具（member.tools 白名单） | 按 member.tools 白名单过滤 |
| **subagent** | v0.0.28 既有（read/web_search/web_fetch/send_message），迁框架不改集合 | 沿用 scope 排除 agent |

> 实现层：schema 层过滤（LLM 看不到无关工具）+ allowedTools 类型过滤（执行层门控）+ config.tools 白名单（实例级），三层叠加。

---

## 4. Session.type 四值接 loop 后的行为差异（HTTP 入口侧）

| session.type | HTTP 入口 | a2a 入口 | loop 行为 |
|---|---|---|---|
| `squad` | 接 user POST（不再 403） | 接收 leader/mate 经 send_message 投递 | SquadChat 哑路由 + `<EOS>` 收尾；不创作 answer |
| `leader` | 接 user POST（不再 403） | 接收 squad/mate 经 send_message 投递 | 协调者；charter 注入 prompt；可调 team 只读 |
| `mate` | 接 user POST（不再 403） | 接收 squad/leader/peer 经 send_message 投递 | 执行者；member.systemPrompt 注入；可 spawn subagent + 业务工具 |
| `subagent` | **403 `subagent_readonly`**（不变量） | 仅 parent 经 agent.spawn/send_message 投递 | explorer 人设（D9 修后生效）；只可达 parent |

> **关键**：HTTP 入口对所有非-subagent session 一视同仁（POST messages 返 202）；行为差异完全由 session.type + bizType 在后端 resolveConfigBySid → buildSessionConfigFromDeps → AgentLoop → mapper/toolfilter 链内部分流消化。客户端无需感知 scope。

---

## 5. 文件级变更清单（MANDATORY）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `specs/api/version_logs/v0.0.33.2/change_log.md` | 新增 | 本文件 |
| `specs/api/overall/11-squad.md` | 修改 | §4.5 占位 chat 403 → 拆除（studio session 接 loop）；§4.4 GET /messages 注明 studio session 真实 transcript + sender.agent.ref 透传；§6 SSE `<EOS>` 透明保证 |
| `specs/api/overall/11a-squad-endpoints.md` | 修改 | 标注 v0.0.33.2 拆 403 后 squad/member/charter 端点不变（仅对话路径生效） |
| `specs/api/overall/04-agent-session.md` | 修改 | §3.2 POST messages 加 studio session 行为说明（与 11-squad §4.5 交叉引用） |
| `specs/api/overall/10-multi-agent.md` | 修改 | §5 send_message 加 squad clique 校验语义 + 别名解析扩（'squadchat'/'leader'/name） |
| `specs/api/overall/10a-multi-agent-tool-ref.md` | 修改 | 加 `team` 工具 v2 只读子集契约（list/query/get_charter） |

---

## 6. AT 覆盖映射（PRD §5 12 用户路径）

| UC | 主路径 | API case 关键断言 |
|---|---|---|
| UC-1 | 群聊路由（user→SquadChat→leader→群聊 UI） | POST squadChatSid 返 202；leader 收到 a2a；GET squadChatSid messages 含 leader reply 且 sender.agent.ref.type='leader'；transcript 不含 `<EOS>` |
| UC-2 | 单聊 leader | POST leaderSid 返 202；leader final text 落 transcript；sender.source='user'/'agent' 不混淆 |
| UC-3 | 单聊 mate | 同 UC-2（type='mate'） |
| UC-4 | Leader→mate 协作 | leader send_message(to=mate) → mate inbox；mate send_message(to=leader) 回；leader 综合后 send_message(to=squad) 透传 UI |
| UC-5 | Mate→peer 通信 | mate A send_message(to=mate B by name) → B 收到 → B 回 A |
| UC-6 | Mate spawn subagent | mate 调 agent(spawn) → subagent 干活 → 回 parent mate（sync answer 或 async send_message） |
| UC-7 | `<EOS>` 验证 | SquadChat 出 `<EOS>` → strip → GET transcript 不含 `<EOS>`；session idle；新消息再激活 |
| UC-8 | Subagent backward compat | v0.0.28 全 AT/ET 回归 PASS；AT 真 LLM 验 subagent 自报 explorer 身份（非 Rocky） |
| UC-9 | Leader→user 升级 | leader send_message(to=SquadChat, needReply=false) → 群聊 UI 透传；user 回复经 SquadChat 路由回 leader |
| UC-10 | 角色面板记忆管理 | POST /session/:id/compact 返 200；GET /session/:id/summary 含 summary 内容 |
| UC-11 | reachable_agents 注入 | mate prompt 中 reachable_agents 含 leader/squadchat/peers，不含 user；通过 transcript 检查 LLM 看到的提示（或 fixture 跑 mapper 单测） |
| UC-12 | bizType 隔离 | GET /session?bizType=playground 不含 studio session；GET /session?bizType=studio 含 squad/leader/mate/studio-subagent |

> 真实 LLM 跑 UC-1/UC-2/UC-4/UC-6/UC-8（行为正确性 + identity）；UC-3/UC-5/UC-9 等价路径合并；UC-7/UC-10/UC-11/UC-12 黑盒可验。

---

## 7. 版本

version: 1.0 `[v0.0.33.2]`（4 scope 对话打通首版 API：①§1 概述——零新 HTTP 端点，变更集中在拆 403 + 工具契约 + `<EOS>` 透明；②§2 HTTP 端点契约变更（POST /messages 拆 studio 403 + 4 type 行为表 / GET /messages sender.agent.ref 透传 / SSE `<EOS>` 透明 / GET /session bizType 过滤）；③§3 LLM 工具契约变更（send_message 别名扩 + squad clique 校验三表 / team 新工具 v2 只读 / agent(spawn) in squad 复用 / 4 scope 工具集）；④§4 session.type 四值 HTTP 入口行为差异表；⑤§5 文件级变更清单（6 文件，5 修改 + 1 新增）；⑥§6 AT 12 UC 映射表。基于 PRD v1.0 + tech v1.0 + 权威 spec。）
