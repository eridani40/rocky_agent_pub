# v0.0.144 变更计划书（method 级 review 合同）

> 主题：LLM 重试的 ① 分层失败日志（error.log + layer）② llm_request config 装配断链修复 ③ 运行气泡「重试中」外显。
> 行=函数/符号级变更。coder 参考本表 + PRD `specs/prd/version_logs/v0.0.144/03-run-spinner-retry.md` + UI `_overview.md §4.10` 实现；偏离必报 orchestrator。
> 依赖关系：需求2 是需求1/3 的基础（config 生效后 max_attempts 分母才真实、timeout 才生效）。三者同版本一并交付。

---

## 需求 2 — llm_request config 装配接线（断链修复，最优先）

**断点确认（已 grep）**：`LlmRequestConfigService.get()` 仅在 `router.ts:504`（HTTP GET/PUT handler）被调用。生产 agent loop（`loop-stage-llm.ts:callLLMForSpec` / `agent-loop-stage-llm.ts:stageLLMRequest`）组 `baseCallLLM` 入参时**从不设** `llmRequestConfig`/`allProviders`/`health` → `buildInvokeContext.ts:162 config: input.llmRequestConfig` 恒 undefined → `llm_caller.ts:211 ctx.config ?? DEFAULT_LLM_REQUEST_CONFIG` 回退默认（默认 max_attempts=3 掩盖问题）。
**接线方案**：在 `buildSessionConfigFromDeps`（唯一有 `deps.appConfig` 句柄的 SessionConfig 构造点）加载 config 落 `SessionConfig`，两个 stage-llm 透传到 `baseCallLLM`。**health 不接线**——invoke 内 `getProviderHealthRegistry()` 进程单例按 `(sessionId,provider,key,model)` 四元组 key 已保证隔离（spec `[P0]provider_health_registry §6.5`），无需 per-session 注入。

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|----------|------|------|--------|
| agent/context | `app/server/src/agent/context-types.ts` | `SessionConfig.llmRequestConfig?` | 新增 | 加可选字段 `llmRequestConfig?: LlmRequestConfig`（顶部 `import type { LlmRequestConfig } from '../config/llm_request_config'`）。承载生效的 llm_request config，供 stage-llm 透传 invoke | 可选（缺省 undefined→invoke 回退 DEFAULT，向后兼容零回归） | `[P0]llm_request_config.md §1.2` | ~84-174 加字段 + import |
| agent/context | `app/server/src/agent/context-types.ts` | `SessionConfig.allProviders?` | 新增 | 加可选 `allProviders?: LlmProviderConfig[]`（fallback_chain 非空时 resolveTarget 查找用） | 可选；单 provider 部署可空 → 只单 target 兜底 | `[P0]llm_caller.md §6.4` | 同上 |
| handlers | `app/server/src/handlers/session-config.ts` | `buildSessionConfigFromDeps` | 修改 | 组装 return 前：`const llmRequestConfig = new LlmRequestConfigService(deps.appConfig).get()`；`const allProviders = listEnabledProviders(deps.appConfig) as unknown as LlmProviderConfig[]`；return 对象加此二字段。import `LlmRequestConfigService`（config/llm_request_config）+ `listEnabledProviders`（./session-deps）+ type `LlmProviderConfig` | 不改现有字段；`deps.appConfig` 已在；`listEnabledProviders` 已 export（session-deps.ts:167） | session-config.ts:185-318；llm_request_config.ts:125；session-deps.ts:167 | 顶部 import + return |
| agent | `app/server/src/agent/loop-stage-llm.ts` | `callLLMForSpec` | 修改 | `baseCallLLM({...})` 入参补 `llmRequestConfig: config.llmRequestConfig`、`allProviders: (config as {allProviders?:LlmProviderConfig[]}).allProviders`（health 不传→进程单例） | 生产主路径（run-react-loop 用）；不动其余入参 | loop-stage-llm.ts:79-100；agent-loop-base.ts:188-192 | :79-100 |
| agent | `app/server/src/agent/agent-loop-stage-llm.ts` | `stageLLMRequest` | 修改 | 同上，`baseCallLLM` 入参补 `llmRequestConfig`/`allProviders`（旧入口/EOS 测试路径与主路径保持一致，防漂移） | 与 callLLMForSpec 一致 | agent-loop-stage-llm.ts:115-136 | :115-136 |

**非目标（本版本不接线，架构决策）**：`auto-naming-service.ts:applyAiName`（:162 buildInvokeContext 不传 config）——fire-and-forget 后台起名、`backgroundPath=true`（capacity 错误本就不重试）、单 provider 单 attempt 兜底。config 生效对它收益低、blast radius 无谓扩大。保持现状，注释已说明；如后续要让 timeout/retry 生效于起名，另立小改动。

---

## 需求 1 — 分层失败日志（统一 error.log + layer 字段）

**现状**：`error.log` 只在 `run-react-loop.ts:238-245`（run 层 catch）写一条；`llm.log` 在 `llm_caller.ts:157/174`（invoke 级聚合快照，非 per-attempt）。
**方案**：① run 层记录补 `layer:'run'`；② LLM 层每次 attempt 失败（含重试中每次）经 `ctx.logWriter` 写一条 `layer:'llm'` 的精简失败事件。`LogWriter.write` 无需改（record 是自由 `Record<string,unknown>`，layer 直接进 record；`LogType` 已含 `'error'`；开关 `enableErrorLog` 默认 false，`log-writer.ts:76` 早 return 零开销）。
**边界（职责不重叠，都保留）**：`llm.log` = 完整请求/响应快照（invoke 级，debug 全貌）；`error.log(layer=llm)` = 失败事件精简条目（per-attempt，跨层统一失败视图）。定位不同，不去重。

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|----------|------|------|--------|
| agent | `app/server/src/agent/run-react-loop.ts` | catch 块 `agentLog.write('error', {...})` | 修改 | 记录对象补 `layer: 'run'` 字段 | 向后兼容（加字段，现有消费不破）；受 enableErrorLog 门禁 | run-react-loop.ts:238-245 | :238-245 |
| llm/caller | `app/server/src/llm/caller/llm_caller.ts` | `invokeCore`（`result.kind === 'error'` 分支） | 修改 | 在 `appendRecentError(...)` 后、`decideAction` 前新增：`ctx.logWriter?.write('error', { layer:'llm', sessionId, category: err.category, message: err.message, attempt, providerId: target.providerId, modelId: target.model.modelId, keyRef: target.keyRef })`。此点在所有 decide 分支（RETRY/ROTATE_KEY/FALLBACK/NO_RETRY/backgroundPath-fail）上游 → 一条覆盖每次 attempt 失败（含 TIMEOUT 重试） | per-attempt；`ctx.logWriter` 已在 InvokeContext（llm_caller.ts:114）；门禁零开销；invoke 级 all_dead/max_tokens 硬顶的终态由 run 层 catch(layer=run) 兜底记录，不在此重复 | llm_caller.ts:324-352；log-writer.ts:74 | :~333-352 加写 |

---

## 需求 3 — 气泡「重试中」外显（llm_attempt 补字段 + 前端消费）

**G1 maxAttempts**：来源 = `config.retry.max_attempts`（invoke 内 `config` 变量，依赖需求2 才真实）。
**G2 message**：`emitLlmAttempt` 内部 `deriveDisplayReason(category)` 派生（复用现有映射，前端不重复维护）。
**G4 分子/分母语义（统一定义）**：事件 `attempt` = 「刚失败的第几次尝试」（1-based，emit 在 attemptLoop catch 后，`attempt <= config.retry.max_attempts` 循环内 → 恒 1 ≤ attempt ≤ maxAttempts）。UI 显示分子 = `Math.min(attempt, maxAttempts)`（防御性 clamp，保证绝不出 `4/3`）；分母 = `maxAttempts`。读感「重试中 1/3 → 2/3 → 3/3」。`action=FAIL` 终态（`attempt=0`, target=null）不进重试态，前端忽略其分子（PRD §2.1）。

### 后端（事件补字段）

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|----------|------|------|--------|
| llm/caller | `app/server/src/llm/caller/llm_attempt_emit.ts` | `emitLlmAttempt` | 修改 | 签名加参 `maxAttempts: number`；合成 event 加 `maxAttempts` + `message: deriveDisplayReason(category)`（import `deriveDisplayReason` from `./display_reason`） | 纯函数；message 走现有映射 | llm_attempt_emit.ts:39-57；display_reason.ts:66 | :13-57 |
| llm/caller | `app/server/src/llm/caller/llm_caller.ts` | 8 处 `emitLlmAttempt(...)` 调用 | 修改 | 每处末尾补传 `config.retry.max_attempts`（含终结 all_dead FAIL：`emitLlmAttempt(ctx, err.category, null, 0, 'FAIL', config.retry.max_attempts)`） | maxAttempts 依赖需求2 生效 | llm_caller.ts:358,367,374,384,399,405,412,423 | 各调用行 |
| llm | `app/server/src/llm/protocol.ts` | `StreamEvent` `llm_attempt` 变体 | 修改 | 加 `maxAttempts: number` + `message: string` | 与 emit 对齐 | protocol.ts:84-92 | :84-92 |
| agent | `app/server/src/agent/agent-event-types.ts` | `LlmAttemptEvent` | 修改 | 加 `maxAttempts: number` + `message: string` 字段（SSE 出站契约） | 向后兼容加字段 | agent-event-types.ts:322-336 | :322-336 |
| agent | `app/server/src/agent/agent-loop-call-via-invoker.ts` | `forwardEvent`（llm_attempt 分支） | 修改 | 转 `LlmAttemptEvent` 时透传 `maxAttempts: evt.maxAttempts`、`message: evt.message` | 不动其余逻辑 | agent-loop-call-via-invoker.ts:66-86 | :67-83 |

### 前端（消费 + 气泡新态）

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|----------|------|------|--------|
| web/chat-page | `app/web/src/components/chat-page/types.ts` | `RunRetryStatus` | 新增 | 加 `export interface RunRetryStatus { attempt: number; maxAttempts: number; message: string }`（重试 overlay 态，不并入 `LoadingPhase` 枚举） | 独立叠加态 | types.ts | 新增 type |
| web/store | `app/web/src/store/chat-slice-reducer.ts` | `AgentEvent` union + `ReducerState` + `applyAgentEventToMessages` | 修改 | ① union 加 `{ type:'llm_attempt'; category; attempt; maxAttempts; message; action }`；② `ReducerState` 加 `retryStatus?: RunRetryStatus \| null`（+ 返回值透传）；③ 新增 `case 'llm_attempt'`：`action ∈ RETRY/ROTATE_KEY/FALLBACK` → `retryStatus = { attempt: Math.min(evt.attempt, evt.maxAttempts), maxAttempts: evt.maxAttempts, message: evt.message }`；`action=FAIL` → 不设；④ 常规运行事件（`message_start`(assistant)/`text_block_delta`/`tool_call_start`/`tool_result_start`/`tool_execution_start`）与 `run_end` → 清 `retryStatus=null`（重试态被后续正常事件覆盖，PRD 退出规则） | G4 clamp 防越界；retry 是临时叠加态；不阻塞主流程（消费仅影响气泡） | chat-slice-reducer.ts:36-96,128-154,185-447 | 多处 |
| web/chat-page | `app/web/src/components/chat-page/use-messages.ts` | `UseMessagesResult` / `emptyCtx` / return | 修改 | 暴露 `retryStatus: RunRetryStatus \| null`（ctx 派生；run_end/终态强制清同 loadingPhase） | 双写 ctx 渲染通道 | use-messages.ts:48-72,107-132,235-298 | 多处 |
| web/chat-page | `app/web/src/components/chat-page/page-chat.tsx` | ComponentMessageStream 挂载 | 修改 | 透传 `retryStatus={messages.retryStatus}` | 沿 runningToolNames 链 | page-chat.tsx:281 | :281 |
| web/chat-page | `app/web/src/components/chat-page/section-chat-detail.tsx` | props 透传 | 修改 | 加 `retryStatus?: RunRetryStatus \| null` prop，透传到 ComponentMessageStream | 同上 | section-chat-detail.tsx:67-72,129,247 | 多处 |
| web/chat-page | `app/web/src/components/chat-page/component-message-stream.tsx` | props + 挂载 | 修改 | 加 `retryStatus?: RunRetryStatus \| null` prop；`<ComponentLoadingStatus phase=... toolNames=... retryStatus={retryStatus} />` | 同上 | component-message-stream.tsx:57-62,153,322 | 多处 |
| web/chat-page | `app/web/src/components/chat-page/component-loading-status.tsx` | `ComponentLoadingStatus` | 修改 | 加 `retryStatus?: RunRetryStatus \| null` prop。`retryStatus` 非空 → 渲染「重试中 {attempt}/{maxAttempts}」（i18n `loading.retrying`，插值 `{{attempt}}/{{maxAttempts}}`）+ 尾随 ！icon（testid `chat-run-spinner-retry-error`，hover/focus tooltip 显 `message`，复用 `primitive-tooltip`）；容器 `data-phase="retrying"` + inner testid `chat-run-spinner-retrying`。`retryStatus` 空 → 原 4 态行为不变（零回归） | 布局稳定（MANDATORY）：！预留固定空间/绝对定位，态切换零位移；testid 按 `_conventions.md`；不新建组件（§4.10 新增态） | component-loading-status.tsx:19-71；_overview §4.10 | 多处 |
| web/i18n | `app/web/src/i18n/...` chat 命名空间（zh-CN + en） | `loading.retrying` | 新增 | zh:「重试中 {{attempt}}/{{maxAttempts}}」；en:"Retrying {{attempt}}/{{maxAttempts}}" | 双语；沿 `loading.*` 既有 key 风格 | component-loading-status.tsx:31-35 | locale 文件 |

---

## 本版本涉及的 spec 契约新增点

### A. 编码前必须先落（新概念先落 ui spec — architect 本 change_plan 一并落）
- **UI `specs/ui/components/chat-page/_overview.md §4.10`**：`ComponentLoadingStatus` 新增「重试中」显示态（触发/文案/！icon/hover/退出/布局稳定）+ 新 testid `chat-run-spinner-retrying`（重试文案态）、`chat-run-spinner-retry-error`（！hover 触发点）；**§7 testid 总表**加对应两行。← 已由 architect 落（见下）。

### B. doc-modifier 阶段5 统一同步（代码定稿后对齐）
- **API `specs/api/overall/02-llm-chat.md`** + 新建 `specs/api/version_logs/v0.0.144/change_log.md`：`llm_attempt` SSE 事件加 `maxAttempts: number` + `message: string`（向后兼容加字段；原 v0.0.25 §1.4 字段清单补充）。
- **tech `[P0]llm_caller.md §2.3`**：`LlmAttemptEvent` schema 加 `maxAttempts` + `message`；§3 数据流 step1 对齐「invoke 生产路径经 SessionConfig.llmRequestConfig 真正加载 config（修 v0.0.25 断链）」。
- **tech `specs/tech/dev-logs/[P0]overall.md`**：§3.6 error.log 记录结构加 `layer` 字段（llm/run/tool…）；§3.1 附近补「LLM 层 per-attempt error.log（layer=llm，含重试中每次）」；`log.md` 追加本版本条目。
- **tech `[P0]llm_request_config.md` / `[P0]app_config.md`**：config 装配接线现状说明（SessionConfig 承载 llmRequestConfig + allProviders；health 走进程单例）。

---

## architect grep 确认 / 存疑清单

**已 grep 确认真实存在**：`LlmRequestConfigService.get()`（config/llm_request_config.ts:125/134）；`buildSessionConfigFromDeps`（session-config.ts:119，持 `deps.appConfig`）；`listEnabledProviders`（session-deps.ts:167，已 export）；`SessionConfig`（context-types.ts:84，已有 logWriter/appConfig 先例字段）；`callLLMForSpec`（loop-stage-llm.ts:40）+ `stageLLMRequest`（agent-loop-stage-llm.ts:69）；`CallLLMInput.llmRequestConfig/allProviders/health`（agent-loop-base.ts:188-192）；`buildInvokeContext`（build_invoke_context.ts:84，已透传三者）；`emitLlmAttempt`（llm_attempt_emit.ts:39）+ `deriveDisplayReason`（display_reason.ts:66）；`StreamEvent.llm_attempt`（protocol.ts:84）；`LlmAttemptEvent`（agent-event-types.ts:322）；`forwardEvent`（agent-loop-call-via-invoker.ts:66）；`LogWriter.write` + `LogType` 含 `'error'`（log-writer.ts:26,74）；run 层 error.log 写点（run-react-loop.ts:238）；`ctx.logWriter`（llm_caller.ts:114）；前端 `chat-slice-reducer.ts` reducer/ReducerState、`use-messages.ts:48 UseMessagesResult`、`component-loading-status.tsx`、`component-message-stream.tsx:322` 挂载点。

**存疑 / coder 核对**：
1. `listEnabledProviders` 返 `ProviderInstance[]`，需 cast/映射为 `LlmProviderConfig[]`——两类型是否字段兼容（credentials/models/protocolId/id/name）由 coder 核对；不兼容则 map 转换（偏离必报）。
2. `primitive-tooltip` 组件复用（§4.13 run-finish-error hover 已用同款）——coder 核对 import 路径与 `tooltip-content` testid 契约。
3. health 用进程单例是否满足隔离：已确认 invoke `getProviderHealthRegistry()` 按 `(sessionId,...)` 四元组 key（spec §6.5），无需 wire——若 coder 发现实现偏离四元组隔离，报 orchestrator。
