---
type: interface
title: Context Engine — compact 详解
priority: P0
status: active
updated: 2026-07-25
since: v0.0.8
---

# Context Engine — compact 详解

> 主文档：`[P0]context_engine.md`。SummaryInfo 见 `[P0]context_snapshot_interface.md`。压缩 prompt 参考 Claude Code（`refs/claude-code/src/services/compact/prompt.ts`）通用化。**旁路 run 执行器见 `../agent_interface_and_loop/[P0]agent_loop_side_run.md`（v0.0.13 落地，v0.0.204 rename 自 agent_loop_side_run.md）**。**[v0.0.55] compact 互斥改用统一 `SessionTaskLock`（acquire 'compact' / markDone / markFailed）**，subsumes v0.0.13 的 summaryTask 旁路 CAS——见 `../session/[P0]session_task_lock.md`。**压缩指令模板正文经 `CompactHandler` 读 `prompts/content/compact.md`（见 `[P0]prompt_content_files.md` §4/§5），compact runner 委托 handler.build() 取完整压缩 user message 文本。**
> **手动触发路径**：见 §2b（POST /session/:id/compact 端点）。**[v0.0.81.compaction_bug] 触发算式改纯使用比例**：`totalTokens / tokenLimit > compactRatio`（去 estimatedOutput，见 §1）。
>
> **[v0.0.81.compaction_bug] compact_notice 留痕已整删**：旧版（v0.0.16 引入）compact 成功后向 transcript 插一条 `role=system, metadata.kind=compact_notice` 留痕 message + UI 居中 pill 渲染分支；v0.0.81 判定该留痕「无信息量、只增消息数、还污染 assemble 上下文」整段砍掉（grep 0 残留）。compact 是**纯生产者**：只产 summary + accumulateUsage('forked') write，**不再 appendMessages 任何 notice**。本文档原 §6.5（compact_notice 构造 + UI 渲染）+ §6.4 caller 契约的 appendMessages 行 + §2 step 5 / §2c.1.0 / §2c.1.1 / §2d 多处 notice 引用均已清理。

> **当前实现**：compact 改用 **forked agent** 执行（设计 D2.1/D2.2/D2.5）。流程口径（**[v0.0.55] summaryTask CAS → SessionTaskLock**）：
> ```
> // [v0.0.55] 统一锁（subsumes summaryTask CAS，内存 only 不落盘）
> if (!sessionTaskLock.acquire(sessionId, 'compact', runId)) return;  // 已被占 → 跳过（fire-and-forget）
> try {
>   const snap = this.assemble(config);
>   // [v0.0.54] 纯 directive（forked 不变量）——不复述 snap.messages，不注入 old_summary
>   const compactUserMsg = { role:"user", content:[{ type:"text",
>     text: new CompactHandler().build().content }] };   // 读 compact.md（NO_TOOLS + 9 板块 + 输出约束）
>   const forked = new ForkedAgent({ config, snapshot: snap, taskMessage: compactUserMsg,
>     toolsConstraint: [] /* NO_TOOLS */ });
>   const { answer, usage } = await forked.run();      // 内部注入 snap.system（修 D2.2 gap）+ NO_TOOLS；
>                                                      // buffer = [system, ...snap.messages, reminder, directive]
>   const summaryText = extractTag(answer, "summary");
>   store.setSummary(sessionId, { version: oldVersion+1, summaryUpTo: lastMsgId, content: summaryText });
>   await store.accumulateUsage(sessionId, "forked", usage);  // D2.5（**v0.0.14 accumulate 已激活**：真落 forked 分区 + 递归 sub 上报 parent + session_usage_update 真发）
>   sessionTaskLock.markDone(sessionId, 'compact');
> } catch (e) {
>   sessionTaskLock.markFailed(sessionId, 'compact', String(e));
> }
> ```
> - **forked agent 非流式单次调用**，继承父 system prompt（snap.system 注入 CanonicalRequest），NO_TOOLS（tools=[]），无副作用（不碰 session.state / Run / transcript / agent_loop 事件）。
> - **压缩 prompt 简化**：单条 user message 要求解析 `<summary>`（不要求 §3.1 的 `<analysis>` 双 block、不要求 §3.3 的 9 板块结构化输出，coder 实现可尽量贴合但 v0.0.13 不强校验）。**[v0.0.22 升级]：压缩 prompt 升级为 CC 口径完整版（NO_TOOLS preamble+trailer 双保险 + 9 板块 + analysis/summary 双 block + identifier 保留），见 §3；模板正文存 `prompts/content/compact.md` 经 `CompactHandler` 读取**。**[v0.0.54 回归 forked 不变量]：prompt 改纯 directive，不再塞 `serialized_transcript` / `old_summary`——对话历史已在 forked buffer 中（snapshot 单一信息源），prompt 只下指令（见 §3.0）**。
> - **触发时机归 agent loop**（§1 不变）：assemble 后 `remainingTokens < 0` 触发。
> - **summaryUpTo 推进**：固定取 `lastMsgId`（压缩时刻末尾消息 id）；不做 §4 的增量 merge（每次 compact 全量重写 summary）。
> - **summary 不带 head/tail**（§5 不变）：SummaryInfo = `{ version, summaryUpTo, content }`，head/tail 选取归 assemble。
> - **[v0.0.55] SessionTaskLock 状态**：compact 进入 acquire('compact') → 成功 markDone / 失败 markFailed；**内存 only 不落盘**，进程重启自然清空无幽灵锁（详见 `../session/[P0]session_task_lock.md`）。
>
> §3 通用化压缩 prompt（9 板块 + 双 block + NO_TOOLS 双保险）v0.0.22 落地；[v0.0.54] §3 prompt 改纯 directive（回归 forked 不变量）；§4 增量 merge 仍 **future**（完整设计保留）。

## 1. 概述

compact 把一段对话压缩成 summary、推进 `summaryUpTo`，降低后续 assemble 选出的消息量。压缩**调用 LLM**（经 forked agent）。

**职责边界（重要）**：
- compact **只产 summary + 推进 summaryUpTo + 插 system message 留痕（v0.0.16 新增）**。
- **构造视图（head/tail 原文选取）是 assemble 的事**，不在 compact（见 `context_assemble_detail.md`）——summary 与 head/tail 保留解耦。
- **触发时机由 agent loop 决定**（snapshot.contextWindowUsage 超限），不在 compact 内判断；**手动触发**（v0.0.16 新增）由 API 端点 `POST /session/:id/compact` 调，复用同一 compact 执行路径。
- **[v0.0.40] compact 触发 plugin 化**：触发判定不再由 loop 骨架硬编码 `remainingTokens<0`，而是经 `tryCompact(ctx)` 固定胶水 + 两个 `exclusive` context EP（`context_should_compact` 谓词 + `context_do_compact` 动作）承担。loop 骨架对 compact 零感知。详见 §2c。
- **[v0.0.49] tryCompact 调用点回归骨架**：v0.0.40-0.0.48 期间 tryCompact 下沉到 current `ContextPort.recordAssistant`；v0.0.49 删 ContextPort 后，骨架 `runReActLoop` 统一调 `tryCompact(pluginManager, ctx)`（drainMode='eager' 路径，main 专属；forked scope reject 谓词恒 false 自动跳过，骨架无 if main/forked 分支）。详见 §2c.1。

**触发算式（[v0.0.81.compaction_bug] 改纯使用比例）**：tryCompact 胶水在 prepareStage 后调 `threshold_should_compact` 谓词，判定口径：
```
if (totalTokens / tokenLimit > compactRatio) → 触发自动 compact   // 默认 compactRatio = 0.6
```

> **[v0.0.81.compaction_bug] 阈值去 estimatedOutput**：旧口径 `(totalTokens + maxOutputTokens) / tokenLimit > compactRatio` 把 estimated output（= 20000 估算输出常量，见 `context_usage_detail §3` / `context_snapshot_interface §2`）算进占用，导致刚到 60% 实际已逼近撞墙。新口径 `totalTokens / tokenLimit`：**用户视角的真实占用**（已用 / 窗口），> 0.6 即触发——简洁可预期。estimated output 是为 assemble budget 留的 LLM 调用保护（见 `context_assemble_detail §7`），不是已用量，不进阈值。
>
> **历史**：v0.0.8-0.0.15 用 `remainingTokens = tokenLimit − totalTokens − maxOutputTokens; < 0 触发`（撞墙压）；v0.0.16 修复漏减 maxOutputTokens；v0.0.40 plugin 化升级为 `(total+maxOutput)/limit > 0.6`（提前压）；v0.0.81 简化为 `total/limit > 0.6`（去 estimated，纯使用比例）。
>
> **maxOutputTokens 字段语义**（v0.0.81 澄清）：`ContextWindowUsage.maxOutputTokens` = **estimated output 估算输出常量**（默认 20000，app_config `context.maxOutputTokens` 可覆盖；**非 model maxOutput，不随 model 变**）。字段名保留不改（持久化 record + SSE schema 兼容），仅 assemble budget 消费（见 `context_assemble_detail §7`），**不进 compact 阈值 / 不进 UI 占用展示**（见 `component-usage-panel.md §2/§4`）。

```typescript
compact(config: SessionConfig): void;   // 输入：assemble snapshot
```

---

## 2. compact 流程（自动触发执行路径）

```
compact(config)
  输入：assemble snapshot（当前 summary + transcript 视图 + usage）
  │
  ├─ 1. 基于 snapshot 确定压缩区间 [旧 summaryUpTo, 新 summaryUpTo)
  │     - 目标：使 summary + [新 summaryUpTo, 末尾]消息 + system 装得下 context window
  │     - 不碰 head/tail（那是 assemble 的视图选取）
  │
  ├─ 2. fork compaction agent（v0.0.13 落地，见 `../agent_interface_and_loop/[P0]agent_loop_side_run.md`）
  │     - store.markSummaryRunning(sessionId)（summaryTask: idle → running，D2.3 旁路 CAS）
  │     - ForkedAgent({ config, snapshot, taskMessage: 压缩 user msg, toolsConstraint: [] })
  │     - 继承父 session 的 system prompt（system 走 messages[0] role=system，见 snapshot_interface §2 v0.0.16 对齐）
  │     - 压缩 prompt + 待压缩 transcript 段 作为「一条 user message」追加
  │     - NO_TOOLS 约束（tools=[]）+ 写在该 user message 双保险
  │     - 独立 context，中间过程不进主 transcript（无副作用边界见 forked_agent §6）
  │
  ├─ 3. forked agent.run() → answer（v0.0.13 简化：单 `<summary>`；§3 双 block future）
  │     - accumulateUsage(sid, "forked", usage)（D2.5；**v0.0.14 accumulate 已激活**）
  │
  ├─ 4. compact 从 answer 提取 `<summary>` 作新 content（strip 其他）
  │
  └─ 5. 原子更新 SummaryInfo + summaryTask 终态：
        - **[v0.0.186] 先烘焙**：`bakeSummaryBlock(store, config, { content, summaryUpTo, tokenCap, candidateLimit })`
          用**当时的** ratio（`store.getRatio`）+ 锚定候选（head=会话真第一条 takeFromStart /
          tail=summaryUpTo 结尾，candidateLimit 默认 500）+ pickByTokenCap（tokenCap 默认 10000）
          + head∩tail 去重 + budget tailDropped 降级，一次构建完整 block 文本（preamble+head+tail）。
          算法单源 `app/server/src/agent/summary-block.ts`（与组装 fallback 同一实现）；
          参数由 `summary_do_compact` cfg 透传（手动 compact 入口用默认值）。
        - store.setSummary(sessionId, { version++, summaryUpTo = 新, content = 新 summary, block = 烘焙文本 })
        - 成功 → store.markSummaryDone(sessionId)
        - 异常 → store.markSummaryFailed(sessionId, { error })（catch 分支）
        - **[v0.0.81.compaction_bug] 不再 appendMessages 任何 notice**（compact_notice 已删，compact 是纯生产者：只产 summary + accumulateUsage write，零 transcript 副作用）
```

> **[v0.0.186] 烘焙 = prompt 缓存前缀稳定的第二根柱**：组装期 `base_builder` 见 `summary.block`
> 直接用作 messages[0]（零选取零计算），ratio 漂移 / transcript 增长 / recent 窗口滑动都不再
> 影响 messages[0]（v0.0.185 修了候选锚定，但动态 ratio 仍会撑缩 head 窗口——烘焙把选取结果
> 定格，根治该残余机制）。边界：烘焙后 head/tail 窗口内历史消息被 HITL 编辑不回刷 block
> （recent 区每轮读最新不受影响）；存量旧 summary 无 `block` → 组装走 v0.0.185 即时构建
> fallback，下次 compact 自动升级（不做启动迁移）。

---

## 2b. 手动触发路径（v0.0.16 新增）

### 2b.1 端点契约

`POST /session/:id/compact` — 手动触发 compact（详见 `specs/api/overall/04-agent-session.md §7`）：

| 项 | 值 |
|---|---|
| 请求体 | 空（无参） |
| 成功响应 | `202 Accepted` + `{ ok: true }`（fire-and-forget，不 await compact 完成） |
| 冲突响应 | `409 Conflict` + `{ error, message }`——唯一：`compact_in_progress`（**[v0.0.55]** `SessionTaskLock.getState(sid, 'compact').status === 'running'`）；带友好 `message` 提示。**[v0.0.54.compaction] 简化**：之前的 `session_interrupting` / `session_running` 已删除——任何 session.state（idle/running/interrupting/interrupted/error）都放行 |

> **[v0.0.158] compact 走与 chat 同一链**——handler 内部 SessionConfig 组装收敛为**唯一入口** `agentManager.resolveConfigBySid(sid)`（chat/compact 无区分，无 `task` 参数、无 summary 子链）。旧版（v0.0.155 及之前）本 handler 自建 `buildSessionConfigFromDeps(..., task='summary', ...)` 独立支路 → v0.0.158 删除该路径，handler 从 ~90 行瘦到 ~30 行。model resolve 契约见 `../providers_and_models/[P0]model_resolve.md §3`（chat 单链 2 行；playground → default_models.chat / studio → squad.modelDefault）。resolve 跑空仍返 400 `{code:"MODEL_NOT_CONFIGURED", message, detail:{sessionType}}`（detail.task 字段已删）。

### 2b.2 触发条件（caller 校验）

| 条件 | 行为 |
|---|---|
| **[v0.0.55]** `SessionTaskLock.getState(sid, 'compact').status === 'running'` | 409 `compact_in_progress`（compact 进行中，拒绝重复触发；前端按钮 disabled） |
| 任何 `session.state`（idle/running/interrupting/interrupted/error）+ lock `status ∈ {idle, done, failed}` | 通过 → 调 compact 执行路径（§2） |

> **[v0.0.55] 双保险语义（统一锁版）**：接口层 `SessionTaskLock.getState` 检查（reject `running`）+ 内部层 `runCompact` 内 `SessionTaskLock.acquire('compact')` CAS（state: idle/done/failed → running 原子切换，并发抢不到者返 false 直接跳过）——两层独立防护 compact 互斥。session.state 不再参与（forked agent 不碰 session.state/Run，与主对话 AgentLoop 在写 buffer 上正交——任何 session.state 都可跑 compact）。原则：**任何 session 任何时间都能 compact，除非 compact 正在跑**（subagent 防爆炸关键）。
>
> **[v0.0.54] subagent 允许 compact**：手动 compact 不再对 `session.type === "subagent"` 返 403——subagent 长跑上下文同样会爆炸，必须支持手动 + 自动 compact（共用同一 forked agent 路径，subagent 自动 compact 已 work，手动此前被 `session-compact.ts` guard 拦掉是 bug）。

### 2b.3 执行路径

手动触发与自动触发**共用同一 compact 执行路径**（§2 的 markSummaryRunning → ForkedAgent → setSummary + appendMessages → markSummaryDone/failed）。差异仅在入口：
- **自动**：agent loop 在 assemble 后判 `remainingTokens < 0` 触发（§1 算式）。
- **手动**：HTTP 端点收到 POST → 校验条件 → 直接调 compact 执行路径（不依赖 agent loop 上下文，从 session store 读 snapshot / config 自建 compact 上下文）。

> **[v0.0.82] runCompact 收 snapshot 对象，不再收 assembleFn 回调**——caller（自动 = tryCompact / 手动 = ContextEngine.compact）传入 `ContextSnapshot` 对象，runCompact 内部**不重新 assemble**，直接用传入的 snapshot 跑 forkedRun。
>
> - **自动入口（tryCompact → summary_do_compact → runCompact）**：caller 持有 main 的 `state.snapshot`（prepareStage 产），深拷贝后传 runCompact。深拷贝链保留两点：`try-compact.ts:67` `structuredClone(ctx.snapshot)`（main→sharedCtx 共享副本，fork-1/fork-2 共用）+ `agent-manager.ts:354` `structuredClone(opts.snapshot)`（sharedCtx→forked 各自独立副本）。runCompact 只读 snapshot 不改。
> - **手动入口（POST /compact → ContextEngine.compact）**：caller 不持 main snapshot（HTTP 入口不在 loop 内），`ContextEngine.compact` 内部先 `this.assemble(config)` 产 snapshot，再调 runCompact。
> - **历史**：v0.0.16 引入 assembleFn callback（`(c) => ce.assemble(c)`）以便 runCompact 在锁内重新 assemble。三个原由（延迟生产 / 锁内新鲜 / 循环依赖）在 compact 场景都不成立：caller 早已 assemble 过（prepareStage 产 state.snapshot，append 分支 messages 稳定）；锁只 CAS 不持读；ContextEngine 持 store 自建 snapshot 无循环依赖。v0.0.82 删 callback 回归直收 snapshot 对象（消除过度设计）。

> 手动触发**任何 session.state 都可调**（**[v0.0.54.compaction] 修订**：原 v0.0.54 的「`state ∉ {interrupting, running}` 才放行」已废除——之前担心"并发写 buffer 冲突"是误解：forked agent 是无副作用执行器不碰 session.state/Run，与主对话 AgentLoop 在写 buffer 上正交；真正需要互斥的是 compact 自身，由 summaryTask + markSummaryRunning CAS 兜底即可）。forked agent 路径仍复用 §2，不依赖主 loop 在跑（任意 state 从 store 自建 snapshot 跑）。

---

## 2c. compact 触发 plugin 化（v0.0.40 新增 — tryCompact + 2 exclusive EP；v0.0.49 调用点回归骨架）

> **设计目标**：compact 触发从「loop 骨架硬编码 `remainingTokens<0` 撞墙压」升级为**完全 plugin 化**——loop 骨架对 compact **零感知**，触发判定经固定胶水 `tryCompact(ctx)` 由两个 `exclusive` context EP（`context_should_compact` 谓词 + `context_do_compact` 动作）承担。这是首批 exclusive context EP（既有 6 个 context EP 全是 ordered，见 `[P0]extension point and implementations.md §2`）。
>
> **[v0.0.49] 调用点变更**：v0.0.40-0.0.48 tryCompact 在 current `ContextPort.recordAssistant` 内调；v0.0.49 删 ContextPort 后，骨架 `runReActLoop` 统一调 `tryCompact(pluginManager, ctx)`（drainMode='eager' 路径，main 专属；forked scope reject 谓词恒 false 自动跳过，骨架无 if main/forked 分支）。

### 2c.1 tryCompact 固定胶水（v0.0.80.t1 — sibling 双发）

`tryCompact(ctx)` 是**非插件**的固定胶水函数，骨架 `runReActLoop` 在 **`prepareStage` 之后、`callLLM` 之前**调用（[v0.0.80.t1] 触发点迁移：旧位置 `ingestAssistant` 已删——callLLM 前调用保证此刻 snapshot 末尾 msg 必是 user[turn 开头 drain] 或 tool_result[上轮 ingestToolResults]，无 hanging tool_use，干净；drainMode='none' 的 forked 路径也调，但 scope 路由让 reject 谓词恒 false 自动跳过）：

```
// runReActLoop 骨架（伪代码，详见 agent_loop_unified.md §2）
async runReActLoop(spec):
  ...
  // ① prepareStage（drain inbox + ingest user/tool_result + assemble + 准入判定）→ state.snapshot 刷新
  // ★ [v0.0.80.t1] 触发点（fire-and-forget；旧位置 ingestAssistant:109 已删）
  //   callLLM 前 snapshot 末尾 msg 必 user/tool_result，无 hanging tool_use
  void runTryCompact(spec, state).catch((err) => { /* log only */ })
  // ② LLM Request → assistant（callLLM）
  ...

// runTryCompact（loop-stage-context.ts）构造 CompactCtx 后调 tryCompact
async tryCompact(pluginManager, ctx):
  const predicates = pluginManager.getExtensionImpls<ShouldCompactPredicate>("context_should_compact", ctx.scopeId)
  if (predicates.length === 0) return                    // scope 未激活 shouldCompact → 跳过
  if (!(await predicates[0].check(ctx))) return          // exclusive ≤1 active，谓词返 false → 不压（forked scope reject 据此关 compact）
  // ★ [v0.0.80.t1] sibling 双发：谓词 true 后 deep clone snapshot 一次，两 sibling 共享不可变副本
  const sharedCtx = { ...ctx, snapshot: structuredClone(ctx.snapshot) }
  void runSummarySibling(pluginManager, sharedCtx).catch((err) => { /* log only */ })
  void runConsolidationSibling(pluginManager, sharedCtx).catch((err) => { /* log only */ })
  // 立即 return（两 sibling 异步并发，互不阻塞，互不耦合；主 loop 不 await）

async runSummarySibling(pm, ctx):                        // fork-1
  const actions = pm.getExtensionImpls<DoCompactAction>("context_do_compact", ctx.scopeId)
  if (actions.length === 0) return                       // 容错
  try { await actions[0]!.run(ctx) }                     // runCompact 内部 acquire 'compact' 锁 + markFailed/markDone
  catch (err) { console.warn('[summary sibling]', err) }

async runConsolidationSibling(pm, ctx):                  // fork-2
  const handlers = pm.getExtensionImpls<PostCompactHandler>("context_post_compact", ctx.scopeId)
  if (handlers.length === 0) return
  try { await handlers[0]!.handle(ctx) }                 // handler 内部 acquire 'tier1_consolidation' 锁（§2d）
  catch (err) { console.warn('[consolidation sibling]', err) }
```

#### 2c.1.0 「summary = 纯生产者」原则（v0.0.80.t1 核心设计原则 — MANDATORY）

> **compact/forked 是纯生产者**，只负责两件事：
> 1. 写 summary（`store.setSummary`）
> 2. 记自己的 LLM cost（`store.accumulateUsage(sid, 'forked', forkedResult.usage)` **write** 保留——agent run 自身簿记，类比主 loop 每次 callLLM 后记 usage）
>
> **[v0.0.81.compaction_bug] 不再写 compact_notice**：旧版（v0.0.16-v0.0.80.t1）compact 成功后还向 transcript `appendMessages` 一条 `role=system, metadata.kind=compact_notice` 留痕 message；v0.0.81 判定「无信息量、只增消息数、还污染 assemble 上下文」**整删**（grep 0 残留）。compact 现在真正零 transcript 副作用。
>
> **不碰消费侧**（v0.0.80.t1 全部移除）：
> - ❌ `state.snapshot = re-assemble`（旧 `loop-stage-context.ts:222` 同步尾已删）
> - ❌ `obs.setSystem(...)`（旧 `loop-stage-context.ts:224` 已删）
> - ❌ 任何从 compact 内部触发的 `notifyUsageChanged`，含两处：
>   - `loop-stage-context.ts:225`（re-assemble 尾里的 notify）
>   - `context-compact-runner.ts:170-172`（`for (const notifySid of usageChain) notifyUsageChanged` 循环已删，accumulateUsage **write** 保留）
>
> **消费侧归正规 assemble 管线**：`ingestMainAndAssemble` 完成后，三个调用方（`prepareStage` / `ingestAssistant` / `ingestToolResults`）每次 assemble 后都调 `notifyUsageChanged`。`getUsageView` 读**全量** usage record（含 forked 分区 + contextWindowUsage），由这些正规 notify 携带 emit。
>
> **compact 写的 forked cost + 下一轮 context 下降（重算 contextWindowUsage）→ 都由下一轮正规 assemble 的 notifyUsageChanged 携带。compact 完成后不主动 notify，等下一轮 assemble。这是有意分离，不是遗漏。** 详见 `specs/tech/version_logs/v0.0.80.t1/change_log.md` §决策。

### 2c.1.1 并发不变量（v0.0.78.bug fire-and-forget + v0.0.80.t1 sibling 双发）

> 主 loop 把 `tryCompact` 改 fire-and-forget 后（v0.0.78.bug），**compact 与主 loop 并发跑**；v0.0.80.t1 起 tryCompact 内部改 sibling 双发 + 删除 re-assemble 同步尾（summary 纯生产者原则 §2c.1.0）。安全性由以下不变量联合保证：
>
> 1. **per-session compact 互斥**：`SessionTaskLock.acquire(sid, 'compact', runId)` CAS（`session-task-lock.ts`）保证同一 session 同时只 1 个 compact 在跑；并发第二个直接 return false 跳过（`context-compact-runner.ts`）。CAS 语义不变。
> 2. **旁路 run 走独立 session/buffer**：compact 经 `manager.sideRun({ runKind:'summary' })` 起旁路 run，写 in_memory_session_store（summary scope），**不碰主 session transcript**。旁路 run 与主 loop 在 session 写入上正交。
> 3. **compact 无副作用（不碰五态机）**：见 `agent_loop_side_run §1` 不变量——旁路 run 不调 `stateMachine.markRunning/markIdle/markError`、不动 Run 表、不 ingest 父 transcript、不发 agent_loop 事件到主对话 group。主 loop 的 `run_end`/五态机/agent_loop bus 不受 compact 异步影响。
> 4. **summary 写入幂等**：`store.setSummary(sid, ...)` 是 idempotent write，version 自增；compact 失败时 summaryUpTo 不推进，下次 compact 可重试（`context-compact-runner.ts` catch 分支）。
> 5. **[v0.0.80.t1] compact 不刷主 loop snapshot（summary 纯生产者）**：旧 v0.0.78.bug 的 `runTryCompact` 同步尾「compact 后 re-assemble + setSystem + notifyUsageChanged」**已整删**（§2c.1.0 原则）。compact 写完 summary + accumulateUsage write 后**不主动推送 usage**（v0.0.81 起也不再 appendMessages compact_notice，纯生产者）；主 loop 下一轮 `prepareStage` 调 `contextEngine.assemble('default', prevSnapshot)` 自然重建含新 summary 的 snapshot，并经 `prepareStage` 内的 `notifyUsageChanged` 推送全量 usage（含 forked 分区 + 重算 contextWindowUsage）。**主 loop 不需要等 compact，compact 也不主动 notify。**
> 6. **[v0.0.80.t1] sibling 双发互不阻塞**：谓词 true 后 deep clone snapshot ONCE，`void runSummarySibling + void runConsolidationSibling` 并发派发；两 sibling 各自 acquire 自己的锁（`compact` / `tier1_consolidation`），锁失败各自静默跳过，异常各自 `.catch(log)` 不传播。
>
> **错误观测**：sibling 内部 catch 仅 log；fork-1 runCompact 失败仍走 markFailed + rethrow → 外层 `.catch(err => log)` 捕获；fork-2 handler 内部 markFailed。**MUST NOT** 在主 loop 加 try/catch 等结果、**MUST NOT** 让 unhandled rejection 上抛。

> **loop 骨架对 compact 零感知**：`runReActLoop(spec)`（`../agent_interface_and_loop/[P0]agent_loop_unified.md §2`）只调 `tryCompact(pluginManager, ctx)`，不知道 compact 触发条件 / 怎么压的细节。default scope threshold/summary impl 触发；forked scope reject/noop（结构上不可能递归，§2c.3）。

### 2c.2 默认 impl：`threshold_should_compact`（谓词）

```typescript
interface ShouldCompactPredicate {
  check(ctx: CompactCtx): Promise<boolean>;   // true = 该压了
}

interface CompactCtx {
  config: SessionConfig;
  snapshot: ContextSnapshot;     // 含 contextWindowUsage（totalTokens / tokenLimit / maxOutputTokens）
  store: SessionStore;
  scopeId: string;
}
```

**默认 impl `threshold_should_compact`**（`configSchema` 见 `[P0]extension point and implementations.md §4.6`）：

```
predicate = snapshot.contextWindowUsage.totalTokens
            / snapshot.contextWindowUsage.tokenLimit
            > config.compactRatio   // 默认 0.6
```

> **[v0.0.81.compaction_bug] 分母去 maxOutputTokens（隐藏决策点 1 修订）**：旧口径 `(totalTokens + maxOutputTokens) / tokenLimit` 把 estimated output（= 20000 估算输出常量，**非已用量**）算进占用，导致刚到 60% 实际已逼近撞墙。新口径 `totalTokens / tokenLimit` = 用户视角的真实占用（已用 / 窗口），> 0.6 即触发。estimated output 仅用于 assemble budget（保护 LLM 调用，见 `context_assemble_detail §7`），不进阈值。提前 compact 比撞墙 compact 更稳（撞墙往往需要 precompress/prefill 等应急处理，见 `../llm_caller/[P0]llm_request_config.md §2`）。

### 2c.3 默认 impl：`summary_do_compact`（动作）+ 防递归不变量

```typescript
interface DoCompactAction {
  run(ctx: CompactCtx): Promise<void>;   // 执行压缩 + setSummary
}
```

**默认 impl `summary_do_compact`** = 搬现状 §2 流程（`markSummaryRunning` → `sideRun(summary, NO_TOOLS, maxIter=1)` → extractTag → `setSummary` + appendMessages 留痕 → `markSummaryDone/failed`），由 action 闭包承担。**动作契约不变**，只是入口从「loop 硬编码」改为「doCompact EP active impl」。

> **防递归不变量（MANDATORY，spec 显式写死）**：
> 1. `summary_do_compact` 内部调 `sideRun(summary)`，该 run 的 scopeId = summary canonicalId（v0.0.204 起 = `SessionKind.canonicalId()` 纯拼接，如 `playground-rocky:parent:summary`；详见 `../session/[P0]session_type_profile.md`）。
> 2. summary scope **显式激活** `reject_should_compact`（dummy 谓词，`check()` 恒返 false）——`session-type-scopes/*.summary.yaml` 声明。`getExtensionImpls("context_should_compact", summaryScopeId)` 返回 `RejectShouldCompactPredicate` → `tryCompact` 在谓词检查处 `if(!await predicates[0].check(ctx)) return` 短路返回，不触发 compact。
> 3. ∴ summary run 自己**结构上不可能 compact**（递归被 summary scope 的拒绝谓词阻断）。
> 4. `context_do_compact` 在 summary scope 同理显式选中 `noop_do_compact`（空操作）作 **defense-in-depth**——理论上不可达（步骤 2 的 reject 谓词已拦截，doCompact 永不被调），显式选中是为让 exclusive EP 在 summary scope 不留 zero-active 态。
>
> 这是用 scope 机制天然防递归——不靠运行时标志位（如「正在 compact 中」flag），而是结构上：forked scope 显式选 `reject_should_compact` = compact 链在谓词处断。
>
> **为何用「显式选 dummy 实现」而非「disable 唯一实现制造 zero-active」（v0.0.40 修复）**：`context_should_compact` / `context_do_compact` 是 **exclusive** EP，UI（`component-ext-impl-radio`）是 radio 单选——只有「选中某项」交互，没有「取消勾选回到未选」交互（已选中项 radio input 为 disabled，只能改选别项，不能取消）。若 forked scope 靠 disable 唯一实现（`threshold_should_compact`/`summary_do_compact`）制造 zero-active，是只能用 `ensureForkedScope` 代码绕过 UI 语义强行造的中间态，UI 无法表达也无法恢复（exclusive 选中即不可逆）。改为新增 dummy 实现（`reject_should_compact`/`noop_do_compact`）并显式 `setExclusive` 选中——让 exclusive EP 在**任何 scope** 下都「总有人被选中」，不依赖 UI 无法表达的中间态。

### 2c.4 compact 频率 / 迟滞（known tuning 点）

`>60% 提前压` 可能出现「压完几轮用量又到 60%」。**[v0.0.55] 统一锁 `SessionTaskLock.acquire('compact')` 已串行化**（同一时刻不并发压——CAS state: idle/done/failed → running，§2 流程）。**v0.0.40 默认 impl 先不加迟滞**（靠锁串行），spec 记为 known tuning 点：观测后如发现频繁重压，再加「距上次 compact 用量增长 >X」迟滞（属 impl 内部 configSchema 扩展，不动 EP 契约）。

### 2c.5 与 §1 触发算式的关系

§1 的 `remainingTokens = tokenLimit − totalTokens − maxOutputTokens; < 0 触发` 是**历史现状**（v0.0.8-0.0.15 loop 骨架硬编码）。**[v0.0.81.compaction_bug] 起 threshold 改纯使用比例**：
- **loop 骨架不再判 remainingTokens**（compact 判定归 tryCompact 胶水 + EP）。
- **默认 impl `threshold_should_compact` 现口径**：`totalTokens / tokenLimit > compactRatio`（默认 0.6）——纯使用比例，不含 estimated output。
- 改阈值只动 impl 的 `compactRatio` config（configSchema），不动 spec / 不动 loop 骨架。

> **历史算式演进**：v0.0.8-0.0.15 `remainingTokens = tokenLimit − totalTokens − maxOutputTokens; <0 触发`（撞墙压）→ v0.0.16 修漏减 maxOutputTokens → v0.0.40 plugin 化升级为 `(total+maxOutput)/limit > 0.6`（提前压但分母含 estimated output）→ **v0.0.81 简化为 `total/limit > 0.6`**（去 estimated output，纯使用比例，与 UI 占用口径一致）。

---

## 2d. post-compact handler ext point（v0.0.51 新增 — context_post_compact；v0.0.80.t1 调用方式重构）

> **设计目标**：compact 触发时提供一个**可扩展的整理旁路钩子**——让 memory/skill 整理工作通过 ordered EP 注册，而非硬编码在 compact 流程里。
>
> **[v0.0.80.t1] 调用方式重构**：旧 v0.0.51 「compact 成功完成后（setSummary + appendMessages + markSummaryDone 之后）串行触发 handler chain」**退役**——handler 不再是 compact 成功的后续，而是与 summary 并发的 sibling。`tryCompact` 谓词 true 后直接 `void runConsolidationSibling(...) → handlers[0].handle(ctx)` 并发派发（§2c.1）。EP 注册仍在 `context_post_compact`（impl 可扩展、可替换），仅调用点迁移。handler 内部 acquire `'tier1_consolidation'` 锁（spec `../session/[P0]session_task_lock.md §6` 实接）。

> **实现状态（v0.0.204 口径）**：默认 impl `memory_skill_consolidation` 落地于 `app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts`（runKind=`consolidate`；maxIter=10（consolidate profile `runShape.maxIterDefault`）；allowed tools=[skill_manage, memory_manage]（consolidate profile toolBound）；复用 session model + CompactCtx + ConsolidationHandler prompt 模板——**纯 directive**，见 §2d.3）。[v0.0.80.t1] `MemorySkillConsolidationHandler.handle` 内部 acquire `'tier1_consolidation'` 锁（锁失败静默 return；fork-2 完成 `markDone` / 异常 `markFailed`）。consolidate scope 防递归 `noop_post_compact` impl（§2d.4）。post_compact AT 不可行（黑盒难观测），UT 覆盖（runner wire + tier1 锁 acquire + 防递归 + fire-and-forget 异常隔离 + usage 总量累计）。

### 2d.1 触发时机（v0.0.80.t1 sibling 双发）

[v0.0.80.t1] handler 在 **`tryCompact` 谓词 true 后**由胶水 sibling 双发触发（与 summary sibling 并发，**不再依赖 compact 成功完成**）：

```
runReActLoop prepareStage 后、callLLM 前：
  void tryCompact(spec, state).catch(log)
    └─ should-compact 谓词 true →
         ├─ void runSummarySibling(ctx) → DoCompactAction.run（fork-1，acquire 'compact'）
         └─ void runConsolidationSibling(ctx) → PostCompactHandler.handle（fork-2，acquire 'tier1_consolidation'）
              └─ memory_skill_consolidation handler（默认 impl）
                   → 启动 fork-2 整理 forked agent
```

**[v0.0.80.t1] 不再依赖 compact 成功**：fork-2 sibling 与 fork-1 sibling 在 tryCompact 胶水里并发派发，各自锁失败各自静默跳过（fork-1 compact 锁失败 → 不产 summary，但 fork-2 仍可独立跑——这是有意分离，两个 sibling 任务语义独立）。

### 2d.2 EP 契约

```typescript
interface PostCompactHandler {
  handle(ctx: PostCompactCtx): Promise<void>;
}

interface PostCompactCtx {
  // 复用 CompactCtx（见 §2c.2）
  config: SessionConfig;
  snapshot: ContextSnapshot;     // compact 前的完整 snapshot（含待压缩对话）
  store: SessionStore;
  scopeId: string;
}
```

- **EP id**：`context_post_compact`
- **group**：`context`
- **cardinality**：`ordered`（多个 handler 按 effective order 链式执行）
- ** CompactCtx 复用**：PostCompactCtx = CompactCtx（含 snapshot / config / store / scopeId），snapshot 是 compact 前的完整快照（fork-2 用同一份输入）

### 2d.3 默认 impl：`memory_skill_consolidation`

当前实现（`app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts`，v0.0.204 口径）：

```typescript
class MemorySkillConsolidationHandler implements PostCompactHandler {
  async handle(ctx: CompactCtx): Promise<void> {
    if (!ctx.consolidateRunner) return;                  // 缺依赖（UT fixture）→ 跳过
    if (!ctx.toolDefinitions?.length) return;
    if (ctx.taskLock && !ctx.taskLock.acquire(sid, 'tier1_consolidation', runId)) return; // 锁占用 → 静默跳过
    // fire-and-forget：不 await（不阻塞 tryCompact / agent loop），完成 markDone / 失败 markFailed
    void this.startConsolidation(ctx).then(markDone, markFailed);
  }

  private async startConsolidation(ctx) {
    // 1. 构造 fork-2 task message = 纯 directive（旁路不变量，与 fork-1 summary 同契约）：
    //    ConsolidationHandler.build() 不读 vars（只填 routing_rules 单一文案常量）；
    //    consolidation.md 无 serialized_transcript 占位（"the conversation above"）——
    //    对话历史由 snapshot 经旁路 buffer 唯一承载，prompt 只下指令不复述。
    const taskText = new ConsolidationHandler().build().content;
    // 2. 调 ctx.consolidateRunner（bootstrap wrap agentManager.sideRun）启动 fork-2：
    //    runKind='consolidate' + snapshot=ctx.snapshot；allowedTools/maxIter/toolDefinitions
    //    由 consolidate profile 派生（toolBound=[skill_manage, memory_manage]）。
    const result = await runner({ sessionId: sid, runKind: 'consolidate',
                                  snapshot: ctx.snapshot, userMessage, triggerMessageId, triggerUsage });
    // 3. fork-2 usage 总量一次性累计（caller 总量口径，与 fork-1 runCompact 同契约：
    //    不经 lifecycle 逐调用，防双计；tier2 三 run 不累计——公共整理不摊 session usage）。
    if (ctx.store) await ctx.store.accumulateUsage(sid, 'forked', result.usage);
  }
}
```

> **[v0.0.204] fork-2 纯 directive 修复**：本 handler 曾把 `serializeMessages(snapshot.messages)` 塞进 task message（v0.0.51 遗留，违反 §3.0 旁路不变量——对话历史发两遍、长会话双倍 token 可超 window 致 fork-2 静默失败）。v0.0.204 删 serializeMessages + ConsolidationHandler 删 `serialized_transcript` var + consolidation.md 删 [输入] 段（"the snapshot below" 改 "the conversation above"）+ `context-compact-helpers.ts` 删 serializeMessages 死函数。fork-1 / fork-2 同契约：**snapshot 唯一信息源，prompt 纯 directive**。

### 2d.4 旁路 scope 防递归（MANDATORY）

fork-2 的 scopeId = `<prefix>:consolidate`（沿 extends 链落到 `consolidate` 基座 scope），该基座显式选 noop impl 跳过 compact 链，防止**整理 run 再触发 compact → 再整理的递归**：

```
consolidate scope（基座）配置：
  reject_should_compact    ← 防递归 compact（谓词恒 false，§2c.3）
  noop_do_compact           ← defense-in-depth（exclusive EP 不留 zero-active）
  noop_post_compact         ← 防递归整理
```

**实现方式**：`app/plugins/scopes/consolidate.yaml` 在 `context_post_compact` EP 显式声明 `noop_post_compact`（空操作 dummy handler）——与 `reject_should_compact` / `noop_do_compact` 同模式（防递归靠 scope 隔离，不靠运行时 flag）。summary 基座同构（summary run 也不许再 compact / 再整理）。

> **注**：`context_post_compact` 是 **ordered** EP（非 exclusive），consolidate scope 的跳过方式 = impls 数组只列 noop handler（membership 模型全量替换）。spec 约定旁路 scope **必须跳过** post-compact handler。

### 2d.5 与 §2c 的关系（v0.0.80.t1 sibling 双发后）

| 维度 | §2c（compact 触发） | §2d（post-compact handler） |
|---|---|---|
| 时机 | tryCompact 谓词检查 + sibling 双发派发（[v0.0.80.t1] 不再「compact 完成后」串行） | 与 §2c sibling 并发派发（同时、独立 acquire 锁） |
| EP cardinality | exclusive（谓词 + 动作各 ≤1 active） | ordered（多 handler 链式；当前仅 1 个 active impl） |
| 默认 impl | threshold_should_compact + summary_do_compact | memory_skill_consolidation |
| 防递归 | summary scope 选 reject_should_compact | consolidate scope 跳过 post-compact handler（noop_post_compact） |
| 失败影响 | 谓词失败 = 两 sibling 都不派发 | handler 失败 = 整理没做（fire-and-forget 静默 catch log） |
| 锁 | fork-1 sibling 内部 runCompact acquire 'compact'（§2c.3） | fork-2 handler 内部 acquire 'tier1_consolidation'（§2d.1，[v0.0.80.t1] 实接） |

---

## 3. 压缩 prompt（参考 CC 通用化，v0.0.22 完整版）

### 3.0 模板来源（v0.0.22；[v0.0.54] 改纯 directive）

**压缩指令模板正文**（NO_TOOLS preamble + 9 板块要求 + 输出约束 + NO_TOOLS trailer）存于 **`app/server/src/prompts/content/compact.md`**，经 **`CompactHandler`**（`[P0]prompt_content_files.md` §4）读取。

> **[v0.0.54] 旁路 run 不变量（MANDATORY）**：compact prompt 是**纯 directive**——snapshot 是唯一信息源（system + messages + reminder 已在 side-run buffer 中），prompt 只下「概括上面对话历史」的指令，**不复述 `serialized_transcript`、不注入 `old_summary`**。这是旁路 run 的核心不变量（见 `../agent_interface_and_loop/[P0]agent_loop_side_run.md §1`）。
>
> 故 `CompactHandler.build()` 不再接任何 vars；compact.md 不含任何占位符。compact runner（`context-compact-runner.ts`）`new CompactHandler().build().content` 直接取指令文本作为 task message。`serializeMessages` 函数已删（无消费方 → 清死代码）。
>
> **历史背景**：v0.0.22 实现曾把 `serializeMessages(snap.messages)` 塞进 user prompt 的 `serialized_transcript` 字段 → LLM 收到 `[system, ...messages(真身), reminder, userMessage(又把 messages 序列化复述一遍)]`——对话历史发两遍，违反旁路 run 不变量（buffer = snapshot 内容 + 追加指令；task message 是 directive 不复述）。v0.0.54 修复 = 回归不变量。

### 3.1 双 block 结构（旁路 run 产出格式）

旁路 run（summary）产出两块：
- **`<analysis>`**：起草草稿（提升 summary 质量，按时间顺序识别 user 请求 / agent 做法 / 关键决策 / 错误与修正 / 用户反馈），compact **strip 掉、不落库**（同 CC `formatCompactSummary`，用 regex `<analysis>[\s\S]*?</analysis>` 删）。
- **`<summary>`**：实际保留的摘要，含 9 结构化板块（§3.3）→ 存为 `SummaryInfo.content`。

> **`<analysis>` strip 实现**：`extractTag`（`context-compact-helpers.ts`）现有逻辑保留 summary 内容；如需对齐 CC `formatCompactSummary` 的 regex strip，coder 阶段按需补全（regex 删 analysis 块 + 提取 summary 块文本）—— 本版本不强求改造（spec §6.5.1 已约定）。

### 3.2 压缩 prompt 作为 user message（不是 system prompt）+ NO_TOOLS 双保险

forked agent **继承父 session 的 system prompt**（不动，保 cache 一致）；压缩指令作为**对话末尾追加的一条 user message**，结构（v0.0.22 对齐 CC 口径）：

```
[NO_TOOLS preamble]                                    ← compact.md 开头
CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
- Do NOT use Read/Bash/Grep/... or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

[主体指令]
Your task is to create a detailed summary of the conversation above...
Before providing your final summary, wrap your analysis in <analysis> tags...
Your summary should include the following sections:
1. 会话目标与意图
... (9 板块，见 §3.3)

[输出约束]
输出格式：<analysis>...</analysis> 后 <summary>...</summary>，<analysis> 会被 strip 不落库。
Preserve all opaque identifiers exactly as written (UUIDs/path/URL/hostnames/IDs) — 不缩写、不重构。

[NO_TOOLS trailer]                                     ← compact.md 末尾，双保险
REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.
```

> **[v0.0.54] 不变量：prompt 是纯 directive，无任何占位符**。v0.0.22 实现的 `[可选 merge 提示] {{old_summary}}` 和末尾 `[待压缩内容] {{serialized_transcript}}` 已**整删**——forked buffer 已含 system + messages + reminder（snapshot 单一信息源），prompt 只下「概括上面对话历史」指令；复述 serialized_transcript 等于把对话历史发两遍，违反 forked 不变量（见 §3.0）。

> **关键：压缩指令是 user message 而非 system prompt**，是为了让 forked agent 共享父 session 的 prompt cache（forked agent 继承父 tool set 满足 cache-key match）。

> **[v0.0.22 补 trailer]**：原 v0.0.13 实现只有 preamble 一行（`COMPACT_PROMPT_PREFIX`「NO TOOLS 纯文本」），缺 trailer。CC 注释（`prompt.ts:12-18`）明示：Sonnet 4.6+ adaptive-thinking 模型在 maxTurns:1 下，denied tool call = 无文本输出 = 浪费唯一 turn（4.6 流失率 2.79% vs 4.5 的 0.01%）。**preamble（最前）+ trailer（最末）双保险**强制模型只产文本。

### 3.3 summary 板块（通用化，去 coding specific）

| # | 板块 |
|---|---|
| 1 | 会话目标与意图 |
| 2 | 关键事实与决策 |
| 3 | 已完成的工作 |
| 4 | 错误与修正 |
| 5 | 问题与进展 |
| 6 | 用户消息要点（非 tool result） |
| 7 | 待办 |
| 8 | 当前状态（压缩前一刻的工作，含文件名 / 代码片段若适用） |
| 9 | 续作上下文（直接对齐用户最近请求；任务已结束则不列；含 verbatim quote） |

> 参考 Claude Code 9 板块（Primary Intent / Key Concepts / Files & Code / Errors / Problem Solving / User messages / Pending / Current Work / Next Step），去掉 coding specific（Files & Code → 已完成的工作），通用化为任意 agent 场景。完整 prompt 文本（NO_TOOLS + 9 板块 + 输出约束）由 coder 落 `prompts/content/compact.md`，本 spec 约定结构。

### 3.4 identifier 保留（v0.0.22 吸收）

吸收 OpenClaw `IDENTIFIER_PRESERVATION_INSTRUCTIONS`（调研 §3.3）：compact.md 模板内显式要求「Preserve all opaque identifiers exactly as written (UUIDs / hashes / IDs / hostnames / IPs / ports / URLs / file names) — 不缩写、不重构」。否则压缩后 file path / ULID 漂移会坑 agent。

### 3.5 merge 提示已退场（[v0.0.54] 改纯 directive）

**[v0.0.54] `{{old_summary}}` 占位符已删**。v0.0.22 实现的「老 summary 存在时插入 merge 指令块」机制整体退场——回归 forked 不变量：snapshot 是单一信息源（system + messages + reminder），task message 是纯 directive，**不注入任何 old_summary**。

未来若要支持 §4 增量 merge，应走独立路径（如 forked runner 入参扩展或 context 层 head/summary 选取调整），**不复活 task-message 注入路径**（违反不变量）。

---

## 4. 增量 merge

每次 compact 把 **老 `summary.content` + 新压缩段**（旧 summaryUpTo 之后到新 summaryUpTo）一起喂 forked agent → 产出新 summary（覆盖老）。

- 不做 BASE 全量重压（开销大、没必要）。
- 不做 CC 的 from / up_to 方向变体（我们用 forked agent + 继承父 system prompt 已解决 cache）。
- summary 只增厚（老内容 merge 进新），summaryUpTo 单调推进。

---

## 5. SummaryInfo（瘦身）

```typescript
interface SummaryInfo {
  version: number;            // 每次 compact +1
  summaryUpTo: string | null; // 推进到新游标
  content: string | null;     // <summary> 正文（已 strip <analysis>）
}
```

> **不含 head/tail message ids**——head/tail 原文选取归 assemble（见 §1）。SummaryInfo 只记 summary 内容 + 覆盖范围（summaryUpTo），与视图构造解耦。

---

## 6. 关键约束

### 6.1 不删除原文

compact **不删 store 里的消息**。原文仍在 transcript，assemble 按 head/tail 策略选取 + summary 占位。保证 summary 可回溯、query 仍返回完整历史。

### 6.2 compact 后必须重新 assemble

summary 变了但 snapshot 还是旧的 → agent loop 编排 `compact → assemble`（见 `agent_loop.md`）。

### 6.3 原子性

SummaryInfo 更新应原子（事务），避免 version 推进了但 content 没写入的中间态。

### 6.4 旁路 run 契约（v0.0.13 落地，权威见 `[P0]agent_loop_side_run.md`）

compact 侧契约（caller 视角）：

| 维度 | 契约 |
|---|---|
| 输入 | `manager.sideRun({ sessionId, runKind: 'summary', snapshot, userMessage: 压缩 task message })`（v0.0.204 收编 ForkedAgent 策略类入口为 manager.sideRun thin wrapper） |
| system | [v0.0.16] system 走 messages[0] role=system（不另填 CanonicalRequest.system 字段，见 snapshot_interface §2 v0.0.16 对齐）；旁路 run 继承父 session system prompt |
| 工具 | NO_TOOLS（profile.toolBound=[] for summary）+ prompt 前缀双保险；**sideRun 收的 snapshot.tools 字段**与 main spec.toolDefinitions 同源（保 wire body tools 段前缀一致 → cache 命中，见 `../agent_interface_and_loop/[P0]agent_loop_side_run.md §3`） |
| 产出 | `AgentRun.promise` resolve 为 `{ answer, usage, stopReason }`；compact 从 `answer` 提取 `<summary>` |
| 副作用 | **无**（不碰 session.state / Run / transcript / agent_loop 事件，见 `agent_loop_side_run.md §5`）；**[v0.0.81.compaction_bug] compact_notice 留痕整删**——compact 是纯生产者（只产 summary + accumulateUsage('forked') write），**不再 appendMessages 任何 notice**（见 §2c.1.0） |
| usage | caller 调 `store.accumulateUsage(sid, "forked", usage)`（D2.5；**v0.0.14 accumulate 已激活**，真落 forked 分区 + 递归 sub 上报 + 真发 event；v0.0.204 store 桶名 "forked" 保留作 N:1 映射桶） |
| **[v0.0.55] SessionTaskLock** | caller 在 fork 前后用统一锁（`acquire('compact')` / `markDone` / `markFailed`），见 `../session/[P0]session_task_lock.md` |
| **[v0.0.82] runCompact 签名** | `runCompact(store, taskLock, config, snapshot: ContextSnapshot, sideRunner, triggerMessageId?, triggerUsage?)`——直收 snapshot 对象（caller 深拷贝 main 的 state.snapshot，见 §2b.3）；**不再收 assembleFn 回调**（v0.0.16 历史过度设计已删，runCompact 不重新 assemble）。`CompactCtx.assembleFn` 字段同步删除。 |
| **[v0.0.158+v0.0.204] runner 唯一入口收敛** | `CompactSideRunner` 与 `ConsolidateRunner` 的 input **删 `config: SessionConfig` 字段**——bootstrap 的 `setSideRunner` / `setConsolidateRunner` 闭包内**首行**调 `const config = await agentManager.resolveConfigBySid(input.sessionId)` 自 resolve（`agentManager.resolveConfigBySid` 是所有旁路 run 的**唯一入口**）。`runCompact` 形参 `config` 保留（内部只用 `config.sessionId` 派生 sid + 交给 taskLock，功能不变）。chat/compact/T1 记忆整理都从此入口取 config，无 `task` 参数、无 summary 独立子链。model resolve 语义见 `../providers_and_models/[P0]model_resolve.md §3/§5.1`。 |

**关键变更（vs v0.0.8）**：从裸 `client.call`（不传 system、不传 tools）→ 旁路 run（system 走 messages + NO_TOOLS + 无副作用执行器 + summaryTask 旁路 CAS 包夹）。

> **[v0.0.81.compaction_bug] compact_notice 整删**：旧版（v0.0.16-v0.0.80.t1）compact 成功后 caller 显式向 transcript `appendMessages` 一条 `role=system, metadata.kind=compact_notice` 留痕 message（原 §6.5 描述）+ UI 居中 pill 渲染分支。v0.0.81 判定「无信息量、只增消息数、还污染 assemble 上下文」**整删**（grep 0 残留）。原 §6.5 章节已移除；UI 渲染分支（`specs/ui/components/chat-page/_overview.md §2.5b` + `component-usage-panel.md`）也已同步删除。compact 现在真正零 transcript 副作用（见 §2c.1.0 纯生产者原则）。

---

## 7. 与 assemble / usage 的关系

| 组件 | 关系 |
|---|---|
| `assemble` | compact 后必须调；head/tail 原文选取在 assemble（不在 compact） |
| `usage` | compact 内部 forked agent 调 LLM 的 usage **计入** AccumulatedUsage forked 分区（**v0.0.14 起**；§6.4 契约 D2.5） |

---

## 8. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
