# v0.0.25 LLM 调用错误处理 / 自适应重试 调研报告

> 本文件是 v0.0.25 llm-opt 调研报告的概述部分。完整报告见 `specs/research/v0.0.25-llm-error-handling/`。
> 兄弟文件: `implementation.md`(实现细节)、`recommendations.md`(建议)。

- **调研范围**: LLM 调用编排层的错误处理 —— 归一化、adaptive retry、provider 降级、分阶段超时、动态参数构建、SSE 错误处理、length 处理
- **调研对象**: `refs/claude-code/`(TS,Anthropic 官方风格 CLI)、`refs/hermes-agent/`(Python,多 provider agent)、`refs/openclaw/packages/`(TS monorepo,plugin 化 LLM core)
- **调研日期**: 2026-06-26
- **边界**: 只读 refs/,不读 app/ 源码(现状由 reqs.md 给出)

## 1. 整体概况

三个竞品对「LLM 调用错误处理」呈现三种**截然不同的成熟度与架构风格**:

| 项目 | 风格 | 自实现重试 | 错误归一化 | Provider 降级 | 动态参数 | 流式错误 |
|------|------|----------|-----------|-------------|---------|---------|
| **claude-code** | 单 provider(Anthropic SDK)深度优化 | 强(822 行 `withRetry`) | 强(`classifyAPIError`) | 弱(单 fallback model) | 强(max_tokens/context) | 强(watchdog+非流式 fallback) |
| **hermes-agent** | 多 provider 编排 | 中(分布式多处) | 强(`FailoverReason` enum + `ClassifiedError` recovery hints) | 强(fallback chain + credential pool) | 中(context_length/max_tokens 解析) | 中(finish_reason 区分) |
| **openclaw** | Plugin 化、provider 各自管 | 无(透传 SDK `maxRetries`) | 弱(只在 harness 层做 backend-independent code) | 无(无 health registry) | 无 | 中(错误事件化为 stream event) |

**核心结论**:
1. **claude-code `withRetry`** 是 v0.0.25 「LlmCaller 编排层」最直接的范本 —— 单循环内根据 error 动态决定 action(retry/退避/fallback model/调 max_tokens/换 client)。但它**只单 provider**,没有「全局健康注册表 + fallback chain」。
2. **hermes-agent** 提供了 v0.0.25 多 provider 编排的另一半 —— `FailoverReason` enum + `ClassifiedError` recovery hints(归一化→decide 的精确架构)、fallback chain 遍历、credential pool、jittered_backoff 防 thundering-herd、context_length vs max_tokens 错误的精确区分。
3. **openclaw** 整体偏弱(LLM 错误处理委托给底层 SDK),但它的 **「stable error code pattern」**(FileErrorCode/ExecutionErrorCode/SessionErrorCode 全部 backend-independent)是 v0.0.25 「LlmErrorCategory」抽象层级的范本。它的 `StopReason = "stop" | "length" | "toolUse" | "error" | "aborted"` 把流式终态也纳入归一化,值得借鉴。
4. **prefill 续写(MAX_TOKENS_EXCEEDED → 续接 partial)**: 三个 ref **都没有实现**。Claude-Code/Hermes 只做 max_tokens 调整 + provider 降级,不做 Anthropic prefill 续接。这是 v0.0.25 必须**自己设计**的部分。

## 2. 策略枚举(7 类)

下面每类只列「是什么/解决什么」+ 主要 ref 落点;**触发条件、完整流程、代码摘录**见 `implementation.md`。

### 2.1 retry + 指数退避 + jitter
- **是什么**: 失败后按指数间隔重试,jitter 防多客户端同步重试(thundering-herd)。
- **关键 ref**:
  - `claude-code/src/services/api/withRetry.ts:530-548` `getRetryDelay()` —— `min(base*2^(n-1), cap) + random*0.25*base` 半 jitter
  - `hermes-agent/agent/retry_utils.py:19-57` `jittered_backoff()` —— full jitter + 进程级 counter seed 防并发同种子
- **尊重 retry-after 头**: claude-code `withRetry.ts:519-528` 优先用 `retry-after` 头(秒级);hermes 也读 retry-after

### 2.2 circuit breaker / provider 健康降级
- **是什么**: per-(provider,key) 命中 429/overload → 冷却窗口,窗口内跳过;连续失败升级状态(healthy→cooled_down→degraded→dead)。
- **关键 ref**:
  - hermes `_rate_limited_until = time.monotonic() + 60`(session 级时间戳冷却,`chat_completion_helpers.py:1065`)
  - hermes credential pool `has_available()` 剔除冷却中条目(`run_agent.py:4028-4052`)
  - claude-code fast mode cooldown(`withRetry.ts:293-304`) —— 短 retry-after 等待保 cache,长 retry-after 触发冷却切标准速度
- **half-open 探测**: refs 都**没实现**(没有主动探测恢复机制,靠冷却到期自然恢复)

### 2.3 fallback chain / 多 provider 路由 / key 池轮换
- **是什么**: 配置有序 `[(provider, key, model), ...]`,失败时按序切下一个 healthy 的。
- **关键 ref**:
  - hermes `try_activate_fallback`(`chat_completion_helpers.py:1045-1145`) —— 链式遍历 + 同 backend dedup(provider+model+base_url)+ 客户端重建
  - hermes `_pool_may_recover_from_rate_limit`(`run_agent.py:233-260`) —— 单 credential pool 不轮换;account-wide quota(Google CloudCode)不轮换
- **key 池**: hermes credential pool `entries()` 多条目;claude-code 单 key

### 2.4 错误归一化 adapter
- **是什么**: 多 provider 原始错误(HTTP status + error.type + 消息文本)→ 内部统一 category;重试逻辑只认 category。
- **关键 ref**:
  - hermes `FailoverReason` enum(20+ category)+ `ClassifiedError` 携带 recovery hints(`error_classifier.py:24-90`)
  - claude-code `classifyAPIError`(20+ 字符串 category)+ `categorizeRetryableAPIError`(`errors.ts:965-1182`)
  - openclaw `StopReason = "stop"|"length"|"toolUse"|"error"|"aborted"`(把流式终态也归一化,`llm-core/src/types.ts:277`)

### 2.5 分阶段超时看门狗
- **是什么**: TTFB + chunk 间 stall + wall-clock 兜底;阶段感知(think/answer/tool 阈值不同)。
- **关键 ref**:
  - claude-code 流式 idle watchdog(`claude.ts:1868-1928`) —— `STREAM_IDLE_TIMEOUT_MS`(默认 90s,setTimeout 主动 abort)+ stall threshold 30s(仅记日志)
  - claude-code 全局 timeout(`client.ts:144`) —— `API_TIMEOUT_MS` 默认 600s
  - claude-code 非流式 fallback timeout(`claude.ts:807-811`) —— 远程 120s / 本地 300s
- **阶段感知**: refs 都**没实现 think/answer/tool 分别阈值** —— 这是 v0.0.25 要自己设计的
- **工具执行期不误判**: claude-code 在工具调用期间不流式(LLM 不参与),不进 stall 计时

### 2.6 「智能 caller 在传输之上」模式(动态构建请求参数)
- **是什么**: 根据 error 状态动态覆写请求参数 —— max_tokens bump、预压缩、续写 prefill。
- **关键 ref**:
  - claude-code `parseMaxTokensContextOverflowError` + 动态调 max_tokens(`withRetry.ts:388-427, 550-595`) —— 解析 "input length and `max_tokens` exceed context limit: 188059 + 20000 > 200000",按 `contextLimit - inputTokens - safetyBuffer` 算可用空间
  - hermes `parse_available_output_tokens_from_error`(`model_metadata.py:1030-1110`) —— 区分「prompt too long」(输入超→压缩)vs「max_tokens too large」(输出 cap 太大→降 max_tokens),绝不瞎猜 context_length
- **续写 prefill**: refs **都没有** —— 这是 v0.0.25 必须自己写的核心创新点

### 2.7 SSE 流式错误 / 不完整流处理
- **是什么**: 中途断流、流内 error 事件、partial 保留 vs 丢弃、abort 来源区分。
- **关键 ref**:
  - claude-code watchdog abort → 非流式 fallback(`claude.ts:2308-2334`)
  - claude-code 空流/partial 流检测(`claude.ts:2350-2364`) —— `!partialMessage` 或 `newMessages.length===0 && !stopReason` 触发非流式 fallback
  - claude-code abort 来源区分(`claude.ts:2434-2459`) —— `APIUserAbortError + signal.aborted` 双条件:signal.aborted=用户 ESC;否则=SDK 超时
  - hermes partial tool args 区分(`chat_completion_helpers.py:2054-2108`) —— `finish_reason="length"` = 真输出截断→bump max_tokens;无 finish_reason 但 tool args 未完成 = 流断开→不 boost(避免 3 次无效重试)
  - openclaw 流式事件协议(`llm-core/src/types.ts:369-390`) —— `start → ... → done|error`,error 携带 `stopReason: "error"|"aborted"` + errorMessage

## 3. 报告导航

- **`implementation.md`**: 每类策略的触发条件、完整流程、关键代码摘录
- **`recommendations.md`**: 竞品对比表 + 对 v0.0.25 LlmCaller 的具体建议(直接抄/要改/自己写)
