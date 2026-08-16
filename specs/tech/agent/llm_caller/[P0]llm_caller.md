---
type: interface
title: LlmCaller 调用编排层
priority: P0
status: active
updated: 2026-08-15
since: v0.0.25
related: [[P0]error_normalization.md, [P0]provider_health_registry.md, [P0]retry_and_timeout.md, [P0]length_handling.md, [P0]llm_request_config.md, [P0]success_target_registry.md, ../providers_and_models/[P0]llm_client_interface.md, ../observability/[P0]observability_interface.md]
---

# LlmCaller — 调用编排层（策略层）

## 1. 概述

**(a) 管什么**：在 `LlmClient`（4 件套不可变共享）**之上**抽一层，收口「错误归一化 + adaptive retry + provider 降级 + 分阶段超时 + 动态参数构建（length/prefill）」全流程；对外只暴露 `invoke()` 一个入口。

**(b) 不管什么**：4 件套本身（→ `../providers_and_models/[P0]llm_client_interface.md`，**不可变共享契约不动**）；HTTP 调用细节（归 LlmClient）；agent loop 的消息驱动 / 状态机（归各 mode）；config 持久化机制（归 app_config）。子模块：错误归一化（→ `[P0]error_normalization.md`）；provider 健康（→ `[P0]provider_health_registry.md`）；退避/超时（→ `[P0]retry_and_timeout.md`）；length 处理（→ `[P0]length_handling.md`）；config（→ `[P0]llm_request_config.md`）。

**(c) 与外界如何交互**：agent loop 的 `callLLM` 改调 `llmCaller.invoke(req, ctx)`（不再直调 `client.stream`）；ctx 由 agent loop 注入（errorState / controller / observability / providers / clientFactory）；失败 throw `ClassifiedLlmError`（带 category，绝不笼统 LOOP_ERROR），agent loop run 收尾填 `Run.error`。

### 1.1 与 LlmClient 的关系（关键边界）

```
agent_loop.callLLM
     │  client.stream(req, signal)            ← 旧路径（v0.0.25 前）
     │  llmCaller.invoke(req, ctx)            ← 新路径
     ▼
┌─────────────────────────────────────────────────────┐
│ LlmCaller（编排层 / 状态层 / 可变）                │
│  ├ resolveTarget    ← fallback_chain + HealthRegistry│
│  ├ buildRequest     ← errorState overlay 改实参      │
│  ├ attemptLoop      ← retry / classify / decide      │
│  └ watchdog         ← TTFB / stall / wall abort      │
└─────────────────────────────────────────────────────┘
     │  client.stream(req, signal)   ← 不动
     ▼
┌─────────────────────────────────────────────────────┐
│ LlmClient（组合层 / 不可变 / 共享 / 无状态）        │
│  providerConfig + provider + protocol + modelConfig  │
└─────────────────────────────────────────────────────┘
```

**LlmClient 不动**（保持 `../providers_and_models/[P0]llm_client_interface.md §3.6` 不可变共享 + 4 件套绑定契约 + async 并发安全）。LlmCaller 持有 LlmClientFactory（按 `(provider, keyRef, model)` 组合取/建对应 LlmClient，缓存复用），按 resolveTarget 选中的 target 取对应 client。LlmClient 自身**没有** retry / 退避 / 状态机 —— 那些全在 LlmCaller。

LlmCaller 是「策略层」，LlmClient 是「机制层」，agent loop 是「驱动层」—— 三层正交、各自独立演化、各自单测。

## 2. 接口契约

### 2.1 `invoke()`（唯一入口）

```typescript
interface LlmCaller {
  /**
   * 发起一次带状态、自适应的 LLM 调用。
   *
   * @param baseReq  agent loop 组装好的 canonical 请求（messages + params 基线）
   * @param ctx      调用上下文（errorState / controller / observability / callers）
   * @returns        成功 → 流式聚合后的 InvokeResponse（含 message / usage / stopReason）；
   *                 失败 → throw ClassifiedLlmError（带 category + reason，绝不笼统 LOOP_ERROR）。
   *
   * 不变式：
   *  - 整链全 dead（所有 fallback 项都不可用）才 throw；
   *  - 不可恢复错误（CONTENT_FILTERED / AUTH_INVALID / MODEL_NOT_FOUND）首次即 throw，不重试；
   *  - 用户 abort → throw {category:"ABORTED_BY_USER"}，保留 partial 于 ctx.errorState.partialResult；
   *  - 所有 throw 前调 ctx.observability.endGenerationError（langfuse 闭环）。
   */
  invoke(baseReq: CanonicalRequest, ctx: InvokeContext): Promise<InvokeResponse>;
}

interface InvokeContext {
  errorState: LlmErrorState;            // agent loop 的 RunState.llmErrorState（跨 iteration 继承 overlay）
  sessionId?: string;                   // health registry 按 (sessionId,provider,key,model) 四元组存储
  controller: AgentLoopAbortController; // agent loop 的 AbortController（用户中断信号源）
  observability?: ObservabilityPort;    // observability 端口（recordWireBody / recordAttemptTarget / recordSkippedCandidate / endGenerationOk / endGenerationError）
  backgroundPath?: boolean;             // 标记后台路径（summary/title）—— true 时 overload 直 fail 不重试（防雪崩）
  onEvent?: (evt: StreamEvent) => void; // chunk 转发回调（agent loop emit 责任保留）
  providers: Map<string, LlmProviderConfig>;  // provider 查找表
  clientFactory: LlmClientFactory;      // LlmClient 工厂（按 (provider,key,model) 取/建 client）
  compressor?: ContextCompressor;       // ContextEngine 实现（precompress overlay 用）
  config?: LlmRequestConfig;            // 不传用 DEFAULT_LLM_REQUEST_CONFIG
  health?: ProviderHealthRegistry;      // 不传用 globalThis 单例
  fallback?: { provider; keyRef; model; client };  // 空 chain 时的单一 target 兜底
  logWriter?: LogWriter;                // dev 调试日志（invoke 末尾/失败写一条）
}

interface InvokeResponse {
  message: Message;
  usage: Usage | null;
  stopReason: 'stop' | 'tool_use' | 'max_tokens';
}
```

> `CanonicalRequest` / `StreamEvent` 见 `../providers_and_models/[P0]llm_protocol_interface.md §2`；`LlmErrorState` 见 `[P0]llm_request_config.md §2`；`AgentLoopAbortController` 见 `../agent_interface_and_loop/[P0]agent_loop_base.md §5`；`LlmClientFactory` 见 §6.4。

### 2.2 内部子模块（各自一文件，本文件只列签名）

```typescript
/**
 * 按 fallback_chain + 健康表选 target，**两遍扫描**：
 *   第 1 遍：扫 chain（顺序：正式项 > backup 项），选首个 health.isPreferred (healthy) 项；
 *   第 2 遍：扫 chain（同顺序），选首个 health.isAvailable (healthy 或 degraded) 项兜底；
 *   cooled_down（未到期）跳过（尊重 until）；dead 排除；全 dead → all_dead fail。
 * 同 session 内共享健康表（per-session × per-model 四元组 key，见 [P0]provider_health_registry §2）。
 *
 * 实现：llm/caller/resolve_target.ts:resolveTarget()
 */
resolveTarget(args: {
  config: LlmRequestConfig;
  providers: Map<string, LlmProviderConfig>;
  health: ProviderHealthRegistry;
  sessionId: string;
  clientFactory: LlmClientFactory;
  onWire?: (req, body, url) => void;
  now: number;
  fallback?: { provider; keyRef; model; client };
}):
  | { kind: 'target'; target: ResolvedTarget }   // ResolvedTarget = { providerId, provider, keyRef, keyValue, model, client }
  | { kind: 'all_dead'; reason: string };

/** 按 errorState 的 recentErrors 派生 maxTokens + precompress/prefill 构建实参（见 [P0]llm_request_config §2.4） */
buildRequest(baseReq, errorState, model, config): CanonicalRequest;

/** attempt 1..max_attempts 循环 + 看门狗 abort；每次 catch append recentErrors + emit llm_attempt SSE；成功 clearRecentErrors */
attemptLoop(client, req, ctx, watchdog): Promise<{ kind:"ok"|"user_abort"|"max_tokens_finish"|"error"; ... }>;
```

**resolveTarget 两遍扫描**（简化伪代码；完整伪代码 + dedup 规则见 `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §2`）：

```typescript
function resolveTarget(sessionId, chain, health, errorState) {
  // 第 1 遍：优先选 healthy（isPreferred=true 仅当 healthy）
  for (const item of chain) {
    if (health.isPreferred(sessionId, item.providerId, item.keyRef, item.modelId).ok) return buildTarget(item);
  }
  // 第 2 遍：兜底选 healthy 或 degraded（isAvailable=true）
  for (const item of chain) {
    if (health.isAvailable(sessionId, item.providerId, item.keyRef, item.modelId).ok) return buildTarget(item);
  }
  return { kind: "all_dead", reason: "all fallback chain items dead or cooled_down" };
}
```

**fallback_chain（全局 provider 池 config）不动**——结构仍按 `[P0]llm_request_config §1.2`；resolveTarget 只改扫描策略（两遍 + 四元组 key 查询）。

### 2.3 per-attempt 动态 SSE event `llm_attempt`

retry / fallback 过程实时外显给 caller（UI 显示「重试中…」「切换备用模型…」），通过 `ctx.onEvent` 转发：

```typescript
type LlmAttemptEvent = {
  type: "llm_attempt";
  category: LlmErrorCategory;     // 本次 attempt 失败的错误分类（首次成功不发本事件）
  providerId: string;
  modelId: string;
  keyRef?: string;                // 失败目标 key 引用（health 四元组之一；all_dead 终结时可缺）
  attempt: number;                // 第几次 attempt（1-based；all_dead 终结 FAIL 时为 0）
  maxAttempts: number;            // 本次 invoke 最大 attempt 次数（= config.retry.max_attempts）；前端「重试中 x/x」分母
  action: "RETRY" | "ROTATE_KEY" | "FALLBACK" | "FAIL";   // decide 产的动作
  message: string;                // category 对应的用户可读文案（deriveDisplayReason 派生）；前端 hover 展示
};
```

**emit 时机**：每次 attemptLoop catch 到 error 后、decide 产 action 时发一次。attempt 1 首次成功不发。整链 all_dead 发 `action:FAIL`。用户 abort 不发（走原 abort 路径）。

> **[v0.0.144] `maxAttempts` + `message` 字段**：前端气泡「重试中 {attempt}/{maxAttempts}」外显所需——`maxAttempts = config.retry.max_attempts`（8 处 `emitLlmAttempt` 调用点末尾补传），`message = deriveDisplayReason(category)`（emit 内派生，前端不重复维护映射）。`emitLlmAttempt(ctx, category, target, attempt, action, maxAttempts)`（`llm/caller/llm_attempt_emit.ts`）→ `ctx.onEvent(StreamEvent)` → `agent-loop-call-via-invoker.ts:forwardEvent` 转 `LlmAttemptEvent` 出站（透传两字段）。**`maxAttempts` 真实性依赖 config 装配接线**（见 §3 step1；断链未修前恒为 DEFAULT 的 3）。完整 wire schema + caller 语义见 `specs/api/version_logs/v0.0.25/change_log.md §1.4` + `specs/api/version_logs/v0.0.144/change_log.md`。

### 2.4 Run finish_reason 携带 errorCategory + displayReason

invoke 失败 throw `ClassifiedLlmError` 后，agent loop run 收尾时（`stopReason="error"`）填 Run/RunRecord 的 error 字段：

```typescript
interface RunErrorInfo {
  errorCategory: LlmErrorCategory;   // LlmErrorCategory 枚举值（不再 loose string code 如 "LOOP_ERROR"）
  displayReason: string;             // 用户可读理由（从 category + context 派生）
  errorDetail?: string;              // 完整细节（raw provider message，给 tooltip / log）
}
```

非 error 的 stopReason（no_tool_call / max_iterations / doom_loop / interrupted / no_new_messages / require_approval）保持现有语义，不填 RunErrorInfo。完整收尾伪代码 + RunRecord 持久化 + SSE error 事件形态 + errorCategory→displayReason 映射表见 `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §1 §3`（权威定义；displayReason 是用户可读层，errorCategory 是结构化层）。

## 3. invoke() 内部数据流（端到端）

```
LlmCaller.invoke(baseReq, ctx)
  │
  ├─ 1. 加载 LlmRequestConfig（ctx.config ?? DEFAULT_LLM_REQUEST_CONFIG）
  │       └─ ctx.config 来源 = SessionConfig.llmRequestConfig（生产路径经装配接线注入，见下）
  │
  ├─ 2. resolveTarget(sessionId, fallbackChain, healthRegistry, errorState)
  │     └─ 两遍扫描：第1遍 healthy（isPreferred）→ 第2遍 degraded 兜底（isAvailable）→ cooled_down 跳过 → dead 排除
  │        （account-wide quota 的 provider 不轮换 key —— 见 [P0]provider_health_registry §4）
  │
  ├─ 3. attemptLoop (1..max_attempts):
  │     │
  │     ├─ 3a. req = buildRequest(baseReq, errorState, modelCap, config)
  │     │       └─ maxTokens 派生：deriveMaxTokens(baseReq, errorState.recentErrors) = base × 0.7^(TOO_HIGH 次数)
  │     │       └─ MAX_TOKENS_EXCEEDED → bump（按 length_handling strategy，封顶 model.maxOutputTokens）
  │     │       └─ 预压缩标记（precompress） → req.messages = 截断/压缩后版本
  │     │       └─ prefill overlay（prefillPartial） → req.messages += [partial assistant turn]
  │     │
  │     ├─ 3b. watchdog.start()   ← 启动 TTFB / stall / wall 计时器
  │     │
  │     ├─ 3c. resp = await client.stream(req, compositeSignal)
  │     │       └─ compositeSignal = 用户 controller ⊕ watchdog AbortController（abortReason 事前记录）
  │     │       └─ 首 chunk 到 → 切 TTFB timer 为 stall timer（按 phase 切换 answer/think/tool）
  │     │       └─ chunk 间 stall 超 → watchdog.abort("watchdog_stall")
  │     │       └─ 用户 abort → ctx.controller.aborted=true → composite abort
  │     │
  │     ├─ 3d. 流消费完毕 → watchdog.stop() → return {kind:"ok", resp}
  │     │
  │     └─ 3e. catch / abort →
  │          ├─ abortReason="user" → {kind:"user_abort"}（不重试，保留 partial）
  │          ├─ abortReason="watchdog_*" → {kind:"error", err: classify(TIMEOUT_*)}（重试，丢 partial）
  │          └─ HTTP error → err = classify(rawError, provider)（归一化）
  │
  │     若 {kind:"ok"} →
  │        ├─ errorState.clearRecentErrors()  ← 清空连续错误历史（成功 = 连续被打断）
  │        ├─ healthRegistry.recordSuccess(sessionId, provider, key, model)（清 consecutive，降级恢复）
  │        ├─ recordSuccessTarget(sessionId, {providerId, providerName, modelId})（ctx.sessionId 存在时；写成功 target registry，
  │        │   与 observability 平行的正路线——squad 用量统计归属，见 [P0]success_target_registry）
  │        └─ break attemptLoop, return resp
  │     若 {kind:"user_abort"} → break，throw ABORTED_BY_USER（保留 partial）
  │     若 max_tokens_finish → applyMaxTokensOverlay 决策（bump 重跑 / throw 硬上限）
  │     若 {kind:"error"} →
  │        ├─ errorState.recentErrors.append({category, modelEntry:{providerId,keyRef,modelId}, at:now})（上限 max_attempts−1）
  │        ├─ emit llm_attempt SSE event（§2.3）—— 实时外显 retry/fallback 进度
  │        └─ decide(err) 读 hints + recentErrors → action（每次 action 都 emit llm_attempt{action}）:
  │           ├─ NO_RETRY → throw err（langfuse endGeneration error）
  │           ├─ RETRY_BACKOFF → sleep(getRetryDelay) → 下轮（瞬时错误；下轮 buildRequest 自动降级/不改参）
  │           ├─ ROTATE_KEY → healthRegistry.markDead(...) → resolveTarget 换 key → 下轮
  │           ├─ FIX_AND_RETRY (CONTEXT_LENGTH) → errorState.precompress=true → 下轮 buildRequest 压缩
  │           ├─ FIX_AND_RETRY (MAX_TOKENS_EXCEEDED bump) → 下轮 buildRequest 按 length_handling bump
  │           ├─ FIX_AND_RETRY (MAX_TOKENS_PREFILL) → errorState.prefillPartial = resp.partial → 下轮
  │           └─ FALLBACK → healthRegistry.escalate(...) → 回到 step 2（resolveTarget）
  │        若整链 all_dead → emit llm_attempt{action:FAIL} → throw lastError（带 category）
  │
  ├─ 4. attemptLoop 退出后：
  │     ├─ 成功 → 已在 3.ok 分支 recordSuccess + clearRecentErrors → return resp
  │     └─ 失败 → throw lastError（ClassifiedLlmError，带 category + rawError；langfuse 已记 endGeneration error）
  │
  └─ 5. 跨 attempt 的状态写入：
        ├─ ctx.errorState（RunState 级，跨 iteration 继承）：recentErrors / precompress / prefillPartial
        └─ healthRegistry（session-scoped）：cooldown / consecutive{overload,rate_limit} / dead —— 按 (sessionId, providerId, keyRef, modelId) 四元组
```

**关键不变式**：
- `ctx.errorState.recentErrors` 跨 iteration 持续累积直到 recordSuccess → clearRecentErrors（见 [P0]llm_request_config §2.3）。
- `healthRegistry` 按 session-scoped 四元组 key 存储（同 session 共享；跨 session 隔离；session 结束 cleanupSession）。
- `attempt` 计数 / `lastError` 是 invoke 局部，invoke 返回即清。

## 4. callLLM 接入改造（agent_loop_base §2.1）

`callLLM` 不再直接调 `client.stream`，改调 `llmCaller.invoke`：

```typescript
async function callLLM(input: CallLLMInput): Promise<CallLLMResult> {
  const baseReq: CanonicalRequest = {
    modelId: input.modelId,
    messages: input.messages,
    tools: input.tools,
    params: { maxTokens: input.maxOutputTokens, ... },
  };
  const ctx: InvokeContext = {
    errorState: input.runState.llmErrorState,    // ← RunState 字段（见 §5）
    controller: input.controller,
    observability: input.observability,
    backgroundPath: input.backgroundPath,
    onEvent: input.emit,                         // chunk 转发回调（agent loop emit 责任保留）
    providers: input.providers,
    clientFactory: input.clientFactory,
  };
  try {
    const resp = await llmCaller.invoke(baseReq, ctx);
    return { assistantMessage: resp.message, usage: resp.usage, rawStopReason: resp.stopReason };
  } catch (err) {
    throw err as ClassifiedLlmError;   // 不再塌缩 LOOP_ERROR —— 上抛带 category
  }
}
```

> **流式 emit 责任**：`InvokeContext.onEvent` 接收 chunk → 调 agent loop 的 emit；group 选择仍归 mode，LlmCaller 不感知 group。

`CallLLMInput` 新增字段：`runState: LoopStateBase`（读 `llmErrorState`）、`backgroundPath?: boolean`（标记后台路径，overload 不重试）、`providers` / `clientFactory`（target 解析用）。

### 4.1 config 装配接线（生产路径 config 生效链路 — v0.0.144 修断链）

`invoke` 的 `ctx.config`（`LlmRequestConfig`）来源必须一路接线，否则恒回退 `DEFAULT_LLM_REQUEST_CONFIG`。**装配链路（唯一接线点 = `buildSessionConfigFromDeps`）**：

```
buildSessionConfigFromDeps（handlers/session-config.ts，唯一持 deps.appConfig 句柄）
  ├─ new LlmRequestConfigService(deps.appConfig).get()  → SessionConfig.llmRequestConfig
  └─ listEnabledProviders(deps.appConfig) as LlmProviderConfig[]  → SessionConfig.allProviders
        ▼
两个 stage-llm 透传（都补 baseCallLLM 入参 llmRequestConfig / allProviders）：
  ├─ loop-stage-llm.ts:callLLMForSpec        （生产主路径，run-react-loop 用）
  └─ agent-loop-stage-llm.ts:stageLLMRequest （旧/EOS 路径，与主路径保持一致防漂移）
        ▼
baseCallLLM → CallLLMInput.llmRequestConfig → buildInvokeContext → InvokeContext.config → invoke step1
```

**断链背景（v0.0.25 起潜伏，v0.0.144 修）**：`LlmRequestConfigService.get()` 此前**仅** `router.ts` 的 HTTP GET/PUT handler 调用；生产 agent loop 组 `CallLLMInput` 时从不设 `llmRequestConfig` → `buildInvokeContext` 的 `config` 恒 undefined → invoke step1 命中 `ctx.config ?? DEFAULT` 回退默认。默认 `max_attempts=3` 恰好掩盖问题（config 里配的 retry/timeout/fallback_chain 全部不生效）。v0.0.144 接线后 config 真正生效，`llm_attempt.maxAttempts` 分母才反映用户配置。

- **`SessionConfig.allProviders` 宽转**：`listEnabledProviders` 返 `ProviderInstance[]`，与 `LlmProviderConfig` 字段不完全兼容（缺 pluginId / model 侧 inputModalities 等），用 `as unknown as LlmProviderConfig[]` 宽转。空 `fallback_chain`（默认）时 `allProviders` 不被消费；非空 chain 时 `resolveTarget` 按 id/credentials/models 取运行时真值。
- **health 不接线（架构决策）**：invoke 内 `getProviderHealthRegistry()` 进程单例按 `(sessionId,provider,key,model)` 四元组 key 已保证隔离（`[P0]provider_health_registry.md §6.5`），无需 per-session 注入。
- **auto-naming 路径不接线 config（已知非目标）**：`auto-naming-service.ts:applyAiName` 的 `buildInvokeContext` 不传 config——fire-and-forget 后台起名、`backgroundPath=true`（capacity 错误本就不重试）、单 provider 单 attempt 兜底。config 生效对它收益低、blast radius 无谓扩大，保持现状。

## 5. RunState 扩展（llmErrorState）

`LoopStateBase` 加字段：

```typescript
interface LoopStateBase {
  step: number;
  done: boolean;
  stopReason?: StopReason;
  snapshot: ContextSnapshot | null;
  lastAssistantContent?: ContentBlock[];
  llmErrorState: LlmErrorState;   // ← 新增
}
```

`LlmErrorState` schema 见 `[P0]llm_request_config.md §2`。要点：
- 跨 iteration 继承（每 iteration callLLM 读它 → buildRequest 算实参）
- **不随 session 落盘**（arch 决定，理由见 §6.3）
- agent loop 一次 run 结束清空瞬时部分（attempt 计数），保留粘性 overlay（maxTokensOverlay 跨 iteration 保留，直到 clear）

## 6. 设计决策（Why）

### 6.1 LlmCaller 是独立层，不塞 LlmClient

**结论**：LlmCaller 在 LlmClient 之上，LlmClient 4 件套不动。
**理由**：见 §1.1。LlmClient 的不可变共享契约（`../providers_and_models/[P0]llm_client_interface §3.6`）是它的核心价值（跨 session 并发安全、按组合缓存复用），引入可变状态会破坏。
**反例**：若塞进 agent loop，错误处理逻辑（归一化/退避/健康状态机）与 loop 的消息驱动正交，混入会让 mode spec（eager/lazy/forked）三处各自实现一份。

### 6.2 错误状态记 RunState，不记 LlmCaller 局部

**结论**：跨 iteration 继承的 overlay（maxTokensBump / precompress / prefillPartial）记 `RunState.llmErrorState`；进程级共享（cooldown / dead-key）记 `ProviderHealthRegistry` 单例；瞬时（attempt / lastError）记 invoke 局部。
**理由**：错误状态记 loop RunState，这样每 iteration 调 LLM 时 buildRequest 能跨 retry 修改实参。若记 LlmCaller 局部，LlmCaller 实例生命周期 ≠ loop iteration 生命周期，overlay 会丢或乱。
**反例**：若记 SessionStore 字段，跨 iteration 仍可见但跨 run 不可见，且 SessionStore 已臃肿。

### 6.3 RunState.llmErrorState 不随 session 落盘

**结论**：`llmErrorState` 是内存态，session 重启（进程重启或 session reload）后清空。
**理由**：overlay 本质是「上次失败的临时应对」，重启后场景已变（用户可能换话题、模型可能恢复），保留 stale overlay 风险高于收益；provider 健康是进程级（重启 reset 可接受，refs 都没扛重启，300s TTL）；落盘会增加 SessionStore schema 复杂度。
**例外**：dead-key 是否扛重启 → 见 `[P0]provider_health_registry §6`（MVP 不扛，懒重验：下次该 key 被选中时探测一次）。

### 6.4 LlmCaller 持有多 LlmClient 句柄（按 target）

**结论**：LlmCaller 按 fallback chain 的每个 `(provider, key, model)` 组合持一个 LlmClient 句柄（由 factory 按 `[P0]llm_client_interface §3.6` 缓存复用）；resolveTarget 返回对应句柄。
**理由**：LlmClient 按 4 件套组合缓存复用，不同 (provider, key, model) 是不同组合 → 不同 LlmClient 实例。LlmCaller 持有「组合 → client」的查找表（factory 提供）。
**反例**：若 LlmCaller 只持一个 client，无法支持 fallback chain（切 provider 后没 client 可用）。

### 6.5 backgroundPath 标记（防 overload 雪崩）

**结论**：`InvokeContext.backgroundPath=true` 时，overload / rate_limit **直接 fail 不重试**（借鉴 claude-code `FOREGROUND_529_RETRY_SOURCES` 教训）。
**理由**：summary / title 等后台 LLM 调用在 capacity cascade 时重试会 3-10× 放大 gateway 压力；前台用户阻塞路径才值得重试。
**标注**：forked mode 调 LlmCaller 时 `backgroundPath=true`（compact 是 ContextEngine 调，不走 LlmCaller）。

### 6.6 物理层 generation 埋点（v0.0.50）

**结论**：`invoke` 内在 `protocol.encode(canonicalRequest)` 拿到 wire body 后、进 HTTP 前，若 `obs.hasPhysicalChild()` 为真则触发 physical generation 埋点（紧邻同 iteration 的 logical generation），`try/finally` 收尾 endGeneration（无 usage/output）。

```typescript
// llm_caller.invoke 内（attemptLoop 单次 attempt 的 HTTP 调用前后）
const wireBody = protocol.encode(canonicalRequest);
const physicalGen = obs.hasPhysicalChild()
  ? obs.startPhysicalGeneration(wireBody, new Date())   // LangfuseObservabilityPort 实现
  : null;
try {
  const resp = await httpClient.post(url, wireBody);
  // ... 流式聚合 ...
} finally {
  if (physicalGen) obs.endPhysicalGeneration(physicalGen, new Date());   // 不带 usage（mapUsage({}) → total=0）
}
```

**物理方法归属**（避依赖循环）：`startPhysicalGeneration` / `endPhysicalGeneration` / `hasPhysicalChild` 不在 `LoopObservability`（agent 层），而在 `LangfuseObservabilityPort`（`app/server/src/llm/caller/langfuse_observability_port.ts`）。理由：埋点点位在 llm_caller.invoke 内，若挂 agent 层会形成 `llm/caller→agent` 依赖循环（agent 层已 import llm/caller）。`LoopObservability` 仅暴露 `currentGenIteration(): number` 供 port 拼接 physical name 的 N（同 logical 的 N，成对）。

**埋点细节**：
- **不带 usage**：`endPhysicalGeneration` 内部调 `adapter.endGeneration({ gen, usage: {}, endTime, metadata })`；`langfuse-adapter.mapUsage({})` 结果 `total=0` 且不写 cost。
- **失败路径**：`httpClient throw` → `finally` 里 `endPhysicalGeneration` 照样调（不带 `status='error'`，因为物理层不承载错误语义，错误由 logical 承担）。
- **无重试放大**：invoke 的重试链在 attemptLoop 上层；physical 埋点只包**单次真实 HTTP 请求**；重试触发下一次 encode+startPhysicalGeneration，所以 physical generation 数量 = 真实 wire 尝试数。
- **关闭态零开销**：`hasPhysicalChild()`=false 时 invoke 完全跳过 physical 分支（不调 encode 后的 startPhysicalGeneration），等价 v0.0.49 行为。

**与 logical generation 的关系**（见 `../observability/[P0]observability_interface.md §4.1`）：
- 同 iteration N（logical=`llm-N-logical`，physical=`llm-N-physical`，成对紧邻）。
- 同 step span parent（physical gen 的 parent = logical gen 的 parent = step span handle）。
- physical 不带 usage/output（不污染 token/cost dashboard）；logical 沿用全量字段。
- 两次 startGeneration 互相独立 try/catch（双层容错沿用，physical 失败不影响 logical / loop）。

## 7. 已知问题 / 后续

### 7.1 BUG-005 — client.validate() 裸 Error → NETWORK（已实现，spec 收口）

**现象（旧）**：`validate()` 对参数越界抛裸 `Error(string)`（无 status）→ classifier 落 NETWORK 可重试 → misconfig 请求白重试 3 次（指数 backoff ~7s）+ errorCategory 误标。

**spec 收口方案（已落 spec + 已实现）**：选项 A 改良版——`validate()` 抛 `LlmHttpError` 形态（复用 `llm_client_interface §3.9` type，不新增类型），classifier 不动：
- **maxTokens 越界** → `LlmHttpError{status:400, body:{message:"max_tokens X exceeds model max Y"}}` → classifier 400 max_tokens 行命中 → **`MAX_TOKENS_TOO_HIGH`**（retryable + buildRequest 派生降 ×0.7 重试）。降级重试能让 session 不重启自适应恢复（20000→14000→9800…直到 ≤4096）。
- **temperature/topP/模态越界** → `LlmHttpError{status:400, body:{message:"..."}}` → classifier 400 其他行 → `BAD_REQUEST_OTHER`（NO_RETRY）。

**实现现状**：`app/server/src/llm/client.ts:validate()`（line 225+）已落 LlmHttpError{400}——temperature/topP/maxTokens 越界均抛 LlmHttpError（message 避免 `max_tokens` 字样误命中 MAX_TOKENS_BAD_PARAM_PATTERNS）。spec 落点 `[P0]llm_client_interface §3.9` + `[P0]error_normalization §1 §4.1`（400 max_tokens 行 → MAX_TOKENS_TOO_HIGH）。

## 8. 边界

| 零件 | 归属 |
|------|------|
| invoke / resolveTarget / buildRequest / attemptLoop 编排 | 本文件 ✅ |
| 错误归一化（LlmErrorCategory / ClassifiedLlmError / classify） | `[P0]error_normalization.md` |
| ProviderHealthRegistry（进程级单例 / 状态机） | `[P0]provider_health_registry.md` |
| 退避算法 / 分阶段超时看门狗 | `[P0]retry_and_timeout.md` |
| Length 处理（prefill / bump / 压缩） | `[P0]length_handling.md` |
| `llm_request` config group / LlmErrorState schema / fallback_chain 结构 | `[P0]llm_request_config.md` |
| LlmClient（4 件套组合层） | `../providers_and_models/[P0]llm_client_interface.md`（不动） |
| agent loop 驱动 / RunState 游标 | `../agent_interface_and_loop/[P0]agent_loop_base.md`（§2.1 §4 改造） |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
