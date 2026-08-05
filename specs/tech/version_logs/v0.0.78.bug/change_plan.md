# v0.0.78.bug — Change Plan（method 级 review 合同）

> **冻结契约**：planner 按本表切 task，coder 按本表实现，reviewer 按本表查偏离。coder 不改本文件；事后偏差写进 `change_log.md`。
>
> 行 = 一个函数/符号。8 列：所属模块 / 文件路径 / 函数·符号 / 类型 / 变更内容 / 约束 / 参考 / 影响行。
>
> 输入：`reqs/[working] v0.0.78.bug/req.md`（6 契约 + 调查结论 + 用户决策）。
> 范围：3 改动点（T1 异步化 / T2 SessionTaskLock bus 注入 + summary_task_update 恢复 / T3 trace name 加 modeKey）。

---

## 0. 并发不变量段（T1 fire-and-forget 安全论证 — coder 实现前必读）

主 loop 改 `void runTryCompact(...).catch(...)` 后，**compact 与主 loop 并发跑**。安全性由以下不变量联合保证（已在 spec 落地，coder 不再创造新不变量）：

1. **per-session compact 互斥**：`SessionTaskLock.acquire(sid, 'compact', runId)` CAS（`session-task-lock.ts:74`）保证同一 session 同时只 1 个 compact 在跑；并发第二个直接 return false 跳过（`context-compact-runner.ts:113-114`）。本变更不动 CAS 语义。
2. **forked 走独立 session/buffer**：compact 经 `manager.forkedRun({ modeKey:'summary' })` 起 forked agent，写 in_memory_session_store（forked scope），**不碰主 session transcript**（`build-forked-deps.ts` 不设 wireStore → ensureRunCreated 跳过、appendMessages 走 in_memory）。forked run 与主 loop 在 session 写入上正交。
3. **compact 无副作用（不碰五态机）**：spec `agent_loop_forked §1` 不变量——forked agent 不调 `stateMachine.markRunning/markIdle/markError`、不动 Run 表、不 ingest 父 transcript、不发 agent_loop 事件到主对话 group（emit 走 forked group `_amt:summary`）。主 loop 的 `run_end`/五态机/agent_loop bus 不受 compact 异步影响。
4. **summary 写入幂等**：`store.setSummary(sid, ...)` 是 idempotent write，version 自增；compact 失败时 summaryUpTo 不推进，下次 compact 可重试（`context-compact-runner.ts:177-182` catch 分支）。
5. **re-assemble 在主 loop 内仍是同步的**：T1 只把 `runTryCompact` 整体改成 fire-and-forget——`runTryCompact` 内部的「compact 后读 afterVersion → re-assemble + setSystem + notifyUsageChanged」分支（`loop-stage-context.ts:201-210`）会被一并异步化。这意味着 compact 完成后主 loop **下一轮** `prepare` 才会读到新 snapshot——但因 compact 写的是 summary（被 default scope 的 `summary_builder` 在下次 `assemble` 时自动消费），主 loop 下一轮 prepareStage 调 `contextEngine.assemble('default', prevSnapshot)` 即自然重建含新 summary 的 snapshot。**主 loop 不需要等 compact**。

**唯一新增的并发点**：compact 异步完成后 `state.snapshot = await ce.assemble(...)` 这行（`loop-stage-context.ts:206`）会改主 loop 的 `state.snapshot`。但因 `state.snapshot` 在主 loop 下一轮 `prepareStage` 进入时会被重新 `assemble(... state.snapshot ?? null)` 覆盖（append 不满足条件 → rebuild），异步 compact 写入的 snapshot 顶多被「再 rebuild 一次」，幂等无副作用。**coder 注意**：异步分支读写 `state.snapshot` 是已允许的（spec 已设计如此），但需保证 compact 异步分支不读写 `state.ingestUpTo/llmUpTo` 游标（这两个游标只由主 loop drain 推进）——`runTryCompact` 现有实现不碰游标（已读代码确认），保持。

**错误观测**：`runTryCompact` 内部 catch 链路完整（`context-compact-runner.ts:177-182` markFailed + rethrow）。fire-and-forget 后这个 rethrow 会被外层 `.catch(err => log)` 捕获——只需打日志（`console.warn('[compact async]', err)` 或经 observability `safe()`），不让 unhandled rejection 上抛。**MUST NOT** 在主 loop 加 try/catch 等结果。

---

## 1. Method-level 变更表（8 列）

### T1 — compact 异步化（契约 1）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-loop-context | app/server/src/agent/loop-stage-context.ts | ingestAssistant()（line 101 调用点） | 修改 | `await runTryCompact(spec, state);` → `void runTryCompact(spec, state).catch((err) => { /* log */ });`（不阻塞主 loop） | MUST：fire-and-forget，主 loop 立即返回；MUST NOT 在主 loop 加 await / try-catch 等结果；MUST 在 catch 内打日志（console.warn 或 logger）保证错误可见；MUST NOT 让 unhandled rejection 上抛 | req 契约 1；`agent_loop_unified.md §2`；本文件 §0 并发不变量 | +3/-1 |
| agent-loop-context | app/server/src/agent/loop-stage-context.ts | runTryCompact() | 修改 | 函数体不变（保留内部 await tryCompact + afterVersion>beforeVersion → re-assemble 链路）；只改它的**调用方式**（caller 不再 await）；可选加 JSDoc 注明「本函数异步执行，caller 应 fire-and-forget」 | MUST：内部 await 链保留（async fn 内部仍顺序）；MUST NOT 改返回签名（仍是 Promise<void>）；MUST NOT 在内部吞错（让外层 catch 捕获 + markFailed 已在 context-compact-runner 落地） | `loop-stage-context.ts:179-211`；`context_compact_detail.md §2c.1` | +5/-0（注释） |

### T2 — SessionTaskLock bus 注入 + 恢复 summary_task_update SSE（契约 3/4）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| session-task-lock | app/server/src/agent/session-task-lock.ts | SessionTaskLock 类字段 | 修改 | 加私有字段 `private sessionPanelBus?: ReplayableEventBus`（参考 `session-store.ts:66` statusBus 注入模式）；加 `setSessionPanelBus(bus): void` 后置注入方法（与 `ContextEngine.setTaskLock` 同模式，避免构造函数耦合） | MUST：bus 缺省 undefined（UT fixture 兼容，与 statusBus 同兜底）；MUST NOT 强制构造期注入（bootstrap 顺序不可控） | `session-store.ts:66/83`；`context-engine.ts:46` setTaskLock 模式 | +12/-0 |
| session-task-lock | app/server/src/agent/session-task-lock.ts | acquire() | 修改 | CAS 成功后调 `emitTaskUpdate(sid, taskType, next)`（新增私有 helper）；emit 失败吞掉（safe-wrap，不影响 CAS 返回值） | MUST：CAS false（已被占）时不 emit（无状态变更）；MUST：emit 异常吞掉不影响 acquire 返回 true；MUST：emit 复用现有 `SESSION_PANEL_TOPIC` + group `session_id:${sid}` | `session-event-types.ts:112` SESSION_PANEL_TOPIC；`session-store.ts:576` emit 形态 | +6/-0 |
| session-task-lock | app/server/src/agent/session-task-lock.ts | markDone() | 修改 | CAS running→done 成功后调 `emitTaskUpdate(sid, taskType, { status:'done', runId:null, startedAt:null, error:null })` | MUST：非 running 调用为 no-op 同时**不 emit**（幂等保护，spec §7.6）；MUST：emit 失败吞掉 | req 契约 3；`session_task_lock.md §3.3` | +3/-0 |
| session-task-lock | app/server/src/agent/session-task-lock.ts | markFailed() | 修改 | CAS running→failed 成功后调 `emitTaskUpdate(sid, taskType, { status:'failed', runId:null, startedAt:null, error })` | MUST：非 running no-op 不 emit；MUST：context-compact-runner catch 分支已调 markFailed → 不重复 emit（不破坏单源） | `context-compact-runner.ts:177-182`；req 契约 3 | +3/-0 |
| session-task-lock | app/server/src/agent/session-task-lock.ts | emitTaskUpdate()（私有 helper） | 新增 | 私有方法：`if (!this.sessionPanelBus) return;` → 组装 `SummaryTaskUpdateEvent`（id=ulid, type='summary_task_update', sessionId, createdAt, data=SessionTaskState）→ `bus.emit(`session_id:${sid}`, { data: evt, timestamp })`；try/catch 吞错 | MUST：bus 未注入时静默 no-op（UT 兼容）；MUST：data = 调用方传入的 next state（acquire/markDone/markFailed 各传自己 CAS 后的 state）；MUST NOT 走 session_meta topic（compact 状态属 session 自身，per-session group 不是 broadcast） | `session-event-types.ts` SummaryTaskUpdateEvent；`session-store.ts:564-579` notifyUsageChanged 模式 | +18/-0 |
| session-task-lock | app/server/src/agent/session-task-lock.ts | release() | 修改 | CAS running→idle 成功后调 `emitTaskUpdate(sid, taskType, { status:'idle', ...IDLE_STATE })`（保持与 acquire/markDone/markFailed 对称） | SHOULD：release 罕见但 emit 一致（spec §2 idle 状态变更同样应推 SSE）；MUST：非 running no-op 不 emit | `session-task-lock.ts:118-124` | +2/-0 |
| session-event-types | app/server/src/agent/session-event-types.ts | SummaryTaskUpdateEvent | 新增（恢复） | 恢复 v0.0.55 删除的 interface：`extends SessionEventBase { type: 'summary_task_update'; data: SessionTaskState; }`；删除 v0.0.55 「已删除」注释（line 47-48）；import `SessionTaskState` from './session-task-lock' | MUST：data 类型用 SessionTaskLock 的 SessionTaskState（`'idle'\|'running'\|'done'\|'failed'`）；MUST：恢复为 `SessionEvent` 联合类型成员（line 50-56）；MUST NOT 改 SESSION_PANEL_TOPIC / SESSION_META_TOPIC 常量 | `session_event.md §2` SummaryTaskUpdateEvent；req 契约 4 | +8/-2 |
| session-meta-broadcaster | app/server/src/agent/session-meta-broadcaster.ts | META_TRIGGERING_TYPES | 修改 | Set 加 `'summary_task_update'`（恢复 v0.0.55 删除的成员）；删除 v0.0.55 注释（line 23-24, 64） | MUST：加回 Set（让 broadcaster 捕获 summary_task_update → 触发 session_meta broadcast，会话列表也刷新 meta）；MUST NOT 改 broadcaster.handleSessionEvent 逻辑（已泛化） | `session-meta-broadcaster.ts:52-58,156`；`session_event.md §3a` | +1/-2 |
| session-meta-broadcaster | app/server/src/agent/session-meta-broadcaster.ts | sessionToMetaView() | 修改 | 加 `summaryTask` 字段（值从 SessionTaskLock 读，但 broadcaster 持有 crud 不持 lock——见下方「⚠️ 实现开放点」） | SHOULD：若 broadcaster 难以读 lock state，则 summaryTask 字段在 SessionMetaView 上保留 optional（`summaryTask?: SessionTaskState`），broadcaster 不填（前端从 summary_task_update 单独事件取）；MUST NOT 强行让 broadcaster 跨越 lock 实例（破坏关注点分离） | `session_event.md §3a.3` SessionMetaView | coder 定位（见下方开放点） |
| session-event-types | app/server/src/agent/session-event-types.ts | SessionMetaView | 修改 | 加 `summaryTask?: SessionTaskState` 字段（恢复 v0.0.55 删除）；optional（broadcaster 不一定能填） | MUST：optional（避免 broadcast 路径强依赖 lock 实例）；MUST：注释说明数据源是 SessionTaskLock | `session_event.md §3a.3` | +3/-0 |
| bootstrap | app/server/src/bootstrap.ts | taskLock 装配（line 437-438） | 修改 | `taskLock.setSessionPanelBus(sessionStatusBus)`（在 registerTopic 之后调，bus 已就绪）；注入点紧跟 `contextEngine.setTaskLock(taskLock)`（line 462 之后） | MUST：在 `hub.registerTopic(SESSION_PANEL_TOPIC, sessionStatusBus)` 之后调（line 374 之后）；MUST：用同一个 sessionStatusBus 实例（不新建）；MUST NOT：让 SessionTaskLock 持有 meta bus（compact 状态属 session_panel 范畴） | `bootstrap.ts:337-374`（bus 装配）；`bootstrap.ts:437/462`（taskLock 装配） | +2/-0 |

> **事件命名决策**：复用 `summary_task_update`（不新起 `compact_task_update`）。理由：(1) spec `session_event.md §2` + 前端 `use-session-run-state.ts:204` + `chat-api.ts:201` + UI spec `component-usage-panel.md §3.3` 全部已用此名，前端零改动；(2) SessionTaskLock 的 `SessionTaskType` 已开放集合（`'compact' | 'tier1_consolidation' | string`），未来 tier1_consolidation 复用同事件只需在 data 里换 taskType 标签，事件名不变；(3) 「summary_task」是 spec 历史命名（v0.0.13 起），改名为「compact_task_update」会同时破 spec+前端+API 三处契约，违背「最小变更恢复 SSE」原则。

### T3 — buildTraceName 加 modeKey（契约 6）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-loop-helpers | app/server/src/agent/agent-loop-helpers.ts | buildTraceName() | 修改 | 加第 4 参数 `modeKey?: string`；modeKey 非空时拼到第一段：\`${kind}[${modeKey}]\`（例 `studio-leader[summary] 01KWN7 helloworld` / `studio-leader[memory_extract] ...`）；modeKey 缺省/=`'current'` 时退原格式 \`${kind} ${sid6} ${input10}\`（main loop 不变） | MUST：modeKey='current' 或 undefined 时退原行为（main loop 视觉零回归）；MUST：modeKey 段紧贴 kind 不加空格（`studio-leader[summary]`）；MUST：保留 trimEnd 兜底；MUST NOT 改 sid6/input10 段语义 | `observability_interface.md §5.1`；`observability/log.md:36` v0.0.61 | +6/-2 |
| agent-loop-observability | app/server/src/agent/agent-loop-observability.ts | LoopObservabilityOpts | 修改 | 加字段 `modeKey?: string`（缺省 = `'current'` 语义，但代码层面 undefined 即可——buildTraceName 自己兜底） | MUST：optional（UT 兼容）；MUST：注释指明 modeKey 来源（forked = `'summary'\|'memory_extract'`，main = `'current'\|undefined`） | `agent-loop-observability.ts:34-51` | +3/-0 |
| agent-loop-observability | app/server/src/agent/agent-loop-observability.ts | startTrace()（line 137 调用点） | 修改 | `buildTraceName(this.opts.sessionKind, this.opts.sessionId, triggerMessages)` → 加第 4 参 `this.opts.modeKey` | MUST：透传 opts.modeKey；MUST NOT 重复默认值（让 buildTraceName 兜底） | `agent-loop-observability.ts:137` | +1/-1 |
| build-forked-deps | app/server/src/agent/build-forked-deps.ts | LoopObservability 构造（line 170-178） | 修改 | opts 加 `modeKey: modeKey`（来自 BuildForkedDepsOpts.modeKey，line 137 已读出局部变量） | MUST：用 caller 传入的 modeKey（`'summary'` for compact / `'memory_extract'` for consolidation），不二次推导；MUST NOT 读 config.modeKey（无此字段） | `build-forked-deps.ts:137/170` | +1/-0 |
| build-deps | app/server/src/agent/build-deps.ts | LoopObservability 构造（line 194-202） | 修改 | opts 加 `modeKey: 'current'`（main loop 显式标 current） | MUST：main loop 显式 `'current'`（langfuse UI 区分 forked vs main 一目了然）；SHOULD：可省略让 buildTraceName 兜底，但显式更清晰 | `build-deps.ts:194` | +1/-0 |

---

## 2. ⚠️ Spec 漂移 / 实现开放点（coder 决策 + 汇报）

### 漂移-1：specs/api/overall/04-agent-session.md（**doc-modifier 阶段修，coder 不动**）
- **现状**：line 567 §7 注释「[v0.0.55] SSE `summary_task_update` 已删除」与 line 681 §10 路径 T「SSE summary_task_update(running→done)」**自相矛盾**——前者声明删除、后者仍描述契约。
- **真相**：spec 整体方向是「恢复」（req.md 明示「spec 对齐已写，代码追上」），但 §7 残留 v0.0.55 删除注释未清。
- **处置**：coder 不修 spec；记入 task-board「doc-sync 待办」，doc-modifier 阶段 5 统一清理（删 line 567 的 v0.0.55 注释、补 v0.0.78.bug 恢复说明）。

### 开放点-1：SessionMetaView.summaryTask 数据源（**coder 定位 + 汇报**）
- **问题**：`session-meta-broadcaster.ts` 持有 `crud`（读 Session record），不持有 `SessionTaskLock` 实例。`SessionMetaView.summaryTask` 字段（如恢复）数据从哪来？
- **方案 A（推荐）**：`SessionMetaView.summaryTask` 设为 **optional**，broadcaster 不填（broadcast 的 SessionMetaView 不带 summaryTask）；前端通过单独的 `summary_task_update` SSE 事件取（已是设计），不依赖 meta_view.summaryTask。
- **方案 B**：broadcaster 注入 `SessionTaskLock` 引用，sessionToMetaView 时 `lock.getState(sid, 'compact')` 读最新 compact 状态填入。增加耦合（broadcaster 持 lock），但 meta_view 字段完整。
- **决策**：方案 A。理由：(1) 前端 CompactBtn 已通过单独事件订阅（`use-session-run-state.ts:204`），不读 meta_view；(2) 减少 broadcaster 跨实例依赖；(3) 与 v0.0.55 之前的字段语义不同（那时 summaryTask 落盘，crud 直读；现在内存 only，crud 读不到）。
- **coder 动作**：按方案 A 实现（`summaryTask?` optional，broadcaster 不填）；在 task-board「偏离汇报」记一句「方案 A，meta_view.summaryTask optional 不填」让 orchestrator 知情。

### 文件体量预警（**coder 注意 ≤300 行**）
- `agent-loop-observability.ts`：当前 357 行（**已超 300**）。本变更 +4 行。coder 实现时如触发 reviewer 退回，需把 `buildTraceName` 调用 / modeKey 处理逻辑外移（但本 plan 不强制——reviewer 按 300 行硬限裁定）。
- `build-forked-deps.ts`（282）/`build-deps.ts`（285）：接近上限，本变更各 +1 行，安全。
- `bootstrap.ts`（856）：长期超限，本版本不动其结构。

---

## 3. Spec 同步清单（doc-modifier 阶段 5 — 不可跳过）

| spec 文件 | 章节 | 现状 | 改动 |
|---|---|---|---|
| specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md | §2 line 72-75 | 伪代码 `await tryCompact(...)` | 改 `void tryCompact(...).catch(...)` + 注释「fire-and-forget，主 loop 不阻塞」 |
| specs/tech/agent/context/[P0]context_compact_detail.md | §2c.1 line 153-158 | 伪代码 `await tryCompact(...)` | 同上改 fire-and-forget；§2c.1 加并发不变量段（引用本 plan §0） |
| specs/tech/agent/session/[P0]session_event.md | §2 + §3 | SummaryTaskUpdateEvent / summary_task_update 已存在（spec 已恢复） | 校对与代码一致（data=SessionTaskState 字段名）；§3 触发时机表加「SessionTaskLock.acquire/markDone/markFailed CAS 成功后」（替代旧 markSummary*） |
| specs/api/overall/04-agent-session.md | §7 line 567 + §10 路径 T | §7 残留「已删除」注释 ↔ §10 仍描述契约（自相矛盾） | 删 §7 的 v0.0.55 删除注释；§10 路径 T 加 v0.0.78.bug「SSE 恢复」说明；前端 CompactBtn 重新走 SSE 不再 poll/409 推断 |
| specs/ui/components/chat-page/component-usage-panel.md | §3.3 | CompactBtn 已绑定 summaryTask（spec 已恢复） | 校对与代码一致；加 v0.0.78.bug 注「SSE 恢复，前端零改动」 |
| specs/tech/agent/observability/[P0]observability_interface.md | §5.1 line 121 | TraceStart.name 描述「`${kind} ${sid6} ${input10}`」 | 加 modeKey 段：`${kind}[${modeKey}] ${sid6} ${input10}`（modeKey 缺省/='current' 退原格式） |
| specs/tech/agent/observability/log.md | 顶部 v0.0.61 段 | 描述 buildTraceName 三段 | 加 v0.0.78.bug 段：buildTraceName 加第 4 参 modeKey，forked 用 `'summary'`/`'memory_extract'`，main 用 `'current'` |
| specs/tech/version_logs/v0.0.61/change_log.md | trace 命名段 | 已写 | 加「v0.0.78.bug 加 modeKey 段」前向引用（或本版本 change_log 自记） |

> 共 6 处 spec 同步（agent_loop_unified / context_compact_detail / session_event / 04-agent-session / component-usage-panel / observability_interface + log）。doc-modifier 必须验证「代码实现 == spec 契约」逐项对齐。

---

## 4. coder 实现顺序建议

| 顺序 | Task | 依赖 | 备注 |
|---|---|---|---|
| 1 | **T2**（SessionTaskLock bus 注入 + summary_task_update 恢复） | 无 | **优先**：恢复 SSE 推送是用户最痛的回归（CompactBtn spinner 信号丢失）。不依赖 T1。 |
| 2 | **T1**（compact 异步化） | 可与 T2 并行 | **独立改动**：仅改 loop-stage-context.ts:101 调用方式 + 加 catch log。T2 完成后 AT 验证更直观（compact 期间前端按钮立即可见 running→done，证明 fire-and-forget 生效）。 |
| 3 | **T3**（buildTraceName 加 modeKey） | 完全独立 | **孤立改动**：仅 observability name 格式，不影响功能；可与 T1/T2 并行或最后做。 |

**planner 切 task 建议**：
- Task A = T2（含 SessionTaskLock 改造 + session-event-types 恢复 + session-meta-broadcaster 触发集 + bootstrap 注入）
- Task B = T1（loop-stage-context.ts fire-and-forget）
- Task C = T3（agent-loop-helpers + agent-loop-observability + build-forked-deps + build-deps）

3 个 task 各自 owning 文件集不重叠（T2 不碰 observability/loop-stage；T1 不碰 lock/observability；T3 不碰 lock/loop-stage），符合 planner 「最粗 owning 级别」切分原则。

---

## 5. AT 验证最低要求（test-plan 阶段细化）

| 路径 | 验证点 | 必需 case |
|---|---|---|
| 路径 4（手动 compact → SSE） | POST /compact 返 202 → SSE 推 summary_task_update(running) → 完成后 SSE 推 summary_task_update(done) → GET /summary 非 null | 新增 AT case（forked 真 LLM） |
| 路径 3（多轮自动 compact） | 多轮对话撞阈值 → 主 loop run_end **不延迟**（fire-and-forget 验证）→ SSE summary_task_update(running) 到达 → compact 完成后 summary_task_update(done) | 复用既有 AT case + 加 SSE 断言 |
| 路径 T（trace name） | langfuse trace name 含 `[summary]` / `[memory_extract]` 段；main loop trace name 不带 bracket | 新增 AT case（langfuse oracle） |

> 详细 test-plan 由 orchestrator 阶段 2.5 产出，本表只列最低覆盖要求。

---

**Plan 冻结**。coder 按 §1 表实现，任何偏离（含方案 A/B 选择、文件体量超额需拆分）必须向 orchestrator 汇报。
