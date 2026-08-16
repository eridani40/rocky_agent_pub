# Rocky 应用页面内存占用与常驻内容调研

> 日期：2026-08-15  
> 范围：app/web 前端主要页面（playground / studio / academy / settings / skill / connector / channel）  
> 方法：源码走查 + 运行时进程观察；未改代码、未实施优化。

---

## §1 调研方法

1. **源码走查**：重点读页面入口 `page-*.tsx`、`useLifecycle` 订阅/轮询/清理（`app/web/src/lib/use-lifecycle.ts`）、全局 store、SSE 单例、localStorage 持久化、图片资源加载。
2. **运行时观察**：`ps aux` 查看 Electron 主进程 / GPU / Renderer / Network Helper 的 RSS；确认 prod app 在跑且 Renderer RSS 约 270 MB 量级（仅作参考，未做 heap snapshot）。
3. **工具限制**：prod Electron app 未开启 `--remote-debugging-port`，本次没有抓取 heap snapshot；建议后续在 dev worktree 用 `scripts/run-dev.sh` + Chrome DevTools 做前后对比。
4. **不修改代码**：本次只做静态分析与观察，产出报告给 architect 出 change_plan 用。

---

## §2 各页面内存画像

| 页面 | 主要常驻内容 | 订阅/轮询/SSE | 切走后是否释放 | 风险 |
|---|---|---|---|---|
| **playground (PageChat)** | chat-slice: `sessions[]`、`childrenByParent`、`drafts`、`lastWorkspaceEvent`、`lastTodoEvent`；当前 session 的 messages（GET limit=50 + SSE 增量）、runCtx buffer、enqueueItems、pendingToolCall、workspace tree + childrenCache、preview tabs + drafts；per-session localStorage | `session_meta _all`（页面级）；`agent_loop` / `session_panel`（per session）；workspace watch-set | 页面级 SSE/timer **会释放**（页面 unmount），但全局 chat-slice **常驻** | 🔴 高 |
| **studio (PageStudio)** | squads 列表、`selectedSquadId`、`detail`、`mainView`；`aggregateMap`（squad_meta SSE）；unread/running/state 三张 map（session_meta _all，biz=studio）；chat 子路由激活时再挂 session 级 SSE | `squad_meta _all`、`session_meta _all`（biz=studio） | 页面级 SSE/timer 会释放；chat 子路由切回 seats 也会释放 session 级订阅 | 🟡 中 |
| **academy (PageAcademy)** | 教室列表；`detailsMap` 聚合所有教室详情；student detail、version content、academy sessions；运行中任务 5s 轮询 | 无 SSE；`useClassroomDetail` / `useStudentDetail` 在 active task 时 5s 轮询 | 页面级 timer **会释放**；`detailsMap` 随页面 unmount 释放 | 🟡 中 |
| **settings-app (PageAppSettingsMerged)** | `useAppSettingsConfig`：KV groups、drafts、snapshots；providers list + protocols cache；model-routing plans；各 tab 本地 state | provider 额度轮询 5min+30s tick（仅在 Providers tab 渲染时） | 页面 unmount 释放；Providers tab 切走也会释放轮询 | 🟡 中 |
| **skill (PageSkill)** | 已安装 skills 列表；market search query/items/detail modal state | market 挂载时 `getMarketCapabilities`；搜索 400ms 防抖 timer | manage tab 常驻；market tab 切走 unmount，timer 清理 | 🟢 低 |
| **connector (PageConnector)** | connector 列表 + form 状态 | 5s 轮询 `listConnectors` | 页面 unmount **释放** | 🟡 中低 |
| **channel (PageChannel)** | channel config 列表 + form 状态 + implTypes | 5s 轮询 `listChannels` | 页面 unmount **释放** | 🟡 中低 |
| **home/session list** | 已含在 playground 左侧 `SectionConvPanel`；`sessions[]` 全量常驻 | 同 playground | 同 playground | 🔴 高 |
| **nav-rail / AppShell** | bootstrap status 一次性；migration error modal state；currentView | 无订阅 | 常驻但 minimal | 🟢 低 |

> 注：AppShell 的 `renderView` 在 `switch (currentView)` 里返回不同页面组件（`app/web/src/components/framework/app-shell/app-shell.tsx:102-130`）。React 同一位置元素类型变化会触发旧页面 **unmount**，因此 `useLifecycle` 的 cleanup（`stopTimer` + `unsubscribeAll`，`use-lifecycle.ts:283-288`）会正常执行。

---

## §3 关键发现

1. **页面级订阅/轮询切页会释放，但全局 store 常驻**。`useLifecycle` 在组件 `useEffect` cleanup 中取消 SSE 订阅、停 timer（`use-lifecycle.ts:283-288`）。`AppShell` 切视图触发旧页面 unmount，因此 playground/studio/academy/connector/channel 的页面级 SSE/timer 都会释放。但 `chat-slice`（`app/web/src/store/chat-slice.ts:71-104`）的 `sessions[]`、`childrenByParent`、`drafts`、`lastWorkspaceEvent`、`lastTodoEvent` 以及 `academy-slice` 路由态等全局 store 数据保留。

2. **chat-slice 是前端最大的常驻内存源**：
   - `sessions[]`：全量会话列表，每条含 title、state、unread、updatedAt、biz、derivation 等字段。
   - `childrenByParent`：每展开一个 parent 会话，缓存其 subagent children 视图（`app/web/src/components/chat-page/use-subagent-children.ts`）。
   - `drafts`：`sessionId → 输入区草稿` 映射，理论上无限增长。
   - 这些状态不随切页清空，随使用时间线性累积。

3. **Academy 详情聚合 `detailsMap` 在页面激活时全量累积**。`page-academy.tsx:49-61` 在拿到教室列表后，对每个 classroom 调用 `getClassroomDetail` 并写入 `detailsMap`。切走 academy 页面后随 unmount 释放，但长驻 academy 页面时内存占用会随教室数量增长。

4. **chat-debug-log.ts 是明确的 prod 环境内存/日志污染源**。该文件模块级状态 `seq`、`netSeq`、`burst`、`burstTimer`、`initAt` 不随页面/会话 unmount 清理（`app/web/src/lib/chat-debug-log.ts:33-36`），且 `CHAT_DEBUG = true` 在 prod 持续输出 `[CHAT-DEBUG]` console.log。文件注释已声明「排查完本文件连同各打点整体删除」。

5. **SSE singleton 连接全局长期存活，但 handlers 可正常清理**。`getSseClient()`（`sse-singleton.ts:39-60`）创建一条长连接；`useLifecycle` unmount 时调用 subscribe 返回句柄的 `unsubscribe`，理论上会从 handlers Map 移除。未发现 handlers 泄漏的直接证据，但建议加监控。

6. **未发现典型资源泄漏**：全仓库搜索无 `URL.createObjectURL` / `URL.revokeObjectURL`；图片使用标准 `<img src>`，由浏览器缓存管理。`useWorkspaceWatch` 在 cleanup 时调用 `unwatchWorkspaceDir`（`use-workspace-watch.ts:34-41`），符合成对释放。

7. **运行时 RSS 参考**：prod Electron Renderer 约 270 MB RSS，主进程约 424 MB RSS。此数值包含 Chromium/V8/Electron 运行时、JS heap、render surfaces、GPU textures 等，不能单独归因于前端业务代码；需 heap snapshot 才能定量。

---

## §4 优化建议（按优先级）

### P0 · 立即做

| # | 优化项 | 理由 | 影响面 | 建议 owner |
|---|---|---|---|---|
| 1 | **关闭/删除 `chat-debug-log.ts`** | prod 持续输出日志且模块级状态累积；文件注释已声明临时 | 内存/日志干净度 | coder |
| 2 | **确认 `CHAT_DEBUG` 不进入 prod** | 当前硬编码为 `true`，应改为环境变量或 `false` | 零功能影响 | coder |

### P1 · 近期做

| # | 优化项 | 理由 | 影响面 | 建议 owner |
|---|---|---|---|---|
| 3 | **chat-slice `childrenByParent` 清理策略** | 展开过的 parent children 永久累积；可 LRU 或切页后清理非 active 的 children | 全局 store 内存 | architect |
| 4 | **chat-slice `drafts` 数量/老化策略** | `sessionId → 草稿` 无限增长；可按最近访问时间清理 | 全局 store 内存 | architect |
| 5 | **Academy `detailsMap` 按需加载/老化** | 当前一次性拉所有 classroom detail；可改为仅当前选中/可见教室 + LRU | 页面内存 | architect |
| 6 | **playground 重复 mount 避免全量重拉** | 切回 playground 时若 `sessions` 已存在，可先渲染 store 数据，后台 diff 刷新 | 减少重复请求与瞬时内存 | architect |
| 7 | **usePageChatMount `refreshChildren` 按需触发** | mount 时对每个 parent 拉 children；可改为展开时拉 | 减少初始请求量 | coder |

### P2 · 验证后做

| # | 优化项 | 理由 | 影响面 | 建议 owner |
|---|---|---|---|---|
| 8 | **dev worktree 抓取 heap snapshot** | 用 `--remote-debugging-port=9222` 对比切页前后 detached / array / closure 数量 | 拿到定量数据 | researcher / e2e-test-executor |
| 9 | **SSE handlers 数量监控/断言** | 在 dev 环境加 handlers size 上限断言，防止未来泄漏 | 防御性 | architect |
| 10 | **全局 store 状态 reset 机制** | 长会话使用后可提供切页后清理非必要数据的能力 | 需避免 UX 退化 | architect |

### P3 · 留意

| # | 优化项 | 理由 | 影响面 | 建议 owner |
|---|---|---|---|---|
| 11 | **localStorage per-session key 膨胀** | 大量 session 会生成大量 `ws-*` / `pv-*` key；可考虑 IndexedDB 或定期清理 | disk 占用 | coder |
| 12 | **图片/文件预览缓存** | 大量图片会话可能占 Image decode cache；必要时 lazy unload | 视觉/内存平衡 | architect |

---

## §5 结论

当前 Rocky 前端最显著的内存风险不是“切页后页面仍在后台跑轮询/SSE”——`AppShell` 的 switch 视图会触发旧页面 unmount，`useLifecycle` 会正常清理订阅与轮询。真正的问题在于：

1. **全局 `chat-slice` store 随使用时间线性累积**：`sessions[]`、`childrenByParent`、`drafts` 不随切页清空。
2. **Academy 页面在激活期间全量聚合 `detailsMap`**：教室数量多时会占用较大页面内存。
3. **`chat-debug-log.ts` 作为临时调试文件仍在 prod 输出日志并持有模块级状态**，应尽快删除或关闭开关。
4. **页面重新 mount 时会重复拉取数据**：虽未泄漏，但造成不必要的网络与瞬时内存开销。

建议优先删除/关闭 `chat-debug-log.ts`，然后对 `chat-slice` 的 `childrenByParent` 和 `drafts`、以及 Academy 的 `detailsMap` 引入按需加载/老化策略，并在 dev worktree 用 heap snapshot 做定量验证。
