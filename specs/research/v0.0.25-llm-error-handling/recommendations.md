# 竞品对比 + 对 v0.0.25 LlmCaller 的建议

> 本文件是 v0.0.25 llm-opt 调研报告的建议部分。完整报告见 `specs/research/v0.0.25-llm-error-handling/`。
> 概述见 `overview.md`,实现细节见 `implementation.md`。

## 1. 竞品横向对比

### 1.1 retry + 退避 + jitter

| 维度 | claude-code | hermes | openclaw |
|------|-------------|--------|----------|
| 自实现循环 | 强(822 行 `withRetry`)| 分布式多处 | 无(透传 SDK) |
| jitter 策略 | 半 jitter(`random*0.25*base`)| full jitter + counter seed | SDK 内部 |
| retry-after 尊重 | 强(秒级 header 优先,有 cap 防病态)| 读 header | SDK 内部 |
| persistent 模式 | 有(无限重试+心跳 chunked sleep)| 无 | 无 |
| 默认 max_retries | 10 | 配置 | SDK 默认(2) |
| 默认 base / cap | 500ms / 32s | 5s / 120s | SDK 默认 |
| **共同点** | 指数退避 + jitter + 尊重 retry-after |||
| **差异本质** | claude-code 是「单 provider 深度优化」,次数多(10)+ 短间隔;hermes 是「多 provider 编排」,次数少 + 长间隔(配合 fallback 切换) |||

### 1.2 circuit breaker / 健康降级

| 维度 | claude-code | hermes | openclaw |
|------|-------------|--------|----------|
| 冷却机制 | fast mode cooldown(短期切速度)| `_rate_limited_until`(session 级时间戳)| 无 |
| 状态升级 | 无(只 healthy/cooldown 两态)| 无显式状态机 | 无 |
| half-open 探测 | 无 | 无 | 无 |
| 进程级共享 | 否(每调用自己 retry)| 否(session 级)| N/A |
| **关键缺口** | **三个都没有「全局共享 + 状态升级 + half-open 探测」完整 circuit breaker** |||

### 1.3 fallback chain / provider 路由 / key 池

| 维度 | claude-code | hermes | openclaw |
|------|-------------|--------|----------|
| fallback 模式 | 单 model(throw `FallbackTriggeredError`)| 有序链(in-place 切换,不抛异常)| 无 |
| key 池 | 单 key | credential pool(多条目 + has_available)| 单 key(由 plugin 自管) |
| 同 backend dedup | 无 | 强(provider+model+base_url 三元组)| N/A |
| account-wide quota 例外 | N/A | 有(Google CloudCode 不轮换)| N/A |
| **优势** | 简单 | 完整、生产级 | 插件化灵活 |
| **劣势** | 只能切一个 model | session 级,非进程共享 | 完全不管 |

### 1.4 错误归一化

| 维度 | claude-code | hermes | openclaw |
|------|-------------|--------|----------|
| 形式 | 字符串 category(20+)| enum + dataclass(20+)| 5 元 StopReason |
| recovery hints | 无(决策分散)| 有(4 bool: retryable/compress/rotate/fallback)| 无 |
| 流式终态归一化 | 部分(stop_reason)| 部分(finish_reason)| 强(error/aborted 入流协议) |
| **推荐** | **hermes 模式最佳**: enum + recovery hints,分类与决策分离 |||

### 1.5 分阶段超时

| 维度 | claude-code | hermes | openclaw |
|------|-------------|--------|----------|
| TTFB 超时 | 无显式(靠 idle watchdog 兜底)| SDK 内部 | SDK timeout |
| chunk 间 stall | idle watchdog(90s,主动 abort)+ stall log(30s)| 无 | 无 |
| wall-clock 兜底 | 600s(`API_TIMEOUT_MS`)| 无显式 | SDK 默认 10min |
| 阶段感知(think/answer/tool)| **无** | **无** | **无** |
| 工具执行期不误判 | 工具在 stream 循环外执行,天然不进 stall 计时 | 同 | 同 |
| **关键缺口** | **三个都没实现「think/answer/tool 分别阈值」** |||

### 1.6 SSE 流式错误 / 不完整流

| 维度 | claude-code | hermes | openclaw |
|------|-------------|--------|----------|
| watchdog abort → fallback | 强(非流式 fallback)| 无 | 无 |
| 空流/partial 流检测 | 强(两种 case + 例外)| 强(partial tool args 区分)| 通过流协议 error 事件 |
| abort 来源区分 | `APIUserAbortError + signal.aborted` 双条件 | 无 | `reason: "aborted"\|"error"` |
| partial 保留 vs 丢弃 | 丢弃(watchdog 重试)/ 保留(用户 abort)| 区分 length/stream drop | 入流协议 |
| **推荐** | **claude-code 最完整**;**hermes 的 partial tool args 区分必学** |||

## 2. v0.0.25 LlmCaller 设计建议

### 2.1 可直接抄(高置信度借鉴)

| 模块 | 抄哪个 ref | 关键文件:行 | 怎么抄 |
|------|-----------|------------|--------|
| **错误归一化架构** | hermes | `refs/error_classifier.py:24-90` | `LlmErrorCategory` 用 enum;`ClassifiedLlmError` dataclass 携带 `retryable/shouldRotateKey/shouldFallbackProvider/shouldCompressContext/shouldBumpMaxTokens` 5 个 action hint。**Anthropic adapter 先实现 HTTP status + error.type + 消息正则的映射列**;OpenAI/GLM 后续各填一列,主逻辑不动 |
| **退避算法** | claude-code 半 jitter + hermes counter seed | `refs/withRetry.ts:530-548` + `refs/retry_utils.py:41-57` | `getRetryDelay(attempt, retryAfter)` = retry-after 优先(秒*1000,cap 在 `backoff_cap_s`)否则 `min(base*2^(n-1), cap) + random*0.25*base`;并发场景加进程级 counter seed |
| **fallback chain 遍历 + dedup** | hermes | `refs/chat_completion_helpers.py:1045-1145` | 链 `[({providerId, keyRef, modelId}), ...]` + index;dedup 用 `(provider, model, base_url)` 三元组避免切回死路;resolveTarget 遍历跳过 cooled_down/dead |
| **流式 idle watchdog** | claude-code | `refs/claude.ts:1868-1928` | `setTimeout(STREAM_IDLE_TIMEOUT_MS)` 每个 chunk reset;超时 abort + 走重试。env 可覆盖 |
| **partial tool args 区分(避坑)** | hermes | `refs/chat_completion_helpers.py:2054-2108` | `STREAM_INCOMPLETE`(无 stop_reason + tool args 未完成)≠ `MAX_TOKENS_EXCEEDED`(有 length stop_reason);前者不 bump max_tokens |
| **context_length vs max_tokens 错误区分** | hermes | `refs/model_metadata.py:1010-1110` | 解析「input length and max_tokens exceed context limit」正则;`CONTEXT_LENGTH_EXCEEDED`(输入超)走压缩,`MAX_TOKENS_EXCEEDED`(输出触顶)走 bump/续写 |
| **错误事件化入流** | openclaw | `refs/types.ts:369-390` | LlmCaller.invoke 返回的流,失败用 `{type:"error", reason:"aborted"|"error", ...}` 而非 throw(让流消费者无 try/catch 包裹) |
| **错误状态分层** | claude-code RetryContext(瞬时)+ hermes _rate_limited_until(粘性)| `refs/withRetry.ts:120-142` + `refs/chat_completion_helpers.py:1057-1065` | 瞬时:`attempt/consecutive529/lastError` 局部;粘性:`SessionStore.llmErrorState`(对话级)+ `ProviderHealthRegistry`(进程级单例)|

### 2.2 要改(有参考但不能照搬)

| 模块 | 参考来源 | 为何要改 | 改造方向 |
|------|---------|---------|---------|
| **健康注册表作用域** | hermes `_rate_limited_until` 是 session 级 | reqs.md §3 要求**进程级跨 session 共享**(否则每个 session 各自重试各自踩坑) | 抽 `ProviderHealthRegistry` 进程级单例(`Map<(providerId, keyRef), {status, cooldownUntil, consecutive}>`);`healthy→cooled_down→degraded→dead` 状态机(reqs.md §3);session 级只放对话相关(连续 CONTEXT_LENGTH、最近错误原因) |
| **状态升级 + half-open** | refs 三个都没完整实现 | reqs.md §3 要求状态升级 + 到期恢复 | 自己写:`consecutive{overload,rate_limit} >= consecutive_to_degrade` 升级;`cooldownUntil` 到期 → `healthy`(简单)或 `degraded→half-open→探测一次成功才 healthy`(完整,可选) |
| **退避默认值** | claude-code(500/32/10)vs hermes(5/120/?) | v0.0.25 多 provider,claude-code 的 10 次太激进(单 provider 场景);hermes 的间隔太长(无 fast mode 配合) | 折中:reqs.md 锁定 `max_attempts=3, backoff_base_s=2, backoff_cap_s=30`(短而少,靠 fallback chain 兜底而非单 provider 死磕) |
| **abort 来源区分** | claude-code 事后推断(APIUserAbortError + signal.aborted) | v0.0.25 自己管 AbortController,可以事前记录 | `AbortController` 包装一层,记录 `abortReason: "user" \| "watchdog_ttfb" \| "watchdog_stall" \| "wall_max"`;abort 时分类写入,LlmCaller 据此决定 `ABORTED_BY_USER`(不重试,保留 partial)vs `TIMEOUT_*`(重试,丢 partial) |
| **partial 保留策略** | claude-code「watchdog 丢,用户保留」 | 一致,但要把「哪种 partial 可保留」说清 | partial 保留仅当:(1)用户 abort;(2)partial 无未完成 tool_use(否则 tool_use 部分无法续)。watchdog/wall_max 触发 → 全丢重试 |

### 2.3 refs 没有,必须自己写

| 模块 | 为何 refs 没有 | v0.0.25 设计方向 |
|------|--------------|-----------------|
| **prefill 续写(MAX_TOKENS_EXCEEDED → 续接 partial)** | claude-code 用 SDK 不便控制续写;hermes/openclaw 多 provider 抽象不好统一 | 这是 v0.0.25 核心创新。Anthropic Messages API 支持:把 partial assistant turn(text + 完成的 tool_use)作为 messages 数组最后一条,模型续写。决策树(reqs.md §5):partial salvageable(无未完成 tool_use) && `model.supportsPrefill` → prefill 续写;elif `max_tokens < model.maxOutputTokens` → 加 max_tokens 重跑;else 上抛用户。**modelConfig 必须带 `supportsPrefill` 能力位** |
| **分阶段 stall 阈值** | refs 都没实现(think/answer/tool 分别) | reqs.md §4 锁定:answer 30s / think 30s / tool 120s。**关键**:tool 阶段又分「tool 实参流式」(LLM 仍在 stream,适用 stall)vs「工具执行期」(LLM 不流式,**不进 stall 计时**)。LlmCaller 在退出 stream 循环(进入工具执行)时**停 stall timer**,下次 invoke 重启 |
| **TTFB 单独超时(45s)** | claude-code 没显式 TTFB(靠 idle watchdog 兜底 90s) | v0.0.25 要求 TTFB 45s。在 stream 启动后等首个 chunk,若超时 abort(分类 `TIMEOUT_FIRST_CHUNK`);首个 chunk 后切到 chunk-间 stall timer(分类 `TIMEOUT_INTER_CHUNK`) |
| **half-open 探测恢复** | refs 都没(靠冷却到期自然恢复) | 可选:cooldown 到期后状态从 `cooled_down` → `half_open`,下一次该 provider 被选中时**只发一个探测请求**,成功 → `healthy`,失败 → 回 `cooled_down` 重置 cooldownUntil。MVP 可省(直接到期回 healthy),v0.0.25 范围内可不做 |
| **`max_tokens_bump_strategy = continue` 完整决策树** | refs 只做 increase(claude-code)或降 max_tokens(hermes 区分 input/output)| reqs.md §5 决策树:partial salvageable + supportsPrefill → prefill;elif `max_tokens < maxOutputTokens` → increase;else 上抛。**绝不降低**(降是给 CONTEXT_LENGTH_EXCEEDED 用的) |
| **langfuse error 路径补全** | refs 不涉及(langfuse 是 rocky 自有)| LlmCaller.invoke catch 块里,所有 throw 前调 `endGeneration({status:"error", errorCategory})`;category 记进 generation metadata |

### 2.4 整体架构建议(LlmCaller 模块边界)

基于调研,推荐 LlmCaller 内部分层(供 architect 参考,非最终设计):

```
LlmCaller.invoke(req, sessionErrorState, signal)
  ├── resolveTarget(fallbackChain, ProviderHealthRegistry)
  │     └── 遍历 chain,跳过 cooled_down/dead,返回首个 healthy (provider,key,model)
  ├── buildRequest(req, sessionErrorState, modelCapability, config)
  │     ├── MAX_TOKENS + increase → max_tokens bump(封顶 model.maxOutputTokens)
  │     ├── 连续 CONTEXT_LENGTH → 设预压缩标记
  │     └── MAX_TOKENS + continue + supportsPrefill → partial 当 assistant turn 续写
  ├── attemptLoop(1..max_attempts)
  │     ├── 调 LlmClient.stream(原 client.ts 不动)
  │     ├── 看门狗(TTFB / 阶段 stall / wall_max)组合 abort
  │     │     └── abort 时按 abortReason 分类 TIMEOUT_*
  │     ├── 流消费 → 正常 done 返回
  │     └── catch → classify(adapter 归一化为 LlmErrorCategory)
  │           └── decide(category + action hints)
  │                 ├── NO_RETRY(AUTH_INVALID/CONTENT_FILTERED/MODEL_NOT_FOUND)→ throw
  │                 ├── RETRY_BACKOFF(RATE_LIMITED/SERVER_ERROR/NETWORK)→ sleep+jitter→下一轮
  │                 ├── ROTATE_KEY(AUTH 连续)→ 标 key dead → resolveTarget 换 key
  │                 ├── FIX_AND_RETRY(CONTEXT_LENGTH→压缩 / MAX_TOKENS→bump or prefill)→ buildRequest 改参 → 下一轮
  │                 └── FALLBACK(provider 连续 overloaded)→ ProviderHealthRegistry 升级 → resolveTarget 换 provider
  └── 写状态:SessionStore.llmErrorState + ProviderHealthRegistry(进程级单例)
```

**关键设计原则**(从 refs 提炼):
1. **分类与决策分离**(hermes):classify 只产 `ClassifiedLlmError`,decide 读 action hints —— Anthropic adapter 改 category 映射列时,主逻辑不动
2. **错误事件化入流**(openclaw):LlmCaller.invoke 返回流失败用 error 事件,不 throw 打断消费者;但 retry 在内部重建流续上
3. **状态分层**(claude-code + hermes):瞬时(attempt/consecutiveXXX)局部;对话级(SessionStore);进程级(ProviderHealthRegistry 单例)
4. **同 backend dedup**(hermes):fallback chain 切换时按 `(provider, model, base_url)` 三元组避免切回死路
5. **partial tool args 区分**(hermes):`STREAM_INCOMPLETE`(无 stop_reason)≠ `MAX_TOKENS_EXCEEDED`(有 length stop_reason)—— 前者不 bump max_tokens
6. **abort 来源事前记录**(改进 claude-code):包装 AbortController 记 abortReason,不靠事后推断

### 2.5 风险与避坑清单

| 风险 | 来源 ref 教训 | v0.0.25 应对 |
|------|--------------|-------------|
| **3 次无效 max_tokens bump** | hermes `refs/chat_completion_helpers.py:2054-2108` 教训:partial tool args + 无 finish_reason 时若误标 length 会 3 次无效重试 | 严格区分 `STREAM_INCOMPLETE`(无 stop_reason)vs `MAX_TOKENS_EXCEEDED`(有 length);前者不进 max_tokens-boost 路径 |
| **病态 retry-after header** | claude-code `refs/withRetry.ts:96-97` `PERSISTENT_RESET_CAP_MS=6h` 防病态 header | retry-after 解析后必须 cap(`backoff_cap_s` × N 或绝对上限如 10min);否则一个恶意/病态 header 卡死 |
| **account-wide quota 轮换无效** | hermes `run_agent.py:244-260` 教训:Google CloudCode quota 是 account 级,pool 轮换不解决 | 多 key credential 设计要标注「quota 作用域」(per-key vs account-wide);account-wide 的 provider 不轮换 key,直接 fallback |
| **冷却延 long-chain-switch** | hermes `refs/chat_completion_helpers.py:1057-1065` 教训:chain-switch 时不应重置 primary 冷却 | ProviderHealthRegistry 升级状态时,只在「离开 primary」或「该 provider 本次确实失败」时设 cooldownUntil,不因 chain 切换累加 |
| **瞎猜 context_length** | hermes `refs/model_metadata.py:1014-1027` 明确约束 | CONTEXT_LENGTH_EXCEEDED 后**不**永久调小 context 窗口;只在 provider 明确报告时本次调用降 max_tokens,粘性状态只设「预压缩标记」不缩窗口 |
| **SDK 内部 timeout 误判为用户 abort** | claude-code `refs/claude.ts:2434-2459` 教训 | v0.0.25 自管 AbortController 事前记 abortReason,避免事后推断(比 claude-code 干净) |
| **overload 雪崩** | claude-code `refs/withRetry.ts:57-89` `FOREGROUND_529_RETRY_SOURCES` 教训:后台任务(summary/title)在 capacity cascade 时不重试,避免 3-10× gateway 放大 | 区分「用户阻塞路径」vs「后台路径」;后台路径 overload 直接 fail 不重试(v0.0.25 若有后台 LLM 调用如 compact,需标注) |
| **状态机不可表示**(impossible states) | openclaw AGENTS.md「make impossible states unrepresentable」原则 | ProviderHealthRegistry 用 discriminated union(`status: "healthy" | {type:"cooled_down", until:number} | ...`),不用并行 bool |

## 3. 调研覆盖度自检

| reqs.md § 调研项 | 覆盖 | 备注 |
|------------------|------|------|
| §1 归一化错误分类 | ✅ | hermes FailoverReason + claude-code classifyAPIError 提供完整 category 列表参考 |
| §2 adaptive retry 双层 | ✅ | claude-code withRetry 单循环 + RetryContext(瞬时);hermes _rate_limited_until(粘性) |
| §3 provider 降级(全局健康 + 兜底链) | ⚠️ 部分 | fallback chain 参考 hermes;**全局共享健康表 + 状态升级 + half-open refs 没有,自己写** |
| §4 分阶段超时(看门狗) | ⚠️ 部分 | idle watchdog 参考 claude-code;**think/answer/tool 分别阈值 + TTFB 45s refs 没有,自己写** |
| §5 length 处理 | ⚠️ 部分 | context vs max_tokens 区分参考 hermes;**prefill 续写 refs 没有,自己写** |
| §6 config 接线 | N/A | refs 不涉及 rockyp own config |
| §7 LlmCaller 编排层 + 错误状态持久化 | ✅ 架构参考 | claude-code withRetry 是单 provider 范本;分层架构建议见 §2.4 |
| **「tool stall 期间实参流式 vs 工具执行」切分** | ⚠️ | refs 不显式区分。建议:LlmCaller 在 stream 循环内仍是「实参流式」(适用 stall_tool_s);退出 stream 进入工具执行时**停 stall timer**;下次 invoke 重启 |
| **粘性状态 schema** | ✅ 参考 | hermes ClassifiedError fields + claude-code RetryContext 给字段设计参考;具体 schema 留 architect |
| **错误归一化模块边界 + adapter 接口** | ✅ | hermes「classify 产 hint,decide 读 hint」是范本;adapter 接口:`classifyProviderError(rawError, provider) → ClassifiedLlmError` |
| **credentials 多 key 模型 + keyRef 选择器** | ✅ | hermes credential pool(`entries()/has_available()`)+ account-wide quota 例外是范本 |

**未覆盖项说明**: 本调研聚焦「LLM 调用错误处理」,不涉及 UI/UX、langfuse 集成细节、config 加载机制。这些属于 architect/coder 阶段。
