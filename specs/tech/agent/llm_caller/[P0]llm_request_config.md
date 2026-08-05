---
type: interface
title: llm_request Config Group + LlmErrorState + 多 key credentials + fallback_chain
priority: P0
status: active
updated: 2026-06-30
since: v0.0.25
related: [[P0]llm_caller.md, [P0]provider_health_registry.md, ../providers_and_models/[P0]llm_provider_interface.md]
---

# `llm_request` Config Group + LlmErrorState + 多 key credentials + fallback_chain

> 管什么：(1) `llm_request` config group 定义（app_config 新 group）+ 默认值；(2) `RunState.llmErrorState` schema（跨 iteration 继承的 overlay）；(3) credentials 单 key → 多 key 扩展 + keyRef 选择器；(4) fallback_chain 结构。
> 不管什么：app_config KV 机制（→ `../../config/[P0]app_config.md`）；ProviderHealthRegistry 状态机（→ `[P0]provider_health_registry.md`）；config 持久化迁移（schema 落 spec，迁移脚本视情况）。

---

## 1. `llm_request` config group（app_config 新增 group）

### 1.1 group 定义

`app_config` 新增 group `llm_request`（与 appearance / providers / locale 并列）。按 `[P0]app_config.md §1` KV-sharded 形态：

```json
{
  "group": "llm_request",
  "key": "default",
  "data": {
    "timeout":     { "ttfb_s": 45, "stall_answer_s": 30, "stall_think_s": 30, "stall_tool_s": 120, "wall_max_s": 600 },
    "retry":       { "max_attempts": 3, "backoff_base_s": 2, "backoff_cap_s": 30, "jitter": true },
    "degradation": { "cooldown_s": 300, "consecutive_to_degrade": 3, "respect_retry_after": true },
    "length":      { "auto_compress": true, "precompress_threshold_ratio": 0.8, "max_tokens_bump_strategy": "continue" },
    "fallback_chain": [
      { "providerId": "01KVC9A2...", "keyRef": "default", "modelId": "claude-sonnet-4-6" },
      { "providerId": "01KVC9B5...", "keyRef": "default", "modelId": "gpt-4o" }
    ]
  }
}
```

**key = "default"**：llm_request 是全局配置（单实例），用固定 key `"default"`。

### 1.2 schema + 默认值

```typescript
interface LlmRequestConfig {
  timeout: TimeoutConfig;
  retry: RetryConfig;
  degradation: DegradationConfig;
  length: LengthConfig;
  fallbackChain: FallbackChainItem[];
}

interface TimeoutConfig {
  ttfb_s: number;              // TTFB 阈值（首 chunk），默认 45
  stall_answer_s: number;      // answer 阶段 chunk 间 stall，默认 30
  stall_think_s: number;       // think 阶段，默认 30
  stall_tool_s: number;        // tool 实参流式期，默认 120
  wall_max_s: number;          // wall-clock 兜底，默认 600
}

interface RetryConfig {
  max_attempts: number;        // 单 provider 内最大 attempt，默认 3
  backoff_base_s: number;      // 退避基数，默认 2
  backoff_cap_s: number;       // 退避上限，默认 30
  jitter: boolean;             // 半 jitter 开关，默认 true
}

interface DegradationConfig {
  cooldown_s: number;                  // 单次冷却窗口，默认 300
  consecutive_to_degrade: number;      // 升级阈值，默认 3
  respect_retry_after: boolean;        // 是否尊重 Retry-After header，默认 true
}

interface LengthConfig {
  auto_compress: boolean;                  // CONTEXT_LENGTH 是否自动压缩，默认 true
  precompress_threshold_ratio: number;     // 预压缩目标比例（0.8 = 压到 80%），默认 0.8
  max_tokens_bump_strategy: MaxTokensBumpStrategy;  // "continue" | "increase" | "none"，默认 "continue"
}

interface FallbackChainItem {
  providerId: string;     // → app_config providers 组某条实例（LlmProviderConfig.id = data.id）
  keyRef: string;         // → 该 provider credentials 中的 key 引用（"default" / "backup" / ...）
  modelId: string;        // → 该 provider models[] 中的一条（LlmModelConfig.modelId）
}
```

### 1.3 不配 = 默认，配了 = 按配置

按 `[P0]app_config.md §5` AppConfigService 语义：record 不存在 = 未配置。`LlmRequestConfigService`（新建，类比 AppConfigService）做**缺省→默认回退**（区别于 AppConfigService 不回退）：

```typescript
interface LlmRequestConfigService {
  /** 取 llm_request config；record 不存在返回 DEFAULT_LLM_REQUEST_CONFIG */
  get(): LlmRequestConfig;
  /** 写 llm_request config（整体替换） */
  set(config: LlmRequestConfig): void;
}

const DEFAULT_LLM_REQUEST_CONFIG: LlmRequestConfig = {
  timeout:     { ttfb_s:45, stall_answer_s:30, stall_think_s:30, stall_tool_s:120, wall_max_s:600 },
  retry:       { max_attempts:3, backoff_base_s:2, backoff_cap_s:30, jitter:true },
  degradation: { cooldown_s:300, consecutive_to_degrade:3, respect_retry_after:true },
  length:      { auto_compress:true, precompress_threshold_ratio:0.8, max_tokens_bump_strategy:"continue" },
  fallbackChain: [],   // 空 chain = 只用调用方传入的单一 provider，无 fallback
};
```

**为什么 llm_request 回退默认而 app_config 不回退**：llm_request 是调优参数（用户不配应能用合理默认），app_config providers 是权威值（不配 = 没配 provider，不能用）。语义不同。

### 1.3.1 config 装配接线（生效链路 — v0.0.144）

`LlmRequestConfigService.get()` 的返回值必须一路接线到 invoke，否则 config 形同虚设。**接线现状**：`buildSessionConfigFromDeps`（`handlers/session-config.ts`，唯一持 `deps.appConfig` 句柄）调 `new LlmRequestConfigService(deps.appConfig).get()` 落 `SessionConfig.llmRequestConfig`，并 `listEnabledProviders(deps.appConfig)` 落 `SessionConfig.allProviders`（宽转 `LlmProviderConfig[]`）；两个 stage-llm（`callLLMForSpec` 主路径 + `stageLLMRequest` 旧/EOS 路径）透传到 `baseCallLLM` → `InvokeContext.config`。完整链路 + 断链背景（v0.0.25 起 `get()` 仅 HTTP handler 调用、生产 loop 从不接线致恒回退 DEFAULT）见 `[P0]llm_caller.md §4.1`。**health 不接线**（进程单例四元组隔离，见 `[P0]provider_health_registry.md §6.5`）。

### 1.4 resolveTarget 遍历规则（dedup）

`resolveTarget(fallbackChain, health, errorState)` 遍历 chain：

```typescript
function resolveTarget(chain, health, errorState): Target | { kind:"all_dead" } {
  const seen = new Set<string>();   // (providerId, modelId, baseUrl) dedup
  for (const item of chain) {
    const provider = loadProvider(item.providerId);
    const key = resolveKey(provider.credentials, item.keyRef);   // §3 keyRef 选择器
    const model = findModel(provider, item.modelId);
    
    // dedup 三元组（避免切回死路，hermes 教训）
    const dedupKey = `${item.providerId}|${item.modelId}|${provider.baseUrl}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    
    // 查健康
    const avail = health.isAvailable(item.providerId, item.keyRef);
    if (!avail.ok) continue;
    
    return { provider, key, model, client: getClient(provider, key, model) };
  }
  return { kind:"all_dead", reason: "all fallback chain items unavailable" };
}
```

**fallback_chain 为空时**：用调用方（agent loop）传入的单一 provider/model（向后兼容，无 fallback 能力但有 retry）。

---

## 2. RunState.llmErrorState（跨 iteration overlay）

> **[v0.0.25 改版]**：LlmErrorState 持**连续错误历史**（`recentErrors`）作为「连续错误」的真相源；`maxTokens` 降级因子**派生不存储**（`maxTokensOverlay` 删除/废弃）。成功调用清空整个 `recentErrors`（clearRecentErrors）。本节为改版后权威定义。

### 2.1 schema

```typescript
interface LlmErrorState {
  /**
   * [连续错误历史 — v0.0.25 新增] 最近 N 次连续错误（attempt 内 + 跨 iteration 累积）。
   * 上限 = config.retry.max_attempts − 1（默认 max_attempts=3 → 上限 2 条）。
   * 每次 error（attemptLoop catch 到 ClassifiedLlmError）按时间序 append；超过上限丢最旧。
   * 成功调用（attemptLoop 返回 ok）→ clearRecentErrors() 清空整个数组。
   * 这是「连续错误」的真相源：retry 升级 / fallback / maxTokens 派生 / precompress 触发 全读它。
   */
  recentErrors: Array<{
    category: LlmErrorCategory;
    /** 该次错误发生时的目标 model（provider + key + model 三元组快照） */
    modelEntry: { providerId: string; keyRef: string; modelId: string };
    /** 错误发生时间（epoch ms）—— 用于 langfuse / debug 排序 */
    at: number;
  }>;

  /** [粘性] 预压缩标记（CONTEXT_LENGTH 连续达阈值后持续生效） */
  precompress?: boolean;

  /** [粘性] prefill 续写的 partial（MAX_TOKENS_EXCEEDED 的 prefill 决策，下轮 buildRequest 应用） */
  prefillPartial?: Message;

  /** [计数] 连续 CONTEXT_LENGTH 次数（达阈值设 precompress）—— 由 recentErrors 派生，仍保留方便判定 */
  consecutiveContextLength: number;

  /** [瞬时] partial 结果（abort 时保留，供 agent loop 决定是否上抛半截回复） */
  partialResult?: { message: Message; usage?: Usage };

  /** @deprecated [v0.0.25 改版] maxTokensOverlay 已删除——maxTokens 降级因子现由 recentErrors 派生（见 §2.4）。保留字段位仅为兼容旧 reader，buildRequest 不再读它。 */
  maxTokensOverlay?: number;
}
```

### 2.2 读写规则

| 字段 | 写时机 | 读时机 | 清时机 |
|---|---|---|---|
| recentErrors | 每次 catch（attemptLoop error）append | retry 升级 / fallback / buildRequest（派生 maxTokens）/ langfuse / SSE llm_attempt | **recordSuccess → clearRecentErrors() 清空整个数组**（连续错误真相源） |
| precompress | decide CONTEXT_LENGTH（连续达阈值，count = recentErrors.filter(CONTEXT_LENGTH).length） | buildRequest（每 attempt / iteration） | 不主动清（粘性，靠 compact 后自然不再触发）；run 结束自然销毁 |
| prefillPartial | decide MAX_TOKENS_PREFILL | buildRequest（下轮） | 应用后清（续写流并入原 message） |
| consecutiveContextLength | 由 recentErrors 派生（filter CONTEXT_LENGTH.length） | decide（判达阈值） | recordSuccess（同 recentErrors 清） |
| partialResult | abort 用户时 | agent loop（决定 emit 半截回复） | 下次 invoke 成功时 |

**关键读写不变式**：`recentErrors` 是「连续错误」的**唯一真相源**。`consecutiveContextLength` 不再独立累加——改为 `recentErrors.filter(e => e.category === CONTEXT_LENGTH_EXCEEDED).length` 派生。`precompress` 仍独立存储（粘性标记，达阈值后即使 recentErrors 清空仍持续生效到 run 结束）。

### 2.3 跨 iteration 继承（P9 关键）

agent loop 每 iteration 调 `callLLM` → `llmCaller.invoke`：

```
iteration N:
  invoke → MAX_TOKENS_TOO_HIGH (provider 400 max_tokens) → append recentErrors
  → buildRequest 派生 maxTokens = base × 0.7^1 = base × 0.7
  → attempt 2 with 降级 maxTokens → 成功 → recordSuccess → clearRecentErrors()

iteration N+1（同一 run 内）:
  invoke → recentErrors=[] → buildRequest 派生 maxTokens = base（无降级）
  → 若又 MAX_TOKENS_TOO_HIGH → recentErrors 重新累积
```

**关键决定（v0.0.25 改版）**：
- `recentErrors` 在 **recordSuccess 时立即清空**（clearRecentErrors）—— 连续错误一旦被成功打断，降级因子立即归零。这取代旧设计「maxTokensOverlay 保留到 run 结束」。
- **理由**：连续错误历史是真相源，成功 = 连续被打断 = 降级假设可能不再成立（用户场景可能已变化），保留 stale 历史会让后续 iteration 无谓降级 maxTokens。旧 maxTokensOverlay 的「保留到 run 结束」假设已被推翻（实际是 MAX_TOKENS_EXCEEDED 的 bump 才需要保留到 run 结束，而 MAX_TOKENS_TOO_HIGH 的降级应在成功后归零）。
- `precompress`：run 结束自然销毁（不主动清）。
- `prefillPartial`：应用后立即清（一次性）。
- `partialResult`：下次 invoke 成功清。

> 注：RunState 本身是 per-run 的（agent loop run 结束即销毁），所以「run 结束清」= 自然销毁，无需显式清。**跨 iteration 继承 = 同一 run 内多 iteration 共享 RunState**；`recentErrors` 在 run 内多 iteration 间累积连续错误。

### 2.4 [v0.0.25 新增] maxTokens 派生（不存储）

**核心变化**：旧设计存储 `maxTokensOverlay`（bump 或降级值），buildRequest 读它；新设计**派生**——`buildRequest` 时根据 `recentErrors` 中 `MAX_TOKENS_TOO_HIGH` 出现的次数，按指数衰减算 `maxTokens`：

```typescript
function deriveMaxTokens(baseReq: CanonicalRequest, errorState: LlmErrorState): number {
  const base = baseReq.params.maxTokens;   // caller 传入的输出预算（如 20000）
  const downHits = errorState.recentErrors
    .filter(e => e.category === LlmErrorCategory.MAX_TOKENS_TOO_HIGH).length;
  // 每次 MAX_TOKENS_TOO_HIGH 降一档：× 0.7^downHits（指数衰减防病态循环）
  // downHits=0 → base；downHits=1 → base×0.7；downHits=2 → base×0.49
  return Math.max(MIN_MAX_TOKENS, Math.floor(base * Math.pow(0.7, downHits)));
}
const MIN_MAX_TOKENS = 1024;   // 下限保护（防止指数衰减到 0）
```

**注意区分（与 `[P0]length_handling.md` 协同）**：
- **`MAX_TOKENS_TOO_HIGH`**（provider 400 / validate 越界）→ **降** `maxTokens`（× 0.7，本派生函数 `deriveMaxTokens` 处理；**只数 TOO_HIGH**，不数 EXCEEDED）。
- **`MAX_TOKENS_EXCEEDED`**（流正常 finish + stop_reason=length）→ **升** —— **不走本派生函数**，归 `[P0]length_handling.md §2.2` one-shot ceiling bump（max_tokens = `model.capabilities.maxOutputTokens`，不 append recentErrors / 不复合 / 不 ×0.7）；prefill 路径 v0.0.25 defer。

**为什么不存储 overlay**：
1. 派生天然与 `recentErrors` 一致（不会出现 recentErrors 清了但 overlay 还在的 stale 状态）。
2. 成功清空 recentErrors → 派生自动归零，无需独立清逻辑。
3. 减少 RunState 可变字段（一个 recentErrors 数组服务多个派生用途）。

**`MAX_TOKENS_EXCEEDED` 的 bump 怎么办（不存 overlay 后）**：bump 决策仍由 `[P0]length_handling.md` 处理，但不再写 `errorState.maxTokensOverlay`，**也不 append `recentErrors`**（EXCEEDED 与连续错误历史无关，见 `[P0]length_handling.md §2.2` rev2 纠正）。v0.0.25 = **one-shot ceiling bump**：buildRequest 时若当前 attempt 是 EXCEEDED bump 重试 → `max_tokens = model.capabilities.maxOutputTokens`（直接到上限，非渐进 ×1.5）；`strategy=none` → 保留 base 即 throw；prefill 路径仍写 `prefillPartial`（**v0.0.25 defer**，见 `[P0]length_handling.md §2.1`）。详见 `[P0]length_handling.md`（v0.0.25 rev2 纠正版）。

---

## 3. credentials 多 key（引用，详见 `[P0]llm_provider_interface §3.3`）

credentials 多 key schema（`CredentialConfig = {key} | {keys[]}` union，向后兼容单 key）+ `CredentialKey`（keyRef / keyValue / quotaScope / weight）+ keyRef 选择器（`resolveKey`）+ `buildAuthHeaders(config, keyRef?)` 改造 —— 完整定义在 `../providers_and_models/[P0]llm_provider_interface.md §3.3`。

**fallback_chain 引用 keyRef**：`FallbackChainItem.keyRef`（§1.2）对应 `CredentialKey.keyRef`。同 provider 不同 key 轮换：`[{providerId:P1, keyRef:"default", ...}, {providerId:P1, keyRef:"backup", ...}]`。

## 4. account-wide quota 例外（引用，详见 `[P0]provider_health_registry §4`）

`CredentialKey.quotaScope: "per_key" | "account_wide"`：account-wide 的 provider 不轮换 key，RATE_LIMITED 直接 FALLBACK 换 provider（hermes 教训）。

**decide 逻辑**：`err.hints.shouldRotateKey && ctx.providerHasPerKeyQuota` 才进 ROTATE_KEY；否则 FALLBACK。decide 完整逻辑在 `[P0]llm_caller.md §3`。

---

## 5. 设计决策（Why）

### 5.1 llm_request 独立 group（非塞 providers）

**结论**：llm_request 是独立 app_config group，不塞进 providers。
**理由**：llm_request 是全局调优参数（与具体 provider 无关），塞进 providers 会让每个 provider 实例都带一份冗余配置。独立 group 单实例（key="default"）。
**反例**：若塞 providers，改 timeout 要改 N 个 provider 实例。

### 5.2 llm_request 缺省回退默认（app_config 不回退）

**结论**：LlmRequestConfigService 缺省回退 DEFAULT；AppConfigService 不回退。
**理由**：llm_request 是调优参数（不配应能用），providers 是权威值（不配 = 没配）。语义不同决定回退策略不同。

### 5.3 fallback_chain 为空时向后兼容

**结论**：fallback_chain=[] 时用调用方传入的单一 provider/model，仍有 retry 能力但无 fallback。
**理由**：向后兼容未配 fallback_chain 的部署。用户配了 fallback_chain 才有跨 provider 能力。

### 5.4 [v0.0.25 改版] maxTokens 派生不存储（取代 maxTokensOverlay 保留）

**结论**：`maxTokens` 降级因子**派生不存储**——buildRequest 按 `recentErrors` 中 `MAX_TOKENS_TOO_HIGH` 次数算 `base × 0.7^downHits`；成功清空 recentErrors → 派生归零。
**理由**：连续错误历史（recentErrors）是真相源，派生天然与之同步，避免「recentErrors 清了但 overlay stale」的不一致；成功 = 连续被打断 = 降级假设可能不再成立，立即归零比保留到 run 结束更合理。
**推翻旧设计**：旧 §5.4「maxTokensOverlay 保留到 run 结束」针对的是 `MAX_TOKENS_EXCEEDED`（升）场景的 bump 保留，但被错误地泛化到了 `MAX_TOKENS_TOO_HIGH`（降）场景。v0.0.25 改版分离两类：降级（TOO_HIGH）走派生 + 成功清空；升级（EXCEEDED）走 length_handling 的 **one-shot ceiling bump**（不 append recentErrors / 不复用本派生函数；prefill v0.0.25 defer），bump 不再存 overlay。
**反例（旧设计的问题）**：若降级 overlay 保留到 run 结束，成功一次后续 iteration 仍用降级 maxTokens，模型实际已恢复大输出能力却被人为限制 → 用户体验下降。

---

## 6. 边界

| 零件 | 归属 |
|------|------|
| llm_request group 定义 + schema + 默认值 | 本文件 §1 ✅ |
| resolveTarget 遍历 + dedup | 本文件 §1.4（编排逻辑在 `[P0]llm_caller.md §3`） |
| LlmErrorState schema + 读写规则 | 本文件 §2 ✅ |
| credentials 多 key schema + keyRef 选择器 | 本文件 §3 ✅（同步更新 `[P0]llm_provider_interface §3.3`） |
| account-wide quota 例外 | 本文件 §4（状态机在 `[P0]provider_health_registry §4`） |
| ProviderHealthRegistry 状态机 | `[P0]provider_health_registry.md` |
| app_config KV 机制 | `../../config/[P0]app_config.md`（补 llm_request group） |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
