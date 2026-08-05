# 实现细节(一):retry + circuit breaker + fallback + 归一化

> 本文件是 v0.0.25 llm-opt 调研报告的实现细节第一部分(§1-4: 重试/退避/jitter + circuit breaker + fallback chain + 错误归一化)。
> 完整报告见 `specs/research/v0.0.25-llm-error-handling/`。
> §5-7(分阶段超时 + 动态参数 + SSE 流式错误)见 `implementation-streaming.md`;概述见 `overview.md`;建议见 `recommendations.md`。

## 1. retry + 指数退避 + jitter

### 1.1 claude-code `getRetryDelay()`(半 jitter + 尊重 retry-after)

- **位置**: `refs/claude-code/src/services/api/withRetry.ts:530-548`
- **触发**: 每次 retry 前(除 persistent 模式有独立路径)
- **逻辑**: retry-after 头优先(秒*1000);否则 `min(base*2^(n-1), cap) + random*0.25*base`

```typescript
// 摘自 withRetry.ts:530-548
export function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
  maxDelayMs = 32000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (!isNaN(seconds)) return seconds * 1000   // 尊重 retry-after
  }
  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), maxDelayMs)  // BASE_DELAY_MS=500
  const jitter = Math.random() * 0.25 * baseDelay  // 0-25% 的 base 作为 jitter
  return baseDelay + jitter
}
```

- **关键参数**: `DEFAULT_MAX_RETRIES=10`、`BASE_DELAY_MS=500`、`maxDelayMs=32000`(cap)
- **避坑**: persistent 模式下 cap 提到 `PERSISTENT_MAX_BACKOFF_MS=5min`,且有 `PERSISTENT_RESET_CAP_MS=6h` 防病态 header(`withRetry.ts:96-97, 433-463`)

### 1.2 hermes `jittered_backoff()`(full jitter + counter seed)

- **位置**: `refs/hermes-agent/agent/retry_utils.py:19-57`
- **触发**: 多 session 并发重试同一 provider 时
- **逻辑**: `min(base*2^(n-1), max) + uniform(0, ratio*delay)`,**counter seed** 保证同进程并发不撞种子

```python
# 摘自 retry_utils.py:41-57
global _jitter_counter
with _jitter_lock:
    _jitter_counter += 1
    tick = _jitter_counter

exponent = max(0, attempt - 1)
delay = min(base_delay * (2 ** exponent), max_delay)  # base=5, max=120
# 进程级 counter + 时间 ns 异或,防并发同种子
seed = (time.time_ns() ^ (tick * 0x9E3779B9)) & 0xFFFFFFFF
rng = random.Random(seed)
jitter = rng.uniform(0, jitter_ratio * delay)  # ratio=0.5(full jitter)
return delay + jitter
```

- **关键参数**: `base_delay=5.0`、`max_delay=120.0`、`jitter_ratio=0.5`
- **借鉴点**: counter seed 思路 —— v0.0.25 全局健康表多 session 并发时,需类似机制防同步重试

### 1.3 retry 循环主框架(claude-code)

- **位置**: `refs/claude-code/src/services/api/withRetry.ts:170-517`
- **数据流**:
  1. 输入: `getClient`、`operation(client, attempt, context)`、`options{maxRetries, model, fallbackModel, signal, querySource, initialConsecutive529Errors}`
  2. 循环 `attempt = 1..maxRetries+1`:
     - signal.aborted → throw APIUserAbortError
     - 调 operation → 成功 return
     - catch → classify → decide action(下面 1.4)
  3. 输出: 成功值 或 `CannotRetryError`/`FallbackTriggeredError`
- **关键设计**: 是 `AsyncGenerator<SystemAPIErrorMessage, T>` —— 重试期间 yield system message 给 UI(让用户看到「正在重试」)

### 1.4 retry 决策树(claude-code `shouldRetry`)

- **位置**: `refs/claude-code/src/services/api/withRetry.ts:696-787`
- **触发条件**(按优先级):
  1. mock error → 不重试
  2. persistent 模式 + 429/529 → 重试
  3. CLAUDE_CODE_REMOTE + 401/403 → 重试(infra JWT,瞬时)
  4. message 含 `"type":"overloaded_error"` → 重试(SDK 漏传 529 status)
  5. `parseMaxTokensContextOverflowError` 命中 → 重试(可救)
  6. `x-should-retry` header:
     - `true` + (非 subscriber 或 enterprise) → 重试
     - `false` + 非 5xx(ant 例外) → 不重试
  7. `APIConnectionError` → 重试
  8. status 408(请求超时)/409(lock)→ 重试
  9. status 429 → 非 subscriber 或 enterprise 才重试
  10. status 401 → 清 key cache + 重试
  11. status 403 + "OAuth token revoked" → 重试
  12. status >= 500 → 重试
  13. else → 不重试

## 2. circuit breaker / provider 健康降级

### 2.1 hermes `_rate_limited_until` 时间戳冷却

- **位置**: `refs/hermes-agent/agent/chat_completion_helpers.py:1057-1065`
- **触发**: `try_activate_fallback` 时,reason ∈ {rate_limit, billing}
- **逻辑**: 只在「离开 primary」时设 `_rate_limited_until = monotonic() + 60`;若已在 fallback 上 chain-switch,不重置(避免延长冷却)

```python
# 摘自 chat_completion_helpers.py:1057-1065
if reason in {FailoverReason.rate_limit, FailoverReason.billing}:
    fallback_already_active = bool(getattr(agent, "_fallback_activated", False))
    current_provider = (getattr(agent, "provider", "") or "").strip().lower()
    primary_provider = ((agent._primary_runtime or {}).get("provider") or "").strip().lower()
    if (not fallback_already_active) or (primary_provider and current_provider == primary_provider):
        agent._rate_limited_until = time.monotonic() + 60  # session 级冷却 60s
```

- **关键限制**: hermes 这个是 **session 级**;v0.0.25 要求**进程级跨 session 共享**(reqs.md §3)

### 2.2 hermes credential pool `has_available()`

- **位置**: `refs/hermes-agent/run_agent.py:4028-4052`
- **触发**: rate-limit retry 前,判断「等 pool 冷却」vs「立即 fallback」
- **逻辑**:
  - pool 不存在 / `has_available()==False` → 不轮换
  - Google CloudCode / `cloudcode-pa://` → 不轮换(account-wide quota)
  - 否则 → `pool.has_available()` 决定

### 2.3 claude-code fast mode cooldown(短期冷却切速度)

- **位置**: `refs/claude-code/src/services/api/withRetry.ts:267-305`
- **触发**: fast mode 开启 + 429/529
- **逻辑**:
  - retry-after < `SHORT_RETRY_THRESHOLD_MS=20s` → 等待 + 同模式重试(保 prompt cache)
  - retry-after 长 / 未知 → 触发 cooldown `max(retryAfter ?? 30min, MIN_COOLDOWN_MS=10min)`,切标准速度

## 3. fallback chain / 多 provider 路由

### 3.1 hermes `try_activate_fallback`(链式遍历)

- **位置**: `refs/hermes-agent/agent/chat_completion_helpers.py:1045-1145`
- **入口**: retry 失败 / empty response / `finish_reason=length` 等场景调用
- **数据流**:
  1. 读 `agent._fallback_chain` + `agent._fallback_index`
  2. `_fallback_index >= len(chain)` → return False(耗尽)
  3. 取 `fb = chain[index]`,index++
  4. **dedup 检查**(避免切到刚失败的 backend):
     - provider+model 与当前相同 → skip 递归下一项
     - base_url+model 与当前相同 → skip
  5. `resolve_provider_client(fb_provider, model, base_url_hint, api_key_hint)` 构建新客户端
  6. 客户端为 None → skip(provider 未配置)
  7. normalize model → 切换 agent.provider/model/base_url/client
- **输出**: True(切换成功)/ False(链耗尽)
- **关键设计**: 同 backend dedup 防止切回死路;客户端重建含 base_url 比对(两个 custom_provider 指向同 proxy 也算同 backend)

### 3.2 claude-code 单 fallback model(`FallbackTriggeredError`)

- **位置**: `refs/claude-code/src/services/api/withRetry.ts:326-365`
- **触发**: 连续 529 ≥ `MAX_529_RETRIES=3` 且配了 `fallbackModel`
- **逻辑**: throw `FallbackTriggeredError(originalModel, fallbackModel)`,**外层**捕获后重建 client 用 fallback model

```typescript
// 摘自 withRetry.ts:335-351
consecutive529Errors++
if (consecutive529Errors >= MAX_529_RETRIES) {
  if (options.fallbackModel) {
    throw new FallbackTriggeredError(options.model, options.fallbackModel)
  }
}
```

- **与 hermes 对比**: claude-code 只支持**单** fallback model(throw 出去外层处理);hermes 支持**有序链**(in-place 切换不抛异常,继续 retry 循环)。v0.0.25 需求是「全局兜底链」—— hermes 模式更贴近。

## 4. 错误归一化 adapter

### 4.1 hermes `FailoverReason` + `ClassifiedError`(recovery hints)

- **位置**: `refs/hermes-agent/agent/error_classifier.py:24-90`
- **设计**: enum 20+ category + dataclass 携带 `retryable/should_compress/should_rotate_credential/should_fallback` 4 个 action hint
- **完整 category 列表**(见 overview.md §2.4 或 `error_classifier.py:24-64`):
  - auth / auth_permanent / billing / rate_limit
  - overloaded / server_error / timeout
  - context_overflow / payload_too_large / image_too_large
  - model_not_found / provider_policy_blocked / content_policy_blocked
  - format_error / invalid_encrypted_content / multimodal_tool_content_unsupported
  - thinking_signature / long_context_tier / oauth_long_context_beta_forbidden / llama_cpp_grammar_pattern
  - unknown

```python
# 摘自 error_classifier.py:69-90
@dataclass
class ClassifiedError:
    reason: FailoverReason
    status_code: Optional[int] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    message: str = ""
    error_context: Dict[str, Any] = field(default_factory=dict)
    # Recovery action hints — retry loop 查这些,不重新分类
    retryable: bool = True
    should_compress: bool = False
    should_rotate_credential: bool = False
    should_fallback: bool = False

    @property
    def is_auth(self) -> bool:
        return self.reason in {FailoverReason.auth, FailoverReason.auth_permanent}
```

- **借鉴点**: 把「分类」与「决策」分离 —— classify 只产 `ClassifiedError`,retry loop 只读 hints。这是 v0.0.25 「adapter 归一化 → decide action」的精确架构。

### 4.2 claude-code `classifyAPIError`(字符串 category)

- **位置**: `refs/claude-code/src/services/api/errors.ts:965-1161`
- **设计**: 20+ 字符串 category(非 enum),按优先级 if-else 链
- **与 hermes 对比**:
  - claude-code 用字符串(易扩展,但易拼写错);hermes 用 enum(类型安全)
  - claude-code 不带 recovery hints(决策逻辑分散在 `shouldRetry` 和 `withRetry` 主循环);hermes 集中在 `ClassifiedError`
  - claude-code 有更细的「prompt_too_long / pdf_too_large / image_too_large / tool_use_mismatch」等业务级 category;hermes 更聚焦 failover 决策

### 4.3 openclaw `StopReason`(流式终态归一化)

- **位置**: `refs/openclaw/packages/llm-core/src/types.ts:277`
- **设计**: `StopReason = "stop" | "length" | "toolUse" | "error" | "aborted"`
- **借鉴点**: 把流式**终态**(不只是错误)也纳入归一化。v0.0.25 的 `LlmErrorCategory` 应参考这种「success | length | toolUse | error | aborted」五元组作为顶层分流。
