# v0.0.42 tech change log — session/run 两层状态分离 + 消息来源对齐 + IME 守护

> PRD 权威源：`specs/prd/version_logs/v0.0.42/change_log.md`；锁定设计：`states/v0.0.42/task-board.md`「设计方向」（用户逐点拍板）。

## 概述

本版本交付 chat 页 session 状态可见性的三处对齐（**4 个设计块**）：
1. **agent_loop replay 粘住生命周期标记**（后端 event-bus，块 1 核心）
2. **两层状态前端架构**（session 层 stop 按钮 + run 层 on-message spinner，块 2）
3. **`component-message-stream` 加 sideResolver prop**（块 3）
4. **IME 中文输入选字回车误发送守护**（块 4，studio 两页 textarea）

无新 HTTP 端点（块 4 块 5）；abort / messages / session 端点全复用现有。

---

## 块 1：agent_loop replay 粘住（后端 event-bus）

### 选定方案：A（lifecyclePredicate + sticky slot）

3 候选对比：

| 候选 | 改动面 | 兼容度 | 多 run 时序 | phase 恢复精度 | 评价 |
|---|---|---|---|---|---|
| **A. lifecyclePredicate + sticky slot（采纳）** | `EventBusOptions` 加 predicate + GroupState 加 sticky Map + emit/subscribe 加分支 | ✅ 通用语义（predicate 是 bus 配置，不硬编码业务 type 名）；其他 topic 不传 = 旧行为零回归 | ✅ emit run_start 时 replace 旧 sticky（清旧 run_start+run_end） | ✅ sticky run_start 兜底 thinking + content buffer 内事件细化 | 最干净、改动集中、不破坏其他 topic |
| B. 独立 sticky 子 buffer（per bus） | 类似 A 但 sticky 在 bus 外层独立维护 | ⚠️ bus 内部感知「sticky type 集合」需配置；不如 A 直接 | 同 A | 同 A | 实现复杂度同 A，无明显优势 |
| C. subscribe 时后端合成 `run_resume` 快照事件 | subscribe 路径加合成逻辑 + 新 AgentEvent 类型 + reducer 支持新事件 | ❌ bus 不再通用（subscribe 时合成 = 业务感知）；改动大 | 天然单 run 无问题 | 最精确（注入当前 phase 快照） | 改动过大、破坏通用语义、需新 event 类型 + reducer 支持 |

**采纳 A**：最小改动、向后兼容、不破坏其他 topic。

### A 的核心契约

- `EventBusOptions` 加 `lifecyclePredicate?: (event: EventBusEvent<unknown>) => boolean`（实例级，构造时定）。
- GroupState 加 `sticky?: Map<event.type, EventBusEvent>`（按 type 替换，保证每种生命周期 type 至多一份）。
- **emit**：predicate 命中（且 event 有 type 字段）→ **sticky-exclusive：只写 sticky slot、不进 content buffer**（避免 subscribe 先回放 sticky 再回放 buffer 时把同一事件回放两次 → `run_start` 重复。原「双写 sticky + buffer」措辞已修正，见 T1 修复条目）；**特殊：emit `run_start` 时清旧 sticky 内的 run_start/run_end**（多 run replace 语义）。
- **clearReplay**：只清 content buffer，**不清 sticky**（生命周期标记跨 ingest 边界存活）。
- **subscribe**：先回放 sticky（按 type 顺序：run_start → run_end），再回放 content buffer。

### T1 修复（sticky-exclusive）+ reviewer 已知权衡

- **sticky-exclusive（命中事件不进 buffer）**：原 emit 实现把命中 predicate 的事件同时写 sticky + buffer，导致 subscribe（先回放 sticky 再回放 buffer）把 `run_start` 回放两次 → AT `sse_subscribe_tc1` run_start 重复回归 fail。修法：emit 的 `buffer.push` 移入 else 分支（仅非命中事件进 buffer）。`event_bus.md` §2.2/§4.3/§5 全部「镜像投影 / 同时写 buffer」措辞修正为「sticky-exclusive（不进 buffer）」；`event/index.md` 第 ④ 原则 6 同步修正。
- **reviewer 已知权衡（硬编码 `run_start` replace）**：当前 emit 内多 run replace 语义硬编码 `data.type === 'run_start'`（命中 run_start 时清旧 sticky 内的 run_start + run_end 再写新 run_start）——这与「bus 不感知业务 type 名」理想**略有偏差**（predicate 本身是通用的，但 replace group 仍写死在 emit 分支）。当前 bus 仅 agent_loop topic 启用且只识别 run_start/run_end，硬编码够用；**未来泛化方向**：把 replace group 也声明为 `EventBusOptions` 配置（如 `replaceGroups?: Map<eventType, eventType[]>`），让 bus 在多个生命周期 type 互斥场景（如 chat 协议的 user_turn/assistant_turn）仍保持通用。详见 `event_bus.md §4.3 已知权衡段`。

### phase 恢复结论

切回时 reducer 喂入顺序：sticky run_start → content buffer（半截 message_start / text_delta / tool_call_*）。
- run_start → `runActive=true, loadingPhase='thinking'`（兜底）。
- content buffer 内最后一个生命周期事件细化 phase：message_start→answering、tool_call_start→tool_calling、tool_result_start→tool_executing。
- 若 content buffer 为空（刚 ingest 完到下一轮 emit 之间），phase 保持 thinking（run_start 默认）。

→ 契合用户期望「phase 跟最后一个 event，没有就默认 thinking」。**不依赖 sticky 维护 phase 字段**——sticky 只管 run 级生命周期（run_start/run_end），phase 由 content buffer 派生。

### 清理时机

- sticky slot 不靠定时清理（避免定时器遗漏）。
- emit run_start 时清旧 sticky（run_start + run_end 全删再写新 run_start）——保证连续 run 时 sticky 只含最新一组。
- run_end 之后 sticky 保留（run_start + run_end 成对）是无害的：下次切回 replay 看到 run_start→run_end 序列，reducer 最终 runActive=false（spinner 不显，正确，因为 run 真的结束了）。

### 影响面隔离

- 只动 agent_loop topic 的 bus（bootstrap.ts 注入 predicate 识别 `run_start` / `run_end`）。
- session_panel / session_meta 的 bus 不传 predicate（默认 undefined），无 sticky 行为，clearReplay 仍清整个 buffer（旧行为，零回归）。

### 影响代码（块 1）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/agent/event-bus.ts` | 修改 | `EventBusOptions` 加 `lifecyclePredicate?`；`GroupState` 加 `sticky?: Map<string, EventBusEvent>`；`emit` 加 predicate 命中分支（含 run_start replace 旧 sticky）；`clearReplay` 不清 sticky；`subscribe` 先回放 sticky 再 buffer；`wrap-bus-with-log.ts` proxy 透传 lifecyclePredicate 选项（不改 wrap 行为） |
| `app/server/src/bootstrap.ts` | 修改 | agent_loop topic 的 `new ReplayableEventBus({ replayable: true })` 改为 `new ReplayableEventBus({ replayable: true, lifecyclePredicate: e => e.data?.type === 'run_start' \|\| e.data?.type === 'run_end' })`（仅 agent_loop bus 注入；session_panel / session_meta 不动） |

---

## 块 2：两层状态前端架构（session vs run/message）

### 两层数据源 + 恢复 + UI

| 层 | 数据源 | 恢复语义 | 驱动 UI |
|---|---|---|---|
| session 层 | `sessionRunning` ← GET /session + session_panel SSE session_status_update | GET 兜底 + SSE 增量 | stop 按钮（圆环+方框，interrupting 减速） |
| run 层 | `runActive` / `loadingPhase` ← agent_loop SSE（块 1 改完可恢复） | replay 粘住 sticky run_start → runActive 恢复 + phase 兜底 thinking | on-message spinner（贴流式尾部） |

### 组件契约（块 2 影响代码）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/web/src/components/chat-page/component-abort-btn.tsx` | 修改 | Props 加 `sessionState: 'running' \| 'interrupting'`；视觉改「外圈旋转环（accent border，animate-spin，duration 按 sessionState 切换 1s/2.5s）+ 中心实心方框」；移除红色方块 bg（视觉权威交组件 spec）；保留防连点 disabled 本地态 |
| `app/web/src/components/chat-page/component-loading-status.tsx` | 修改 | 移除 `absolute left-10 bottom-[72px] z-10` 浮动定位（改 `position: relative` 或 inline 由 caller 摆）；保留 spinner+phase 文案逻辑（4 阶段）；testid 改 `chat-on-message-spinner`（原 `chat-loading-status` 在组件 spec 同步改名）；定位由 caller 内联（贴 ComponentMessageStream 末尾） |
| `app/web/src/components/chat-page/component-message-stream.tsx` | 修改 | 末尾（run-finish 之前）加 on-message spinner 节点：`runActive && <ComponentLoadingStatus phase={loadingPhase ?? 'thinking'} visible={runActive} />`（或新建 `component-on-message-spinner` 内联渲染）；Props 增加 `loadingPhase?: LoadingPhase \| null` 透传（run 层 phase） |
| `app/web/src/components/chat-page/component-run-state-bar.tsx` | 修改 | `ComponentRunStateBar` 移除 `<ComponentLoadingStatus />`（浮动胶囊）；只剩 enqueue 排队区；loading 状态 UI 由 `ComponentMessageStream` 内 spinner 接管；`ComponentRunStateAbortSlot` 加 `sessionState` 透传给 `ComponentAbortBtn` |
| `app/web/src/components/chat-page/section-chat-detail.tsx` | 修改 | 装配链路：`ComponentRunStateBar` 不再传 runActive/loadingPhase 给浮动胶囊；`ComponentMessageStream` 新增 props `runActive` + `loadingPhase`；`ComponentRunStateAbortSlot` 传 `sessionState` |
| `app/web/src/components/studio-page/section-member-chat.tsx` | 修改 | 同 playground 装配链路（shared 引擎 + shared 组装层同受益） |

> **`useSessionRunState` 引擎 hook 零改动**——hook 内部 ref 状态 + reducer 已经支持 replay 事件触发 runActive 翻转（reducer 行为不变，块 1 改完后 replay 含 sticky run_start 自动让 reducer 设 runActive=true）。

---

## 块 3：component-message-stream sideResolver

### 选定方案：独立 sideResolver prop（不采纳 actor.side 字段）

**采纳独立 prop**（单一职责——actor 控头像/名字，sideResolver 控左右）；否决 actor.side 字段（耦合头像/名字与左右语义，单聊 a2a→右需绕开默认头像只改 side 时不便）。

### 契约

- `MessageStreamProps` 加 `sideResolver?: (msg: Message) => 'user' | 'assistant'`。
- 内核渲染：`const side = sideResolver?.(msg) ?? sideOfMessage(msg)`。
- 默认 `sideOfMessage` 逻辑不动（playground 零回归）；从内核导出供 caller 复用（保持单一来源）。
- 不影响 `resolveActor`（头像/名字仍由 actor 解析决定）。

### 三视图策略

- **studio 单聊**：传 `sideResolver = msg => isA2aInbox(msg) ? 'user' : sideOfMessage(msg)`（a2a 收件→右与 user 同侧；assistant 自答+tool 仍左）。
- **studio 群聊**：不传（默认 a2a→左；现状已正确）。
- **playground**：不传（默认零回归）。

### 影响代码（块 3）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/web/src/components/chat-page/component-message-stream.tsx` | 修改 | `MessageStreamProps` 加 `sideResolver?: (msg: Message) => 'user' \| 'assistant'`；内核 `sideOfMessage` 改为 `sideResolver?.(msg) ?? sideOfMessage(msg)`；导出 `sideOfMessage` 函数（caller 复用） |
| `app/web/src/components/studio-page/squad-chat-helpers.tsx` | 修改 | 导出 `memberSideResolver = msg => isA2aInbox(msg) ? 'user' : sideOfMessage(msg)`（import 自 component-message-stream；或 wrapper 内联） |
| `app/web/src/components/studio-page/section-member-chat.tsx` | 修改 | `<ComponentMessageStream>` 传 `sideResolver={memberSideResolver}` |

---

## 块 4：IME 守护（studio 两页 textarea）

### 契约

抄 playground `section-chat-detail.tsx:124-133` 的 IME 守护：组字中（`e.nativeEvent.isComposing || e.keyCode === 229`）的 Enter 不发送。

### 影响代码（块 4）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/web/src/components/studio-page/section-member-chat.tsx` | 修改 | `onKeyDown` 加 2 行：`const imeComposing = e.nativeEvent.isComposing \|\| e.keyCode === 229; if (e.key === 'Enter' && !e.shiftKey && !imeComposing) { ... }` |
| `app/web/src/components/studio-page/section-squad-chat.tsx` | 修改 | 同款守护 |
| `app/web/src/components/chat-page/section-chat-detail.tsx` | 不动 | playground 已有守护（v0.0.9 加） |

---

## 块 5（API）— 无新 HTTP 端点

确认：
- replay 粘住（块 1）是 event-bus 内部实现（lifecyclePredicate 配置），**不暴露新 HTTP**。
- sideResolver（块 3）是前端渲染内核，**不涉及 HTTP**。
- IME 守护（块 4）是前端 textarea onKeyDown，**不涉及 HTTP**。
- abort / messages / session 端点全复用现有（`POST /session/:id/abort`、`GET /session/:id`、`GET /session/:id/messages`、`GET /sse` SSE 流）。

→ **`specs/api/version_logs/v0.0.42/change_log.md` 仅声明「无 API 变更」**（架构师建议 doc-modifier 在 overall 同步时建占位文件标注无新接口）。

---

## 影响代码文件总览（给 coder 用）

### 后端（块 1）
1. `app/server/src/agent/event-bus.ts` — EventBusOptions 加 lifecyclePredicate + GroupState 加 sticky + emit/clearReplay/subscribe 改逻辑
2. `app/server/src/bootstrap.ts` — agent_loop bus 注入 predicate 识别 run_start/run_end

### 前端 chat-page（块 2 + 块 3）
3. `app/web/src/components/chat-page/component-abort-btn.tsx` — Props 加 sessionState + 圆环视觉
4. `app/web/src/components/chat-page/component-loading-status.tsx` — 移除浮动 absolute + 改 on-message spinner
5. `app/web/src/components/chat-page/component-message-stream.tsx` — 加 sideResolver + 加 loadingPhase prop + 末尾 spinner 节点
6. `app/web/src/components/chat-page/component-run-state-bar.tsx` — 移除 loading 胶囊引用 + abort slot 加 sessionState
7. `app/web/src/components/chat-page/section-chat-detail.tsx` — 装配链路调整（loadingPhase 透传给 message-stream + sessionState 透传给 abort slot）
8. `app/web/src/store/chat-slice-reducer.ts` — 不动（reducer 已支持 replay 触发 runActive 翻转）

### 前端 studio-page（块 3 + 块 4）
9. `app/web/src/components/studio-page/squad-chat-helpers.tsx` — 导出 memberSideResolver
10. `app/web/src/components/studio-page/section-member-chat.tsx` — 传 sideResolver + 装配链路 + IME 守护
11. `app/web/src/components/studio-page/section-squad-chat.tsx` — IME 守护（不传 sideResolver）

### 前端 hook（不动）
- `app/web/src/components/chat-page/use-session-run-state.ts` — 零改动（块 1 改完后 replay 自动恢复 runActive）

### 后端不动的（核实）
- `agent-loop-lifecycle.ts` `ingestAndAssemble` — `bus.clearReplay(group)` 调用不动（语义改在 bus 层：clearReplay 不清 sticky）
- `context-port.ts` 三处 `ingestAndAssembleFn` 调用 — 不动
- `run-react-loop.ts` `emitRunStart/emitRunEnd` 调用 — 不动
- `event-hub.ts` / `wrap-bus-with-log.ts` — 不动（lifecyclePredicate 是 EventBusOptions，构造时注入，proxy 透传）

---

## 测试覆盖（呼应 PRD §4 用户路径）

| 路径 | 测试类型 | 最低覆盖 case |
|---|---|---|
| 路径 A 切走切回 spinner 恢复 | ET | vision_check 断言切回后 spinner 存在（贴流式尾部）+ AT 验证 sticky replay 行为（subscribe 后第一帧含 run_start） |
| 路径 B abort interrupting 减速 | ET + AT | ET 圆环减速态；AT POST abort → session_panel state 序列 running→interrupting→interrupted |
| 路径 C 单聊 a2a→右 | ET | vision_check 断言 a2a 气泡在右侧 + assistant 在左侧 |
| 路径 D 群聊 a2a→左 + mute | ET | 群聊 a2a 左 + 无 assistant answer/tool 节点 |
| 路径 E IME 组字 Enter 不发送 | ET | Playwright 模拟 IME composition → 断言 send 未触发 POST |

> 后端 UT 覆盖（coder 白盒）：`event-bus.test.ts` 加 lifecyclePredicate + sticky slot 行为 case（run_start 替换旧 sticky / clearReplay 不清 sticky / subscribe 先 sticky 再 buffer）。

---

## 版本

v0.0.42（session/run 两层状态分离 + 消息来源对齐 + IME 守护。块 1 后端 event-bus 加 lifecyclePredicate + sticky slot，clearReplay 不清生命周期标记，让 agent_loop replay 切走切回可恢复 runActive；块 2 前端两层状态严格分离，stop 按钮（圆环+方框，interrupting 减速）+ on-message spinner（贴流式尾部）替代浮动胶囊；块 3 渲染内核加 sideResolver（独立 prop，actor 解耦），单聊 a2a→右、群聊默认；块 4 studio 两页 textarea 抄 playground IME 守护。无新 HTTP 端点。影响代码：后端 2 文件 + 前端 chat-page 6 文件 + studio-page 3 文件。选定方案 A（lifecyclePredicate）+ 独立 sideResolver prop）
