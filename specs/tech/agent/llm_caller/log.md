---
type: log
title: LlmCaller KB 变更记录
updated: 2026-07-05
---

# LlmCaller KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-14 · v0.0.144（config 装配断链修复 + llm_attempt 补 maxAttempts/message）

- **`[P0]llm_caller.md` 新增 §4.1「config 装配接线」**：修 v0.0.25 起潜伏的断链——`LlmRequestConfigService.get()` 此前仅 `router.ts` HTTP handler 调用，生产 loop 从不设 `llmRequestConfig` → invoke step1 恒 `ctx.config ?? DEFAULT` 回退默认（default max_attempts=3 掩盖漏配）。接线：`buildSessionConfigFromDeps` 加载 config 落 `SessionConfig.llmRequestConfig` + `allProviders`（宽转），两个 stage-llm（`callLLMForSpec` / `stageLLMRequest`）透传到 `baseCallLLM`。health 不接线（进程单例四元组隔离）；auto-naming 明确不接线（后台 fire-and-forget）。§3 数据流 step1 同步注明来源。`index.md §4` 加设计原则 7。
- **`[P0]llm_caller.md §2.3` LlmAttemptEvent 加 `maxAttempts` + `message`**：`maxAttempts = config.retry.max_attempts`（前端「重试中 x/x」分母，8 处 `emitLlmAttempt` 调用点补传）；`message = deriveDisplayReason(category)`（emit 内派生，hover 展示）。`keyRef` 订正为可选（对齐代码 `keyRef?: string`；all_dead FAIL 时 attempt=0/target=null）。
- **`[P0]llm_request_config.md` 新增 §1.3.1「config 装配接线」**：`get()` 返回值经 SessionConfig 一路接线的现状说明（指向 llm_caller §4.1）。

详情：`specs/tech/version_logs/v0.0.144/change_plan.md` + `specs/api/version_logs/v0.0.144/change_log.md`

## 2026-07-05 · v0.0.68（invoke 外层 catch 补 endGenerationError — R7 langfuse bug 修复）

- **`[P0]llm_caller.md §2.1 line 65 不变量重申`**：「所有 throw 前 endGenerationError」是 spec 已明确的红线，本版本**修实现偏离**：`app/server/src/llm/caller/llm_caller.ts invoke()` 外层 catch（约 :155-161）只写 dev log 后 rethrow，**未调 endGenerationError**——invokeCore 抛出的非 ClassifiedLlmError 异常（attemptLoop runtime error 等）会绕过 invokeCore 内部已 end 的 throw 点（line 269/295/338/346/400）直击外层 catch，langfuse 该 generation 漏 end。
- **修法（D7）**：invoke 加 `observabilityEnded: boolean` 标志位；invokeCore 内部已 end 处置 true；外层 catch 判定 `if (!observabilityEnded && e 不是 ClassifiedLlmError)` 补 `ctx.observability?.endGenerationError?.(LlmErrorCategory.INTERNAL, msg, { retryChain: [] })` 后再 rethrow。**避免重复 end**（invokeCore 已 end 的 ClassifiedLlmError 不再二次 end）。
- **BUG-001 修复（trace level=ERROR 等价机制）**：spec 起草时写「trace level=ERROR 落盘」，实际 langfuse `ApiTraceBody` schema **无 level 字段**（仅 observation 有），SDK `trace.update({level})` 被后端 silently 忽略 → trace_level 查询返 None。修走 spec R7 change_plan 行 101「或等价机制」：trace 类型 setLevel 改写 `metadata.errorLevel`（deep-merge 落盘，可被 GET /traces/{id} 查询）；span/generation 不变（observation schema 支持 level）。**关键**：trace 顶层**没有** level 字段——下游 agent 别再以为 `trace.update({level})` 能落盘，必须走 `metadata.errorLevel` 等价机制。commit 03c1b9a8。
- **endTrace trace-level ERROR**（agent-loop-observability）：`agent-loop-observability.ts` 加 `markTraceError(reason: string): void` 方法；agent loop `run.error` 路径调用，内部走 setLevel 等价机制把 trace metadata.errorLevel=ERROR（详见上条 BUG-001）。**endTrace 签名不变**（避免破坏 4+ 调用点 + 测试）。
- **关联**：`specs/tech/agent/observability/log.md` v0.0.68 条目同步 setLevel 接口 + LangfuseAdapter metadata.errorLevel 分支（doc-modifier 阶段 5）。

详情：`specs/tech/version_logs/v0.0.68/change_log.md` §R7

## 2026-07-02 · v0.0.50（物理层 generation 埋点 + 物理方法归属 Port）

- `[P0]llm_caller.md` 新增 §6.6「物理层 generation 埋点」：invoke 内 protocol.encode 后 HTTP 前，若 `obs.hasPhysicalChild()` 为真则 `startPhysicalGeneration(wireBody)` + `try/finally` `endPhysicalGeneration`（无 usage/output）。
- **物理方法归属**（避 `llm/caller→agent` 依赖循环）：`startPhysicalGeneration` / `endPhysicalGeneration` / `hasPhysicalChild` 在 `LangfuseObservabilityPort`（`app/server/src/llm/caller/langfuse_observability_port.ts`），不在 agent 层 `LoopObservability`。`LoopObservability` 仅暴露 `currentGenIteration(): number` 供 port 拼 N。
- name 格式：`llm-N-physical`（N 同 logical 的 `llm-N-logical`，成对紧邻）。
- 关闭态零开销：`hasPhysicalChild()`=false 时跳过整个 physical 分支（等价 v0.0.49）。

详情：`specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md`

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起，98 行）+ 本 `log.md`。
- `[P0]llm_caller_overview.md` 拆流：overview/概念/边界/导航 → index；invoke 接口 + 数据流 + callLLM 接入 + 设计决策 + 边界 → 新成 `[P0]llm_caller.md`（正文对齐 docs_guide §2）；原 `_overview` 文件归档 soft_deleted。
- 6 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理 inline `[vX.Y]` / `[vX.Y modified]` 噪声 + 尾部 `## 版本` 段，迁移到 frontmatter `since` 或本 log。
- 修正 spec 错误：
  - `[P0]llm_caller.md §2.2` resolveTarget 签名对齐代码现状（实参 config/providers/clientFactory/onWire/now/fallback；无 sessionErrorState 形参）+ 返回 ResolvedTarget（含 providerId/keyRef/keyValue）。
  - `[P0]llm_caller.md §7` BUG-005 状态：spec 旧标「待 coder 实现」，但 client.ts validate() 已落 LlmHttpError{400}（→ classifier MAX_TOKENS_TOO_HIGH / BAD_REQUEST_OTHER）→ 订正为「已实现」。
- 子模块内 `[P0]llm_caller_overview §X` 引用 → 改指 `[P0]llm_caller §X`；`../providers_and_models/[P0]llm_client_interface.md` 同步。

## 2026-06-15 · v0.0.25（LlmCaller 独立成层 + rev2 改版）

- LlmCaller 编排层独立成 spec：在 LlmClient 之上收口错误归一化 / adaptive retry / provider 降级 / 分阶段超时 / 动态参数构建；对外只暴露 `invoke()`。
- rev2 改版：resolveTarget 改**两遍扫描**（healthy 优先 → degraded 兜底 → cooled_down 跳过 → dead 排除）+ 四元组 key；attemptLoop 加 recentErrors append/clearRecentErrors + emit `llm_attempt` SSE event；Run finish_reason 携带 errorCategory/displayReason/errorDetail（不塌缩 LOOP_ERROR）。
- 新增 5 子模块 spec：error_normalization / provider_health_registry / retry_and_timeout / length_handling / llm_request_config。
- callLLM 接入改造（agent_loop_base §2.1）；RunState 加 `llmErrorState` 字段（不落盘）。
- account-wide quota 例外（RATE_LIMITED 直接 fallback 换 provider，不轮换 key——hermes 教训）。
- BUG-005 收口方向定（validate 抛可分类 MAX_TOKENS_TOO_HIGH / BAD_REQUEST_OTHER）。

详情：`specs/tech/version_logs/v0.0.25/change_log.md` + `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md`

## 2026-05-XX · v0.0.24 前置（fallback chain 概念）

- fallback chain 概念引入（「换 key = 换 provider」统一元组）；credentials 多 key union 铺垫（reqs.md §3）。
