---
type: spec
title: SSE Client Singleton（客户端单通道订阅规范）
priority: P0
status: active
updated: 2026-07-08
since: v0.0.88
related: [[P0]sse_channel.md, ../../agent/event/[P0]event_hub.md, ../../agent/event/[P0]event_bus.md]
---

# SSE Client Singleton（客户端单通道订阅规范）

> 管什么：`app/web/` 整个前端的 SSE 订阅模型——**1 条 SSE 通道 + 1 个 SseClient 单例 + 组件级订阅 + subId 路由**（方案 B：后端广播，前端按 subId 过滤）。
> 不管什么：后端 hub/channel 改造（→ `[P0]sse_channel_multipub.md`）；event bus replay/sticky 行为（→ `../../agent/event/[P0]event_bus.md`）；组件契约细则（→ `specs/ui/components/`）。
> 关系：本文件是**前端 SSE 订阅权威规范**，`[P0]sse_channel.md` 是后端 SSE 桥权威规范，二者共同定义「客户端单通道订阅」端到端契约。
> **术语统一**：标识字段名 = `subId`（不用 `compId` / `subscriberId`）。**1 次订阅 = 1 个 sub id**——一个组件可能订阅多次（如 agent_loop + session_panel 两条），用 component id 做 key 会撞（同组件第二条覆盖第一条）；subId 贯穿前后端，是唯一粘合 key。**handler 是闭包，天然绑定组件 instance**（JS 闭包捕获组件作用域的 setState/reducer/props），不用显式存 instance。

## 1. 核心原则（MUST NOT 违反）

| # | 原则 | 理由 |
|---|------|------|
| **S1** | **全局唯一 SseClient 单例**：app 根 mount 时 `void singleton.connect()` 一次；app 卸载时 `singleton.destroy()`。中间全程不销毁、不重连。 | 后端 `EventHub`/`SseChannel` 本就是「1 消费者 per (topic,group)」模型，多 SseClient 共存触发未设计缺陷（hub 无 refcount / channel subs 去重丢 replay / `_all` 多订阅者互相踩）。详见 research.md §0 / §1.Q3。 |
| **S2** | **1 条 GET /sse 长连接**：DevTools Network 全生命周期只见 1 条持久 `GET /sse`。切会话/切页面/StrictMode 双 mount 都不动连接。 | 连接反复拔插会触发 ownSse 时序竞态（handler 注册前帧丢 / destroy abort / StrictMode 双 mount race），是 v0.0.87 现场根因。 |
| **S3** | **订阅所有权 = 组件级，连接所有权 = app 级**：组件 mount `subscribe()`、unmount `unsubscribe()`，**不动通道**。 | 解耦连接生命周期与订阅生命周期——切会话只换订阅句柄，连接不动。 |
| **S4** | **subId = 前端路由 key（方案 B）**：每次 `subscribe()` 内部生成 `subId`（前端 ULID），随 `POST /sse/subscribe` 上行；后端帧携带 `subId` 字段下行（**广播不变**，listener 闭包注入 subId）；前端按 `subId` 路由到 handler（**零过滤**）。 | 解决「同 (topic,group) 多 handler」冲突（如 `session_meta _all` 同时被列表 + 红点订阅；又如同一组件订阅 agent_loop + session_panel 两条）——不再靠 `Map<key, Set<handler>>` 客户端兜底，也不靠后端定向投递（后端不维护 sink-subId 关联），靠前端 `Map<subId, handler>` 一对一路由。**1 次订阅 = 1 个 subId**（不用 component id：一个组件可能订阅多次，component id 做 key 会撞，第二条覆盖第一条）。 |
| **S5** | **稳定句柄，不依赖 handler 引用相等**：`subscribe()` 返回 `{ subId, topic, group, unsubscribe }` 句柄；`unsubscribe(handle)` 接受句柄或 subId；句柄自带 `unsubscribe()` 方法方便 cleanup 直接调。 | 避免 React inline arrow handler 每次渲染变化导致「unsubscribe 找不到原 handler」问题。 |
| **S6** | **不发业务消息经 SSE**：SSE 单向（server→client）；发消息走 HTTP `POST /messages`（fire-and-forget）。结果靠 SSE 推。 | 沿用 `[P0]sse_channel.md §4` 既有协议。 |

## 2. 架构（端到端，方案 B）

```
                        ┌── app/web (单例 + 组件订阅) ──┐
                        │                              │
  app root mount        │  SseClient singleton          │
  ──────────────────►   │  ├─ connect() 一次            │   1 条 GET /sse
                        │  ├─ handlers: Map<subId, handler>
                        │  └─ destroy() app 卸载        │
                        │                              │
  组件 mount            │  const h = singleton          │
  ──────────────────►   │    .subscribe(topic, group, handler)
                        │  // 内部生成 subId, POST 上行
                        │                              │
  组件 unmount          │  singleton.unsubscribe(h)    │
  ──────────────────►   │  // DELETE /sse/subscriber/:subId │
                        └──────────────────────────────┘

                        ┌── app/server (channel 多订阅 + subId 注入广播) ──┐
                        │                                                  │
  POST /sse/subscribe   │  SseChannel.subscribe(topic, group, subId)       │
  ──────────────────►   │  ├─ listeners 不持 sink：listener 闭包捕获 subId │
                        │  ├─ groupSubs[topic:group].add(subId)            │
                        │  └─ hub.sub(topic, group, listener) 注册 bus 消费 │
                        │                                                  │
  bus emit → listener   │  for each subId in groupSubs[topic:group]:      │
  ──────────────────►   │    (每 subId 各一 listener，bus fan-out 调全部) │
                        │    listener(data) → writeFrame({...,subId})     │  广播（不定向）
                        │    writeFrame → for each sink: sink.push(frame)  │  所有 sink 都收到
                        │                                                  │
  DELETE /sse/subs/:id  │  SseChannel.unsubscribe(subId)                  │
  ──────────────────►   │  ├─ proxy.cancel() → hub.activeSubs[key] splice │
                        │  ├─ subscribers.delete(subId)                   │
                        │  └─ groupSubs[key].delete（空则清 + onUnsubscribe）│
                        └──────────────────────────────────────────────────┘
```

> **方案 B 关键**：后端 writeFrame 仍广播所有 sinks，**不**按 subId 定向；每 sink 收到全部 N 帧（N=该 (topic,group) 订阅者数）；前端 SseClient 单例按自己 handlers 的 subId 集合过滤——`handlers.get(frame.subId)?.(frame.data)`，无匹配则静默丢弃（其他 tab 的帧）。

## 3. SseClient 单例接口

```typescript
/** 订阅句柄：unsubscribe 用，不依赖 handler 引用相等；句柄自带 unsubscribe 方法 */
interface SubscribeHandle {
  subId: string;       // 内部生成 ULID，唯一标识本订阅
  topic: string;
  group: string;
  unsubscribe: () => Promise<void>;  // 内部绑定 subId，cleanup 直接调 handle.unsubscribe()
}

class SseClient {
  /** handler 路由表：subId → handler（一帧一调，零过滤） */
  private handlers = new Map<string, (frame: SseFrame) => void>();
  private controller: AbortController | null = null;
  private active = false;

  /** app 根 mount 调一次；幂等 */
  async connect(onError?: (e: unknown) => void): Promise<void>;

  /**
   * 订阅 (topic, group)：内部生成 subId + 上行 POST 携带 + 注册 handler
   * handler 是闭包，天然绑定组件 instance（捕获组件作用域的 setState/reducer/props），不用显式存 instance
   */
  async subscribe(
    topic: string,
    group: string,
    handler: (frame: SseFrame) => void,
  ): Promise<SubscribeHandle>;

  /** 取消订阅（按句柄或 subId）→ DELETE /sse/subscriber/:subId */
  async unsubscribe(handle: SubscribeHandle | string): Promise<void>;

  /** app 卸载调一次：断连接 + 清 handler；不动 hub 后端订阅（后端 refcount 自管） */
  destroy(): void;
}
```

### 3.1 subscribe 行为（MANDATORY）

1. 内部 `subId = ulid()`（前端生成，全 app 唯一，不暴露给 caller）。
2. `handlers.set(subId, handler)`。
3. `await fetch('/sse/subscribe', { body: { topic, group, subId } })`。
4. POST 失败 → `handlers.delete(subId)` + throw（caller catch 不阻塞 UI，沿用现有 best-effort 风格）。
5. 返回 `{ subId, topic, group, unsubscribe }`（`unsubscribe` 内部绑定 subId，cleanup 直接调 `handle.unsubscribe()`）。

> **handler 是闭包 = 天然绑定组件 instance**：JS 闭包捕获组件作用域的 `setState` / `reducer` / `props`，无需显式存 instance 引用。每次组件 mount 时 `useEffect` 内创建的 inline handler 是该次 render 的新闭包，挂到 handlers Map 上；组件 unmount 后退订，handler 引用随 Map 删除释放。**handler 内只读 refs，不读 state**（避免 stale closure），或用 `useRef<handler>` 桥接最新 state（coder 定）。

### 3.2 帧路由（MANDATORY）

```typescript
// onmessage / fetch stream chunk 解析后：
for (const f of parseSseFrames(chunk)) {
  const handler = this.handlers.get(f.subId);
  handler?.(f.data);  // 零过滤：subId 唯一对应一个 handler；无匹配则静默丢弃（其他 tab 帧）
}
```

- 帧不带 `subId`（旧后端兼容）→ drop（前端单例只认 subId 帧）。
- 同一 (topic, group) 多个订阅 → 多个 subId，每个收到自己的帧（后端 fan-out 给每个 listener，listener 各调 writeFrame 带自己 subId，广播所有 sinks；本 tab SseClient 只匹配自己的 subId）。

### 3.3 unsubscribe 行为（MANDATORY）

1. 解析 `subId`（从句柄或直接 string）。
2. `handlers.delete(subId)`。
3. `await fetch('/sse/subscriber/' + subId, { method: 'DELETE' })`（best-effort，失败 catch 不阻塞 UI）。

### 3.4 destroy 行为

- `controller.abort()` 断 GET /sse。
- `handlers.clear()`。
- **不**为每个 handler 调 DELETE unsubscribe（app 卸载 = 后端 channel 也即将 destroy，无需逐个清；若需优雅退出可循环 DELETE，但 app 关闭时 TCP RST 兜底）。

## 4. 单例位置：App 根 Provider

```typescript
// app/web/src/lib/sse-singleton.ts
import { SseClient } from './sse-client';

let singleton: SseClient | null = null;

export function getSseClient(): SseClient {
  if (!singleton) {
    singleton = new SseClient();
    void singleton.connect();
  }
  return singleton;
}

/** 测试隔离：重置单例（仅 NODE_ENV=test 调） */
export function _resetSseSingletonForTest(): void {
  if (singleton) singleton.destroy();
  singleton = null;
}
```

> 选 `getSseClient()` 模块级 lazy 单例而非 React Context provider：
> - 模块级单例跨 page 复用零 prop drilling，playground/studio 都可直接 import。
> - React Context 在 StrictMode 双 mount 下会双建实例（违背 S1），模块级单例天然幂等。
> - 与现有 `sharedSse` 模块级 `let` 风格一致（`page-chat.tsx:38`），迁移路径最短。
> - **app 卸载**：Electron main 进程退出时整个渲染进程销毁，模块级单例随之 GC；显式 `destroy()` 仅在 HMR / 测试隔离场景调。

## 5. 现有 SseClient 实例收敛映射

| # | 当前实例 | 创建点 | 迁移方式 |
|---|---------|--------|---------|
| **R1** | **sharedSse**（playground） | `app/web/src/components/chat-page/page-chat.tsx:38,110` 模块级 `let sharedSse` + mount `new SseClient()` + `void connect()` | **删除模块级 `let sharedSse`**，改为 `import { getSseClient }`；mount 时不再 `new+connect`（单例 lazy 自连）；session_meta `_all` 订阅改 `getSseClient().subscribe('session_meta','_all', handler)`；unmount 不 destroy（单例跨 page 复用）。 |
| **R2** | **ownSse**（studio member-chat） | `app/web/src/components/chat-page/use-session-run-state.ts:231` `const sse = injectedSse ?? new SseClient(); ownSse=true → destroy()` | **删 `ownSse` 分支**：`useSessionRunState` 强制从 `getSseClient()` 取单例，参数 `sseClient?` 改为已废弃（保留兼容签名但忽略，coder 定）；cleanup `unsubscribe` 两 topic 但 **不 destroy**（连接 app 级，组件不碰）。 |
| **R3** | **squad chat 轮询** | `app/web/src/components/studio-page/section-squad-chat.tsx:67,75` `setInterval(fetchOnce, 2000)` | **删 `setInterval` 轮询**，改用 `getSseClient().subscribe('agent_loop', agentGroup, onAgent)` + `subscribe('session_panel', panelGroup, onPanel)`，与 member 单聊同机制；初始 GET 一次拉 transcript 基线（与 §3.4 引擎契约一致）。 |

> research.md 列的「studio unread 红点独立 SseClient」（D3）：v0.0.92 之前**确存在**于 `app/web/src/components/studio-page/use-studio-unread-meta.ts`（`new SseClient()` + `void sse.connect()` + unmount `sse.destroy()`），违反 S1 全局唯一。**since v0.0.92** 已收敛：改用 `getSseClient()` 单例订阅 `session_meta _all`，与 playground session_meta 订阅并存靠 subId 区分（不冲突），unmount 仅 unsubscribe 句柄。详见 §7 重连机制 + `[P0]component_architecture.md §3.8`。

## 6. 组件级订阅契约

```typescript
// 组件 mount：
useEffect(() => {
  const handle = getSseClient().subscribe(topic, group, handler);
  return () => {
    void getSseClient().unsubscribe(handle);
  };
}, [topic, group]);
```

- **handler 闭包陷阱**：React 渲染每次新 inline handler，但 `handlers` Map 按 subId 存首次的 handler。**handler 内只读 refs，不读 state**（避免 stale closure）；或用 `useRef<handler>` 桥接最新 state（coder 定）。
- **切会话**：unsubscribe 旧 group 句柄 + subscribe 新 group 句柄，**不动通道**。
- **StrictMode 双 mount**：第一次 cleanup `unsubscribe(h1)` + 第二次 mount `subscribe()` 生成新 `subId` —— 单例不动，句柄各自独立，无竞态。

## 7. 状态自愈 + SSE 重连（治 D6/D7 + R2，前端层）

> 归属：`useSessionRunState`（chat-page 引擎）做业务自愈；`SseClient` 做 transport 层重连；二者解耦。

### 7.1 业务自愈（归属 useSessionRunState）

| 触发 | 行为 | 治理 |
|------|------|------|
| 收到 `run_end` 但 `sessionState` 仍 `running` | 调 `GET /session/:id` 校正（GET 为权威） | D6 卡 running |
| 收到 `session_status_update{state: idle\|error}` | 强制 `runActive=false`（清 sticky run_start 孤儿影响） | D7 sticky 孤儿 |

### 7.2 SSE 自动重连（since v0.0.92，归属 SseClient transport 层）

> 原标记「（可选）可见性变化 / SSE 重连后 GET 校正一次」—— **since v0.0.92 已落地**：SseClient 内部实现指数回退自动重连 + singleton 接 visibilitychange + `onResumed(cb)` 通知 caller 做 GET 校正。

**重连策略常量**（`SseClient` 私有）：

| 常量 | 默认值 | 说明 |
|---|---|---|
| `reconnectBaseMs` | 1000 | 初始回退（1s） |
| `reconnectMaxMs` | 30_000 | 回退上限（30s） |
| `reconnectJitterRatio` | 0.2 | ±20% jitter（防「羊群效应」多客户端同时重连） |

**重连链路**：
1. `connect()` 内 reader.read() 循环 catch：识别 `AbortError`（destroy 触发）vs 其他瞬时错误（网络抖动/HMR/macOS 唤醒/Electron 卡顿）。
2. AbortError → `active=false` 终态，不重连。
3. 瞬时错误 → 保持 handlers Map 不动（订阅不丢）+ 调 `scheduleReconnect(onError)`：`delay = min(base * 2^attempts, max) × (1 ± random(-0.2, 0.2))`，`reconnectTimer = setTimeout(() => void this.connect(onError), delay)`，`attempts++`。
4. 重连成功（connect 内 stream 起来后）→ `attempts=0` + 触发 `resumedSubscribers` 全部回调。
5. `destroy()` 设 `destroyed=true` + `clearTimeout(reconnectTimer)`；`scheduleReconnect` 入口检查 `if (this.destroyed) return` 防 destroy 后僵尸重连。

**invariants**：
- handlers Map 在瞬时错误时**不清**（保留订阅，重连后继续路由）。
- `connect()` 仍是 stream loop 永不 resolve（重连走 catch，不走 then；详见 memory `sseclient-connect-never-resolves`）。
- `isConnected()` 在重连中返 false（但可恢复），destroyed 后永远 false（终态）。

**`onResumed(cb): () => void`**：caller 注册回调（返回 unsubscribe 函数），在「重连成功」或「visibilitychange hidden→visible（连接已 active）」时触发。典型 caller：`useSessionSseSubscribe` 注册一个回调调 `GET /session/:id` + `GET /messages?limit=50` 校正当前活跃 session 态（replayable=false 的 session_panel/session_meta 靠 GET 兜底；agent_loop 靠 hub replay）。

**visibilitychange listener**：`sse-singleton.ts` 模块顶层（首次 getSseClient 时）注册一次 `document.addEventListener('visibilitychange', ...)`：hidden→visible 时若 `!singleton.isConnected()` → 触发 `void singleton.connect(onError)` 自愈；若已 connected → 直接触发 `onResumed` 全部回调（让 caller 做 GET 校正）。仅注册一次（模块级 flag 防 StrictMode 双触发）。

## 8. 轮询消除清单

| # | 位置 | 当前 | 迁移 |
|---|------|------|------|
| **P1** | `section-squad-chat.tsx:67` `setInterval(fetchOnce, 2000)` | 2s 轮询 getMessages + usage | 删 setInterval，改单例 subscribe `agent_loop` + `session_panel`；初始 GET 一次 |
| **P2** | `section-squad-chat.tsx:75` 另一 setInterval | （需 coder 核实是否同 fetchOnce 或不同用途） | 同上或保留（coder 审视后定） |
| **P3** | `component-conversation-item.tsx:115-116` `setInterval(onRefreshChildren, 1500)` + `setTimeout(stopPolling, 30000)` | 1.5s 轮询 subagent children × 30s 自停（BUG-001 修复，headless SSE 不可靠兜底） | 删 setInterval + setTimeout；保留 expandOnce 主动刷一次（line 113 `onRefreshChildren(s.id)`）；后续 subagent 状态变化靠 session_meta `_all` 推送（page-chat session_meta handler 已调 `refreshChildren(evt.data.parentSessionId)` 见 `page-chat.tsx:122`，依赖该链路兜底） |

> research.md 初稿曾判断 conversation-item 轮询「代码未见」——v0.0.88 架构期重新核实确认存在（`component-conversation-item.tsx:115-116`），补入清单 P3。

## 9. 不变量（MUST NOT 违反）

1. **`SseClient.handlers` 是 `Map<subId, handler>`，不是 `Map<key, handler>` 也不是 `Map<key, Set<handler>>`** —— subId 唯一路由 key。
2. **同 (topic, group) 多订阅 = 多个 subId**，后端 bus fan-out 给每个 listener，listener 各调 writeFrame 带自己 subId 广播所有 sinks —— 前端单例按 subId 各自路由（其他 tab 的帧静默丢弃）。
3. **单例不 destroy，组件不碰连接** —— 组件只 subscribe/unsubscribe，连接生命周期归 app。
4. **subId 前端内部生成**（ULID），不在后端生成，不暴露给 caller —— 减少一次 RTT（前端立即注册 handler，POST 上行后才收帧，无空窗）。
5. **后端不维护 sink-subId 关联**（方案 B） —— writeFrame 广播不变；定向路由责任在前端 `Map<subId, handler>`。
6. **1 次订阅 = 1 个 subId** —— 不用 component id 做 key（同组件多次订阅会撞，第二条覆盖第一条）；组件多订阅各生成独立 subId。

## 10. 与后端契约的对齐

- 后端帧格式 + 多订阅改造（方案 B 广播 + subId 注入）：见 `[P0]sse_channel_multipub.md`。
- hub refcount + 多消费者：见 `../../agent/event/[P0]event_hub.md §3.1`。
- API 契约（subscribe body 加 subId + DELETE /sse/subscriber/:subId）：见 `specs/api/version_logs/v0.0.88/change_log.md`。

## 11. 与 research.md 的差异说明

- research.md §0 称「handlers 必须升级为 `Map<key, Set<handler>>`」——本架构改为 `Map<subId, handler>`（subId 一对一路由替代 Set 兜底），更彻底。
- research.md §2 称「4 个 SseClient 实例」——代码核实实际 2 个创建点（`page-chat.tsx:110` sharedSse + `use-session-run-state.ts:231` ownSse）；studio unread 红点独立 SseClient 不存在。已在 §5 注脚说明。
- research.md 提及「conversation-item 1.5s 子树轮询」——重新核实代码确认存在（`component-conversation-item.tsx:115-116`），补入 §8 P3。
- **方案选型（用户最终拍板）**：初稿 architect 曾设计「定向投递 A」（后端 SubscriberProxy 持 sink，按 subId 写自己 sink）。用户改方案 B：后端不维护 sink-subId 关联，writeFrame 广播不变，listener 闭包注入 subId，前端 `Map<subId, handler>` 过滤。简化后端状态 + 多 tab 天然支持。
- **字段名统一**：术语曾混用 `compId` / `subscriberId`（两轮 architect 交替改），v0.0.88 架构期最终统一为 `subId`——「1 次订阅 = 1 个 sub id」（不用 component id，组件多订阅各生成独立 subId 不撞车）。

## 12. 版本史

- v0.0.88（2026-07-07）：新建。1 通道 + 1 单例 + 组件级订阅 + subId 路由（方案 B：后端广播 + 前端过滤），收敛 4 个 SseClient 实例路径 + 消除 squad 2s 轮询 + 消除 conversation-item 1.5s 子树轮询。术语统一 `subId`（不用 `compId` / `subscriberId`）。
