# Tech Change Log — v0.0.10

> 增量记录 v0.0.10 相对 v0.0.8/v0.0.9 的技术架构变更。
> 全量概念权威：`specs/tech/agent/`、`specs/tech/app/frontend/`、`specs/tech/persistence/`、`specs/tech/config/`。
> PRD：`specs/prd/version_logs/v0.0.10/change_log.md`。
> v0.0.10 = **真实使用闭环收尾**：对话页三区布局（推翻 v9a.html 单侧头像）+ AgentLoop 重构（对齐 §4 单 while ①②③④ 顺序内联）+ Usage/cost 全实现 + 新增 observability 子系统（Langfuse 接入）。

## 1. Scope 与口径

**IN SCOPE（v0.0.10 新增/重构）**：对话页三区布局、AgentLoop 结构化重构（行为不变，5→4 文件 992→871 行）、ContextEngine.assemble 持久化 contextWindowUsage、EventHub.cancel 改 wakePendingSubscribers、Usage 全字段 + LlmClient computeCost/validate + parseAnthropicUsage、Observability 子系统（ObservabilityAdapter + NoopAdapter + LangfuseAdapter + agent-loop 埋点 + dev_config.observability schema）、env var convention（LANGFUSE_BASE_URL 主 / LANGFUSE_HOST 兜底）+ flush 生命周期、类型小清理。

**仍 future（保持 v0.0.8 简化基线，不变）**：

| 项 | v0.0.10 状态 | full spec（future） |
|----|------------|---------------------|
| `SessionStore.accumulateUsage` | no-op（保留签名，agent loop 仍不调用） | `session_usage.md` 三分区 + ratio + 递归 sub |
| `stream` 路径端到端 cost | 仅 `call()` 调 computeCost；stream 产 StreamEvent.usage 透传，cost 未在 stream 路径填 | stream gather 后算 cost |
| ContentBlock 双份去重（protocol-types.ts） | 残留 thinking 别名 + 第二份 ContentBlock | 统一引用 `message/types.ts` 权威源 |
| HITL / ratio 学习 / forked agent compact | 不实现 | 同 v0.0.8 future 表 |

## 2. UI：对话页三区布局

**为什么**：v9a.html 单侧头像（user 右 / agent 左）实测气泡越界、两侧不平衡。用户明确推翻单侧方案，改为三区对称布局。

**关键实现点**：
- `component-message-row`（`app/web/src/components/chat/component-message-row.tsx`）：三区 `flex gap-2.5`：左头像列（w-9）｜中间内容列｜右头像列（w-9），**双边对称**。
- user 消息：左头像列空占位 + 内容列靠右（`self-end max-w-[600px]`）+ 右头像列 user avatar；agent 消息：左头像列 agent avatar + 内容列靠左（`max-w-[820px]`）+ 右头像列空占位。
- 气泡不越界（内容列独立受 max-w 约束，头像列固定宽不挤压）。
- avatar 28×28 `rounded-lg` Playfair 700 12px；agent = accent 渐变底白字；user = `bg-fg-2` surface 字。
- `tool-batch` 折叠胶囊改 `items-start` 收窄（展开后内容左对齐，不顶满）。

**对应 spec**：`specs/ui/components/chat-page/_overview.md §4.6`（已同步三区）。

## 3. AgentLoop 重构（行为不变）

**为什么**：v0.0.8 impl 是 `agent-loop-stages.ts` 分阶段文件（5 文件 992 行），但 spec §4 描述的是单 while 循环 ①②③④ 顺序内联。重构使 impl 与 spec §4 一致，提升可读性 + 降低跨文件跳转成本。**行为完全不变**（12 条对齐条款仍 MATCH，见 `states/v0.0.10/audit-agent-loop.md`）。

**关键实现点**：
- 删 `agent-loop-stages.ts`；抽 `ingestAndAssemble(cursor)` helper（①②③ 三处统一调 ingest → clearReplay → assemble）。
- 单 while 循环：`runLoop` 体内 `stagePreProcess`（①）→ `stageLLMRequest`（②，含准入 `ingestUpTo != llmUpTo`）→ `stageToolExecution`（③）→ Exit Check（④）。
- 文件：`agent-loop.ts`（296 行）+ `agent-loop-helpers.ts`（RunState/ingestAndAssemble/doomLoop）+ `agent-loop-emitters.ts`（emit helpers）+ `agent-loop-stream.ts`（② LLM 流式 emit）。
- compact 触发：② LLM 落库 + assemble 后判 `snapshot.contextWindowUsage.remainingTokens < 0` → `contextEngine.compact` → 重 assemble。
- doom_loop：`lastNEqual(recentToolSigs, 3, sig)` 命中 → `stopReason='doom_loop'`（连续 ≥3 轮同 tool_call 签名）。

**对应 spec**：`specs/tech/agent/agent_interface_and_loop/[P0]agent_loop.md §4`（不变，impl 对齐 spec）。

## 4. ContextEngine：assemble 持久化 contextWindowUsage

**为什么**：`states/v0.0.10/audit-context-engine.md` GAP-1（Major）—— assemble 未调 `store.updateContextWindowUsage`，session 级 contextWindowUsage 永不持久化，`GET /session` 展示的 context 用量与实际脱节。spec 本就要求（`context_snapshot_interface.md §4` + `context_usage_detail.md §2`），是 impl 漏。

**关键实现点**：
- `ContextEngine.assemble`（`app/server/src/agent/context-engine.ts`）：return 前加 `await this.store.updateContextWindowUsage(config.sessionId, cw)`。
- store 方法已就绪（`session-store.ts:274-279`，upsert 语义写 session.contextWindowUsage meta）。
- 修复后对齐 `context_engine.md §3/§4` + `usage_detail §2` + `snapshot_interface §4` 三处要求。

**对应 spec**：`specs/tech/agent/context_and_memory/[P0]context_engine.md §3`（assemble 内部 → updateContextWindowUsage）。

## 5. EventHub：cancel 改 wakePendingSubscribers

**为什么**：`states/v0.0.10/audit-manager-eventbus.md` GAP-1（LOW）—— 原 cancel 用 `bus.emit(group, {data:undefined})` 哨兵事件唤醒阻塞的 `iter.next()`，在 replayable bus 上污染 buffer（紧随其后的新 sub 回放出一条 `data:undefined` 伪事件）。

**关键实现点**：
- `ReplayableEventBus` 新增方法 `wakePendingSubscribers(group): void`：只 resolve 排队中的 pending `next()` Promise，**不向 buffer 注入伪事件**。
- `EventHub.cancel`（`app/server/src/agent/event-hub.ts:152-155`）：改调 `bus.wakePendingSubscribers(group)` 而非 `bus.emit`。
- AgentManager.unwrap 路径已丢弃 undefined（兜底保留，无害）；直接走 `hub.sub` 的消费者（SseChannel）也不再收到 undefined。
- EventHub 持有的 bus 最小依赖接口新增 `wakePendingSubscribers(group)`（hub 不依赖 replay 选项）。

**对应 spec**：`specs/tech/agent/event/[P0]event_bus.md`（wakePendingSubscribers 新方法）+ `event_hub.md §3`（cancel 实现细节）。

## 6. Usage / cost 全实现

**为什么**：v0.0.8 Usage 类型链断裂（`states/v0.0.10/audit-event-message-protocol.md` GAP-1/2/3）—— Usage 丢字段 + 全可选 + 索引签名退化为 Record；LlmClient 静默缺 computeCost/validate/currency；CanonicalResponse.usage 退化。cache_control 2bp 投入 encode 成本但收益字段（input_cache_read）在类型与计费链路两头落空。

**关键实现点**：
- **Usage 全字段**（`app/server/src/message/types.ts`）：对齐 `session_usage.md §1` 9 字段（input_cache_read/write、input_no_cache、input_total_tokens、output_response/reasoning、output_total_tokens、total_tokens、cost）+ currency? + inputCharCount/outputCharCount；移除 `[key: string]: unknown` 索引签名。
- **CanonicalResponse.usage**（`app/server/src/llm/protocol.ts`）：类型从 `Record<string, number>` 改为完整 `Usage`；StreamEvent.usage 同。
- **LlmClient.computeCost / validate**（`app/server/src/llm/client.ts`）：
  - `call()` 返回前填 `resp.usage.cost = this.computeCost(resp.usage)` + `resp.usage.currency = this.modelConfig.pricing.currency`（对齐 `llm_client_interface.md §2/§3.3`）。
  - `computeCost(usage)`：用 `modelConfig.pricing`（inputPerMillion / outputPerMillion / cacheReadPerMillion / cacheWritePerMillion）按 input_no_cache / output_total_tokens / input_cache_read / input_cache_write 计算。
  - `validate(request)`：temperature/topP 落 paramConstraints、maxTokens ≤ maxOutputTokens、输入模态 ⊆ inputModalities，违反抛错。
  - **stream 路径端到端 cost 留 future**（StreamEvent.usage 透传 LLM 返回，cost 未在 stream 路径填）。
- **parseAnthropicUsage**（`app/server/src/llm/protocol-parse-stream.ts` 或 protocol-parse）：把 anthropic wire usage（input_tokens/cache_creation_input_tokens/cache_read_input_tokens/output_tokens）映射到完整 Usage（填充 input_cache_read/write、input_no_cache、output_response 等字段）。
- **类型小清理**：`CanonicalResponse.usage` 用完整 Usage、Message.createdAt 去 readonly（信封字段统一可选）。

**对应 spec**：`session_usage.md §1`（Usage 类型已权威）+ `agent_message_interface.md §2` + `providers_and_models/[P0]llm_client_interface.md §2/§3.3`（computeCost/validate 已描述，v0.0.10 impl 落地）。

## 7. Observability 子系统（新增）

**为什么**：agent 执行需要可观测性（trace/调试/成本审计）。用户在 spec-dev 阶段已写 spec（`specs/tech/agent/observability/`），v0.0.10 实现。

**关键实现点**：
- **接口 + 抽象**（`app/server/src/agent/observability/`）：`ObservabilityAdapter`（startTrace/endTrace/startGeneration/endGeneration/startSpan/endSpan/shutdown）+ `NoopAdapter`（默认零成本）。
- **LangfuseAdapter**：用 langfuse TS SDK（`langfuse` npm），全局 singleton（一份凭证跨多 session），trace.id=runId，嵌套靠 SDK `trace.span().span()/.generation()`。
- **agent-loop 埋点**（`LoopObservability`）：run_start → startTrace；每 iteration → startSpan("step N")…endSpan；② LLM 前/后 → startGeneration/endGeneration（带 model + 完整 input/output + usage）；③ tool 前/后 → startSpan("tool:…")/endSpan（完整 arguments/result）。默认 NoopAdapter 无 if 分支。
- **dev_config.observability schema**（`specs/tech/config/`）：Langfuse 凭证（publicKey/secretKey/baseUrl）来源 dev_config（主）+ ENV 兜底。

**对应 spec**：`specs/tech/agent/observability/[P0]overall.md`（v1.1，接口 + 全量字段）+ `[P0]langfuse_adapter.md`（v1.1，SDK 接入 + 字段映射 + flush 生命周期）。**用户已在 spec-dev 阶段 merge，v0.0.10 补 env var convention + flush 生命周期**（见 §8）。

## 8. Env/infra：env var convention + flush 生命周期

**为什么**：原 observability factory 只读 `LANGFUSE_HOST`，但 `test.env` 用的是 `LANGFUSE_BASE_URL` → hasCreds=false → 静默 fallback NoopAdapter → langfuse 从不收数据（Critical blocker）。另：flush 仅接在 electron before-quit，node server（test/prod 独立运行）退出时丢末尾 trace。

**关键实现点**：
- **env var convention**（`app/server/src/observability/index.ts`）：factory 读 `LANGFUSE_BASE_URL`（主，test.env 用此）→ `LANGFUSE_HOST`（langfuse SDK 惯例别名，兜底）。
- **env_start.sh**：注入 `LANGFUSE_*` 环境变量（test.env 的 BASE_URL 被正确识别）。
- **flush 生命周期**：
  - **node server SIGTERM/SIGINT**（`app/server/src/index.ts`）：收到信号后调 `shutdownObservability()` 强制 flush；Electron packaged 模式（isMain=false）不进此分支，其 before-quit 自行 flush。
  - **electron before-quit**（`app/electron/main.ts`）：调 `shutdownObservability()` flush。
  - 不再依赖「process 存活 12s」式延迟 flush。

**对应 spec**：`specs/tech/agent/observability/[P0]langfuse_adapter.md §2/§3`（env var convention + flush 生命周期，v0.0.10 补充）。

## 9. 类型小清理

- **CanonicalResponse.usage**：用完整 `Usage`（见 §6）。
- **Message.createdAt**：去 `readonly`（信封字段 createdAt/updatedAt/version 统一可选，注释说明 store 返回必有；对齐 `agent_message_interface.md §5`）。
- **ContentBlock 双份去重**（`protocol-types.ts` 残留 thinking 别名 + 第二份 ContentBlock）：**留 future**（/chat 已删但清理未做，非阻断）。

## 10. 文件级变更清单（汇总）

**新增**：
- `app/server/src/agent/observability/`（ObservabilityAdapter + NoopAdapter + LangfuseAdapter + factory + LoopObservability 埋点 helper）。
- `app/server/src/agent/agent-loop-helpers.ts` / `agent-loop-emitters.ts` / `agent-loop-stream.ts`（重构拆分）。

**修改**：
- `app/web/src/components/chat/component-message-row.tsx`（三区布局）+ `component-tool-batch.tsx`（items-start 收窄）。
- `app/server/src/agent/agent-loop.ts`（单 while 循环重构 + observability 埋点）。
- `app/server/src/agent/context-engine.ts`（assemble → updateContextWindowUsage）。
- `app/server/src/agent/event-hub.ts` + `event-bus.ts`（wakePendingSubscribers）。
- `app/server/src/message/types.ts`（Usage 全字段 + createdAt 去 readonly）。
- `app/server/src/llm/{protocol,client,protocol-parse-stream}.ts`（CanonicalResponse.usage 类型 + computeCost/validate + parseAnthropicUsage）。
- `app/server/src/index.ts`（SIGTERM/SIGINT flush）+ `app/electron/main.ts`（before-quit flush）。
- `tests/api/env_start.sh` + `tests/e2e/env_start.sh`（注入 LANGFUSE_*）。

**删除**：`app/server/src/agent/agent-loop-stages.ts`（重构后并入单文件 + helpers）。

## 11. Spec-Outdated 修复（本版本 doc-sync 阶段同步）

| spec 条款 | 原状 | v0.0.10 修复 |
|----------|------|-------------|
| `agent_loop.md §4 ②/§6/change_log §5` | accumulateUsage 措辞自相矛盾（既写「构造 usage → accumulateUsage」又标 no-op） | 统一为「v0.0.10 不调用 accumulateUsage（no-op 保留签名）；computeCost 已在 LlmClient.call 落地」 |
| `agent_loop.md §4c` | normal mode 当一等公民详述，未标 future | 标 `[future — v0.0.8/v0.0.10 仅 eager]` |
| `agent_loop.md §4 ①/§6.2` | emit 顺序与 impl 不符（emit 先于 store 写入） | 明确「dedup 是消费端职责，emit 可先于 store-write」 |
| `agent_manager.md §5 emitMessageEnqueued` | 缺 content 字段 | 补 `content: msg.content`（对齐 agent_event.md §4.3） |
| `agent_manager.md §5 unwrap 注释` | 提「replay_clear 等控制事件不透传」 | 改为「clearReplay 是 bus 方法不是事件，无需 unwrap 过滤」 |
| `event_hub.md §3` | sub 伪代码未反映 hub 级 (topic,group) 去重 | 补 v0.0.8/v0.0.10 hub 级去重 note |
| `session_usage.md` + `agent_message_interface.md §2` + `llm_client_interface.md §2/§3.3` | Usage/computeCost 未标 v0.0.10 scope | 标 v0.0.10：Usage 全字段 + computeCost/validate **已实现**；accumulateUsage 仍 no-op |

## 12. 版本

version: 1.0（v0.0.10 新建：对话页三区布局 + AgentLoop 单 while 重构（行为不变）+ ContextEngine assemble 持久化 contextWindowUsage + EventHub wakePendingSubscribers + Usage/cost 全实现 + observability 子系统（Langfuse 接入）+ env var convention + flush 生命周期 + 类型小清理）。
