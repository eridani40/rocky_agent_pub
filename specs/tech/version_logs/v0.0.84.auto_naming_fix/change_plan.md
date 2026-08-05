# v0.0.84 变更计划书 — 会话起名不稳定修复（auto_naming_fix）

> **method 级 review 合同**（已 user review 通过，D2/D3/D4 拍板见末尾）。coder 按本表实现，code-reviewer 按本表查偏离。

## 背景

起名裸调 `config.client.call` 绕过 `LlmCaller.invoke`（无 adaptive retry / 无 langfuse / 无错误归一化）+ hardcode `params:{maxTokens:1024,temperature:0}`（thinking 模型 thinking budget 占满 → `stop_reason:max_tokens` 无 text → 静默失败）+ gate 首条锁定（失败即永久放弃，重启不恢复）。

修复核心：**起名改走 `LlmCaller.invoke`**，三件事一次到位（复用配置 + reuse 重试 + langfuse）。gate/CAS 保持现状。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent | `app/server/src/agent/auto-naming-service.ts` | `AutoNamingService.applyAiName` | 修改 | 裸 `config.client.call` → `LlmCaller.invoke(baseReq, ctx)`；`ctx.backgroundPath=true`；`baseReq` 用 `config.modelId` + 起名 messages，**不传 params**（maxTokens/temperature 全复用 session/model 配置 + invoke buildRequest overlay） | MUST `backgroundPath:true`；MUST baseReq 不含 maxTokens/temperature；MUST 任何失败不抛主路径（外层 catch 兜底）；MUST 不雪崩（capacity 类不重试由 backgroundPath 保证） | `llm_caller.ts:invoke`(§2.1)+§6.5 backgroundPath；`build_invoke_context.ts` | +20 −8 |
| agent | `app/server/src/agent/auto-naming-service.ts` | `AutoNamingServiceDeps` | 修改 | 注入 `LlmCaller.invoke` 入口 + `InvokeContext` 构造所需（observability 从 `SessionConfig.observability` 取；providers/clientFactory 等 ctx 字段由 coder 读 `build_invoke_context.ts` 决定最小集） | MUST 走依赖注入（bootstrap 装配），不硬 import 单例；MUST observability 复用 SessionConfig 已注入的 adapter | `bootstrap.ts:805-812`；`context-types.ts:82` SessionConfig.observability | +6 |
| agent | `app/server/src/agent/auto-naming-service.ts` | `NAMING_PROMPT` 相关注释（v0.0.64 maxTokens 注释块） | 修改 | 删「为什么 maxTokens=1024」注释段（params 已不 hardcode，注释过时）；NAMING_PROMPT 文本本身保留 | — | — | −7 |
| agent | `app/server/src/agent/auto-naming-service.ts` | 三处空 `catch {}`（trigger/applyAiName LLM 调用/落库） | 修改 | 关键失败点加最小观测：调 observability `endGenerationError`（带 errorCategory）或等价 langfuse 失败标记；保留 fail-silent（catch 体不抛） | MUST 仍 fail-silent（不打扰用户、不阻塞主 run）；MUST 观测本身 try/catch 吞掉（观测失败不影响主路径） | `langfuse_observability_port.ts` endGenerationError | +8 |
| bootstrap | `app/server/src/bootstrap.ts` | AutoNamingService 装配点 | 修改 | 注入 `LlmCaller.invoke` 入口 + ctx 构造依赖（observability 已在 SessionConfig 链路上） | — | 现 805-812 | +4 |

## 不改（D4 用户明确保留）

- **`triggerIfFirstQuery` gate**：首条 query（transcript 无 prior user）+ `titled!==true` 触发，**逻辑不变**（不补起名，失败由用户手动改名）
- **CAS**：`applyAiName` re-read `titled===false` 才回写（用户已改名 `titled=true` 则丢弃 AI 名）
- playground scope gate / fire-and-forget（外层 `.catch(()=>{})`）/ `extractPlainName` 净化
- `session-messages.ts:182-186` 触发点不动

## 影响面评估

- **跨模块**：agent（auto-naming-service）+ bootstrap 装配。不碰 handler/store/前端。
- **无破坏性变更**：triggerIfFirstQuery/gate/CAS/触发点全保留，外部行为契约不变（仍是「首条 query fire-and-forget 起名，CAS 保护」），仅内部 LLM 调用链路升级。
- **依赖顺序**：底层 `LlmCaller.invoke` 已存在（v0.0.25 起），本版本只消费它，不动它。
- **风险点**：① `InvokeContext` 构造在起名场景的最小集（起名无 errorState 跨 iteration 继承、无 tools、无 compressor）—— coder 须读 `build_invoke_context.ts` 确定哪些字段必填、哪些可省；② observability 接口形态（`SessionConfig.observability: ObservabilityAdapter` vs `InvokeContext.observability: ObservabilityPort`）若不符，参考主 loop `agent-loop-stage-llm.ts` 的 `invokeObservability` 构造方式适配。

## 用户拍板的设计决策（D2/D3/D4）

- **D2 重试**：reuse `LlmCaller` adaptive retry 全套（`RETRY_BACKOFF`/`FIX_AND_RETRY_MAX_TOKENS`←治 thinking 截断/`ROTATE_KEY`/`FALLBACK`）。`backgroundPath:true` 仅排除 capacity(rate_limit/overload)类重试防雪崩（`llm_caller.ts:354-356`）。**不另搞跨消息补/应用层重试**。
- **D3 params**：temperature:0 也不留（用户：名字每次一样不一样无所谓），baseReq 完全不传 params，复用配置。
- **D4 gate/CAS**：保持现状，不补起名；CAS 保护用户改名是核心不变量。

## 反馈回路

- 实现/codereview 严重违反本表（改 gate/CAS、传 hardcode params、backgroundPath=false、动表外文件）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect
