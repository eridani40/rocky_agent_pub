---
type: interface
title: Retry Backoff + 分阶段超时看门狗
priority: P0
status: active
updated: 2026-06-30
since: v0.0.25
related: [[P0]llm_caller.md, [P0]error_normalization.md, [P0]provider_health_registry.md]
---

# Retry Backoff + 分阶段超时看门狗

> 管什么：退避算法（`getRetryDelay`）+ 分阶段超时看门狗（TTFB / 阶段 stall / wall-clock）+ composite AbortController + abortReason 事前记录。
> 不管什么：错误归一化（→ `[P0]error_normalization.md`）；decide（→ `[P0]llm_caller.md §3`）；provider 健康（→ `[P0]provider_health_registry.md`）。
> **核心借鉴**：退避 = claude-code 半 jitter + hermes counter seed；超时 = claude-code idle watchdog + 自创「阶段感知 + abortReason 事前记录」。

---

## 1. 退避算法（getRetryDelay）

### 1.1 公式

```typescript
/**
 * 计算下一次重试的等待时间（毫秒）。
 *
 * @param attempt     当前 attempt 编号（1-based；第 1 次失败后算 attempt=1 的 delay）
 * @param retryAfter  分类错误携带的 Retry-After（秒），无则 undefined
 * @param config      { backoffBaseS, backoffCapS, jitter }
 * @returns 等待毫秒数
 */
function getRetryDelay(
  attempt: number,
  retryAfter: number | undefined,
  config: { backoffBaseS: number; backoffCapS: number; jitter: boolean },
): number {
  const baseMs = config.backoffBaseS * 1000;
  const capMs = config.backoffCapS * 1000;

  // 1. retry-after 优先（尊重 provider 反压）
  if (retryAfter !== undefined) {
    return Math.min(retryAfter * 1000, capMs);   // cap 防病态（CAP_RETRY_AFTER_S 已在 classify 阶段 cap 过，此处再防）
  }

  // 2. 指数退避：min(base * 2^(attempt-1), cap)
  const exp = Math.min(baseMs * Math.pow(2, attempt - 1), capMs);

  // 3. 半 jitter（claude-code 风格）：+ random * 0.25 * base
  //    全 jitter（hermes 风格）会让最小延迟过低；半 jitter 保下限又散列
  if (config.jitter) {
    const jitterSeed = getCounterSeedJitter();   // §1.2 进程级 counter seed
    return exp + Math.floor(jitterSeed * 0.25 * baseMs);
  }
  return exp;
}
```

### 1.2 counter seed jitter（防并发同步重试）

**问题**：多 session 并发重试时，若都用 `Math.random()`，理论上独立；但高并发下仍可能瞬时同步（同一毫秒 N 个 session 同时退避后同时重试，加剧限流）。hermes 用进程级 counter seed 散列。

```typescript
let __retryCounter = 0;
function getCounterSeedJitter(): number {
  __retryCounter = (__retryCounter + 1) % 1000;
  // 混合 counter 与 random，保证并发不撞 + 仍随机
  return (Date.now() % 1000 + __retryCounter + Math.random() * 1000) % 1000 / 1000;
}
```

### 1.3 默认值（reqs.md §6 锁定）

| 参数 | 默认值 | 来源 |
|---|---|---|
| `max_attempts` | 3 | reqs.md（短而少，靠 fallback chain 兜底） |
| `backoff_base_s` | 2 | reqs.md（claude-code 0.5 太激进，hermes 5 太长） |
| `backoff_cap_s` | 30 | reqs.md |
| `jitter` | true | reqs.md |

**attempt 1 失败 → delay = 2s + jitter；attempt 2 失败 → delay = 4s + jitter；attempt 3 失败 → throw（max=3）**。

---

## 2. 分阶段超时看门狗（Watchdog）

### 2.1 三个计时器

| 计时器 | 默认阈值 | 触发条件 | abort reason | 后续 category |
|---|---|---|---|---|
| **TTFB**（首 chunk） | 45s | stream 启动后首个 chunk 未到达 | `"watchdog_ttfb"` | `TIMEOUT_FIRST_CHUNK` |
| **chunk 间 stall**（阶段感知） | answer 30s / think 30s / tool 120s | 首 chunk 后，相邻 chunk 间隔超阈值 | `"watchdog_stall"` | `TIMEOUT_INTER_CHUNK` |
| **wall-clock 兜底** | 600s | invoke 开始到当前总时长超 | `"wall_max"` | `TIMEOUT_INTER_CHUNK` |

### 2.2 阶段感知 stall（v0.0.25 自创，refs 都没实现）

stream 收到 chunk 时，按当前 StreamEvent 类型判定阶段，切换 stall 阈值：

```typescript
function getStallThreshold(evt: StreamEvent, config: TimeoutConfig): number {
  switch (evt.type) {
    case "thinking_delta": return config.stallThinkS * 1000;    // 30s（reasoning 模型合法停顿）
    case "tool_call_delta": return config.stallToolS * 1000;    // 120s（tool 实参流式期）
    case "text_delta":
    case "usage":
    case "finish":
    default: return config.stallAnswerS * 1000;                 // 30s（answer 阶段）
  }
}
```

每个 chunk 到达 → `reset stall timer` 用当前阶段的阈值。

### 2.3 tool 阶段切分（实参流式 vs 工具执行期）

**关键**（reqs.md §4 待 arch 细化点）：tool 阶段分两种：
- **tool 实参流式期**：LLM 仍在 stream，产 `tool_call_delta` 事件 → **进 stall 计时**（用 `stall_tool_s`=120s）。
- **工具执行期**：LLM stream 已结束（finish 事件已到），agent loop 在执行 tool → LLM 不流式 → **不进 stall 计时**。

**实现**：LlmCaller.invoke 在 stream 正常结束（finish 事件）后**停所有 stall timer**，return resp 给 agent loop；agent loop executeTools 期间 LlmCaller 不持有任何计时器（invoke 已返回）。下次 iteration 调 invoke 时重新启动 watchdog。

```
invoke():
  watchdog.start()
  for await chunk in stream:
    if first chunk: switch TTFB → stall
    reset stall with phase threshold
    onEvent(chunk)
  watchdog.stop()   ← stream 正常结束，停所有 timer
  return resp
                              ← agent loop executeTools 期间无计时器（invoke 已 return）
                              ← 下一 iteration invoke() 再 watchdog.start()
```

**注**：tool stall（120s）只覆盖「LLM 流式产 tool 实参」阶段，不覆盖「agent 执行工具」阶段（那个由 agent loop / tool engine 自己的 timeout 管，归 executeTools，见 `agent_loop_base §2.2`）。

---

## 3. composite AbortController + abortReason 事前记录

### 3.1 abort 来源（4 种）

```typescript
type AbortReason = "user" | "watchdog_ttfb" | "watchdog_stall" | "wall_max";
```

| 来源 | 触发 | category | partial 处理 | 进重试？ |
|---|---|---|---|---|
| `"user"` | agent loop controller.aborted=true（用户中断） | `ABORTED_BY_USER` | **保留** | **否** |
| `"watchdog_ttfb"` | TTFB 计时器到 | `TIMEOUT_FIRST_CHUNK` | 丢弃 | 是 |
| `"watchdog_stall"` | stall 计时器到 | `TIMEOUT_INTER_CHUNK` | 丢弃 | 是 |
| `"wall_max"` | wall-clock 到 | `TIMEOUT_INTER_CHUNK` | 丢弃 | 是 |

### 3.2 实现：事前记录 abortReason

**claude-code 教训**：事后推断（`signal.aborted && err instanceof APIUserAbortError`）不可靠 —— SDK 内部 timeout 也 set signal.aborted，会误判为用户 abort。

**v0.0.25 做法**：自管 composite AbortController，**abort 前先设 abortReason 变量**：

```typescript
class CompositeAbortController {
  private controller = new AbortController();   // Web API AbortController
  private _reason: AbortReason | null = null;
  
  readonly signal: AbortSignal = this.controller.signal;
  
  get reason(): AbortReason | null { return this._reason; }
  
  /** 用户中断（来自 agent loop controller） */
  abortByUser(): void {
    if (this._reason) return;   // 已 abort，不覆盖
    this._reason = "user";
    this.controller.abort(new DOMException("aborted by user", "AbortError"));
  }
  
  /** 看门狗 TTFB 超时 */
  abortByTtfbTimeout(): void {
    if (this._reason) return;
    this._reason = "watchdog_ttfb";
    this.controller.abort(new DOMException("ttfb timeout", "AbortError"));
  }
  
  /** 看门狗 stall 超时 */
  abortByStallTimeout(): void {
    if (this._reason) return;
    this._reason = "watchdog_stall";
    this.controller.abort(new DOMException("stall timeout", "AbortError"));
  }
  
  /** wall-clock 兜底 */
  abortByWallMax(): void {
    if (this._reason) return;
    this._reason = "wall_max";
    this.controller.abort(new DOMException("wall max", "AbortError"));
  }
}
```

LlmCaller.invoke 创建 `CompositeAbortController`，把 `signal` 传给 `client.stream(req, signal)`；watchdog 计时器和 agent loop controller 各调对应 abort 方法。

**catch 块判定**：

```typescript
try {
  for await (const chunk of stream) { ... }
} catch (err) {
  if (err instanceof DOMException && err.name === "AbortError") {
    // abort 来源由 _reason 决定（不靠推断）
    const reason = compositeController.reason;
    if (reason === "user") return { kind:"abort", reason:"user" };
    const category = reason === "watchdog_ttfb" ? LlmErrorCategory.TIMEOUT_FIRST_CHUNK : LlmErrorCategory.TIMEOUT_INTER_CHUNK;
    return { kind:"error", err: makeClassified(category, { rawError: err }) };
  }
  // 非 abort 错误 → 走 classify
  return { kind:"error", err: classify(err, provider) };
}
```

---

## 4. partial 保留策略

| 场景 | partial | 理由 |
|---|---|---|
| 用户 abort | **保留**（写 errorState.partialResult） | 用户主动，可能想看半截回复 |
| watchdog_ttfb abort | 丢弃 | 首 chunk 都没到，无 partial 可言 |
| watchdog_stall abort | 丢弃（除非无未完成 tool_use） | 流断 partial 不可信 |
| wall_max abort | 丢弃 | 同上 |
| STREAM_INCOMPLETE（流断非 abort） | 保留（若无未完成 tool_use，供 prefill） | 见 `[P0]length_handling §3` |
| MAX_TOKENS_EXCEEDED | 保留（供 prefill 续写） | 见 `[P0]length_handling §2` |

**判定「partial 可保留」**：partial message 无 `ToolCallBlock` 或所有 ToolCallBlock 的 `arguments` 已完整（JSON 可解析）。

---

## 5. 设计决策（Why）

### 5.1 半 jitter 而非全 jitter

**结论**：`exp + random*0.25*base`（半 jitter），不用 hermes 的全 jitter `random * exp`。
**理由**：全 jitter 让最小延迟接近 0，高并发下退避无效（瞬时全涌上）；半 jitter 保下限（exp）+ 散列（0.25*base 抖动），claude-code 实测有效。

### 5.2 retry-after 优先但 cap

**结论**：有 `Retry-After` 时优先用，但 `min(retryAfter, backoff_cap_s)`。
**理由**：尊重 provider 反压（它知道自己多久恢复）；但病态 header（6h）会卡死，cap 在 30s（默认）防病态。注意 classify 阶段已 cap 在 600s，退避阶段再 cap 在 config.backoffCapS（30s）—— 双层 cap 更保守。

### 5.3 TTFB 单独计时（45s）

**结论**：TTFB 45s 单独计时，首 chunk 后切 stall。
**理由**：claude-code 没显式 TTFB（靠 idle watchdog 兜底 90s），但 45s 内首 chunk 不到通常是 provider 不可达 / 严重排队，继续等无意义。45s 阈值参考 anthropic 平均 TTFB（1-5s）+ 容错。

### 5.4 abortReason 事前记录（改进 claude-code）

**结论**：abort 前设 `_reason` 变量，catch 块读 `_reason` 决定 category，不靠 `err instanceof APIUserAbortError`。
**理由**：claude-code 教训 —— SDK 内部 timeout 也 set signal.aborted，事后推断会误判。事前记录是干净的设计（CompositeAbortController 把 reason 当一等公民）。

### 5.5 tool stall 切分（实参流式 vs 工具执行）

**结论**：stall_tool_s（120s）只覆盖 LLM 流式产 tool 实参阶段；工具执行期 LlmCaller.invoke 已 return，不持有计时器。
**理由**：工具执行期 LLM 不流式，不该用 LLM 的 stall 阈值（工具可能合法跑几分钟，如 bash 长命令）；executeTools 自己有 timeout（agent_loop_base §2.2）。
**反例**：若 tool 执行期仍计 stall_tool_s，长工具会被误 abort。

### 5.6 wall-clock 兜底 600s

**结论**：invoke 开始累计 wall-clock，超 600s 兜底 abort。
**理由**：兜底所有计时器漏判场景（如 stall 阈值被 config 调极高 + 多次重试）。600s 参考 claude-code `API_TIMEOUT_MS`。

---

## 6. 边界

| 零件 | 归属 |
|------|------|
| getRetryDelay 公式 + counter seed + 默认值 | 本文件 §1 ✅ |
| 三计时器（TTFB / stall / wall）+ 阶段感知 | 本文件 §2 ✅ |
| tool stall 切分（实参流式 vs 工具执行） | 本文件 §2.3 |
| CompositeAbortController + abortReason 事前记录 | 本文件 §3 ✅ |
| partial 保留策略 | 本文件 §4 |
| decide（调 getRetryDelay / 读 abortReason） | `[P0]llm_caller.md §3` |
| TimeoutConfig / RetryConfig schema | `[P0]llm_request_config.md §2` |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
