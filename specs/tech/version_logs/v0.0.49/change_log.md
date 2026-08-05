# v0.0.49 Tech Change Log — Remove ContextPort + callLLMForXxx，骨架直调 contextEngine + base.callLLM + store_sink EP 化

> version: 1.0 · 2026-07-02
> 范围：内部重构（无新 API / 无 UI 变更）。删 ContextPort（MainContextPort / ForkedContextPort）+ callLLMForMain / callLLMForForked 中间层，骨架 `runReActLoop` 直调 `contextEngine.ingest/assemble(scopeId, buffer)` 与 `base.callLLM`；default sink EP 化（`store_sink` impl，D15）让 default/forked sink 对称（chain 尾二选一，由 scope 配置选）；Forked→forked 小写；FinalizePort 并入 LifecyclePort（D7，三 hook onUsage/onRunEnd/onInterrupted）；并进 v0.0.52 三项 base_builder 优化（P0-1 assemble prevSnapshot / P2-3 ratio 动态化 / P1-2 ingestAndAssemble scopeId）。
> 权威方案：`specs/tech/version_logs/v0.0.49/design.md`（决策摘要 + 骨架伪代码 + main/forked 4 维差异表 + 文件三态分类）+ `design_context_ext.md`（forked ext impl 对接 + scope 配置）+ `design_refactor_manifest.md`（spec/impl 改动清单 + 不变量守护 + 风险/测试）。
> 验证：UT 全量 + AT 真 LLM 2/2 pass（主对话多轮+compact 触发；forked summary 全链路验证 buffer_sink/reader/append_passthrough 首次被骨架激活）。

---

## 1. 改动摘要

### 1.1 删除（4 个文件 — 中间层整删，spec↔代码偏差根源）

| 文件 | 内容 | 替代 |
|---|---|---|
| `app/server/src/agent/context-port.ts` | `MainContextPort` / `MainLifecyclePort` / `MainFinalizePort` | 骨架直调 contextEngine.ingest/assemble；lifecycle/finalize 装入 MainLifecyclePort |
| `app/server/src/agent/forked-context-port.ts` | `ForkedContextPort`（直接 buffer.push 绕过 contextEngine 的死代码——v0.0.49 主要修复点）/ ForkedLifecyclePort / ForkedFinalizePort | 骨架统一调 contextEngine.ingest；forked recordAssistant 改 chain 尾 buffer_sink impl 写 buffer |
| `app/server/src/agent/agent-loop-call-main.ts` | `callLLMForMain`（EOS + filterToolDefinitions + langfuse + obs 包装） | EOS/filterToolDefinitions 迁 build-deps.ts 装配阶段（spec.toolDefinitions / spec.stopSequences 一次性定）；骨架直调 base.callLLM |
| `app/server/src/agent/agent-loop-call-forked.ts` | `callLLMForForked`（langfuse + obs + backgroundPath=true 包装） | backgroundPath 改 RunSpec 字段透传；langfuse+obs 内联骨架 §2 LLM 段 |

### 1.2 新增（1 个 impl 文件 — D15 default sink EP 化）

| 文件 | 内容 |
|---|---|
| `app/plugins/builtins/rocky_context/ingest/store_sink.ts` | D15 store_sink impl（EP=`context_ingest_handler`，default 专属 sink，对齐 forked `buffer_sink`）；`handle` 读 `ctx.store.appendMessages(sessionId, messages)` 写 store（async）；`ctx.store` 空 → no-op 防御性 fallback |

### 1.3 修改（5 个核心文件）

| 文件 | 改动要点 |
|---|---|
| `app/server/src/agent/run-react-loop.ts` | 内联 contextEngine 调用 + 直调 base.callLLM；drainMode='eager'/'none'/'lazy' 三态分支；tryCompact 骨架统一调（无 if main/forked）；emit/run_start/run_end 内联；LifecyclePort 含 onInterrupted |
| `app/server/src/agent/loop-ports.ts` | 删 ContextPort + FinalizePort + CallLLMHook + wireCallLLM + NO_NEW 契约；RunSpec 加 scopeId/drainMode(三态)/backgroundPath/stopSequences/eosStripper/compactNoticeEmitter/pluginManager 字段；LifecyclePort 加 onInterrupted |
| `app/server/src/agent/build-deps.ts` | 装配 main RunSpec：filterToolDefinitionsBySessionType 一次性过滤；EOS 注入 spec.stopSequences/eosStripper（squad session）；drainMode='eager'；backgroundPath=false；MainLifecyclePort（三 hook） |
| `app/server/src/agent/build-forked-deps.ts` | 装配 forked RunSpec：RunState.buffer 新建（持引用）；drainMode='none'；backgroundPath=true；stopSequences/eosStripper=undefined；ForkedLifecyclePort（onUsage→accumulate('forked') / onRunEnd=noop / onInterrupted=noop） |
| `app/server/src/agent/context-engine.ts` | D15 删 `if (scopeId !== FORKED) store.appendMessages` 硬尾（line 187-190）；`ingest` 注入 `ctx.store`（default 注入 wireStore / forked undefined）；sink 完全由 chain 配置决定 |

### 1.4 小改

| 文件 | 改动 |
|---|---|
| `forked-scope-bootstrap.ts` | D14 `FORKED_SCOPE_NAME = 'Forked'` → `'forked'`（小写）；D15 加 `disableImplInForked('context_ingest_handler', 'store_sink')`；可选精简：关 4 清理 reducer（orphan/empty/role_merge/snip） |
| `plugin.json`（rocky_context） | 注册 `store_sink` impl（EP=`context_ingest_handler`，P0 enabled=true） |
| `loop-stage-context.ts` / `loop-stage-llm.ts` | 骨架 helper：传 state.snapshot 作 prevSnapshot（P0-1）；ingestAndAssemble 加 scopeId 参数（P1-2） |
| `base_builder.ts`（assemble impl） | P2-3 ratio 动态化：从 ctx.ratio 拿（与 computeContextWindowUsage 同源 store.getRatio），fallback 1.0 |

### 1.5 并进 v0.0.52（task4）

| 项 | 描述 |
|---|---|
| **P0-1** assemble prevSnapshot | main 路径传 `state.snapshot` → base_builder append 分支激活（messages 引用稳定，prompt cache 前缀命中）。v0.0.40-0.0.51 期间骨架未透传 prevSnapshot → append 分支死代码，每次 rebuild（cache 失效）。 |
| **P2-3** base_builder ratio 动态化 | `ctx.ratio` 透传（与 computeContextWindowUsage 同源 `store.getRatio`，per-session 学习窗口），冷启动 fallback 1.0；v0.0.40-0.0.51 base_builder 内部硬编码 `RATIO = 1.0` 常量（与 usage 估算不同源），现已动态化。 |
| **P1-2** ingestAndAssemble scopeId | 修旧 helper 残留：加 scopeId 参数（路由 contextEngine impl 链），与骨架一致。 |

---

## 2. 不变量守护（v0.0.49 后如何保证）

| 不变量 | 保证机制 |
|---|---|
| append-only 保缓存（forked） | `buffer_sink` 在 chain 尾 push（前缀不动）；`append_passthrough` 原样返回 buffer；骨架不改 buffer 前缀 |
| 绝不 compact（forked） | tryCompact 骨架统一调；forked scope `reject_should_compact` 恒 false → 谓词检查处 return；noop_do_compact defense-in-depth |
| 无 store transcript（forked） | forked scope `store_sink` disabled（`ensureForkedScope` 显式 disable）+ ingest 不注入 ctx.store；contextEngine 已删 if 硬尾（D15） |
| 无持久化（forked） | `wireStore` 不设；LifecyclePort.onRunEnd=noop；onInterrupted=noop |
| onUsage forked 分区 | ForkedLifecyclePort.onUsage → accumulateUsage(sid, "forked", u)（type 隔离，不污染 current） |
| 骨架无 if main/forked 字面分支 | UT-S grep 守护；差异全在 RunSpec 字段（scopeId/buffer/drainMode/backgroundPath/stop/eosStripper/compactNoticeEmitter + LifecyclePort impl + emit） |

---

## 3. spec↔代码一致性结论（doc-modifier 核对项）

| 项 | spec 旧描述 | 代码现实 | 处理 |
|---|---|---|---|
| forked 走 contextEngine impl 链 | spec `context_engine.md §3.6 D1=B` 已声明 forked 也走 `contextEngine.ingest/assemble('forked', buffer)` | v0.0.40-0.0.48 ForkedContextPort 直接 `buffer.push()` 绕过（死代码）；v0.0.49 修复骨架真调 impl 链 | spec §3.6 加 v0.0.49 修复注；§4 交互图改骨架直调；index/forked spec 加注 |
| store_sink EP 化（D15） | spec 旧描述「context-engine.ts:187 if scopeId 硬尾」 | 代码已删 if 硬尾，sink 由 chain 配置（default=`store_sink` / forked=`buffer_sink`） | context_engine/extension/ingest_detail spec 更新；新增 store_sink impl 描述 |
| assemble prevSnapshot（P0-1） | spec §2 append 分支「summary version 不变 → 复用 prev.messages 追加」 | 代码 v0.0.40-0.0.51 未透传 prevSnapshot → append 死代码；v0.0.49（并进 v0.0.52 P0-1）激活 | assemble_detail §2 加 v0.0.52 P0-1 激活注 |
| ratio 动态化（P2-3） | spec §6 base_builder 默认配置 | 代码 v0.0.40-0.0.51 base_builder 硬编码 RATIO=1.0；现已 ctx.ratio 动态 | assemble_detail §6 加 v0.0.52 P2-3 注 |
| 删 ContextPort/callLLMForXxx/FinalizePort | spec 多处引用 ContextPort.prepare/recordAssistant/recordToolResults + FinalizePort + callLLMForXxx 包装 | 代码已删 4 文件 + FinalizePort 并入 LifecyclePort | unified/forked/eager_drain/base/interface/scope_router/index spec 全更新 |

**结论**：spec 与代码已对齐，无残留过时描述。

---

## 4. 受影响 spec 文件清单

### tech（OKF KB：index.md/log.md/frontmatter + 单文件章节）

- `specs/tech/agent/context/index.md`（④核心设计原则 + 概念表 更新）
- `specs/tech/agent/context/[P0]context_engine.md`（§3 ingest/assemble 签名 + §3.5 链表 + §3.6 D1=B/D15 + §4 交互图 重写）
- `specs/tech/agent/context/[P0]extension point and implementations.md`（§1 概述计数 37→38 + §3.1 加 store_sink + §5 manifest 示例 + scope 配置注）
- `specs/tech/agent/context/[P0]context_ingest_detail.md`（§1 概述 + §2 设计 + §3 IngestCtx.store 字段 + handler 表加 store_sink/buffer_sink + §5 sink 终点）
- `specs/tech/agent/context/[P0]context_assemble_detail.md`（§2 增量构建 P0-1 注 + §6 base_builder ratio P2-3 注）
- `specs/tech/agent/context/[P0]context_compact_detail.md`（§1 边界 + §2c tryCompact 调用点改骨架统一调）
- `specs/tech/agent/context/log.md`（加 v0.0.49 条目）
- `specs/tech/agent/agent_interface_and_loop/index.md`（概念表 + 导航行 更新）
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md`（§1/§2/§3/§4/§5/§6 全面更新——4 port 收缩为 3 port + 骨架直调）
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_forked.md`（前言注 + §4 消息驱动重写 + §7 副作用 + §9 中断）
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md`（§6 循环结构重写）
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md`（§2 加注骨架直调）
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_interface.md`（§2 RunSpec 字段更新 + 删 context/finalize port + modeKey/scopeId 描述）
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_scope_router.md`（调用点 + modeKey 描述）
- `specs/tech/agent/agent_interface_and_loop/log.md`（加 v0.0.49 条目）
- `specs/tech/version_logs/v0.0.49/design.md` / `design_context_ext.md` / `design_refactor_manifest.md`（status draft→done）
- `specs/tech/version_logs/v0.0.49/change_log.md`（本文档，新建）

### prd / api / ui

- **无变更**：v0.0.49 是内部重构（无新 API、无 UI 变更、跳过独立 PRD）。api/ ui/ prd/ overall 文档核对无 ContextPort 类引用残留（若有则修正，实际无）。

---

## 5. 验证记录

- UT 全量绿（含 UT-M1/M2/M3/M4 store_sink 在 default 被调 + UT-F1/F2/F3/F4 forked buffer_sink/reader/append_passthrough 被骨架激活 + UT-S 骨架无 if main/forked 字面分支）
- AT 真 LLM 2/2 pass：AT-M1（主对话多轮+工具+compact 触发，store transcript 增长验证 store_sink 生效）+ AT-F1（forked summary 全链路，buffer_sink/reader/append_passthrough 首次被骨架激活，父 session transcript 未污染验证 store_sink 在 forked disabled）
- 防递归（AT-X1）：compact 触发的 summary run 不再触发 compact（reject_should_compact 拦截）

详见 `states/v0.0.49.forked_agent/verify/`。
