---
type: spec
title: SSE Channel（前端 ↔ event-hub 的 SSE 桥）
priority: P0
status: active
updated: 2026-07-01
since: v0.0.1
related: [../../agent/event/[P0]event_hub.md, ../../agent/event/[P0]event_convention.md, ../../agent/session/[P0]session_state.md, ../../agent/session/[P0]session_event.md]
---

# SSE Channel（前端 ↔ event-hub 的 SSE 桥）

> 整个 web 共享**一条 SSE 链路**,electron 启动时创建、关闭时销毁。前端按 (topic, group) 订阅,后端 sse_channel 对象订阅 event-hub,收到 event 经 SSE 转发给前端,前端自行处理。
> event-hub(topic+group 路由)见 `../../agent/event/[P0]event_hub.md`;寻址规范见 `../../agent/event/[P0]event_convention.md`。

## 1. 定位

sse_channel 是 **前端(web)与后端 event-hub 之间的 SSE 桥**：
- 整个 web 共享**一条 SSE 链路**(全局单 connection,所有订阅复用)
- 生命周期 = electron app:启动创建、关闭销毁
- 前端订阅 (topic, group) → 后端订阅 event-hub → event 经 SSE 推前端 → 前端分发处理

> 复用 event-hub 的 (topic, group) 寻址(见 event_convention):agent 进度(topic=`agent_loop`)、session 面板(topic=`session_panel`)等都经此 channel 订阅。

## 2. 生命周期(electron 全局)

- **启动**:electron app 启动 → 创建 SSE endpoint + 后端 sse_channel 对象(全局单例)
- **运行**:前端打开 SSE connection(一条);按需 subscribe / unsubscribe (topic, group)
- **关闭**:electron app 关闭 → 断 SSE + 销毁 sse_channel(取消所有订阅)

> 单链路:整个 web 一个 SSE connection(不 per-subscription 建连),所有订阅的 event 复用这一条流(帧带 topic+group 区分)。

## 3. 架构

```
前端(web)                           后端(electron main / server)
─────────                           ──────────────────────────────
SseClient                           SseChannel（全局对象，electron 生命周期）
├─ 一个 SSE connection(GET /sse)   ├─ 订阅列表: (topic,group) → Subscription
├─ subscribe(topic, group) ─POST─→  ├─ subscribe: hub.sub(topic, group, listener)
├─ unsubscribe(topic, group)─POST→  │     listener 收 event → SSE 推帧 {topic, group, data}
├─ 收 SSE 帧 → 按 (topic,group)     ├─ unsubscribe: hub.unsub(subscription)
│  分发给 handler                   └─ event-hub（EventHub.singleton()，见 event_hub）
```

## 4. 订阅协议(topic + group)

SSE 单向(server→client);订阅/取消走 HTTP POST,event 流走 SSE GET。

| 方向 | 通道 | 内容 |
|---|---|---|
| client→server | `POST /sse/subscribe` | `{ topic, group }` 订阅 |
| client→server | `POST /sse/unsubscribe` | `{ topic, group }` 取消 |
| server→client | `GET /sse`(SSE) | event 帧 `{ topic, group, data, timestamp }` |

**SSE 帧格式**:
```json
{ "topic": "agent_loop", "group": "session_id:01KVC...", "data": "<AgentEvent>", "timestamp": "..." }
```

> 前端按 (topic, group) 路由帧到 handler(如 `agent_loop` → chat 流渲染;`session_panel` → usage 面板刷新)。

## 5. 后端 sse_channel 对象

```typescript
/** 全局单例，electron app 生命周期内一个 */
class SseChannel {
  private hub = EventHub.singleton();
  private subs = new Map<string, Subscription>();   // key = `${topic}:${group}` → Subscription
  private sseStream: SseSink;                        // SSE 输出流（推给前端）

  /** 前端订阅 (topic, group)：hub.sub → listener 收到经 SSE 推前端 */
  subscribe(topic: string, group: string): void {
    const key = `${topic}:${group}`;
    if (this.subs.has(key)) return;                  // 去重（同 topic+group 不重复订）
    const sub = this.hub.sub(topic, group, (event) => {
      this.sseStream.write({ topic, group, data: event, timestamp: nowIso() });
    });
    this.subs.set(key, sub);
  }

  /** 取消订阅 */
  unsubscribe(topic: string, group: string): void {
    const sub = this.subs.get(`${topic}:${group}`);
    if (sub) { this.hub.unsub(sub); this.subs.delete(`${topic}:${group}`); }
  }

  /** session 是否当前在前台（有活跃订阅）。
   *  判定依据：subs Map 中存在 key `session_panel:session_id:<sid>` —— 即前端 chat 页已 subscribe 该 session 的 session_panel topic（§9 生命周期：进入会话 subscribe，切走/离开 unsubscribe）。
   *  不引入新的「活跃 session registry」或心跳，零新协议、零新状态——复用 SSE 订阅信号。
   *  用途：**session 层**（SessionUnreadOps runtime，非 agent-loop、非状态机）在收到状态机 markIdle/markError 完成信号（session_status_update state→idle|error）时点查此，决定是否**产生未读**（不在前台 → CAS unread=true；在前台 → no-op）。详见 session_state.md §4.4/§6。 */
  isSessionActive(sessionId: string): boolean {
    return this.subs.has(`session_panel:session_id:${sessionId}`);
  }

  /** electron 关闭：取消所有订阅 + 断 SSE */
  destroy(): void {
    for (const sub of this.subs.values()) this.hub.unsub(sub);
    this.subs.clear();
    this.sseStream.close();
  }
}
```

> sse_channel 是 event-hub 的**订阅方**(`hub.sub`),不产生 event;event 来自各业务 producer(agent_loop / session_panel 等)。

### 5.1 [v0.0.85.ui_opt F2] setSubscribeHooks async + await（消除 fire-and-forget 时序竞争）

**问题**：`bootstrap.ts setSubscribeHooks` 内部 hook 体（v0.0.85 时是 `void workspaceManager.startWatch/stopWatch`，[v0.0.139] 换成 recycleSession，见下）若 fire-and-forget——快速切 tab 时 hook 触发但异步操作未完成，下次 subscribe 可能命中旧 entry（残留）或漏启（未启动）。

**修复**：
- **`SubscribeHooks` 接口返回类型**：`void → void | Promise<void>`（保留 sync 兼容；caller 必须 await 才能保证时序）。
- **`SseChannel.subscribe/unsubscribe` 改 async**：内部 `await hooks.onSubscribe?.(topic, group)` / `await hooks.onUnsubscribe?.(topic, group)`（hook 异常 try/catch 不影响订阅本身，与旧 sync 行为一致）。
- **`bootstrap.ts` hook 改 async + await**：`onSubscribe/onUnsubscribe` 声明为 async 函数，`SseChannel` 内部 `await` 其返回 Promise。**[v0.0.139] 懒监听重构后 hook 体换新模型**：`onSubscribe` 退化为 no-op（watch 由前端显式 `POST watch` API 驱动，subscribe 不再隐式建监听）；`onUnsubscribe(session_panel, group)`（1→0）内 `await workspaceManager.recycleSession(sid)` 兜底回收该 session 全部 tab 监听——async+await 骨架不变，仅 hook 体从旧 `startWatch/stopWatch` 换成新懒监听 API。

**HTTP handler 兼容**：handlers/sse.ts 的 `channel.subscribe(topic, group)` 不显式 await（fire-and-forget 仍工作——subscribe 返回 Promise 但 handler 不 await）。HTTP 响应即返回 ok:200，hook 异步链执行；lazy 启停时序由 bootstrap 内部 await 链保证，不依赖 HTTP 层 await。

**向后兼容**：旧 sync onSubscribe 实现（返 void）仍工作——`await void` 等价 `await Promise.resolve()`，立即 resolve 不阻塞。

## 6. 前端 SseClient

```typescript
/** 前端单例，管理一条 SSE connection + 订阅 */
class SseClient {
  private es = new EventSource("/sse");              // 一条 SSE connection
  private handlers = new Map<string, (data: any) => void>();  // key = `${topic}:${group}`

  constructor() {
    this.es.onmessage = (e) => {
      const { topic, group, data } = JSON.parse(e.data);
      this.handlers.get(`${topic}:${group}`)?.(data);   // 按 topic+group 分发
    };
  }

  /** 订阅：注册 handler + POST /sse/subscribe */
  subscribe(topic: string, group: string, handler: (data: any) => void): void {
    this.handlers.set(`${topic}:${group}`, handler);
    fetch("/sse/subscribe", { method: "POST", body: JSON.stringify({ topic, group }) });
  }

  unsubscribe(topic: string, group: string): void {
    this.handlers.delete(`${topic}:${group}`);
    fetch("/sse/unsubscribe", { method: "POST", body: JSON.stringify({ topic, group }) });
  }
}
```

> 前端组件按需 `subscribe(topic, group, handler)`(如 chat 页订 `agent_loop:<sid>`,usage 面板订 `session_panel:<sid>`,**chat 页同时订 `session_panel:<sid>`** 以驱动 session 运行态 UI —— 见 §9),unmount 时 `unsubscribe`。

## 9. chat 页 session_panel 订阅

**背景**：后端 `session_status_update` event 已全接好真在发（6 CAS 方法 + reconcileOnStartup 完成后触发，topic=`session_panel`、group=`session_id:<sid>`，SSE 白名单已含 `session_panel`，见 `../../agent/session/[P0]session_event.md §3`），但前端 chat 页（`section-chat-detail` / `page-chat`）**从未 subscribe `session_panel`** —— 只订 `agent_loop`，`sessionRunning` 从 `agent_loop` 的 `run_start`/`run_stop` 派生。

**sessionRunning 权威源切换**：`session_status_update.data`（`SessionStatus = {state, running, currentRunId}`，见 `session_event.md §2`）比 agent_loop 派生更权威 —— 它含 `interrupting` / `interrupted` 中间态（agent_loop 只有 run 级 start/stop，不含 session 状态机态），且由 CAS 状态机在状态变更瞬间直接 emit（无派生延迟）。chat 页 `sessionRunning` / 中断按钮 / enqueue view 的可见条件应**以 session_panel 订阅为权威源**。

**订阅契约**：
- **topic**：`session_panel`
- **group**：`session_id:<activeSid>`（active session id；切会话时 unsubscribe 旧 sid + subscribe 新 sid）
- **handler 输入**：`SessionEvent`（discriminated union，见 `session_event.md §2`）。chat 页 reducer 处理 `session_status_update` 分支（`session_usage_update` 分支归 usage 面板，不在 chat 页 reducer 范围 —— 但同订阅可共享 handler 按 type 分流）。

**reducer 行为**（chat-slice / chat-store）：
```typescript
// 伪代码 —— 实际归 chat-slice reducer
function onSessionEvent(event: SessionEvent) {
  if (event.type === "session_status_update") {
    const { state, running, currentRunId } = event.data;
    set({ sessionRunning: running, sessionState: state, currentRunId });
    // sessionState ∈ {"idle"|"running"|"interrupting"|"interrupted"|"error"} 驱动：
    //   - component-abort-btn 渲染条件 = (running === true)（§4.11b 已对齐）
    //   - component-enqueue-view 可见条件 = (running === true && pending 非空)（§4.11a 已对齐）
    //   - state=interrupting 时 abort-btn 禁用（收尾中，design 板块 4.1）
  }
  // session_usage_update 分支：usage 面板 reducer 处理（不在本节范围）
}
```

**与 agent_loop 订阅的关系**：**并存**，不互斥。chat 页同时订两条流：
- `agent_loop`（topic，group `session_id:<sid>`）：驱动消息流（message_start/text_delta/tool_call_delta/run_end 等），UI 渲染对话内容。
- `session_panel`（topic，group `session_id:<sid>`）：驱动 session 运行态 UI（sessionRunning / abort-btn / enqueue-view / state transitions）。

两者 group 相同（都是 `session_id:<sid>`），但 topic 不同 —— event-hub 按 (topic, group) 路由，不冲突。

**生命周期**：
- **进入会话**（active sid 变化）：`subscribe("agent_loop", "session_id:"+sid, onAgentEvent)` + `subscribe("session_panel", "session_id:"+sid, onSessionEvent)`；同时 GET `/session/:id` 读初始 `state`/`running`/`currentRunId`（SSE 只推增量，初始态靠 GET）。
- **切会话**：unsubscribe 旧 sid 两个 topic + subscribe 新 sid 两个 topic。
- **离开 chat 页 / unmount**：unsubscribe 当前 sid 两个 topic。

> **后端 spec 无需改**：`session_event.md` / `sse.ts` 白名单 / SessionStore→StateMachine→bus 注入链路全部就绪。本节仅前端 chat 页订阅接线。后端 session_status_update event 结构见 `../../agent/session/[P0]session_event.md §2-§3`，前端 reducer 严格按该结构解析（`event.type === "session_status_update"` → `event.data.{state,running,currentRunId}`）。

### 9.1 [v0.0.42] 两层状态严格分离（session vs run/message）

**核心原理（落 spec 必记）**：session 状态（粗，跑/中断中/停）↔ run/message 状态（细，思考/生成/调工具/执行）**两层严格分离**——前者驱动 **stop 按钮**可见性，后者驱动 **on-message spinner**（贴流式尾部）。两层数据源、恢复语义、驱动 UI 各自独立：

| 层 | 数据源 | 恢复语义（切走切回） | 驱动 UI |
|---|---|---|---|
| **session 层** | `sessionRunning` ← GET /session（初始）+ `session_panel` SSE `session_status_update`（增量） | GET 兜底（返 `running` bool）+ 后续 SSE 增量；切回立刻 GET 拿到当前 running 态 | **stop 按钮**可见性（圆环动画 + 中心实心方框，interrupting 减速） |
| **run 层** | `runActive` / `loadingPhase` ← `agent_loop` SSE（`run_start` 翻 true / `run_end` 翻 false；phase 由 message/tool 事件派生） | **靠 §10.7 replay 粘住的生命周期标记恢复**——切走切回重订阅 agent_loop 时 sticky `run_start` 先回放 → reducer 重翻 runActive=true → spinner 回归；phase 兜底 thinking，后续靠 content buffer 内事件细化 | **on-message spinner** 可见性（贴流式尾部，spinner+phase 同控件状态各自决定） |

**两层的边界（不能混）**：
- session 层不依赖 `runActive`（session 在跑但当前没有 run 时也显 stop 按钮，如 enqueue 排队间隙）。
- run 层不依赖 `sessionRunning`（run 进行中但 session 切到 interrupting 时 spinner 仍转，直到 run_end）。
- **移除的混乱**：原 §4.10 浮动 loading 胶囊用 run 层状态（`runActive && loadingPhase`）表达「session 在跑」语义，职责错位（spinner 跑没跑 ≠ session 跑没跑）。本版本移除浮动胶囊，改两层独立 UI。

**stop 按钮组件契约**（替代 §4.11b 红方块）：
- Props: `{ sessionId, sessionState: 'running' | 'interrupting', onAbort }`
- 可见性：父 `ComponentRunStateAbortSlot` 包，门控 `sessionRunning && sessionId`（沿用 §4.11b）。
- 视觉：外圈**旋转环动画**（accent，running 正常转速；interrupting 减速 ~2.5x 表「收尾中」）+ 中心**实心方框**（stop icon）。
- 点击：POST /session/:id/abort（202 fire-and-forget，沿用 §4.11b）→ session_panel 推 `state→interrupting`（圆环减速）→ `interrupted`（按钮消失）。
- disabled：interrupting 态仍渲染但圆环减速（不 disabled，视觉反馈即可）；idle/interrupted/error 不渲染（父级 sessionRunning=false）。

**on-message spinner 组件契约**（替代 §4.10 浮动胶囊）：
- Props: `{ visible: boolean; phase: LoadingPhase | null }`
- 可见性：`visible === runActive`（只要 run 活着就转，run_end 消失）。
- phase 文案：沿用 §4.10 4 阶段（thinking/answering/tool_calling/tool_executing）；`phase === null` 时仍转（无文案），但实际上 `runActive=true` 时 phase 至少为 thinking（run_start 默认设）。
- 位置：**贴 run 流式尾部**（最新内容下方），由 caller（`ComponentMessageStream` 或父 section）放在 messages 列表末尾，auto-scroll 时跟到底部。

**恢复链路**（路径 A 切走切回）：
```
切走 → unsubscribe agent_loop + session_panel
切回 → GET /session → sessionRunning 立刻恢复（stop 按钮显）
     → subscribe agent_loop → bus 回放 sticky [run_start] + buffer [半截 content]
       → reducer 喂入 run_start → runActive=true, loadingPhase=thinking
       → 喂入 content（message_start/tool_call_*/...）→ phase 细化
     → spinner 回归（贴流式尾部）
run_end → emit run_end → sticky 追加 run_end（成对），buffer 追加 run_end
       → reducer run_end → runActive=false → spinner 消失
       → session_panel 推 idle → sessionRunning=false → stop 按钮消失
```

> **职责清晰**：session 层（stop 按钮）走 GET /session + session_panel，恢复不依赖 agent_loop；run 层（spinner）走 agent_loop replay 粘住（§10.7），恢复不依赖 session_panel。两层各自独立、互不耦合。

## 7. 前台订阅聚合（isSessionActive）

**背景**：未读红点的「产生」逻辑需要后端在 run 完成瞬间知道「某 session 当前是否在前台」——不在前台时产生未读（CAS unread=true），在前台时 no-op（见 `../../agent/session/[P0]session_state.md §4.4/§6`）。**归属层**：未读 + 前台都是 **session 层**（SessionUnreadOps runtime）的事——session 层订阅状态机 completion 信号、自己查 isSessionActive、自己 CAS unread（agent-loop 干活的不碰、状态机纯 CAS 不感知 SSE）。SseChannel 的 `subs` Map（§5）此前只用于「转发去重」，本节聚合为「session 是否活跃」的查询能力，**消费方为 session 层**（非 agent-loop）。

**设计决策（3 选 1，采纳 a：复用订阅信号）**：决策表（含 b 显式 registry/心跳、c 仅 GET 时刻）的对比见 `specs/tech/version_logs/v0.0.27/unread-model-decision.md` §3。采纳 (a) 因：零新 API、零新状态、零心跳、O(1) Map.has、与「订阅=在看」语义天然对齐。

**实现（§5 SseChannel）**：

```typescript
isSessionActive(sessionId: string): boolean {
  return this.subs.has(`session_panel:session_id:${sessionId}`);
}
```

**语义对齐**：
- **「在前台」= chat 页已 subscribe 该 session 的 session_panel topic**（§9：进入会话 subscribe `agent_loop:<sid>` + `session_panel:<sid>`；切走/离开 unsubscribe 两个 topic）。
- 不依赖 `agent_loop` topic（仅 `session_panel` 即可判定，二者生命周期一致，用 session_panel 因其名更直白表达「session 维度订阅」）。
- **单连接假设**：本版本 SseChannel 是全局单例（§2 electron 一条 SSE connection），subs Map 反映唯一前端的订阅状态。多连接 fan-out（多 tab）场景下，isSessionActive 应聚合所有连接的订阅——本版本暂不涉及（单前端），future 多 tab 时扩展为「任一连接订阅即视为活跃」。

**调用方**：**session 层**（SessionUnreadOps runtime，非 agent-loop、非状态机）。session 层订阅状态机 emit 的 `session_status_update` completion 信号，收到 `state→idle|error`（markIdle/markError CAS 成功后状态机已 emit）时，调一次 `sseChannel.isSessionActive(sid)`：
- `false`（不在前台）→ CAS `unread: false→true`（**产生未读**）。
- `true`（在前台）→ **no-op**（用户正看着，不产生未读；用户进入会话时已通过 POST /session/:id/read 显式清零）。

> **关注点分离（修订核心）**：未读（状态）+ 前台（交互）都是 **session 层** 的事——session 层自己持有/查询「是否在前台」（调 isSessionActive）、自己 CAS unread。**agent-loop 不调 isSessionActive**（干活的只调 markIdle/markError）、**状态机不调 isSessionActive**（纯 CAS 不感知 SSE）。SseChannel 只提供查询能力（isSessionActive），不写 unread、不调 markRead，保持「订阅 + 转发」单一职责。
>
> **不连续追踪前台**：session 层仅在收到 completion 信号（state→idle|error）瞬间点查一次；run 进行中不轮询前台态。

## 10. session_meta topic（广播，会话列表订阅）

> 背景：会话列表（左侧常驻 conv-panel）只在挂载时 `GET /session` 拉一次全量；后台 session 完成时前端收不到通知（`session_status_update` 是 per-sid 订阅 `session_id:<sid>`，列表只订 active session 的 group）→ 后台完成的 session 的红点不实时出现。新增 `session_meta` 广播 topic 承载「session 变了」的通知，列表订阅它实时刷新。决策详见 `specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md`。

### 10.1 复用 EventHub，只加 topic（不改传输层）

**架构硬约束**：本 topic **完全复用现有 `EventHub.singleton()` + 既定 `(topic, group)` 寻址机制**——
- **唯一新增** = bootstrap 在现有 hub 上 `hub.registerTopic('session_meta', new ReplayableEventBus({ replayable: false }))`（每个 topic 一个 bus 实例，本就是 hub 既有设计，见 `event-hub.ts registerTopic`）。
- **禁止**：新建传输层 / 改 `ReplayableEventBus` 或 `EventHub` 代码 / 加 wildcard 订阅 / 新造 singleton。SseChannel 不感知 session_meta（仅按 (topic, group) 转发，§5 通用机制）。

### 10.2 共享广播 group `_all`（传输层 group 分区约束的落地）

**为何「列表收所有」用共享 `_all` group 落地**（如实说明，不提议改传输层）：
- `ReplayableEventBus`（`app/server/src/agent/event-bus.ts`）的 group 间**完全隔离**——`emit(group, event)` 只 fan-out 给**该 group 的订阅者**；`subscribe(group)` 只回放 + 收**该 group** 的事件。**无原生 wildcard / 不带 group 订阅**（group 是必填分区 key，bus 不感知业务，只认字符串）。
- 故「列表收所有 session 的 meta」的落地 = **共享广播 group `_all`**：所有 session 的 meta 都 emit 到它，列表 subscribe `(session_meta, _all)` 一次即收所有。`_all` 是约定常量（非特殊语法），与其他 group 字符串等价。

### 10.3 topic 属性

| 属性 | 值 | 说明 |
|---|---|---|
| topic 名 | `session_meta` | SSE 白名单需含（见 api/overall/04 §4.2 + handlers/sse.ts） |
| group | `_all` | 共享广播 group（§10.2） |
| replayable | **false** | 列表初始态靠挂载时 `GET /session` 拉全量；只需订阅后的增量，避免回放陈旧 meta 与刚拉的全量冲突/抖动 |
| 订阅方 | 会话列表（conv-panel / page-chat 挂载时 subscribe `(session_meta, _all)` 一次） | **非 per-session**，共享 `_all` 一次订阅 |
| producer | session 层 `SessionMetaBroadcaster`（见 §10.4） | session 层组件，状态机/agent-loop 不感知 |

### 10.4 Producer = session 层（SessionMetaBroadcaster），状态机 + agent-loop 纯粹

**硬约束**：状态机、agent-loop **不感知** session_meta / 不调 broadcaster。broadcaster 是状态机之上的 **session 层**组件（与 §7 SessionUnreadRuntime 同构——都是 session 层订阅者）。

- 新增 session 层 `SessionMetaBroadcaster`：持 `crud`（读最新 record）+ `sessionMetaBus`（emit 到 `_all` group）。
- 方法 `broadcast(sessionId)`：**同步** `crud.get` 重读 session record → 组装 `SessionMetaView`（见 `../../agent/session/[P0]session_event.md §3a.3`）→ emit `session_meta_update` 到 `(session_meta, _all)`。
  - **同步语义 = 触发方必须 await put 落盘后再调 broadcast**（否则重读到旧值广播错值，v0.0.163 unread red-dot race 教训）。约束落在触发方（`markUnreadTrue` / `markReadAndEmit` / `applyAiName` / handler 直调等），broadcaster 自身不做异步等待——保持全量 payload 重读的最简语义（decision.md §3）。
- **触发接线**（最干净路径，spec 决策 §5）：复用并泛化现有 `wrapStatusBusForUnread` → 扩展为同时 fan-out 给 `SessionUnreadRuntime`（既有）**和** `SessionMetaBroadcaster`：wrap 在 statusBus emit 入口，对任何经过 statusBus 的 session 事件（`session_status_update` / `summary_task_update` / `session_usage_update` / `session_read_update` / `messages_cleared` / `session_workspace_dir_changed`）→ 调 `broadcaster.broadcast(event.sessionId)`。状态 CAS / summary / usage / read / clear / dir 全部经由 statusBus，**单点捕获**。
- **unread 产生**（`markUnreadTrue`，不经 statusBus）→ `SessionUnreadRuntime` 在 `markUnreadTrue` CAS 成功后**直接调** `broadcaster.broadcast(sid)`。
- 触发时机全集见 `../../agent/session/[P0]session_event.md §3a.4` + decision.md §4。

### 10.5 列表订阅契约（会话列表 reducer）

- **挂载**：conv-panel / page-chat 挂载时 `subscribe("session_meta", "_all", onSessionMetaEvent)` **一次**（共享 `_all`，非 per-session）。
- **handler 输入**：`SessionMetaUpdateEvent`（`{ id, type:"session_meta_update", sessionId, createdAt, data: SessionMetaView }`，见 `../../agent/session/[P0]session_event.md §3a.2`）。
- **reducer 行为**：收到 → 按 `data.id`(=sessionId) 在 `sessions[]` 中**整条替换**（不存在则插入）→ 列表始终反映权威最新态（红点 / running / title / summaryTask / workspaceDir 全实时），与哪个字段变了无关。
- **初始态**：挂载时 `GET /session` 拉全量（replayable=false 不回放，初始态必须 GET）。
- **unmount**：unsubscribe `(session_meta, _all)`。

### 10.6 与 session_panel 各干各的

- **chat 页（active session）**：保持 `session_panel:session_id:<sid>` per-sid 订阅不动（§9 既有）。session_panel 所有现有消费者（chat 页 sessionRunning / workspace watch 钩子 / usage / summaryTask / session_read_update）**零改动**。
- **会话列表（conv-panel）**：subscribe `(session_meta, _all)` 一次。
- 两个 topic 各自独立路由：`session_panel`（per-sid，**replayable=false**，见 §10.7）服务 active session 详情；`session_meta`（broadcast `_all`，**replayable=false**）服务列表增量。前端 SSE 帧按 `${topic}:${group}` 分发（§6），两流不冲突。

### 10.7 各 topic replayable 配置总表 + replay 初衷

replay（subscribe 回放历史 buffer）**仅 `agent_loop` 需要**，其他 topic 都 non-replayable：

| topic | replayable | 初衷 |
|---|---|---|
| `agent_loop` | **true** | 流式增量事件（message_start / text_delta / tool_call_* / ...），subscribe 时回放「上次持久化(ingest)之后的半截」+ 后续 stream，与 GET /messages（全量已持久化）拼成不漏全量（见 `agent_event.md §10` API+SSE 契约） |
| `session_panel` | **false** | session_status_update / session_usage_update 是**累计快照**（最新态），非流式增量——回放历史 buffer 只刷一堆过时快照（实测 subscribe 一次回放十几分钟 usage_update，前端只用最新一个）。初始态靠 GET /session + GET /session/:id/usage 拉 |
| `session_meta` | **false** | 列表初始态靠 GET /session 拉全量；只需订阅后增量，避免回放陈旧 meta 与刚拉全量冲突（§10.3） |

**replay 设计初衷**（仅 agent_loop）：agent_loop 事件是**流式增量**（一个 message 拆成 start / delta* / end 多事件），后订阅者（如切到进行中的 run）会错过「subscribe 之前已 emit、尚未持久化」的半截；replay 把这段半截回放，与 GET（全量已持久化）拼成完整状态。而 session_panel / session_meta 是**快照态**（每次发当前累计值），无「半截」概念——后订阅者只需 GET 最新态，replay 历史快照无意义且有害（过时快照噪音）。

**[v0.0.42] replay 粘住 run 生命周期标记**：原本 `clearReplay` 清整个 buffer（含 run_start/run_end），导致切走切回重订阅 agent_loop 时 replay 不含生命周期标记 → 前端 `runActive` 永远 false → spinner 不回归（路径 A bug 根因）。修法：agent_loop topic 的 bus 在 bootstrap 注册时注入 `lifecyclePredicate`（识别 `run_start` / `run_end`），让这两类事件**额外**写入独立 sticky slot（与 content buffer 分离），`clearReplay` 只清 content buffer、不清 sticky；subscribe 时先回放 sticky（run_start/run_end）再回放 content buffer。切走切回时 reducer 先收到 run_start → runActive=true（spinner 回归），再处理 content（phase 细化）。多 run 时序靠 emit run_start 的 replace 语义（清旧 sticky 再写新）保证。详见 `event_bus.md §2.1/§4.3`。

**phase 恢复结论**：切回时 phase = 「sticky run_start 兜底 thinking」+ 「content buffer 内最后一个生命周期事件细化（message_start→answering、tool_call_start→tool_calling、tool_result_start→tool_executing）」。若 content buffer 为空（刚 ingest 完到下一轮 emit 之间），phase 保持 thinking（run_start 默认）。这契合用户期望「phase 跟最后一个 event，没有就默认 thinking」。

**清理时机**：sticky slot 不靠定时清理（避免 run_end 后定时器遗漏）。新 run_start emit 时清旧 sticky（run_start + run_end 全删再写新 run_start）——保证连续 run 时 sticky 只含最新一组。run_end 之后 sticky 保留（run_start + run_end 成对）是无害的：下次切回 replay 看到 run_start→run_end 序列，reducer 最终 runActive=false（spinner 不显，正确，因为 run 真的结束了）。

**实现**：bootstrap.ts 每 topic 一个 `ReplayableEventBus` 实例（agent_loop / session_panel / session_meta 各一），replayable 构造时定；**agent_loop 的 bus 额外注入 `lifecyclePredicate`**（识别 `event.data.type === 'run_start' || === 'run_end'`）。详见 `event_bus.md §6` + `agent_event.md §10`。

## 8. 边界

| 零件 | 归属 |
|---|---|
| SSE 单链路 + 生命周期(electron)+ 订阅协议 + 前后端对象 | 本文(sse_channel)✅ |
| 后端订阅 event-hub(`hub.sub` / `unsub`) | sse_channel 后端对象(本文 §5) |
| 前台判定查询（isSessionActive） | 本文 §5 + §7 ✅（复用订阅信号聚合；**调用方=session 层**，非 agent-loop/状态机） |
| event-hub(topic+group 路由)+ event 类型 | event_hub / event_convention / 各 event 文档 |
| 前端 SSE client + 分发 + 组件按需订阅 | sse_channel 前端(本文 §6) |
| 未读 explicit-bool 模型（产生/消除都在 session 层；isSessionActive 供 session 层产生 timing 点查） | `../../agent/session/[P0]session_state.md §4.4/§6`（权威） |
| session_meta 广播 topic（复用 hub 只加 topic / 共享 `_all` group / 列表订阅契约 / producer session 层归属 / 与 session_panel 各干各的） | 本文 §10 ✅（topic 注册/producer 细节见 `../../agent/session/[P0]session_event.md §3a`；决策见 `specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md`） |
| electron app 生命周期管理(启动/关闭) | app/envs / app/package |

## 11. [v0.0.88] 多订阅 + SubscriberProxy + 定向投递 + hub refcount

> **v0.0.88 改造**：原 `writeFrame` 广播 → SubscriberProxy 定向投递；hub `activeSubs` 真数组 + refcount。详见新建文件 **`[P0]sse_channel_multipub.md`**（避免本文件超 300 行拆分）。前端单例对端见 **`[P0]sse_client_singleton.md`**。

要点：
- 后端帧格式加 `subscriberId` 字段（`{topic,group,data,timestamp,subscriberId}`）；定向投递替代广播。
- `SseChannel.subscribe(topic, group, subscriberId, sink)` 持 `SubscriberProxy`；`unsubscribe(subscriberId)` 按 id 移除 + refcount 归零才拆 hub 订阅。
- hub `EventHub.sub` 多消费者 refcount +1 / cancel -1 / 归零 `delete`（防御性，单例后不触发但补齐）。
- 向后兼容：旧客户端不传 `subscriberId` → 后端 ULID 兜底；旧帧无 `subscriberId` → 旧客户端按 `${topic}:${group}` 路由（多 handler 客户端 Set 兜底）。
- `isSessionActive(sid)` 改查 `groupSubs.get(key)?.size > 0`（语义不变）。

## 9. isSessionActive 归属层决策史

3 个候选方案：(1) 调用方=agent-loop——违反关注点分离，否决；(2) 调用方=状态机（注入 SSE）——违反「状态机不感知 SSE」纯粹原则，否决；(3) 最终：调用方=**session 层**自治。详见 `specs/tech/version_logs/v0.0.27/unread-model-decision.md` §6。

> 变更历史见 `../log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
