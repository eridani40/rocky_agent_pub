## §4 PRD ↔ ui/tech spec 对齐核对

> 本版不发明新概念。所有引用必须与 v0.0.94 已落地的概念权威源一致。buffer = v0.0.94 design-decisions §4「三形」+ `[P0]chat_area_hooks.md §3`「v0.0.95 预告」里隐含的「特例 reducer 工作内存」的**契约正名**——把 `useMessages` 自管的 `runCtxRef` 副作用参数化为契约一等公民。

### 4.1 概念引用对齐表（PRD ↔ spec）

| PRD 引用概念 | spec 权威源 | 一致性 |
|--------------|-------------|--------|
| useLifecycle 四方法（onInit/onDestroy/onTick/onEvent） | `[P0]component_architecture.md §3.10` | ✅ 沿用，仅扩签名（加 buffer 参数） |
| ① ctx ref-latest 不变量 | `§3.10` 不变量 1 | ✅ 沿用（buffer 同样走 ref-latest 写回路径） |
| mutate 命令式口子 | `§3.10` 控制模型 | ✅ 沿用；新增 `mutateBuffer` 平级口子（开放点 A 见下） |
| effect 声明式订阅（subscribe/startTimer） | `§3.10` 不变量 5/6 | ✅ 本版不动 |
| reload-on-resume = poll-only | `§3.10` reload-on-resume | ✅ 本版不动（reload 重置 ctx + buffer） |
| 三形（Collection/Snapshot/KeyedMap）+ 三 reducer | `[P0]lifecycle_data_shapes.md §2` | ✅ 本版不动三形（buffer 对它们恒 null） |
| useMessages 流式特例 → v0.0.95 进契约 | `[P0]chat_area_hooks.md §3` v0.0.95 预告 + `[P0]lifecycle_data_shapes.md §3.2` | ✅ 本版执行该预告 |
| `applyAgentEventToMessages` reducer 签名 | `chat-slice-reducer.ts:103-108`（`msgs, evt, ctxRef, state` → `ReducerResult`） | ⚠️ **本版改签名**：从 mutate ctxRef 改成 `return {ctx, buffer}`（reducer 纯化），spec 同步 |
| `RunContext` 结构（runId/currentAssistantMessageId/toolCallRawArgs/pendingError） | `chat-slice-reducer.ts:81-88` | ✅ **buffer 形的核心**：`toolCallRawArgs`/`pendingError` 进 buffer；`runId`/`currentAssistantMessageId` 可进 buffer 或 ctx（开放点 B） |
| useMessages ctx 结构（messages/runActive/loadingPhase/lastRunFinish/enqueueItems） | `[P0]chat_area_hooks.md §3` + `use-messages.ts:62-65` | ✅ ctx 不变（仍渲染态）；buffer = RunContext 累积态 |
| onEvent 多订阅按 from.topic switch | `§3.10` 不变量 6 | ✅ useMessages 多订阅（agent_loop + session_panel）不变 |
| runCtx ref 跨帧累积 → buffer 单实例 | req 约束 2 + `use-messages.ts:80` | ✅ 一个 hook 一个 buffer（bufferRef），所有 event 共享 |
| onEvent 串行 | req 约束 3 | ✅ 新增契约保证（不变量 7 新增） |

### 4.2 发现的 spec 待同步项（doc-modifier 阶段 5 处理）

| 项 | 现状 spec | 本版变更 | 处理 |
|----|-----------|----------|------|
| `[P0]component_architecture.md §3.10` 签名 | `useLifecycle<TCtx,TEvent>` 双泛型 | 加 `TBuffer` 第三泛型（可选，默认 null/void） | architect 落 change_plan + coder 实现 + doc-modifier 改 spec |
| `[P0]component_architecture.md §3.10` 不变量 | 6 不变量 | 加不变量 7：onEvent 串行调度（单 buffer race 防护） | 同上 |
| `[P0]chat_area_hooks.md §3` | 「流式特例 / v0.0.95 预告」 | 删特例章节，改「标准契约 + buffer 范例」 | doc-modifier |
| `[P0]lifecycle_data_shapes.md §3.2` | 「三形之外的第四类流式特例」 | 改「v0.0.95 已进契约（buffer 第三参数），保留领域 reducer 但走纯函数通道」 | doc-modifier |
| `chat-slice-reducer.ts` `applyAgentEventToMessages` 注释 | 「纯函数，便于单测」（实际 mutate ctxRef） | 改「真纯函数：return {ctx, buffer}」（spec 与代码对齐，fix v0.0.94 spec 与实现的偏差） | coder |

### 4.3 开放点（交 architect 在架构期定，PRD 不预设）

#### 开放点 A：mutateCtx / mutateBuffer 是否分立两个 API

req.md 契约草案写「命令式口子分两个：`mutateCtx(up => 新ctx)`（触发渲染）/ `mutateBuffer(up => 新buffer)`（不渲染）」。**建议分立**（语义清晰：渲染 vs 不渲染），但需 architect 定：
- **方案 A1（分立，推荐）**：两个 API，调用方明确意图；`mutate` 沿用 v0.0.94 名（= mutateCtx）保兼容。
- **方案 A2（合并）**：`mutate({ctx?, buffer?})` 一个 API，按字段是否提供决定渲染。简洁但隐式。

PRD 倾向 A1（与 req.md 一致），最终由 architect 裁决。

#### 开放点 B：RunContext 的 runId/currentAssistantMessageId 进 ctx 还是 buffer

`RunContext`（`chat-slice-reducer.ts:83-88`）含四字段：`runId` / `currentAssistantMessageId` / `toolCallRawArgs` / `pendingError`。后两明显属 buffer（半截累积），前两属元信息：
- **方案 B1（全进 buffer）**：整个 RunContext 当 buffer，ctx 只持 ReducerResult（messages+状态切片）。简单——buffer 类型 = RunContext。
- **方案 B2（拆分）**：runId/currentAssistantMessageId 进 ctx（可在 UI 显示 runId？现状不显示），rawArgs/pendingError 进 buffer。语义纯净但类型拆碎。

PRD 倾向 B1（buffer = RunContext 整体，类型简单，reducer 改动最小），由 architect 定。

#### 开放点 C：buffer 是否对外只读暴露

useMessages 的外部消费方（ComponentMessageStream 等）目前只读 messages/runActive 等 ctx 字段，不读 rawArgs。buffer 是否需要在 useLifecycle 返回值里暴露？
- **方案 C1（不暴露，推荐）**：`useLifecycle` 返 `{ctx, loading, error, reload, mutate}`（无 buffer）；buffer 完全是 reducer 内部工作内存。useMessages 不返 buffer 字段。
- **方案 C2（只读暴露）**：返 `buffer` 字段供 debug/observability。增加 API surface。

PRD 倾向 C1（buffer 私有，不增加 hook 返回复杂度），由 architect 定。

### 4.4 与 v0.0.94 design-decisions 的一致性核对

| design-decisions 条款 | 本版状态 |
|----------------------|----------|
| §1 范围（全部迁移含对话区引擎） | v0.0.94 已落 useMessages 特例；本版补完最后特例 |
| §3 ①ref-latest 不变量 | ✅ 沿用，buffer 同样走 ref-latest |
| §4 数据三形标准化 | ✅ 三形不动；buffer 是三形之外的 reducer 工作内存正名（非新数据形） |
| §5 控制模型（useLifecycle 持句柄，mutate 口子） | ✅ 沿用；新增 mutateBuffer 平级口子 |
| §7 原子化（一个 hook 恰好持一形一块数据） | ✅ useMessages 进契约后仍持一块（ctx=渲染态 + buffer=工作内存，同属 useMessages 一块） |
| §8 待确认逐条落定 | v0.0.94 已落，本版无新增「待确认」 |
