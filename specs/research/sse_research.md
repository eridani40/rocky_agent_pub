# SSE / Topic 订阅现状 + api+sse 配合风险调研

- **调研范围**: v0.0.92.sse_opt — 盘点当前 SSE/topic 订阅情况，评估 api+sse 配合风险
- **调研对象**: 当前 dev1 主仓库 `app/server/` + `app/web/`（截至 2026-07-08）
- **调研日期**: 2026-07-08
- **权威 spec**: `specs/tech/app/frontend/[P0]sse_channel.md` + `[P0]sse_channel_multipub.md` + `[P0]sse_client_singleton.md`

---

## §0 一句话结论

**现状评分 6/10**：transport 层（SseChannel + SseClient 单例 + subId 路由）设计扎实，但存在 **1 处严重 spec↔code 偏离**（`use-studio-unread-meta` 自建独立 SseClient，违反 S1 全局唯一）+ **SSE 重连/补帧机制完全缺失**（断连期间 agent_loop 流式增量直接丢失，前端无感知）+ **多个组件级 polling 残留**（budget-meter 30s、component-member-panel-memory 等）未走 SSE 总线，与用户期望的"组件生命周期统一管理"目标差距较大。

**最大风险点**：① 单例破口导致多 GET /sse 连接共存（hub refcount 已防多消费者踩踏，但 backend sinks 会向两个连接都广播造成 N×M 帧浪费 + 帧归属状态分裂）；② SSE 永不重连（fetch reader.read() 一旦中断（网络抖动/Electron 卡顿）→ SseClient 进入 `finally: active=false` 终态，handlers 静默不再收帧，用户看到的红点/run 态全部卡死，UI 无错误提示）；③ 切 page 时（playground ↔ studio）page-studio 的 `useStudioUnreadMeta` mount → 自建 SseClient + connect，频繁切 page 会反复建/拆 GET /sse。

---

## §1 Topic 总表

合法 topic 集合白名单：`['agent_loop', 'session_panel', 'session_meta']`（`app/server/src/handlers/sse.ts:17`）。

| topic | group 命名 | 发布者 (server file:line) | 触发时机 | 数据形态 (data 字段) | replayable | 订阅方 (web 组件/hook file:line) |
|---|---|---|---|---|---|---|
| **`agent_loop`** | `session_id:<sid>_amt:current`（主对话）/ `_amt:summary`（forked 压缩）/ `_amt:memory_extract`（forked 记忆抽取）。命名由 `groupKeyForMode(sid, modeKey)` 统一生成（`app/server/src/agent/agent-interface.ts:185`）。 | `app/server/src/agent/agent-loop-emitters.ts`（loop 内所有 emit 点）+ `agent-loop-stage-llm.ts:123,162`（emit AgentEvent）+ `agent-loop-call-via-invoker.ts:82` | LLM 流式 token / tool call / tool result / run_start / run_end 等增量事件 | `AgentEvent`（discriminated union，`message_start` / `text_delta` / `tool_call_delta` / `run_end` 等，见 `app/server/src/agent/agent-event-types.ts`） | **true**（subscribe 时回放 buffer 中未持久化的半截，与 GET /messages 拼全量；`[P0]sse_channel.md §10.7`） | ① `app/web/src/components/chat-page/use-session-sse-subscribe.ts:175`（playground shared 引擎）；② `app/web/src/components/studio-page/section-squad-chat.tsx:145`（群聊直接订阅） |
| **`session_panel`** | `session_id:<sid>`（不带 _amt 后缀；per-session 单一 group） | `app/server/src/agent/session-state-machine.ts:238`（status_update）/ `session-store.ts:577` / `session-unread-ops.ts:96`（read_update）/ `session-clear-op.ts:141,148,157`（clear）/ `session-task-lock.ts:215`（summary_task_update）/ `session-workspace-store.ts:66`（workspace_file/dir_changed） | session CAS 状态变更（idle/running/interrupting/error）、usage 更新、unread CAS、clear、workspace 文件变化、compact summary 状态 | `SessionEvent`（discriminated union，type 字段区分 7+ 子类型） | **false**（快照态，回放过时有害；`[P0]sse_channel.md §10.7`） | ① `use-session-sse-subscribe.ts:180`；② `section-squad-chat.tsx:167`（仅过滤 workspace_file/dir_changed 透传 store） |
| **`session_meta`** | `_all`（共享广播 group；`ReplayableEventBus` group 间完全隔离，无 wildcard，故用约定常量 `_all` 收所有） | `app/server/src/agent/session-meta-broadcaster.ts:146`（broadcast → emit） + 触发点：① `session-unread-runtime.ts:118`（markUnreadTrue CAS 成功直调）；② `bootstrap.ts:415` 包 `wrapStatusBusForUnread` 单点捕获 statusBus 任意 session 事件 → broadcaster.broadcast(sid) | session 任意状态变更（status / usage / read / clear / dir_changed / title 改等）+ unread CAS 产生 | `SessionMetaUpdateEvent`（data = 全量最新 `SessionMetaView`，每次重读 crud，不携带增量 delta） | **false**（列表初始态靠 GET /session 拉全量） | ① `use-page-chat-mount.ts:84`（playground 列表，bizType=playground 反向守卫在 reducer `chat-slice.ts:129`）；② `use-studio-unread-meta.ts:64`（studio 红点，biz='studio' 反向守卫在本 hook） |

**关键 group 命名规则**：
- `session_id:<sid>` = session 级订阅（session_panel 全部 + session_meta 不用此）
- `session_id:<sid>_amt:<modeKey>` = agent run 级订阅（agent_loop 专有，多 mode 隔离）
- `_all` = 全局广播（session_meta 专有）

---

## §2 SSE 通道架构（基于 spec + 代码）

### 2.1 Client 端（web 单例 + subId 路由，方案 B）

**单例位置**：`app/web/src/lib/sse-singleton.ts:23` 提供 `getSseClient()` 模块级 lazy 单例（不用 React Context 避免 StrictMode 双 mount 双建实例）。首次调用 `new SseClient() + void connect()`，后续返回同实例。测试隔离 `_resetSseSingletonForTest()`。

**SseClient 关键设计**（`app/web/src/lib/sse-client.ts`）：
- `connect()`：fetch + reader.read() 消费循环，**永不 resolve 直到连接关闭**（`sse-client.ts:108-128`）。任何 `await sse.connect().then(...)` 链式调用都会让 `.then` 永不执行 → 是 v0.0.85 F4 红点 bug 根因（`sse_client_singleton.md §1 S3` 已落规范）。
- `subscribe(topic, group, handler)`：①前端 `subId = ulid()` 生成（`sse-client.ts:146`）；②`handlers.set(subId, handler)` **先注册**（保 POST 期间后端推帧能路由）；③`POST /sse/subscribe { topic, group, subId }`；④POST 失败回滚 `handlers.delete`。返回 `SubscribeHandle` 句柄。
- `unsubscribe(handle | subId)`：①`handlers.delete(subId)`；②`DELETE /sse/subscriber/:subId` best-effort。
- `destroy()`：`controller.abort()` 断 GET /sse + `handlers.clear()`；不循环 unsubscribe（spec §3.4：app 卸载靠 TCP RST 兜底）。
- 帧路由：`handlers.get(frame.subId)?.(frame.data)`，**无 subId 帧 drop**（`sse-client.ts:117`）。

**正确连接模式**（spec index.md ④ 原则 13）：必须 `void connect()` + 立即 `subscribe()` 并行，禁止 `await connect().then(subscribe)`。

### 2.2 Server 端（SseChannel 广播 + SubscriberProxy 注入 subId）

**SseChannel 全局对象**（`app/server/src/sse/sse-channel.ts`）：生命周期由 bootstrap 创建，electron app 关闭时 `destroy()`。

- **三层 refcount 模型**（spec multipub §5）：
  1. `subscribers: Map<subId, SubscriberProxy>`（`sse-channel.ts:67`）— 全部活跃订阅者
  2. `groupSubs: Map<${topic}:${group}, Set<subId>>`（`sse-channel.ts:69`）— channel 侧 refcount
  3. `subs: Map<${topic}:${group}, Subscription>`（`sse-channel.ts:65`）— hub 侧消费循环（同 key 首 sub 才建 dispatcher fan-out，非首 sub 只加 Set）
  4. `sinks: Set<SseSink>`（`sse-channel.ts:71`）— 活跃 GET /sse 连接（多连接 fan-out）

- **方案 B 关键**：listener 闭包给帧注入 subId，**writeFrame 广播不变**（不按 subId 定向，所有 sinks 收到全部帧）。多 subId 订同 (topic,group) → bus fan-out 调 N 个 listener → 每 listener 各 writeFrame（带各自 subId）→ 广播 N×M 帧（M=sink 数）→ 前端按 subId 过滤。
- **fan-out dispatcher**（`sse-channel.ts:192-199`）：因 hub.consume 循环只调 head 注册的 listener，多 listener fan-out 由 channel 层做（spec 称 T1 偏差，非设计 bug）。
- **isSessionActive**（`sse-channel.ts:307-309`）：`groupSubs.get('session_panel:session_id:'+sid)?.size > 0`，复用订阅信号聚合「前台」，零心跳/零新协议（spec `[P0]sse_channel.md §7`）。**调用方=session 层 SessionUnreadRuntime**，agent-loop/状态机不调。

- **subscribeHooks**（`sse-channel.ts:85` + `bootstrap.ts:758-791`）：`onSubscribe/onUnsubscribe` 是 async 函数，channel `await` 调用。仅 `session_panel` topic + `session_id:<sid>` group 触发 `workspaceManager.startWatch/stopWatch`（lazy chokidar watcher：进会话启动，切走停止；spec session_workspace_manager §1/§7）。

### 2.3 关键不变量（spec `[P0]sse_client_singleton.md §9`）

1. `SseClient.handlers` 是 `Map<subId, handler>`，**不是** `Map<key, Set<handler>>`（subId 一对一路由）
2. 同 (topic, group) 多订阅 = 多个 subId，各自收帧互不干扰
3. **单例不 destroy，组件不碰连接**（spec S3）
4. subId 前端内部生成 ULID（减少一次 RTT，POST 期间帧能路由）
5. 后端不维护 sink-subId 关联（方案 B）
6. **1 次订阅 = 1 个 subId**（不用 component id 做 key，组件多次订阅不撞车）

---

## §3 订阅方清单（组件视角）

| 组件/hook | 订阅 topic | 何时订阅 | 订阅粒度 | 句柄存哪 | file:line |
|---|---|---|---|---|---|
| **`usePageChatMount`**（playground 列表） | `session_meta _all` | page-chat mount（playground view 激活） | 全局（共享 `_all`）一次 | 闭包 `metaHandle` | `app/web/src/components/chat-page/use-page-chat-mount.ts:84` |
| **`useSessionSseSubscribe`**（playground shared run-state 引擎，page-chat 内消费） | `agent_loop` + `session_panel` 双 topic | sessionId 变化（切会话/进会话）触发 useEffect | per-session（`session_id:<sid>_amt:current` + `session_id:<sid>`） | 闭包 `h1, h2` | `app/web/src/components/chat-page/use-session-sse-subscribe.ts:175,180` |
| **`SquadChatPage`**（studio 群聊） | `agent_loop` + `session_panel` 双 topic | squad-chat mount（点 chat 节点进群聊） | per-session | ref `subRef.current[]` | `app/web/src/components/studio-page/section-squad-chat.tsx:145,167` |
| **`MemberChatPage`**（studio 单聊） | 复用 `useSessionRunState(sessionId)` → 内部走 `useSessionSseSubscribe` | member-chat mount | per-session | hook 内闭包 | `section-member-chat.tsx:111`（调 useSessionRunState） |
| **`useStudioUnreadMeta`**（studio 红点）⚠️ | `session_meta _all` | page-studio mount（studio view 激活） | 全局一次 | 闭包 `metaHandle` | `app/web/src/components/studio-page/use-studio-unread-meta.ts:64` |

**Playground ↔ Studio 隔离机制**：
- `session_meta _all` 是真广播（所有订阅者都收）；隔离靠各自 handler 内的 bizType 守卫：
  - playground 列表 reducer：`chat-slice.ts:129 if (incoming.biz === 'studio') return;`（拒纳 studio meta）
  - studio 红点 hook：`use-studio-unread-meta.ts:68 if (incoming.biz !== 'studio') return;`（反向守卫）

**组件级 polling 残留**（未走 SSE 总线，违反 spec §8 轮询消除目标）：
- `component-budget-meter.tsx:49` `window.setInterval(() => void reload(), 30_000)` — budget 用量 30s 轮询（注释自承"SSE 推送为主，polling 兜底"，但 SSE 推送并未接线）
- `section-cron-panel.tsx:90` `setInterval(...)` — cron 任务列表轮询（待核用途）
- `component-member-panel-memory.tsx:55` `window.setTimeout(() => void reload(), 1500)` — 单次刷新非轮询（可接受）
- `page-connector.tsx:49` `timerRef = useRef<setInterval>` — 待核

---

## §4 api + sse 配合风险（重点）

### R1：乱序 — api REST 响应 vs SSE 推送时序竞态【严重度：中】

**风险描述**：组件 mount 时同时触发 GET /messages + GET /session + GET /session/:id/usage（拉初始态）和 subscribe SSE（推增量）。GET 异步返回，SSE 帧可能在 GET 之前/之后到达。

**触发场景**：进会话时 reducer 顺序错位（如先收 SSE `text_delta` 后收 GET messages list）→ reducer 应用到空 messages 导致丢增量或顺序错乱。

**现状防护**：`use-session-sse-subscribe.ts:150-184` 强制顺序：①先 GET messages → ②GET session → ③GET usage → ④await subscribe。subscribe 在 GET 之后，但 subscribe POST 完成后立刻可能收到帧（POST 期间后端已登记 listener）。GET 是「到这一刻为止的全量」，subscribe 后到达的 SSE 帧是「这一刻之后的增量」——GET 和 subscribe 之间存在理论空窗（GET 发起 → GET 返回 → subscribe 完成），但 agent_loop `replayable=true` 会回放「GET 之后未持久化的半截」弥补（spec `[P0]sse_channel.md §10.7`）。

**遗留风险**：session_panel 是 `replayable=false`，GET 之后到 subscribe 之前的 session 状态变更会丢。`useSessionSseSubscribe` 没有兜底重读（仅 run_end 后做 GET 校正 sessionRunning，治 D6，但其他 state 字段无校正）。

**证据**：`use-session-sse-subscribe.ts:88-98`（仅 run_end 时触发 GET 校正 sessionRunning）。

---

### R2：丢失 — SSE 断连期间事件丢失，无重连/catch-up 机制【严重度：高】

**风险描述**：`SseClient.connect()` 是单一 fetch reader.read() 循环，任何中断（网络抖动、Electron 渲染进程卡顿、后端重启、HTTP/1.1 idle timeout）会让循环退出，`finally: this.active = false`（`sse-client.ts:127`）。**没有任何自动重连逻辑**。

**触发场景**：
- 用户切走 Electron 窗口一段时间后切回 → 连接可能已被中间代理/服务端 idle-timeout 关闭
- dev 环境后端 HMR 重启 → 连接断开
- macOS 系统睡眠唤醒后 → TCP keep-alive 失败

**现状**：`connect(onError?)` 接受 onError 回调但只 console.warn，不重建连接。所有 handlers 残留在 Map 里继续持有组件闭包（内存泄漏），后续 subscribe 会因 `if (this.active) return` 在 connect 入口被拦截（`sse-client.ts:94`），实际订阅请求会 POST 到 backend，backend 收到帧也会 push 到 sink，但前端 sink 已无人消费（stream 已 close）。

**agent_loop 补帧**：replayable=true 在 subscribe 时回放未持久化的半截。但前提是 SSE 连接还在，断连期间完全无补帧。session_panel / session_meta 直接丢失，无补帧机制。

**严重度评估**：用户感知为「红点不实时 / chat 列表不刷新 / session 状态卡住」，需手动刷新页面才能恢复。生产环境影响大，但 dev 阶段频次较低故中等可见性。

**证据**：`app/web/src/lib/sse-client.ts:108-129`（无重连）。spec 也没要求重连（spec `sse_client_singleton.md` 全文搜「重连」无结果）。

---

### R3：重复 — 重连后是否重复推、客户端是否幂等【严重度：低】

**风险描述**：因当前无自动重连，此风险暂不存在。但如果未来加重连：
- agent_loop replayable=true 会回放历史 buffer（含已 GET 持久化过的），reducer 需要幂等（按 message id 去重）
- session_meta 是全量替换语义（reducer 按 id 整条替换），天然幂等（spec `[P0]sse_channel.md §10.5`）
- session_panel 快照态幂等性依事件类型：session_status_update 全量替换幂等；session_usage_update 全量替换幂等

**现状**：reducer 已基本幂等。`applyAgentEventToMessages` 按 message+part key 查找更新而非顺序创建（memory `apply-agent-event-key-by-id` 原则），重复 run_start 会 replace。但 spec `sse_client_singleton.md §3.1` 警告「handler 内只读 refs，不读 state」避免 stale closure，coder 落地未完全验证。

**证据**：`use-session-sse-subscribe.ts:84-87`（applyAgentFrame 调纯 reducer，依赖 reducer 幂等性）。

---

### R4：跨 session 串话 — topic 是否带 session 隔离、切 session 后旧 topic 事件灌进新 session【严重度：高】

**风险描述**：切会话时如果旧 session 的订阅未清理干净，旧 session 的 SSE 帧会继续推到前端，handler 会把旧 session 的 messages 写到新 session 的 slice。

**触发场景**：
- 旧 sessionId 的 unsubscribe 调用失败（网络/后端错误）
- cleanup 未触发（component 卸载但 React 18 StrictMode 双 mount 周期处理不当）
- subscribe POST 与 cleanup race（subscribe 未完成时 component 已卸载）

**现状防护**：
- **session 级 group 隔离**：所有 session 相关 topic 都带 `session_id:<sid>` 或 `session_id:<sid>_amt:<mode>` group 后缀。切会话 = unsubscribe 旧 sid 句柄 + subscribe 新 sid 句柄。
- **subId 路由**：handlers Map 按 subId 索引，旧 sid 的 subId 在 cleanup 时从 Map 删除（`sse-client.ts:183 handlers.delete(subId)`），即便后端误推旧帧，前端 `handlers.get(oldSubId)` 返回 undefined，静默丢弃。
- **cancelled flag**：use-session-sse-subscribe.ts:71 + section-squad-chat.tsx:129 用闭包 `cancelled` 变量，cleanup 设 true 后异步回调内 `if (cancelled) return` 兜底。
- **subscribe resolve 前 unmount 兜底**：`use-page-chat-mount.ts:93-97` / `use-studio-unread-meta.ts:78-82` 在 subscribe `.then` 内检查 cancelled，若已 cancelled 手动 unsubscribe 防 handle 泄漏。
- **subagent 只读视图防错拉**：page-chat.tsx:160 注释「subagent 只读页 viewedSessionId=subagent，activeSessionId=parent，错用 parent 会拉错 session 数据」。

**遗留风险**：单例破口（见 §6 G1）—— page-studio 自建独立 SseClient + 独立 GET /sse 连接，**两个连接同时活跃**，frontend 的 sinks 集合有 2 个元素，backend writeFrame 广播会给两个 sink 都 push（spec 方案 B 行为）。但 studio SseClient 自身的 handlers Map 只有自己的 subId，单例 SseClient 的帧它收不到。这不会串话但会**资源浪费**（N×M 浪费 + 双 GET /sse）。

**证据**：单例 sse-client.ts 完整 subId 路由；page-studio use-studio-unread-meta.ts:46 `new SseClient()` 独立实例。

---

### R5：内存泄漏 — 订阅没解绑 / singleton 持有闭包 / 事件回调累积【严重度：中】

**风险描述**：
- handler 是组件 mount 时闭包，捕获 setState/reducer/props。如果 unmount 时未调 unsubscribe，handler 残留在 Map 中持有组件闭包 → 组件无法 GC。
- 频繁切 session 会反复 subscribe + cleanup，若 cleanup race 失败可能累积。
- `cancelled` flag 闭包也持有 setter 引用，setter 来自 useState（stable 但仍占内存）。

**触发场景**：
- 快速切会话（A→B→C→D），每次 sessionId 变化触发 useEffect 重跑
- StrictMode 双 mount：第一次 cleanup 第二次 mount
- page-studio 频繁切（playground ↔ studio）

**现状防护**：
- 所有订阅点都用 `useEffect` cleanup 调 `handle.unsubscribe().catch(() => {})` best-effort
- subscribe `.then(h => { if (cancelled) h.unsubscribe() })` 兜底 subscribe-before-cleanup race
- cancelled flag 兜底回调内不再 setState
- `_resetSseSingletonForTest()` 测试隔离

**遗留风险**：
- 单例破口（§6 G1）：page-studio `useStudioUnreadMeta` mount 时 `new SseClient()`，cleanup 调 `sse.destroy()`。如果 cleanup 未跑（component 卸载异常）→ SseClient 实例 + handlers 泄漏。**且独立 SseClient 不在 singleton 管辖内，跨 page 不复用，每次进 studio 都建+拆**。
- `useSessionSseSubscribe` deps 仅 `[sessionId]`（`use-session-sse-subscribe.ts:194`），其他 setter 都 stable，无重复 subscribe 风险。但 ctxRef/sliceRef 是 mutable，多个 effect 共享，若重跑期间异步 race 可能读到旧 ctx（applyAgentEventToMessages 对 ctx 有副作用非纯函数，注释已警告）。

**证据**：所有 subscribe 点完整审查，cleanup 都接好。单例破口是主要泄漏源。

---

### R6：api 数据与 sse 数据一致性 — 同一份数据 api 拉一遍 + sse 推一遍，谁为准、如何 merge【严重度：中】

**风险描述**：同一份 session 状态可能既被 GET /session 拉取（初始态）又被 SSE session_panel 推送（增量）。如果时序错位（GET 在 SSE 之后返回），GET 会用旧态覆盖 SSE 推的新态。

**触发场景**：进会话瞬间状态变化（如 session 正好转 idle），SSE 推 `state=idle` 早于 GET /session 返回 `state=running`（GET 发起时状态）→ 前端先 apply SSE 设 idle，再 apply GET 设 running → 错误状态。

**现状防护**：
- `use-session-sse-subscribe.ts:152-163` GET 顺序：messages → session → usage，**严格先 GET 完再 subscribe**（line 184 await subscribe 在 GET 之后）。
- reducer 是 last-write-wins（无版本号/时间戳比对）。

**遗留风险**：
- session_panel 是 replayable=false → subscribe 之后会收未来增量，但 subscribe 之前的 SSE 事件已丢（GET 之后 subscribe 之前的窗口）。若此窗口内有 state 变更，前端漏掉。
- session_meta 同理 replayable=false，列表挂载后 GET /session 拉全量，但 GET 完到 subscribe 完之间的 meta 增量丢失。
- 无版本号/revision 比对机制，纯靠时序保证。

**证据**：`use-session-sse-subscribe.ts:152-184` 时序控制；spec `[P0]sse_channel.md §10.7` 说明 replayable=false 主题靠 GET 拉初始态、订阅后增量。

---

### R7：切 page（playground ↔ studio）数据生命周期【严重度：高】

**风险描述**：用户原话「我从 playground 切 studio，数据还在不在？」「playground 开启切会话，上一个 session 的数据和订阅都清理了？」。

**触发场景**：app-shell 路由切换 → 旧 page（page-chat / page-studio）unmount → 新 page mount。

**现状清理情况**：
| 场景 | 数据 | 订阅 | 连接 |
|---|---|---|---|
| 切会话 A→B（同 page） | useSessionSseSubscribe cleanup reset 旧 messages/runActive/sessionRunning/usage/summaryTask（`use-session-run-state.ts:166` useLayoutEffect 同步清空） | unsubscribe 旧 sid 双 topic + subscribe 新 sid 双 topic | 不动（singleton 复用） |
| 切会话 A→B（page-chat） | page-chat store.sessions[] 列表保留；run-state 切换 | session_meta `_all` 订阅保留（page-chat mount scope） | 不动 |
| playground → studio | page-chat unmount：store 保留 sessions[] 列表（Zustand 全局 store 跨 page 不清） | usePageChatMount cleanup：unsubscribe session_meta `_all` | singleton 不 destroy（保活） |
| studio → playground | page-studio unmount：useStudioUnreadMeta cleanup：destroy 独立 SseClient + unsubscribe meta | 独立 SseClient.destroy() 断 GET /sse | **断一根 GET /sse 连接**（sink 从 sinks Set 删除） |
| studio 内切 chat 节点（A→B） | StudioChatRouter 切 member/squad chat | section-squad-chat cleanup：unsubscribe 双 topic；section-member-chat 经 useSessionRunState cleanup | 不动 |

**遗留风险**：
- **page-studio unmount 频繁拆建 GET /sse**：每次切到 studio 都新建连接、切走都拆连接。高频切换会触发 backend sink 频繁 add/delete，无直接功能问题但浪费资源。
- **page-chat unmount 时 store 保留 sessions[]**：用户期望"切走 playground 数据清掉"，但 Zustand 全局 store 设计上跨 page 保留（聊天列表/拓扑）。如用户期望严格清空，需在 page-chat unmount 调 store.clear()，但 spec 未要求。
- **activeSessionId 切走后 session_meta 增量继续到达 → playground 列表 reducer 继续更新 sessions[]**：这反而是期望行为（后台 session 完成时列表实时刷新红点）。
- **studio 内 chat 节点切换不 reset store**：squad-chat/member-chat 各自管 messages state（不在全局 store），切走 unmount 自动 GC。

**证据**：page-studio.tsx:60 `useStudioUnreadMeta()` 顶层调用；use-studio-unread-meta.ts:90-97 cleanup destroy；use-page-chat-mount.ts:102-107 cleanup 不 destroy。

---

### R8：fs watcher 切 tab 残留【严重度：中】

**风险描述**：用户原话「右侧文件 tab，切换长期记忆，fs 的 watch 到底变了没？」。session_panel 订阅触发 `workspaceManager.startWatch(sid, dir)`，切走 unsubscribe 触发 `stopWatch`。如果快速切 tab（subscribe/unsubscribe 高频交替），异步 await 链可能 race（onSubscribe 触发但 startWatch 还在跑，onUnsubscribe 已到 → stopWatch 跑完，再 startWatch 才完成 → 残留 watcher）。

**现状防护**：v0.0.85.ui_opt F2 已修：`setSubscribeHooks` 改 async + await（spec `sse_channel.md §5.1`），消除 fire-and-forget 竞争。channel 侧 await onSubscribe → onSubscribe 内部 await startWatch；onUnsubscribe 对称。chokidar 'ready' 事件 + addDir listener 显式 watcher.add（spec `session-workspace-manager §7`，已修 BUG-005/006）。

**遗留风险**：
- 跨 page 切换时（playground → studio），playground 的 session_panel 订阅已 unsubscribe → workspaceManager.stopWatch 触发。但单例破口（§6 G1）下 page-studio 的独立 SseClient 也会订阅 session_meta（不是 session_panel），**不会触发 workspaceManager**（hook 仅对 session_panel 触发）。故 fs watch 不会被 studio SseClient 干扰。
- session_meta `_all` 广播 group 不匹配 `session_id:<sid>` 前缀，`extractSessionIdFromGroup` 返回 null，hook 不触发。安全。

**证据**：bootstrap.ts:763-790 setSubscribeHooks 守卫 `topic !== SESSION_PANEL_TOPIC return`；session-workspace-manager.ts await chokidar ready + addDir。

---

## §5 现有测试覆盖

| 测试文件 | 覆盖什么 | 漏了什么 |
|---|---|---|
| `app/web/src/lib/__tests__/sse-client.test.ts` | SseClient 基础：connect/subscribe/unsubscribe/destroy、帧解析、handler 路由 | 重连（R2）、断连后订阅行为、错误恢复 |
| `app/web/src/lib/__tests__/sse-singleton.test.ts` | getSseClient lazy 单例幂等、_resetSseSingletonForTest | 跨 page 切换时 singleton 是否真的不被 destroy（G1 场景） |
| `app/web/src/lib/__tests__/sse-client.subid.test.ts` | subId 前端生成、帧按 subId 路由、无 subId 帧 drop | 多 subId 同 (topic,group) 互不干扰（仅 UT 级，未跨组件验证） |
| `app/web/src/components/chat-page/__tests__/page-chat-sse-singleton-mount.test.tsx` | page-chat mount 走 getSseClient 单例、cleanup 调句柄 unsubscribe 不 destroy | 未验证 studio 独立 SseClient 是否真的"不存在"（G1） |
| `app/web/src/components/chat-page/__tests__/page-chat-switch-unsubscribe.test.tsx` | 切会话 A→B：旧 sid 双 topic unsubscribe、新 sid 双 topic subscribe、session_meta `_all` 跨 session 保留 | 切回 A 时 A 重新 subscribe（spec 注释提到覆盖，待核实）、subscribe-before-unmount race |
| `app/web/src/components/studio-page/__tests__/section-squad-chat-sse.test.tsx` | squad-chat mount/unmount 订阅双 topic、workspace event fan-out 到 store | studio ↔ playground 切换时 squad-chat 订阅行为 |
| `app/server/src/__tests__/sse-channel.test.ts` | SseChannel 基础：帧格式、fan-out、destroy、isSessionActive | 重连/连接异常恢复 |
| `app/server/src/__tests__/sse-channel.multipub.test.ts` | 方案 B：subId 注入、广播、groupSubs Set refcount、DELETE /sse/subscriber/:subId | 多 sink 场景（多 GET /sse 连接）、sink 故障隔离 |
| `app/server/src/__tests__/handlers-sse.test.ts` | HTTP handler：GET /sse / POST subscribe/unsubscribe / DELETE、topic 白名单、subId 缺省 ULID 兜底 | 异常 payload、并发 subscribe/unsubscribe 时序 |

**核心漏测**：
1. **SseClient 断连恢复**（R2）：无任何测试覆盖 connect 中断后行为
2. **跨 page（playground ↔ studio）切换**（R7）：page-studio unmount 时独立 SseClient.destroy 是否真的断连接、是否影响 singleton
3. **多 GET /sse 连接共存**（G1 引发）：sink 集合有 2 个时 broadcast 行为
4. **api + sse 时序竞态**（R1/R6）：无集成测试覆盖 GET 与 SSE 帧到达顺序
5. **subscribe POST 失败回滚**：`sse-client.ts:160-163` POST 失败 delete handler，但无测试触发此分支

---

## §6 spec ↔ code gap 清单

### G1【严重】spec 声明「studio unread 红点独立 SseClient 不存在」与代码实际不符

- **spec 说**：`[P0]sse_client_singleton.md §5` R3 注脚：「research.md 列的「studio unread 红点独立 SseClient」（D3）经代码核实**不存在**—— studio 红点已通过 `session_meta _all` 在 page-chat sharedSse 上订阅。R3 收敛后该订阅仍挂在单例上，多 handler 靠 subId 区分（不冲突）」
- **代码实际**：`app/web/src/components/studio-page/use-studio-unread-meta.ts:46` `const sse = new SseClient();` 显式创建独立实例；`use-studio-unread-meta.ts:59 void sse.connect(...)`；`use-studio-unread-meta.ts:95 sse.destroy()` unmount 时销毁。
- **触发后果**：
  1. 违反 spec S1「全局唯一 SseClient 单例」原则
  2. 同时存在 2 条 GET /sse 长连接（playground singleton + studio own）
  3. backend writeFrame 给两个 sink 都广播 N×M 帧（spec 方案 B 行为），但前端 studio SseClient 只能路由自己的 subId 帧，singleton 的帧它收不到（浪费）
  4. 频繁切 page（playground ↔ studio）反复建/拆 GET /sse 连接
- **spec 应修正方向**：要么改代码（`use-studio-unread-meta` 改走 `getSseClient()` 单例 + subId 区分），要么承认 spec § 5 R3 注脚为「待迁移状态」（标 since: v0.0.92 待修）。

### G2【中】spec SseClient.subscribe 接口签名与代码完全一致但「不抛异常给 caller」未明示

- **spec 说**：`[P0]sse_client_singleton.md §3.1` 第 4 点「POST 失败 → handlers.delete(subId) + throw（caller catch 不阻塞 UI）」
- **代码实际**：`sse-client.ts:159-163` POST 失败 throw e；caller 在 `use-page-chat-mount.ts:100` / `use-studio-unread-meta.ts:87` / `use-session-sse-subscribe.ts:178` 都用 `.catch(...)` 吞掉。
- **不算严重 gap**：行为一致，spec 描述准确。

### G3【低】spec 描述「child store 拓扑」与 chat-slice 实际不符

- **spec 说**：`[P0]sse_channel.md §10.5` 「reducer 行为：收到 → 按 data.id(=sessionId) 在 sessions[] 中整条替换」
- **代码实际**：`chat-slice.ts:129` 加 bizType 守卫 `if (incoming.biz === 'studio') return;`（playground 拒纳 studio meta）。spec 在 index.md ① 概念表 session_meta 行已注记此守卫，但 `[P0]sse_channel.md §10.5` 未提。
- **建议**：`[P0]sse_channel.md §10.5` 补一行「playground reducer 加 bizType 守卫拒纳 studio meta，studio 红点 hook 反向守卫；双向隔离」。

### G4【低】agent_loop group 命名 spec 与代码一致但 spec 表达不完整

- **spec 说**：`[P0]sse_channel.md §4` 帧格式示例 `"group": "session_id:01KVC..."`（裸 sid）
- **代码实际**：`agent-interface.ts:185 groupKeyForMode(sid, modeKey)` 生成 `session_id:<sid>_amt:<modeKey>`，前端 use-session-sse-subscribe.ts:73 `agentGroup = session_id:${sessionId}_amt:current` 都带 _amt 后缀。
- **不算 gap**：`[P0]sse_channel.md` 是早期 spec 示例，agent_interface.md §4 v1.1 已更新命名规范。但建议 `[P0]sse_channel.md §4` 帧示例补完整 group 命名规范链接。

### G5【低】spec SseChannel `subs` Map 描述与实际多一层 dispatcher

- **spec 说**：`[P0]sse_channel.md §5` 伪代码 `subs.set(key, hub.sub(topic, group, listener))`，listener 直接调 writeFrame。
- **代码实际**：`sse-channel.ts:192-200` 首 sub 时建 dispatcher（fan-out 到 groupSubs 全部 proxy 各自 listener），非首 sub 只加 Set；dispatcher 才是 hub 注册的 listener。注释明示这是 T1 hub consume 循环只调 head listener 的偏差。
- **不算 gap**：multipub spec §4 描述已包含 dispatcher，但主 spec `[P0]sse_channel.md §5` 未同步。建议补一行 cross-ref 到 multipub §4。

---

## 附录 A：调研覆盖范围

**已读 specs**：
- `specs/tech/app/frontend/index.md`（5 章总起 + 14 条核心原则）
- `specs/tech/app/frontend/[P0]sse_channel.md`（基础 SSE 桥 + §9 session_panel + §10 session_meta + §10.7 replay 配置）
- `specs/tech/app/frontend/[P0]sse_channel_multipub.md`（方案 B + 三层 refcount）
- `specs/tech/app/frontend/[P0]sse_client_singleton.md`（前端单例 + subId + 6 项不变量）
- `specs/tech/app/frontend/log.md`（v0.0.42 / v0.0.85.ui_opt / v0.0.39 变更）

**已读代码**：
- server 端：sse-channel.ts / sse-frame.ts / handlers/sse.ts / bootstrap.ts(setSubscribeHooks 部分) / agent-interface.ts(groupKey) / agent-loop-emitters.ts
- web 端：sse-client.ts / sse-singleton.ts / use-page-chat-mount.ts / use-session-sse-subscribe.ts / use-session-run-state.ts(部分) / section-squad-chat.ts / section-member-chat.ts / use-studio-unread-meta.ts / page-studio.tsx / component-budget-meter.tsx / component-conversation-item.tsx(部分)

**未读**（受时间约束，标注「待核」）：
- `app/server/src/router.ts` SSE 路由注册（不影响结论）
- `app/server/src/agent/event-hub.ts` refcount 实现细节（spec 已覆盖，行为可信）
- `app/server/src/handlers/sse.ts` 之外的 http-server SSE 头设置（已在 handlers/sse.ts 读到）
- component-conversation-item.tsx 完整逻辑（仅读 pollRef 部分）
- section-cron-panel / page-connector / component-member-panel-memory 完整逻辑

---

## 附录 B：术语表

| 术语 | 含义 |
|---|---|
| **SseClient** | 前端 SSE 通道客户端类，封装 fetch GET /sse + reader.read 消费循环 + handlers Map 路由 |
| **SseChannel** | 后端 SSE 桥对象，全局单例，管理 sinks（连接） + subscribers（订阅者） + groupSubs（refcount） |
| **singleton（单例）** | `getSseClient()` 模块级 lazy 实例，跨 page 复用，组件不碰连接生命周期 |
| **subId** | 订阅唯一 id（前端 ULID 生成），1 次订阅 = 1 个 subId，前后端帧路由唯一 key |
| **SubscriberProxy** | 后端单个订阅者的代理对象（不持 sink），listener 闭包注入 subId |
| **dispatcher** | channel 首 sub 时建的 fan-out 函数，遍历 groupSubs 全部 proxy 各调 listener（弥补 hub 只调 head listener 的限制） |
| **方案 B** | v0.0.88 用户最终拍板：writeFrame 广播不变 + subId 注入帧 + 前端按 subId 过滤（非定向投递） |
| **bizType** | session 业务类型（'playground' / 'studio'），用于双向隔离 meta 广播 |
| **isSessionActive** | session 前台判定探针，复用 session_panel 订阅信号聚合「用户正在看」，零心跳/零新协议 |
