# v0.0.95.lifecycle_buffer 变更计划书 — useLifecycle 加 buffer 第三参数（消灭 useMessages 特例）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 权威输入：`reqs/[done] v0.0.95.lifecycle_buffer/req.md`（法律，用户拍板 5 条约束 + D1/D2 决策）+ tech spec `[P0]component_architecture.md §3.10` + `[P0]chat_area_hooks.md §3` + `[P0]lifecycle_data_shapes.md §3.2`。
> **纯前端重构，无后端契约变更，specs/api/ 不动**。

## 设计要点（落表前必读）

### A. buffer 第三参数契约（演进 useLifecycle）

- v0.0.94 `useLifecycle<TCtx,TEvent>` → v0.0.95 `useLifecycle<TCtx, TBuffer, TEvent>`（TBuffer 可选，默认 `null`/`undefined`，大多数 hook 不传）。
- **onInit 返 `{ctx, buffer}`**（两者都返回，buffer 可为 null/undefined）。
- **onEvent 签名** `(ctx, buffer, event, from) => { ctx?, buffer? } | void`。返回的 ctx 字段才走 commitCtx+setCtx（渲染）；返回的 buffer 字段只走 commitBuffer（写 bufferRef，**不渲染**）；某字段 undefined 跳写（不变）。
- **onTick 签名** 同 onEvent（收 ctx+buffer，可返 `{ctx?,buffer?}` 或 void）。
- **onDestroy 签名** `(ctx, buffer|null) => void`（收最终值做清理，buffer 可能为 null）。
- **双写路径**（核心）：`commitCtx(nextCtx)` 同步写 ctxRef + setCtx；`commitBuffer(nextBuffer)` 同步写 bufferRef（**不 setCtx**）。
- **命令式口子**：保 `reload()`（重 init，重置 ctx+buffer）；v0.0.94 单 `mutate(updater)` **分裂为两个**：
  - `mutateCtx(updater)` — 改渲染态 ctx（触发渲染）；`updater(ctxRef.current) => TCtx | void`。
  - `mutateBuffer(updater)` — 改工作内存 buffer（不渲染）；`updater(bufferRef.current) => TBuffer | void`。
  - **理由**：分立让"改 buffer 不触发渲染"的语义在命令式口子上也成立（useMessages 的 `setMessages` 改 ctx 走 mutateCtx，但 buffer 清理口子若有需要可走 mutateBuffer 不打扰渲染）。详见开放点①。
- **串行调度保证**（约束3）：handleFrame 同步调用 `onEventRef.current` 后立即 commit（写 ref 同步），**一帧处理完才接下一帧**（SseClient 单线程顺序投递，handler 内同步链路无重入）。spec 写成显式不变量⑦。
- **buffer 清理**（D2）：reducer 纯函数 return 删 key 的新 buffer（immutable）；onDestroy/reload 整个 buffer 随 unmount/re-init 重置（bufferRef.current 重新由 onInit 设置）。UT 验：跑一轮 tool_call_end 后 `buffer.rawArgs` 中对应 key 已删。

### B. reducer 纯化（applyAgentEventToMessages）

- 从 `(msgs, evt, ctxRef: {current: RunContext|null}, state)` mutate `ctxRef.current` → 改 `(msgs, runCtx, evt, state) => { messages, runCtx, state... }` 纯函数（合并 ReducerResult 与 runCtx 进同一返回）。
- **新增类型** `ReducerFullResult = ReducerResult & { runCtx: RunContext | null }`（reducer 输出含 runCtx）。
- **runCtx 输入改为值传递**（不再 `{current:}`）：reducer 内部不再 `ctxRef.current = ...`，而是把 runCtx 当参数读取、把新 runCtx 当返回值输出。各 case 改为局部 `let nextRunCtx = runCtx` 后按需赋新对象（如 `nextRunCtx = { ...runCtx, toolCallRawArgs: new Map(...).set(...) }`）或保持原引用（无变化）。
- **rawArgs 累积语义严格不变**（重点验证不回归 BUG-002 相关）：
  - `tool_call_delta` → 新 Map（拷贝旧 entries + set/累积 toolCallId 对应 raw）。
  - `tool_call_end` → 读 rawMap 拿累积值 parse 进 ctx.messages + 返回**删了该 key 的新 Map**（D2 落地：reducer 内清理）。
- **run_start / message_start / tool_call_start / error / run_end 各 case 的 runCtx 副作用全改为返回新 runCtx**（immutable）。

### C. useMessages 进契约（消灭特例）

- 从自管 `sliceRef + runCtxRef + setSlice`（onEvent 返回 void 不走 ctx 通道）→ 改 `ctx` 走渲染通道 + `buffer` 走工作内存通道：
  - **ctx** = `{ messages, hasMore, runActive, loadingPhase, lastRunFinish, enqueueItems }`（渲染）。
  - **buffer** = `{ runCtx: RunContext | null }`（不渲染）。
- onInit：GET /messages(limit 50) → return `{ctx: initialCtx, buffer: {runCtx: null}}`；声明 `subscribe(agent_loop)` + `subscribe(session_panel)`。
- onEvent：
  - `from.topic === 'agent_loop'` → 调纯化后的 reducer `applyAgentEventToMessages(ctx.messages, buffer.runCtx, evt, ctx)` → 拿 `{messages, runCtx, ...派生态}` → **同帧 return `{ctx: 新ctx, buffer: {runCtx: 新runCtx}}`**（双写：ctx 渲染、buffer 累积）。
  - `from.topic === 'session_panel'` && `messages_cleared` → return `{ctx: {...ctx, messages:[], lastRunFinish:null, enqueueItems:[]}}`（buffer 不变）。
  - `from.topic === 'session_panel'` && `session_status_update` 终态 → 强制清 runActive/loadingPhase（D7 治孤儿，保留）。
  - 其余 session_panel type 忽略。
- 命令式方法改用 mutateCtx：
  - `setMessages(items, opts)` → `mutateCtx(ctx => ({...ctx, messages: mergeMessagesById(ctx.messages, items, prepend), hasMore: opts?.hasMore ?? ctx.hasMore}))`。
  - `removeEnqueueItem(id)` → `mutateCtx(ctx => ({...ctx, enqueueItems: ctx.enqueueItems.filter(...)}))`。
- **删** `sliceRef`、`runCtxRef`、`hasMoreRef`（hasMore 进 ctx）、`setSlice`、`setHasMore`、`genRef`（generation 守卫归 useLifecycle abort）。

### D. 受影响的非 useMessages 消费者

- `section-squad-chat.tsx` v0.0.94 已 compose `useMessages`（不再直接调 reducer），v0.0.95 reducer 纯化它间接受益，无需直接适配。
- `chat-slice.ts` re-export `applyAgentEventToMessages` / `AgentEvent` / `RunContext` —— 增加 re-export `ReducerFullResult`（reducer 返回类型）。
- 测试文件三处：`use-messages.test.tsx` / `chat-slice.test.ts` / `enqueue-abort.test.tsx` —— reducer 调用签名 + 断言 runCtx 方式同步改。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统（lifecycle-core / reducer / area-hooks / test） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | spec 位置 |
| 影响行 | +N / -M |

## 建议 task 切分（2 个 task，强依赖链）

- **T1 契约升级 + reducer 纯化**（lifecycle-core / reducer）：useLifecycle 加 TBuffer 第三参数 + 双写路径 + mutateCtx/mutateBuffer + 串行不变量⑦；applyAgentEventToMessages 纯化签名 + ReducerFullResult 类型 + chat-slice.ts re-export。底层先落。
- **T2 useMessages 进契约 + 受影响消费方适配**（area-hooks / studio / tests）：useMessages 改 ctx+buffer 通道（删 sliceRef/runCtxRef/setSlice）+ section-squad-chat 无需直接适配（v0.0.94 已 compose useMessages 间接受益）+ 3 个测试文件适配 + 新 buffer UT。

> 依赖：T1 先（reducer 签名 + 契约 API 落地）。T2 依赖 T1 新签名。

---

## 变更清单

### T1 — 契约升级 + reducer 纯化（lifecycle-core / reducer）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `useLifecycle` | 修改 | 泛型签名加 TBuffer：`useLifecycle<TCtx, TBuffer = null, TEvent = unknown>`；返回值增 `mutateBuffer`；内部增 `bufferRef` | MUST TBuffer 可选默认 null（大多数 hook 不传）；MUST NOT 破坏现有 `<TCtx,TEvent>` 调用方（默认 TBuffer=null 让两参调用兼容） | req §契约签名；§3.10 待更新 | +60/-20 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `LifecycleContract` | 修改 | 接口四方法签名全部加 buffer：onInit 返 `{ctx, buffer}` 或单独 TCtx（兼容旧 ctx-only 返回，hook 内部判断）；onEvent 收 `(ctx, buffer, event, from)` 返 `{ctx?,buffer?}\|void`；onTick 同；onDestroy 收 `(ctx, buffer\|null)` | MUST 四方法都按 D1 参数传递（非类变量/闭包 ref mutate）；MUST 旧 onInit 返回 TCtx（非对象）时兼容（hook 包装为 `{ctx: result, buffer: null}`） | req D1；§3.10 不变量①扩展 | +30/-10 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `commitBuffer`（内部） | 新增 | 写 buffer 双路径：`commitBuffer(next)` 同步写 `bufferRef.current`（**不 setCtx 不渲染**）；next===undefined 跳；cancelled 丢弃 | MUST 不渲染（buffer 变不触发 React rerender，半截 rawArgs 不给用户看）；MUST 同步写 ref 让下一帧 onEvent 立即读到最新 | req D1+D2+约束1「ctx 变才渲染，buffer 变不渲染」 | +12 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `handleFrame`（内部） | 修改 | SSE 帧 handler：调 `onEventRef.current(ctxRef.current, bufferRef.current, event, from)` 拿 `{ctx?,buffer?}` → 分别 commitCtx/commitBuffer | MUST 串行调度（一帧同步处理完才接下一帧，SseClient 顺序投递 + 同步链路无重入）；MUST ctx/buffer 分别独立 commit（互不阻塞） | req 约束3；§3.10 不变量⑦新增 | +12/-4 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `startTimerInterval`（内部） | 修改 | timer 到点：调 `onTickRef.current(ctxRef.current, bufferRef.current)` 拿 `{ctx?,buffer?}` → 分别 commit | MUST 与 handleFrame 一致双写路径 | req D1（onTick 也收 buffer） | +6/-2 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `runInit`（内部） | 修改 | onInit resolve 后：result 是 `{ctx,buffer}` 则分别写 ctxRef/bufferRef；result 是裸 TCtx（兼容）则 ctxRef=ctx, bufferRef=null；re-init/unmount 时 bufferRef 同步重置（bufferRef.current=null） | MUST re-init/unmount 时 bufferRef 重置（D2 ③reload/deps 变 re-init 重置）；MUST onDestroy 调用传 bufferRef.current | req D2 三层时机②③；§3.10 不变量⑤扩展 | +18/-6 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `mutate` | 修改 | **分裂为两个**：保留 `mutate`（向后兼容别名，内部调 mutateCtx）+ 新增 `mutateBuffer`。返回值改 `{ctx,loading,error,reload,mutateCtx,mutateBuffer}`（mutate 作 deprecated 别名，可保留或删，由 coder 决定） | MUST mutateCtx 改渲染态、mutateBuffer 改工作内存（不渲染）；MUST NOT 让 mutateBuffer 触发 setCtx | req §A 命令式口子；开放点①（coder 可保 mutate 别名或彻底删） | +20/-5 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `LifecycleResult` | 修改 | 返回类型加 `mutateCtx: (updater)=>void` + `mutateBuffer: (updater)=>void`；移除或保留 `mutate`（开放点①） | — | req §A | +4/-1 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `mutateCtx` | 新增 | 命令式改渲染态：`updater(ctxRef.current) => TCtx\|void` → commitCtx（同 v0.0.94 mutate 路径） | MUST 走 commitCtx（ref-latest 同步写 + setCtx）；updater 返 void 跳渲染 | §3.10 控制模型 | +8 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `mutateBuffer` | 新增 | 命令式改工作内存：`updater(bufferRef.current) => TBuffer\|void` → commitBuffer（不渲染） | MUST 走 commitBuffer（只写 ref 不 setCtx）；MUST NOT 触发 React 渲染 | req §A；约束1 | +8 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `bufferRef` | 新增 | `useRef<TBuffer | null>(null)` 持最新 buffer（同 ctxRef 模式）；每 render 同步 | MUST buffer ref-latest（同 ctxRef 不变量①扩展） | req D1 | +3 |
| lifecycle-core | app/web/src/lib/__tests__/use-lifecycle.test.ts | (test suite) | 修改 | 增 buffer 相关断言：①buffer 变不触发渲染（spy setCtx 不被调）；②连续高频 onEvent ctx+buffer 同步累积正确；③reducer 返删 key 的 buffer 后 bufferRef 已清；④串行调度（无 race）；⑤onDestroy 收 buffer 终值 | MUST 验不变量⑦（buffer 变不渲染）+ D2（buffer 清理）+ 串行不变量 | req 验证章节；§3.10 不变量⑦ | +120/-30 |
| reducer | app/web/src/store/chat-slice-reducer.ts | `applyAgentEventToMessages` | 修改 | **签名变更**：从 `(msgs, evt, ctxRef: {current: RunContext\|null}, state)` → `(msgs, runCtx: RunContext\|null, evt, state) => ReducerFullResult`；内部 6 个 ctxRef.current 副作用点全改 immutable return（run_start 新建 runCtx；tool_call_delta 新 Map 累积；tool_call_end 读+删 key 返新 Map；error 新对象含 pendingError；run_end 返 null） | MUST 纯函数（无 mutate 入参 / 无 ref 副作用）；MUST rawArgs 累积语义严格不变（tool_call_delta 累积进 runCtx.toolCallRawArgs，tool_call_end 写 ctx.messages + 删 rawArgs key）；MUST tool_call_end 返删 key 的新 Map（D2 落地） | req §B；§3.2 待更新 | +60/-40 |
| reducer | app/web/src/store/chat-slice-reducer.ts | `ReducerFullResult` | 新增 | `ReducerResult & { runCtx: RunContext \| null }`（reducer 输出合并 runCtx） | — | req §B | +2 |
| reducer | app/web/src/store/chat-slice.ts | re-export | 修改 | 增加 re-export `ReducerFullResult`（让 useMessages 拿到完整返回类型） | MUST NOT 删既有 re-export（AgentEvent/applyAgentEventToMessages/SessionEvent） | — | +1/-0 |

### T2 — useMessages 进契约 + 受影响消费方适配（area-hooks / studio / tests）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| area-hooks | app/web/src/components/chat-page/use-messages.ts | `useMessages` | 修改 | 重写为标准契约：ctx=`{messages,hasMore,runActive,loadingPhase,lastRunFinish,enqueueItems}` 走渲染通道；buffer=`{runCtx:RunContext\|null}` 走工作内存通道；onInit GET+subscribe 返 `{ctx,buffer:{runCtx:null}}`；onEvent agent_loop 分支调纯化 reducer 返 `{ctx:新, buffer:{runCtx:新}}`（双写）；session_panel messages_cleared / 终态孤儿清理保留；hasMore 进 ctx；命令式 setMessages/removeEnqueueItem 改走 mutateCtx | MUST 保流式语义不回归（每帧累积不丢字，靠 ①ref-latest ctx 通道）；MUST 删 sliceRef/runCtxRef/setSlice/setHasMore/genRef 自管（全转 useLifecycle）；MUST NOT 碰 sessionRunning/usage（归其它 area-hook）；MUST D7 终态孤儿清理逻辑保留 | req §C；chat_area_hooks §3 待更新；原则#10 | +120/-100 |
| area-hooks | app/web/src/components/chat-page/use-messages.ts | `UseMessagesResult` | 修改 | 返回类型签名不变（messages/hasMore/runActive/loadingPhase/lastRunFinish/enqueueItems/setMessages/removeEnqueueItem），但内部从 sliceRef/state 改读 ctx | MUST 对外 API 零变更（消费页 page-chat/member-chat 不感知） | — | +0/-0 |
| area-hooks | app/web/src/components/chat-page/use-messages.ts | `emptySlice` | 删除 | 重命名/改写为 `emptyCtx()`（返初始 ctx）+ `emptyBuffer()`（返 `{runCtx:null}`） | MUST NOT 保留旧 emptySlice（避免死代码） | 原则：删死代码不留 deprecate 标 | +6/-4 |
| studio | app/web/src/components/studio-page/section-squad-chat.tsx | （无需改） | 无改动 | v0.0.94 已 compose `useMessages`（line 42 import + line 87 hook 调用），line 17 仅注释提到 reducer（描述 useMessages 内部机制），无直接调 reducer；v0.0.95 reducer 纯化由 useMessages 内部承接，squad 间接受益零改动 | MUST NOT 改 squad 业务行为（v0.0.94 compose 已完成零回归） | §D 修正（v0.0.94 compose 事实） | +0/-0 |
| test | app/web/src/components/chat-page/__tests__/use-messages.test.tsx | (test suite) | 修改 | reducer 签名改后，断言 runCtx 改为读 result.runCtx（而非 ctxRef.current）；保留所有现有断言（GET/agent_loop 流式/messages_cleared/D7 终态/setMessages/removeEnqueueItem/cleanup）；**新增 buffer UT**：跑一轮 tool_call（start→delta→end）后 buffer.runCtx.toolCallRawArgs 中对应 key 已删（D2 验证） | MUST 保留全部现有断言（流式不回归）；MUST 新增 buffer 清理 UT（D2 落地验证） | req §验证；req D2 | +40/-15 |
| test | app/web/src/components/chat-page/__tests__/chat-slice.test.ts | (test suite) | 修改 | reducer 调用从 `(state.messages, e, ctxRef, state)` 改 `(state.messages, runCtx, e, state) => {messages, runCtx, ...}`；`reduce()` helper 改为传 runCtx 进出累积；断言 path A/B/C + run-finish 行为不变 | MUST NOT 改测试场景（path A/B/C 全保留，验证 reducer 行为零回归）；MUST 验证 runCtx 在各 case 的累积/清理语义 | req §B（rawArgs 累积不回归 BUG-002） | +30/-15 |
| test | app/web/src/components/chat-page/__tests__/enqueue-abort.test.tsx | (test suite) | 修改 | 同 chat-slice.test：reducer 调用签名改 + runCtx 走返回值 | MUST 验 enqueue/cancel 幂等移除语义不回归 | — | +8/-4 |

## spec 演进（spec 文件修改，doc-modifier 阶段 5 执行，本表仅声明意图）

> 本版 spec 改动以「演进既有章节」为主（不重写），架构期已确认方向：

| spec 文件 | 章节 | 改动 |
|---|---|---|
| `specs/tech/app/frontend/[P0]component_architecture.md` | §3.10 | 增 buffer 第三参数：onInit 返 `{ctx,buffer}`；onEvent/onTick 收 ctx+buffer 返 `{ctx?,buffer?}`；onDestroy 收 buffer；双写路径（ctx→渲染/buffer→不渲染）；新增**不变量⑦ buffer 变不渲染**；新增**不变量⑧ onEvent 串行调度**（一帧同步处理完才接下一帧）；命令式口子 mutateCtx/mutateBuffer 分立；D2 buffer 清理三层时机 |
| `specs/tech/app/frontend/[P0]chat_area_hooks.md` | §3 | useMessages 从「流式特例（自管 sliceRef+runCtxRef，onEvent 返 void）」改「标准契约（ctx 渲染通道 + buffer 工作内存通道）」；删「领域 reducer 不进契约纯函数通道」表述（因 reducer 已纯化）；保留多订阅样板地位（agent_loop + session_panel）；删 §3 末尾「v0.0.95 预告」段（已落地） |
| `specs/tech/app/frontend/[P0]lifecycle_data_shapes.md` | §3.2 | 标题改「为什么 useMessages 走 buffer 第三参数（原流式特例）」；结论改：reducer 已纯化（无 ctxRef mutate），通过 buffer 参数承担跨帧累积，进契约纯函数通道；保留「不套 applyCrud」结论（粒度理由仍成立） |

## 待用户裁决的开放点

### ① mutate / mutateCtx / mutateBuffer 命名策略

- **推荐**：`mutate` 彻底分裂为 `mutateCtx` + `mutateBuffer` 两个，**删旧 `mutate`**（不留别名）。
- **理由**：(a) 旧 `mutate` 语义含糊（既改 ctx 又触发渲染，buffer 概念出现后无法表达「改不渲染态」）；(b) 留别名让消费方面对三个口子（mutate/mutateCtx/mutateBuffer）增加心智负担，违背"消灭特例"的版意；(c) v0.0.94 刚落，调用方少（grep 确认 use-run-state / use-page-chat-mount 等 5 处用 mutate），一并改名成本低。
- **替代方案**：保 `mutate` 别名（内部调 mutateCtx），仅新增 mutateBuffer。代价是接口冗余。
- **architect 推荐**：方案 A（彻底分裂删旧）。

### ② buffer 是否对外只读（useMessages 是否暴露 buffer 给消费方）

- **推荐**：**不暴露**。buffer 是 hook 私有工作内存（reducer 跨帧累积的中间态），消费方（page-chat/member-chat）只读 ctx 字段渲染即可。命令式操作（setMessages/removeEnqueueItem）走 mutateCtx 不碰 buffer。
- **理由**：(a) 半截 rawArgs 给消费方无意义且易误用；(b) buffer 暴露破坏封装（消费方依赖 hook 内部累积实现细节）；(c) useMessages 的 buffer 形状（`{runCtx}`）可能后续演化（如增 idMap），暴露会锁死接口。
- **architect 推荐**：buffer 完全私有，`UseMessagesResult` 不含 buffer 字段。

## spec↔code 漂移清单（架构期发现，交 doc-modifier 阶段 5 处理）

| 漂移点 | spec 表述 | 代码实际 | 处理 |
|---|---|---|---|
| `chat_area_hooks.md §3` ctx 结构 | 「ctx = `{result: ReducerResult, runCtx: RunContext\|null}`，onEvent 内调 reducer 后返回 `{result: next, runCtx: runCtxRef.current}`」 | use-messages.ts 实际 ctx 恒为 null（`useLifecycle<null,...>`），onEvent 返 void 不走 ctx 通道；自管 sliceRef+runCtxRef+setSlice | 本版架构对齐：改 useMessages 让代码符合 spec 的「ctx 走渲染通道」原意（buffer 加进来后 spec 与代码均演进到 ctx+buffer 双通道，原漂移消失） |

## 文件级变更清单（按文件汇总，给 planner 切 task 用）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/web/src/lib/use-lifecycle.ts` | 修改 | 加 TBuffer 泛型；LifecycleContract 四方法签名加 buffer；LifecycleResult 加 mutateCtx/mutateBuffer；内部增 bufferRef + commitBuffer + handleFrame/startTimerInterval/runInit 双写路径；mutate 拆分为 mutateCtx+mutateBuffer（开放点①决定是否保留 mutate 别名） |
| `app/web/src/lib/__tests__/use-lifecycle.test.ts` | 修改 | 增 buffer 不渲染 UT + 串行调度 UT + buffer 清理 UT + ctx+buffer 同步累积 UT |
| `app/web/src/store/chat-slice-reducer.ts` | 修改 | applyAgentEventToMessages 签名变（runCtx 入参 + ReducerFullResult 返回）；6 个 ctxRef.current 副作用点全改 immutable return；新增 ReducerFullResult 类型 |
| `app/web/src/store/chat-slice.ts` | 修改 | re-export ReducerFullResult |
| `app/web/src/components/chat-page/use-messages.ts` | 修改 | 重写为标准契约：ctx 渲染通道 + buffer 工作内存通道；删 sliceRef/runCtxRef/setSlice/setHasMore/genRef；onEvent 调纯化 reducer 返 {ctx,buffer}；setMessages/removeEnqueueItem 改走 mutateCtx；emptySlice 拆 emptyCtx/emptyBuffer |
| `app/web/src/components/studio-page/section-squad-chat.tsx` | 无改动 | v0.0.94 已 compose useMessages，本版无需直接适配（间接受益） |
| `app/web/src/components/chat-page/__tests__/use-messages.test.tsx` | 修改 | reducer 调用签名改；断言 runCtx 走返回值；新增 D2 buffer 清理 UT |
| `app/web/src/components/chat-page/__tests__/chat-slice.test.ts` | 修改 | reducer 调用签名改；reduce helper 改 runCtx 进出累积；保留全部 path A/B/C 场景 |
| `app/web/src/components/chat-page/__tests__/enqueue-abort.test.tsx` | 修改 | reducer 调用签名改 |
| `specs/tech/app/frontend/[P0]component_architecture.md` | 修改（doc-modifier 阶段5） | §3.10 增 buffer 第三参数 + 不变量⑦⑧ + 命令式口子分立 |
| `specs/tech/app/frontend/[P0]chat_area_hooks.md` | 修改（doc-modifier 阶段5） | §3 useMessages 从特例改标准契约 + 删 v0.0.95 预告段 |
| `specs/tech/app/frontend/[P0]lifecycle_data_shapes.md` | 修改（doc-modifier 阶段5） | §3.2 标题与结论改（reducer 已纯化，buffer 参数承担累积） |
