# 组件订阅/数据生命周期审计 + 基础类生命周期机制提案

- **调研范围**: web 组件的订阅(SSE/api/轮询/fs.watch)/数据生命周期的正确回收 + 基础类生命周期机制提案
- **调研对象**: `app/web/src/components/{chat-page,studio-page,connector-page,app-dev-config-page,framework}` + 相关 hooks + `app/server/src/agent/session-workspace-manager.ts`（fs.watch 后端侧）
- **调研日期**: 2026-07-08
- **版本**: v0.0.92.sse_opt

---

## §0 一句话结论

**当前生命周期管理成熟度 = 中等偏上**：SSE 订阅侧已通过 v0.0.88 单例 + subId 句柄 + `useEffect` cleanup 形成清晰契约（playground/单聊/群聊统一），最大的"未回收"风险**不在 SSE，而在 (a) 残留的独立 SseClient（`use-studio-unread-meta.ts`，违反单例规范）、(b) 全局 store 不随 unmount 释放（设计如此，但需要明确）、(c) 散落的 setInterval/tab 闭包定时器（cron-panel/budget-meter/connector/member-panel-memory）**。**用户提出的"base class 生命周期"思路在 React 中应以 **`useLifecycle` hook 抽象 + ESLint 强制 cleanup** 落地，不建议引入 OOP base class。

---

## §1 组件生命周期现状总表

> 列：组件/hook | 订阅了什么 | 创建时机 | 清理时机 | 绑生命周期? | 数据存哪 | 泄漏风险 | file:line

### 1.1 SSE 订阅（playground / studio 共享内核）

| 组件/hook | 订阅 | 创建 | 清理 | 绑生命周期? | 数据 | 泄漏风险 | file:line |
|---|---|---|---|---|---|---|---|
| `usePageChatMount` | `session_meta _all`（1 个 topic，app 生命周期级） | `PageChat` mount | unmount 句柄 unsubscribe（**不 destroy 单例**） | ✅ effect + 句柄 | store.sessions[] / childrenByParent | 无（单例跨 page 复用，句柄 ref 兜底 cancelled） | `app/web/src/components/chat-page/use-page-chat-mount.ts:56-108` |
| `useSessionSseSubscribe` | `agent_loop` + `session_panel`（每 sid 两个 topic） | sessionId 变化（含 mount） | sessionId 变化 / unmount → 句柄 unsubscribe | ✅ effect `[sessionId]` + 句柄 + cancelled flag | hook 内 ref + useState（局部） | 无（cleanup 兜底 + cancelled 拒收） | `app/web/src/components/chat-page/use-session-sse-subscribe.ts:69-194` |
| `useSessionRunState`（引擎壳） | 无（包 `useSessionSseSubscribe`） | — | — | — | sliceRef/ctxRef 等 ref + state | 同上 | `app/web/src/components/chat-page/use-session-run-state.ts:99-199` |
| `SquadChatPage`（群聊自己起 SSE） | `agent_loop` + `session_panel` | sessionId 变化 | unmount/切 sid → `subRef.current.forEach(unsubscribe)` | ✅ effect `[sessionId, fetchOnce]` | 局部 useState + sliceRef | 无（`subRef.current = []` 兜底） | `app/web/src/components/studio-page/section-squad-chat.tsx:128-194` |
| **`useStudioUnreadMeta`**（**违规**） | `session_meta _all` | `PageStudio` mount | unmount 句柄 unsubscribe + **`sse.destroy()`** | ✅ effect 但**独立 SseClient** | 局部 `unreadMap` | **违反单例 spec** + 跨 page 切换 destroy 单例会断其他订阅 | `app/web/src/components/studio-page/use-studio-unread-meta.ts:44-98` |

### 1.2 轮询（setInterval）—— 高风险区

| 组件/hook | 定时器 | 间隔 | 创建 | 清理 | 数据 | 泄漏风险 | file:line |
|---|---|---|---|---|---|---|---|
| `SectionCronPanel` | `setInterval(refetch, 60_000)` | 60s | mount / sessionId 变化 | ✅ `clearInterval(handle)` unmount/切 sid | 局部 jobs/usage | **无**（标准模式） | `app/web/src/components/chat-page/section-cron-panel.tsx:85-95` |
| `BudgetMeter` | `setInterval(reload, 30_000)` | 30s | mount / squadId 变化 | ✅ `clearInterval` unmount | 局部 usage | **无** | `app/web/src/components/studio-page/component-budget-meter.tsx:47-51` |
| `PageConnector` | `setInterval(refresh, 2000)` | 2s | mount | ✅ `clearInterval` unmount | 局部 state | **无**（但 2s 频率偏高，建议改 SSE） | `app/web/src/components/connector-page/page-connector.tsx:66-75` |
| `MemberPanelMemory` | `setTimeout(reload, 1500)` + `setTimeout(setFeedback, 2600)` | 一次性 | compact 后 | ❌ **未 clear** unmount 后仍触发 | 局部 summary/feedback | **低**（短一次性，setState on unmount 由 React 18 抑制，但语义不洁） | `app/web/src/components/studio-page/component-member-panel-memory.tsx:55,62` |
| `PageStudio` flash toast | `setTimeout(setToast(null), 2600)` | 一次性 | mutation 后 | ❌ 未 clear | 局部 toast | **低** | `app/web/src/components/studio-page/page-studio.tsx:63-66` |
| `ComponentBudgetMeter` toast | 同上 | 同上 | 同上 | ❌ 未 clear | 局部 | 低 | `app/web/src/components/studio-page/component-squad-board.tsx:93` |
| `ComponentRunFinish` copy 反馈 | `setTimeout(setCopied(false), 1500)` | 一次性 | 点击复制 | ❌ 未 clear | 局部 copied | 低 | `app/web/src/components/chat-page/component-run-finish.tsx:52` |
| `ComponentConversationItem` | `pollRef`（**v0.0.88 后已退化为空**，仅保留 active 失焦 cleanup） | — | — | useEffect `() => () => stopPolling()` | — | 无（残留 dead code） | `app/web/src/components/chat-page/component-conversation-item.tsx:101-108` |
| `ComponentMentionPopover` | debounce `setTimeout` | 120ms | input 输入 | ✅ **已有 cleanup**（`useEffect return () => clearTimeout(debounceRef.current)`，line 132-140）——**研究初稿误报「未 clear」，v0.0.92 W3 核实纠正** | 局部 | 无（cleanup 已存在） | `app/web/src/components/chat-page/component-mention-popover.tsx:85,134,156` |

### 1.3 API 数据（一次性 GET，无订阅）

| 组件/hook | 拉什么 | 时机 | 数据存哪 | unmount 后 | 泄漏风险 | file:line |
|---|---|---|---|---|---|---|
| `useMemoryCrud` | `listMemory(scope, sid)` | mount / sessionId 变化 / 写操作后 refetch | 局部 entries | cancelled flag 无；setState on unmounted 由 React 18 吞 | 低（无主动 cleanup，但 effect 只跑一次） | `app/web/src/components/chat-page/use-memory-crud.ts:43-93` |
| `MemberPanelMemory` | `getSummary` | mount / compact 后 | 局部 summary | 同上 | 低 | `app/web/src/components/studio-page/component-member-panel-memory.tsx:32-45` |
| `SectionWorkspacePanel` | `getWorkspaceTree` | mount / sid 变化 / dir_changed / refresh | useReducer `wsReducer` | ✅ cancelled flag 兜底 | 无 | `app/web/src/components/chat-page/section-workspace-panel.tsx:79-95` |
| `useSubagentChildren` | `listChildren` | mount / session_meta 推送 | **store.childrenByParent（全局）** | 不释放（设计如此） | **中**（顶层 sessions 删除时 store 不清对应 children，需手动） | `app/web/src/components/chat-page/use-subagent-children.ts:21-39` |
| `PageStudio` 挂载 | `listSquads + getSquad` | mount / sid 变化 | 局部 squads/detail | — | 无 | `app/web/src/components/studio-page/page-studio.tsx:77-99` |

### 1.4 fs.watch（server 端，与前端解耦）

| 触发器 | 创建 | 清理 | 与组件生命周期关系 | file:line |
|---|---|---|---|---|
| `SessionWorkspaceManager.startWatch` | client subscribe `session_panel` topic | client unsubscribe → refcount 1→0 → `stopWatch` | **完全由订阅数驱动**（lazy 0→1 / 1→0） | `app/server/src/bootstrap.ts:765-793` + `app/server/src/agent/session-workspace-manager.ts:115-168, 175-189` |
| `SquadFileWatcher`（squad 级） | squad 启动 | squad 销毁 / app shutdown | 与组件 mount 无关（squad runtime 持有） | `app/server/src/squad/filewatch/squad-file-watcher.ts` |

---

## §2 场景逐条审计

### 场景 1：playground 切会话（A → B）

**完整数据流追踪**（`openSession(sid)` 链路，`app/web/src/components/chat-page/page-chat.tsx:122-135`）：

```
用户点 conv-item-A → openSession('sess-A') →
  setActiveSession('sess-A') → store.activeSessionId = 'sess-A' →
    PageChat rerender → viewedSessionId = activeSubId ?? activeSessionId
    → useSessionRunState('sess-A', opts) 重跑：
      useLayoutEffect[sessionId]：reset() 同步清 messages/runActive/usage/summaryTask
      useSessionSseSubscribe[sessionId]：旧 effect cleanup（unsubscribe A 的 agent_loop + session_panel 句柄）
        → 新 effect 起：GET /messages?limit=50 + GET /session + GET /session/usage
        → 句柄 subscribe agent_loop session_id:sess-A_amt:current + session_panel session_id:sess-A
    → useModelRestore[activeSessionId]：useLayoutEffect setModel(null) 同帧清 + effect getSession 回填
  → markSessionRead('sess-A') fire-and-forget（清未读红点）
```

逐项清单（场景 1 结论）：

| 资源 | A → B 时清理? | 备注 | file:line |
|---|---|---|---|
| **SSE agent_loop 订阅** | ✅ 切 B 时 A 的 agent_loop 句柄 unsubscribe，B 的 subscribe 起 | 已被 `page-chat-switch-unsubscribe.test.tsx` 覆盖 | `use-session-sse-subscribe.ts:186-191` |
| **SSE session_panel 订阅** | ✅ 同上 | 同上 | 同上 |
| **messages** | ✅ `useLayoutEffect` reset() 同步清空 + GET B 拉 new baseline | useLayoutEffect 在 paint 前 | `use-session-run-state.ts:167-171` + `:143-159` |
| **runActive / loadingPhase / lastRunFinish** | ✅ reset 同步清 | 同上 | `use-session-run-state.ts:143-159` |
| **sessionRunning / sessionState** | ✅ reset 清 + GET B 兜底 | | 同上 |
| **usage / summaryTask** | ✅ reset 清 + GET 重拉 | | 同上 |
| **enqueueItems** | ✅ reset 清 | | 同上 |
| **isLoadingMore** | ✅ reset 清（v0.0.85.ui_opt F1 修，防卡滚底 effect） | | `use-session-run-state.ts:152-153` |
| **model 选择** | ✅ useLayoutEffect 同帧清 null + effect 异步回填 B 的 model | 竞态守卫 token + activeSessionIdRef | `use-model-restore.ts:50-99` |
| **subagent children**（顶层） | ⚠️ **不清**（设计如此）—— A 的 children 仍在 store.childrenByParent | 后续切回 A 不重拉；但删 A 后需手动清（未实现） | `use-subagent-children.ts` + `store/chat-slice.ts` |
| **workspace tree** | ✅ `SectionWorkspacePanel` 是独立组件，自身 `[sessionId]` effect 在切 sid 时 dispatch 'fresh' + cancelled flag + GET B | 与消息流解耦 | `section-workspace-panel.tsx:79-95` |
| **scroll 位置** | ❌ **不清**（DOM 节点保留，由 React 复用）—— 切 B 后 onScroll 仍可能触发 A 的 loadMore（但 hasMore 已 reset，不会真拉） | 低风险，行为可接受 | `use-message-scroll-pagination.ts` |

**结论场景 1**：SSE 订阅 + run 态 + model 都清理完整；**唯一遗留**：subagent children 全局 store 不随 parent session 删除而清（轻微内存增长，非泄漏链路）。

### 场景 2：右侧「文件」tab ↔ 「长期记忆」tab 切换

**用户问题：fs.watch 变了没？** —— **没有，且不应变**。

**完整数据流追踪**（`SectionWorkspacePanel` tab 切换）：

```
activeTab = 'workspace' → 'memory' (ComponentWsTabBar onClick)
  → useState setActiveTab('memory')
  → rerender：activeTab==='workspace' 分支不渲染（ComponentWsFileTree unmount）
              activeTab==='memory' 分支渲染（SectionMemoryPanel mount → useMemoryCrud mount GET）
```

| 资源 | tab 切换时变化 | 是否泄漏 | file:line |
|---|---|---|---|
| **fs.watch（chokidar）** | **完全不动**（lazy 由 `session_panel` 订阅数驱动，tab 切换不 subscribe/unsubscribe） | 无 | `bootstrap.ts:765-793` |
| **session_panel SSE 订阅** | 不动（订阅在 `useSessionSseSubscribe` 引擎层，与 tab 无关） | 无 | `use-session-sse-subscribe.ts` |
| **workspace tree state**（useReducer） | **不清**（dispatch 不重置，切回 'workspace' 仍是旧 tree，命中组件记忆） | 无（设计如此，stalePaths 仍正确） | `section-workspace-panel.tsx:61` |
| **ComponentWsFileTree** | unmount → DOM 释放，childrenCache/expanded 仍在 wsReducer state | 无 | 同上 |
| **SectionMemoryPanel entries** | mount → `useMemoryCrud` GET /memory/session?sid | 切回 memory tab 会重 GET（useMemoryCrud effect dep `refetch`，sid 不变也重跑） | `use-memory-crud.ts:61-63` |

**结论场景 2**：fs.watch 是 **session 级**而非 tab 级（设计如此），切 tab 不应改变 watcher。**轻微浪费**：每次切到 memory tab 都重拉一次（可加 cache，但 GET-once 模式与 memory 写后 refetch 语义一致，可接受）。

### 场景 3：playground ↔ studio 跨页切换

**完整数据流追踪**（`AppShell.renderView(view)`）：

```
user click NavRail 'studio' → useViewStore.setView('studio')
  → AppShell rerender → renderView('studio') 返回 <PageStudio />
  → <PageChat /> 条件渲染移除（不 mount）→ PageChat unmount
    → PageChat 内所有子组件 unmount：
      SectionConvPanel / SectionChatDetail / SectionWorkspacePanel / SectionMemoryPanel ...
    → PageChat 的 useEffect cleanup 跑：
      usePageChatMount cleanup：unsubscribe session_meta _all 句柄（不 destroy 单例）
      useSessionRunState -> useSessionSseSubscribe cleanup：unsubscribe agent_loop + session_panel 句柄
      useModelRestore cleanup：cancelled = true（防 async 回填）
    → store.sessions[] / activeSessionId / childrenByParent / lastWorkspaceEvent **保留**（设计如此）
```

| 资源 | playground → studio 时 | 备注 | file:line |
|---|---|---|---|
| **SseClient 单例连接** | ✅ **不动**（app 级生命周期，spec §1 S1/S3） | 切页不断连 | `lib/sse-singleton.ts:23-29` |
| **page-chat session_meta 订阅** | ✅ unsubscribe | `page-chat-sse-singleton-mount.test.tsx` 覆盖 | `use-page-chat-mount.ts:102-107` |
| **agent_loop + session_panel 订阅** | ✅ unsubscribe | | `use-session-sse-subscribe.ts:186-191` |
| **store.sessions / activeSessionId** | ❌ **不清**（设计如此——切回 playground 不重拉列表） | **设计正确**，跨页保留 | `store/chat-slice.ts` |
| **store.childrenByParent** | ❌ 不清 | 同上 | |
| **store.lastWorkspaceEvent** | ❌ 不清（最后一条事件保留，切回后 section-workspace-panel useEffect 会读一次但已处理过） | **轻微问题**：切回后可能重复 dispatch 一次 file-changed；幂等无碍 | `section-workspace-panel.tsx:188-205` |
| **studio 端 use-studio-unread-meta 独立 SseClient** | mount 时 new + connect + subscribe | **问题**：跨 studio↔playground 切换时 mount/unmount 反复建连/destroy；且违反单例 spec | `use-studio-unread-meta.ts:44-98` |
| **fs.watch（后端）** | 当 page-chat unsubscribe session_panel → 后端 refcount 1→0 → `stopWatch`；studio 切入时若无 chat 节点打开，watcher 不重启；若 chat 节点 subscribe 则 lazy 重启 | 符合 lazy 设计 | `bootstrap.ts:782-792` |

**结论场景 3**：跨页切 SSE 订阅清理完整；**最大问题**：`use-studio-unread-meta.ts` 自建独立 SseClient（详见 §6 gap-1）。

### 场景 4（补充）：浏览器 tab 切后台 / 网络断开重连 / abort

| 场景 | 行为 | 风险 | file:line |
|---|---|---|---|
| **浏览器 tab 后台**（visibilitychange） | **无任何处理**——SSE 长连接由浏览器保活，setInterval 继续跑（cron/budget/connector）| **轻微**：后台 tab 仍轮询 60s/30s/2s，浪费 token quota（budget meter 后台拉无意义） | 各 setInterval 处 |
| **网络断开重连** | `SseClient.connect()` 有 onError 回调（仅 use-studio-unread-meta 接了）；主单例无重连逻辑 | **中**：单例 spec §7 表"（可选）可见性变化 / SSE 重连后 GET 校正"未实现 | `sse-singleton.ts` + spec §7 |
| **abort 中断** | `runState.abort()` → POST /session/:id/abort fire-and-forget + sessionState 切 'interrupting'；后续 session_status_update 到达清 sticky run_start | 无（已有 D6/D7 自愈） | `use-session-run-state.ts:161-163` + `use-session-sse-subscribe.ts:90-111` |
| **关闭弹层（modal）** | modal 组件条件渲染移除 → unmount；`setState on unmounted` 由 React 18 抑制 | 无 | `ComponentClearConfirmModal` 等 |
| **关闭整个 Electron app** | 渲染进程销毁 → 模块级单例 GC → 后端 channel destroy → chokidar watcher `beforeExit` hook stopAll | 无 | `bootstrap.ts:798-803` |

---

## §3 fs.watch 审计

### 3.1 全部 watcher 创建/销毁点

| watcher | 位置 | 创建触发 | 销毁触发 | 与组件生命周期关系 |
|---|---|---|---|---|
| **SessionWorkspaceManager**（session 级 lazy） | `app/server/src/agent/session-workspace-manager.ts:115-168` | client subscribe `session_panel` topic → 0→1 → hook `await startWatch` | client unsubscribe → 1→0 → hook `await stopWatch` | **完全解耦**：组件 mount/unmount → SSE subscribe/unsubscribe → 后端 refcount → watcher 启停 |
| **SquadFileWatcher**（squad 级常驻） | `app/server/src/squad/filewatch/squad-file-watcher.ts` | squad runtime 启动 | squad runtime 销毁 / app shutdown | 与组件 mount 无关 |

### 3.2 已知 chokidar 坑现状

| 坑 | 现状 | file:line |
|---|---|---|
| **BUG-005**（await ready） | ✅ 已修：`waitForChokidarReady(watcher, 5000)` + 5s 超时兜底 | `session-workspace-manager.ts:21-31, 167` |
| **BUG-006**（addDir 显式 watcher.add） | ✅ 已修：`'all'` handler 内 addDir 分支 + 显式 `watcher.add(absDir)` 同步调用（chokidar 4.x add 返 FSWatcher，禁 `.catch`） | `session-workspace-manager.ts:251-260` + startWatch 内显式 listener |
| **macOS FSEvents 子目录不递归** | ✅ 已修：addDir 二次防御 + startWatch 内 listener | 同上 |

**结论 §3**：fs.watch 的所有已知问题已修复，且生命周期完全由后端 refcount 驱动，**前端组件无需也无法直接管理**。

---

## §4 api 数据回收审计

### 4.1 数据存储位置分类

| 存储位置 | 用途 | unmount 后是否释放 | 是否泄漏 |
|---|---|---|---|
| **组件 local state（useState）** | messages / usage / model / editor 等 | ✅ 组件卸载即销毁 | 无 |
| **组件 local reducer（useReducer）** | workspace tree / conv editor 等 | ✅ 同上 | 无 |
| **hook 内 ref（useRef）** | sliceRef / ctxRef / cancelled flag / 句柄 | ✅ 同上 | 无 |
| **store.sessions[]（全局 zustand）** | sessions 列表 + activeSessionId | ❌ **不释放** | **设计如此**（跨页保留避免重拉） |
| **store.childrenByParent**（全局） | subagent tree 缓存 | ❌ **不释放** | **轻微增长**（删 session 时未清对应 entry） |
| **store.lastWorkspaceEvent**（全局） | 最后一条 workspace 事件 | ❌ 不清（每次新事件覆盖） | 无（覆盖语义） |
| **localStorage（per session）** | wsCollapsed / wsWidth | ❌ 永久 | **设计如此**（用户偏好） |

### 4.2 轮询清单（含 cleanup 状态）

| 轮询点 | 间隔 | cleanup? | 必要性 | 建议 |
|---|---|---|---|---|
| `SectionCronPanel` | 60s | ✅ | 合理（cron nextFireAt 漂移显示，无 SSE） | 保留 |
| `BudgetMeter` | 30s | ✅ | **存疑**（已有 SSE session_usage_update，可改 SSE 推送） | 建议改 SSE |
| `PageConnector` | 2s | ✅ | **过密**（toggle 后感知 connecting→connected；PUT 后立即 refresh 已部分覆盖） | 改 SSE 或延长至 5s |
| `ComponentMentionPopover` debounce | 120ms | ✅（line 132-140 已有 cleanup，研究初稿误报） | 必要（防抖） | 无需改（W3 已核实纠正） |
| `MemberPanelMemory/PageStudio/Board toast` | 一次性 | ❌ | 必要（UX 反馈） | 加 unmount cleanup（低优） |

---

## §5 现有生命周期测试覆盖

| 测试文件 | 覆盖场景 | 漏了什么 |
|---|---|---|
| `chat-page/__tests__/page-chat-switch-unsubscribe.test.tsx` | 场景 1（A→B SSE unsubscribe + 切回重订阅 + markSessionRead + cleanup 失败兜底 + activeSubId 清空） | — 场景 1 完整覆盖 |
| `chat-page/__tests__/page-chat-sse-singleton-mount.test.tsx` | page-chat mount 用 getSseClient 单例 + unmount 不 destroy 单例 + refreshChildren 兜底链路 | — |
| `chat-page/__tests__/use-session-run-state.test.tsx` | 引擎 reset / 切 sid 行为 | 缺 store.childrenByParent 不清的断言 |
| `chat-page/__tests__/use-subagent-run-refresh.test.tsx` | subagent run-end transcript 补全 | 不涉及生命周期 |
| `chat-page/__tests__/use-subagent-children.test.tsx` | refreshChildren 调 listChildren | 缺 parent session 删除时 store 不清的断言 |

**场景覆盖矩阵**：

| 场景 | 有对应测试? | 缺测项 |
|---|---|---|
| 场景 1（playground 切会话） | ✅ `page-chat-switch-unsubscribe` | subagent children 全局 store 不清（无断言） |
| 场景 2（文件↔长期记忆 tab） | ❌ **无** | fs.watch 不动 / useMemoryCrud 重 GET |
| 场景 3（playground↔studio） | ❌ **无** | page-chat unmount 时所有订阅 cleanup / store 保留 / studio unread SseClient 反复建连 |
| 场景 4（abort / 后台 tab / 断网重连） | ❌ **无** | 后台 setInterval 继续跑 / 单例无重连 |

---

## §6 spec ↔ code gap 清单

| # | gap | spec 说 | code 实际 | 影响 | 建议 |
|---|---|---|---|---|---|
| **G1** | `use-studio-unread-meta.ts` 自建独立 SseClient + destroy | `[P0]sse_client_singleton.md §5 R3 注脚`："studio unread 红点独立 SseClient（D3）经代码核实**不存在**" | **存在**：`use-studio-unread-meta.ts:46 new SseClient()` + `:95 sse.destroy()` | 跨 page 切换时反复建连/断连；与单例 spec §1 S1 直接冲突；多 tab 场景下两 SseClient 互相踩 | 改用 `getSseClient()` 单例 + subId 区分 handler；删除注脚错误描述 |
| **G2** | `lastWorkspaceEvent` 切回 playground 时可能重复 dispatch | spec 未明确 | `section-workspace-panel.tsx:188-205` effect dep `[lastWorkspaceEvent, sessionId]`，旧值保留 | 切回后第一帧会重 dispatch 旧事件（幂等无碍但语义不洁） | unmount 时 store.clearLastWorkspaceEvent 或加 eventId 去重 |
| **G3** | store.childrenByParent 删 session 时不清 | spec 未提 | `chat-slice.ts` 无 deleteSession 路径清 children | 长期使用内存轻微增长 | deleteSession handler 加 `delete childrenByParent[sid]` |
| **G4** | 单例无重连机制 | spec §7 表："（可选）可见性变化 / SSE 重连后 GET 校正一次" | `sse-singleton.ts` 无 onError / 无 visibilitychange 监听 | 网络断开后 SSE 不自愈，需用户刷新 | 接 onError 指数回退重连 + visibilitychange GET 校正 |
| **G5** | `ComponentConversationItem` pollRef / stopPolling 残留 dead code | spec §8 P3 已说"已删" | 残留：`component-conversation-item.tsx:101-108` pollRef + stopPolling + unmount cleanup | dead code 维护负担 | 删除 |
| **G6** | ~~`ComponentMentionPopover` debounce 未在 unmount clear~~ **【研究误报，已纠正】** | spec 未提 | `component-mention-popover.tsx:132-140` **已有 `useEffect return () => { if (debounceRef.current) clearTimeout(debounceRef.current); }`** | 无（cleanup 已存在） | **无需修复**——v0.0.92 W3 architect + code-review 核实 line 132-140 已有 cleanup，研究初稿误报。研究文档已就地纠正（§1.2 表 + 本行） |
| **G7** | spec `[P0]component_architecture.md §3.8` 说"app 根 mount 不需要 explicit connect" | 同 | `sse-singleton.ts:25-27` 首次 getSseClient 内 `void singleton.connect()` | spec/code 一致，**非 gap**，仅记录 | — |

---

## §7 基础类生命周期机制提案

### 7.1 抽象形态选型（推荐：`useLifecycle` hook，**不**用 OOP base class）

**结论：用 hook 抽象，禁止引入 OOP base class。**

| 维度 | base class（OO） | `useLifecycle` hook（推荐） |
|---|---|---|
| 与现有 React 技术栈契合 | ❌ 项目全是函数组件，base class 需 HOC 包装或 class→function 桥接 | ✅ 原生契合 |
| 与现有 hook 复用模式（`useSessionRunState`/`useMemoryCrud`/`useModelRestore`）契合 | ❌ 需重写所有 hook | ✅ 直接 wrap/迁移 |
| TypeScript 类型推导 | ❌ 装饰器/mixin 类型复杂 | ✅ 泛型清晰 |
| StrictMode 双 mount 兼容 | ⚠️ class instance 双建问题 | ✅ hook天然幂等 |
| 心智负担 | ⚠️ class 继承 + lifecycle method | ✅ 单 hook，闭包明确 |

### 7.2 `useLifecycle` hook 接口设计

```typescript
// app/web/src/lib/use-lifecycle.ts （新建）
type LifecyclePhase = 'init' | 'destroy' | 'refresh';

interface LifecycleOptions<TData> {
  /** init: mount 时调（拉 api + 建订阅）；返回 ctx 传给 destroy/refresh */
  init: (ctx: { signal: AbortSignal; sid: string }) => Promise<TData> | TData;
  /** destroy: unmount 时调（清订阅 + 释放内存）；init 抛异常时也调（catch 兜底） */
  destroy?: (ctx: TData | null) => void;
  /** refresh: 仅轮询场景用——setInterval 内调（数据更新后重渲染） */
  refresh?: (ctx: TData | null) => Promise<void> | void;
  /** 可选：启用轮询（必须显式开启 + 写明理由；默认 undefined = 不轮询） */
  poll?: {
    intervalMs: number;
    /** 显式说明为什么必须轮询（写进代码注释 + dev 警告） */
    justification: string;
  };
  /** deps：变化时 destroy + 重 init（替代 useEffect dep） */
  deps: ReadonlyArray<unknown>;
}

function useLifecycle<TData>(opts: LifecycleOptions<TData>): {
  data: TData | null;
  loading: boolean;
  error: Error | null;
  /** 命令式刷新（手动触发 refresh） */
  reload: () => Promise<void>;
};
```

**关键不变量（MUST NOT 违反）**：

1. **`init` 必须接 AbortSignal**：所有 fetch/async 操作 `signal.aborted` 校验，杜绝 setState on unmounted。
2. **`destroy` 必须幂等**：可被多次调用（StrictMode 双 mount + React 18 concurrent）。
3. **`poll` 必须显式 + 写 justification**：违反触发 dev 警告 `console.warn('[lifecycle] polling enabled:', opts.poll.justification)`；PR review 强制检查。
4. **禁止在 `init` 内调 setState**（除返回的 ctx）—— state 由 hook 内部管。
5. **`destroy` 内禁 fetch**（仅清本地资源 + unsubscribe 句柄）；网络层 fire-and-forget 不阻塞 unmount。

### 7.3 现有组件/hook 迁移映射表

| 现 hook/组件 | 迁移目标 | init 内容 | destroy 内容 | poll? | 备注 |
|---|---|---|---|---|---|
| `useMemoryCrud` | `useLifecycle` | `listMemory(scope, sid)` | （无订阅）| 无 | 直接迁移；entries 改 hook 内部 state |
| `MemberPanelMemory` | `useLifecycle` | `getSummary(sid)` | （无） | 无 | 删 setTimeout reload（用 reload 命令式） |
| `SectionWorkspacePanel` | `useLifecycle` | `getWorkspaceTree(sid)` + 监听 `lastWorkspaceEvent` | unsubscribe store subscription（新增） | 无 | 当前 useEffect 改造 |
| `useSubagentChildren` | `useLifecycle` | `listChildren(parentSid)` 写 store | （无，store 保留是设计） | 无 | store 是全局，不归本 hook 清 |
| `BudgetMeter` | `useLifecycle` | `getBudgetUsage(squadId)` | clearInterval | **是（30s）**——justification: "budget 端点无 SSE 推送，需主动拉" | 优先改 SSE，次选保 poll |
| `SectionCronPanel` | `useLifecycle` | `listCronJobs(sid)` | clearInterval | **是（60s）**——justification: "cron nextFireAt 漂移显示需周期刷新，端点无 SSE" | 保留 |
| `PageConnector` | `useLifecycle` | `listConnectors()` | clearInterval | **是（2s，建议改 5s）**——justification: "PUT toggle 后感知 connecting→connected 迁移，无 SSE" | 建议改 SSE |
| `useSessionRunState` | **不迁**（已是引擎，且有自己的 SSE 订阅子 hook `useSessionSseSubscribe`） | — | — | — | 保持现状 |
| `usePageChatMount` | **不迁**（已符合 lifecycle 模式，迁无收益） | — | — | — | 保持现状 |
| `useModelRestore` | **不迁**（已有 useLayoutEffect + useEffect + token 守卫，迁反而退化） | — | — | — | 保持现状 |

### 7.4 禁忌与不变量（写进规范文档）

**禁止**：
- ❌ 禁止在 render 期间订阅（`useEffect` 外调 `subscribe`）。
- ❌ 禁止裸 `setInterval` 不在 `useLifecycle` / `useEffect` 内 clear。
- ❌ 禁止裸 `setTimeout` 不在 unmount cleanup clear（除 React 18 一次性 setState 由库抑制）。
- ❌ 禁止 `new SseClient()`（必须 `getSseClient()`）—— 违反 spec §1 S1。
- ❌ 禁止在 `init` 内 await 后直接 `setState`（必须校验 `signal.aborted`）。
- ❌ 禁止把"全局 store 不释放"当成"组件已清理"——store 释放是独立议题（见 G3）。

**推荐**：
- ✅ 全局 store 数据释放走 `deleteSession` / `deleteSquad` handler 显式清。
- ✅ 后台 tab 暂停轮询（visibilitychange listener in `useLifecycle`，dev/build 都开）。
- ✅ SSE 重连：在 `SseClient` 内接 onError 指数回退；visibilitychange 触发 GET 校正（spec §7 已记录为可选）。

### 7.5 与现有 SseClient singleton 的关系

**完全兼容、不动**：
- `useLifecycle` 的 init 内仍调 `getSseClient().subscribe(...)` 拿句柄。
- destroy 内调 `handle.unsubscribe()`（spec §1 S3：组件不碰连接）。
- SseClient 单例的连接生命周期归 app 级，与组件生命周期解耦——本提案不变更此契约。

### 7.6 落地路径（建议分两期）

**期 1（v0.0.92.sse_opt 配套）**：
1. 修 G1（use-studio-unread-meta 改用单例）—— **必做**，违反 spec。✅ 已落地
2. ~~修 G6（ComponentMentionPopover debounce cleanup）~~ **【研究误报，已纠正】**：line 132-140 已有 cleanup，W3 核实 no-op。
3. 删 G5（ComponentConversationItem pollRef dead code）。✅ 已落地
4. 创建 `lib/use-lifecycle.ts` + 迁移 hook——**实际扩为非引擎非轮询全迁 4 hook**（useMemoryCrud / MemberPanelMemory / SectionWorkspacePanel / useSubagentChildren），非原计划的 1-2 个试点。

**期 2（后续版本）**：
5. 迁移剩余可迁 hook（BudgetMeter / SectionCronPanel / PageConnector）。
6. 修 G4（SSE 重连机制）。
7. 加 visibilitychange 后台暂停轮询。
8. 补场景 2/3/4 测试。

---

## 附录 A：场景 1 完整数据流（备份）

详见 §2 场景 1（已完整追踪）。

## 附录 B：spec 引用清单

- `specs/tech/app/frontend/[P0]sse_client_singleton.md`（SSE 单例规范权威）
- `specs/tech/app/frontend/[P0]sse_channel.md`（后端 SSE 桥）
- `specs/tech/app/frontend/[P0]sse_channel_multipub.md`（多订阅 + subId 注入）
- `specs/tech/app/frontend/[P0]component_architecture.md §3.4-§3.8`（共享 run 态引擎 / SSE 单例）
- `specs/ui/components/_conventions.md`（组件约定）
- `specs/ui/components/chat-page/_overview.md`（playground 组件契约）
- `specs/ui/components/studio-page/{member-chat-page,squad-chat-page}.md`（studio 组件契约）
