---
type: spec
title: Agent Interrupt / Abort（核心分工 + half-data 收尾 + authority transfer）
priority: P0
status: active
updated: 2026-07-27
since: v0.0.12
---

# Agent Interrupt / Abort（核心分工 + half-data 收尾）

> **与 UI 无关**。本文件定义 agent loop 的中断行为、abort api 的收尾职责、half-data 持久化。
> Session 状态机（state 五态、CAS API）见 `../session/[P0]session_state.md`；Run/Session 字段见 `../session/[P0]session_store.md`；replay buffer 见 `../event/[P0]event_bus.md`；AgentManager 门面路由见 `[P0]agent_manager.md`。

## 1. 核心分工（design §5.1 — 用户最终确认）

> **abort api 负责收尾清理；agent loop 赶紧退出，什么都不管。**

| 角色 | 职责 |
|---|---|
| **abort api**（`AgentManager.abort`） | **唯一收尾执行者** —— 收集 loop 已产出的 half-data 原样保存、clear replay、emit run_stop、状态收尾（不解析/不分类/不补全数据） |
| **agent loop** | 发现被中断 → 阻止任何存储 / 发消息 / 执行工具 / 继续 iteration → **尽快退出，不做任何收尾** |

**硬禁令**（design §11.1）：abort api 是收尾唯一执行者；loop 被中断只退出，不 persistUsage、不 emit run_end、不 ingest、不补 tool_result。

**AbortController 内存对象**（自定义类型，非 Web API）：

```typescript
interface AbortController {
  runId: string;    // 目标 runId，用于 AgentManager.abort() 校验
  aborted: boolean; // 置 true 后 loop 下一个检查点立即读到
  childRegistry?: ChildProcessRegistry; // [v0.0.130.hang] run 级子进程注册表（manager 建 controller 时一并 new；abort 时 killAll 兜底杀在途子进程组，§3.1）
}
```

AgentManager 维护 `Map<"${sid}_${runKind}", AbortController>` 内存 map（agent_manager.md §4）。`activate()` / `sideRun()` 时创建 controller 并注入 loop，`abort()` 时校验 `controller.runId === runId` 后置 `controller.aborted = true`。

> **适用范围**：本 spec（abort 4 步收尾 + half-data 收集）**仅主对话（runKind="main"）**——收尾前提是"有持久化 half-data 需收集保存"。**旁路 run（runKind="summary"/"consolidate"）不适用**：旁路默认无副作用（内存 buffer 不写 store），被中断直接退出无收尾（独立 controller、无 abort 4 步接管），见 `[P0]agent_loop_side_run.md §7`。

### 1.1 Controller 生产-持有-触发（v0.0.16 — 核心数据流）

`AbortController` 是 AgentManager 创建并持有的内存对象 `{ runId: string; aborted: boolean }`：

**生产**：`AgentManager.activate()` / `sideRun()` 在创建 AgentRun 同时 `new` 一个 controller `{ runId, aborted: false }`。controller 与 AgentRun 一一对应、生命周期对齐。

**持有**（同一对象引用，非值拷贝）：
- ① `AgentManager.abortControllers: Map<"${sid}_${runKind}", controller>` — 供 abort 路径查找 + 校验 runId
- ② 统一骨架 `runReActLoop`（main/旁路共用）— 构造时作为 spec 字段注入；loop 高频读 `controller.aborted`（每个副作用边界一次）

> JS 对象引用语义保证：manager 端置 `aborted = true` 后，loop 端下一次读 `controller.aborted` 立即看到 `true`，无需额外通知机制（信号/事件/promise）。

**触发**：caller 调 `AgentManager.abort(sid, runId, modeKey)` → manager 查 `abortControllers.get(${sid}_${modeKey})` 取 controller → 校验 `controller.runId === runId`（不匹配 → reason="run_id_mismatch"）→ 置 `controller.aborted = true` → loop 下一检查点立即读到。

**生命周期**：Run 结束（`run_end` / `interrupted` / `error`）后，AgentManager 调 `cleanupRun(key)` 从 `abortControllers` 和 `agentRuns` 两个 map 中删除条目。loop 已退出（不再持有引用），GC 自然回收 controller 对象。

**caller 不直接持有 controller**——`AgentRun`（caller 视图对象）不暴露 controller 字段（agent_interface.md §2 v1.1）。abort 唯一入口是 `AgentManager.abort()`，Agent interface 上没有 abort 方法（agent_interface.md §1 v1.1）。

## 2. Agent Loop 中断行为

### 2.1 单退出条件（design §5.3）

每个副作用点检查**单一内存条件**，命中即退出：

```
if (controller.aborted) {  // O(1) 内存读，abort() step1 置 true
  // 阻止所有副作用，立即退出（不收尾、不 persistUsage、不 emit run_end、不 ingest）
  return;
}
```

**简化理由**：runId 匹配在 `AgentManager.abort()` 中通过 `controller.runId === runId` 校验（见 §3.1），loop 无需再读 `currentRunId`；持久化 state 不再被 loop 读，仅用于 activate 闸门/崩溃恢复/前端（见 §2.4）。loop 只读一个布尔位。

### 2.2 副作用门控（被中断时全部阻止）

被中断（`controller.aborted === true`）时 loop **禁止**执行以下副作用：

| 副作用 | 中断时行为 |
|---|---|
| `store.appendMessages` / `contextEngine.ingest` | 阻止（不持久化） |
| `bus.emit`（任何 AgentEvent） | 阻止（不发任何事件，含 run_end） |
| 执行工具（tool engine） | 阻止（不发起 tool call） |
| 继续 iteration（下一轮 ①②③④） | 阻止（直接跳出 while） |
| `store.persistUsage` | 阻止（不落 run 级 usage） |

> loop 退出不收尾 = 不做上述任何一项；只 return。所有收尾由 abort api step2-4 完成。

### 2.3 abort 生效点（高频检查，design §5.4）

loop 在所有副作用边界检查 `controller.aborted`（§2.1）：

- 每次 `emit` 前
- 每次 `ingest` 前
- 每个 tool step 前（tool engine 调用前）
- 每次 LLM call 前 + **流式 chunk 循环每个 chunk 检查 controller.aborted**（callLLM 内部，见 base §2.1；webAbort 存 callLLM 局部，命中即 abort + break）
- iteration 边界 ①②③④ 进入处

**高频**：单次 run 内检查点 >= 数十次，保证 abort 延迟 < 一次 LLM/tool/emit 的最小粒度。

### 2.4 内存缓存结论（design §5.5）—— 单一内存源

loop 高频检查只读 **`controller.aborted`**（内存级 O(1) 布尔位），**不读 store、不读 session 持久化 state、不读 currentRunId**。

| 检查目标 | loop 是否读 | 用途 |
|---|---|---|
| `controller.aborted`（内存） | ✅ 高频读 | loop 唯一中断判定 |
| 持久化 session.state（store） | ❌ 不读 | activate 闸门（情况1/2/3 dispatch）+ 崩溃恢复（reconcileOnStartup）+ 前端订阅渲染 |
| 持久化 currentRunId（store） | ❌ 不读 | abort 时 AgentManager 校验目标 run，与 controller.runId 一致即放行 |

**runId 守门移到 AgentManager.abort()**：旧三条件中的 `currentRunId !== self.runId` 是为防"abort 时 loop 已被换"，新模型由 `controller.runId === runId` 校验承担（abort 路径检查一次），loop 不再每个检查点对比 runId。

### 2.5 Authority Transfer（v0.0.207 — 句柄集中吊销，loop 副作用零漏兜底）

**两层防御**：§2.1-§2.4 的「loop 各点查 `controller.aborted` 标志」是**第一层**（loop 主动检查退出），但分散易漏——run-react-loop.ts 的 tool 执行段（③ executeTools 内）**零检查点**（保 tool_use/tool_result 配对完整，避免 dangling 半轮，见 `[P0]agent_loop_unified.md §2`）。中断落在 tool 执行段时 loop 仍会跑完 emit tool_result + ingest，与 abort api 的 fillInterruptedToolResults 双写 → 同 toolCallId 双 tool_result（prod k3 tokenization failed 根因）。

**第二层（v0.0.207 authority transfer）**：abort api step1 在 `controller.aborted=true` 那一刻，**主动吊销 loop 持有的对外副作用句柄**——loop 调这些句柄 = no-op，loop 代码零侵入。loop 唯一职责 = 感知 aborted → break；副作用唯一权威 = abort api。

> 为什么是句柄集中吊销（不是 loop 各点加检查）：单一吊销点（`loop.revokeSideEffects()`）= 单一权威不会漏；loop 代码零侵入（调用照旧但句柄已失效）。loop 各点自觉查标志分散易漏——某个 emit/ingest 点忘查就破。

**实现机制**（`app/server/src/agent/revocable-side-effects.ts`）：JS Proxy 包装。
- `wrapRevocableEmitCtx(ctx)` → `{ ctx, revoke }`：ctx.bus 是原 bus 的 Proxy，revoke 后 `emit`/`clearReplay` 命中返 noop，其他属性透传。
- `wrapRevocableContextEngine(ce)` → `{ ce, revoke }`：ce 是原 ce 的 Proxy，revoke 后 `ingest` 命中返 `() => Promise.resolve()`（async noop，保 `await` 安全），其他方法（`assemble`/`getCleanSnapshot`/`compact`/...）透传。
- revoke 仅置内部 `revoked` 标志，**不改原对象引用**——abort api 直发 `bus.emit`/`bus.clearReplay`/`store.appendMessages` 走原对象豁免。
- 装配点：`buildRunDeps()`（`build-run-deps.ts`）main + 旁路都包；组合 revoke `() => { emitWrap.revoke(); ceWrap.revoke(); }` 传 `RunLoopHandle` 第 4 参；旁路不被调 revoke（无 4 步收尾，无副作用）。

**吊销与豁免边界（核心约束 — 硬约束）**：

| 句柄 | loop 调用方 | abort api 调用方 | 吊销后行为 |
|---|---|---|---|
| `wireEmitCtx.bus.emit` | `publish(ctx, ...)` 经 `ctx.bus.emit` | `emitInterruptedRunStop` 直接 `bus.emit`（不经 wireEmitCtx）| loop emit 全 no-op；abort api emit 豁免 |
| `wireEmitCtx.bus.clearReplay` | `refreshSnapshotOnly` 经 `emitCtx.bus.clearReplay` | step3 直接 `bus.clearReplay` | loop clearReplay no-op；abort api 豁免 |
| `wireContextEngine.ingest` | `ingestMainAndAssemble`/`ingestToolResults` 经 `ce.ingest` | `fillInterruptedToolResults` 走 `store.appendMessages`（不经 ce.ingest）| loop ingest no-op；abort api 写入豁免 |
| `wireContextEngine.assemble`/`getCleanSnapshot` | loop 读路径 | — | **不吊销**（透传，read-only 无副作用）|

**吊销点单一**（`abort-finalize.ts:abortRun()` 主对话分支）：`controller.aborted=true` → `void childRegistry?.killAll()` → **`loop.revokeSideEffects?.()`**（`abort-finalize.ts:102`）→ `await waitForLoopExit(loop, 2000)` → step2-4。旁路分支（`runKind!=='main'`）不调 revoke（无 4 步收尾、in_memory 写无副作用）。`LoopHandle.revokeSideEffects` 设为可选方法，旁路现有 3 参构造不受影响（revokeFn 缺省 no-op）。

> **不解决 IO 取消**：per-call AbortController（`engine.ts:260`）不接 run controller → tool fetch IO 不响应 abort。authority transfer 保证「loop IO 跑完后写 result/emit 已被吊销 = no-op」即可修本 bug；IO 取消另立版本（per-tool ctx.signal plumbing 范围大）。

## 3. Abort API 4 步流程（AgentManager.abort — 收尾唯一执行者）

`POST /session/:id/abort` → AgentManager.abort(sessionId, runId, modeKey) 异步执行收尾，**返回 202**（异步收尾，不阻塞 HTTP）。

**forked（modeKey != "current"）**：不走 4 步——直接置 `controller.aborted = true`，forked loop 下一检查点退出，无 half-data 持久化。4 步仅主对话（modeKey="current"）。

### 3.1 step1：取 controller + 校验 runId + CAS markInterrupting + controller.aborted=true

```
1a. 从 AgentManager.abortControllers 取 controller（key = `${sessionId}_${modeKey}`）
1b. 校验 controller.runId === runId（不匹配 → 返 { accepted:false, reason:"run_id_mismatch" }）
1c. 主对话（modeKey="current"）：CAS markInterrupting(runId) — 持久化 state=interrupting（用于 activate 闸门 + 崩溃恢复 + 前端）
    forked（modeKey="summary"/"memory_extract"）：跳过 CAS（forked 不参与五态机）
1d. 置 controller.aborted = true — 内存位（loop 下一个检查点立即读到，与被中断必达域等价）
1e. [v0.0.130.hang] fire-and-forget `void controller.childRegistry?.killAll()` — 杀本 run 登记的所有子进程组
    （主对话 & forked 两分支都调；在 step2 等 loop 退出之前触发）
```

> CAS 保证并发 abort 只有一个胜出。`controller.runId` 校验保证只 abort 目标 run——若 runId 不匹配（已结束或被新 activate 覆盖），直接返不回滚 controller。
>
> **[v0.0.130.hang] 为何 abort 要 killAll**：仅置 `aborted=true` 对**卡在 hung tool 的 loop 无效**——若 bash 子进程（尤其孙进程继承 pipe）不退出，`tool.run` 永不 resolve，loop 到不了下一检查点，`aborted` 白置。`killAll()` 杀在途子进程组（`abort-finalize.abortRun`，`aborted=true` 后立即调）→ pipe 释放 → `tool.run` resolve → loop 抵达检查点读到 `aborted` 退出 interrupted。fire-and-forget（killAll 全 catch 不抛）不阻塞后续收尾。`childRegistry` 由 `bash` 等 spawn 型工具经 `ctx.childRegistry` 登记（`../tools/[P0]tool_execution_engine.md §4.2` + `../tools/[P0]bash_tools.md §4.5`）。单 tool 超时另走 `ctx.signal.abort()` 自清，**不**经 killAll。

### 3.2 step2：等 loop 退出 → 收集 loop 已产出的 half-data → 原样保存

```
2a. await loop 退出（loop 读到 controller.aborted 后在下一检查点退出，通常很快；timeout 兜底可短，50ms 量级——目的是确保 controller 已生效、loop 有机会退出，不是等 run_end）
2b. 收集 loop 本次 run 已产出的 half-data（已 emit 的事件流 / 已 ingest 的 message——具体形态由 loop 生产时决定，abort api 不解析、不分类）
2c. 原样保存到 store（store 自身保证 transcript 有序，abort api 不介入写锁协调）
```
  
### 3.3 step3：clearReplay(group)

```
3. bus.clearReplay(`session_id:${sessionId}_amt:current`)   -- 清半截 replay buffer（event_bus §2.2/§6）
   -- 之后新订阅者从 store 读 interrupted message，不会 replay 半截事件流
```

### 3.4 step4：emit run_stop(interrupted) + state=interrupted

```
4a. emit run_end(stopReason="interrupted")     -- 前端 run-finish 据此渲染「已中断」、隐藏 loading
4b. CAS markInterrupted()                      -- state=interrupting → interrupted + running=false
4c. emit session_status_update(state=interrupted)  -- 见 session_event.md（新增 type）
```

## 4. Half-data 收集（原样保存，不加工）

**核心原则**：abort api 是搬运工，不是加工者。loop 已 emit / 已 ingest 的数据 = 已发生的副作用，abort api 收集后**原样保存**到 store。

- **数据形态由 loop 决定**：partial text、已完整的 message、悬空 tool_call 等——都是 loop 生产时的产物，abort api 不解析、不分类、不补全、不改写。
- **顺序由 store 保证**：store 自身保证 transcript 有序（ULID），abort api 不介入写锁协调。

> 外部副作用（工具执行已写文件 / 已执行命令）不可回滚——这是系统行为声明，abort api 不回滚已发生的外部副作用。

> **协议兜底归 assemble 视图层，非 abort api 加工**：loop 被中断时若 tool_call 已 ingest 但 tool_result 未产出（悬空），原样存入后下次 assemble 会触发协议报错（anthropic 要求 tool_call 必须配对 tool_result）。**协议合法性由构建视图（assemble pipeline）保证**——assemble 时遇悬空 tool_call 容错处理（补 interrupted result 或跳过）。abort api 仍是搬运工，不承担此职责。现有实现由 abort 收尾时的补全（finalizeHalfData）承担此视图层兜底，未来可下沉到 assemble pipeline。

## 5. clear replay 竞态（design §5.6 — B 方案，已消除）

abort step3 `clearReplay(group)` 是 group 级全清。**interrupting 时 activate 走循环等待**（session_state §4.1 case3），无法启动新 loop → clear replay 期间无其他 loop 写 buffer → 安全。无需额外处理。

## 6. AgentManager.abort 接口

```typescript
/**
 * 中断指定 (sessionId, modeKey) 的 run（异步收尾）。
 * - key = `${sessionId}_${modeKey}`，从 abortControllers 取 controller
 * - 返回 202（HTTP 层），实际收尾 4 步异步进行（仅主对话 modeKey="current"）
 * - forked (modeKey != "current")：直接置 controller.aborted=true，不走 4 步
 * - 快速校验失败返 { accepted:false, reason }：
 *   - "no_active_controller" — 无对应 controller（已结束或未启动）
 *   - "run_id_mismatch" — runId 不匹配 controller.runId（已结束或被新 activate 覆盖）
 *   - "cas_failed" — CAS markInterrupting 失败（仅主对话；并发 abort 另一个胜出）
 * - 收尾完成后 emit run_end(interrupted) + session_status_update(interrupted)
 */
abort(sessionId: string, runId: string, modeKey: string): Promise<AbortResult>;
```

`AbortResult` 定义见 `[P0]agent_interface.md §3`：

```typescript
interface AbortResult {
  accepted: boolean;
  reason?: string;            // "run_id_mismatch" / "no_active_controller" / "cas_failed"
}
```

## 7. 不变量（design §11）

1. **abort api 是收尾唯一执行者；loop 被中断只退出，不做任何收尾**。
2. **loop 中断条件简化为 `controller.aborted`**（单一内存源，O(1) 布尔读），不读持久化 state 或 currentRunId。
3. **loop 高频检查用 `controller.aborted`（内存级 O(1)）；持久化 state 仅用于 activate 闸门/崩溃恢复/前端**，不再被 loop 读。
4. **外部副作用不可回滚**。
5. **abort step1 CAS 保证并发 abort 只有一个胜出 + controller.runId 匹配保证只 abort 目标 run**。（旧三条件中 `currentRunId !== self.runId` 由 `controller.runId === runId` 校验承担，loop 不再检查。）
6. **forked loop 被中断不参与五态机、不走 4 步收尾**：直接置 `controller.aborted = true` → forked loop 下一检查点退出（无 half-data 需持久化）。仅主对话（runKind="main"）走完整 4 步收尾。
7. **[v0.0.207] Authority Transfer — 双层防御**：loop 检查 `controller.aborted` 是第一层（§2.1-§2.4）；abort api step1 `controller.aborted=true` 后**主动吊销 loop 对外副作用句柄**（`loop.revokeSideEffects()`，单一吊销点，在 `waitForLoopExit` 之前）是第二层兜底——loop emit/ingest/clearReplay 吊销后 no-op，副作用唯一权威归 abort api。**吊销/豁免边界见 §2.5 表**：abort api 直发 bus.emit + store.appendMessages 走原对象豁免；loop 经 wireEmitCtx/wireContextEngine 走 Proxy 被拦截。

> error 态收尾同 interrupted 理念：收集 loop 已产出数据 + 原样保存，具体形态不规定。

## 8. 边界

| 零件 | 归属 |
|---|---|
| 中断行为 + abort 4 步 + half-data 收集（原样保存） + loop 退出条件 | 本文件 ✅ |
| abort 签名 (sessionId, runId, modeKey) + controller key `${sid}_${modeKey}` | 本文件 §3.1/§6 ✅ |
| AgentManager 门面 + abortControllers/agentRuns map + forked abort | `[P0]agent_manager.md` |
| Session 状态机（state/CAS API/转换表） | `../session/[P0]session_state.md` |
| Session/Run 字段（state/running/currentRunId/Run.status） | `../session/[P0]session_store.md` |
| AgentEvent run_end(stopReason=interrupted) | `[P0]agent_event.md` |
| SessionEvent session_status_update | `../session/[P0]session_event.md` |
| replay buffer / clearReplay | `../event/[P0]event_bus.md §2.2/§6` |
| 主循环结构（①②③④，runReActLoop 统一骨架） | `[P0]agent_loop_eager_drain.md §4` |
| 旁路 run 中断行为（无收尾、直接退出） | `[P0]agent_loop_side_run.md §7` |
| abort HTTP API（POST /session/:id/abort） | `specs/api/overall/04-agent-session.md` |

## 9. （版本史见 `log.md`）