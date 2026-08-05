---
type: interface
title: Error Normalization（错误归一化）
priority: P0
status: active
updated: 2026-06-30
since: v0.0.25
related: [[P0]llm_caller.md, [P0]provider_health_registry.md, [P0]retry_and_timeout.md]
---

# Error Normalization（错误归一化）

> 管什么：把各 provider 的原始错误（HTTP status + `error.type` + 流内 error 事件 + 消息文本）归一化为统一 `LlmErrorCategory`；产出 `ClassifiedLlmError` 携带 action hints（retryable / shouldRotateKey / shouldFallbackProvider / shouldCompressContext / shouldBumpMaxTokens）。
> 不管什么：decide（读 hints 决定 action，归 `[P0]llm_caller.md §3`）；provider 健康状态机（→ `[P0]provider_health_registry.md`）；退避算法（→ `[P0]retry_and_timeout.md`）。
> **核心原则（hermes 模式）**：**classify 只产 hint，decide 读 hint** —— Anthropic adapter 改 category 映射列时主逻辑不动。

---

## 1. LlmErrorCategory（枚举，按恢复语义分组）

```typescript
enum LlmErrorCategory {
  // ── 可重试-瞬时（同 provider 内退避重试，不改参） ──
  RATE_LIMITED          = "RATE_LIMITED",          // 429（per-key 或 per-account quota）
  PROVIDER_OVERLOADED   = "PROVIDER_OVERLOADED",   // 529 / overloaded（provider 容量）
  SERVER_ERROR          = "SERVER_ERROR",          // 500 / 502 / 503（非 overload）
  NETWORK               = "NETWORK",               // fetch throw（DNS / TCP / TLS，无 HTTP 响应）
  STREAM_INCOMPLETE     = "STREAM_INCOMPLETE",     // 流断 / 无 stop_reason / tool args 未完成（非 length）
  MAX_TOKENS_TOO_HIGH   = "MAX_TOKENS_TOO_HIGH",   // [v0.0.25] 请求 maxTokens 越界 / provider 400 max_tokens 拒 → 降 maxTokens ×0.7 重试（≠ MAX_TOKENS_EXCEEDED）
  EMPTY_RESPONSE        = "EMPTY_RESPONSE",        // [v0.0.25] 流正常 finish 但无 text 且无 tool_call → 纯重试

  // ── 超时（看门狗触发，进重试丢 partial） ──
  TIMEOUT_FIRST_CHUNK   = "TIMEOUT_FIRST_CHUNK",   // TTFB 超 45s
  TIMEOUT_INTER_CHUNK   = "TIMEOUT_INTER_CHUNK",   // chunk 间 stall 超（answer 30 / think 30 / tool 120）
  // 注：wall_max abort 归 TIMEOUT_INTER_CHUNK（复用，不单列）—— 都是 stall 类

  // ── 凭证（不重试同 key，换 key 或上抛） ──
  AUTH_INVALID          = "AUTH_INVALID",          // 401（key 失效 / 错）
  AUTH_FORBIDDEN        = "AUTH_FORBIDDEN",        // 403（key 无权限 / 地域禁）

  // ── 请求（参数 / 内容问题，NO_RETRY 或 FIX_AND_RETRY） ──
  CONTEXT_LENGTH_EXCEEDED  = "CONTEXT_LENGTH_EXCEEDED",  // 输入超 context window（→ 压缩）
  MAX_TOKENS_EXCEEDED      = "MAX_TOKENS_EXCEEDED",      // 输出触顶 stop_reason=length（→ bump / prefill，升）
  CONTENT_FILTERED         = "CONTENT_FILTERED",         // 内容被审核拒绝（NO_RETRY，合规）
  MODEL_NOT_FOUND          = "MODEL_NOT_FOUND",          // 模型 id 不存在（NO_RETRY）
  MALFORMED_TOOL_CALL      = "MALFORMED_TOOL_CALL",      // tool_use args 解析失败（NO_RETRY 或修参）
  BAD_REQUEST_OTHER        = "BAD_REQUEST_OTHER",        // 400 其他（NO_RETRY）

  // ── 用户中断（不重试，保留 partial） ──
  ABORTED_BY_USER       = "ABORTED_BY_USER",
}
```

**分组恢复语义**：
- 可重试-瞬时 → `decide` 产 `RETRY_BACKOFF`（同 provider 同 key 退避重试）；连续 N 次 → 升级（overload→FALLBACK、rate_limit→FALLBACK 或 ROTATE_KEY）。
- **`MAX_TOKENS_TOO_HIGH`（v0.0.25 新增）→ 可重试-瞬时组**：退避重试前 **buildRequest 降 maxTokens ×0.7**（通过 `recentErrors` 派生，见 `[P0]llm_request_config §2.4`）；retryable=true，连续 N 次（attempt≥2）shouldFallbackProvider。**方向相反于 `MAX_TOKENS_EXCEEDED`（升），二者必须区分，不可混用**——见 §6 避坑。
- **`EMPTY_RESPONSE`（v0.0.25 新增）→ 可重试-瞬时组**：纯重试（不改参，不降级），retryable=true，连续 N 次（attempt≥2）shouldFallbackProvider。
- 超时 → `RETRY_BACKOFF`（丢 partial 重试）。
- 凭证 → 首次 `ROTATE_KEY`（标 key 连续 +1），连续 N 次 → key dead → `FALLBACK`；若 fallback chain 无其他 key → `NO_RETRY` throw。
- 请求-CONTEXT_LENGTH → `FIX_AND_RETRY`（压缩）。
- 请求-MAX_TOKENS_EXCEEDED（**升**） → `FIX_AND_RETRY`（bump 或 prefill，归 `[P0]length_handling.md`）。
- 请求-CONTENT_FILTERED / MODEL_NOT_FOUND / MALFORMED / BAD_REQUEST_OTHER → `NO_RETRY`。
- ABORTED_BY_USER → 不进 attemptLoop catch，invoke 直接 return（保留 partial）。

---

## 2. ClassifiedLlmError（携带 action hints）

```typescript
interface ClassifiedLlmError extends Error {
  category: LlmErrorCategory;
  /** provider 原始错误（debug / langfuse metadata） */
  rawError?: { status?: number; body?: unknown; message?: string };
  /** HTTP `Retry-After` header（秒），归一化算法读它优先 */
  retryAfter?: number;
  /** provider 报告的可用 context window（仅 CONTEXT_LENGTH_EXCEEDED 可能带，用于本次降 max_tokens） */
  reportedContextWindow?: number;
  /** partial 结果（仅 MAX_TOKENS_EXCEEDED / STREAM_INCOMPLETE 可能带，供 prefill 决策） */
  partial?: { message: Message; usage?: Usage };
  /** 分类时计算的 action hints（decide 读这组 bool，不重读 category） */
  hints: ErrorActionHints;
}

interface ErrorActionHints {
  /** 可退避重试（同 provider 同 key） */
  retryable: boolean;
  /** 应换 key（同 provider 内轮换 credential）—— AUTH 类且 provider 有多 key */
  shouldRotateKey: boolean;
  /** 应换 provider（fallback chain 下一项）—— 连续 overload / key 全 dead */
  shouldFallbackProvider: boolean;
  /** 应压缩输入后重试 —— CONTEXT_LENGTH_EXCEEDED */
  shouldCompressContext: boolean;
  /** 应 bump max_tokens 或 prefill 续写 —— MAX_TOKENS_EXCEEDED */
  shouldBumpMaxTokens: boolean;
}
```

**为什么 hints 是 bool 而非 enum action**：decide 的最终 action 是 `RETRY_BACKOFF / ROTATE_KEY / FIX_AND_RETRY / FALLBACK / NO_RETRY` 五选一，但 hints 是「能力位」—— 一个错误可能同时 `retryable=true && shouldFallbackProvider=true`（瞬时错误但已连续 N 次），decide 综合考虑 attempt 计数 / 健康状态后选最终 action。hints 解耦「错误特性」与「当前上下文决策」。

---

## 3. classify 函数（adapter 入口）

```typescript
/**
 * 把 provider 原始错误归一化为 ClassifiedLlmError。
 * @param rawError  provider 抛出的原始错误（HTTP WireResponse 非 2xx / fetch throw / 流内 error 事件）
 * @param provider  provider impl（anthropic_compatible / openai_compatible / glm）
 * @returns ClassifiedLlmError（带 hints，decide 读）
 */
function classify(rawError: unknown, provider: LlmProvider): ClassifiedLlmError;
```

**内部派发**：按 `provider.name` 调对应 adapter 的 `classifyProviderError`。adapter 接口：

```typescript
interface ProviderErrorClassifier {
  /** provider 专属映射列：rawError → { category, retryAfter?, reportedContextWindow? } */
  classifyProviderError(rawError: unknown): {
    category: LlmErrorCategory;
    retryAfter?: number;
    reportedContextWindow?: number;
    message?: string;
  };
}
```

**hints 由通用 computeHints(category, ctx) 计算**（不进 adapter）：

```typescript
function computeHints(category: LlmErrorCategory, ctx: { hasMultipleKeys: boolean; attempt: number }): ErrorActionHints {
  switch (category) {
    case LlmErrorCategory.RATE_LIMITED:
    case LlmErrorCategory.PROVIDER_OVERLOADED:
    case LlmErrorCategory.SERVER_ERROR:
    case LlmErrorCategory.NETWORK:
    case LlmErrorCategory.STREAM_INCOMPLETE:
    case LlmErrorCategory.MAX_TOKENS_TOO_HIGH:   // [v0.0.25] 归「可重试-瞬时」组；buildRequest 派生降 maxTokens（不改 hints，decide 走 RETRY_BACKOFF，下次 buildRequest 读 recentErrors 派生 ×0.7）
    case LlmErrorCategory.EMPTY_RESPONSE:        // [v0.0.25] 归「可重试-瞬时」组；纯重试不改参
      return { retryable:true, shouldRotateKey:false,
        shouldFallbackProvider: ctx.attempt >= 2,   // 第二次重试起考虑 fallback（attempt 从 1 起算，首次瞬时错误先重试而非立即 fallback；decide 综合健康表）
        shouldCompressContext:false, shouldBumpMaxTokens:false };
    case LlmErrorCategory.TIMEOUT_FIRST_CHUNK:
    case LlmErrorCategory.TIMEOUT_INTER_CHUNK:
      return { retryable:true, shouldRotateKey:false, shouldFallbackProvider:false,
        shouldCompressContext:false, shouldBumpMaxTokens:false };
    case LlmErrorCategory.AUTH_INVALID:
    case LlmErrorCategory.AUTH_FORBIDDEN:
      return { retryable:false, shouldRotateKey: ctx.hasMultipleKeys,
        shouldFallbackProvider: !ctx.hasMultipleKeys, shouldCompressContext:false, shouldBumpMaxTokens:false };
    case LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED:
      return { retryable:false, shouldRotateKey:false, shouldFallbackProvider:false,
        shouldCompressContext:true, shouldBumpMaxTokens:false };
    case LlmErrorCategory.MAX_TOKENS_EXCEEDED:
      return { retryable:false, shouldRotateKey:false, shouldFallbackProvider:false,
        shouldCompressContext:false, shouldBumpMaxTokens:true };   // 注：升（bump/prefill），≠ MAX_TOKENS_TOO_HIGH（降）
    default: // CONTENT_FILTERED / MODEL_NOT_FOUND / MALFORMED_TOOL_CALL / BAD_REQUEST_OTHER / ABORTED_BY_USER
      return { retryable:false, shouldRotateKey:false, shouldFallbackProvider:false,
        shouldCompressContext:false, shouldBumpMaxTokens:false };
  }
}
```

> **[v0.0.25] MAX_TOKENS_TOO_HIGH 的降级机制**：hints 本身不改（retryable=true，无 shouldBumpMaxTokens）；降级发生在 buildRequest 阶段——attemptLoop catch 到 MAX_TOKENS_TOO_HIGH → append `recentErrors` → 下次 attempt 的 buildRequest 调 `deriveMaxTokens`（见 `[P0]llm_request_config §2.4`）读 recentErrors 中 TOO_HIGH 次数 → `base × 0.7^downHits`。decide 产 RETRY_BACKOFF（不改 hints），下次 buildRequest 自动降级。**这是「hints 描述错误特性，buildRequest 读 recentErrors 派生实参」的协同设计**——hints 不重复 recentErrors 的信息。

---

## 4. Anthropic Adapter 完整映射表（v0.0.25 实现的唯一 adapter）

### 4.1 HTTP status + error.type 映射

anthropic wire 错误响应（非 2xx）格式：`{ "type":"error", "error":{ "type":"<error_type>", "message":"..." } }`，HTTP status 独立。

| HTTP status | `error.type` | → category | retryAfter | 备注 |
|---|---|---|---|---|
| 400 | `invalid_request_error` 且 message 匹配 `context.*exceed|too long` (正则 §4.4) | `CONTEXT_LENGTH_EXCEEDED` | — | 解析 message 拿 reportedContextWindow（若 provider 给） |
| 400 | `invalid_request_error` 且 message 匹配 `max_tokens.*exceed|max_tokens.*invalid|max_tokens.*less|output.*exceed` | **`MAX_TOKENS_TOO_HIGH`** | — | [v0.0.25] **改判**：客户端请求 maxTokens 越界（>model 上限）→ 降 maxTokens ×0.7 重试（原 `BAD_REQUEST_OTHER` NO_RETRY 会让 misconfig 白失败）。注意：这是请求**越界**（TOO_HIGH，降），**≠** 流式 stop_reason=length 的输出**触顶**（EXCEEDED，升）。 |
| 400 | `invalid_request_error` 且 message 匹配 `model.*not found|does not exist` | `MODEL_NOT_FOUND` | — | |
| 400 | `invalid_request_error` 其他 | `BAD_REQUEST_OTHER` | — | |
| 401 | `authentication_error` | `AUTH_INVALID` | — | key 失效 |
| 403 | `permission_error` | `AUTH_FORBIDDEN` | — | key 无权限 / 地域 |
| 403 | 其他（无 error.type） | `AUTH_FORBIDDEN` | — | |
| 404 | `not_found_error` 且 message 匹配 `model` | `MODEL_NOT_FOUND` | — | |
| 404 | 其他 | `BAD_REQUEST_OTHER` | — | |
| 413 | `request_too_large` | `CONTEXT_LENGTH_EXCEEDED` | — | body 超大 |
| 429 | `rate_limit_error` | `RATE_LIMITED` | 解析 `Retry-After` header（秒） | per-key 或 per-account |
| 429 | （无 error.type，message 含 `overloaded`） | `PROVIDER_OVERLOADED` | 解析 `Retry-After`（若有） | anthropic 529 也走 429?  见 529 行 |
| 500 | `api_error` | `SERVER_ERROR` | — | |
| 502 / 503 / 504 | （网关） | `SERVER_ERROR` | — | 上游网关错（minimax / volcengine 可能） |
| 529 | `overloaded_error` | `PROVIDER_OVERLOADED` | 解析 `Retry-After`（若有，罕见） | anthropic 专属「overloaded」 |
| 其他 4xx | — | `BAD_REQUEST_OTHER` | — | 兜底 |
| 其他 5xx | — | `SERVER_ERROR` | — | 兜底 |

### 4.2 流内 error 事件映射

anthropic SSE 流中可能在中途产 `event: error`（如内容审核、服务端中断）：

```
event: error
data: {"type":"error","error":{"type":"<error_type>","message":"..."}}
```

| 流内 error 场景 | → category | 备注 |
|---|---|---|
| `error.type="overloaded_error"` | `PROVIDER_OVERLOADED` | 流中途 overload |
| `error.type="rate_limit_error"` | `RATE_LIMITED` | 流中途限流（罕见） |
| `error.type="invalid_request_error"` 且 message 匹配 content filter | `CONTENT_FILTERED` | 内容审核拒绝 |
| 流断（SSE 连接断，无 finish 事件，无 error 事件） | `STREAM_INCOMPLETE` | partial 保留（若无未完成 tool_use） |

### 4.3 stop_reason 映射（流正常结束但需 length 处理 / 或空响应）

流正常 finish 但 `stop_reason` 提示 length（或正常 finish 却空响应）：

| `message_delta.stop_reason` | content 是否非空 | tool args 是否完成 | → category | 走 bump 路径？ |
|---|---|---|---|---|
| `max_tokens` 且无未完成 tool_use | — | 是 | `MAX_TOKENS_EXCEEDED` | **是**（bump 或 prefill，升） |
| `max_tokens` 且 tool args 未完成（`input_json_delta` 中断） | — | 否 | `STREAM_INCOMPLETE` | **否**（hermes 教训：bump 无效，3 次浪费） |
| 无 stop_reason（流断） | — | — | `STREAM_INCOMPLETE` | 否 |
| `end_turn` / `stop` / `stop_sequence`（正常 finish）但**无 text 且无 tool_call** | 空 | — | **`EMPTY_RESPONSE`** [v0.0.25] | **否**（纯重试，不改参） |
| `end_turn` / `stop` 且有 text 或 tool_call | 非空 | — | （非错误，正常返回） | 否 |

**关键避坑**：
- `STREAM_INCOMPLETE` ≠ `MAX_TOKENS_EXCEEDED`。前者不进 max_tokens-boost 路径（refs hermes `chat_completion_helpers.py:2054-2108` 教训）。
- **[v0.0.25] `EMPTY_RESPONSE`**：流正常 finish（`stop_reason=end_turn` 等）但 assistant content 全空（无 text block、无 tool_use block）→ 视为可重试瞬时错误（模型偶发空响应）。retryable=true，连续 N 次升级 FALLBACK。**不改 maxTokens、不压缩 context**——纯重试。判定点：`parseStream` 聚合 CanonicalResponse 时若 `message.content.length === 0` → 触发 `EMPTY_RESPONSE`（而非正常返回）。

### 4.4 message 正则（CONTEXT_LENGTH_EXCEEDED 判定）

anthropic 在 `error.message` 中给具体超长信息，需正则匹配：

```typescript
const CONTEXT_LENGTH_PATTERNS = [
  /input length and max_tokens.+exceed/i,    // "input length and max_tokens, 1234, exceed context window"
  /prompt is too long/i,                      // "prompt is too long: X tokens > Y max"
  /context.{0,20}exceed/i,
  /request too large/i,
];
```

`reportedContextWindow` 解析：从 message 抽数字（如 `exceed context window: 200000`）→ 若能解析出 provider 上限，写入 `reportedContextWindow`（本次调用降 max_tokens 用，**不**永久调窗口 —— hermes 教训）。

### 4.5 Retry-After header 解析

```typescript
function parseRetryAfter(headers: Record<string,string>): number | undefined {
  const v = headers["retry-after"];
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isNaN(n) && n >= 0) return Math.min(n, CAP_RETRY_AFTER_S);   // cap 防病态
  // HTTP-date 格式暂不支持（anthropic 不用），返回 undefined
  return undefined;
}
const CAP_RETRY_AFTER_S = 600;   // 10min 绝对上限（claude-code PERSISTENT_RESET_CAP_MS=6h 启发，更保守）
```

---

## 5. OpenAI / GLM Adapter（v0.0.25 仅占位）

v0.0.25 仅实现 Anthropic adapter（§4）。OpenAI / GLM adapter 占位：临时走 HTTP status 兜底（401→AUTH_INVALID / 429→RATE_LIMITED / 5xx→SERVER_ERROR / 其他→BAD_REQUEST_OTHER），v0.0.26+ 填映射列。**主逻辑只认 category**，后续填列不动 decide / computeHints（adapter 接口 §3 `ProviderErrorClassifier` 保证扩展点稳定）。

---

## 6. 设计决策（Why）

### 6.1 classify 与 decide 分离（hermes 模式）

**结论**：classify 产 `ClassifiedLlmError`（含 category + hints），decide 读 hints 产最终 action。
**理由**：adapter 改 category 映射列（如 anthropic 新增 error.type）时，主逻辑（decide / computeHints）不动。若 classify 直接产 action，每加一个 category 都要改 decide。
**反例**：claude-code 是字符串 category + 决策散落（无 hints），扩展时多处改。

### 6.2 hints 是 bool 而非 enum（解耦）

见 §2 末尾。bool hints 让 decide 综合上下文（attempt / 健康表）选最终 action，而非 classify 时一刀切。

### 6.3 STREAM_INCOMPLETE ≠ MAX_TOKENS_EXCEEDED（必学避坑）

**结论**：无 stop_reason + tool args 未完成 → `STREAM_INCOMPLETE`（不 bump）；有 stop_reason=length → `MAX_TOKENS_EXCEEDED`（bump 或 prefill）。
**理由**：hermes 教训 —— 把 STREAM_INCOMPLETE 误标 MAX_TOKENS 后 3 次无效 bump 浪费配额。
**实现**：parseStream 在流断时检查最后 tool_use block 的 `input_json_delta` 是否完整（有无 closing `}`），未完成则标 STREAM_INCOMPLETE。

### 6.4 CONTENT_FILTERED 不重试（合规）

**结论**：`CONTENT_FILTERED` → `NO_RETRY` 直接上抛。
**理由**：同输入 = 同拒绝（模型审核确定性），重试无效且浪费；合规上也不能绕。

### 6.5 Retry-After 必须 cap

**结论**：解析后 `min(retryAfter, 600)`。
**理由**：claude-code 教训 —— 病态 header（如 6h）会卡死重试。10min 是绝对上限（足够尊重合理 retry-after，又防病态）。

### 6.6 [v0.0.25] MAX_TOKENS_TOO_HIGH（降）≠ MAX_TOKENS_EXCEEDED（升），方向相反不可混用

**结论**：两个 `MAX_TOKENS_*` category 方向相反——`MAX_TOKENS_TOO_HIGH` 请求越界（provider 400 / validate 拒）→ **降** maxTokens ×0.7 重试；`MAX_TOKENS_EXCEEDED` 输出触顶（流 finish + stop_reason=length）→ **升** maxTokens bump/prefill。二者必须区分，不可合并。
**理由**：方向相反——若混用（如把 TOO_HIGH 当 EXCEEDED 升 maxTokens），会让越界请求越升越拒（永远 400）；反之（把 EXCEEDED 当 TOO_HIGH 降）会让触顶输出越降越早截断。两类错误的恢复动作完全对立。
**判定边界**：
- `MAX_TOKENS_TOO_HIGH`：HTTP 400 + message 含 `max_tokens.*exceed|invalid|less`（provider 拒绝请求参数，**请求未发到模型**）；或 `client.validate()` 抛错（见 `[P0]llm_client_interface §3.9` 附近，v0.0.25 BUG-005 收口）。
- `MAX_TOKENS_EXCEEDED`：流正常 finish + `stop_reason=max_tokens`（**请求成功送达模型**，模型输出到上限被截断）。
**反例**：旧 §4.1 把 400 max_tokens 映射 `BAD_REQUEST_OTHER`（NO_RETRY）→ misconfig 白失败（BUG-005 根因之一）；正确做法是映射 `MAX_TOKENS_TOO_HIGH`（可重试 + 降级 ×0.7）。

### 6.7 [v0.0.25] EMPTY_RESPONSE 归可重试-瞬时（纯重试不改参）

**结论**：流正常 finish 但 content 全空 → `EMPTY_RESPONSE`，retryable=true，连续 N 次升级 FALLBACK；**不降 maxTokens、不压缩 context、不 bump**。
**理由**：模型偶发空响应（如 provider 内部 glitch、content filter 软拦截但未报 filtered），通常重试即恢复；改参（降 maxTokens / 压缩 context）反而引入无谓副作用。
**判定点**：`parseStream` 聚合时 `message.content.length === 0` → 触发（而非正常返回空 message）。

---

## 7. 边界

| 零件 | 归属 |
|------|------|
| LlmErrorCategory 枚举 / ClassifiedLlmError 类型 / computeHints | 本文件 ✅ |
| Anthropic adapter 完整映射列（HTTP / 流内 / stop_reason / 正则） | 本文件 §4 ✅ |
| OpenAI/GLM adapter 占位 | 本文件 §5 ✅（v0.0.26+ 填列） |
| decide（读 hints 产 action） | `[P0]llm_caller.md §3` |
| 退避算法（getRetryDelay） | `[P0]retry_and_timeout.md` |
| provider 健康状态机 | `[P0]provider_health_registry.md` |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
