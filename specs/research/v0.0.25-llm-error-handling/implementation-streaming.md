# 实现细节(二):分阶段超时 + 动态参数 + SSE 流式错误

> 本文件是 v0.0.25 llm-opt 调研报告的实现细节第二部分(§5-7)。
> 完整报告见 `specs/research/v0.0.25-llm-error-handling/`。
> §1-4(retry/退避/circuit breaker/fallback/归一化)见 `implementation.md`;概述见 `overview.md`;建议见 `recommendations.md`。

## 5. 分阶段超时看门狗

### 5.1 claude-code 流式 idle watchdog

- **位置**: `refs/claude-code/src/services/api/claude.ts:1868-1928`
- **触发**: 每个 chunk 收到时 `resetStreamIdleTimer()`;超时 `setTimeout` 主动 abort
- **逻辑**:
  - `STREAM_IDLE_TIMEOUT_MS` = env `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 或 90000(90s)
  - `STREAM_IDLE_WARNING_MS` = 一半(45s),记 warn 日志
  - 超时 → `streamIdleAborted=true` + `releaseStreamResources()`(abort controller)

```typescript
// 摘自 refs/claude-code/src/services/api/claude.ts:1877-1928(精简)
const STREAM_IDLE_TIMEOUT_MS = parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000
let streamIdleTimer: ReturnType<typeof setTimeout> | null = null
function resetStreamIdleTimer(): void {
  clearStreamIdleTimers()
  if (!streamWatchdogEnabled) return
  streamIdleTimer = setTimeout(() => {
    streamIdleAborted = true
    streamWatchdogFiredAt = performance.now()
    logEvent('tengu_streaming_idle_timeout', { timeout_ms: STREAM_IDLE_TIMEOUT_MS })
    releaseStreamResources()  // abort stream
  }, STREAM_IDLE_TIMEOUT_MS)
}
// for await 循环里每收到 chunk 调 resetStreamIdleTimer()
```

### 5.2 stall 检测(仅记日志,不 abort)

- **位置**: `refs/claude-code/src/services/api/claude.ts:1934-1960`
- **触发**: `lastEventTime !== null` 且 `now - lastEventTime > STALL_THRESHOLD_MS=30000`
- **逻辑**: 只记 `tengu_streaming_stall` 事件 + 累加 `totalStallTime`,**不 abort**(与 idle watchdog 区分;idle 是主动杀,stall 是被动观察)

### 5.3 全局 / 非流式 timeout

- **位置**:
  - 全局 SDK timeout: `refs/claude-code/src/services/api/client.ts:144` `timeout: API_TIMEOUT_MS || 600000`(600s)
  - 非流式 fallback timeout: `refs/claude-code/src/services/api/claude.ts:807-811`
    - `CLAUDE_CODE_REMOTE` → 120s(远低于 CCR 容器 idle-kill ~5min,防容器被杀)
    - 否则 → 300s

### 5.4 阶段感知 / 工具执行期不误判

- **refs 现状**: **都没实现** think/answer/tool 分别阈值。claude-code 只有「chunk 间 idle」一个阈值(90s);hermes 依赖 SDK timeout。
- **工具执行期**: claude-code 流式循环外执行工具(`for await` 退出后才跑 tool),不进 stall 计时;再次调 LLM 时重新进 stream loop。这是 v0.0.25 可参考的「分阶段」切分思路 —— **tool 执行是 LLM 调用之间的间隔,不属于某次 LLM stream 的 stall**。

## 6. 「智能 caller 在传输之上」动态参数构建

### 6.1 claude-code context overflow → 动态调 max_tokens

- **位置**: `refs/claude-code/src/services/api/withRetry.ts:388-427, 550-595`
- **触发**: `parseMaxTokensContextOverflowError` 命中 400 + 消息含 `"input length and \`max_tokens\` exceed context limit: 188059 + 20000 > 200000"`
- **逻辑**:
  1. 正则解析 `inputTokens / maxTokens / contextLimit`
  2. `availableContext = max(0, contextLimit - inputTokens - 1000)`(safety buffer)
  3. `availableContext < FLOOR_OUTPUT_TOKENS=3000` → 不救,throw
  4. 否则 `adjustedMaxTokens = max(3000, availableContext, thinkingBudget+1)`
  5. 写入 `retryContext.maxTokensOverride`,下一轮 operation 用此值

```typescript
// 摘自 refs/claude-code/src/services/api/withRetry.ts:550-595
export function parseMaxTokensContextOverflowError(error: APIError) {
  if (error.status !== 400 || !error.message) return undefined
  if (!error.message.includes('input length and `max_tokens` exceed context limit')) return undefined
  // "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000"
  const regex = /input length and `max_tokens` exceed context limit: (\d+) \+ (\d+) > (\d+)/
  const match = error.message.match(regex)
  if (!match || match.length !== 4) return undefined
  return {
    inputTokens: parseInt(match[1], 10),
    maxTokens: parseInt(match[2], 10),
    contextLimit: parseInt(match[3], 10),
  }
}
```

- **关键限制**: 这是**输入+输出超限**的场景(`input + max_tokens > context`),通过降 max_tokens 救。**不是**「输出触顶」(MAX_TOKENS_EXCEEDED stop_reason)的场景。

### 6.2 hermes 区分「prompt too long」vs「max_tokens too large」

- **位置**: `refs/hermes-agent/agent/model_metadata.py:1010-1110`
- **设计**: 两种错误分别处理,绝不混:
  - **prompt too long**(输入超 context 窗口)→ 压缩 history;**只在 provider 明确报告时**降 context_length
  - **max_tokens too large**(`input + requested_output > window`,输入本身没问题)→ 降 max_tokens;**不动** context_length

```python
# 摘自 refs/hermes-agent/agent/model_metadata.py:1030-1068(精简)
def parse_available_output_tokens_from_error(error_msg: str) -> Optional[int]:
    """检测 'output cap too large' 错误,返回可用的 output token 数。"""
    error_lower = error_msg.lower()
    is_output_cap_error = (
        ("max_tokens" in error_lower and "available_tokens" in error_lower)
        or ("in the output" in error_lower and "maximum context length" in error_lower)
        or ("maximum context length" in error_lower and "requested" in error_lower and "output tokens" in error_lower)
    )
    if not is_output_cap_error:
        return None
    # Anthropic: "max_tokens: 32768 > context_window: 200000 - input_tokens: 190000 = available_tokens: 10000"
    patterns = [r'available_tokens[:\s]+(\d+)', r'=\s*(\d+)\s*$']
    # ... 解析返回 available_tokens
```

- **关键约束**(`refs/hermes-agent/agent/model_metadata.py:1014-1027`):「Context-overflow recovery must not invent a new model window size」—— 不瞎猜,只信 provider 报告。这是 v0.0.25 「CONTEXT_LENGTH_EXCEEDED → 预压缩」必须遵守的:不要因为一次错误就把 context 窗口永久调小。

### 6.3 续写 prefill(MAX_TOKENS_EXCEEDED → 续接 partial)

- **refs 现状**: **三个项目都没有实现**。
- **原因**: prefill 是 Anthropic Messages API 特性(把 partial assistant turn 作为最后一条 message 喂回,模型续写)。claude-code 是 Anthropic 官方风格但选择「调 max_tokens + 非流式 fallback」而非 prefill;hermes/openclaw 多 provider 抽象,不好统一。
- **v0.0.25 必须自己写**: 见 `recommendations.md` §2.3 的设计建议。

## 7. SSE 流式错误 / 不完整流处理

### 7.1 claude-code watchdog abort → 非流式 fallback

- **位置**: `refs/claude-code/src/services/api/claude.ts:2308-2334`
- **触发**: `streamIdleAborted===true`(idle watchdog 触发)
- **逻辑**: throw `'Stream idle timeout - no chunks received'`,catch 块走非流式 fallback 路径(见 §5.3 的非流式 timeout)

### 7.2 claude-code 空流 / partial 流检测

- **位置**: `refs/claude-code/src/services/api/claude.ts:2350-2364`
- **触发**: stream for-await 结束但产物不全
- **两种 case**:
  1. `!partialMessage` —— proxy 返 200 但非 SSE body(根本没 message_start)
  2. `partialMessage` 存在但 `newMessages.length===0 && !stopReason` —— 有 message_start 但没 content_block_stop 也没 stop_reason(中途断)
- **action**: 两种都 throw → 走非流式 fallback
- **例外**: structured output 工具调用 turn 1 调 StructuredOutput,turn 2 才返 end_turn 且无 content —— 这是合法空响应,**不**触发 fallback(用 `stopReason` 检查区分)

### 7.3 claude-code abort 来源区分(用户 vs 看门狗/SDK)

- **位置**: `refs/claude-code/src/services/api/claude.ts:2434-2459`
- **关键双条件**: `streamingError instanceof APIUserAbortError && signal.aborted`
  - 两者都真 → **用户 ESC abort** → throw(保留状态,不重试)
  - `APIUserAbortError` 但 `!signal.aborted` → **SDK 内部 timeout** → 转 `APIConnectionTimeoutError` 走重试

```typescript
// 摘自 refs/claude-code/src/services/api/claude.ts:2434-2459(精简)
if (streamingError instanceof APIUserAbortError) {
  if (signal.aborted) {
    // 真用户 abort(ESC 键)
    logForDebugging(`Streaming aborted by user: ${errorMessage(streamingError)}`)
    throw streamingError  // 不重试
  } else {
    // SDK 内部 timeout 抛的 APIUserAbortError,但我们的 signal 没被 abort
    logForDebugging(`Streaming timeout (SDK abort): ${streamingError.message}`, { level: 'error' })
    // 转 timeout 错误走重试路径
  }
}
```

- **借鉴点**: v0.0.25 的 `ABORTED_BY_USER` vs `TIMEOUT_*` 区分需求(reqs.md §4)—— 必须有类似的「abort 来源」判定。但因为 v0.0.25 是自己用 AbortController,可以直接在「谁调 controller.abort()」时记录来源(user vs watchdog),比 claude-code 这种事后推断更干净。

### 7.4 hermes partial tool args 区分(关键避坑)

- **位置**: `refs/hermes-agent/agent/chat_completion_helpers.py:2054-2108`
- **场景**: 流结束但 tool call 的 JSON args 未完成(`has_truncated_tool_args`)
- **两种 case**(必须区分,否则 3 次无效重试):
  1. `finish_reason="length"` —— **真输出截断**(模型报告触顶)→ bump max_tokens 重试
  2. `finish_reason=None` —— **流中途断开**(provider stall/drop,模型没报告触顶)→ **不**走 max_tokens-boost 路径,走 partial-stream-stub 路径报 mid-tool-call stream drop,失败快

```python
# 摘自 refs/hermes-agent/agent/chat_completion_helpers.py:2074-2104(精简)
_tool_args_dropped_no_finish = has_truncated_tool_args and finish_reason is None
if _tool_args_dropped_no_finish:
    logger.warning(
        "Stream ended with no finish_reason while a tool call's "
        "arguments were still incomplete (tools=%s); treating as a "
        "mid-tool-call stream drop, not an output-length truncation.",
        _dropped_names,
    )
    # 不走 max_tokens-boost 路径;构造 partial-stream-stub 让循环失败快
    return SimpleNamespace(id=PARTIAL_STREAM_STUB_ID, ...)
effective_finish_reason = finish_reason or "stop"
if has_truncated_tool_args:
    effective_finish_reason = "length"  # 真截断才标 length
```

- **避坑点**: 这是 v0.0.25 处理 `STREAM_INCOMPLETE` vs `MAX_TOKENS_EXCEEDED` 的关键区分 —— 不能见到 partial tool args 就 bump max_tokens(可能 3 次无效重试)。

### 7.5 openclaw 流式事件协议(error 事件化)

- **位置**: `refs/openclaw/packages/llm-core/src/types.ts:369-390`
- **设计**: 流协议显式有 `done` 和 `error` 终止事件,error 携带 `stopReason: "aborted"|"error"` + AssistantMessage(含 errorMessage/errorCode/errorType/errorBody)
- **契约**: `StreamFunction` 一旦调用,**request/runtime 失败必须编码进返回流**,不能 throw(`refs/openclaw/packages/llm-core/src/types.ts:194-200`)

```typescript
// 摘自 refs/openclaw/packages/llm-core/src/types.ts:369-390
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial?: AssistantMessage }
  // ...
  | { type: "done"; reason: "stop"|"length"|"toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted"|"error"; error: AssistantMessage }
```

- **借鉴点**: v0.0.25 LlmCaller.invoke() 返回流时,**错误也应事件化**(不 throw 打断流消费者),这与 openclaw 一致。但 v0.0.25 还要决定「错误后是否在 LlmCaller 内部 retry 重建流」—— openclaw 不在 core 做 retry,所以它的 error 是终态;v0.0.25 retry 成功后应产新流续上。
