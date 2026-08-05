---
type: change_plan
title: v0.0.88 SSE 单通道重构 变更计划书
priority: P0
status: frozen
updated: 2026-07-07
since: v0.0.88
related: [../../app/frontend/[P0]sse_client_singleton.md, ../../app/frontend/[P0]sse_channel_multipub.md, ../../agent/event/[P0]event_hub.md]
---

# v0.0.88 变更计划书（method 级 review 合同）

> 冻结于架构期。planner 按它切 task（`coversModules/coversFiles/coversMethods`），coder 按它实现，reviewer 按它查偏离。
> 8 列：所属模块 / 文件路径 / 函数·符号 / 类型 / 变更内容 / 约束 / 参考 / 预计影响行。
> 行 = 一个函数/符号（新增 class/interface/type 也各占一行）。
> 与「文件级变更清单」的关系：清单是 tech/api spec 内每 feature 章节的文件级叙事（设计粒度）；本计划书是 version 级符号级汇总契约（review 粒度），即清单的冻结 roll-up。二者数据一致。
> **术语统一**：标识字段名 = `subId`（不用 `compId` / `subscriberId`）。**1 次订阅 = 1 个 sub id**——一个组件可能订阅多次，用 component id 做 key 会撞；subId 贯穿前后端，是唯一粘合 key。
> **投递模型（方案 B）**：后端 writeFrame 广播不变；listener 闭包注入 subId；后端不维护 sink-subId 关联；前端 `Map<subId, handler>` 过滤。

## 后端 — event_hub refcount

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| event_hub | `app/server/src/agent/event-hub.ts` | `EventHub.sub()` | 修改 | 命中已有 `activeSubs` 记录时不再 return head 的 cancel；push 真 `ActiveSub` record 到数组（refcount +1），返回新 record 自己的 cancel 句柄；新 record cancel 时按引用从数组 splice 移除，数组空才 `activeSubs.delete(key)` + 调 head.sub.cancel 拆 bus 消费循环 | MUST 保留 head 的 bus 消费循环（去重不变，避免对同 group 多并行 bus.subscribe 消费者）；MUST NOT 在数组非空时 `activeSubs.delete(key)`（避免误清全局）；refcount=0 才拆；cancel 幂等 | `specs/tech/agent/event/[P0]event_hub.md §3.1` | +35/-12 |
| event_hub | `app/server/src/agent/event-hub.ts` | `ActiveSub` interface | 修改（语义） | 字段不变（`{sub, canceled}`），但语义从「单条记录」改为「数组元素之一」；注释明确 refcount 语义 | MUST NOT 改字段名（破坏现有 cancel 引用） | 同上 | +3/-1 |

## 后端 — SseChannel 多订阅 + 广播 + subId 注入（方案 B）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| sse_channel | `app/server/src/sse/sse-channel.ts` | `SubscriberProxy` interface | 新增 | `{ subId: string; topic: string; group: string; listener; cancel }`——单个订阅者代理对象；**不持 sink 引用**（方案 B 后端广播，无需 sink 归属） | MUST NOT 持 sink 引用（方案 B 关键：后端不维护 sink-subId 关联） | `specs/tech/app/frontend/[P0]sse_channel_multipub.md §2` | +6 |
| sse_channel | `app/server/src/sse/sse-channel.ts` | `SseChannel.subscribers` | 新增 | `Map<string, SubscriberProxy>`——全部活跃订阅者（key=subId） | MUST NOT 与 `subs` Map 混用（不同 key 维度） | 同上 | +1 |
| sse_channel | `app/server/src/sse/sse-channel.ts` | `SseChannel.groupSubs` | 新增 | `Map<string, Set<string>>`——每 (topic:group) 的订阅者集合 = refcount 来源 | MUST 由 refcount 控制何时拆 `subs[key]` 的 hub 订阅 | 同上 | +1 |
| sse_channel | `app/server/src/sse/sse-channel.ts` | `SseChannel.subscribe(topic, group, subId)` | 修改 | 签名加 `subId`（**不传 sink**——方案 B 后端广播）；新建 `SubscriberProxy` 入 `subscribers` + `groupSubs`；listener 闭包捕获 subId，bus emit 时调 `writeFrame({topic, group, data, timestamp, subId})` 广播所有 sinks；首 sub（`groupSubs[key]` 不存在或空）才 `hub.sub` 建 listener | MUST 首判 `subs.has(key)` 不变（去重）；MUST writeFrame 保持广播语义（不定向、不按 subId 写特定 sink）；MUST listener 内注入 subId 到帧体；MUST NOT 持 sink 引用；MUST 在首 sub 时触发 `subscribeHooks.onSubscribe` | `specs/tech/app/frontend/[P0]sse_channel_multipub.md §4` | +35/-12 |
| sse_channel | `app/server/src/sse/sse-channel.ts` | `SseChannel.unsubscribe(subId)` | 修改 | 签名改为接受 `subId`（不再接受 topic+group）；查 `subscribers` 拿 proxy → 拿 topic/group → 从 `subscribers` 删除 + `groupSubs[key]` Set 删除；Set 空（refcount=0）才 `hub.unsub(subs[key])` + `subs.delete(key)` + `groupSubs.delete(key)` + 触发 `subscribeHooks.onUnsubscribe` | MUST NOT 在 Set 非空时 `hub.unsub`（会拆掉其他订阅者的 bus 消费者）；MUST 幂等（subId 不存在 → no-op） | 同上 | +25/-8 |
| sse_channel | `app/server/src/sse/sse-channel.ts` | `SseChannel.writeFrame(frame)` | 修改（注释强化） | 实现保持广播语义（仍 `for (const sink of this.sinks) sink.push(serializeFrame(frame))`）；不再从 listener 闭包内遍历 `groupSubs`——bus fan-out 自然调每订阅者一 listener，每 listener 各调一次 writeFrame 带自己 subId 广播所有 sinks | MUST 保持广播语义（`for sink of sinks: sink.push`）；MUST NOT 改为定向投递（违反方案 B）；MUST 帧序列化时填 `subId` 字段（listener 闭包已注入） | 同上 | +3/-2 |
| sse_channel | `app/server/src/sse/sse-channel.ts` | `SseFrame` interface | 修改 | 加 `subId?: string` 字段（向后兼容） | MUST 可选字段（向后兼容旧帧） | 同上 | +1 |
| sse_channel | `app/server/src/sse/sse-channel.ts` | `SseChannel.isSessionActive(sid)` | 修改 | 实现改为 `groupSubs.get('session_panel:session_id:'+sid)?.size > 0`（原查 `subs.has`） | MUST 语义不变（仍反映「该 session 的 session_panel 有活跃订阅」）；MUST NOT 改调用方（仍是 session 层 SessionUnreadRuntime） | `specs/tech/app/frontend/[P0]sse_channel.md §5/§7` | +2/-1 |
| sse_channel | `app/server/src/sse/sse-channel.ts` | `SseChannel.destroy()` | 修改 | 遍历 `subscribers` 全部 unsubscribe + 清 `groupSubs`/`subs`/`subscribers`；保留原 sinks 关闭逻辑 | MUST 拆全部 hub 订阅 + 清全部 Map | 同上 | +5/-2 |
| sse_channel | `app/server/src/sse/sse-channel.ts` | `SseChannel.openConnection()` | 不动 | sink 创建逻辑保持原状（v0.0.88 不改：方案 B channel 不需要 sink 归属，openConnection 仅管 sink 生命周期） | MUST 保留 ReadableStream 单连接语义；MUST NOT 改为返回 sink 给 caller（方案 B 无需 sink 传递） | 同上 | +0/-0 |
| sse_handler | `app/server/src/handlers/sse.ts` | `SubscribeBody` interface | 修改 | 加 `subId?: string` 字段 | MUST 可选（向后兼容旧客户端） | `specs/api/version_logs/v0.0.88/change_log.md §2` | +1 |
| sse_handler | `app/server/src/handlers/sse.ts` | `UnsubscribeBody` interface | 新增 | `{ topic: string; group: string; subId?: string }`（与 SubscribeBody 同形但语义不同——subId 可选） | MUST 与 SubscribeBody 分开 interface（语义独立，便于未来分化） | 同上 | +3 |
| sse_handler | `app/server/src/handlers/sse.ts` | `parseSubscribeBody()` | 修改 | 校验 topic/group 不变；subId 不传时生成 ULID 兜底（向后兼容老 sharedSse 路径）；返回 body 含 subId | MUST 生成 ULID 而非随机串（与前端 ULID 一致格式）；MUST NOT 在 subId 缺失时拒 400 | 同上 | +6/-1 |
| sse_handler | `app/server/src/handlers/sse.ts` | `handleSseSubscribeOps()` | 修改 | `subscribe` 分支调 `channel.subscribe(topic, group, subId)`（**不传 sink**——方案 B 后端广播，channel 不需要 sink 归属）；`unsubscribe` 分支调 `channel.unsubscribe(subId)`（不传时 channel 内部取消该 group 全部）；新增 `DELETE /sse/subscriber/:subId` 路由分支（推荐路径） | MUST NOT 在 handler 层维护 sink-subscriber 关联（方案 B 后端不存这层状态）；MUST 在 request body 缺 subId 时用 parse 兜底的 ULID | 同上 | +12/-4 |

## 前端 — SseClient 单例 + subId 路由

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| sse_client | `app/web/src/lib/sse-client.ts` | `SseClient.handlers` | 修改 | `Map<HandlerKey, handler>` → `Map<string /* subId */, (frame: SseFrame) => void>` | MUST key 是 subId（一帧一调，零过滤）；MUST NOT 用 `Map<key, Set<handler>>`（subId 唯一路由，无需 Set） | `specs/tech/app/frontend/[P0]sse_client_singleton.md §3` | +1/-1 |
| sse_client | `app/web/src/lib/sse-client.ts` | `SseFrame` interface | 修改 | 加 `subId?: string` 字段（与后端帧一致） | MUST 可选（向后兼容） | 同上 | +1 |
| sse_client | `app/web/src/lib/sse-client.ts` | `SubscribeHandle` interface | 新增 | `{ subId: string; topic: string; group: string; unsubscribe: () => Promise<void> }`——unsubscribe 句柄；句柄自带 unsubscribe 方法方便 cleanup 直接调 | MUST 句柄不依赖 handler 引用相等；MUST unsubscribe 方法内部绑定 subId | 同上 | +5 |
| sse_client | `app/web/src/lib/sse-client.ts` | `SseClient.subscribe(topic, group, handler)` | 修改 | 签名改为返回 `Promise<SubscribeHandle>`；内部生成 `subId = ulid()`（**不暴露 subId 参数给 caller**）；`handlers.set(subId, handler)`；POST body 加 `subId`；POST 失败 → `handlers.delete(subId)` + throw | MUST 生成 ULID（前端内部生成，全 app 唯一）；MUST handler 先注册再 POST（POST 期间若后端推帧，前端 handlers 已有该 id，帧能路由）；MUST NOT 接受外部 subId 参数（统一内部生成） | `specs/tech/app/frontend/[P0]sse_client_singleton.md §3.1` | +18/-5 |
| sse_client | `app/web/src/lib/sse-client.ts` | `SseClient.unsubscribe(handle)` | 修改 | 签名改为接受 `SubscribeHandle \| string`；解析 subId；`handlers.delete(subId)`；调 `DELETE /sse/subscriber/:subId`（生产推荐路径）；best-effort（失败 catch） | MUST NOT throw 阻塞 cleanup；MUST 幂等（subId 不存在 → no-op） | 同上 | +10/-4 |
| sse_client | `app/web/src/lib/sse-client.ts` | `SseClient.connect()` onmessage 帧 dispatch | 修改 | 解析帧后 `handlers.get(frame.subId)?.(frame)`（按 subId 路由，零过滤） | MUST 帧无 subId → drop（单例只认 subId 帧）；MUST NOT 按 `${topic}:${group}` 路由（旧路径废弃） | 同上 | +3/-3 |
| sse_client | `app/web/src/lib/sse-client.ts` | `SseClient.destroy()` | 修改 | `controller.abort()` + `handlers.clear()`；不再为每个 handler 调 POST unsubscribe（app 卸载场景 TCP RST 兜底） | MUST 不阻塞 app 卸载 | 同上 | +2/-4 |
| sse_singleton | `app/web/src/lib/sse-singleton.ts` | `getSseClient()` | 新增 | 模块级 lazy 单例：首次调用 `new SseClient()` + `void connect()`；后续返回同一实例 | MUST NOT 用 React Context（StrictMode 双 mount 会双建）；MUST 模块级 lazy（与现有 `sharedSse` 模块级 `let` 风格一致） | `specs/tech/app/frontend/[P0]sse_client_singleton.md §4` | +12 |
| sse_singleton | `app/web/src/lib/sse-singleton.ts` | `_resetSseSingletonForTest()` | 新增 | 测试隔离：`singleton?.destroy(); singleton = null`；仅 `NODE_ENV=test` 调 | MUST 命名前缀 `_` 标测试专用；MUST NOT 在生产代码 import | 同上 | +4 |

## 前端 — 现有 SseClient 实例收敛 + 轮询消除

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| page_chat | `app/web/src/components/chat-page/page-chat.tsx` | `sharedSse`（模块级 `let`） | 删除 | 删模块级 `let sharedSse: SseClient \| null = null` 及其 `new+connect`/destroy 逻辑（约 line 38, 109-127） | MUST 改为 `import { getSseClient }`；MUST NOT 保留 `let sharedSse`（破坏单例语义） | `specs/tech/app/frontend/[P0]sse_client_singleton.md §5 R1` | -25 |
| page_chat | `app/web/src/components/chat-page/page-chat.tsx` | mount effect（session_meta 订阅） | 修改 | `getSseClient().subscribe('session_meta', '_all', handler)` 替换原 `sharedSse.subscribe(...)`；unmount 不 destroy（单例跨 page 复用）；保留 line 122 `refreshChildren(evt.data.parentSessionId)` 兜底链路（conversation-item 轮询消除后靠这条 session_meta `_all` 推送兜底刷新 subagent children） | MUST 句柄存 ref 用于 unmount unsubscribe；MUST NOT 在 unmount 调 `destroy()`；MUST 保留 refreshChildren 调用（conversation-item P3 依赖） | 同上 | +8/-15 |
| page_chat | `app/web/src/components/chat-page/page-chat.tsx` | `_resetSharedSseForTest()` | 删除 | 单例改 lazy 后该测试 hook 不再需要（由 `sse-singleton._resetSseSingletonForTest` 取代） | MUST NOT 保留旧 hook 名（避免歧义） | 同上 | -8 |
| page_chat | `app/web/src/components/chat-page/page-chat.tsx` | `useSessionRunState` 调用 | 修改 | `sseClient: sharedSse ?? undefined` 改为不传 sseClient（hook 内部 `getSseClient()` 取单例） | MUST 移除注入参数；MUST 保留 hook 兼容签名（coder 定是否保留 `sseClient?` deprecated 标记） | 同上 | +1/-2 |
| run_state | `app/web/src/components/chat-page/use-session-run-state.ts` | `useSessionRunState(sessionId, opts?)` | 修改 | 删 `ownSse` 分支（`const ownSse = !injectedSse; const sse = injectedSse ?? new SseClient(); if (ownSse) void sse.connect()`）；改为 `const sse = getSseClient()` 强制单例；opts.sseClient 参数 deprecated（保留签名兼容，忽略值） | MUST 强制单例（不传注入也走单例）；MUST NOT `new SseClient()`（破坏单例）；MUST cleanup 调 `sse.unsubscribe(handle)` 而非 `sse.unsubscribe(topic, group)`（句柄新签名） | `specs/tech/app/frontend/[P0]sse_client_singleton.md §5 R2` | +5/-12 |
| run_state | `app/web/src/components/chat-page/use-session-run-state.ts` | SSE subscribe 调用 | 修改 | `await sse.subscribe('agent_loop', agentGroup, handler)` 改为 `const h1 = await sse.subscribe(...)` 存句柄；同理 session_panel `h2`；cleanup 用 `h1`/`h2` unsubscribe | MUST 句柄存 effect scope ref；MUST NOT 在 cleanup `sse.destroy()`（连接 app 级，组件不碰） | 同上 | +6/-4 |
| run_state | `app/web/src/components/chat-page/use-session-run-state.ts` | 状态自愈（run_end 校正） | 新增 | 在 `applyAgentFrame` 的 `case 'run_end'` 分支后：若 `sessionRunningRef.current === true && sessionStateRef.current !== 'interrupting'`，调 `getSession(sessionId)` 校正 `sessionRunning/sessionState`（GET 为权威） | MUST GET 是权威源；MUST NOT 在 interrupting 态触发 GET（abort 收尾中，等待 session_status_update）；MUST best-effort（catch 不阻塞） | `specs/tech/app/frontend/[P0]sse_client_singleton.md §7`；`reqs/issues.md 漏洞B` | +18 |
| run_state | `app/web/src/components/chat-page/use-session-run-state.ts` | 状态自愈（session_status_update 强制 runActive=false） | 新增 | 在 `applyPanelFrame` 的 `case 'session_status_update'` 分支：state 进入 `idle/error/interrupted` 时，sliceRef 强制 `runActive=false, loadingPhase=null`（清 sticky run_start 孤儿） | MUST 强制清 runActive（清 sticky 孤儿影响）；MUST NOT 仅依赖 agent_loop 的 run_end（session 卡死时 run_end 不到达） | 同上；`reqs/issues.md 漏洞C` | +6 |
| squad_chat | `app/web/src/components/studio-page/section-squad-chat.tsx` | `setInterval(fetchOnce, 2000)` 轮询 | 删除 | 删 line 67 + line 75 setInterval + fetchOnce useCallback | MUST 删 2s 轮询（违反「进会话全靠订阅」原则）；MUST NOT 保留任何 setInterval 轮询 messages/usage | `specs/tech/app/frontend/[P0]sse_client_singleton.md §8 P1` | -20 |
| squad_chat | `app/web/src/components/studio-page/section-squad-chat.tsx` | 单例 subscribe（agent_loop + session_panel） | 新增 | mount 时 `getSseClient().subscribe('agent_loop', agentGroup, onAgent)` + `subscribe('session_panel', panelGroup, onPanel)`；onAgent 喂 message reducer；onPanel 喂 usage/workspace 事件；unmount unsubscribe 两句柄；保留初始 GET 一次拉 transcript 基线 | MUST 与 member 单聊同机制（同 group 命名）；MUST agentGroup = `session_id:<sid>_amt:current`，panelGroup = `session_id:<sid>`；MUST NOT 复用 squad 自有的 workspace-only session_panel 订阅（已有 spec 中 squad 只订 workspace event——coder 审视后定是否升级为全 session_panel 订阅） | `specs/tech/app/frontend/[P0]sse_client_singleton.md §5 R3` | +30 |
| conv_item | `app/web/src/components/chat-page/component-conversation-item.tsx` | `setInterval(onRefreshChildren, 1500)` + `setTimeout(stopPolling, 30000)`（line 115-116） | 删除 | 删 line 115 `pollRef.current = setInterval(...)` + line 116 `setTimeout(stopPolling, 30000)`；保留 line 113 expandOnce 主动刷一次（`onRefreshChildren(s.id)`）；后续 subagent 状态变化靠 session_meta `_all` 推送 | MUST 删 1.5s 轮询（违反「进会话全靠订阅」原则）；MUST NOT 删 line 113 expandOnce 主动刷；MUST 依赖 page-chat session_meta handler 的 `refreshChildren(evt.data.parentSessionId)` 兜底链路（line 122，已确认存在）；MUST 保留 stopPolling 函数定义（active 切换 cleanup 用，line 102-106 仍调） | `specs/tech/app/frontend/[P0]sse_client_singleton.md §8 P3` | -8 |
| conv_item | `app/web/src/components/chat-page/component-conversation-item.tsx` | `pollRef` cleanup（active 失焦分支） | 不动 | active 切换时 `stopPolling()` 逻辑保留（line 102-106 useEffect for [active]）；删 setInterval 后 pollRef 仅在 active 失焦时 clearInterval 兜底（已无 interval 可清，幂等无害） | MUST 保留 stopPolling 函数（active 失焦 cleanup 用）；MUST NOT 改 active effect 逻辑 | 同上 | +0/-0 |

## Spec 文档同步（doc-modifier 阶段 5 统一对齐）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| spec | `specs/tech/agent/session/[P0]session_event.md` | line 14（topic 声明） | 修改 | `session_panel（per-sid，replayable）` → `non-replayable[ v0.0.30]`（对齐 code bootstrap.ts:267） | MUST 与 code 一致；MUST 标注 [v0.0.30/0.0.88 修正] | research.md §Q5 spec/code 不一致 | +1/-1 |
| spec | `specs/tech/agent/session/[P0]session_event.md` | line 274（§3a.5） | 修改 | `session_panel ... replayable=true` → `replayable=false` + drift 修正注释 | 同上 | 同上 | +1/-1 |

## 验证（test-designer 阶段做，本表只列覆盖点）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| verify | `tests/api/sse_channel/<case>/checkpoint.json` | (case) | 新增 | AA/AB/AC/AD 四 case 见 api change_log §5（由 test-designer 创建实际 case 文件） | MUST 走 run_all 自动跑；MUST NOT 用 mock LLM | `specs/api/version_logs/v0.0.88/change_log.md §5` | 0 |

## 合计

- 新增文件：3（sse-singleton.ts / sse_channel_multipub.md / api change_log v0.0.88）
- 修改文件：9（event-hub.ts / sse-channel.ts / handlers/sse.ts / sse-client.ts / page-chat.tsx / use-session-run-state.ts / section-squad-chat.tsx / **component-conversation-item.tsx** / 04-agent-session.md）
- 删除符号：3（page-chat.tsx `sharedSse` + `_resetSharedSseForTest` + ownSse 分支）
- 影响行合计：约 +210 / -125

## 开放点（已拍板）

1. **`useSessionRunState` opts.sseClient 参数**：**直接删**（用户拍板：纯逻辑重构无数据迁移，不存在"废弃/过渡"，直接干掉兼容代码）。caller 不再传 sseClient，hook 内部强制 `getSseClient()` 单例。→ 见 T7。
2. **squad chat session_panel 订阅范围**：**升级为全 session_panel 订阅**（含 usage），与 member 单聊同机制（用户拍板：剥夺业务 SSE 逻辑，全局统一）。
3. **状态自愈触发时机**：**仅事件驱动**（run_end + session_status_update），v0.0.88 范围内不加可见性变化兜底。

> **原「开放点 sink 关联」已删除**：方案 B（后端广播）落地后 channel 不需要 sink 归属——writeFrame 广播所有 sinks，前端按 subId 过滤；handler 不需要把 sink 传给 channel.subscribe。

## T7：清除兼容历史逻辑（用户拍板：纯逻辑无数据迁移，全量更新，不存在废弃，直接删）

v0.0.88 是 SSE 通道/订阅协议的纯逻辑重构，无持久化数据迁移。全量更新后所有"向后兼容"代码一律删除——不留 @deprecated、不留过渡 shim、不留兼容分支。**"协议设计缺省"（保留，如 subId 缺省生成 ULID）≠ "兼容旧版"（删除）**。

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| run_state | `app/web/src/components/chat-page/use-session-run-state.ts` | `useSessionRunState` opts.sseClient 参数 | 删除 | 删 `opts.sseClient` 入参 + `injectedSse` 读取；hook 内部强制 `const sse = getSseClient()` | MUST 删参数（不保留 deprecated 签名）；MUST NOT 标 @deprecated | T4；开放点1 | +1/-3 |
| page_chat | `app/web/src/components/chat-page/page-chat.tsx` | `sseClient: getSharedSse() ?? undefined` 传参 | 删除 | useSessionRunState 调用不再传 sseClient | MUST 删传参 | 同上 | -1 |
| page_chat | `app/web/src/components/chat-page/use-page-chat-mount.ts` | `sharedSse` 模块级 `let` + `_resetSharedSseForTest` | 删除 | 整个 sharedSse 单例 + test hook 删除（被 sse-singleton 取代）；mount effect 改 `getSseClient().subscribe(...)` | MUST 删旧单例 + test hook；MUST NOT 保留兼容别名 | T3/T4 | -30 |
| sse_client | `app/web/src/lib/sse-client.ts` | `SseFrame.subId` | 必填 | subId 字段从可选改必填（不兼容旧无 subId 帧） | MUST 必填；无 subId 帧 drop（非兼容） | T2/T3 | +1/-1 |
| 全局 | 所有 v0.0.88 改动文件 | `@deprecated` 标记 / 向后兼容注释 / 兼容旧签名分支 / 兼容旧帧格式代码 | 扫除 | `grep -rn '@deprecated\|backward.compat\|legacy'` 在 v0.0.88 改动文件范围内清零 | MUST 清零；MUST NOT 保留任何兼容路径 | req.md | varies |

T7 依赖 T6（主体改完最后扫一遍），acceptance：grep 清零 + typecheck + test 通过。

> **原「开放点 3 sink 关联」已删除**：方案 B（后端广播）落地后 channel 不需要 sink 归属——writeFrame 广播所有 sinks，前端按 subId 过滤；handler 不需要把 sink 传给 channel.subscribe。

## 与 research.md 的对齐 / 冲突

- research.md §0 称「handlers 必须升级为 `Map<key, Set<handler>>`」——本架构改为 `Map<subId, handler>`（subId 路由替代 Set 兜底），更彻底。已在 `[P0]sse_client_singleton.md §9` 显式说明与 research.md 方案的差异。
- research.md §2 称「4 个 SseClient 实例」——代码核实实际 2 个创建点（`page-chat.tsx:110` sharedSse + `use-session-run-state.ts:231` ownSse）；studio unread 红点独立 SseClient 不存在。已在 `[P0]sse_client_singleton.md §5` 注脚说明。
- research.md 提及「conversation-item 1.5s 子树轮询」——v0.0.88 架构期重新核实代码确认存在（`component-conversation-item.tsx:115-116`），已补入轮询消除清单 P3 + 本计划书「conv_item」模块两行（setInterval/setTimeout 删除 + pollRef cleanup 保留）。
- 其余设计与 research.md 一致，无冲突。
