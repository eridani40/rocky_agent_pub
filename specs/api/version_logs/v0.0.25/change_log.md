# v0.0.25 API Spec 变更日志 — LLM 调用错误处理 / 自适应重试（llm-opt）

> 概述：**backend-only**。本版本对 HTTP API（`/messages` / `/session/:id/messages` / `/sse`）的 wire 契约改动**极小**（端点形状不变），主要是：
> 1. **BUG-002 协议修复**：anthropic 兼容协议不再 422（wire body 中 message role 转换规则在 server encode 层固化）。
> 2. **错误响应不再塌缩 `LOOP_ERROR`**：agent loop 错误事件带 `LlmErrorCategory`（langfuse generation metadata 可查；SSE `error` 事件带 category 字段）。
> 3. **`llm_request` config group**：新增 `GET/PUT /config/app/llm_request` 端点（按 `03-config-center.md` 既有 `/config/app` 模式）。
> 4. **物理层 wire body 记录（BUG-001）**：langfuse generation metadata 新增 `physical_wire_body` 字段（非 HTTP 端点改动，是 observability 字段补充）。
> 5. **[rev2 改版] 错误外显增强**：SSE error 事件加 `displayReason` + `errorDetail`（§1.2）；新增 `llm_attempt` SSE 事件实时外显 retry/fallback 进度（§1.4）；Run/RunRecord 加 `RunErrorInfo`（errorCategory+displayReason+errorDetail，§1.5）；LlmErrorCategory 枚举扩至 19 值（加 `MAX_TOKENS_TOO_HIGH` + `EMPTY_RESPONSE`，§4）。
>
> 权威 tech spec：`specs/tech/agent/llm_caller/`（6 文件，rev2 改版）+ `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §9.1` + `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md`（rev2 详细附录）+ 4 件套修订。

---

## 1. 端点契约变更

### 1.1 `/messages` / `/session/:id/messages`（无 wire 形状变化）

- **请求体不变**：`{ providerId, modelId, messages[], ... }`（caller 不感知 LlmCaller 内部 retry / fallback）。
- **响应 SSE wire event 不变**：仍复用 `StreamEvent`（`02-llm-chat.md §3` / `04-agent-session.md`）。
- **内部行为变化**：server 内部从 `client.stream` 改为 `llmCaller.invoke`（对 caller 透明；caller 看到的仍是同形态 SSE 流）。
- **新增 SSE error 事件 category 字段**（见 §1.2）。

### 1.2 SSE error 事件带 LlmErrorCategory + displayReason + errorDetail

agent loop 失败时 SSE error 事件（`04-agent-session.md` 定义）**[v0.0.25 rev2 改版]** 携带完整 error 三件套（不再只 errorCategory）：

```json
{
  "type": "error",
  "errorCategory": "PROVIDER_OVERLOADED",
  "displayReason": "服务商过载，请稍后重试",
  "errorDetail": "anthropic overloaded_error ...",
  "message": "all fallback chain items unavailable"
}
```

- `errorCategory`：`LlmErrorCategory` 枚举值（见 `specs/tech/agent/llm_caller/[P0]error_normalization.md §1`，**[rev2] 19 值**——新增 `MAX_TOKENS_TOO_HIGH` + `EMPTY_RESPONSE`）。
- **[rev2 新增] `displayReason`**：用户可读理由（从 category 派生，完整映射表见 `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §1`）。前端可直接显示。
- **[rev2 新增] `errorDetail`**：raw provider message（给 debug tooltip / log，不直接给终端用户）。
- **不再塌缩 `LOOP_ERROR`** —— 整链全 dead 时按真实原因给 category（如 `PROVIDER_OVERLOADED` / `RATE_LIMITED` / `AUTH_INVALID` / `CONTENT_FILTERED` / `CONTEXT_LENGTH_EXCEEDED` / `MAX_TOKENS_TOO_HIGH` / `EMPTY_RESPONSE` 等）。
- **用户 abort**：不走 error 事件，走 `run_end`(stopReason=`interrupted`)（partial 在前序 `text_delta` 已流给 caller）。

> **caller 不需改**：errorCategory / displayReason / errorDetail 都是新增可选字段（向后兼容）；旧 caller 仍读 `message` 字段。

### 1.3 `GET/PUT /config/app/llm_request`（新端点）

按 `03-config-center.md` 既有 `/config/app` 模式，新增 llm_request group 的读写：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/config/app/llm_request` | 取 llm_request config（record 不存在返回 DEFAULT_LLM_REQUEST_CONFIG） |
| PUT | `/config/app/llm_request` | 整体替换 llm_request config |

**GET 响应**：

```json
{
  "timeout":     { "ttfb_s":45, "stall_answer_s":30, "stall_think_s":30, "stall_tool_s":120, "wall_max_s":600 },
  "retry":       { "max_attempts":3, "backoff_base_s":2, "backoff_cap_s":30, "jitter":true },
  "degradation": { "cooldown_s":300, "consecutive_to_degrade":3, "respect_retry_after":true },
  "length":      { "auto_compress":true, "precompress_threshold_ratio":0.8, "max_tokens_bump_strategy":"continue" },
  "fallback_chain": []
}
```

**PUT 请求体**：同上结构（整体替换）。

> 配了按配置走（如改 `max_attempts=5` 生效）；不配走默认值。schema 完整定义见 `specs/tech/agent/llm_caller/[P0]llm_request_config.md §1`。

### 1.4 [rev2 新增] SSE `llm_attempt` 事件（retry/fallback 实时进度）

LlmCaller attemptLoop 在 retry / fallback 过程中**实时**发 `llm_attempt` 事件（通过 agent loop 的 onEvent 转发，走同 SSE 流），让 caller（前端）能显示「重试中…」「切换备用模型…」进度提示：

```json
{
  "type": "llm_attempt",
  "category": "RATE_LIMITED",
  "providerId": "01KVC9A2...",
  "modelId": "claude-sonnet-4-6",
  "keyRef": "default",
  "attempt": 2,
  "action": "FALLBACK"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | `"llm_attempt"` | 事件类型标识 |
| `category` | `LlmErrorCategory` | 本次 attempt 失败的错误分类（首次成功不发本事件） |
| `providerId` / `modelId` / `keyRef` | string | 失败目标的四元组（缺 sessionId，sessionId 由 SSE group 隐含） |
| `attempt` | number | 第几次 attempt（1-based） |
| `action` | `"RETRY"` \| `"ROTATE_KEY"` \| `"FALLBACK"` \| `"FAIL"` | decide 产的动作 |

**emit 时机**（见 `specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3.1`）：每次 catch 到 error 后 decide 产 action 时发一次；attempt 1 首次成功不发；整链 all_dead 发 `action:"FAIL"`；用户 abort 不发（走原 abort 路径）。

**caller 语义**：可选消费——前端据 `action` 显示进度（RETRY→「重试中」/ ROTATE_KEY→「切换凭证」/ FALLBACK→「切换备用模型」/ FAIL→进入 error 终态）。不阻塞主流程（仍按 message_* / run_end 契约收尾）。旧 caller 忽略本事件即可（向后兼容）。

### 1.5 [rev2 新增] Run/RunRecord error 字段 + GET /session 返回的 finish_reason 形态

**Run/RunRecord 在 stopReason="error" 时携带 `RunErrorInfo`**（见 `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §9.1`）：

```typescript
interface RunErrorInfo {
  errorCategory: LlmErrorCategory;   // 19 值枚举（rev2 加 MAX_TOKENS_TOO_HIGH + EMPTY_RESPONSE）
  displayReason: string;             // 用户可读理由（完整映射表见 specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §1）
  errorDetail?: string;              // raw provider message（debug / log）
}
```

**GET /session/:id 响应**（currentRun / 历史 runs）在 run 失败时返：

```json
{
  "currentRun": {
    "id": "01KV...",
    "status": "error",
    "stopReason": "error",
    "error": {
      "errorCategory": "AUTH_INVALID",
      "displayReason": "认证失败，请检查 API Key",
      "errorDetail": "anthropic authentication_error: invalid x-api-key"
    }
  }
}
```

**GET /session/:id/messages 响应**：messages transcript 不变（error 不产生 assistant message；用户 abort 时 partial text 已在前序 text_delta 事件落 message）。finish_reason 的真相源是 Run.stopReason + Run.error（不在 message 上冗余）。

**errorCategory → displayReason 映射表**（权威定义在 `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §1`）：AUTH_INVALID→「认证失败，请检查 API Key」/ RATE_LIMITED→「模型限流，请稍后重试」/ PROVIDER_OVERLOADED→「服务商过载，请稍后重试」/ EMPTY_RESPONSE→「模型返回空响应」/ MAX_TOKENS_TOO_HIGH→「输出长度超限（请求参数越界）」/ NETWORK→「网络错误，请检查网络连接」/ TIMEOUT_*→「响应超时」/ 等（共 17 行可显 + ABORTED_BY_USER 不走 error）。

**SSE error 事件**也带同三件套（见 §1.2）；GET /session 与 SSE error 事件字段同源（都从 RunErrorInfo 派生），保证前端无论从哪个通道读，errorCategory/displayReason 一致。

---

## 2. BUG-002 协议修复（api spec 重点）

### 2.1 问题（修复前）

调用 anthropic 兼容 message protocol（`/v1/messages` 端点）返回 422：

```json
{"detail":[{"type":"literal_error","loc":["body","messages",2,"role"],
  "msg":"Input should be 'user', 'assistant' or 'system'","input":"tool"}]}
```

端点拒收 `role:"tool"`（只接受 `{user, assistant, system}`）。

### 2.2 修复后 wire body 规则

server encode 层（`protocol-encode.ts encodeMessage`）对 anthropic_messages protocol 做：

**(1) 外层 message role 映射**：

| canonical `Message.role` | anthropic wire `role` |
|---|---|
| `system` | （提取到顶层 `system` 参数） |
| `user` | `user` |
| `assistant` | `assistant` |
| **`tool`** | **`user`** |

库内 Message 仍 `role:"tool"`（符合 `specs/tech/agent/message/[P0]agent_message_interface.md §1` role 模型）；encode 边界转 `user`。

**(2) 连续同 role 合并**（保证严格交替）：

`encodeAnthropicMessages` 在 role 映射后，合并相邻同 role（content 数组拼接）：

- 多个连续 tool result（`tool→user` 后变连续 user）→ 合并为单条 user message（content 数组含多个 `tool_result` block）。
- tool result 紧跟 user（`tool→user` 后与下条 user 连续）→ 合并。

### 2.3 wire body 示例（修复后）

**输入 canonical messages**（多 tool result + 紧跟 user）：

```json
[
  {"role":"user","content":[{"type":"text","text":"调工具A和B"}]},
  {"role":"assistant","content":[{"type":"tool_use","id":"t1",...},{"type":"tool_use","id":"t2",...}]},
  {"role":"tool","content":[{"type":"tool_result","tool_use_id":"t1","content":"结果A"}]},
  {"role":"tool","content":[{"type":"tool_result","tool_use_id":"t2","content":"结果B"}]},
  {"role":"user","content":[{"type":"text","text":"继续"}]}
]
```

**输出 wire body messages**（role 映射 + 相邻合并，严格交替）：

```json
[
  {"role":"user","content":[{"type":"text","text":"调工具A和B"}]},
  {"role":"assistant","content":[{"type":"tool_use","id":"t1",...},{"type":"tool_use","id":"t2",...}]},
  {"role":"user","content":[
    {"type":"tool_result","tool_use_id":"t1","content":"结果A"},
    {"type":"tool_result","tool_use_id":"t2","content":"结果B"},
    {"type":"text","text":"继续"}
  ]}
]
```

端点接受（200，非 422）。

### 2.4 验收口径（api case）

- 多 tool result 连续 + tool 紧跟 user 的请求 → wire body 中无 `role:"tool"`（全转 user）。
- 端点返 200（非 422 literal_error）。
- 覆盖 eager + forked 两条路径（forked-agent 的 tool message 不走 assemble，encode 层修复必须覆盖）。

完整规则见 `specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2`（「外层 message role 转换规则」+「连续同 role 合并规则」）。

---

## 3. langfuse generation metadata 补全（BUG-001）

非 HTTP 端点改动。langfuse generation（`startGeneration` / `endGeneration`）metadata 新增字段：

| 字段 | 来源 | 用途 |
|---|---|---|
| `physical_wire_body` | `LlmClientOptions.onWire` 钩子（encode 后 fetch 前记录） | 物理层 wire body（含 tool_result content 原文），与逻辑层 input（snapshotMessages）diff 对账 |
| `errorCategory` | LlmCaller.invoke catch 块 `endGeneration({status:"error", errorCategory})` | 错误分类（LlmErrorCategory），不再笼统 LOOP_ERROR |
| `retry_chain` | LlmCaller attemptLoop | 每次 attempt 的 `{providerId, keyRef, attempt, category, delay}` 链 |

**验收口径**（api case P7）：
- tool 调用后读 langfuse generation metadata → 含 `physical_wire_body` 字段。
- wire body 中 tool_result content == 逻辑 input（无 `...`）。
- 下一 iteration LLM 看到真实 tool result（非 `...`）。

---

## 4. 错误归一化 category 列表（caller 可见）

LlmCaller 内部归一化的 **[rev2] 19 个 category**（见 `specs/tech/agent/llm_caller/[P0]error_normalization.md §1`），其中 caller（api-verifier / langfuse）可见的：

| category | 含义 | SSE error 事件示例 message |
|---|---|---|
| `PROVIDER_OVERLOADED` | provider 容量不足 | "provider X overloaded, fallback exhausted" |
| `RATE_LIMITED` | per-key/account 限流 | "rate limited on (X, default), no fallback" |
| `AUTH_INVALID` | key 失效 | "auth invalid for key Y of provider X" |
| `CONTENT_FILTERED` | 内容审核拒绝 | "content filtered by provider" |
| `CONTEXT_LENGTH_EXCEEDED` | 输入超长且压缩失败 | "context length exceeded even after compact" |
| `MAX_TOKENS_EXCEEDED` | 输出触顶到硬上限（升） | "max_tokens reached model hard limit" |
| **`MAX_TOKENS_TOO_HIGH`** [rev2] | 请求 maxTokens 越界（降 ×0.7） | "request max_tokens exceeds model max" |
| **`EMPTY_RESPONSE`** [rev2] | 流 finish 但空响应（纯重试） | "model returned empty response" |
| `ABORTED_BY_USER` | 用户中断（不走 error，走 interrupted） | "aborted by user (partial preserved)" |
| `TIMEOUT_FIRST_CHUNK` / `TIMEOUT_INTER_CHUNK` | 看门狗超时重试耗尽 | "timeout after N retries" |
| ... | （完整 19 值见 tech spec） | |

---

## 5. 整体验收门禁（api-level）

- **零塌缩**：所有 LLM 错误带 `LlmErrorCategory`（langfuse generation metadata 可查 `errorCategory`，不再 LOOP_ERROR）。
- **[rev2] provider 健康 per-session × per-model 隔离**：同 session 内多 run 共享健康表（session A run1 触发某 model 冷却，run2 立即跳过）；跨 session 隔离（session A 的冷却不影响 session B 用同 model）；同 provider 不同 model 独立（opus overload 不连坐 sonnet）。
- **[rev2] recentErrors 连续错误 + 成功清空**：连续 MAX_TOKENS_TOO_HIGH → buildRequest 派生降 maxTokens ×0.7；成功调用 → clearRecentErrors → 下次 buildRequest 用原 maxTokens（langfuse trace 可查 recentErrors 链 + maxTokens 派生值）。
- **[rev2] finish_reason 完整**：run 失败时 Run.error 携带 errorCategory + displayReason + errorDetail（GET /session/:id 可查 + SSE error 事件同源）；ABORTED_BY_USER 走 interrupted 不走 error。
- **[rev2] llm_attempt SSE 实时进度**：retry/fallback 过程发 llm_attempt 事件（action=RETRY/ROTATE_KEY/FALLBACK/FAIL）；前端可消费显示进度。
- **config 接线**：`PUT /config/app/llm_request` 改 `max_attempts=5` → 后续调用 retry 5 次（trace 可查）。
- **langfuse 闭环**：error 路径也调 `endGeneration`（无泄漏，metadata 含 `errorCategory` + `physical_wire_body`）。
- **BUG-002 修复**：多 tool result + tool 紧跟 user 的请求返 200（非 422）。

---

## 6. 不变项（澄清）

- `/chat` 端点：v0.0.8 已作废，本版本不动。
- `/provider` `/provider/:id/model` CRUD：不变（多 key credentials 是 provider 数据内部 schema 扩展，CRUD 端点形状不变，PUT `/provider/:id` 接受新 credentials 形态）。
- `/sse` `/session*` 端点形状：不变（内部走 LlmCaller，对 caller 透明）。
- 视觉保真度门禁：N/A（backend-only，无设计稿）。

---

## 7. 文件变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `specs/api/version_logs/v0.0.25/change_log.md` | 修改 | 本文件（api spec 变更日志）；[rev2] §1.2 SSE error 加 displayReason+errorDetail；§1.4 新增 llm_attempt 事件；§1.5 新增 RunErrorInfo + GET /session finish_reason 形态；§4 枚举扩至 19 值；§5 验收门禁补 per-session/per-model 隔离 + recentErrors + finish_reason + llm_attempt |
| `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md` | 新增 | [rev2] 详细附录：errorCategory→displayReason 完整映射表 §1 / resolveTarget 两遍扫描完整伪代码 §2 / Run finish_reason 收尾机制 §3（各 P0 spec 引用，保持 ≤300 行） |
| `specs/tech/agent/llm_caller/[P0]llm_request_config.md` | 修改 | [rev2] §2 LlmErrorState 加 recentErrors 连续错误历史 + clearRecentErrors；maxTokensOverlay 废弃改派生（§2.4 deriveMaxTokens = base × 0.7^downHits）；§2.2/§2.3 读写规则 + 跨 iteration 继承更新；§5.4 推翻旧 maxTokensOverlay 保留设计 |
| `specs/tech/agent/llm_caller/[P0]error_normalization.md` | 修改 | [rev2] §1 枚举加 MAX_TOKENS_TOO_HIGH + EMPTY_RESPONSE（19 值）；§3 computeHints 两值归可重试-瞬时组；§4.1 Anthropic 400 max_tokens 行改判 MAX_TOKENS_TOO_HIGH；§4.3 stop_reason 表加 EMPTY_RESPONSE 行；§6.6/§6.7 两新设计决策 |
| `specs/tech/agent/llm_caller/[P0]provider_health_registry.md` | 修改 | [rev2] health state key 改 (sessionId, providerId, keyRef, modelId) 四元组；session-scoped 存储 + cleanupSession；§2 加 isPreferred/isAvailable/getState/markDead；§6.5 推翻进程级单例改 session-scoped + per-model 隔离 |
| `specs/tech/agent/llm_caller/[P0]llm_caller_overview.md` | 修改 | [rev2] §2.2 resolveTarget 改两遍扫描（healthy 优先 → degraded 兜底）+ 四元组 key；§3 attemptLoop 数据流加 recentErrors append/clearRecentErrors + emit llm_attempt；§3.1 新增 llm_attempt event schema；§3.2 新增 RunErrorInfo；§7 BUG-005 收口 |
| `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md` | 修改 | [rev2] §9.1 新增 Run error 字段 RunErrorInfo（stopReason=error 时携带 errorCategory+displayReason+errorDetail）；run 收尾逻辑：ABORTED_BY_USER→interrupted，其他→error 填 RunErrorInfo |
| `specs/tech/agent/providers_and_models/[P0]llm_client_interface.md` | 修改 | [rev2] §3.9 BUG-005 收口：validate() 不再裸 Error→NETWORK；maxTokens 越界抛 LlmHttpError{400}→MAX_TOKENS_TOO_HIGH（降 ×0.7 重试）；temp/topP/模态越界→BAD_REQUEST_OTHER（NO_RETRY） |
| `specs/api/overall/02-llm-chat.md` | 修改 | （doc-modifier 阶段）补 SSE error 事件 errorCategory+displayReason+errorDetail；标注 callLLM 内部走 LlmCaller |
| `specs/api/overall/03-config-center.md` | 修改 | （doc-modifier 阶段）补 `/config/app/llm_request` GET/PUT 端点 |
| `specs/api/overall/04-agent-session.md` | 修改 | （doc-modifier 阶段）补 SSE error 事件三件套 + llm_attempt 事件；RunErrorInfo；langfuse metadata physical_wire_body |
