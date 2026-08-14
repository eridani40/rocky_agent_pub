# chat 页数据流与后端交互（单一权威 — `_data-flow.md`）

> 层级: 横切规范（适用 playground chat / studio 单聊 / studio 群聊 三处 chat root）
> 文件: 本文件是 chat 页**数据驱动 + 后端交互契约**的单一权威——`use-messages.ts` / `use-run-state.ts` / `use-chat-actions.ts` / `message-flatten.ts` 的链路真相源。`_overview.md §0/§2/§5` 是一句话摘要，细节以本文为准。
> 消费者：实现 chat area-hook / 修发送与 enqueue 链路 / 排查「气泡不显示 / 排队卡住 / run 卡 running」类问题时必读。

## 0. 为什么单独立项（非显而易见的 why）

chat 页看似「输入 → 出气泡」的简单循环，但实际是**双通道 reducer + 多订阅 SSE + 3 路 GET 冷启动 seed + 跨客户端一致性**的复合系统。关键非显而易见的设计决策：

1. **对话区从不本地乐观插入 user 气泡**（INV-1，BUG-006 根治）：user 气泡只渲染服务端 SSE `message_start` 的 messageId（ULID）。POST /messages 仅触发后端，不等它返、不本地 push——避免「客户端临时 id vs 服务端 ULID」双轨制（旧版本因乐观插入导致 id 撞车 / 工具结果绑不上 / 多端气泡数不一致）。
2. **enqueue 队列加/移项纯 SSE 驱动，不进 store**（INV-1/INV-5）：客户端 A 发消息、客户端 B 取消、服务端 drain 处理，三端通过同一套 SSE 事件达到一致；前端命令式增删队列会破坏多端一致性。
3. **reducer 双通道**（ctx 渲染通道 + buffer 工作内存通道）：半截 tool_call 参数、待显 error payload 这类**跨帧中间态**走 buffer（不渲染），完整态才进 ctx。若中间态进渲染会抖屏（半截 JSON 参数一会儿有一会儿没）。
4. **单次 flatten 记忆化分发**（架构决策）：`useFlattenedView` 在 section 层跑一次 `flattenAndGroup`，结果**同源分发给** `ComponentMessageStream`（flattened prop）+ `deriveMinimapBars`（elements）——保证 minimap bar 数 = 可见右侧 user 气泡数**恒等**。若各算一次，filter / group 漂移会导致 bar 与气泡对不上。
5. **No optimistic insert ≠ No optimistic UI**：HITL 回填（b 路径）和 HITL 放弃（c 路径）**有**乐观清 `pendingToolCall`（卡片立即 unmount 给即时反馈），但消息体本身仍等 SSE。

## 1. chat 数据驱动来源（数据从哪来）

### 1.1 三路 GET 冷启动 seed（subscribe-first 顺序 D8）

`useMessages.onInit` 按 **subscribe-first** 顺序执行（先 subscribe 再 GET，避免「GET 返回到 subscribe 之间的事件丢失」）：

| 顺序 | 端点 | 用途 | 失败降级 |
|------|------|------|----------|
| 0 | `subscribe('agent_loop', 'session_id:{sid}_amt:current')` | 流式消息通道 | 不订阅 = 收不到任何增量 |
| 0 | `subscribe('session_panel', 'session_id:{sid}')` | 控制态通道 | 不订阅 = 收不到 status_update |
| 1 | `GET /session/:id/messages?limit=50` | transcript 基线（含 hasMore 分页） | 失败：保空基线，SSE 仍可推增量 |
| 2 | `GET /session/:id/inbox` | enqueueItems seed（切走切回恢复） | 失败：降空，SSE `message_enqueued` 仍可推 |
| 3 | `GET /session/:id/pending-tool-call` | HITL 悬挂队首 seed（recover 提问/审批卡） | 失败：降 null，SSE `require_human_input` 仍可推 |

**为什么需要 GET /inbox + GET /pending-tool-call seed**：SSE 无 sticky replay——用户切走再切回、或刷新页面，订阅前发生的事件（`message_enqueued` / `require_human_input`）永远不会补推。所以靠 GET 主动 seed 当前快照，订阅后的增量靠 SSE。

### 1.2 两路 SSE 实时增量（多订阅 useLifecycle 不变量⑥）

`useLifecycle` 同一个 hook 可订阅多 topic，`onEvent` 按 `from.topic` switch：

**`agent_loop` topic（流式消息）**：
- `run_start` → `runActive=true / loadingPhase='thinking'`
- `message_start(role=user)` → 入 user 气泡（messageId = 服务端 ULID，唯一来源）
- `message_start(role=assistant)` → 建空 assistant message（占位，等增量）
- `text_delta` → 累积 assistant 的 `TextBlock.text`（part key = `messageId:text-index`，SSE 乱序不抖）
- `tool_call_delta` → 累积 `ToolCallBlock.arguments`（**半截 JSON 进 buffer.runCtx 不渲染**，完整 tool_call block 才进 ctx）
- `tool_execution_start/end` → `runningToolNames`（spinner 显「运行工具: X」）
- `tool_result`（或扫 `role=tool` 消息）→ 建 `Map<toolCallId, ToolResultBlock>` 绑定到对应 call
- `message_enqueued` / `enqueued_message_processed` / `enqueued_message_canceled` → enqueueItems 加/移（见 §2）
- `require_human_input` → `pendingToolCall`（mount 提问/审批卡）
- `llm_attempt(RETRY/ROTATE_KEY/FALLBACK)` → `retryStatus`（运行气泡显「重试中 x/x」+ ！icon）
- `error` → `buffer.pendingError`（**不进 ctx**，防闪屏；`run_end` 时若 stopReason=error 才组装进 `lastRunFinish.error`）
- `run_end` → `runActive=false / lastRunFinish={stopReason, error?} / buffer.runCtx=null`

**`session_panel` topic（控制态 + 跨 area-hook 扇出）**：`useMessages` 只消费三类，其余归 `useRunState` / `useUsage` / `useSummary` / `useSessionPanelFanout`：
- `messages_cleared` → 清对话区（messages/lastRunFinish/enqueueItems/pendingToolCall 全清，`POST /clear` 后端 emit）
- `session_status_update` 进终态（idle/error/interrupted）→ **强制清 sticky run_start 孤儿**（治 D7：session 卡死时 `run_end` 不到达，靠 session_panel 终态互补，`runActive=false / loadingPhase=null / retryStatus=null`）
- `session_status_update` 进 running/interrupting → **清 HITL 悬挂**（治悬挂卡片不消失：子 agent / 另一个 tab / 后台激活进 running 时，原清除只挂本客户端显式动作 → 提问/审批卡悬挂）

### 1.3 双通道 reducer（架构决策）

`useMessages` 持两份状态（`useLifecycle<MessagesCtx, ..., MessagesBuffer>`）：

| 通道 | 持久度 | 字段 | 用途 |
|------|--------|------|------|
| **ctx**（渲染通道） | 每帧 `setCtx` 触发 React 渲染 | messages / hasMore / runActive / loadingPhase / lastRunFinish / enqueueItems / pendingToolCall / runningToolNames / retryStatus | 直接驱动 UI |
| **buffer**（工作内存通道） | `bufferRef.current` 写回，**不触发渲染** | `runCtx`（跨帧累积半截 toolCallRawArgs / pendingError / currentAssistantMessageId） | reducer 跨帧中间态，完整后才进 ctx |

`onEvent` 签名 `(ctx, event, from, buffer)` → reducer 返 `{ctx, buffer}` 双写。

**ref-latest 不变量①**：`useLifecycle` 的 `ctxRef` 持续同步最新 ctx，`onEvent` 每帧收 `ctxRef.current`（最新非 React 快照）——保证 agent_loop 高频 `text_delta` 不丢字（React batching 延迟 `setCtx` 会读到 stale ctx 丢字）。

### 1.4 flatten + group 管线（视图层合并）

**单次 flatten 记忆化**（`use-flattened-view.ts`）：`useFlattenedView(messages, opts)` 在 section 层跑一次 `flattenAndGroup`，`useMemo` 在 messages/opts 引用不变时不重算。结果同源分发给：
- `ComponentMessageStream`（`flattened` prop）→ 渲染气泡 / tool-batch
- `deriveMinimapBars(fv.elements, messages)` → 历史 minimap 的 bar 数

**管线阶段**（`message-flatten.ts`）：
1. `messageFilter`（消息级白名单，群聊用 `isUser || isA2aInbox`）先筛
2. `flattenMessages`（block 级过滤 `DEFAULT_BLOCK_FILTER` 滤 `isSystemReminder=true` text block）→ `ViewElement[]`（**4 种**：user-text / agent-answer / tool-call-item / send-message-envelope——[v0.0.310] send_message 出站信封为第 4 kind，独立成行）
3. `groupToolBatches` → 任意连续 tool-call-item 合并为一个 batch（跨消息边界、遇非 tool 元素断开）；**send-message-envelope 天然断裂 batch**（信封不进 tool-batch，前一 batch 到此终止、后一 batch 从其后 tool-call-item 重新起组，见 `build-render-rows.ts`）

**part key 稳定性**：`${messageId}:u${text-index}` / `${messageId}:t${text-index}` / `${messageId}:c:${toolCallId}`——非数组 index，SSE 乱序/增量更新不抖动。

**text-index 编号按原 text block 总数**（不是过滤后）：被 blockFilter 滤掉的 reminder block 仍占编号位，避免其他 text block 的 key 跳变。

### 1.5 关键不变量（INV）

| INV | 内容 | 为什么 |
|-----|------|--------|
| INV-1 | 队列加/移项只由 SSE 驱动 | 多端一致（客户端 A 发、客户端 B 取消，两端通过同一 SSE 状态收敛） |
| INV-5 | 命令式 `cancelEnqueue` 仅 POST /cancel，不改本地队列 | 同上；移项靠 `enqueued_message_canceled` SSE |
| INV-7 | cancel POST 幂等可重试 | 来晚的 cancel 若消息已 processed，前端按 `enqueued_message_processed` 也会按 enqueueId 出列（幂等） |
| ref-latest | `onEvent` 每帧收最新 ctx（非 React 快照） | 高频 `text_delta` 不丢字 |
| `mergeMessagesById` | transcript fetch（loadMore / 切走切回）按 messageId merge | 不重置 SSE 累积态（旧 message 已收 text_delta，重拉不能覆盖成空） |

## 2. enqueue 区域展示条件（非显而易见）

### 2.1 可见性门控（两道）

| 门控 | 位置 | 条件 |
|------|------|------|
| 外层（挂载） | `component-run-state-bar.tsx` `showEnqueue` prop | `true` 默认；playground subagent readOnly mode 传 `false`（随 input-bar 一并隐藏） |
| 内层（渲染） | `component-enqueue-view.tsx` 函数体首行 | `sessionRunning === true && items.length > 0`——否则 `return null`（不占排版流） |

### 2.2 为什么 running 时才展示（非显而易见的 why）

session **idle/interrupted/error** 态发消息：后端立即 activate 新 run，消息**不排队**——直接走 `message_start(role=user)` 进对话区，enqueue 队列始终为空。

session **running** 态发消息：后端 enqueue 到 inbox（返 `already_activated`，不启新 loop），等当前 run 结束后 drain 处理——此时 inbox 非空，enqueue-view 显示这些 pending 项给用户「排队中」反馈。

session **interrupting** 态发消息：enqueue 后 activate 循环等待，abort 收尾完成后新 loop drain。

**结论**：`sessionRunning === false` 时 inbox 逻辑上必为空（drain 已处理完）；`sessionRunning === true && items.length === 0` 时（刚 running 但用户没发新消息）也不展示——只有真有排队项才展示。

### 2.3 队列驱动（纯 SSE 三事件）

| 事件 | reducer 行为 |
|------|--------------|
| `message_enqueued` | 按 `enqueueId` 幂等入列（`some(enqueueId)` 防双计：GET /inbox seed 与 SSE 重放） |
| `enqueued_message_processed` | 按 `enqueueId` 幂等出列（drain 处理了这条） |
| `enqueued_message_canceled` | 按 `enqueueId` 幂等出列（用户/另一端取消了） |

`processed` 与 `canceled` 二者**只可能到达其一**；已乐观移除（GET 时已不在）则无操作。

`message_enqueued.content` 是 `ContentBlock[]`，reducer 内 `contentBlocksToPreviewText` 拍平为 string 存入 `EnqueueItem.content`（避免 `ComponentEnqueueView` 把 `{type,text}` 对象当 React child 渲染崩树，BUG-007）。

### 2.4 cancel 链路

点 `enqueue-item-{enqueueId}-cancel` → 本地 `canceling Set` 加 enqueueId（**X 立即转 spinner**，转圈期禁点防重复 POST）→ `POST /session/:id/messages/:enqueueId/cancel`（202 fire-and-forget，不监听成败）→ 后端 emit `enqueued_message_canceled` → 前端按 enqueueId 出列 → 1s 后回 X（cancel POST 幂等 INV-7，不监听 SSE 也能自愈）。

**竞态兜底**：cancel 来晚、消息已先一步 processed → 前端收到 `enqueued_message_processed` 也按 enqueueId 出列（幂等）。队列移项**始终靠 SSE**，不进 store INV-1/INV-5。

## 3. 与后端交互逻辑（HTTP + SSE 全链路）

### 3.1 发消息（POST /messages）

**body** = `{ content: string, toolReply?: {...} }`：
- `content` 是 mention 以 `<mention type="..." path|kind+id|id=".." icon=".." label=".." [badge=".."]/>` 内联标签嵌入的字符串（Tiptap doc 经 `serializeEditorContent` 序列化）
- `toolReply` 仅 HITL b 路径（§3.5）用；普通发消息不带
- **不再 body 带 providerId/modelId override**（v0.0.158 删）：picker 变化在 `handleModelChange` 立即 `PUT /session` 落库；发消息 body 只含 content/toolReply，server 用 session record resolve

**响应** = `{ runId, enqueueId }`：
- 前端**不存 runId**（SSE `run_start` 是 run 态权威源，HTTP 响应只是 ack）
- `enqueueId` 仅作 cancel 句柄透传用（不进 UI state INV-1）

### 3.2 三态分支（sessionRunning 决定）

| session 状态 | POST 后后端行为 | UI 现象 |
|--------------|-----------------|---------|
| **idle / interrupted / error** | 立即 activate 新 loop | `message_start(user)` 渲染气泡 → loading → assistant 流式增量 → `run_end` |
| **running** | enqueue 到 inbox，不启新 loop（返 already_activated） | enqueue-view 显该 pending 项 → 当前 run 结束 drain 处理 → `message_start(user)` 渲染 + `enqueued_message_processed` 出列 → 继续 run |
| **interrupting** | enqueue 后 activate 循环等待（poll），abort 收尾完成后新 loop drain | enqueue-view 显项 → abort 收尾完成后 drain |

### 3.3 abort 链路（中断当前 run）

`useRunState.abort()` → `POST /session/:id/abort`（202 fire-and-forget）→ 后端 4 步收尾：
1. loop 退出
2. partial assistant message 持久化（已生成的字保留）
3. `clearReplay`（清回放快照）
4. `state→interrupted` + `run_stop(interrupted)`

**UI 现象链**：
- `session_status_update(state=interrupting)` → abort-btn 禁用、圆环减速视觉反馈
- `session_status_update(state=interrupted)` → `sessionRunning=false`
- `run_end` (stopReason=interrupted) → `lastRunFinish` 渲染「已中断」、loading 消失、abort-btn 消失

**不在 interrupting 态触发 GET 校正**（避免与 abort 收尾竞态）：`useRunState` 的 `run_end` GET 校正分支显式排除 `interrupting` 态。

#### 3.3.1 中断动作 = 既有 abort + cancel 的产品层编排（ESC + 红钮统一入口）

「中断」的用户语义从「点红钮仅 abort」升级为统一产品动作——ESC（焦点门控通过后）与红钮（任意焦点位置兜底）任一触发都执行同一 handler（`component-chat-session-input.tsx::handleInterrupt`），步骤对齐 PRD：

| 步骤 | 调用 | 后端 |
|------|------|------|
| 1 snapshot enqueueItems | 闭包读 `enqueueItems` | — |
| 2 取消全部排队 | `items.forEach(onEnqueueCancel)` = `POST /session/:id/messages/:enqueueId/cancel` 逐条 fire-and-forget（202） | 后端 emit `enqueued_message_canceled`（移项靠 SSE，INV-1/5 不进 store；cancel 幂等 INV-7） |
| 3 注入排队内容到输入区开头 | `composerRef.applyInterrupt(items.map(it => ({content: it.content})))`——`mention-tag.ts::deserializeContentToParagraphs` 反序列化（保留 mention pill）+ `buildInterruptTransaction` 构 `tr.insert(0, nodes)` + 焦点管理两分支 | — |
| 4 abort 当前 run | `onAbort()` = `useRunState.abort()` | `POST /session/:id/abort`（见上节 4 步收尾） |

**零后端改动**：abort + cancel 既有端点零改；本节是纯前端把分散的「中断相关动作」编排进单一 handler。编排逻辑 + 焦点管理两分支 + 反序列化器契约细节见 `chat-composer.md`「中断注入」节。

### 3.4 run 态权威源（useRunState）

**`sessionRunning` / `sessionState` 唯一持者是 `useRunState`**（其他 area-hook 不重复 compute）：
- `onInit GET /session` 拉基线 `{running, state}` 作为 ctx 返回
- `session_panel session_status_update` → reducer → 更新 ctx
- `agent_loop run_end` 且 `sessionRunning` 仍 true 且非 interrupting → 异步 `GET /session` 校正（**治 D6 卡 running**：session 卡死时 session_status_update 不达，靠 run_end 触发 GET 兜底）

### 3.5 HITL（Human-in-the-Loop）三条路径

后端 `require_human_input` SSE → `pendingToolCall` → mount 提问卡（`subState=need_feedback`）或审批卡（`subState=need_approval`）。用户响应有三条路径：

| 路径 | 触发 | 前端行为 | 后端行为 |
|------|------|----------|----------|
| **b（回填）** | 点卡的提交按钮 | 乐观清 `pendingToolCall`（卡片立即 unmount）+ POST /messages body 加 `toolReply: {toolCallId, handleType, payload}` | pre-process 编辑占位 block + resolve → emit 下一个 `require_human_input`（多 pending 串行）或续 LLM |
| **c（放弃）** | suspended 态用户发普通 query（无 toolReply） | `handleSend` 同步清本地 `pendingToolCall` + POST /messages（只带 content） | 检测「有 pending + user query」清空 pendingToolCalls + 占位原样发 LLM |
| **悬挂自愈** | 子 agent / 另一 tab / 后台激活进 running | `session_status_update` 进 running/interrupting → 强制清 `pendingToolCall` | （清除只挂本客户端显式动作的原方案有死角，靠 SSE 单点修覆盖两卡） |

`handleType` 三分发：`direct_result`（ask-question）/ `approval` / `callback`——后端按 type 走不同 pre-process。

### 3.6 冷读 seed lastRunFinish（run-finish 不丢）

`useMessages.onInit` 在 GET /messages 成功后，**倒序找最后一条带 `stopReason` 的 message**（后端在 message 上 join 了 run 结束态下发）→ 组装成 `lastRunFinish`：

- `stopReason !== 'error'` → `{stopReason}`
- `stopReason === 'error'` 且 `message.runError` 存在 → `{stopReason, error: {category, displayReason, detail?}}`（契约对齐 SSE `run_end` 分支）

切走切回 / 重启后，SSE `run_end` 无 sticky replay → 靠 GET seed 恢复 run-finish 显示；之后 SSE `run_end` 到达时 reducer 覆盖为同值（无冲突）。

### 3.7 lastRunFinish 渲染门控（非显而易见）

**渲染条件** = `lastRunFinish != null && sessionRunning === false`：
- running 中**不渲染 finish**（此时由 on-message spinner 表达进行态，finish 隐藏避免与「生成中」叠加）
- 切会话 / 重开恢复时 GET /session 若已 running → finish 不渲染直到 session 转 idle/interrupted/error
- **仅最近一次 run（last run）**在其末条消息下方渲染；历史 run 不重复渲染（UI 不堆叠多个 finish）

## 4. 偏离本数据流契约的常见陷阱（排障清单）

| 症状 | 可能根因（违反本文哪条） |
|------|--------------------------|
| 发消息后 user 气泡迟迟不出现 | POST 误用乐观插入（违反 §0 INV-1）；或 SSE 未订 agent_loop topic |
| 切走切回后 enqueue / 提问卡丢失 | onInit 顺序错（GET 先于 subscribe，违反 §1.1 D8）；或漏 GET /inbox / /pending-tool-call |
| minimap bar 数与气泡数对不上 | 没用 useFlattenedView 单次分发，各算一次 flatten（违反 §0.4 / §1.4） |
| 高频流式时偶发丢字 | onEvent 读 stale ctx 而非 ctxRef.current（违反 ref-latest 不变量①） |
| 排队消息取消后队列未移 | cancel POST 后改了本地 store（违反 INV-5）；应靠 `enqueued_message_canceled` SSE |
| run 已结束但 session 卡 running | 缺 run_end GET 校正（违反 §3.4 D6 兜底） |
| 工具结果绑不上对应 call | part key 用了数组 index 而非 `messageId + toolCallId`（违反 §1.4 part key） |
