# API Change Log — v0.0.8

> 增量记录 v0.0.8 相对 v0.0.7 的 HTTP 端点契约变更。
> tech 架构：`specs/tech/version_logs/v0.0.8/change_log.md`。PRD：`specs/prd/version_logs/v0.0.8/change_log.md`。
> 全量契约基线：`specs/api/overall/02-llm-chat.md`（本版本后 `/chat` 作废）+ `03-config-center.md`。
> v0.0.8 = **删除无 session `POST /chat` + 新增 session CRUD / message 分页 / SSE channel 端点**。

## 1. 端点变更概览

| 操作 | 端点 |
|------|------|
| **删除** | `POST /chat`（无 session 单轮，作废，PRD §1.2.5） |
| **新增** | `POST /session`、`GET /session`、`GET /session/:id`、`DELETE /session/:id` |
| **新增** | `GET /session/:id/messages`（transcript 分页）、`POST /session/:id/messages`（发消息触发 run） |
| **新增** | `GET /session/:id/summary`（D2 摘要只读端点，使 path D compact 可观测） |
| **新增** | `GET /sse`（SSE 流）、`POST /sse/subscribe`、`POST /sse/unsubscribe` |
| 保留 | `/counter*`、`/health`、`/config/{app,dev,plugin}`（03-config-center.md）、`/provider*`、`/provider/:id/model*` |

**通用约定（沿用 `02-llm-chat.md §2`）**：host `127.0.0.1`；port `API_PORT`（test 3700 / dev 3710 / prod 3720）；JSON 请求/响应；错误体 `{ "error": string }`；credentials 不下发前端（key 在 server 读 app_config providers 组）。

## 2. Session CRUD

### 2.1 `POST /session` — 创建会话

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session` | 创建空 Session（ULID），不触发 run | `CreateSessionBody?`（可选） | `201` + `Session` |

**请求体（可选）**：

```typescript
interface CreateSessionBody {
  title?: string;           // 缺省 = "新会话"
  providerId?: string;      // 可选，预绑定 provider/model（缺省用 app_config 默认）
  modelId?: string;
}
```

**响应 `Session`**：

```typescript
interface Session {
  id: string;               // ULID
  title: string;
  status: "active";
  createdAt: string;        // isoDate
  updatedAt: string;
}
```

**错误**：`400` body 非法 JSON；`400` `providerId` 提供但不命中 app_config providers 组。

### 2.2 `GET /session` — 会话列表

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/session` | 所有 session（按 updatedAt desc） | `200` + `{ items: Session[] }` |

### 2.3 `GET /session/:id` — 会话详情

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/session/:id` | 单个 session 元数据 | `200` + `Session` |

**错误**：`404` session 不存在。

### 2.4 `DELETE /session/:id` — 删除会话

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `DELETE` | `/session/:id` | 删除 session + 其 transcript/summary/runs（级联） | `204`（无 body） |

**错误**：`404` session 不存在。

## 3. Session Messages

### 3.1 `GET /session/:id/messages` — transcript 分页

| 方法 | 路径 | 语义 | query | 成功响应 |
|------|------|------|-------|---------|
| `GET` | `/session/:id/messages` | 读 transcript（升序） | `limit`、`beforeId`（可选） | `200` + `{ items: Message[], hasMore: boolean }` |

**query 参数**：

| 参数 | 类型 | 默认 | 语义 |
|------|------|------|------|
| `limit` | number | `50` | 单页最大条数（建议 50） |
| `beforeId` | string? | — | 取该 messageId（ULID 字典序）**之前**的 limit 条；缺失 = 取末尾 limit 条（最近 50） |

**分页约定**（支撑 PRD §5.8 上滑续载）：
- 打开 session：前端无 `beforeId` 调用 → 拿到最近 50 条。
- 上滑到顶：前端用最旧一条的 `id` 作 `beforeId` → 续载前 50 条，**前插**渲染。
- `hasMore=true` 表示还有更早历史；`hasMore=false` 停止续载。

**响应 `Message`**（对齐 `agent_message_interface.md §5`，v0.0.8 子集见 tech change_log §3）：

```typescript
interface Message {
  id: string;               // ULID
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];  // TextBlock | ToolCallBlock | ToolResultBlock | ReasoningBlock | UsageBlock
  runId?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}
```

**错误**：`404` session 不存在；`400` `limit` 非 [1,200]；`400` `beforeId` 格式非法。

### 3.2 `POST /session/:id/messages` — 发消息触发 run

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/messages` | enqueue user message + activate AgentLoop（新 run）；**非 SSE** | `PostMessageBody` | `202` + `{ runId: string }` |

**请求体**：

```typescript
interface PostMessageBody {
  content: string;          // 必填，user query 纯文本
  providerId?: string;      // 可选，覆盖 session 预绑定（缺省用 session 或 app_config 默认）
  modelId?: string;
}
```

**行为**：
1. 构造 `role:"user"` Message（content=`[{type:"text",text:content}]`）。
2. `AgentManager.enqueue(config, [msg])` → 写 inbox（emit `message_enqueued`，但 source="user" 不进 enqueue view，PRD §5.2 user 气泡立即入列）。
3. `AgentManager.activate(config)` → 启动 AgentLoop（异步，不 await run 完成）。
4. 返回 `{ runId }`（前端用 runId 关联 SSE `run_end`）。

**run 进度**：前端**不**从这个端点拿流式响应；改通过 `POST /sse/subscribe { topic:"agent_loop", group:"session_id:<sid>" }` 订阅，经 SSE 收 `run_start` / `message_*` / `tool_*` / `run_end` 等事件（见 §4）。

**错误**：`404` session 不存在；`400` `content` 空；`400` `providerId` 提供但不命中；`409` 该 session 已有 run 在跑（activate 返回 `already_running` 时——前端 UX：禁用 send 直至 `run_end`）。

## 4. SSE Channel

复用全局单链路（`sse_channel.md §2-§4`）：前端一条 SSE connection（GET /sse）+ 多 (topic,group) 订阅（POST subscribe/unsubscribe）。

### 4.1 `GET /sse` — SSE 流

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/sse` | 全局单 SSE connection；接收所有已订阅 (topic,group) 的事件帧 | `200` · `Content-Type: text/event-stream` · `cache-control: no-cache` |

**SSE 帧格式**（每帧一条 `data:` 行，JSON payload）：

```
data: {"topic":"agent_loop","group":"session_id:01KV...","data":<AgentEvent>,"timestamp":"2026-06-21T..."}

```

- `data` = `AgentEvent`（见 `agent_event.md §8`，topic=`agent_loop`）。
- 前端按 `${topic}:${group}` 分发到 handler。

### 4.2 `POST /sse/subscribe` — 订阅 (topic, group)

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/sse/subscribe` | 后端 `hub.sub(topic, group, listener)`，listener 收 event 转 SSE 帧 | `SubscribeBody` | `200` + `{ ok: true }` |

**请求体**：

```typescript
interface SubscribeBody {
  topic: string;            // "agent_loop"（v0.0.8 唯一）
  group: string;            // "session_id:<sid>"
}
```

**幂等**：同 (topic,group) 重复订阅不重复登记（key=`${topic}:${group}` 去重）。

### 4.3 `POST /sse/unsubscribe` — 取消订阅

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/sse/unsubscribe` | 后端 `hub.unsub(subscription)` | `SubscribeBody` | `200` + `{ ok: true }` |

**错误（subscribe/unsubscribe 共享）**：`400` body 非法 / topic 不存在（v0.0.8 仅 `agent_loop` 合法）。

## 5. 典型时序（路径 A：发消息收纯文本回复）

```
1. POST /session                       → 201 { id: S1 }
2. POST /sse/subscribe { topic:"agent_loop", group:"session_id:S1" }   → 200
3. POST /session/S1/messages { content:"你好" }                         → 202 { runId: R1 }
4. GET /sse (保持连接，收事件帧):
     data:{topic:"agent_loop",group:"session_id:S1",data:{type:"run_start",runId:R1,...}}
     data:{...,data:{type:"message_start",messageId:M1,role:"assistant"}}
     data:{...,data:{type:"text_block_delta",blockId:B1,delta:"你"}}
     data:{...,data:{type:"text_block_delta",blockId:B1,delta:"好"}}
     data:{...,data:{type:"message_end",messageId:M1}}
     data:{...,data:{type:"run_end",runId:R1,stopReason:"no_tool_call"}}
5. （前端可选）GET /session/S1/messages?limit=50 → 拉完整 transcript 兜底
```

## 5.1 `GET /session/:id/summary` — 摘要只读端点（D2）

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/session/:id/summary` | 读 session 当前 summary（compact 后产生）；使 path D compact 可观测 | `200` + `{ summary: SummaryInfo \| null }` |

**响应字段**（`SummaryInfo` 对齐 `specs/tech/agent/context_and_memory/[P0]context_snapshot_interface.md §2`）：

```typescript
interface SummaryInfo {
  version: number;
  summaryUpTo: string | null;   // 摘要覆盖到的最新 messageId（ULID）
  content: string | null;        // 压缩后的 summary 文本
  createdAt: string;
  updatedAt: string;
}
```

**行为**：
- session 无 summary（未触发过 compact）→ `summary: null`。
- compact 产生后由 `SessionStore.setSummary` 写入，本端点直接读回（只读，不触发 compact）。
- compact 触发逻辑在 `ContextEngine.compact`（agent-loop task-5 实现）：char × 1.0 估算超 `contextWindow.tokenLimit` 时推进。

**错误**：`404` session 不存在；`405` 非 GET。

**用途**：path D（多轮→compact）的 AT/ET 通过本端点断言 compact 已发生（summary 非 null + summaryUpTo 推进），无需直接读 store。

## 6. 错误码汇总（v0.0.8 新端点）

| HTTP | 场景 |
|------|------|
| `400` | 非法 JSON / 字段缺失 / 校验失败 / `providerId` 不命中 |
| `404` | session 不存在 |
| `409` | session 已有 run 在跑（POST messages 时） |
| `500` | server 内部错误（EventBus / SessionStore / AgentManager 异常） |

## 7. credentials 与安全（沿用 `02-llm-chat.md §3.2`）

- API key 仅 server 持有（读 app_config `providers[providerId].credentials.key`），前端请求体**不传 key**。
- 所有端点 loopback only（`127.0.0.1`），无 TLS。

## 8. AT（API Test）覆盖映射（PRD §6 关键路径）

| 路径 | 端点组合 |
|------|---------|
| A：新建会话→发消息→纯文本回复 | POST /session → POST /sse/subscribe → POST /session/:id/messages → GET /sse（断言 run 序列 + run_end stopReason=no_tool_call） |
| B：发消息→调工具→result 回灌→续答 | POST /session/:id/messages → GET /sse（断言 tool_call_* / tool_result_* 序列 + 续 message_start） |
| C：run 异常→error 事件 | mock 注入 error → GET /sse 断言 error 事件 + run_end stopReason=error |
| D：多轮→compact | mock 触发 char 估算超阈值 → GET /sse 断言后续 assemble 含 summary（间接：续答正常 + 无报错） |
| E：打开旧会话→分页续载 | GET /session/:id/messages?limit=50 → GET .../messages?beforeId=<id>&limit=50 → 断言 hasMore 切换 |
| F：跨消息边界工具合并 | （ET 主覆盖；AT 可断言 SSE tool_call 事件跨两条 assistant message） |

## 9. 文档同步（doc-modifier 阶段）

- `specs/api/overall/02-llm-chat.md`：`/chat` 端点 §3 标 `[作废-被 v0.0.8 取代]`；新增章节引 v0.0.8 session/message/sse 端点（或拆出 `04-agent-session.md` 若超 300 行）。
- 本 change_log 为 coder 依据，不重复 overall 全量。

## 10. 版本

version: 1.0（v0.0.8 新建：删 `/chat`；新增 `/session*` CRUD + `/session/:id/messages` 分页/发送 + `/sse*` channel 端点；StopReason 经 run_end 暴露；credentials 沿用不下发）
