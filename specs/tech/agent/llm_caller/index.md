---
type: index
title: LlmCaller 子系统总起
priority: P0
updated: 2026-06-30
---

# LlmCaller 子系统总起

## ① 是什么

LlmCaller = LLM 调用的**策略层 / 编排层**——在 `LlmClient`（机制层，4 件套不可变共享）**之上**抽一层，收口「错误归一化 + adaptive retry + provider 降级 + 分阶段超时 + 动态参数构建（length/prefill）」全流程。对外只暴露 `invoke()` 一个入口；agent loop 的 `callLLM` 改调 `llmCaller.invoke()`（不再直调 `client.stream`）。三层正交：LlmClient = 机制层、LlmCaller = 策略层、agent loop = 驱动层，各自独立演化、各自单测。

| 核心概念 | 一句话 |
|---|---|
| **invoke()** | 唯一入口，发起一次带状态、自适应的 LLM 调用（成功返聚合响应，失败 throw ClassifiedLlmError） |
| **resolveTarget** | fallback_chain + 健康表**两遍扫描**选 target（healthy 优先 → degraded 兜底） |
| **attemptLoop** | 单 target 内 1..max_attempts 重试循环 + 看门狗 abort |
| **buildRequest** | 按 errorState overlay 改实参（maxTokens 派生 / precompress / prefill） |
| **decide** | 读 err.hints + recentErrors 产 action（NO_RETRY/RETRY/ROTATE_KEY/FIX_AND_RETRY/FALLBACK） |
| **Watchdog** | 分阶段超时（TTFB 45s / stall / wall 600s），composite AbortController |
| **ProviderHealthRegistry** | 进程级 singleton，provider 健康 4 态机（healthy/degraded/cooled_down/dead），按 (sessionId,provider,key,model) 四元组 |
| **LlmErrorState** | RunState 级 overlay（跨 iteration 继承，不落盘），含 recentErrors / precompress / prefillPartial |
| **LlmErrorCategory** | 错误归一化枚举（按恢复语义分组），classify 把任意 raw error → category + hints |
| **fallback_chain** | 全局 provider 池 config（`llm_request` group），(providerId, keyRef, modelId) 三元组列表 |
| **llm_attempt SSE** | per-attempt 动态事件（RETRY/ROTATE_KEY/FALLBACK/FAIL），实时外显重试/降级进度 |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| invoke / resolveTarget / buildRequest / attemptLoop / decide 编排 | LlmClient 4 件套绑定 / call / stream（→ `../providers_and_models/[P0]llm_client_interface.md`，不可变共享不动） |
| 错误归一化（LlmErrorCategory / ClassifiedLlmError / classify / hints） | HTTP 调用细节 / fetchImpl 注入（归 LlmClient） |
| ProviderHealthRegistry（进程级 singleton / 4 态机 / cooldown） | agent loop 消息驱动 / 状态机 / RunState 游标（→ `../agent_interface_and_loop/`） |
| 退避算法（getRetryDelay）+ 分阶段超时看门狗 | config 持久化机制（→ `../../config/[P0]app_config.md`） |
| Length 处理（MAX_TOKENS bump / CONTEXT_LENGTH 压缩 / prefill defer） | session store / usage 落盘（→ `../session/`） |
| `llm_request` config group / LlmErrorState schema / fallback_chain 结构 | HTTP API 端点 / SSE wire（→ `specs/api/overall/02-llm-chat.md`） |

## ③ 与系统的关系

```
   agent_loop.callLLM（驱动层）
        │  invoke(baseReq, ctx)              ← ctx = errorState + controller + observability + callers
        ▼
   ┌─── LlmCaller（策略层 / 编排层 / 可变状态）──────────────────────────────┐
   │  resolveTarget  ← fallback_chain + ProviderHealthRegistry（两遍扫描）    │
   │  attemptLoop    ← retry / classify / decide / getRetryDelay              │
   │  buildRequest   ← errorState overlay（maxTokens 派生 / precompress）     │
   │  Watchdog       ← TTFB / stall / wall abort（composite AbortController） │
   └────────────────────────────────────────────────────────────────────────┘
        │  client.stream(req, compositeSignal)    ← 不动（机制层）
        ▼
   LlmClient（4 件套不可变共享 / 跨 session 并发安全）
        │
        ▼
   HTTP → LLM → ClassifiedLlmError（category + hints）或 CanonicalResponse
```

**对外协作点**：invoke 持 LlmClientFactory（按 (provider,key,model) 取/建 client，4 件套缓存复用）；health registry 进程级 singleton（重启 reset，dead-key 懒重验）；errorState 注入自 RunState.llmErrorState（跨 iteration 继承，不随 session 落盘）；llm_attempt SSE 经 ctx.onEvent 转 agent loop emit。

## ④ 核心设计原则（跨文件不变量）

1. **LlmCaller 是独立层，不塞 LlmClient**——LlmClient 不可变共享是核心价值；retry/状态机需可变状态，塞进去破坏并发安全 + 失去缓存复用。→ `[P0]llm_caller.md §6.1`
2. **错误状态记 RunState，不记 LlmCaller 局部**——跨 iteration overlay（maxTokensBump/precompress/prefillPartial）记 `RunState.llmErrorState`；进程级（cooldown/dead-key）记 health registry；瞬时（attempt/lastError）记 invoke 局部。→ `[P0]llm_caller.md §6.2`
3. **llmErrorState 不落盘**——overlay 本质是「上次失败的临时应对」，重启后场景已变，保留 stale overlay 风险高于收益。→ `[P0]llm_caller.md §6.3`
4. **整链全 dead 才真失败**——否则用户对 overload/429/超时无感；不可恢复（CONTENT_FILTERED/AUTH_INVALID/MODEL_NOT_FOUND）首次即 throw，不重试。→ `[P0]llm_caller.md §2.1`
5. **classify 与 decide 分离**——classify 只产 category + hints（bool），decide 读 hints + recentErrors + attempt 产 action；两阶段解耦（hermes 模式）。→ `[P0]error_normalization.md §6.1` + `[P0]llm_caller.md §3`
6. **backgroundPath 防雪崩**——summary/title 等后台路径 overload/rate_limit 直 fail 不重试（避免 capacity cascade 时 3-10× 放大 gateway 压力）。→ `[P0]llm_caller.md §6.5`
7. **config 必须一路接线才生效**——`LlmRequestConfig` 唯一在 `buildSessionConfigFromDeps` 加载落 `SessionConfig.llmRequestConfig`，经两个 stage-llm 透传到 invoke；不接线则恒回退 `DEFAULT`（default max_attempts=3 会掩盖漏配）。auto-naming 后台路径明确不接线。→ `[P0]llm_caller.md §4.1`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| **编排层主体** | | |
| `[P0]llm_caller.md` | LlmCaller invoke 接口 + 数据流（resolveTarget→attemptLoop→decide）+ callLLM 接入 + RunState.llmErrorState + 设计决策 | [link]([P0]llm_caller.md) |
| **子模块** | | |
| `[P0]error_normalization.md` | LlmErrorCategory 枚举 + ClassifiedLlmError + classify 函数 + Anthropic adapter 映射表 | [link]([P0]error_normalization.md) |
| `[P0]provider_health_registry.md` | ProviderHealthRegistry（进程级 singleton / 4 态 discriminated union / 升级恢复 / account-wide quota 例外） | [link]([P0]provider_health_registry.md) |
| `[P0]retry_and_timeout.md` | 退避算法（半 jitter + retry-after cap）+ 分阶段看门狗（TTFB/stall/wall）+ composite abort + partial 保留 | [link]([P0]retry_and_timeout.md) |
| `[P0]length_handling.md` | MAX_TOKENS bump / CONTEXT_LENGTH 压缩 / prefill defer + ModelCapability + STREAM_INCOMPLETE 区分 | [link]([P0]length_handling.md) |
| `[P0]llm_request_config.md` | `llm_request` config group + LlmErrorState schema + fallback_chain + credentials 多 key 引用 | [link]([P0]llm_request_config.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
