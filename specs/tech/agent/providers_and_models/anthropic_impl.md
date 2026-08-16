---
type: design
title: Anthropic Protocol Impl（anthropic_messages）
priority: P0
status: active
updated: 2026-07-23
since: v0.0.3
related: [[P0]llm_protocol_interface.md, [P0]cache_control.md]
---

# Anthropic Protocol Impl（anthropic_messages）

> `llm_protocol` 扩展点的 `anthropic_messages` impl 实现细节：encode / parse / parseStream + **cache control（prompt caching）策略**。
> 契约见 `[P0]llm_protocol_interface.md`（LlmProtocol）；message 形态见 `../message/[P0]agent_message_interface.md`。
>
> **impl 物理归 plugin 目录（v0.0.191）**：本 impl 的所有代码（provider/protocol/encode/parse-stream）落在 `app/plugins/builtins/llm_anthropic/`（builtin plugin，经 EP 注册 + `llm-client-factory` 按 implId 解析）。主干 `app/server/src/llm/` 只留 **`LlmProvider` / `LlmProtocol` 接口 + canonical/wire 类型 + cross-impl 共用工具**（credentials / logical-view / client / http_error / resolve-provider-config）。EP 机制（`LlmProviderPoint` / `LlmProtocolPoint` list cardinality）+ `llm-client-factory` 按 implId 解析不变。plugin 对主干是 `import type`（接口/类型）+ 极少量值 import（`pickKeyValue` from `credentials`，packaged 经 `build-plugins.ts` 的 `SERVER_IMPORT_RE` 改写为 `@app/server/dist/llm/credentials`）。
>
> **多端点服务**：本 impl 同时服务多个 `anthropic_compatible` 端点——**Anthropic 原生**、**minimax**（baseUrl=`https://api.minimaxi.com/anthropic`）、**volcengine**（baseUrl=`https://ark.cn-beijing.volces.com/api/coding`，model `glm-5.2`，ark coding 端点背后代理 Claude）。encode/path/contentType/cache control 策略对各端点**一致**（均兼容 anthropic wire schema）。差异仅在 **wire usage 字段语义**（§5.1 校准点）+ volcengine 两条校准点：
> - **`max_tokens` 必须非 0**（caller 传入的输出预算，见 agent_loop_base §2.1）：volcengine 严格按字面执行 `max_tokens:0` → 立即 `stop_reason:"max_tokens"`、0 内容；minimax 容忍 0（曾掩盖 bug）。**教训：encode 的 `?? 0` 兜底是静默截断隐患，caller 必须显式传 maxTokens。**
> - **`tool_stream: true`**：wire body 顶层字段（与 `stream` 并列）。部分厂商（volcengine ark）支持，控制 tool 调用参数增量流式（`input_json_delta`）；不支持该字段的厂商（minimax/原生 anthropic）按 SSE 规范忽略未知顶层字段（实测 minimax 无回归）。

## 1. 定位

`anthropic_messages` impl 把 canonical 请求翻译成 Anthropic Messages API（`/v1/messages`）wire body，解析响应 / 流式。本文件补充实现细节，重点是 **cache control**。

## 2. 标准值（代码常量）

| 项 | 值 |
|---|---|
| path | `/v1/messages` |
| contentType | `application/json` |
| label `[v0.0.53]` | `Anthropic Messages 风格` |
| system 落点 | `top_level`（顶层 `system` 参数，见 protocol §3.5） |

## 3. encode（canonical → wire）

- **role 映射**：framework role → anthropic role（`user` / `assistant`；`system` 提到顶层；`tool` 的 ToolResultBlock 作 user content block，见 protocol §4 多模态表）。**[v0.0.25 BUG-002]** `role:"tool" → role:"user"` 映射 + `encodeAnthropicMessages` 合并相邻同 role（见 protocol §2 「外层 message role 转换规则」+「连续同 role 合并规则」）—— encode 层修复覆盖 eager+forked 两条路径。
- **system**：从 `messages[]` 读 `role:"system"` → 顶层 `system`。为支持 cache_control，encode 为 **content block array**（见 §4）
- **content blocks**：TextBlock / ImageBlock / ToolCallBlock / ToolResultBlock → anthropic wire block（protocol §4 表）

wire body 基础示例见 protocol §4；下面 §4 在其上加 cache_control。

## 4. cache control（prompt caching）★

> 权威契约见 `[P0]cache_control.md`（目标机制 + 两层独立 + 核心原则）。本节是 anthropic_messages impl 的**落地细节**。

Anthropic prompt caching。每次 encode 注入 **3 个 cache_control breakpoint**（system 末 + tools 末 + messages 末）+ **历史 reminder 块全保留进 wire**（v0.0.361），最大化缓存命中（机制详见 cache_control.md §3）：

1. **bp#1 — system 末 block**：顶层 `system` 的末 content block 加 `cache_control`（system 跨 turn 极稳）。
2. **bp#T — tools 末位 tool**：wire `tools` 数组末位 tool 定义加 `cache_control`（工具集 run/session 级稳定；三层各自锚定，任一层变更不拖垮其余缓存）。
3. **bp#2 — 最末 message 最末 block**：固定打 messages 末 block（无反向扫描、无避让）。历史 reminder 块 append-only 字节稳定 → bp#2 前缀 = 稳定历史 + 本轮新块 → 每轮命中上一轮条目，只有新块计费。

**ttl：默认**（ephemeral，不指定 `ttl` 字段 = Anthropic 默认 5 分钟）。

```json
{
  "system": [
    { "type": "text", "text": "你是助手...", "cache_control": { "type": "ephemeral" } }
  ],
  "tools": [
    { "name": "bash", "description": "...", "input_schema": {}, "cache_control": { "type": "ephemeral" } }
  ],
  "messages": [
    { "role": "user", "content": [ { "type": "text", "text": "历史...（含历史 reminder 块，append-only 全保留）" } ] },
    { "role": "user", "content": [
      { "type": "text", "text": "用户正文" },
      { "type": "text", "text": "[system_reminder]\n- ...当轮 reminder...", "cache_control": { "type": "ephemeral" } }
    ]}
  ]
}
```

**实现**（`encodeAnthropicMessages` + `encodeTools`）：
- **system bp#1**：encode 时转 content block array（若原始是 string），给末 block 加 `cache_control: { type: "ephemeral" }`。
- **tools bp#T**：`encodeTools` 末位 tool 定义加 `cache_control`（原纯映射无注入，v0.0.361 新增）。
- **messages bp#2**：encode 完成后给最末 message 最末 block 固定注入（无反向扫描、无避让；旧 `injectLastNonReminderCacheControl` 已删）。
- **历史块全保留**：各 message 一视同仁 encode，无 reminder drop（旧 `encodeMessage` 的 `lastKeptReminderIdx` 过滤已删）。
- **`isSystemReminder` 不进 wire**：`encodeContentBlock` text 分支只取 `{type:'text', text: b.text}`，丢弃块级标记字段（LLM 零侵入）。

> Anthropic 限制：最多 4 breakpoints；本规则用 3 个，留余量。cache_control 在 encode 翻译时注入（protocol impl 职责）。
> cache 命中在 `Usage.input_cache_read` 体现（见 `../session/[P0]session_usage.md §1` Usage 的 cache 拆分；命中 = 省 token / 钱）。

## 4a. stop_sequences（SquadChat EOS）`[v0.0.33.2]`

- **核心概念**：`RequestParams.stop` 在 `anthropic_messages` wire 中编码为 `stop_sequences`。
- **设计思路**：SquadChat 用 `<EOS>` 表示“本轮路由完毕”，优先由 provider stop sequence 截断，避免 `<EOS>` 进入流式文本；后端仍保留 strip 兜底。
- **代码路径**：`app/server/src/agent/agent-loop-stage-llm.ts.stageLLMRequest() → app/plugins/builtins/llm_anthropic/protocol-encode.ts.encodeAnthropicMessages() → app/server/src/agent/agent-loop-stage-llm.ts.stripEosToken()`。
- **接口签名**：`interface RequestParams { stop?: string[] }` —— `anthropic_messages` 映射 `body.stop_sequences=params.stop`；空数组/undefined 不写字段。
- **版本演进**：`[v0.0.33.2]` 当前仓库仅此 protocol impl 有显式 stop 映射；不要在 overall 写“GPT/DeepSeek/Gemini 已映射”，其他 provider 依赖 strip 兜底或后续实现。

## 5. parseStream（thinking / text 平行）

`parseStream` 把 anthropic SSE（`content_block_delta` 等）映射为 `StreamEvent`（见 protocol §3.6）：
- thinking block（index）→ `thinking_delta`
- text block（index）→ `text_delta`
- tool_use → `tool_call_delta`
- `message_delta` 的 usage → `usage`
- `message_stop` → `finish`

> usage 字段映射（Anthropic 原生 → 我们的 Usage，逐字段计算）见 §6。
> thinking 与 text 平行独立变体，UI 按 `messageId:partIndex` 分段（见 protocol §3.6）。

## 5.1 parseAnthropicUsage 校准点（v0.0.13 S3）

`parseAnthropicUsage(raw)` 把 wire `usage` 对象映射到 canonical `Usage` 的 9 个 token 字段（见 `../session/[P0]session_usage.md §1`）。映射规则对 Anthropic 原生已校准；**对 minimax（同 path）有 3 个未验证风险点**（design [D3] raw 抓取后固化）：

| 字段 | 当前映射（Anthropic 校准版） | minimax 风险 | 校准动作（待 raw 实测） |
|---|---|---|---|
| `input_no_cache` / `input_total_tokens` | `input_tokens` → `input_no_cache`；`input_total_tokens` = cache_read + cache_write + no_cache | 若 minimax `input_tokens` **含 cache**（与 Anthropic 语义反），则双计 → `input_total_tokens` 虚高 | raw 抓取 → 若确认含 cache：改映射 `no_cache = input_tokens - cache_read - cache_write`；若同 Anthropic（不含 cache）：维持 |
| `output_reasoning` | 恒 0（不写） | MiniMax-M3 若是 reasoning 模型，wire 可能返回独立 reasoning token（字段名待测，可能 `reasoning_tokens` / `output_tokens` 子拆 / 完全不返回） | raw 抓取 → 若有独立字段：补映射 `output_reasoning = raw.reasoning_tokens`，否则维持恒 0 |
| `input_cache_write` | `cache_creation_input_tokens` → `input_cache_write` | minimax 是否支持 prompt caching（即 wire 是否返回 `cache_creation_input_tokens`）未验证 | raw 抓取 → 若 wire 无该字段：`input_cache_write` 恒 0（维持）；若有：照常映射 |

**校准流程**（design S3 step1）：
1. 在 `app/plugins/builtins/llm_anthropic/protocol-parse-stream.ts` 临时插 `console.log('[wire-usage]', JSON.stringify(raw))`；
2. 跑 `states/v0.0.10/verify/api-test/smoke_real_llm.sh`（test.env minimax 就绪），stdout 拿 wire usage 原始字段；
3. 按上表三列决策；调整 `parseAnthropicUsage` 映射逻辑；
4. 校准产出（wire 样例 + 决策）记录在 `states/v0.0.13/verify/` 校准报告；本 spec §5.1 表格同步固化字段映射。

**不变约束**：无论 minimax 还是 Anthropic 原生，`parseAnthropicUsage` **只产 token 字段**，不填 cost/currency/char（见 `llm_protocol_interface.md` §3 [v0.0.13 S3] usage parse 边界）。

## 6. usage 映射（Anthropic 原生 → 我们的 Usage）

`parse`（非流式）/ `parseStream`（流式）把 **Anthropic 原生 usage** 翻译成我们的 `Usage`（`../session/[P0]session_usage.md §1`）。**逐字段映射与计算是 protocol impl 的契约职责**（见 llm_protocol_interface §3.7）。

### 6.1 Anthropic 原生 usage 格式

**非流式**（`response.usage`）：

```json
{
  "input_tokens": 2587,
  "output_tokens": 210,
  "cache_creation_input_tokens": 2000,
  "cache_read_input_tokens": 0
}
```

可选字段：`cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`（按 ttl 细分 cache 写入）、`service_tier`。

**流式**（SSE）usage 分两次到达：
- `message_start` → `message.usage`：`input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`（input 部分；`output_tokens` 初始为 1）
- `message_delta` → `usage`：`output_tokens`（**累积最终值**）

> **关键语义**：Anthropic `input_tokens` **不含** cache 部分（= 未缓存的普通输入）；总输入 = `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`。`output_tokens` **含** reasoning/thinking token（Anthropic **不单独报告** reasoning，见 §6.3）。

### 6.2 逐字段映射（每个 token 字段如何计算）

| 我们的 Usage 字段 | Anthropic 原生 | 计算 |
|---|---|---|
| `input_no_cache` | `input_tokens` | 直接取（未缓存输入） |
| `input_cache_write` | `cache_creation_input_tokens` | 直接取；若含 `cache_creation` 子对象则 = `ephemeral_5m_input_tokens + ephemeral_1h_input_tokens` |
| `input_cache_read` | `cache_read_input_tokens` | 直接取（命中 cache） |
| `input_total_tokens` | （无直接字段） | = `input_no_cache + input_cache_write + input_cache_read` |
| `output_total_tokens` | `output_tokens` | 取最终累积值（流式 = `message_delta` 的 `output_tokens`；非流式 = `response.usage.output_tokens`） |
| `output_reasoning` | （Anthropic 不报告） | = **0**（见 §6.3） |
| `output_response` | （无直接字段） | = `output_total_tokens − output_reasoning`（reasoning=0 → = `output_total_tokens`） |
| `total_tokens` | （无直接字段） | = `input_total_tokens + output_total_tokens` |

> 每个 token 字段的计算口径**必须**如上完整可追溯（vendor 原生字段 → 我们的字段 → 计算式），无遗漏、无歧义。

### 6.3 output_reasoning 限制

Anthropic `output_tokens` **包含** extended thinking / reasoning token，但 usage **不单独报告** reasoning 数量（不同于 OpenAI 的 `completion_tokens_details.reasoning_tokens`）。故：
- `output_reasoning = 0`（占位，无法从原生 usage 拆出）
- `output_response = output_total_tokens`（reasoning 归入 response 口径）
- 等 Anthropic 未来支持 reasoning 细分时再补映射

### 6.4 cost / currency / char 不归 protocol impl

protocol impl **只填 §6.2 的 token 字段**；以下字段由其他层填，impl 置默认：

| 字段 | 归属 | 说明 |
|---|---|---|
| `cost` | `LlmClient.computeCost` | 按 modelConfig.pricing 算（消费 `input_no_cache`/`output_total_tokens`/`input_cache_read`/`input_cache_write`，见 llm_client_interface §2）；impl 置 0，client 覆盖 |
| `currency` | `LlmClient` | 填 `modelConfig.pricing.currency` |
| `inputCharCount` | agent loop | 从 assemble snapshot 填（`snapshot.inputCharCount`） |
| `outputCharCount` | `LlmClient` | 统计 LLM 输出 char |

### 6.5 流式 usage 产出

`parseStream` 内部累积：缓存 `message_start` 的 input 字段，在 `message_delta` 收到最终 `output_tokens` 时产出**完整** `Usage`（§6.2 全字段填齐）作为一个 `{type:"usage", usage}` 事件。消费方（agent loop）取该事件为最终 usage。

## 7. 边界

| 零件 | 归属 |
|---|---|
| anthropic encode / parse / parseStream + cache control 2-bp 策略 | 本文（anthropic_impl）✅ |
| **Anthropic 原生 usage → 我们 Usage 逐字段映射（§6）** | 本文（anthropic_impl）✅ |
| LlmProtocol 契约 + 多模态编码表 + StreamEvent | llm_protocol_interface |
| 标准值（path / contentType）自承载 | impl 代码常量 |
| HTTP 调用 / 编排 / cost 计算（computeCost） | llm_client_interface |
| Usage 类型权威 + cache 拆分口径 + char 字段归属 | session_usage |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
