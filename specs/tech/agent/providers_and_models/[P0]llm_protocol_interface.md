---
type: interface
title: LLM Protocol Interface
priority: P0
status: active
updated: 2026-07-23
since: v0.0.3
related: [[P0]llm_provider_interface.md, [P0]llm_model_interface.md, [P0]llm_client_interface.md, anthropic_impl.md]
---

# LLM Protocol Interface

> 管什么：endpoint path、请求 body 与参数字段名、多模态输入/输出编码、响应与流式解析（纯翻译）、content-type header。这些**标准值自承载在 protocol impl（代码常量）里**，不在数据对象。
> 不管什么：凭证与 base URL（→ `[P0]llm_provider_interface.md`）、模型能力与取值约束（→ `[P0]llm_model_interface.md`）、HTTP 调用与编排（→ `[P0]llm_client_interface.md`）。
> 边界归属规则见 [docs_guide.md](../../docs_guide.md) §4。

## 1. 概述

Protocol 解决"**请求长什么样、响应怎么解**"。它是 `llm_protocol` 扩展点的一个 **ext impl（代码，per-type，无状态，自承载标准值）**：

- **`LlmProtocol`（行为契约，纯翻译，无状态，不碰网络，自承载标准值）**：把 path / contentType / paramFields（字段名映射）/ system 落点等**标准值写死在 impl 代码里**（作为 `readonly` 常量），暴露 `encode(request)` / `parse(response)` / `parseStream(chunk)`，把框架规范输入（canonical `Message[]` + 参数，见 [`[P0]agent_message_interface.md`](../message/[P0]agent_message_interface.md)）编码成 wire body，把 wire 响应/流式 chunk 解析回 canonical 形态。
- **没有 `LlmProtocolConfig` 数据对象**。protocol 标准值是 per-type 的代码常量，不是 per-instance 的数据。

Protocol 只管**编码与字段名**，不管**数值约束**（默认值/范围/上限归 model）。`encode` 不再收 `config` 参数——字段名映射在 impl 内部硬编码。少数可配置项（extra params / extra headers / 自定义 path）→ `ext_impl_config` overlay，运行时 `deepMerge(impl 代码默认, overlay)`，**P0 基本只用代码默认**。

## 2. 接口定义

```typescript
/** protocol 行为契约（纯翻译，无状态，不碰网络，标准值自承载为 readonly 常量） */
interface LlmProtocol {
  /** endpoint path，自承载，e.g. "/v1/chat/completions"。P0 用 impl 默认值；可被 ext_impl_config overlay 覆盖 */
  readonly path: string;
  /** content-type，自承载，默认 "application/json" */
  readonly contentType: string;
  /** [v0.0.53] 人类可读展示名（UI 下拉用，e.g. "Anthropic Messages 风格"）。与 ProtocolName id 正交：id 是 wire/持久化标识，label 是 UI 展示文本 */
  readonly label: string;
  /** canonical → wire：字段名映射 / system 落点 / 多模态编码全在 impl 内部，不收 config */
  encode(request: CanonicalRequest): WireBody;
  /** wire 响应 → canonical 响应 */
  parse(response: WireResponse): CanonicalResponse;
  /** SSE chunk → 事件（流式用） */
  parseStream(chunk: string): StreamEvent[];
}

type ProtocolName =
  | "anthropic_messages"
  | "openai_chat_completions"
  | "openai_responses"
  | "gemini_generateContent";

interface CanonicalRequest {
  modelId: string;
  messages: Message[];          // 来自 [P0]agent_message_interface.md；含 role:"system" 的 system message
  tools?: ToolDefinition[];
  params: RequestParams;        // 框架规范参数，键名固定
}

interface RequestParams {
  maxTokens?: number;           // 框架统一键名
  temperature?: number;
  topP?: number;
  stream?: boolean;
  stop?: string[];              // [v0.0.33.2] EOS stop sequences；当前仓库仅 anthropic_messages encode 映射 stop_sequences
  effort?: 'default' | 'low' | 'high' | 'max';   // 推理强度档位（canonical 语义键，4 档；详见 §3.8）。'default' = 厂商默认行为（encode 不注入 wire 字段）
  // 注：system prompt 不在此——它以 role:"system" 的 message 存于 messages[]，
  // encode 时从 messages[] 读出，落点（顶层参数 / messages[0]）由 impl 内部决定（见 §3.5）。
}
```

### encode / parse / parseStream 契约

protocol 只做**纯翻译**（不碰网络），I/O 与编排由 `LlmClient` 负责（见 `[P0]llm_client_interface.md`）。

```typescript
// canonical → wire 请求体（字段名映射 / system 落点 / 多模态编码全在 impl 内部，不收 config）
encode(request: CanonicalRequest): WireBody;

// wire 响应 → canonical 响应
parse(response: WireResponse): CanonicalResponse;

// SSE chunk → 事件（流式用）
parseStream(chunk: string): StreamEvent[];
```

类型定义：

```typescript
type WireBody = Record<string, unknown>;      // 各 protocol 自定义，可 JSON 序列化

interface WireResponse {
  status: number;
  body: unknown;                               // 已解析的响应 JSON
}

interface CanonicalResponse {
  message: Message;                            // assistant 消息（含 ContentBlock[]），见 [P0]agent_message_interface.md
  usage: Usage;                                // 见 [P0]agent_message_interface.md §2
  stopReason: "stop" | "tool_use" | "max_tokens";
}
```

### 多模态编码（canonical ContentBlock ↔ wire block）

protocol 负责 `Message.content` 中每个 `ContentBlock`（见 `[P0]agent_message_interface.md` §4）与 wire block 的双向翻译。模型**是否支持**某模态由 model 判定，protocol 只管**怎么编码**。

| 框架 canonical | Anthropic wire | OpenAI wire |
|---|---|---|
| `TextBlock` | `{ type:"text", text }` | `{ type:"text", text }` |
| `ImageBlock` | `{ type:"image", source:{...} }` | `{ type:"image_url", image_url:{ url } }` |
| `AudioBlock` | `{ type:"audio", source:{...} }` | `{ type:"input_audio", input_audio:{...} }` |
| `VideoBlock` | （按 provider 支持编码） | （按 provider 支持编码） |
| `ToolCallBlock` | `{ type:"tool_use", id, name, input }` | `tool_calls:[{ id, function:{ name, arguments } }]` |
| `ToolResultBlock` | `{ type:"tool_result", tool_use_id, content }` | `{ role:"tool", tool_call_id, content }` |

### 外层 message role 转换规则（v0.0.25 BUG-002）

**背景**：canonical `Message.role` 集合是 `{ system, user, assistant, tool }`（见 `[P0]agent_message_interface.md §1`，OpenAI Chat Completions 风格）；anthropic Messages API 端点只接受 `role ∈ { system, user, assistant }`，**拒收 `role:"tool"`**（422 literal_error，见 BUG-002）。

**结论**：`encodeMessage`（canonical → wire 边界，每条 message）做 role 映射：

| canonical `Message.role` | anthropic wire `role` | 备注 |
|---|---|---|
| `system` | （提取到顶层 `system` 参数，不放 messages 数组） | 见 §3.5 system 落点 |
| `user` | `user` | 原样 |
| `assistant` | `assistant` | 原样 |
| **`tool`** | **`user`** | **关键修复**：库内 Message 仍 `role:"tool"`（符合 message types §1 role 模型），encode 边界转 `user`，content block 用 `ToolResultBlock → {type:"tool_result",...}`（见上表） |

**落点必须在 `encodeMessage`（encode 层），不是 assemble reducer**：BUG-002 排查发现 `forked-agent.ts:181-184` 的 tool message **不走 assemble pipeline**（直接 `state.messages.push`），只在 assemble reducer 改的方案对 forked 无效。encode 层是 canonical → wire 的最后一站，覆盖 eager + forked 两条路径（所有 message 进 wire 必经 encode）。

### 连续同 role 合并规则（v0.0.25 BUG-002）

**背景**：anthropic Messages API 要求 messages 数组中 `user` / `assistant` **严格交替**。`role:"tool" → user` 映射后会破坏交替（两种场景）：
- 多个连续 tool result（多 tool 调用）：`tool → user` 后变 `user, user, user`（连续同 role）。
- tool result 紧跟 user 消息：`tool → user` 后与下一条 `user` 连续。

**结论**：`encodeAnthropicMessages`（messages 数组编码）在 role 映射后，**合并相邻同 role 的 message**（content 数组拼接）：

```typescript
function encodeAnthropicMessages(messages: Message[]): WireMessage[] {
  const wire = messages
    .filter(m => m.role !== "system")           // system 提到顶层
    .map(m => ({ role: m.role === "tool" ? "user" : m.role, content: encodeContent(m) }));
  
  // 合并相邻同 role（user/user 或 assistant/assistant）
  const merged: WireMessage[] = [];
  for (const m of wire) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = [...last.content, ...m.content];   // content 数组拼接
    } else {
      merged.push({ ...m });
    }
  }
  return merged;
}
```

**合并语义**：content 数组拼接（user 消息的 text block + tool_result block 拼成单条 user message 的 content 数组），保持顺序。**不丢内容、不改 content block 内部**。

**为什么 encode 层兜底（而非只靠 assemble role_merge）**：assemble 的 `role_merge.ts` 只合同 role，但：(1) 它在 canonical 层合并（不会把 tool 转 user）；(2) forked 不走 assemble。encode 层的合并是 wire 边界最后兜底，保证进 wire 的 messages 严格交替。

**示例**（多个 tool result + 紧跟 user）：

canonical messages：
```
[
  { role:"user", content:[{type:"text", text:"调工具A和B"}] },
  { role:"assistant", content:[{type:"tool_use", id:"t1",...},{type:"tool_use", id:"t2",...}] },
  { role:"tool", content:[{type:"tool_result", tool_use_id:"t1", content:"结果A"}] },
  { role:"tool", content:[{type:"tool_result", tool_use_id:"t2", content:"结果B"}] },
  { role:"user", content:[{type:"text", text:"继续"}] }
]
```

encode 后 wire messages（role 映射 + 相邻合并）：
```
[
  { role:"user", content:[{type:"text", text:"调工具A和B"}] },
  { role:"assistant", content:[{type:"tool_use", id:"t1",...},{type:"tool_use", id:"t2",...}] },
  { role:"user", content:[
      {type:"tool_result", tool_use_id:"t1", content:"结果A"},
      {type:"tool_result", tool_use_id:"t2", content:"结果B"},
      {type:"text", text:"继续"}
  ]}
]
```

严格交替（user → assistant → user），端点接受。

### 流式

SSE chunk 由 `parseStream` 解析为统一事件流：

```typescript
type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_call_delta"; toolCallId: string; name?: string; argumentsDelta?: string }
  | { type: "usage"; usage: Usage }
  | { type: "finish"; reason: "stop" | "tool_use" | "max_tokens" };
```

- `thinking_delta` 与 `text_delta` 是**平行独立的变体**（来自 anthropic 不同 content block 的 `index`，见 `specs/research/v0.0.3-anthropic-protocol.md` §3）。chat UI 按 `messageId:partIndex` 把不同变体路由到不同 part 渲染（thinking 折叠面板 / answer 文本）。
- P0 仅 `anthropic_messages` impl 产出 `thinking_delta`（Anthropic extended thinking 的独立 thinking block）；OpenAI 系 protocol 当前无 thinking 概念，不产出该变体。
- v0.0.3 chat 经 server `/chat` SSE 时**复用**本 `StreamEvent`（不另定 wire event），server 把每个 `StreamEvent` 序列化为一条 SSE 帧原样推前端（见 `specs/api/overall/02-llm-chat.md` §3）。

各 protocol 的 SSE 事件类型不同（Anthropic `content_block_delta` / OpenAI `chat.completion.chunk`），`parseStream` 屏蔽差异。

> **[v0.0.13 S3] usage parse 边界**：`parseStream` 产出的 `{type:"usage"; usage:Usage}` 事件**只填 LLM 返回的 token 字段**（input_cache_read/write、input_no_cache、input_total_tokens、output_response、output_reasoning、output_total_tokens、total_tokens），**不填 cost / currency / inputCharCount / outputCharCount**。cost/currency 由 `LlmClient.stream` yield 前补齐（见 `llm_client_interface.md §3.7`）；char 由 agent loop 填（见 `session_usage.md §1`）。
>
> **[v0.0.13 S3] minimax 同 path 语义差异（待 raw 实测固化）**：minimax（providerId=`anthropic_compatible`、protocolId=`anthropic_messages`、baseUrl=`https://api.minimaxi.com/anthropic`）**走与 Anthropic 同一份 `anthropic_messages` impl**，不新增 protocol。`parseAnthropicUsage` 已映射 9 个 token 字段。**已知风险点**（design [D3.x] 待 raw 抓取后固化）：
> - **input_tokens 语义**：anthropic 的 `input_tokens` = 不含 cache 的纯新增输入；若 minimax wire 返回的 `input_tokens` **含 cache** 则会与 `input_no_cache` 双计 → `input_total_tokens` 虚高。raw 抓取后若确认含 cache，需在 `parseAnthropicUsage` 改映射逻辑（减去 cache_read/write 得 no_cache）。
> - **output_reasoning 字段**：当前 `parseAnthropicUsage` 恒不写 `output_reasoning`（值=0）。MiniMax-M3 若是 reasoning 模型并在 wire 返回 reasoning token，需确认字段名（可能是 `output_tokens` 子拆或独立 `reasoning_tokens` 字段）后补映射；否则 `output_reasoning` 恒 0、`output_total_tokens` 与 `output_response` 相等。
> - **cache_creation 字段**：anthropic 有 `cache_creation_input_tokens`；minimax 是否支持 prompt caching（即 wire 是否返回该字段）未验证。若无 → `input_cache_write` 恒 0。
>
> 上述三点属 **anthropic_impl 校准点**（见 `anthropic_impl.md §5.1`），待 `states/v0.0.13/` raw 抓取产出（`protocol-parse-stream.ts` 临时插日志跑 smoke）后于 `anthropic_impl.md` 固化字段映射 + 在校准报告记录。本文件不预先写死 minimax 字段映射（避免未实测的猜测固化进 spec）。

## 3. 设计决策

### 3.1 标准值归 protocol impl（代码），少数可配置项走 ext_impl_config overlay

**结论**：path / contentType / paramFields（字段名映射）/ system 落点等**标准值**写死在 protocol impl（`readonly` 代码常量），按 protocol name 复用同一份实现；**没有 `LlmProtocolConfig` 数据对象**。少数 per-instance 可配置项（extra params / extra headers / 自定义 path）走 `ext_impl_config` overlay，运行时 `deepMerge(impl 代码默认, overlay)`，P0 基本只用代码默认。`encode` 不收 `config` 参数——字段名映射在 impl 内部硬编码。
**理由**：path / 字段名 / system 落点是 per-protocol-type 的接口契约（不是 per-instance 的部署参数），把同类协议的不同接入点（如 OpenAI 直连 vs 自部署 OpenAI 兼容端点）抽出来用 overlay 表达即可，不必为每个 protocol type 配一个数据对象。把标准值塞进数据对象会让「换 path」与「换实现」耦合，且引入额外持久化层。
**反例**：若 path 塞进行为对象可变字段、且每次请求从 config 读，则 protocol impl 退化为数据驱动模板，纯翻译单测无法脱离 config；若把字段名映射做成数据，则 encode 还要收一份字段表，调用链多一环且 P0 根本没人换字段名。

### 3.2 protocol 只做纯翻译，调用编排归 client

**结论**：protocol 只暴露纯函数 `encode` / `parse` / `parseStream`，不发起 HTTP；URL 拼接、auth 注入、流式迭代由 `LlmClient` 编排（client 读 `protocol.path` / `protocol.contentType`）。
**理由**：纯函数可脱离网络单测、可在不同 transport 复用；I/O 集中在 client 便于统一处理。
**反例**：让 protocol 一个方法连 HTTP 一起干，会迫使 protocol 依赖 provider 与 I/O，无法独立单测。

### 3.3 参数只管"字段名"，不管"取值"

**结论**：paramFields（`max_tokens` vs `max_completion_tokens` 等 wire 字段名）写死在 impl 内部；默认值/范围/上限归 model。
**理由**：字段名随接口变（protocol），约束随模型变（model），二者独立。
**反例**：把 temperature 默认 1.0 写进 protocol，会让 protocol 文档随模型更新而膨胀。

### 3.4 多模态编码归 protocol，支持与否归 model

**结论**：图片/音频/视频在 body 里的 block 格式归 protocol；该模型是否吃图归 model。
**理由**：编码是接口契约的一部分，能力是模型固有属性。
**反例**：若编码归 model，换同协议下的另一模型要改编码逻辑。

### 3.5 system prompt 来源是 messages[]，落点由 protocol impl 决定

**结论**：system prompt 不放 `RequestParams`，而是以 `role:"system"` 的 message 存于 `messages[]`（与 [P0]agent_message_interface.md §1 的 role 模型一致）。`encode` 从 `messages[]` 读出 system message，按 impl 内部决定的落点（`top_level` 放顶层参数，Anthropic/Gemini；`message` 放 messages[0]，OpenAI）放置。wire body 中仍可出现 system 字段，只是来源是 messages[]，落点判定是 impl 代码常量（不再走 config）。
**理由**：system prompt 是消息流的一部分（与 user/assistant 同源），把它单独拎到 RequestParams 会引入第二个消息入口，且无法统一排序/多轮管理；落点差异是 schema 差异，归 protocol impl。
**反例**：若 system 放 RequestParams，调用方要同时管 `params.system` 与 `messages[]`，且多轮压缩时容易漏带 system。

### 3.5.1 encode 入参假定已 logical 展平（v0.0.50）

**结论**：`encode(request)` 收到的 `request.messages` **假定已是 logical 视图**——业务 `sender` 已由上游 `llm/logical-view.ts.toLogicalMessages()` 展平到首个 TextBlock 文本前缀（见 `[P0]llm_logical_view.md`）。`encode` / `encodeMessage` **不再读 `Message.sender` 字段**（既有 anthropic_messages 实现本来就没读，行为等价；文档层澄清）。
**理由**：sender 是结构化字段，LLM 不识；进 wire 前必须变文本前缀。v0.0.50 抽公共层后，所有 protocol.encode 上游统一展平，protocol 自身只做协议本身的合并/映射（role tool→user、相邻同 role 合并、system 顶层、cache_control 等）。
**反例**：若 protocol.encode 自行展平 sender，每新增 protocol 都要复刻前缀表，且 observability 打到的 logical generation input 与 LLM 真正看到的 input 不一致（盲区）。
**落点**：`app/plugins/builtins/llm_anthropic/protocol-encode-helpers.ts.encodeMessage()` 仅读 `m.role` + `m.content`（v0.0.50 起注释明确「入参已 logical 展平」；v0.0.191 起 impl 物理迁 plugin 目录，见 `anthropic_impl.md` 顶部对齐说明）。

### 3.7 stop sequences（EOS 双保险）`[v0.0.33.2]`

- **核心概念**：`RequestParams.stop` 是 canonical stop sequence，SquadChat 用 `['<EOS>']` 表达路由完成。
- **设计思路**：优先让 provider 在 `<EOS>` 前自然停止，减少无意义尾 token；同时在 `stage-llm` 入库前 strip，覆盖 provider 未支持 stop 的情况。
- **代码路径**：`app/server/src/agent/agent-loop-stage-llm.ts.stageLLMRequest() → app/plugins/builtins/llm_anthropic/protocol-encode.ts.encodeAnthropicMessages() → app/server/src/agent/agent-loop-stage-llm.ts.stripEosToken()`。
- **接口签名**：`interface RequestParams { stop?: string[] }` —— canonical 字段；当前仓库只有 `anthropic_messages` 映射到 wire `stop_sequences`，不要推断其他 provider impl 已支持。
- **版本演进**：`[v0.0.33.2]` SquadChat EOS 透明化；HTTP/SSE/GET messages 均不暴露 `<EOS>`。

### 3.8 effort 推理强度 — canonical 语义键，encode 内部映射注入（v0.0.148 加入）

**结论**：`RequestParams.effort` 是 canonical **语义值**（`'default'|'low'|'high'|'max'`，非 wire 字面值）。protocol impl 在 encode 内部映射到厂商具体 wire 值，**字段名映射 + 缺省档语义**全在 impl 内部硬编码（对齐 §3.1「标准值归 protocol impl（代码）」+ §3.3「字段名归 protocol、取值归 model」）。

**映射表**（v0.0.148 仅 anthropic_messages 实现，`EFFORT_WIRE_MAP` 常量）：

| canonical effort | Anthropic wire (`output_config.effort`) | OpenAI wire（spec 声明，未实现——无 openai protocol impl） |
|---|---|---|
| `'default'` | **不注入** `output_config` 字段（= 厂商默认行为，非传字面 `"default"`） | 不注入字段 |
| `'low'` | `'low'` | `'minimal'` |
| `'high'` | `'high'` | `'high'` |
| `'max'` | `'max'` | `'xhigh'` |

**约束（MANDATORY）**：
- **`'default'` 档不加 `output_config` 字段**——等价未挂 effort，不是传一个 `"default"` 字面值。encode guard：`if (params.effort !== undefined && params.effort !== 'default') body['output_config'] = { effort: EFFORT_WIRE_MAP[params.effort] }`。
- **canonical 是语义键，不在 RequestParams 放 wire 字面值**（`minimal`/`xhigh` 等厂商专属值归 encode 内部硬编码映射，对齐既有字段名映射风格）。
- **实现范围 = anthropic_messages 唯一 protocol impl**；OpenAI 映射写本 spec 不实现（仓库无 openai provider/protocol）。

**透传链（源头 → wire）**：
`session.effort`（持久化字段）→ `buildSessionConfigFromDeps`（handlers/session-config.ts）读 → `config.effort`（SessionConfig，agent 上下文）→ `callLLMForSpec`（loop-stage-llm.ts main+forked 唯一活跃 stage）+ `callLLM legacy client.stream 路径`（agent-loop-base.ts，同步加防 drift）透传 → `CallLLMInput.effort` → `callLLMViaInvoker baseReq.params.effort` → `encodeAnthropicMessages` 注入 wire body。`undefined` 一路透传，encode 兜底走 default 档（不加 output_config）。

**studio 覆盖链（[v0.0.279] squad 团队默认推理强度）**：`buildSessionConfigFromDeps` 在 resolveModel 同区（session-config.ts L255-260）调 `resolveEffort(sessionPersist.effort, isStudio && squad !== undefined ? squad.effortDefault : undefined)`（纯函数，session-config.ts L107-114）——**成员显式档（low/high/max）→ 用之；否则团队 `squad.effortDefault`（low/high/max）→ 用之；否则 `undefined`（厂商默认，encode 不注入）**。成员 `'default'` 与 `undefined` 同语义（不覆盖 → 落团队/厂商默认）。resolve 时机与 model 一致：每次 `resolveConfigBySid` 现拉（无 cache）——团队改设置下一次 run 立即生效；playground/academy/standalone 无 squad → 只 session 一层；subagent 继承父 resolve 结果不重复 resolve。`squad.effortDefault` 由 squad schema（`required:false`，存量无字段=default）+ PATCH 校验（非法 400）双保证合法值。数据契约见 `specs/api/overall/11a-squad-endpoints.md §1.3/§1.4`。

**理由**：effort 是新概念（v0.0.148 net-new），厂商（Claude/OpenAI）已离散化为 4 档；canonical 统一键 + encode 映射模式与既有 protocol 字段（maxTokens / stop / temperature）一致——语义在 canonical 层稳定（换 provider 不改调用方），映射差异封在 encode 内部（换 provider 只改 encode 常量表）。
**反例**：若把 Anthropic wire 字面 `'max'` 直接塞进 RequestParams.effort，调用方需按 provider 切换值（OpenAI 用 `'xhigh'`），破坏 canonical 协议层屏蔽差异的职责；调用方要 import 厂商专属常量，与 provider 强耦合。

### 3.6 thinking_delta 与 text_delta 是平行独立变体（v0.0.3 加入）

**结论**：`StreamEvent` 加一个独立变体 `{ type: "thinking_delta"; thinking: string }`，与 `text_delta` 平行（不复用 text 变体、不嵌进通用 `block_delta`）。`anthropic_messages` impl 的 `parseStream` 把 anthropic SSE 中 `content_block_delta.delta.type==="thinking_delta"` 的 chunk 映射成本变体（见 `specs/research/v0.0.3-anthropic-protocol.md` §3）；`signature_delta` 当前不产出（v0.0.3 不续 thinking，见 PRD scope.out）。
**理由**：anthropic extended thinking 的 thinking block 与 text block 是不同 `index` 的独立 content block，UI 端要按 part 分段渲染（折叠 thinking / 显示 answer）。若复用 text 变体（用 type 字段区分）会让消费方拆字符串；若引入通用 `block_delta{blockType, index}` 反而把 protocol 层的 index 路由细节泄露给消费方（index 是 protocol 实现细节，UI 应以 `messageId:partIndex` 维护 part 顺序而非依赖 protocol index）。
**反例**：若 thinking 不在 StreamEvent 中表达（v0.0.3 前的旧版），req 要求的 thinking 展示无法在协议层落地，只能在前端临时 hardcode anthropic SSE 解析，破坏 protocol 屏蔽差异的职责。

## 4. 示例

Anthropic Messages（`anthropic_messages` impl）的 `encode` 产物（wire body）。注：`path` 写死为 `"/v1/messages"`，`system` 字段在产物中仍存在，但其来源是入参 `messages[]` 里 `role:"system"` 的 message，由 impl 按 `top_level` 落点放到顶层，而非来自 `RequestParams.system`：

```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1024,
  "system": "你是助手",
  "messages": [
    { "role": "user", "content": [
      { "type": "text", "text": "这张图是什么" },
      { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBOR..." } }
    ]}
  ],
  "stream": false
}
```

## 5. 边界

| 零件 | 归属 |
|------|------|
| URL path、content-type（标准值，自承载 readonly 常量） | `LlmProtocol` impl（本文件）✅ |
| request body、参数字段名映射、多模态编码 | `LlmProtocol` impl（本文件）✅ |
| 响应 / 流式解析（`parse` / `parseStream`）、system 落点 | `LlmProtocol` impl（本文件）✅ |
| 少数可配置项（extra params/headers/自定义 path）→ overlay | `ext_impl_config`（plugin_system） |
| base URL、credentials、auth header（`buildAuthHeaders`） | `[P0]llm_provider_interface.md` |
| 参数默认值/范围/上限 | `[P0]llm_model_interface.md` |
| 模态/能力是否支持、context window、定价 | `[P0]llm_model_interface.md` |
| HTTP 调用、参数校验、成本计算（调用编排） | `[P0]llm_client_interface.md` |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
