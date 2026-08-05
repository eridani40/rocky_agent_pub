# v0.0.39 Tech Change Log — squad 对话 UI 重写（共享渲染内核 ChatStream + reminder 块级标记）

> version: 1.2 · 2026-07-01（Round 3 追加：共享 run 态 UI 组装层 ComponentRunStateBar + 补接单聊 enqueue 排队区；Round 2：共享 run 态引擎 + store 瘦身 + P1 bizType 守卫 + 瞬态修复）
> 范围：squad 对话 UI（群聊 + 单聊）渲染层重写为共享内核；reminder 注入加块级 `isSystemReminder` 标记（前端精确过滤 + LLM 零侵入）。**无 API 变更**（reminder 仍发 LLM、GET /messages 零过滤不变）；**无 PRD 改动**。
> 权威输入：本 worktree（`worktrees/v0.0.39-squad-ui`）实现的 `component-message-stream.tsx` 参数化 + `message-flatten.ts` 两级过滤 + `system_reminder_injector.ts` 双标记 + `section-{squad,member}-chat.tsx` 重写 + Round 2 `use-session-run-state.ts` 引擎 + `chat-slice.ts` 瘦身。

---

## 1. 改动摘要

### 1.1 共享渲染内核 ChatStream（参数化）

`chat-page/component-message-stream.tsx` 从「playground 专用 message stream」参数化为**共享渲染内核 ChatStream**——playground / studio 单聊 / studio 群聊三视图复用同一内核，差异收敛到 4 个可选策略 hook（不传 = playground 默认行为零回归）：

| 策略 hook | 作用 | 不传时默认 |
|---|---|---|
| `resolveActor(msg)` | 头像 + 名字（actor 解析） | 默认 Rocky icon + `Rocky` / U 色块 + `you` |
| `messageFilter(msg)` | 消息级白名单（false 则整条跳过） | 全展示 |
| `blockFilter(block, msg)` | block 级过滤（false 则该 block 不进 view） | `DEFAULT_BLOCK_FILTER`（滤 `isSystemReminder=true` 的 text block） |
| `sideOfMessage(msg)` | 左右侧判定（user→右 / assistant→左） | 按 role（a2a inbox 由调用方负责） |

配套：`message-flatten.ts` 新增 `flattenAndGroup(messages, options)`（拍平 + 分组 + 两级过滤）+ `FlattenOptions { messageFilter?, blockFilter? }` + 导出 `DEFAULT_BLOCK_FILTER` / `MessageFilter` / `BlockFilter` 类型。

### 1.2 可见性策略（新架构概念）

| 视图 | messageFilter | 哲学 |
|---|---|---|
| **playground** | 不传 | 全展示（个人对话，无 a2a） |
| **studio 单聊**（leader/mate） | 不传 | 全展示（单对端，仅滤 reminder） |
| **studio 群聊**（squadChat） | `m => isUser(m) \|\| isA2aInbox(m)` | **白名单**（mute assistant answer + tool + reminder，只留 user 输入 + 各角色 a2a inbox） |

群聊白名单理由：squadChat 是团队信息权威源，user 关心「我说了什么 + 各角色反馈了什么」，而非 leader 的内部思考/工具调用（这些在单聊页查）。

### 1.3 a2a 双重身份

- **发出端** = assistant 的 tool_call（leader/mate 调 `send_message` 工具发 a2a）。
- **接收端** = inbox 消息（`sender.source='agent'` + `sender.agent.ref`），后端存 `role='user'`（a2a inbox 是被投递的消息，role='user' 表「被送达的 user-facing 消息」）。
- **渲染**：群聊 `sideOfMessage` 把 a2a inbox 路由到 assistant 侧（左），带角色名前缀（`ref.name:`），即便 `role='user'`。

### 1.4 reminder 块级标记（双标记 + LLM 零侵入）

`system_reminder_injector.ts`（`app/plugins/builtins/rocky_context/ingest/`）注入 reminder 时同时打：
- **块级**（新）：reminder TextBlock 设 `isSystemReminder: true`。
- **消息级**（保留）：message `metadata.isSystemReminder: true`（兼容旧路径/工具按消息级判断的场景）。

前端 `DEFAULT_BLOCK_FILTER`（`message-flatten.ts`）按块级精确过滤——隐藏这一块 text，不影响同 message 其他 text block（旧消息级 metadata 无法区分块，前端要隐 reminder 时要么整条隐误伤 user 正文、要么不隐暴露 reminder）。

**LLM 零侵入**：`encodeContentBlock(text)`（`app/server/src/llm/protocol-encode.ts:184`）只读 `b.text`，`isSystemReminder` 不进 wire —— reminder 仍透明发 LLM（保 system_reminder §5 prompt cache 不破坏的语义）。

### 1.5 文件拆分 + MemberAvatar

- `section-squad-chat.tsx` / `section-member-chat.tsx`：从单文件拆为两个 section，共用 `squad-chat-helpers.tsx` 谓词（`isUser` / `isA2aInbox` / `sideOfMessage`）。
- `common/member-avatar.tsx`（新）：色块 + 首字母的 member 头像组件（单聊/群聊对端 member 用，区别 playground 的 Rocky icon）。

---

## 2. 设计决策

### 2.1 为什么参数化而不是复制

- **结论**：单内核 + 4 个可选策略 hook，而非三份独立的 message stream。
- **理由**：三视图的渲染逻辑（拍平 / 分组 / tool-batch 合并 / SSE 乱序 part key 稳定 / 自动滚底）**完全相同**，差异只在「显示哪些消息」「头像怎么画」「左右侧怎么判」。复制三份会让 SSE 时序处理、part key 算法等核心逻辑漂移（v0.0.33.2 的 squad chat 复制 playground 后已出现 message-flatten 重复实现）。
- **反例**：若把策略 hook 做成必填 → playground 也要传一套默认策略 → 破坏零回归；故全可选 + 内核自带默认。

### 2.2 为什么 reminder 用块级标记而非消息级

- **结论**：块级 `block.isSystemReminder` + 消息级 `metadata.isSystemReminder` 双标记共存。
- **理由**：消息级 metadata 只能表达「这条 message 含 reminder」，前端要隐 reminder 时要么整条 message 隐（误伤同 message 的 user 正文——一个 user message 可能同时有用户输入 text + reminder text）要么不隐（reminder 暴露给用户）。块级标记让 `DEFAULT_BLOCK_FILTER` 精确隐这一块 text。保留消息级是为兼容旧代码（按消息级判断 reminder 的视图/工具/测试）。
- **反例**：若仅块级、删 metadata → 旧路径失效；故双标记共存，新代码读块级，旧代码读消息级。
- **LLM 零侵入**：`encodeContentBlock(text)` 只读 `b.text`，两套标记都不进 wire —— reminder 仍透明发 LLM，system prompt cache 不破坏。

### 2.3 为什么群聊白名单、单聊全开

- **结论**：群聊 `messageFilter = m => isUser(m) || isA2aInbox(m)`；单聊不传 messageFilter。
- **理由**：群聊是团队信息权威源（CLAUDE.md memory `squad-team-info-authority`），user 关心「我说的 + 各角色反馈的」；mute 掉 leader 的内部 reasoning/工具调用（这些噪音淹没团队信号；详细信息在单聊页查）。单聊只有一个对端角色，全展示无噪音。
- **反例**：若群聊也全展示 → leader 的 tool_call + 多轮 thinking 占满屏，user 难找各角色的 a2a 回复。

---

## 3. 影响的 specs

### 3.1 tech（OKF KB）

- `specs/tech/agent/message/[P0]agent_message_interface.md §4.1`：TextBlock 加 `isSystemReminder?: boolean` 字段 + 设计决策（双标记 + LLM 零侵入理由 + 反例）。
- `specs/tech/agent/context/[P0]system_reminder.md §4`：injector 伪码更新（块级 `isSystemReminder=true` + 保留消息级 metadata）+ 设计决策段。
- `specs/tech/app/frontend/[P0]component_architecture.md`：
  - §3 目录树加 `studio-page/squad-chat-helpers.tsx` + `common/member-avatar.tsx`。
  - §3.3 新增「共享渲染内核 ChatStream [v0.0.39]」概念段（4 策略 hook + 代码路径 + 接口签名 + 版本演进）。

### 3.2 ui（overall + components）

- `specs/ui/overall/02-llm-chat.md`：§3 ChatPage 加 `[v0.0.39 added]` 段（共享内核概念 + 4 策略 hook + DEFAULT_BLOCK_FILTER + LLM 零侵入）；version 升 2.7。
- `specs/ui/overall/06-studio.md`：§5 Chat 加策略表（单聊/群聊/playground 三列对比）+ a2a 双重身份说明；§10 边界加共享内核/reminder/MemberAvatar 行；version 升 1.3。
- `specs/ui/components/studio-page/squad-chat-page.md`（coder 已做 v2.0）+ `member-chat-page.md`（v2.0）+ `specs/ui/components/common/member-avatar.md` + `.tsx`（按 `_conventions.md §5` 配对，**.tsx 合规勿删**）。

### 3.3 不变（明确范围）

- **api**：无变更。reminder 仍发 LLM（`encodeContentBlock` 透明）；GET /messages 零过滤不变（前端 blockFilter 在 view 层做，不影响 API 契约）。
- **prd**：本版本无 PRD 改动。

---

## 4. 测试

- coder 单元测试覆盖（UT）：`message-flatten.test.ts`（含 filter 测试）+ `message-flatten-filter.test.ts` + `message-flatten-system-notice.test.ts` + `component-message-stream-strategy.test.tsx`（策略 hook）+ `section-squad-chat.test.tsx` + `member-avatar.test.tsx`。
- code-review：CONDITIONAL PASS（Minor 已直接修复）。

---

## 5. 后续（不在本版本范围）

- 各 tech KB（`specs/tech/agent/message/`、`specs/tech/agent/context/` 等）**缺 OKF index.md / log.md**（全代码库问题，v0.0.35 commit 声称「全量 OKF 迁移」但实际未补 index/log/frontmatter）。本版本仅在现有 spec 文件内追加 `[v0.0.39]` 标注，与同目录兄弟文件风格保持一致；OKF 化（补 index/log + frontmatter + 退役 inline `[vX.Y]`）作为独立工作项。

---

## 6. Round 2 增量（2026-06-30 · 共享 run 态引擎 + store 瘦身 + P1 bizType 守卫）

> 在 Round 1「共享渲染内核 ChatStream」之上引入**第二层共享**：把 playground 的 run 态机制（SSE 订阅 + reducer + run-state）从 page-chat 内联 + 全局 `useChatStore` 抽成可复用 hook。**与 Round 1 渲染层共享并列**：渲染层（ComponentMessageStream）+ run-state/SSE 层（useSessionRunState）。

### 6.1 共享 run 态引擎 `useSessionRunState(sessionId, opts?)`

- **新文件** `app/web/src/components/chat-page/use-session-run-state.ts`（282 行）。
- **核心契约**：playground（`page-chat.tsx`）+ studio 单聊（`section-member-chat.tsx`）共用——同一 hook、同一套纯 reducer（`chat-slice-reducer.applyAgentEventToMessages` 喂 `agent_loop` + `session-slice-reducer.applySessionStatusUpdate` 喂 `session_panel`），**不写第三套 reducer**。
- **SSE 订阅**（与原 page-chat openSession 一致，零回归）：
  - `agent_loop`（group=`session_id:${sid}_amt:current`）→ messages/runActive/loadingPhase/lastRunFinish/enqueueItems。
  - `session_panel`（group=`session_id:${sid}`）→ 按 type 分流：`session_status_update`→sessionRunning；`session_usage_update`→usage；`summary_task_update`→summaryTask；`messages_cleared`→清 messages/lastRunFinish/enqueueItems；`session_workspace_*`→`onWorkspaceEvent`；`session_read_update`→`onSessionRead`。
- **SSE 所有权**：`opts.sseClient` 注入（playground `sharedSse`）→ hook 只 subscribe/unsubscribe **不 destroy**；省略（单聊）→ hook 内部 new + connect，cleanup 时 unsubscribe + **destroy**（隔离，对 playground 零回归）。
- **返回**：`{ messages, hasMore, setMessages, runActive, loadingPhase, lastRunFinish, sessionRunning, enqueueItems, removeEnqueueItem, usage, summaryTask, abort, reset }`。
- **设计原则**：`applyAgentEventToMessages` 对 ctxRef 有副作用（累积 tool_call rawArgs / pendingError），非纯函数——故 reducer 应用放在 **SSE 帧 handler 内**（每帧恰好一次），用 ref 持权威态、setState 只存已算好的快照，避免 setState updater 被 StrictMode 双调而重复累积。

### 6.2 store 瘦身（`chat-slice.ts`）

- **迁出**：messages/hasMore/runActive/loadingPhase/lastRunFinish/sessionRunning/enqueueItems/usage/summaryTask 及 actions（applyAgentEvent/applySessionEvent/setMessages/setSessionRunning/setUsage/removeEnqueueItem/resetRunState）。
- **保留**：sessions[] 列表 + activeSessionId + subagent tree（childrenByParent/activeSubId）+ lastWorkspaceEvent + applySessionMetaEvent + setSessionUnread。
- **re-export**：`applyAgentEventToMessages` / `AgentEvent` / `SessionEvent` 仍从 `chat-slice` 导出（消费方 + 既有 UT 一处 import；纯 reducer UT 不动）。

### 6.3 P1 bizType 列表隔离（`applySessionMetaEvent` 守卫）

- **问题**：`session_meta` 是 `_all` 共享广播 topic（spec sse_channel.md §10.5），后端 `session-meta-broadcaster.ts:87` 对 studio session（bizType:'studio'）running 时也会广播 meta。playground store 是 `useChatStore` 专属（studio-page 不共用），但 `_all` 订阅会把 studio 会话 upsert 进 playground sessions[] → 列表污染。
- **守卫**：`chat-slice.ts.applySessionMetaEvent()` 加 `if (incoming.bizType === 'studio') return;`——studio 会话一律拒纳；缺省/undefined 视为 playground 正常纳入。
- **类型补充**：前端 `Session`（`chat-page/types.ts`）补 `bizType?: 'playground' | 'studio'`（对齐后端 SessionMetaView）。
- **参考**：`specs/tech/agent/session/[P0]session_biztype.md`。

### 6.4 瞬态修复（切会话不留旧 messages 残留）

- **问题**：迁到 hook 后 reset 落 post-paint `useEffect`，sessionId 变化后浏览器先 paint 一帧「新 sid header + 旧 session A messages」才清空——回退了 v0.0.30 刻意修的「切会话主动清旧 messages」行为。
- **修复**：reset 改放 `useLayoutEffect`（依赖仅 sessionId）——paint 前同步清空 messages/runActive/sessionRunning/usage/summaryTask → 同步重渲染 → paint 时 messages 已空。reset 幂等（纯清空），StrictMode 双调无副作用；subscribe/初始 GET 留在 `useEffect`（异步 post-paint）。
- **复现路径**：playground 切会话 A→B 时观察是否出现「B header + A messages」一帧。

### 6.5 改动文件（M=修改 A=新增）

| 文件 | 状态 | 说明 |
|------|------|------|
| `app/web/src/components/chat-page/use-session-run-state.ts` | **A** | 新建共享 run 态引擎（282 行） |
| `app/web/src/components/chat-page/page-chat.tsx` | M | 迁移消费引擎（viewedSessionId = activeSubId ?? activeSessionId；注入 sharedSse + onWorkspaceEvent + onSessionRead） |
| `app/web/src/components/studio-page/section-member-chat.tsx` | M | 单聊直接消费 `useSessionRunState(sessionId)`（省 sseClient → 自建隔离）；删旧轮询 setInterval |
| `app/web/src/store/chat-slice.ts` | M | run-state 切片整体迁出；applySessionMetaEvent 加 bizType 守卫；re-export 纯 reducer |
| `app/web/src/components/chat-page/types.ts` | M | `Session` 加 `bizType?: 'playground' \| 'studio'` |
| `app/web/src/components/chat-page/use-subagent-run-refresh.ts` | M | 接收 `setMessages` 参数（page-chat 传 `runState.setMessages`）；BUG-002 fix 保留 |
| `app/web/src/components/chat-page/component-loading-status.tsx` | M（消费） | 复用 playground loading 胶囊（单聊 run 态驱动） |
| `app/web/src/components/chat-page/component-abort-btn.tsx` | M（消费） | 复用 playground 停止按钮（单聊 run 态驱动） |

### 6.6 影响的 specs（M）

- `specs/tech/app/frontend/index.md`：① 概念表加「共享 run 态引擎」行 + session_meta 行补 bizType 守卫；④ 核心原则加第 8 条（run 态从 store 迁 hook）。
- `specs/tech/app/frontend/log.md`：v0.0.39 块追加 Round 2 子段。
- `specs/tech/app/frontend/[P0]component_architecture.md §3.4`：补「共享 run 态引擎 useSessionRunState」（coder 已加，doc-modifier 核对一致）。
- `specs/ui/components/studio-page/member-chat-page.md`：修 `useMemberRunState` phantom 名 → `useSessionRunState`（直接消费、无 wrapper）。
- `specs/ui/overall/06-studio.md §5.2`：修 `use-member-run-state.ts` phantom 文件名 → `section-member-chat.tsx` 直接消费 `useSessionRunState`。

### 6.7 不变（明确范围）

- **api**：无变更（SSE topic/group 约定不变；GET/POST 端点不变；session_meta 广播 payload 加 bizType 是后端早已有的字段，前端这次才消费）。
- **prd**：本版本无 PRD 改动。
- **群聊（squadChat）**：本次不动 run 态（群聊走 GET /messages 直读 inbox 模式，无 agent_loop SSE 订阅）。

## 7. Round 3 增量（共享 run 态 UI 组装层 + 补接单聊 enqueue 排队区）

### 7.1 触发

用户验证 Round 2 时发现 studio 单聊（`section-member-chat.tsx`）run 态 UI 只手写接了 loading 胶囊 + 停止按钮，**漏接了 enqueue 排队区**——Round 2 引擎 `useSessionRunState` 早已算好 `enqueueItems`/`removeEnqueueItem`，只是单聊没人接 UI。根因：Round 2 只把 run 态**数据**抽成共享引擎，但「引擎数据 → UI 组件」这层**组装**仍由各消费方各自手写 JSX，容易漏字段。

用户要求：直接补上 enqueue + 顺手把「引擎数据→UI 组件」这层组装也抽象成共享件，最大化 reuse，防止以后再漏字段。

### 7.2 新增共享组件

`app/web/src/components/chat-page/component-run-state-bar.tsx`（101 行，两导出）——继渲染内核 `ComponentMessageStream`（§3.3）、run 态引擎 `useSessionRunState`（§3.4）之后的**第三个共享件**（run 态 UI 组装层）：

- **`ComponentRunStateBar`**（渲为 Fragment）= loading 胶囊（`ComponentLoadingStatus`，`phase=runActive?loadingPhase:null`）+ enqueue 排队区（`ComponentEnqueueView`，`showEnqueue` 门控，playground readOnly 传 `false` 仅留 loading）。
- **`ComponentRunStateAbortSlot`** = 停止按钮「是否渲染」判断收拢（`!sessionRunning || !sessionId → null`）；位置仍由 caller 内联（abort 按钮牵涉 caller input-row flex 布局 + 两侧 send 样式不同，不整体收拢）。

零回归要点：bar 渲为 Fragment（不引入新定位上下文）；loading 胶囊 `absolute` 锚点由 caller wrapper 决定，wrapper 满宽贴底 → 物理位置与原先一致；叶子组件自带 testid，包装不改 DOM。

### 7.3 playground 真迁移（`section-chat-detail.tsx`）

删旧三个叶子组件 import（`ComponentLoadingStatus`/`ComponentEnqueueView`/`ComponentAbortBtn`），全切 `ComponentRunStateBar`/`ComponentRunStateAbortSlot`，**无并存**。readOnly 分支 `<ComponentRunStateBar showEnqueue={false}>`（仅 loading 胶囊挂页根）；非 readOnly 分支控制条放 input-bar wrapper 首位 + abort slot 内联 send 左侧。`onEnqueueCancel` prop 透传，`page-chat.tsx` 未改（乐观移除 + cancel API 流不变）。

### 7.4 studio 单聊接入（`section-member-chat.tsx`）

补解构 `enqueueItems`/`removeEnqueueItem`（引擎早算好）+ import `cancelEnqueue` + 本地 `handleEnqueueCancel`（乐观移除 `removeEnqueueItem` + `cancelEnqueue(sessionId, enqueueId)` fire-and-forget，仿 page-chat）。换装同一 `ComponentRunStateBar`/`ComponentRunStateAbortSlot`，补回此前漏接的 enqueue 排队区。

### 7.5 改动文件（A/M）

| 文件 | 状态 | 说明 |
|---|---|---|
| `app/web/src/components/chat-page/component-run-state-bar.tsx` | A | 新增共享组件（两导出） |
| `app/web/src/components/chat-page/__tests__/component-run-state-bar.test.tsx` | A | 15 tests（loading 显隐/enqueue 门控/showEnqueue/cancel/abort slot 三态） |
| `app/web/src/components/chat-page/section-chat-detail.tsx` | M | playground 迁移到共享组件（删旧 import，无并存） |
| `app/web/src/components/studio-page/section-member-chat.tsx` | M | 补接 enqueue（解构 + handleEnqueueCancel）+ 换装共享组件 |
| `app/web/src/components/studio-page/__tests__/section-member-chat.test.tsx` | M | 补 enqueue 3 tests（显示/隐藏/cancel 两步链路） |
| `specs/tech/app/frontend/[P0]component_architecture.md` | M | §3.5 新增（共享 run 态 UI 组装层）+ 单文件单组件例外条款 |
| `specs/tech/app/frontend/index.md` | M | ① 概念表加行 + ④ 核心原则 9 |
| `specs/tech/app/frontend/log.md` | M | v0.0.39 块追加 Round 3 子段 |
| `specs/ui/components/chat-page/_components.md` | M | 组件清单登记 component-run-state-bar |
| `specs/ui/components/studio-page/member-chat-page.md` | M | run 态契约补 enqueue + 共享 bar + v2.2 |

### 7.6 不变（明确范围）

- **引擎**：`useSessionRunState` 字段/语义零改动（Round 2 已验证正确，本轮只动 UI 组装层）。
- **纯 reducer**：零改动。
- **api**：无变更（cancelEnqueue 端点早已存在，单聊这次才消费）。
- **群聊**：不动（与 Round 2 同，群聊走 inbox 直读模式）。
- **后端**：零改动。

### 7.7 验证

code-review **PASSED**（0 Critical/Major/Minor）；typecheck 绿；vitest 改动目录 44 文件 / 357 测试全绿。
