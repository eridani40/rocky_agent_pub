---
type: spec
title: Agent Manager（session 级门面 + 状态持有者）
priority: P0
status: active
updated: 2026-07-25
since: v0.0.8
---

# Agent Manager

> 参见：`[P0]agent_interface.md`（v0.0.40 单 run 契约 + RunSpec + AgentRun + groupKey 命名 + runKind vs scopeId）、`[P0]agent_loop_unified.md`（统一骨架 + LifecyclePort 契约 + buildRunDeps 装配表）、`[P0]agent_event.md`（AgentEvent）、`[P0]agent_loop_eager_drain.md`（main 不变量）/ `[P2]agent_loop_lazy_drain.md`（lazy future）/ `[P0]agent_loop_side_run.md`（旁路 run 不变量）、`[P0]agent_interrupt.md`（abort 4 步收尾 + half-data）、`../event/[P0]event_hub.md`（EventHub）、`../session/[P0]session_state.md`（五态机 + CAS + activate 三情况）、`../session/[P0]session_store.md`（Session/Run 字段）、`../session/[P0]session_type_profile.md`（profile 配置层；scopeId=canonicalId 纯拼接，`[P0]agent_scope_router.md` 已废止）。

## 1. 设计理念

AgentManager 是 **session 级别的门面 + 状态持有者**，本身不执行 ReAct——所有推理经 `run(spec, loop)` 进入统一 `runReActLoop`（见 `[P0]agent_loop_unified.md`）。Manager 只做**路由 + 句柄管理 + 中断收尾**。

> **单 loop 入口**：`manager.run(spec: RunSpec, loop: LoopHandle) → Promise<AgentRun>` 是**唯一 loop 启动入口**（立即返回句柄）。两个入参：`spec`（身份 + RunSpec 字段 + LifecyclePort + emit，由 `buildRunDeps` 单装配产出，profile 驱动）+ `loop`（loop 句柄 `{ start(): Promise<void>|Promise<RunResult>; isRunning(): boolean }`，同一装配产出）。`activate(sid)` / `sideRun(opts)` 降为构造 `RunSpec` + `loop` 的 **thin wrapper**（门面签名不变，内部组装后调 `run(spec, loop)`）。`enqueue/cancel/deliverTo` 是 inbox ops（非 loop 入口，原样保留）。策略类（EagerDrainAgent / LazyDrainAgent / ForkedAgent）及 `agentByMode()` 已退役（见 `[P0]agent_interface.md §1.1`）。
>
> **v0.0.204 文件拆分（文件体量治理，agent-manager.ts ≤450 行）**：manager 主类只留门面 + 三 map 持有 + CAS/订阅/abort；两个协作者文件——
> - **`agent-side-run.ts`**（`executeSideRun(env, opts)`）：旁路 run 启动编排——并发检查 + controller 创建 + snapshot 克隆 + effectiveKind 派生（host kind + runKind；`config.kind` 缺失时兜底 `playground-rocky:parent`——tier2 三 caller 的 SessionConfig 无 kind，兜底 kind 对应 consolidate profile toolBound=[skill_manage,memory_manage]，与 tier2 snapshot.tools 交集正确）+ `buildRunDeps` 装配 + `startRunAndTrack` 启动。
> - **`agent-run-registry.ts`**（`startRunAndTrack` + `createAgentRunShell` / `attachRunPromise` / `cleanupRun` / `makeErrorRun` / `loopKey` / `runMapKey`）：三 map（agentRuns/abortControllers/loops）管理 + AgentRun shell 构造 + promise 绑定 + cleanup，全部无状态函数（操作传入的 Map）。

### 核心职责

- **run(spec, loop)** ★ 唯一 loop 启动入口：注册三 map（agentRuns/abortControllers/loops）+ `void loop.start()` 异步启 `runReActLoop`（见 `[P0]agent_loop_unified.md §2`）+ 绑 `agentRun.promise` + `cleanupRun`（实现已抽 `agent-run-registry.ts startRunAndTrack`）。main 经 session 五态机 CAS markRunning（在 activate wrapper 内）；旁路不碰 session state。并发检查 / CAS / `agentToolContext` 注入全留在 wrapper，`run` 不改语义。
- **enqueue**：写 inbox（独立存储），不触发推理。原样保留（session 职责，非协议）。
- **activate(sid)**：thin wrapper → 构造 main `RunSpec` + `loop`（经 `buildRunDeps` main 分支：runKind='main', scopeId=canonicalId, maxIter=profile.maxIterDefault??25）→ 调 `run(spec, loop)`。按 session 持久化 state 三情况 dispatch（见 session_state.md §4.1）。**[v0.0.102] activate 失败走 error shell**：config resolve 失败 / session not found / buildRunDeps throw 时，catch 落 `makeErrorRun(sid, 'main', errObj)`（**透传原 Error**，非字符串化），返 `state==='error'` 的 AgentRun（非 throw——防 unhandled rejection 击穿 Bun 进程）。caller handler 读 `agentRun.error instanceof ModelNotConfiguredError` 返语义化 400，其余 500（详见 §2 activate + §4 伪代码 + `specs/api/overall/04-agent-session.md §3.2 error shell`）。
- **sideRun(opts)**：thin wrapper → 委托 `agent-side-run.ts executeSideRun`——构造旁路 `RunSpec` + `loop`（经 `buildRunDeps` 旁路分支：runKind=opts.runKind, scopeId=canonicalId, allowedTools/maxIter 从 profile 派生, toolDefinitions=opts.snapshot.tools）→ `startRunAndTrack` 启动。按 `(sid, runKind)` 拒同 kind 并发。
- **abort**：按 `(sid, runKind)` 查 controller → 校验 `controller.runId === runId` → CAS `markInterrupting`（主对话才走五态机）→ 置 `controller.aborted = true` → 4 步异步 finalize（见 agent_interrupt.md §3）→ `cleanupRun`。
- **cancel**：写一条 cancel 条目到 inbox（不删原 message），由 loop drain 同批配对作废。
- **subscribe(sid, runKind)**：单 key 订阅，转 `hub.sub("agent_loop", "session_id:<sid>_amt:<runKind>")`（runKind 缺省 'main'）。

### 核心原则

- **Manager 管路由 + 状态，不写 ReAct 执行细节**——执行细节归统一骨架 `runReActLoop(spec)`（`[P0]agent_loop_unified.md`）。
- **单 loop 启动入口 `run(spec, loop)`**——`activate` / `sideRun` 是 thin wrapper（构造 spec + loop 后调 run/startRunAndTrack）。协议只剩 `run`（见 `agent_interface.md §1.2`）。
- **activate 闸门 = session 持久化 state**（session_state.md §4.1 / 板块 11 §11）——Manager 只**读** state 做 dispatch，不写 state；state 由 main wrapper（CAS markRunning）和 abort（CAS markInterrupting/Interrupted）维护。旁路 run 不参与五态机。
- **abort 是收尾唯一执行者；loop 被中断只退出，不做任何收尾**（agent_interrupt.md §1）。
- **同 runKind 不并发**：`agentRuns.get("${sid}_${runKind}")?.state === "running"` → 拒。
- **所有事件经 EventHub（topic=`agent_loop`, group=`session_id:<sid>_amt:<runKind>`）流转**（agent_interface.md §4）；`subscribe` 是 `hub.sub` 的薄封装。

---

## 2. 接口定义

```typescript
interface AgentManager {
  /**
   * ★ 唯一 loop 启动入口。立即返回 AgentRun（含 .promise）。
   *
   * 两入参（activate/sideRun wrapper 装配后传入）：
   *   - spec: RunSpec（身份 + RunSpec 字段 + LifecyclePort + emit，buildRunDeps 产出，profile 驱动）
   *   - loop: LoopHandle（{ start(), isRunning() }，同一 deps 装配产出）
   *
   * run 本身只做：注册三 map（agentRuns/abortControllers/loops）+ `void loop.start()` 异步启
   * runReActLoop（见 [P0]agent_loop_unified.md §2）+ 绑 agentRun.promise + cleanupRun
   * （实现抽 agent-run-registry.ts startRunAndTrack）。
   *
   * 并发检查 / 五态机 CAS / agentToolContext 注入全留在 activate/sideRun wrapper，run 不做这些
   * （故 run 不改 wrapper 语义）。main 的 loops map 注册供 abort-finalize 轮询用；旁路不注册 loops。
   *
   * caller 想等结果 → await run.promise；不等 → 忽略 run.promise。
   * caller 一般不直接调 run——走 activate / sideRun thin wrapper（构造 spec + loop 后调 run）。
   */
  run(spec: RunSpec, loop: LoopHandle): Promise<AgentRun>;

  /**
   * 入队消息到 session inbox（独立存储，不写主对话 store）。
   * - eager/lazy ✅；旁路 run → throw NotSupportedError（旁路不消费 inbox）
   * - 不触发推理。为每条消息分配 enqueueId + 注入 enqueuedAt，emit message_enqueued（group=`session_id:<sid>_amt:main`）
   * - 可在 activate 之前或之后调用；loop 运行中追加，下一轮 drain 自动消费
   *
   * [v0.0.31 去 config 重构] 签名从 `enqueue(config, messages)` 改为 `enqueue(sessionId, messages)`。
   *   manager 内部按 sessionId 获取 config（见 §3.1.1 resolveConfigBySid 方案 A）；详见 §8 v6.0。
   */
  enqueue(sessionId: string, messages: Message[]): Promise<string[]>;

  /**
   * 激活 session 的主对话 run（按 state 三情况 dispatch）。
   * - **thin wrapper**：内部经 `buildRunDeps`（main 分支）构造 RunSpec + LoopHandle（runKind='main', scopeId=canonicalId, maxIter=profile.runShape.maxIterDefault??25）→ 调 `run(spec, loop)`。
   * - 情况 1 (running)             → 返回现有 AgentRun（`agentRuns.get("${sid}_main")`，同一对象引用）
   * - 情况 2 (idle/interrupted/error) → CAS markRunning → 创建新 AgentRun(runKind='main') + controller → 启动 runReActLoop → 返回新 AgentRun
   * - 情况 3 (interrupting)        → 循环等 100ms 重读 state → 转情况 1/2
   * - **[v0.0.102] 失败 = error shell**：config resolve 失败（含 `resolveModel` 跑空抛 `ModelNotConfiguredError`）/ session not found / `buildRunDeps` throw → catch 落 `makeErrorRun(sid, 'main', errObj)` 返 `state==='error'` 的 AgentRun（**透传原 Error**，不字符串化）。caller 读 `agentRun.error` 识别语义化错误决定 HTTP 码（见 §4 伪代码 + `specs/api/overall/04-agent-session.md §3.2`）。
   * @returns AgentRun（runKind='main'）。caller 可 `await run.promise` 等 run_end，或 subscribe(sid) 拿事件流
   * @note 调用方无需根据 status 分支——返回值始终是「当前句柄」，已废弃 ActivateResult 区分；但需读 `state`/`error` 区分正常 run vs error shell
   *
   * [v0.0.31 去 config 重构] 签名从 `activate(config)` 改为 `activate(sessionId)`。详见 §8 v6.0。
   */
  activate(sessionId: string): Promise<AgentRun>;

  /**
   * ★ 统一投递入口（a2a / 外部给 session 发消息）。v0.0.31 正式去 config 重构 + enrich 落地。
   *
   * - 只需 sessionId + message（不碰 config——内部按 sessionId 获取 config，见 §3.1.1）
   * - 内部链路：① enrichForInbox(message, store)（a2a 形态补全，见 [P0]agent_inbox_enqueue.md §2.5）
   *             ② enqueue(sessionId, [enriched])（写 inbox + emit message_enqueued）
   *             ③ activate(sessionId)（启动 loop）
   * - 同步等结果：`await (await deliverTo(sid, msg)).promise` → RunResult（复用 AgentRun.promise）
   * - fire-and-forget：忽略返回的 run（如 send_message 工具）
   *
   * [v0.0.31 重构完成] enqueue/activate 去 config 后，deliverTo 不再 resolveConfig 对外暴露（内部封装）。
   *   所有"给 session 发消息"的入口统一收敛到 deliverTo：
   *   - spawn 首任务（spawn-action.ts:125 已走 deliverTo）
   *   - a2a send_message（send-message-tool.ts:111 已走 deliverTo）
   *   - user POST /messages（v0.0.31 改走 deliverTo，见 §3.2）
   *   - 心跳激活 / 测试 fixture（v0.0.31 改走 deliverTo 或 enqueue(sessionId)+activate(sessionId)）
   *   详见 specs/tech/multi_agent/[P1]subagent_derivation.md §4.1。
   */
  deliverTo(sessionId: string, message: Message): Promise<AgentRun>;

  /**
   * 启动一个旁路 run（runKind=summary/consolidate，基于 snapshot + userMessage 内存 loop，不写 inbox / 不动主对话 transcript）。
   * - **thin wrapper**：委托 `agent-side-run.ts executeSideRun`——并发检查 + controller + snapshot 克隆 + effectiveKind 派生 + `buildRunDeps`（旁路分支）构造 RunSpec + LoopHandle → `startRunAndTrack` 启动（见 §1 文件拆分）。
   * - 同 (sid, runKind) 已 running → throw "already_running_in_this_mode"（agent_interface.md §6）
   * - allowedTools / maxIter / toolDefinitions 全由 profile + snapshot 派生（caller 不传；profile.toolBound / profile.runShape.maxIterDefault / snapshot.tools）
   * - 创建 AgentRun + AbortController，注册到 agentRuns + abortControllers
   * - 启动后异步执行，run 结束自动 cleanupRun(key)
   * @returns AgentRun（runKind 由 options 给定，"summary" / "consolidate"）
   */
  sideRun(options: SideRunOptions): Promise<AgentRun>;

  /**
   * 中断指定 (sid, runKind) 的 run（4 步异步收尾）。
   * - key = `${sessionId}_${runKind}`，从 abortControllers 取 controller
   * - 校验 controller.runId === runId（不匹配 → reason="run_id_mismatch"）
   * - 主对话（runKind='main'）：CAS markInterrupting → 置 controller.aborted=true → 4 步 finalize（详见 agent_interrupt.md §3）
   * - 旁路（runKind='summary'/'consolidate'）：直接置 controller.aborted=true → 内存 loop 退出（旁路无 half-data 收尾，agent_loop_side_run.md §7）
   * - 返回 202 语义：同步返 accepted 快速校验，异步 finalize 收尾
   */
  abort(sessionId: string, runId: string, runKind: RunKind): Promise<AbortResult>;

  /**
   * 取消一条已 enqueue 但 loop 尚未消费的消息。
   * - eager/lazy ✅；旁路 run → throw NotSupportedError
   * - 不删 inbox，append 一条 kind="cancel" 条目（cancelFor=enqueueId）
   * - 由 loop drain 同批配对作废，emit enqueued_message_canceled；详见 [P0]agent_inbox_enqueue.md §5
   */
  cancel(sessionId: string, enqueueId: string): Promise<void>;

  /**
   * 订阅指定 (sid, runKind) 的事件流（单 key；runKind 缺省 'main'）。
   * - 等价于 hub.sub("agent_loop", `session_id:${sessionId}_amt:${runKind}`)
   * - replayable bus 先回放 buffer，再接新事件
   * - 多 runKind 并发观测需多次 subscribe（如同时订阅 "main" + "summary"）
   */
  subscribe(sessionId: string, runKind?: RunKind): AsyncIterable<AgentEvent>;
}
```

### 2.1 SideRunOptions

```typescript
interface SideRunOptions {
  sessionId: string;                // 观测/groupKey 用
  runKind: RunKind;                 // 必填 'summary' | 'consolidate'（决定 scopeId/groupKey/agentRuns key）
  config: SessionConfig;            // caller resolve 的 session config（kind 可缺——tier2 三 caller 无 kind，
                                    //   executeSideRun 兜底 playground-rocky:parent，见 §1 文件拆分）
  userMessage: Message;             // 本次 run 的任务消息（纯 directive，旁路不变量 §1）
  snapshot: ContextSnapshot;        // 必填（旁路核心，保 KV 缓存命中；生产三路径 caller 均非空）
  emit?: boolean;                   // 默认 true（旁路默认发事件到独立 group）
  observability?: ObservabilityAdapter;
  triggerMessage?: Message;         // 仅取 id 写旁路 trace metadata（不进旁路 buffer）
  triggerUsage?: ContextWindowUsage;// 触发时 context window 用量（写 trace metadata.triggerUsage）
  // allowedTools / maxIter / toolDefinitions 不在 options——由 buildRunDeps 从 profile
  //   （toolBound / runShape.maxIterDefault）+ snapshot.tools 派生。
  // 注：controller 由 executeSideRun 内部创建并注入 LoopHandle，caller 不传也不持有；
  //     中断必经 manager.abort(sid, runId, runKind)。
}
```

### 2.2 AgentRun / AbortResult / SessionConfig

`AgentRun` / `AbortResult` 见 `[P0]agent_interface.md §2-§3`。`SessionConfig` 沿用原定义：

```typescript
interface SessionConfig {
  sessionId: string;                    // 绑定的 session ULID
  systemPrompt: string;
  client: LlmClient;                    // LLM 运行时句柄
  tools?: Tool[];
  maxIterations?: number;               // ReAct 最大迭代数，默认 25
  permissionRules?: PermissionRule[];
  middlewares?: MiddlewareBase[];
  observability?: ObservabilityAdapter;
  loopMode?: "eager-drain" | "lazy-drain";  // 默认 eager-drain（历史字段，activate 固定走 buildRunDeps main 分支）
}
```

### 2.3 manager 内部按 sessionId 获取 config（去 config 重构核心 · v0.0.31）

`enqueue(sessionId)` / `activate(sessionId)` / `deliverTo(sessionId, msg)` 对外去 config 后，manager 内部需按 sessionId 获取对应 SessionConfig。**方案：每次调用 `resolveConfigBySid(sessionId)`（复用 `bootstrap.ts:300 setResolveConfig` 注入的 `buildSessionConfigFromDeps`），无 cache**——无失效问题（每次取最新 session 持久字段），性能开销可接受（非高频热路径）。

#### 内部获取伪代码（resolveConfigBySid）

```
class AgentManagerImpl:
  // bootstrap.ts:300 setResolveConfig 注入（v0.0.28 已铺路）
  resolveConfig?: (sessionId: string) => Promise<SessionConfig>

  // 内部 helper：去 config 重构后所有需 config 的方法调本函数
  private async resolveConfigBySid(sessionId: string): Promise<SessionConfig>:
    if !this.resolveConfig:
      throw Error("AgentManager: resolveConfig not injected (bootstrap 未注入)")
    return this.resolveConfig(sessionId)              // 内部调 buildSessionConfigFromDeps

  // —— enqueue（去 config）——
  enqueue(sessionId, messages):
    config = await this.resolveConfigBySid(sessionId)  // 仅取 sessionId 用（enrich 在 deliverTo 层；裸 enqueue 不 enrich）
    enqueueIds = inbox.append(sessionId, messages)     // 注入 enqueuedAt
    for each (id, msg):
      bus.emit(`session_id:${sessionId}_amt:current`, { type:"message_enqueued", enqueueId:id, ... })
    return enqueueIds

  // —— activate（去 config）——
  activate(sessionId):
    config = await this.resolveConfigBySid(sessionId)
    // buildRunDeps({config, ...}) → RunSpec + LoopHandle → run(spec, loop)
    // ... 后续与旧 activate(config) 一致（用 config.sessionId 即 sessionId）

  // —— deliverTo（去 config + enrich）——
  deliverTo(sessionId, message):
    enriched = await enrichForInbox(message, this.store)    // [P0]agent_inbox_enqueue.md §2.5
    await this.enqueue(sessionId, [enriched])
    return this.activate(sessionId)
```

> **注**：方案 A 下 `resolveConfigBySid` 每次重建 client/tools，与 v0.0.28 deliverTo wrapper 内部的 `deps.resolveConfig(sessionId)` 行为一致（已验证可行）。性能无显著回退。

### 2.4 调用方收敛（去 config 重构）

所有"给 session 发消息"的入口统一收敛到 `deliverTo(sessionId, msg)`（user POST /messages、spawn 首任务、a2a send_message、心跳激活）。各调用方不再自行 buildSessionConfigFromDeps，manager 内部 resolveConfigBySid 获取。sideRun 不消费 inbox，与去 config 无关。

---

## 3. 典型调用流程

### 3.1 主对话（eager-drain）

```typescript
const config: SessionConfig = { sessionId, systemPrompt, client, loopMode: "eager-drain", ... };
await manager.enqueue(sessionId, [userMessage]);               // 入队（不触发推理）
const run = await manager.activate(sessionId);                 // → AgentRun(runKind='main')
// run 始终是 "${sid}_main" 的当前句柄：
//   - 已在跑：返回正在跑的那个 AgentRun（同一对象引用）
//   - 新建：返回新 AgentRun
const stream = manager.subscribe(sessionId);                   // 订阅主对话事件流（runKind 缺省 'main'）
for await (const event of stream) {
  if (event.type === "run_end") break;
}
// caller 也可直接 await run.promise 拿 RunResult（不需事件流时）
```

### 3.2 旁路 compact（summary）

```typescript
const snapshot = contextEngine.snapshot();
const run = await manager.sideRun({
  sessionId,
  runKind: "summary",
  config,                      // caller resolve 的 SessionConfig（含 kind）
  userMessage: { role: "user", content: [{ type: "text", text: compactPrompt }] },  // 纯 directive
  snapshot,                    // 必填；toolDefinitions 由 buildRunDeps 取 snapshot.tools
  emit: true,
});
// 看进度
const stream = manager.subscribe(sessionId, "summary");
// 拿结果（旁路 run.promise 直接 resolve RunResult）
const result = await run.promise;
// result.answer 即压缩后的总结；caller（runCompact）随后 setSummary + accumulateUsage 总量口径
```

### 3.3 中断

```typescript
// 中断主对话
await manager.abort(sessionId, run.runId, "main");
// → controller.aborted=true → loop 下一个检查点立即退出 → finalize 4 步 → run_end(stopReason=interrupted)

// 中断旁路 summary（不影响主对话）
await manager.abort(sessionId, summaryRun.runId, "summary");
// → 旁路 controller.aborted=true → 内存 loop 直接退出（旁路无 half-data 收尾）
```

返回 `AbortResult`：`{ accepted:true }` 表示快速校验通过、异步收尾启动；`{ accepted:false, reason }` 表示拒绝（`no_active_controller` / `run_id_mismatch` / `cas_failed`）。

---

## 4. AgentManagerImpl（伪代码）

```
class AgentManagerImpl implements AgentManager:
  // 无策略类实例——activate/sideRun 是 thin wrapper，
  //   activate 内经 buildRunDeps 装配 RunSpec + LoopHandle 后调 run(spec, loop)；
  //   sideRun 委托 agent-side-run.ts executeSideRun（编排 + 装配 + startRunAndTrack）

  // —— 基础设施 ——
  hub: EventHub                                  // hub.sub/sub-multi/registerTopic
  bus: EventBus                                  // = agent_loop topic 的 bus（构造时 hub.registerTopic）
  store: SessionStore
  stateStore: SessionStateStore                  // session 持久化 state CAS
  inbox: InboxStore

  // —— 内存状态（key = `${sid}_${runKind}`，runMapKey）——
  agentRuns:        Map<string, AgentRun>                       // 运行中 + 完成后 cleanup 即删
  abortControllers: Map<string, { runId, aborted: boolean }>    // 同 key
  loops:            Map<string, LoopHandle>                    // 仅主对话 (runKind='main') 缓存 loop 句柄，供 finalize 等待退出

  // —— agentByMode 已退役——activate/sideRun 同走 buildRunDeps 单装配（profile 驱动）——

  // —— enqueue（去 config：签名 sessionId；内部 resolveConfigBySid 仅校验注入）——
  enqueue(sessionId, messages):
    await resolveConfigBySid(sessionId)             // §2.3 方案 A（本方法实际只用 sessionId）
    enqueueIds = inbox.enqueue(sessionId, messages)
    for each (id, msg):
      bus.emit(`session_id:${sessionId}_amt:current`, { type:"message_enqueued", enqueueId:id, ... })
    return enqueueIds

  // —— cancel ——
  cancel(sid, enqueueId):
    inbox.removeMessage(sid, enqueueId)         // 同步移除命中则立即 emit canceled；否则 appendCancel 兜底
                                                // 详见 [P0]agent_inbox_enqueue.md §4/§6

  // —— activate（去 config：签名 sessionId；内部按 sessionId 取 config + 路由）——
  activate(sessionId):
    // [v0.0.102] config resolve 失败（含 ModelNotConfiguredError）→ catch 透传原 Error 落 makeErrorRun。
    //   非字符串化：保 Error.code/detail 供 caller handler 识别返语义化 400（非 500）。
    //   非 Error 值（字符串 throw 等）兜底包 Error。resolveConfig 未注入仍抛（dev misconfig，早失败）。
    let config
    try:
      config = await resolveConfigBySid(sessionId)
    catch (e):
      return makeErrorRun(sessionId, "main", e instanceof Error ? e : new Error(String(e)))

    sid = sessionId
    let st = stateStore.getState(sid)

    // 情况 3：interrupting → 循环等 100ms 重读
    while (st === "interrupting"):
      sleep(100ms); st = stateStore.getState(sid)

    // 情况 1：running → 返回现有 AgentRun（同一对象引用，无 "already_activated" 状态码）
    if (st === "running"):
      return this.agentRuns.get(`${sid}_main`)!   // 必然存在（run 结束才 cleanupRun）

    // 情况 2：idle/interrupted/error → CAS markRunning + 新建
    newRunId = ulid()
    if (!stateStore.markRunning(sid, newRunId)):
      return this.activate(sessionId)                   // 极少见竞态，重 dispatch

    controller = { runId: newRunId, aborted: false }
    key = `${sid}_main`
    agentRun = { sessionId: sid, runKind: "main", runId: newRunId,
                 groupKey: `session_id:${sid}_amt:main`, state: "running",
                 promise: <future>, result: undefined }
    this.abortControllers.set(key, controller)
    this.agentRuns.set(key, agentRun)

    // buildRunDeps throw（装配错误）→ catch 落 makeErrorRun（与 config resolve 同路径）
    try:
      { spec, loop } = buildRunDeps({ config, runId: newRunId, controller,
                                      bus: this.bus, store, sessionTypePolicy, ... })
      void this.run(spec, loop)
    catch (e):
      return makeErrorRun(sid, "main", e instanceof Error ? e : new Error(String(e)))
    if agentRun.loop: this.loops.set(key, agentRun.loop)

    // run 结束 → cleanupRun
    agentRun.promise.finally(() => cleanupRun(key))
    return agentRun

  // —— session 不存在：直接返 error shell ——
  //  activate 内读 store.getSession(sid) 返 null 时：return makeErrorRun(sid, "main", `session not found: ${sid}`)
  //  （字符串入参 makeErrorRun 内部包 Error）

  // —— sideRun（编排全在 agent-side-run.ts executeSideRun；此处为语义梗概）——
  sideRun(opts):
    sid = opts.sessionId
    key = `${sid}_${opts.runKind}`
    if agentRuns.has(key):
      throw "already_running_in_this_mode"
    // executeSideRun：controller 创建（带 ChildProcessRegistry）→ snapshot structuredClone →
    //   effectiveKind = SessionKind(host biz/role/derivation + runKind)（config.kind 缺失兜底
    //   playground-rocky:parent，tier2 场景）→ buildRunDeps({config, snapshot, userMessage, kind,
    //   sessionTypePolicy, ...}) → startRunAndTrack（shell 构造 + 三 map 注册 + start + cleanup）
    return executeSideRun(env, opts)

  // —— abort ——
  abort(sid, runId, runKind):
    key = `${sid}_${runKind}`
    controller = abortControllers.get(key)
    if !controller:           return { accepted: false, reason: "no_active_controller" }
    if controller.runId!==runId: return { accepted: false, reason: "run_id_mismatch" }

    if runKind === "main":
      // 主对话：走五态机 CAS + 4 步 finalize
      if !stateStore.markInterrupting(sid, runId):
        return { accepted: false, reason: "cas_failed" }
      controller.aborted = true
      loop = loops.get(key)
      runAbortFinalize(sid, runId, controller, loop)        // 异步，详见 agent_interrupt.md §3 step2-4
        .finally(() => cleanupRun(key))
    else:
      // 旁路：无五态机参与，直接置 aborted
      controller.aborted = true                              // 旁路 loop 下一检查点退出
      // run 的 promise reject 触发 .catch；cleanupRun 由 .finally 调
    return { accepted: true }

  // —— subscribe（单 key）——
  subscribe(sid, runKind = "main"):
    return hub.sub("agent_loop", `session_id:${sid}_amt:${runKind}`)

  // —— cleanupRun ——
  cleanupRun(key):
    agentRuns.delete(key)
    abortControllers.delete(key)
    loops.delete(key)
```

> **`runAbortFinalize` 的实现职责**（半数据持久化、补 interrupted tool_result、clearReplay、emit run_stop、markInterrupted）详见 `[P0]agent_interrupt.md §3 step2-4` + `§4 half-data 三场景`，本文件不重复。

### 4.1 `makeErrorRun` 契约（[v0.0.102] error shell 构造器）

`makeErrorRun(sid, runKind, error: Error | string)` 在 `agent-run-registry.ts` 导出，是 activate 失败的唯一出口：

```
makeErrorRun(sid, runKind, error):
  shell = createAgentRunShell(sid, runKind, ulid())   // state='running' 初始
  shell.state = 'error'
  errObj = typeof error === 'string' ? new Error(error) : error   // 字符串包 Error；Error 原样
  shell.error = errObj                                // 透传 Error 对象（保 code/detail）
  errShell.__reject(errObj)                           // promise 转 rejected（冗余信号）
  void shell.promise.catch(() => {})                  // 同步挂 noop catch 防 unhandled rejection（Bun crash）
  return shell
```

**契约要点**：
- **透传原 Error（非字符串化）**——caller handler 经 `instanceof ModelNotConfiguredError` 识别语义化错误返 400（保 Error.code/detail）。
- **`state='error'` 是 error 的权威信号**——caller 检查 `agentRun.state === 'error'` 决定走兜底；promise rejection 是冗余信号（故挂 noop catch 吞掉，不击穿进程）。
- **caller 识别链路**（`session-deps.ts:resolveErrorRunResult`）：
  - `agentRun.error instanceof ModelNotConfiguredError` → `400 {code, message, detail}`（语义化）
  - 其余（session not found / buildRunDeps throw 等）→ `500 {error: 'activate failed for runId: ...'}`
  - helper 同时挂 noop catch 消费 promise（防御性，防 caller 漏挂）

**handler 入口**（session-run.ts / session-messages.ts）：

```typescript
let agentRun;
try {
  agentRun = await deps.agentManager.deliverTo(id, userMsg);  // deliverTo 内部抛 → catch 返 400
} catch (e) {
  if (e instanceof ModelNotConfiguredError) return json(400, {code, message, detail});
  throw e;
}
if (agentRun.state === 'error') {                            // activate 返 error shell → resolveErrorRunResult
  const r = resolveErrorRunResult(agentRun);
  return json(r.status, r.body);
}
```

> **两条路径并存**：① deliverTo 同步 throw（buildSessionConfigFromDeps 早抛 ModelNotConfiguredError）→ catch；② activate 异步落 makeErrorRun 返 state='error' run → resolveErrorRunResult。

---

## 5. 内部架构

```
AgentManagerImpl（agent-manager.ts，thin wrapper + 状态持有者）
├─ 装配层（单装配，profile 驱动）
│   └─ buildRunDeps(opts) → RunSpec + RunLoopHandle（main/旁路同一函数，build-run-deps.ts）
├─ 协作者文件（v0.0.204 拆分）
│   ├─ agent-side-run.ts executeSideRun(env, opts)  → 旁路 run 启动编排
│   └─ agent-run-registry.ts startRunAndTrack + shell/cleanup helpers → 三 map 管理
├─ 统一入口 run(spec, loop) → runReActLoop
├─ 基础设施
│   ├─ hub, bus (topic=agent_loop)
│   ├─ store, stateStore, inbox
├─ 内存状态（key = `${sid}_${runKind}`）
│   ├─ agentRuns:        Map<key, AgentRun>
│   ├─ abortControllers: Map<key, { runId, aborted }>
│   └─ loops:            Map<"${sid}_main", LoopHandle>  ← 仅主对话缓存句柄
└─ 无路由表——activate/sideRun 同走 buildRunDeps（差异全由 profile 字段驱动）
```

**`loops` Map 角色**：仅供 `runAbortFinalize` 查 `loop.promise` 等待退出。进程崩溃后 `loops` / `agentRuns` / `abortControllers` 内存丢失不影响正确性——崩溃恢复走 `stateStore.reconcileOnStartup()`（session_state.md §5）。

---

## 6. 与 runReActLoop 的关系

```
AgentManager                                runReActLoop (统一骨架)
─────────────────                           ────────────────────────────────────────────
enqueue()       ──→ inbox(message)
cancel()        ──→ inbox(cancel)     ──→     drain inbox（msg+cancel 同 enqueueId 配对 → 作废）
activate()      ──→ stateStore.markRunning(CAS)
                  → buildRunDeps → run(spec, loop) → runReActLoop
                       ├─ 创建 controller = { runId, aborted:false }
                       ├─ 创建 AgentRun(runKind='main')
                       └─ loop.start() 启 runReActLoop      （每个边界读 controller.aborted）
sideRun()      ──→ executeSideRun → buildRunDeps → startRunAndTrack
                                                              ⚡ aborted=true → 立即退出不收尾
abort(sid,                                                       loop 退出后 bus.emit(events)
  runId, runKind)──→ 校验 controller.runId
                  → runKind='main'  → markInterrupting + 4 步 finalize
                  → runKind=旁路    → 直接 aborted=true
subscribe(sid,
  runKind?)    ──→ hub.sub("agent_loop", `session_id:<sid>_amt:<runKind>`)

AgentManager ←──→ SessionStateStore（state CAS）：仅主对话 (runKind='main') 参与五态机
EventHub (replayable) → subscribe() → AgentEvent stream
```

**职责边界**：

| 组件 | 职责 |
|------|------|
| **AgentManager** | session 级门面 + 状态持有者；enqueue/cancel 写 inbox；activate 经 buildRunDeps 装配后调 run(spec, loop)、sideRun 委托 executeSideRun；abort 收尾唯一执行者（校验 controller.runId + 置 aborted + 主对话走 4 步 finalize）；subscribe 转 hub.sub；不写 ReAct |
| **buildRunDeps**（build-run-deps.ts） | 单装配函数：按 `SessionTypePolicy.profile(kind)` 驱动装配 RunSpec（scopeId=canonicalId / drainMode / buffer / lifecycle / eventChannel）+ RunLoopHandle；main 与旁路同一入口，差异全由 profile 字段表达 |
| **executeSideRun**（agent-side-run.ts） | 旁路 run 启动编排：并发检查 + controller + snapshot 克隆 + effectiveKind 派生 + buildRunDeps + startRunAndTrack |
| **startRunAndTrack**（agent-run-registry.ts） | AgentRun shell 构造 + 三 map 注册 + loop.start + promise 绑定 + cleanup |
| **SessionStateStore** | 五态机权威源（CAS markRunning/markInterrupting/markInterrupted/markIdle/markError + reconcileOnStartup）。仅主对话参与；旁路不写 state |
| **EventHub / EventBus** | 事件分发 + replay buffer + 多订阅 fan-out；`clearReplay(group)` 由 abort step3 调用 |
| **SessionStore** | 消息持久化（abort 重组的 partial / interrupted tool_result 经此 ingest；cancel 作废的 message 不进） |
| **InboxStore** | inbox 独立存储；条目形态 InboxEntry（联合 kind=message|cancel），见 `[P0]agent_inbox_enqueue.md §2` |

---

## 7. 多 Agent 通信

Agent 间通信统一通过 AgentManager 的 `enqueue + activate + sessionQuery`——无需特殊 Agent 间通信协议。多 agent 场景每个 agent session 独立维护 state + currentRunId；abort 走各自 AgentManager 实例。

旁路 run（summary / consolidate）不经 enqueue，直接 `sideRun`，事件流走独立 group（`session_id:<sid>_amt:summary` 等），不污染主对话事件流。前端要看旁路进度，需额外 `subscribe(sid, "summary")`。

---

## 8. （版本史见 `log.md`）
