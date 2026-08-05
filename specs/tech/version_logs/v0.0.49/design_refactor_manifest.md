---
type: design
title: v0.0.49 — Spec/Impl 改动清单 + 不变量 + 测试（design.md §4/§6/§7 展开）
version: 0.1
updated: 2026-07-02
status: done
parent: specs/tech/version_logs/v0.0.49/design.md
related:
  - specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md
  - specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_forked.md
  - specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md
  - specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md
  - specs/tech/agent/context/[P0]context_engine.md
---

# Spec/Impl 改动清单 + 不变量守护 + 风险/测试

> 本文展开 `design.md §4/§6/§7`：逐 spec / impl 文件列出三态分类（保留/删除/修改）+ 改动要点 + 不变量守护 + 风险与测试策略。
>
> 用户决策对齐：D1 删 ContextPort / D2 删 callLLMForXxx / D6-D9 保留骨架+port+scopeId+contextEngine impl 链。

---

## 1. Spec 改动清单（逐文件）

> 原则：spec 错改 spec，实现错改实现。下方按 spec 文件列出改动点；§2 按实现文件列出。

### 1.1 `[P0]agent_loop_unified.md`（**大改**：删 ContextPort 整章 + §4 装配表 ContextPort 行）

| 章节 | 改动 | 内容 |
|---|---|---|
| 标题/前言 | 修改 | "4 Port 注入" → "**3 Port 注入 + 直调 contextEngine/base.callLLM**"；首段 §1 "下沉为 4 个 port" 改 "3 个 port（context 删除）+ 骨架直调 contextEngine.ingest/assemble 与 base.callLLM" |
| §2 骨架伪代码 | 修改 | ① 取消 `spec.context.prepare(state)` 改为直调 `contextEngine.ingest/assemble(scopeId, buffer)` + drain（`drainMode === 'eager'` 控制，三态枚举）；② 取消 `spec.wireCallLLM(...)` 改直调 `base.callLLM(...)`；recordAssistant/recordToolResults 改 `contextEngine.ingest`；compact 改骨架直调 `tryCompact(pluginManager, ctx)` |
| §3 Port 契约 | **删除 §3.1 ContextPort 整章** | 删 `interface ContextPort {...}` + tryCompact 胶水说明（迁入骨架描述）|
| §3 Port 契约 | **删除 §3.3 FinalizePort 整章**（D7 并入 LifecyclePort） | `onInterrupted` 成为 `LifecyclePort` 方法；MainLifecyclePort 含 onInterrupted=noop（abort api 4 步接管）；ForkedLifecyclePort 含 onInterrupted=noop（buffer 随 GC） |
| §3 Port 契约 | 保留 §3.2/§3.4 | LifecyclePort（三 hook `onUsage`/`onRunEnd`/`onInterrupted`） / emit port 保留不动 |
| §4 装配表 | 修改 | 删 context 行；删 FinalizePort 行（D7 并入 LifecyclePort）；新增 `scopeId` / `buffer` / `drainMode`（替代 `drainOptions`，三态枚举 `'eager'|'none'|'lazy'`）/ `backgroundPath` / `stopSequences` / `eosStripper` / `compactNoticeEmitter` 字段对照（main vs forked）；新增"骨架统一调 contextEngine" 说明段 |
| §5 与 base/mode 关系 | 修改 | base §2.1 callLLM 标注"骨架直调（不再有 callLLMForXxx 包装）"；eager_drain / forked §"while 编排退役" 改为 "while 编排 + ContextPort 退役，骨架直调 contextEngine" |
| §6 风险 | 修改 | 删 "ContextPort 改 forked 前缀" 段；加 "骨架直调 contextEngine 时 buffer 透传 + scopeId 路由保证 forked 走 buffer_sink/buffer_reader/append_passthrough" |

### 1.2 `[P0]agent_loop_forked.md`（**中改**：§4 改新骨架直调）

| 章节 | 改动 | 内容 |
|---|---|---|
| 文件顶 [v0.0.40] 注 | 修改 | "buildForkedDeps 装配 4 port（buffer-backed ContextPort + ...）" → "buildForkedDeps 装配 RunSpec（buffer 字段进 RunState，骨架直调 contextEngine.ingest/assemble('forked', buffer)，不再有 ContextPort 层）" |
| §4 消息驱动 | 修改 | while 编排迁入 unified runReActLoop（保留这句）；删 `ForkedContextPort` buffer.push 描述；改为"骨架直调 `contextEngine.ingest(scopeId='forked', buffer)` 由 `buffer_sink` impl append 到 buffer；`contextEngine.assemble(scopeId='forked', buffer)` 由 `buffer_reader`+`append_passthrough` 返回 buffer 原样" |
| §4 system 注入 | 修改 | "snapshot.system prepend" 改为"buildForkedDeps 装配时把 `initialSnapshot.system` 放 buffer[0]，buffer_reader 贡献为 transcript 头，append_passthrough 原样返回" |
| §7 副作用表 | 修改 | "写 transcript 关" 保留（forked scope `store_sink` disabled，非代码 if 硬尾，D15）；"compact 关" 加注"骨架统一调 tryCompact，forked scope reject_should_compact 恒 false 自动跳过"；"accumulateUsage 关" 改"option 开启时由 ForkedLifecyclePort.onUsage 调 accumulateUsage(sid,'forked',u)" |
| §9 中断 | 修改 | "D4 直接退出无收尾" 保留；加注"ForkedLifecyclePort.onInterrupted=noop（D7 并入 LifecyclePort，onInterrupted 是 LifecyclePort 方法），buffer 随 RunState GC" |

### 1.3 `[P0]agent_loop_eager_drain.md`（**小改**：标注直调）

| 章节 | 改动 | 内容 |
|---|---|---|
| §6 循环结构 [v0.0.40] 注 | 修改 | "迁入 unified runReActLoop，由 buildMainDeps 装配 4 port" → "...装配 RunSpec（`drainMode='eager'` + store 游标进 RunState，骨架直调 contextEngine.ingest/assemble('default') + drain inbox；FinalizePort 并入 LifecyclePort，三 hook onUsage/onRunEnd/onInterrupted）" |
| §6 ② LLM Request | 修改 | "base.callLLM" 保留；加注"骨架直调（无 callLLMForMain 包装）；EOS stop seq / filterToolDefinitions 已在 buildMainDeps 装配阶段进 spec.toolDefinitions / spec.stopSequences" |
| §6 ② compact 判定 | 修改 | "contextEngine.compact" 改 "骨架统一调 tryCompact(pluginManager, ctx)，default scope threshold/summary impl 触发" |
| §7 副作用策略 | 保留 | ingest/compact/accumulateUsage/run/state/emit 落点描述不变（behavior 保留）|

### 1.4 `[P0]agent_loop_base.md`（**最小改**：§2.1 加注）

| 章节 | 改动 | 内容 |
|---|---|---|
| §2.1 callLLM | 加注 | "本原语被 runReActLoop 骨架直调（v0.0.49 起 callLLMForMain/callLLMForForked 中间层移除）。backgroundPath / modeKey / stop / maxOutputTokens 等参数由 RunSpec 字段透传，骨架不再经 hook 间接调用" |
| §1.2 base vs mode 分工 | 修改 | "callLLM 原语" 行加注"骨架直调（无 hook 包装）" |
| §3 tool 双维度 / §4 RunState / §9 StopReason | 不动 | 行为契约保留 |

### 1.5 `[P0]context_engine.md`（**最小改**：§3.6 补说明）

| 章节 | 改动 | 内容 |
|---|---|---|
| §3.6 D1=B | 加一段 | "v0.0.49 起 unified runReActLoop 骨架直调 ingest/assemble(scopeId, buffer)；之前的 ContextPort 包装移除。spec §3.6 契约本身不变（scopeId + buffer 透传 + 三 forked impl）。**这次修复了 spec 与代码的偏差**：v0.0.40-0.0.48 期间 ForkedContextPort 直接 buffer.push 绕过了 §3.6 声明的链路（死代码），v0.0.49 骨架开始真正调用 impl 链。" |
| §3.6 D15 (新增) | 加一段 | "v0.0.49 default sink 也 EP 化（`store_sink` impl，EP=`context_ingest_handler`），contextEngine 删 `if scopeId !== FORKED_SCOPE_ID store.appendMessages` 硬尾（`context-engine.ts:187-190`），default/forked sink 对称：default chain 尾 `store_sink` 写 store / forked chain 尾 `buffer_sink` 写 buffer；`IngestCtx` 加 `store?: SessionStore` 字段（default scope 注入 wireStore / forked 不注入 / store_sink 读它）。怎么决定 forked 不持久化 = scope 配置 disable `store_sink`（非代码 if）。" |
| §4 与 Agent Loop 交互 | 修改 | "current ContextPort.prepare / recordAssistant" 等命名改 "骨架 ① drain + ingest + assemble / ② 后 ingest + tryCompact"（去掉 ContextPort 命名）|

### 1.6 其他 spec（不动或最小加注）

| 文件 | 改动 |
|---|---|
| `[P0]agent_interface.md` | 不动（RunSpec 是 unified 引用，本身无 ContextPort 字段）|
| `[P0]agent_scope_router.md` | 不动（scopeId 路由不变）|
| `[P0]context_compact_detail.md` §2c | 不动（tryCompact 胶水契约保留）|
| `[P0]agent_loop_base.md` §2.2 executeTools | 不动 |

### 1.7 `[P0]extension point and implementations.md`（**小改**：impl 清单加 store_sink）

| 章节 | 改动 | 内容 |
|---|---|---|
| context_ingest_handler impl 清单 | 加一行 | `store_sink`（**v0.0.49 新增 impl**，default 专属 sink，对齐 `buffer_sink` 的 forked 专属语义）；行为 = `ctx.store.appendMessages(ctx.config.sessionId, messages)`；`IngestCtx` 加 `store?: SessionStore` 字段（default 注入 / forked 不注入）|

---

## 2. 实现重构清单（逐文件 三态）

### 2.1 删除（4 个文件 — 整删）

| 文件 | 行数 | 判定 | 删除内容 | 替代/迁移 |
|---|---|---|---|---|
| `app/server/src/agent/context-port.ts` | 225 | **整删** | `MainContextPort` / `MainLifecyclePort` / `MainFinalizePort` 三 class | Main 三 port 行为内联到 run-react-loop.ts（contextEngine 直调 + 旧 lifecycle/finalize 装配为 LifecyclePort impl）；或迁 lifecycle/finalize 到 build-deps.ts 内部 helper |
| `app/server/src/agent/forked-context-port.ts` | 134 | **整删** | `ForkedContextPort`（绕过 contextEngine 的死代码 — 这是 v0.0.49 主要修复点） / `ForkedLifecyclePort` / `ForkedFinalizePort` | forked recordAssistant/recordToolResults 改骨架统一调 contextEngine.ingest；lifecycle/finalize 迁 build-forked-deps.ts 内部 helper |
| `app/server/src/agent/agent-loop-call-main.ts` | 123 | **整删** | `callLLMForMain` 函数（EOS + filterToolDefinitions + langfuse + obs 包装层）| EOS stop seq / filterToolDefinitions **迁 build-deps.ts 装配阶段**（spec.toolDefinitions / spec.stopSequences 一次性定）；langfuse + obs 包装内联骨架 §2 LLM 段 |
| `app/server/src/agent/agent-loop-call-forked.ts` | 119 | **整删** | `callLLMForForked` 函数（langfuse + obs 包装层，backgroundPath=true）| backgroundPath 改 RunSpec 字段透传；langfuse + obs 包装内联骨架 §2 LLM 段（与 main 共用）|

> **判定依据**：用户决策 D1/D2。这 4 文件是 spec ↔ 代码偏差的根源（v0.0.40 引入的中间层）。删除后骨架直调 contextEngine + base.callLLM，ext impl 链路被真正激活。

> **注意 `agent-loop-call-via-invoker.ts`（110 行）**：现状是 callLLMForXxx 的底层 helper（含 invoke 路径），需查看是否仍被其他处引用；若仅被 call-main/call-forked 引用则同删；若被 base.callLLM 直接调则保留。**实施时先 grep 引用关系再判删**。

### 2.2 修改（4 个核心文件）

| 文件 | 行数 | 改动要点 |
|---|---|---|
| `app/server/src/agent/run-react-loop.ts` | 231 → 估 ~280 | **内联 contextEngine 调用 + 直调 base.callLLM**：① 删 `spec.context.prepare/recordAssistant/recordToolResults` 调用，改 `contextEngine.ingest/assemble(scopeId, state.buffer)` + `drainMode === 'eager'` 分支（三态枚举 eager/none/lazy，lazy 占位 future 不实现）+ drain helper；② 删 `spec.wireCallLLM` 调用，改直调 `base.callLLM(...)`（参数从 RunSpec 字段透传）；③ tryCompact 在骨架统一调（删 ContextPort 包装后不再下沉 recordAssistant）；④ emit message_end / emitMessageStart 等内联到骨架对应段；⑤ LifecyclePort 调用保留（含 onInterrupted，D7 已并 FinalizePort）。**若超 300 行则抽 drain/llm-stage/compact-stage helper 到子文件** |
| `app/server/src/agent/loop-ports.ts` | 255 → 估 ~180 | **删 ContextPort + CallLLMHook + FinalizePort 契约**：删 `interface ContextPort` 整章；删 `interface FinalizePort` 整章（D7 并入 LifecyclePort，`onInterrupted` 成为 LifecyclePort 方法）；删 `CanonicalLLMMessages` / `NO_NEW` 哨兵（若改用 snapshot null 判定则不需要哨兵）；删 `CallLLMHook` / `wireCallLLM` / `wireInitState` 类型；保留 `LoopState` / `LifecyclePort`（含 onUsage/onRunEnd/onInterrupted 三 hook）/ `RunSpec` / `RunResult`；RunSpec 加 `backgroundPath` / `drainMode`（替代 `drainOptions`，三态枚举）/ `stopSequences` / `eosStripper` / `compactNoticeEmitter` / `pluginManager` 字段 |
| `app/server/src/agent/build-deps.ts` | 259 → 估 ~280 | **装配 main RunSpec**：删 `MainContextPort` 实例化；删 `MainFinalizePort` 实例化（D7：`onInterrupted` 内联到 `MainLifecyclePort`，main = noop 由 abort api 4 步接管）；filterToolDefinitionsBySessionType 在装配阶段调（一次性）→ `spec.toolDefinitions`；EOS stop seq 注入 → `spec.stopSequences = sessionType==='squad' ? [EOS_STOP_TOKEN] : undefined`；`spec.eosStripper = sessionType==='squad' ? stripEosToken : undefined`；构造 `MainLifecyclePort`（含 onUsage/onRunEnd/onInterrupted 三 hook，onInterrupted=noop）；`spec.drainMode = 'eager'`；`spec.backgroundPath = false`；`spec.wireStore`/`wireInbox`/`wireStateMachine` 透传 |
| `app/server/src/agent/build-forked-deps.ts` | 260 → 估 ~280 | **装配 forked RunSpec**：删 `ForkedContextPort` 实例化；删 `ForkedFinalizePort` 实例化（D7：`onInterrupted` 内联到 `ForkedLifecyclePort`，forked = noop buffer 随 GC）；新建 `buffer = [snap.system, ...snap.messages, userMessage]` 注入 RunState；`spec.drainMode = 'none'`；`spec.backgroundPath = true`；`spec.stopSequences = undefined`；`spec.eosStripper = undefined`；构造 `ForkedLifecyclePort`（含 onUsage/onRunEnd/onInterrupted 三 hook：onUsage→accumulateUsage('forked') / onRunEnd=noop / onInterrupted=noop）；`spec.pluginManager` 透传（让 tryCompact 在 forked scope 显式调 reject_should_compact） |
| `app/server/src/agent/context-engine.ts` | ~250 → 估 ~245 | **D15 删 if 硬尾 + IngestCtx 加 store**：删 `if (scopeId !== FORKED_SCOPE_ID) store.appendMessages(...)` 硬尾（line 187-190）；`IngestCtx` 加 `store?: SessionStore` 字段；default scope ingest 时注入 `wireStore` 到 `ctx.store`（forked 不注入）；chain 尾 `store_sink` impl 读 `ctx.store` 写 store（替代 if 硬尾）；contextEngine.ingest 只跑 chain，sink 完全由 chain 配置决定 |

### 2.3 小改（1 个文件 + spec 文档）

| 文件 | 改动 |
|---|---|
| `app/server/src/agent/forked-scope-bootstrap.ts` | **D14 小写 + D15 disable store_sink**：`FORKED_SCOPE_NAME = 'Forked'` → `'forked'`；🆕 v0.0.49 加 `disableImplInForked('context_ingest_handler', 'store_sink')`（forked 不写 store，chain 尾是 `buffer_sink`；删 context-engine if 硬尾后**必须显式 disable**，否则 `store_sink` 会被 chain 选中误写 store）；可选追加 4 个 `disableImplInForked('context_assemble_reducer', ...)` 关清理 reducer（详见 design_context_ext.md §5.3）|
| `app/server/src/agent/agent-loop-stage-llm.ts` | 检查：EOS_STOP_TOKEN / stripEosToken export 是否被 build-deps.ts 引用（迁过去）；本文件可保留作为 EOS 工具函数 host，或迁 EOS 到 squad-specific 文件 |
| `app/server/src/agent/agent-manager.ts` | 检查：buildMainDeps / buildForkedDeps 调用签名是否需调整（line 247）；activate 流程本身不动 |
| `app/server/src/agent/__tests__/*.test.ts` | UT 更新：forked-agent.test.ts 删 ForkedContextPort 断言；context-engine-forked-scope.test.ts 加 buffer_sink/reader 调用断言 + store_sink 在 forked 不被调断言 + store_sink 在 default 被调断言；try-compact.test.ts 保留 |

### 2.4 新增（v0.0.49 — 1 个 impl 新文件 + scope 配置改动）

| 文件/配置 | 行数估 | 内容 |
|---|---|---|
| `app/plugins/builtins/rocky_context/ingest/store_sink.ts` | ~40 | **D15 store_sink impl**（EP=`context_ingest_handler`，default 专属 sink，对齐 `buffer_sink` 的 forked 专属语义）；契约 `handle(messages, ctx): messages`（`ctx.store` 非空 → `ctx.store.appendMessages(ctx.config.sessionId, messages)`；`ctx.store` 空 → no-op 返回 messages 防御性 fallback）；plugin.json P0 标 enabled=true 或 ensureDefaultScope 显式 activate |

> **scope 配置改动**（属 `ensureForkedScope` / `ensureDefaultScope` / plugin.json，非新文件）：
> - `ensureForkedScope`：加 `disableImplInForked('context_ingest_handler', 'store_sink')`（forked 不写 store，chain 尾是 `buffer_sink`）
> - `ensureDefaultScope`（或 plugin.json P0）：activate `store_sink`（default chain 尾必须有 sink impl 写 store，删 context-engine if 硬尾后由 scope 配置选中）
> - `plugin.json`（rocky_context）：register `store_sink` impl（EP=`context_ingest_handler`，P0 enabled=true）

### 2.5 保留不动（核心机制层）

| 文件 | 行数 | 保留理由 |
|---|---|---|
| `app/server/src/agent/context-ingest-pipeline.ts` | - | ctx.buffer 注入已实现（v0.0.49 加 ctx.store 注入对齐机制）|
| `app/server/src/agent/assemble-pipeline.ts` | - | ctx.buffer 注入已实现 |
| `app/server/src/agent/agent-loop-base.ts` | - | base.callLLM / executeTools 原语保留 |
| `app/server/src/agent/try-compact.ts` | 49 | 胶水函数保留，骨架统一调 |
| `app/server/src/agent/compact-types.ts` | - | CompactCtx 类型保留 |
| `app/server/src/agent/agent-scope-router.ts` | - | scopeId 路由不变 |
| `app/server/src/agent/agent-loop-stage-tool.ts` | - | executeAndEmit 保留 |
| `app/server/src/agent/agent-loop-helpers.ts` / `agent-loop-lifecycle.ts` / `agent-loop-emitters.ts` / `agent-loop-observability.ts` | - | helper 保留 |
| `app/plugins/builtins/rocky_context/ingest/buffer_sink.ts` | 41 | ext impl 保留 |
| `app/plugins/builtins/rocky_context/assemble/buffer_reader.ts` | 39 | ext impl 保留 |
| `app/plugins/builtins/rocky_context/assemble/append_passthrough.ts` | 49 | ext impl 保留 |
| `app/plugins/builtins/rocky_context/compact/*.ts`（threshold/reject/summary/noop） | - | compact impl 保留 |

---

## 3. 不变量守护（逐条 → 新骨架如何保证）

### 3.1 append-only 保缓存（forked）

| 守护点 | 保证机制 |
|---|---|
| buffer 前缀（[system, ...snapshot.messages, userMessage]）整个 run 不变 | `buildForkedDeps` 装配时构建一次，RunState.buffer 持引用；骨架每轮 `contextEngine.ingest(scopeId='forked', buffer)` 经 `buffer_sink` **只在尾部 push**（in-place mutate，前缀不动） |
| 严禁 rebuild / head-tail / compact | forked scope `base_builder` disabled → `append_passthrough` reducer 原样返回 data.transcript；`should_compact` 选 reject（恒 false）→ tryCompact 跳过 |
| toolDefinitions 整个 run 不变 | RunSpec 不可变字段；骨架每轮 LLM 调用从 spec 取（不重算）；caller 不传变体 |

### 3.2 绝不 compact（forked）

| 守护点 | 保证机制 |
|---|---|
| tryCompact 谓词返 false | `reject_should_compact.check(ctx)` 恒 false → tryCompact return（design_context_ext.md §3.3）|
| 即便误调 doCompact | noop_do_compact 防御（空操作）|
| 即便谓词被绕过 | forked scope `summary_do_compact` 未 setExclusive（仅 noop 被选）→ getExtensionImpls 返 noop |

**双重保证**：骨架统一调 tryCompact（D11）+ scope 配置（reject/noop）。结构上不可能递归 compact。

### 3.3 无 store transcript（forked）

| 守护点 | 保证机制 |
|---|---|
| 不写 store.appendMessages | D15 后：forked scope `store_sink` impl **disabled**（`ensureForkedScope` 显式 disable，**非代码 if 硬尾**）→ ingest chain 不含 `store_sink` → chain 尾是 `buffer_sink` 写 buffer；contextEngine.ingest 只跑 chain（已删 `if scopeId !== FORKED` 硬尾）|
| 不读 transcript_reader | forked scope `transcript_reader` disabled；buffer_reader 替代 |
| 不读 store.getSummary | `context-engine.assemble(scopeId='forked')` 分支跳过（spec §3 已注释：forked buffer 自带完整上下文）|

### 3.4 无持久化（forked）

| 守护点 | 保证机制 |
|---|---|
| 不 persistRun | `spec.wireStore = undefined` → 骨架 `if (spec.wireStore)` 跳过 ensureRunCreated |
| 不碰五态机 | `spec.wireStateMachine = undefined` + ForkedLifecyclePort.onRunEnd = noop |
| 不消费 inbox | `spec.drainMode = 'none'` → 骨架 ① drain 段跳过（drainMode 三态：main='eager' / forked='none' / 'lazy' 占位 future 不实现）|
| buffer 随 run GC | `wireInitState` 设 RunState.buffer；run 结束 RunState 销毁 → buffer 引用断开 → GC |

### 3.5 onUsage forked 分区保留（D13）

| 守护点 | 保证机制 |
|---|---|
| type='forked' 隔离 | `ForkedLifecyclePort.onUsage(usage)` → `store.accumulateUsage(sid, 'forked', usage)`；与 main 'current' 类型隔离（互不污染）|
| notifyUsageChanged 链式上报 | v0.0.44 write/notify 分离保留：accumulateUsage 返 sid 链 → 逐链 notify（parent session 也收到）|
| 默认不累计 | `usagePartition` option 未开时 onUsage noop（spec §7 默认关；opts.usagePartition='forked' 才开）|

### 3.6 main 行为零回归（守护）

| 守护点 | 保证机制 |
|---|---|
| default scope impl 链不变 | `ensureForkedScope` 只动 forked scope；default scope config 不变 |
| store 游标准入 | RunState.ingestUpTo/llmUpTo 字段保留；骨架 `drainMode === 'eager'` 分支调原 drain + ingest + assemble + 准入判定逻辑 |
| tryCompact 在 main 触发 | default scope `threshold_should_compact` + `summary_do_compact` 选中 → 谓词返 true 时 action.run → forkedRun(summary) → setSummary → re-assemble |

---

## 4. 风险 + 测试策略

### 4.1 风险点

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 骨架内联 contextEngine 调用导致行数超 300 | 抽 helper 到子文件（drain-stage.ts / llm-stage.ts / compact-stage.ts），保持 run-react-loop.ts ≤300 行 |
| R2 | main EOS 路径回归（squad session）| 装配阶段 stopSequences/eosStripper 透传到 spec；UT case：squad session 主对话 EOS 注入 + strip 验证 |
| R3 | forked compact 防递归破坏（骨架统一调 tryCompact 后）| scope 配置 reject/noop 显式选中（不靠 zero-active）+ AT case：forked summary run 后再确认 store.summary 未二次 compact |
| R4 | filterToolDefinitions 装配阶段执行 vs callLLM 包装层执行的时机差异 | 装配时一次性过滤存 spec.toolDefinitions（整个 run 不变）—— 实际更符合缓存契约（运行中不变）；行为等价（包装层也是首次调用就过滤后不变）|
| R5 | Langfuse observability port 构造迁移（callLLMForXxx 删除后）| 骨架 §2 LLM 段内联 `createLangfuseObservabilityPort({ adapter, genHandle, iteration, step })`；与原行为 1:1 |
| R6 | buffer_sink/reader 在 default scope 误激活（防御性）| impl 内已防御（ctx.buffer 空 → no-op）；UT case：default scope run 不调 buffer_sink（断言 buffer 字段为空 / sink handler 未被触发的 spy）|

### 4.2 UT 策略（白盒，骨架）

| Case | 路径 | 断言 |
|---|---|---|
| UT-M1 | main 多轮 + drain | 每轮 ingest/assemble 调用次数 + 游标推进 llmUpTo ≤ ingestUpTo + persistRun 在 onRunEnd 调用 |
| UT-M2 | main compact 触发 | tryCompact 谓词返 true 后 summary_do_compact action 调用 + re-assemble + summary version 增长 |
| UT-M3 | main 中断 | controller.aborted 置位后骨架 break + LifecyclePort.onInterrupted 是 noop（D7 并入后是 LifecyclePort 方法；abort api 4 步接管）|
| UT-M4（v0.0.49 新增）| main run 落 store（store_sink 生效）| default scope run 后 `store_sink.handle` 被调（spy）+ store transcript 增长（messages 写入）+ chain 尾是 `store_sink`（不是 `buffer_sink`）+ `ctx.store` 注入 wireStore |
| UT-F1 | forked 单轮 summary | buffer_sink/reader/append_passthrough 被调（spy 验证）+ store transcript 未增长 + RunState.buffer 头部是 snapshot.system |
| UT-F2 | forked tryCompact 跳过 | reject_should_compact.check 返 false → summary_do_compact **未**被调 |
| UT-F3 | forked 中断 | buffer 引用在 onInterrupted 后断开 + store 未污染 |
| UT-F4（v0.0.49 新增）| forked run store_sink 不被调 | forked scope run 后 `store_sink.handle` **未**被调（chain 不含；`ensureForkedScope` disable 生效）+ `buffer_sink.handle` 被调 + `ctx.store` 未注入 |
| UT-S | 骨架无 if main/forked 分支 | grep run-react-loop.ts 不含 `if.*main` / `if.*forked` 字面字符串（除非 spec 字段名）；grep context-engine.ts 不含 `if.*scopeId.*FORKED` 硬尾分支（D15 已删）|
| UT-EXT | buffer_sink/reader/store_sink impl 单测 | buffer_* 已存在（assemble-reducers.test.ts 等）保留；🆕 store_sink 单测 v0.0.49 新增（ctx.store 注入写 / 空 no-op fallback）|

### 4.3 AT 策略（黑盒，真 LLM）

| Case | 路径 | 断言 |
|---|---|---|
| AT-M1 | 主对话多轮 + 工具 | 真 LLM 回复 + 工具执行 + 多轮后 store transcript 增长（`store_sink` 生效）+ accumulateUsage('current') |
| AT-M2 | 主对话触发 compact | 多轮堆积超阈值 → compact 触发 → forkedRun(summary) 起 → setSummary → summary version 增长；GET /messages 返回含 compacted 视图 |
| AT-M3（v0.0.49 新增）| default run 后 store transcript 增长（store_sink 生效）| 主对话发消息 → `store_sink` 写 store → GET /messages 返回新增 assistant/user 消息（store 落库验证 `store_sink` impl 被调，非 if 硬尾）|
| AT-F1 | forked summary 全链路（手动触发 compact 后）| buffer_sink/reader/append_passthrough 在真实 run 中被调（plugin trace / log 验证）+ forked scope 路由正确 + 父 session transcript 未污染（`store_sink` disabled 验证：forked run 后父 session transcript 不增长）|
| AT-X1 | 防递归 | compact 触发的 summary run **不**再触发 compact（reject_should_compact 拦截）|

> AT 必须真 LLM + 真服务（按 memory：[no-mock-api-e2e-tests]、[test-mock-llm-default-on] → ROCKY_TEST_MOCK_LLM=0 显式设置）。断言通过 GET /messages + langfuse oracle（按 [at-case-oracle-not-sse]）。

### 4.4 回归门槛

- main 行为零回归（AT-M1 + AT-M2 全绿）
- forked ext impl 首次被骨架真正调用（UT-F1 + AT-F1 全绿 — 这是 v0.0.49 主要修复证据）
- 不变量守护（§3 全部 UT case 通过）
- spec 与代码对齐（doc-modifier 同步 specs 后无 spec/代码冲突）
