# v0.0.348 change_log — 队员面板状态不实时修复（useStudioUnreadMeta 四层 hydration）

> 对应需求：`reqs/[done] v0.0.348.member-panel-state`；bug 分析见 `states/v0.0.348/`（BUG-member-panel-state-stale → [fixed]）。
> 权威契约：`specs/tech/version_logs/v0.0.348/change_plan.md`（决策①-⑧，frozen）。
> commits：`2d9b61d38`（T1 主体，review PASSED）。

## 变更摘要（已合并编码）

### 根因（P0）：仅 SSE 增量 → 订阅窗口丢帧永久错态

- 根因链（实证）：`useStudioUnreadMeta` 三张 map（unread/running/state）唯一写入源是 SSE `session_meta _all` 增量帧——**v0.0.165 删初始拉取**且无重连校正 → 订阅冷启动（订阅前已 running 的 session 无帧）/断连窗口（丢帧后无补偿）丢的帧**永远补不回** → 面板状态永久错态（左侧 squad 列表对、右侧面板错——老板实证）。

### 修复（方案 A：四层 hydration，老板拍板「视图级数据生命周期」）

| 层 | 机制 | 决策 |
|---|---|---|
| ① 订阅 | onInit **同步** subscribe（在前；禁 await——阻塞 onInit resolve → establishSubscriptions 滞后 → 丢帧窗口扩大） | ⑦ |
| ② 冷启动补水 | fire-and-forget `listSessionsByBiz('studio')`（GET /session?biz=studio）→ `mergeFromSessions` 纯函数（重建语义）经 mutate 写回 | ①③ |
| ③ 竞态仲裁 | ctx 内部第四张 `metaMap`（sid→updatedAt，不外露）：GET 在途新帧先到时，GET 响应后到**不回退**更新的帧；响应缺失但 ctx 有更新帧的 sid 保留（新建会话帧先到） | ④⑥ |
| ④ 重连校正 | `getSseClient().onResumed(() => hydrate())` 注册；退订句柄 onDestroy 回收（严于 use-squad-meta 先例，防 singleton 残留回调） | ⑧ |

## 实现核对（method 级）

| 计划项 | 实现一致性 |
|---|---|
| StudioMetaCtx.metaMap（第四张 map） | ✅ `KeyedMap<string,string>`（sid→updatedAt）；不外露到 StudioUnreadMeta 返回值 |
| mergeFromSessions 纯函数 | ✅ 重建语义 + updatedAt 仲裁（ctx 帧更新则四 map 全保留 ctx 值）；running 由 isRunningState 派生 |
| onInit | ✅ 同步 subscribe + `void hydrateRef.current()`（不 await）+ onResumed 注册 |
| hydrate() | ✅ `listSessionsByBiz('studio')` → mutate(mergeFromSessions)；失败 console.warn 静默（SSE 仍活，下次 onResumed 重试） |
| onEvent | ✅ 帧写三 map 同步写 metaMap（updatedAt 缺失跳 metaMap 写不跳三 map，防御） |
| onDestroy | ✅ 回收 onResumed 退订句柄（幂等） |
| listSessionsByBiz | ✅ `session-api.ts` 新增（GET /session?biz=xxx）；**listSessions 原签名零改动**（3 现有调用方不动）；barrel 透出经 `chat-api.ts export *`（trivial 偏离已记 task-board） |
| UT | ✅ 新增 4 例（三场景 + unmount 句柄回收）+ 3 既有测试 mock 适配；31/31 + 回归 973/973 + tsc -b 0 error |

## API 契约注记（零变化）

`listSessionsByBiz` 是**纯前端封装**；`GET /session?biz=` 为 server 既有路由参数（**biz 参数 v0.0.56 既有契约**，`specs/api/overall/04-agent-session.md §2.2` 已记载）——server 代码零改动，**API spec 无变化**（不新增 api/version_logs 条目）。

## 验证与遗留

- **ET**（e2e-test-executor2，panel-fix **small 不阻塞**）：核心判据① 刷新 running 补水 PASS + ③ 切 squad rebuild PASS；冒烟 2 条全过无回归。
- **遗留观察项（留 architect 评估）**：ET case② 断连重连 small——真实网络闪断 UT 已覆盖；**API-server-restart 极端变体**下 updatedAt 仲裁拒绝回退致 stale 保持、需 reload 收敛。hypothesis：重连补水不比较 updatedAt / server 重启 epoch。

## doc 同步记录（2026-08-14 doc-modifier2）

| 文档 | 同步内容 |
|---|---|
| `specs/ui/overall/06-studio.md` §3 | 数据行：stateMap 数据源 → 四层 hydration 描述 |
| `specs/ui/components/studio-page/component-seats-panel.md` | 「为什么需要」段补四层 hydration 注记（seat-card/seat-row 仅派生源指针不动） |
| `specs/tech/app/frontend/[P0]component_data_map.md` §2 | `useStudioUnreadMeta` 行：数据形/读 API/触发/契约同步 |
| `specs/tech/app/frontend/log.md` | v0.0.348 条目（2026-08-14） |
| `specs/prd/version_logs/v0.0.348-member-panel-state.md` | PRD 变更日志（根因/修复/验证/遗留） |
