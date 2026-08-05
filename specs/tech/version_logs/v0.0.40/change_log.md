# v0.0.40 Tech Change Log — Agent Loop 统一重构（单 run 契约 + 统一骨架 + 4 port + scope 路由 + compact plugin 化）

> version: 1.0 · 2026-07-01
> 范围：agent loop 协议瘦身 + eager/forked 双 loop 合一 + emitter/context 经策略与 plugin scope 控制。**纯后端重构，无对外 API/UI 契约变更**（`run` 是内部协议，非 HTTP API）。
> 权威方案：`reqs/v0.0.40.loop_opt.panding/change-plan.md`（D1-D5 决策）。
> 验证：UT 3589 + 真 LLM AT 4/4 + ET 功能 PASS。

---

## 1. 改动摘要

### 1.1 协议瘦身（D2）

`Agent` 只剩 `run(spec, loop) → AgentRun`（两参——spec + LoopHandle）。删除 `enqueue/cancel/activate`（死桩）+ `EagerDrainAgent` 整类 + `agentByMode(loopMode)` 路由 + `LazyDrainAgent`（spec future，无代码）。`RunSpec` = 身份 + 4 注入 port（context/emit/lifecycle/finalize）+ toolDefinitions/allowedTools/maxIter/scopeId/controller/modeKey。

> **`run` 两参说明**：早期草案写 `run(spec)` 单参；实现落地为 `run(spec, loop)`——`loop` 句柄由 `buildMainDeps`/`buildForkedDeps` 装配产出（与 spec 同源），`manager.run` 注册三 map（agentRuns/abortControllers/loops）后 `void loop.start()` 异步启 `runReActLoop`。`activate`/`forkedRun` wrapper 内部调 buildDeps 拿 `{ spec, loop }` 再调 `run(spec, loop)`；五态机 CAS / 并发检查 / agentToolContext 注入全留在 wrapper。

### 1.2 统一骨架 + 4 port（D5 一把梭哈）

新建 `agent_loop_unified.md`：eager/forked 共用一份 `runReActLoop(spec)` 骨架，mode 差异全部下沉为 4 个注入 port：

| Port | current（`buildMainDeps`） | forked（`buildForkedDeps`） |
|---|---|---|
| context | store-backed：drain inbox + ingest + assemble + tryCompact | buffer-backed：buffer push（`buffer_reader`/`append_passthrough`/`buffer_sink`） |
| emit | bus→`session_id:<sid>_amt:current` | bus→`session_id:<sid>_amt:<modeKey>` 或 noop |
| lifecycle | persistRun + markIdle/markError(CAS) + accumulateUsage("current") | noop + accumulateUsage("forked")/noop |
| finalize | noop（abort api 4 步接管） | 丢弃 buffer |

`AgentLoop` / `ForkedLoop` 类的 `while` 编排**退役**——逻辑迁入 deps 装配。forked 改走 `executeAndEmit`（补既有 tool_result emit + obs span gap，memory_extract 据此可用）。compact 判定从 loop 骨架下沉到 current `ContextPort.recordAssistant` 的 `tryCompact` 胶水（loop 骨架对 compact 零感知）。

### 1.3 AgentScopeRouter（D4）

新建 `agent_scope_router.md`：`AgentScopeRouter.resolve(modeKey, session) → scopeId`。4 维输入拆解（RunKind/Biz/Role/Derivation，拆 sessionType 重载）。

**Min 方案（本版本落）**：current → 恒 `default`（`CURRENT_SCOPE_ID`）；**所有非 current → 单一 `forked` scope**（`FORKED_SCOPE_ID='forked'`，非 modeKey 原样回传——summary/memory_extract 共享同一套 forked context 配置）。squad/leader/mate/subagent 不作 scopeId 返回（差异保留 intra-impl：`readSessionType(ctx)` 在各 impl 内部分支）。Granular 方案（~5 scope）留 future，router 4 维签名已为它预留（加 role→scope map 即可，签名不变）。

### 1.4 compact 触发 plugin 化（D3）

新增 2 个 **exclusive** context EP（首批 exclusive context EP，既有 6 个全是 ordered）：

| EP | cardinality | 默认 impl | 行为 |
|---|---|---|---|
| `context_should_compact` | exclusive | `threshold_should_compact` | 谓词：`(totalTokens+maxOutputTokens)/tokenLimit > compactRatio`（默认 0.6，分母含 maxOutputTokens，提前压而非撞墙压） |
| `context_do_compact` | exclusive | `summary_do_compact` | 动作：`forkedRun(summary, NO_TOOLS, maxIter=1)` → extractTag → setSummary（搬现状逻辑） |

`tryCompact(ctx)` 固定胶水在 current `ContextPort.recordAssistant`（ingest+assemble 后调 `if(await should) await do`）。

**防递归不变量**：forked scope 不激活 `context_should_compact`（exclusive EP 无 active impl）→ `getExtensionImpls` 返空 → tryCompact 兜底跳过 → summary run 结构上不可能 compact（用 scope 隔离天然防递归，不靠运行时标志位）。

### 1.5 context 源/汇可注入（D1=B）

`ContextEngine.ingest/assemble` 加 `scopeId` 入参（透传到 `getExtensionImpls(point, scopeId)` 双参重载）+ `buffer?` 显式入参（forked 透传给 buffer_sink/buffer_reader）。

- **default（current）**：store 硬尾（`store.appendMessages`，行为不变）；读 store transcript + summary；写 session meta。
- **forked**：`buffer_sink` 写 buffer / `buffer_reader` 读 buffer；**跳过 store 硬尾**（异步 store 写不进 forked 同步 handler 链 + 旁路无污染）；不读 store summary（buffer 自带完整上下文）；不写 session meta（不污染主对话 contextWindowUsage）。

新增 3 个 forked 专属 impl 到 `rocky_context` manifest：`buffer_reader`(mapper) / `append_passthrough`(reducer 不 rebuild 保 cache 前缀) / `buffer_sink`(ingest 尾写 buffer)。default scope disable 它们。forked scope 由 bootstrap `ensureForked` 预建。

---

## 2. impl 清单变更（context EP）

| 维度 | v0.0.39 | v0.0.40 |
|---|---|---|
| context EP 数 | 6（全 ordered） | **8**（6 ordered + 2 exclusive compact） |
| `rocky_context` impl 数 | 33 | **35**（26 通用基线 + 2 compact + 7 squad-scoped） |
| 新增 EP | — | `context_should_compact` / `context_do_compact`（均 group=context, cardinality=exclusive） |
| 新增 impl | — | `threshold_should_compact` / `summary_do_compact` / `buffer_reader` / `append_passthrough` / `buffer_sink` |

> scope 实体：`default`（current 基线，无需建）+ `forked`（bootstrap ensureForked 预建：enable forked 3 impl + disable transcript_reader/base_builder/system_reminder_injector + 不激活 shouldCompact）。

---

## 3. 关键设计原则（本次新增，落各 KB index §④）

1. **单 run 契约 + 统一骨架**——`Agent` 只剩 `run(spec, loop)`；eager/forked 共用 `runReActLoop(spec)`，mode 差异全在 4 port。
2. **modeKey ≠ scopeId**——modeKey=run 种类（调用方意图定，决定 ContextPort 变体）；scopeId=context impl 链选择（`AgentScopeRouter.resolve` 路由）。forked scopeId 由 modeKey 固定（→`forked`）；current scopeId 恒 `default`（Min 方案）。
3. **compact 判定在 ContextPort.recordAssistant 非骨架**——loop 骨架对 compact 零感知；tryCompact 胶水 + 2 exclusive EP 承担判定 + 动作。
4. **compact 防递归靠 scope 隔离**——forked scope 不激活 shouldCompact EP → 结构上不可能递归 compact。
5. **forked append-only 保缓存禁 rebuild/compact**——`buildForkedDeps.context` 的 reducer 必须是 `append_passthrough`（原样返回，不 rebuild/head-tail/compact），保 prompt cache 前缀。

---

## 4. 风险与回归要点

- **prompt cache**：forked `toolDefinitions` 固定、messages 仅追加——严禁 ContextPort 改 forked 前缀（无 compact、无 rebuild）。
- **中断语义**：current 中断**不收尾**（abort api 4 步）；`FinalizePort.onInterrupted` 对 current 必须 noop。
- **五态机 CAS**：markRunning 在 manager.activate 入口，markIdle/markError 在 `lifecycle.onRunEnd`——保持 current 专属，forked 不碰 session state。
- **secret**：dev plugin_policy 里有真实 provider key，scope 改造勿把 configValues 误带进日志/快照。

---

## 5. 涉及代码（app/server/src/agent/）

| 文件 | 行数 | 角色 |
|---|---|---|
| `agent-interface.ts` | 194 | Agent 契约 + AgentRun + AbortControllerHandle |
| `run-react-loop.ts` | 231 | 统一 `runReActLoop(spec)` 骨架 |
| `loop-ports.ts` | 255 | 4 port 契约 + RunSpec + LoopState + NO_NEW |
| `context-port.ts` | 211 | MainContextPort（current，含 tryCompact 胶水） |
| `build-deps.ts` | 259 | `buildMainDeps`（current deps 装配） |
| `try-compact.ts` | 49 | tryCompact 固定胶水 |
| `compact-types.ts` | 49 | CompactCtx + ShouldCompactPredicate + DoCompactAction |
| `agent-loop-call-main.ts` | 123 | callLLMForMain（current ② 段） |
| `agent-loop-call-forked.ts` | 119 | callLLMForForked（forked ② 段） |
| `build-forked-deps.ts` | 260 | `buildForkedDeps`（forked deps 装配） |
| `forked-context-port.ts` | 127 | ForkedContextPort（buffer-backed） |
| `forked-scope-bootstrap.ts` | 75 | ensureForked scope 预建 |
| `agent-scope-router.ts` | 108 | AgentScopeRouter（Min map） |
| `agent-manager.ts` | 463 | `run(spec, loop)` 唯一入口 + wrappers |
| `context-engine.ts` | 299 | ingest/assemble 加 scopeId + buffer? |

plugin impls：`app/plugins/builtins/rocky_context/`（`compact/threshold_should_compact.ts`、`compact/summary_do_compact.ts`、`assemble/buffer_reader.ts`、`assemble/append_passthrough.ts`、`ingest/buffer_sink.ts`）。

---

## 6. 非 target

- lazy-drain 落地（保留 future；统一骨架天然能容第三份 deps）。
- HITL / require_approval。
- fork-session（持久化复制 session）。
- Granular scope（~5 scope，按 role 拆 impl）——Min 方案够用，future 按需。
