---
type: interface
title: Length Handling（CONTEXT_LENGTH 压缩 + MAX_TOKENS prefill/bump）
priority: P0
status: active
updated: 2026-06-30
since: v0.0.25
related: [[P0]llm_caller.md, [P0]error_normalization.md, [P0]llm_request_config.md]
---

# Length Handling（CONTEXT_LENGTH 压缩 + MAX_TOKENS prefill/bump）

> 管什么：两类 length 错误的处理决策树 + 数据流 —— `CONTEXT_LENGTH_EXCEEDED`（输入超 → 压缩）/ `MAX_TOKENS_EXCEEDED`（输出触顶 → prefill 续写 或 bump）/ `STREAM_INCOMPLETE`（不 bump）。
> 不管什么：错误分类（→ `[P0]error_normalization.md §4.3`）；modelConfig 能力位（→ `../providers_and_models/[P0]llm_model_interface.md` 扩展）；上下文压缩具体算法（→ `../context/[P0]context_compact_detail.md`）。
> **核心创新（refs 没有）**：STREAM_INCOMPLETE 区分 + prefill 续写（partial assistant turn 续接，**当前 defer / later — 见 §2.1**）。
> **两个 MAX_TOKENS category 机制分开，绝不混用**：`MAX_TOKENS_TOO_HIGH`（请求越界 / provider 400 / validate 拒）→ **降**（recentErrors 复合 `base × 0.7^downHits`，见 `[P0]llm_request_config §2.4`）；`MAX_TOKENS_EXCEEDED`（stop_reason=length 输出触顶）→ **升**（one-shot ceiling bump，§2.2，**不走 recentErrors / 不复合 / 不 ×0.7**）。

---

## 1. 两类 length 错误的杠杆（reqs.md §5）

| 错误 | 杠杆 | max_tokens |
|---|---|---|
| `CONTEXT_LENGTH_EXCEEDED`（输入超长） | 压缩/截断输入后重试；粘性→提前压缩 | 非主杠杆（可次要降低换输入空间） |
| `MAX_TOKENS_EXCEEDED`（输出触顶） | 让模型说完整 | **增加**或**续写**，绝不降低 |

**绝不混淆**：降 max_tokens 是给 CONTEXT_LENGTH 的；MAX_TOKENS 必须增或续写。hermes 教训：混淆会 3 次无效 bump。

---

## 2. MAX_TOKENS_EXCEEDED 输出触顶决策树

```
收到 MAX_TOKENS_EXCEEDED（stop_reason=length, 无未完成 tool_use）
  │
  ├─ 2a. partial 可 salvage？
  │     │  判定：partial.message.content 中所有 ToolCallBlock.arguments 已完整（JSON 可解析）
  │     │        且至少有一个 TextBlock 或完整 ToolCallBlock
  │     │
  │     ├─ 否（partial 不可 salvage：有未完成 tool_use）→ 走 STREAM_INCOMPLETE 路径（不 bump，§4）
  │     │
  │     └─ 是（salvageable）→
  │           ├─ [v0.0.25 实现] 【one-shot ceiling bump 重跑】（§2.2）
  │           │     bumpMaxTokensToOneShotCeiling：max_tokens = model.capabilities.maxOutputTokens
  │           │     若 current_max_tokens ≥ ceiling 仍 length → throw / 转 STREAM_INCOMPLETE（输出超 model 能力，无法）
  │           │     重跑（丢弃 partial，从头生成）；不 append recentErrors；不 ×0.7；不复合
  │           │
  │           └─ [future / later，v0.0.25 不实现] prefill 续写（§2.1）
  │                 理想解：纯文本 partial && supportsPrefill → prefill 续写（省 token，体验更连贯）
  │                 v0.0.25 defer：先 bump ceiling 兜底；待 length-hit 频繁时实现 prefill
```

**[v0.0.25 rev2 纠正]** one-shot ceiling 而非渐进 ×2：EXCEEDED 是「模型能说更多但被截断」，一次性给到 model 上限最省事。**不进 recentErrors、不复合**（理由见 §2.2 边界段）。

### 2.1 prefill 续写（Anthropic Messages API 特性）— v0.0.25 defer / later

> **[v0.0.25 defer]** prefill 续写是**理想解**（省 token + 体验连贯），v0.0.25 **不实现**——salvageable partial 走 §2.2 one-shot ceiling bump 兜底（从头生成）。本节描述 future 实现，**v0.0.25 不走此分支**；保留 spec 避免 future 重设计。

**Anthropic Messages API 支持**：把 partial assistant turn 作为 `messages[]` 最后一条，模型会**续写**（而非重新生成）。

**数据流**：

```typescript
// buildRequest 中应用 prefill overlay
function applyPrefillOverlay(baseReq: CanonicalRequest, partial: Message): CanonicalRequest {
  return {
    ...baseReq,
    messages: [
      ...baseReq.messages,
      partial,   // ← partial assistant turn（role:"assistant"，含已生成的 text/tool_use block）
    ],
    params: {
      ...baseReq.params,
      maxTokens: remainingBudget,   // ← 剩余预算（model.maxOutputTokens - partial.usage.output_total_tokens）
    },
  };
}
```

**wire body 示例**（Anthropic，future）：messages 数组最后一条为 `{role:"assistant", content:[{type:"text", text:"partial answer..."}]}`，模型续写产出的 chunk **接着 partial 的 text**（不重复已生成内容）。

**拼接规则**（agent loop 收到续写后）：
- 续写流的 `text_delta` 直接 append 到原 partial message 的 TextBlock（按 messageId:partIndex 路由，同 `[P0]llm_protocol_interface §3.6` 平行变体规则）。
- 续写流的 `tool_call_delta`：若 partial 已有同 toolCallId 的 ToolCallBlock，append 到该 block 的 arguments；若是新 toolCallId，新建 block。
- 续写流的 `usage` 事件：**累加**到 partial usage（input 不重复计，output 累加）。
- 续写流的 `finish` 事件：若 reason 仍是 `max_tokens` 且 partial 仍可 salvage → 递归续写（限 1 次递归，避免无限）。

**递归限制**：prefill 续写最多 1 次（总输出预算 = `2 * model.maxOutputTokens` 封顶）。第二次续写仍触顶 → 上抛用户（已尽力）。

### 2.2 max_tokens bump 重跑（one-shot ceiling — v0.0.25 实现路径）

**决策**：salvageable partial（无未完成 tool_use）→ v0.0.25 走 **one-shot ceiling bump**：直接把 max_tokens 提到 model 上限重跑。

```typescript
function bumpMaxTokensToOneShotCeiling(current: number, model: LlmModelConfig): number {
  const ceiling = model.capabilities.maxOutputTokens;   // model 硬上限
  if (current >= ceiling) {
    throw new ClassifiedLlmError({
      category: LlmErrorCategory.MAX_TOKENS_EXCEEDED,   // 或转 STREAM_INCOMPLETE
      message: `output hit max_tokens ceiling (${ceiling}) but still stop_reason=length — exceeds model capability`,
      hints: { retryable:false, /* ...no bump possible */ },
    });
  }
  return ceiling;   // one-shot 直接到上限（非渐进 ×2）
}
```

**关键 [v0.0.25 rev2 纠正]**：
- **不写 `errorState.maxTokensOverlay`**（字段已 @deprecated，见 `[P0]llm_request_config §2`）；bumped 值由 buildRequest 判 attempt 标志位算（不存 overlay）。
- **不 append `errorState.recentErrors`、不复合、不 ×0.7** —— EXCEEDED 与连续错误历史无关；塞进 recentErrors 会与 TOO_HIGH count 混淆派生错误 maxTokens（两类方向相反：升 vs 降）。×0.7 是 TOO_HIGH 降级机制（`[P0]llm_request_config §2.4` deriveMaxTokens 专管），EXCEEDED 不走那条。
- **重跑丢弃 partial**：从头生成（prefill defer 到 later，见 §2.1）。
- **封顶**：已到 `maxOutputTokens` 硬上限仍触顶 → throw（输出超 model 能力，无法兜底，不无限重试）。

**与 `[P0]llm_request_config §2.4` 的边界**：deriveMaxTokens `base × 0.7^downHits` **只数 TOO_HIGH**（降级）；EXCEEDED bump 由本节独立处理（升级），两函数各管一类，互不调用、互不复用 recentErrors。

---

## 3. CONTEXT_LENGTH_EXCEEDED 处理（输入压缩）

### 3.1 触发后处理

```
收到 CONTEXT_LENGTH_EXCEEDED（含 reportedContextWindow?）
  │
  ├─ 3a. 本次调用降 max_tokens（若 provider 报告了 context window）
  │     当前 max_tokens + 输入超 context → 降 max_tokens 腾输入空间
  │     本次: req.params.maxTokens = max(原值 - (input - reportedContextWindow), 安全下限)
  │
  ├─ 3b. 触发上下文压缩（ContextEngine.compact）
  │     errorState.precompress = true（粘性标记）
  │     → buildRequest 调 ContextEngine 压缩 messages（见 context_compact_detail）
  │
  └─ 3c. 重试（FIX_AND_RETRY）
```

### 3.2 粘性预压缩（跨 iteration）

**reqs.md 关键**：连续触发 CONTEXT_LENGTH → 下一 iteration 主动预压缩（不等地报错）。

```typescript
// errorState.consecutiveContextLength 累加
// 达阈值（默认 1，即上次报错这次就预压） → precompress=true 持续生效
```

**buildRequest 检查**：

```typescript
function applyCompressOverlay(baseReq, errorState, contextEngine): CanonicalRequest {
  if (errorState.precompress) {
    return {
      ...baseReq,
      messages: contextEngine.compact(baseReq.messages, { targetRatio: 0.8 }),  // 压到 80%
    };
  }
  return baseReq;
}
```

### 3.3 不瞎猜 context window（hermes 教训）

**结论**：CONTEXT_LENGTH_EXCEEDED 后**不**永久调小 context window；只在 provider 明确报告时本次调用降 max_tokens，粘性状态只设「预压缩标记」。
**理由**：hermes refs `model_metadata.py:1014-1027` 教训 —— 瞎猜窗口会让后续所有调用都被错误限制。context window 是模型固有属性（modelConfig），LlmCaller 无权改它；只能改本次 max_tokens（腾输入空间）或压缩输入。

---

## 4. STREAM_INCOMPLETE 区分（必学避坑）

**hermes 教训**（refs `chat_completion_helpers.py:2054-2108`）：partial tool args + 无 finish_reason 时若误标 MAX_TOKENS 会 3 次无效 bump（bump 后 tool args 仍不完整，因为真因是流断不是触顶）。

**v0.0.25 严格区分**：

| 场景 | stop_reason | tool args 完整？ | → category | bump？ |
|---|---|---|---|---|
| 正常触顶 | `max_tokens` | 是（或无 tool_use） | `MAX_TOKENS_EXCEEDED` | 是（prefill 或 bump） |
| 流断 + tool args 未完成 | 无 / `max_tokens` | 否（`input_json_delta` 中断，JSON 不可解析） | `STREAM_INCOMPLETE` | **否** |
| 流断无 finish | 无 | — | `STREAM_INCOMPLETE` | **否** |

**STREAM_INCOMPLETE 处理**：
- retryable=true（可退避重试，可能是瞬时网络断）。
- **不**进 max_tokens-boost 路径。
- 不保留 partial（partial 含未完成 tool_use，不可用）。
- 连续 STREAM_INCOMPLETE → provider 可能有问题，escalate（升级健康状态）。

**判定 tool args 完整**：parseStream 在 finish / 流断时，检查所有 ToolCallBlock 的 `arguments` 字段是否能 `JSON.parse` 成功（closing `}`）。失败则标 STREAM_INCOMPLETE。

---

## 5. ModelCapability 能力位（modelConfig 扩展）

`[P0]llm_model_interface.md` 的 `LlmModelConfig` 加能力位字段：

```typescript
interface LlmModelConfig {
  // ... 原有字段
  /** [v0.0.25] length 处理能力位 */
  capabilities: ModelCapability;
}

interface ModelCapability {
  /** 单次最大输出（token）—— 原有字段，移入 capabilities */
  maxOutputTokens: number;
  /** 是否支持 prefill 续写（partial assistant turn 续接）—— Anthropic Messages API 支持 */
  supportsPrefill: boolean;
  /** 是否支持 extended thinking（reasoning）—— 影响是否产 thinking_delta */
  supportsThinking: boolean;
}
```

**各模型事实**（初始值，后续按实测调整）：

| 模型 | supportsPrefill | supportsThinking |
|---|---|---|
| Anthropic claude-* (anthropic_messages) | true | true（若启用 extended thinking） |
| OpenAI gpt-* (openai_chat_completions) | false（OpenAI 不支持 prefill 语义） | false（reasoning 模型另计） |
| GLM glm-* | false（待实测） | false |

**为什么单独能力位**：prefill 是模型固有特性（不是所有 provider 都支持把 assistant turn 续写），需在 modelConfig 声明，供 buildRequest 决策。`maxOutputTokens` 也移入 `capabilities`（语义上是「输出能力」，与 pricing 等其他字段正交）。

> **向后兼容**：原 `maxOutputTokens` 顶层字段保留为 alias（`model.maxOutputTokens` === `model.capabilities.maxOutputTokens`），迁移期 v0.0.25 双路径可读。

---

## 6. max_tokens_bump_strategy config

`llm_request.length.max_tokens_bump_strategy`（reqs.md §6）：

```typescript
type MaxTokensBumpStrategy = "continue" | "increase" | "none";

// continue: 优先 prefill 续写（若 supportsPrefill）—— **v0.0.25 defer，行为同 increase**
// increase: 直接 bump max_tokens 到 ceiling（不试 prefill）—— v0.0.25 实际路径
// none:     不处理，直接上抛用户
```

**默认 `continue`**（reqs.md）。

**buildRequest 决策**（v0.0.25 prefill defer 后的实际行为）：

```typescript
function decideMaxTokensAction(
  partial: Message,
  model: LlmModelConfig,
  currentMaxTokens: number,
  strategy: MaxTokensBumpStrategy,
): { action: "prefill" } | { action: "bump"; newMax: number } | { action: "throw" } {
  const salvageable = isSalvageable(partial);   // 无未完成 tool_use

  if (strategy === "none") return { action: "throw" };

  // [v0.0.25 defer] continue && salvageable && supportsPrefill → 理论上 prefill，
  // 但 v0.0.25 不实现 prefill，fallback 到 increase 路径（one-shot ceiling bump）。
  // future：实现 prefill 后此处 return { action: "prefill" }。

  if (currentMaxTokens < model.capabilities.maxOutputTokens) {
    return { action: "bump", newMax: bumpMaxTokensToOneShotCeiling(currentMaxTokens, model) };
  }

  return { action: "throw" };   // 已到硬上限
}
```

---

## 7. 设计决策（Why）

### 7.1 prefill 续写是 future target（v0.0.25 defer）

**结论**：MAX_TOKENS + supportsPrefill + salvageable → **理想**走 prefill 续写；**v0.0.25 不实现，先走 §2.2 ceiling bump 兜底**，待 length-hit 频繁时实现。
**理由（defer）**：v0.0.25 优先级是先收口错误归一化 + 降级/外显/validate；prefill 涉及续写流拼接 + 递归限制 + 能力位探测，工作量大且 length-hit 频率未知。先用 bump 兜底，prefill 留 future（不删 spec 避免 future 重设计）。

### 7.2 [future] 续写递归限 1 次（prefill 实现后适用）

**结论**：prefill 续写最多递归 1 次（总预算 2*maxOutputTokens）—— 单次回复超此极罕见、防死循环、覆盖绝大多数场景。第二次仍触顶 → 上抛。**v0.0.25 prefill defer，本条 future 适用**。

### 7.3 STREAM_INCOMPLETE 严格不 bump

**结论**：无 stop_reason / tool args 未完成 → STREAM_INCOMPLETE，不进 bump 路径。
**理由**：hermes 教训 —— bump 后 tool args 仍不完整（真因流断），3 次浪费配额。

### 7.4 不瞎猜 context window

**结论**：CONTEXT_LENGTH 后不永久调小窗口，粘性只设预压缩标记。
**理由**：hermes 教训 —— 瞎猜窗口会错误限制后续调用。窗口是模型固有属性（modelConfig），LlmCaller 无权改。

### 7.5 ModelCapability 单独能力位

**结论**：supportsPrefill / supportsThinking 放 modelConfig.capabilities（per-model 事实）。
**理由**：这是模型固有特性（不是 config / 不是 protocol），归 modelConfig。与 pricing / contextWindow 同级。

---

## 8. 边界

| 零件 | 归属 |
|------|------|
| MAX_TOKENS 决策树（prefill / bump / throw） | 本文件 §2 ✅ |
| prefill 续写数据流 + 拼接规则 | 本文件 §2.1 ✅ |
| bump 算法 + 封顶 | 本文件 §2.2 ✅ |
| CONTEXT_LENGTH 压缩 + 预压缩粘性 | 本文件 §3 ✅ |
| STREAM_INCOMPLETE 区分 | 本文件 §4 ✅ |
| ModelCapability（supportsPrefill / supportsThinking） | 本文件 §5（modelConfig 扩展同步到 `[P0]llm_model_interface`） |
| 上下文压缩具体算法 | `../context/[P0]context_compact_detail.md` |
| LlmErrorCategory 分类 | `[P0]error_normalization.md §4.3` |

## 9. 边界补充

> prefill（§2.1）当前 defer / later；MAX_TOKENS_EXCEEDED（升，one-shot ceiling bump，不走 recentErrors）与 MAX_TOKENS_TOO_HIGH（降，recentErrors ×0.7）机制彻底分开，绝不混用。

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
