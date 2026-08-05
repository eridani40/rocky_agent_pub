---
type: interface
title: Agent Interface（单 run 契约 + RunSpec + AgentRun）
priority: P0
status: active
updated: 2026-08-04
since: v0.0.16
---

# Agent Interface（单 run 契约）

> 定位：所有 agent run（主链 run RunKind='main' / 旁路 run RunKind='summary'|'consolidate'）的**唯一入口契约**。只剩 `run(spec, loop)`，删 `enqueue/cancel/activate`（死桩）。
> **[v0.0.204 重大更新]** 本文下列描述中：
> - `modeKey: "current"|"summary"|"memory_extract"` → **改为 `runKind: 'main'|'summary'|'consolidate'`**（扁平闭合枚举替代 modeKey 自由 string；current→main / summary→summary / memory_extract→consolidate）。
> - `RunSpec.enableToolWhitelist + toolWhitelist` → **删除**（caller intent 收编 `profile.toolBound`，详见 `../tools/[P0]tool_policy.md`）。
> - `buildMainDeps` / `buildForkedDeps` → **合并为单 `buildRunDeps(opts)`**（profile 驱动 RunSpec 装配，详见 `[P0]agent_loop_unified.md §3`）。
> - `AgentScopeRouter.resolve(modeKey, session) → scopeId` → **删除**（scopeId = `SessionKind.canonicalId()` 纯拼接，零路由表，详见 `[P0]agent_scope_router.md` 已废止）。
> - `forked` 命名体系（isForked / forkedRun / ForkedContextPort / ForkedLifecyclePort / MUTED_BUS）→ **彻底退役**（详 `index.md ④ 原则 #2/#10/#14`）。
> 参见：统一 loop 骨架 → `[P0]agent_loop_unified.md`；scopeId 纯拼接 → `[P0]agent_scope_router.md`（已废止）；门面调度 → `[P0]agent_manager.md`；事件定义 → `[P0]agent_event.md`；机制原语 → `[P0]agent_loop_base.md`。

---

## 1. Agent interface（单 run）

```typescript
interface Agent {
  /**
   * 启动一个 agent run，立即返回 AgentRun（含 .promise 可 await 结果）。
   *
   * - 想「等结果」（旧 run 语义）：`await run.promise`
   * - 想「不等结果」（旧 activate 语义）：忽略 `run.promise`
   *
   * 两入参（由 buildRunDeps 装配后传入）：
   *   - spec: RunSpec——身份（kind + sessionId + runId + runKind）+ RunLifecyclePort + observability + RunSpec 字段参数化，run（主链/旁路）差异全在装配；
   *   - loop: RunLoopHandle——loop 句柄 `{ start(); isRunning() }`，同一 deps 装配产出，供 manager 注册三 map + 启动。
   *
   * 协议本身不再区分 run 类型；runKind 只是 spec 内的种类标签（main/summary/consolidate）。
   */
  run(spec: RunSpec, loop: RunLoopHandle): Promise<AgentRun>;
}
```

> **两入参的由来**：早期草案（change-plan §1.1）写 `run(spec)` 单参；实现落地为 `run(spec, loop)` 两参——`loop` 句柄由 `buildRunDeps` 装配产出（与 spec 同源），manager.run 注册三 map 后 `void loop.start()` 异步启 `runReActLoop`。`activate(sid)` / 旁路 run 入口 wrapper 内部调 `buildRunDeps` 拿 `{ spec, loop }` 再调 `run(spec, loop)`。

> **中断不在 Agent interface 上**：abort 由 `AgentManager.abort(sid, runId, runKind)` 统一提供（manager 持 controller，校验 runId 后置 aborted=true）。详见 `[P0]agent_manager.md §3` + `[P0]agent_interrupt.md §3`。

### 1.1 v0.0.40 协议瘦身（删 enqueue/cancel/activate）

旧 `Agent.enqueue / cancel / activate` **全部删除**。理由（调研 §1.2 已核对代码）：

| 旧方法 | 真实落点 | 协议上的命运 |
|---|---|---|
| `enqueue(config, msgs)` | `AgentManager.enqueue(sid, msgs)` → `inbox.enqueue` | 早已是 throw 死桩；本就是 session/inbox 职责，非 agent 协议 |
| `cancel(sid, enqueueId)` | `AgentManager.cancel(sid, id)` → `inbox.removeMessage / appendCancel` | 同上，死桩 |
| `activate(config)` | `AgentManager.activate(sid)` 内联 `new AgentLoop(...)`（**从不经策略类**） | 入口下沉为 `run(spec, loop)` 的 thin wrapper（见下） |
| `run(userMsg, opts)` | `AgentManager.forkedRun(opts)` → `new ForkedAgent().run()`（v0.0.40 前） | 收敛为唯一 `run(spec, loop)` |

**退役连带**：`EagerDrainAgent` 整类（死重，仅被构造测试拴着）、`agentByMode(loopMode)` 路由（无任何多态调用点）、`LazyDrainAgent` 类（spec future，无代码）一并退役。

### 1.2 迁移说明（caller 视角）

- `manager.activate(sid)` / `manager.sideRun(opts)` 是 AgentManager 门面的 thin wrapper——内部经 `buildRunDeps` 构造对应 `RunSpec` + `LoopHandle` 后调 `run(spec, loop)` / `startRunAndTrack`（sideRun 编排抽 `agent-side-run.ts executeSideRun`）。即「入口统一在 run，门面 API 兼容」。
- `manager.enqueue / cancel / deliverTo` 原样保留（inbox ops，非协议）。
- `manager.abort / subscribe / clearReplay` 原样保留。

> 三 mode 支持矩阵（旧 §5）**删除**——协议只剩一个 `run`，不再分 mode 支持与否。mode 差异全在 spec 的 3 个 port 装配（见 `[P0]agent_loop_unified.md §4`）。

---

## 2. RunSpec（入口参数 = 身份 + 注入 ports）

```typescript
interface RunSpec {
  // —— 身份 ——
  sessionId: string;                   // 归属 session
  runId: string;                       // ULID，全局唯一（manager 经 CAS markRunning 后传入）
  runKind: RunKind;                    // 'main'（主对话）| 'summary' | 'consolidate'（旁路 run）——扁平闭合枚举
  scopeId: string;                     // context 配置 scope（= SessionKind.canonicalId 纯拼接，如 playground-rocky:parent:main）
  controller: AbortControllerHandle;   // { runId, aborted, childRegistry? }（manager 创建并注入；runId 守门单点；childRegistry=run 级子进程 sweep，[v0.0.130.hang]）

  // —— 入参消息 ——
  message?: Message;                   // 可选；main=与 inbox 一起在首轮处理；旁路=任务消息（snapshot 前缀由 buildRunDeps 装配 RunState.buffer 时纳入）

  // —— 工具（双维度，详见 agent_loop_base §3）——
  toolDefinitions: ToolDefinition[];   // 缓存契约：传 LLM 的工具声明，整个 run 不变（保 prompt cache）；main 装配阶段已 filterToolDefinitionsBySessionType
  allowedTools: string[];              // 行为契约：执行门控白名单；非 allowed → not-allowed result 喂回（多轮可自修正）
  maxIter: number;                     // main = profile.runShape.maxIterDefault ?? 25；旁路 = profile 派生（summary=1 单次 / consolidate=10 多轮）

  // —— main/旁路 差异参数化字段（v0.0.49 D12，骨架无 if main/旁路 字面分支；v0.0.204 起全字段由 profile.runShape 驱动）——
  drainMode: 'eager' | 'none' | 'lazy'; // main='eager'（每轮 drain inbox）/ 旁路='none'（不 drain）/ 'lazy' 预留 future
  backgroundPath: boolean;              // main=false；旁路=true（overload 直接 fail 不重试，防雪崩）
  stopSequences?: string[];             // main squad 才有 [EOS_STOP_TOKEN]；旁路 undefined
  eosStripper?: (content: ContentBlock[]) => void;        // main squad = stripEosToken；旁路 undefined
  compactNoticeEmitter?: (notice: Message) => void;       // main = emitMessageStart/Text/End（compact 通知）；旁路 undefined

  // —— 注入 port（v0.0.49 起从 4 个收缩到 2 个：删 ContextPort 骨架直调 contextEngine；删 FinalizePort 并入 LifecyclePort）——
  emit: (e: AgentEvent) => void;       // 事件发射；noop = ()=>{} 不发事件（如旁路 emit:false）
  lifecycle: LifecyclePort;            // run 生命周期 + usage 分区 + 中断收尾（v0.0.49 并入 FinalizePort，含 onInterrupted；三 hook onUsage/onRunEnd/onInterrupted）；v0.0.204 起单 impl RunLifecyclePort 按 profile.runShape 分派：main=persistRun+五态机+onUsage 累计 / 旁路=onRunEnd noop+onUsage early return（caller 总量累计）+onInterrupted noop；subagent main run 另装配 replySettle 回报兜底（onRunEnd/onInterrupted 代发，见 `[P0]agent_loop_unified.md §3.2`）
  observability: ObservabilityPort;    // 埋点端口（默认 NoopAdapter 零成本）
  pluginManager?: PluginManager;       // tryCompact 用；旁路也传（让 tryCompact 在 summary/consolidate scope 显式调 reject_should_compact）
}
```

**port 契约签名 + buildRunDeps 装配表** 详见 `[P0]agent_loop_unified.md §3/§4`。

> `RunSpec` 取代旧 `RunOptions`（snapshot/userMessage/allowedTools/toolDefinitions/maxIter/modeKey/emit/usagePartition/observability 全部归并）。旧 `taskType` 删除（runKind 已是种类标签）。`snapshot` 字段不进 RunSpec——它属于旁路的 RunState.buffer 内部状态（buildRunDeps 装配时建 `[initialSnapshot.system, ...initialSnapshot.messages, userMessage]`）。**v0.0.49 删 ContextPort + FinalizePort**：原 ContextPort（源/汇/组装）回归骨架直调 `contextEngine.ingest/assemble(scopeId, buffer)`（runKind 差异由 RunSpec 字段参数化），原 FinalizePort 的 onInterrupted 并入 LifecyclePort（D7）。

---

## 3. AgentRun（instance）

每次 run 产出的 agent run 实例。caller 拿到后可知状态、等结果。

```typescript
interface AgentRun {
  readonly sessionId: string;       // 归属 session
  readonly runKind: RunKind;        // 'main' | 'summary' | 'consolidate'
  readonly runId: string;           // ULID，全局唯一
  readonly groupKey: string;        // session_id:<sid>_amt:<runKind>
  readonly state: AgentRunState;    // running | completed | interrupted | error
  readonly promise: Promise<RunResult>;  // 可 await 拿最终结果
  readonly result?: RunResult;      // 完成后填充
  readonly error?: unknown;         // state==='error' 时携带原 Error（makeErrorRun 透传）；pending/completed 态无此字段
}
```

> **AgentRun 不暴露 controller**：caller 只能 `await run.promise` / 读 `run.state`，无法直接操作 controller。中断必须经 `AgentManager.abort()` 入口。loop 句柄不暴露给 caller（manager 内部 `loops` map 仅供 abort finalize 等待退出）。

> **[v0.0.102] `error` 字段 = activate 失败的语义化错误载体**——`AgentManager.activate(sid)` 失败（config resolve 失败 / session not found / buildRunDeps throw）时，`makeErrorRun` 不字符串化 Error，而是把**原 Error 对象**塞进 `error` 字段返一个 `state==='error'` 的 AgentRun（非 throw）。caller（session-run / session-messages handler）读 `agentRun.error instanceof ModelNotConfiguredError` → 返语义化 400 `{code, message, detail}`，其余 → 500 兜底（详见 `[P0]agent_manager.md §2/§4` + `specs/api/overall/04-agent-session.md §3.2 error shell`）。这取代了「activate throw → caller catch」路径——activate 失败现在有结构化错误透传链路（旧版 ghost model 只能返 500，现可返 400 MODEL_NOT_CONFIGURED）。

---

## 4. 类型定义

```typescript
type AgentRunState = "running" | "completed" | "interrupted" | "error";

interface RunResult {
  answer: string;
  usage: Usage;
  stopReason: StopReason;
  rounds: number;
}

interface AbortResult {
  accepted: boolean;
  reason?: string;            // "run_id_mismatch" / "no_active_controller" / "cas_failed"
}

// AbortController 内存模型（自定义对象，非 Web API；见 agent_interrupt §1）
interface AbortControllerHandle {
  runId: string;
  aborted: boolean;
  childRegistry?: ChildProcessRegistry; // [v0.0.130.hang] run 级子进程注册表；abort 时 killAll 兜底杀在途子进程组（agent_interrupt §3.1）
}
```

> `ActivateResult` / `RunOptions` / `ForkedRunOptions` 类型已废弃（v0.0.40）：入口统一为 `RunSpec`，`activate()` / `forkedRun()` 直接返回 `AgentRun`。

---

## 5. groupKey 命名约定

所有 agent run 共用 `agent_loop` topic，通过 group 区分：

| runKind | groupKey | 说明 |
|---------|----------|------|
| `main` | `session_id:<sid>_amt:main` | 主对话 |
| `summary` | `session_id:<sid>_amt:summary` | 旁路压缩（compact summary run） |
| `consolidate` | `session_id:<sid>_amt:consolidate` | 旁路整理（memory/skill consolidation run） |

> 命名规范：`session_id:<sid>_amt:<runKind>`（amt = agent mode type），与 event_bus §1 的 `key_name:key_value` 对齐。拼接函数 `groupKeyForRunKind(sid, runKind)`（agent-interface.ts）。

---

## 6. 同 runKind 不并发

同一 sessionId 同一 runKind 同时只能有一个 run。
- **main**：session 五态机保证（state=running 时拒新 activate，见 `[P0]agent_manager.md §2`）
- **旁路**：AgentManager.agentRuns map 检查（`${sid}_${runKind}` 已存在且 state=running → 拒）

```
key = `${sessionId}_${runKind}`（runMapKey）
agentRuns.get(key)?.state === "running" → throw "already_running_in_this_mode"
```

---

## 7. runKind 定义（扁平闭合枚举）

**定义**：`RunKind = 'main' | 'summary' | 'consolidate'`（扁平闭合枚举，`app/shared/src/types/session-kind.ts`；v0.0.204 替代原 modeKey 自由 string：current→main / summary→summary / memory_extract→consolidate）。`groupKeyForRunKind(sid, runKind)` → `session_id:<sid>_amt:<runKind>`、`runMapKey` → `${sid}_${runKind}`。一个 run 的「种类」标签。

**驱动三件事**：
1. **事件分组**：`groupKey = session_id:<sid>_amt:<runKind>`（消费者订阅分流）。
2. **run map key**：`${sid}_${runKind}`，同 sessionId 同 runKind 不并发（§6）。
3. **profile 解析**：runKind 是 SessionKind canonicalId 第 4 段（`<biz>-<role>:<derivation>:<runKind>`）——`SessionTypePolicy.profile(kind)` 按它取行为契约（toolBound / runShape / lifecycleHooks 等）。

**runKind vs scopeId（别混淆）**：
- **runKind** = run 的**种类** → 决定 profile/RunSpec 装配（lifecycle port / emit group / drainMode / backgroundPath / stop/eos）。由**调用方意图**定。
- **scopeId** = context **impl 链**的选择 → 决定 ingest/assemble 跑哪些 handler。**v0.0.204 起 scopeId = SessionKind.canonicalId() 纯拼接**（含 runKind 段，零路由表；`AgentScopeRouter` 已删除，见 `[P0]agent_scope_router.md` 已废止）。
- 关系：scopeId 由 kind（含 runKind）机械拼接得出——runKind 是输入维度之一，scopeId 是派生产物。

---

## 8. （版本史见 `log.md`）
