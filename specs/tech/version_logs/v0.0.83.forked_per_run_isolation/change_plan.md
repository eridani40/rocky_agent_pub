# v0.0.83.forked_per_run_isolation — Change Plan（method 级契约）

> req：`reqs/[working] v0.0.83.forked_per_run_isolation/req.md`；user_query 已记。
> 简化流程（用户裁定）：spec + code + UT 即可，AT/E2E/真机由用户自验。

## 0. 根因

`in_memory_session_store` 的 buffer 按 `sid` 分桶（v0.0.66 把 per-run `RunState.buffer` 降级成 per-session Map slot）。
summary + memory_extract 两 sibling forked run 同 sid → **共享一个 buffer 桶** → 消息混合（实测 SUMMARY trace `messages[12]` 同时含 summary reminder + memory_extract directive + memory_extract reminder + compact trailer，LLM 收 3 种矛盾指令）。

## 1. 第一性原则 + 抽象红线

- **第一性原则**（用户）：「因为它 forked，所以每一个独立运行的节点都应该有一个独立的资源存储区域，而不是一个公共区域。」
- **抽象红线**（用户二次强调）：`session`(sid) 与 `run`(runId) 是**通用领域 id**——任何调用点都同时拥有二者；`slot` **只是 in_memory 这个特定 ext impl 的内部概念**（Map 桶 key = runId），**绝不出现在 ContextEngine / handler / EP 契约层**。

→ ContextEngine / handler 只传 `sessionId + runId`（用 `StoreCallOpts` 承载 runId + 未来字段）。用 runId 还是 sid 作桶 key，是 in_memory impl 内部决策（`slotKeyOf`）。

## 2. 契约（StoreCallOpts 作可选尾参，sid 不动）

`StoreCallOpts`（新类型，`session-store-types.ts`）= `{ runId?: string; /* 未来字段直接加，不动方法签名 */ }`。

**消息缓冲类方法**（buffer 按 run 隔离）→ 加可选尾参 `opts?: StoreCallOpts`：
| 方法 | 新签名 | real SessionStore | in_memory |
|------|--------|-------------------|-----------|
| `appendMessages` | `(sessionId, messages, opts?)` | 忽略 opts，按 sid | **内部 slotKey=opts.runId??sid** 分桶 |
| `getMessages` | `(sessionId, range?, opts?)` | 忽略 opts，按 sid | 按 slotKey 读桶 |
| `releaseSlot`（EP-only） | `(sessionId, opts?)` | no-op | 按 slotKey delete 桶 |

**session-meta 类方法**（与 run 无关，in_memory 全忽略）→ **签名不动**：`getSummary(sessionId)` / `getRatio(sessionId)` / `updateContextWindowUsage(sessionId, cw)`。

`slotKeyOf(sessionId, opts) = opts?.runId ?? sessionId` —— **仅出现在 `in_memory_session_store.ts`**（slot 是该 impl 内部概念）。

## 3. 线程穿透（ContextEngine / handler 传 sid + opts，无 slotKey）

```
forked caller → ce.ingest(config, msgs, 'forked', false, { runId })
  → applyIngestPipeline(..., opts={runId}) → IngestCtx.opts
    → store_sink: ctx.store.appendMessages(sid, msgs, ctx.opts)
forked caller → ce.assemble(config, 'forked', prev, { runId })
  → store.getSummary(sid) / getRatio(sid)              // session-meta，sid-only（不变）
  → runAssemblePipeline(..., opts) → AssembleCtx.opts
    → transcript_reader: ctx.store.getMessages(sid, {limit}, ctx.opts)
  → store.updateContextWindowUsage(sid, cw)             // session-meta（不变）
ce.clearScopeSession('forked', sid, { runId }) → store.releaseSlot(sid, opts)
```

`config.sessionId` = 真 sid 不变（usage 归属 / trace / memory.ts / groupKey 全用真 sid）。

## 4. 回收（用户强调：注意回收，不要内存泄漏）

单一 chokepoint：`ForkedLoopHandle.start()` 的 `finally` → `clearScopeSession(scopeId, sid, { runId })` → `releaseSlot`。
成功/抛错/中断三路径 finally 都跑；slot 在 `wireInitState`（runReActLoop 内 = try 内）分配 → 必被覆盖；`releaseSlot` 幂等。
顺带：`wireInitState` 删旧防御性 sid clear；`ForkedLifecyclePort.onRunEnd` 改 noop；`onInterrupted` noop（finally 兜底）。

## 5. Method 级变更契约（8 列）

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响 |
|------|------|----------|------|---------|------|------|------|
| server | `session-store-types.ts` | `StoreCallOpts` | 类型(新) | 新增 `{ runId?: string }`（store 调用可选参数，承载 runId + 未来） | — | §2 | 新增 |
| server | `session-store.ts` | `appendMessages`/`getMessages` | 签名 | 加尾参 `opts?: StoreCallOpts`；real impl 忽略 | 向后兼容 | §2 | :413/:436 |
| server | `context-engine.ts` | `ingest` | 签名+体 | 加尾参 `opts?`；透传 applyIngestPipeline | — | §3 | :149 |
| server | `context-engine.ts` | `assemble` | 签名+体 | 加尾参 `opts?`；透传 runAssemblePipeline + fallback getMessages；session-meta 不动 | — | §3 | :180 |
| server | `context-engine.ts` | `clearScopeSession` | 签名+体 | 加 `opts?`；透传 releaseSlot | 幂等 | §3 §4 | :140 |
| server | `context-engine-store-resolver.ts` | `clearScopeSession` | 签名+体 | 加 `opts?`；`releaseSlot(sid, opts)` | — | §3 | :46 |
| server | `context-ingest-pipeline.ts` | `applyIngestPipeline` + `IngestHandler.ctx` | 签名+体 | 加 `opts?`；ctx 注入 opts；2 处 fallback appendMessages 传 opts | — | §3 | :118 |
| server | `assemble-pipeline.ts` | `runAssemblePipeline` + `AssembleCtx` | 签名+体 | 加 `opts?`；ctx 注入 opts | — | §3 | :81/:37 |
| server | `build-forked-deps.ts` | `ForkedLoopHandle.start` | 体 | **finally 加 clearScopeSession(scopeId, sid, {runId})**（单一回收点） | 防泄漏 | §4 | :78 |
| server | `build-forked-deps.ts` | `wireInitState` | 体 | 删防御性 clear；ingest 传 `{ runId }` | — | §4 | :239 |
| server | `forked-lifecycle-port.ts` | `onRunEnd`/deps | 体 | onRunEnd noop；删 deps.contextEngine/scopeId（不再用） | — | §4 | :38 |
| server | `loop-stage-context.ts` | prepareStage/ingestAssistant/ingestToolResults（forked 分支） | 体 | assemble/ingest 传 `{ runId: spec.runId }` | forked 分支 | §3 | :72/:94/:122 |
| plugin | `rocky_context/store/types.ts` | `SessionStoreContract` | 类型 | appendMessages/getMessages/releaseSlot 加 `opts?`；meta 3 方法不动 | §2 分类 | §2 | :28 |
| plugin | `rocky_context/store/in_memory_session_store.ts` | `appendMessages`/`getMessages`/`releaseSlot` + `slotKeyOf` | 体+helper | 加 `opts?`；**内部** `slotKeyOf(sid, opts)=opts.runId??sid`（slot 仅本文件）；按 slotKey 分桶/读/删 | slot 不外泄 | §1 §2 | :53/:73/:129 |
| plugin | `rocky_context/store/persistent_session_store.ts` | `appendMessages`/`getMessages`/`releaseSlot` | 签名 | 加 `opts?`（忽略，转发 real store 按 sid） | — | §2 | :59/:63/:88 |
| plugin | `rocky_context/types.ts` | `IngestCtx`/`AssembleCtx` | 类型 | 加 `opts?: StoreCallOpts` | — | §3 | :113/:172 |
| plugin | `rocky_context/ingest/store_sink.ts` | `handle` | 体 | `appendMessages(sid, msgs, ctx.opts)` | — | §3 | :49 |
| plugin | `rocky_context/assemble/transcript_reader.ts` | `map` | 体 | `getMessages(sid, {limit}, ctx.opts)` | — | §3 | :45 |

**不改**：`computeContextWindowUsage`（仅 getRatio(sid)）、`summary_reader`/`base_builder`/`memory.ts`（真 sid）、`runCompact`/compact 链、`getSummary`/`getRatio`/`updateContextWindowUsage`/`getMessagesByRun` 签名、real SessionStore 落盘逻辑。

## 6. 不变量

1. **per-run 隔离**：同 sid 不同 runId → buffer 物理分离，零交叉。
2. **default 零回归**：opts 缺省 → 消息缓冲方法按 sid（real store 忽略 opts）；~110 个 HTTP/test 调用点零改动。
3. **身份不变**：config.sessionId 始终 = 真 sid。
4. **slot 不外泄**：`slotKey` 字眼仅 `in_memory_session_store.ts`；ContextEngine/handler/EP 契约只有 `sessionId`+`opts.runId`。
5. **无泄漏**：每个 forked run 的桶在 start() finally 必释放（三路径）；releaseSlot 幂等。
6. **forked 不变量保留**：append-only / 绝不 compact / 无持久化。
7. **未来扩展**：StoreCallOpts 加字段不动任何方法签名。

## 7. UT（实做）

- **新** `rocky_context/__tests__/in-memory-per-run-isolation.test.ts`（6）：同 sid 不同 runId 隔离 / 多轮累积 / releaseSlot 只清本 run 不误伤 sibling / 无 opts 按 sid 回退 / releaseSlot 幂等 / session-meta 与 run 无关。
- **新** `agent/__tests__/forked-handle-reclamation.test.ts`（4）：start() finally 成功路径回收 / 抛错路径仍回收 / 不同 runId 各释其桶 / start() 未调不回收。
- **改** `ingest-handlers.test.ts`：store_sink 2 处 appendMessages 断言加 ctx.opts（undefined）+ 新增 runId 透传 case。
- **改** `assemble-mappers.test.ts`：transcript_reader 新增 ctx.opts 透传 case。
- 现有 forked UT（context-engine-forked-scope / agent-manager-forked-run / forked-agent）零改动仍绿（opts 可选尾参，default 路径不传）。

typecheck 绿；agent + rocky_context 全量 1024 passed（1 个 session-workspace-manager debounce timing flaky，孤立跑绿，与本改动无关）。

## 8. spec 同步（实做）

- `specs/tech/agent/context/[P0]context_engine.md`：ingest/assemble 签名加 `opts?: StoreCallOpts` + §注（per-run 隔离语义，slot 不外泄）。
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_forked.md`：加 [v0.0.83] 注（per-run 隔离 + start() finally 回收，onRunEnd/onInterrupted noop）。
- `in_memory_session_store.ts` 顶部注释：buffer 桶 key 从「per-session sid」改「per-run runId（opts 传入，slot 是本 impl 内部概念）」。
- 本 change_plan（version_logs/v0.0.83/）。
