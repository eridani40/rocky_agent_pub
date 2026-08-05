# v0.0.139 变更计划书 — workspace watcher 懒监听重构（展开才监听 + tab 显式控制）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 权威模型：`specs/tech/agent/session/[P0]session_workspace_manager.md`（v0.0.139 重写）；API 契约：`specs/api/overall/04-agent-session.md §2.6.5`；前端接线：`specs/ui/components/chat-page/component-workspace-panel.md §4.3`；用户六裁决红线：`reqs/[working] v0.0.139.lazy-workspace-watch/req.md`。
>
> **核心不变量（MUST NOT 违反）**：① 监听单元 = 单目录一层（chokidar `depth:0` 非递归）② watch/unwatch 幂等（增量非声明式）③ GET tree 绝不隐式 watch ④ 同 (sid,absDir) create/close 串行化防重入 ⑤ tab 消失两层回收无泄漏 ⑥ 只动 watcher（不动观测护栏/子进程隔离/squad-file-watcher/切目录字段流程）。

## 变更清单

### 模块 1：manager 核心重写（backend / app/server/src/agent/）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| manager | app/server/src/agent/session-workspace-manager.ts | `SessionWorkspaceManager`（class） | 修改 | 重写为懒监听编排器：持 registry（tab 列表+refcount）+ dirWatchers（每 absDir 一个非递归 watcher）+ per-absDir close 串行队列；注入 statusBus + change-emitter | MUST 委托 registry 记账、dir-watcher 建/关 watcher；MUST NOT 自己直接持递归 watcher | manager §1/§3 | +40/-120 |
| manager | app/server/src/agent/session-workspace-manager.ts | `watch(sid, clientId, relDir)` | 新增 | resolve absDir+白名单校验（在 workspaceDir 内）；registry.addTabDir 幂等（Set）；首引用→openDirWatcher(await ready)+refcount=1，已有→refcount++ | MUST 幂等（重复不叠加 refcount）；MUST 走串行段改 refcount；不存在/非目录静默忽略不报错 | manager §3/§5；红线②；api §2.6.5 | +45 |
| manager | app/server/src/agent/session-workspace-manager.ts | `unwatch(sid, clientId, relDir)` | 新增 | registry.removeTabDir（未持有 no-op）；refcount--；归零→串行 closeDirWatcher | MUST 幂等 no-op；MUST 串行 close（防重入） | manager §3/§7；红线②④ | +30 |
| manager | app/server/src/agent/session-workspace-manager.ts | `releaseTab(sid, clientId)` | 新增 | 取该 tab 目录集，逐个 refcount--，归零者串行 close；删 tab 列表 | MUST 幂等（无列表 no-op） | manager §3/§6①；红线⑤ | +22 |
| manager | app/server/src/agent/session-workspace-manager.ts | `recycleSession(sid)` | 新增 | 遍历该 sid 所有 clientId → releaseTab；确保物理 watcher 全 close + 清 emitter debounce | MUST 幂等；MUST 无监听主体存活后 getStatus 为空（无泄漏 invariant） | manager §3/§6②；红线⑤ | +20 |
| manager | app/server/src/agent/session-workspace-manager.ts | `switchDir(sid, newDir, setDirCb)` | 修改 | 改为 `recycleSession(sid)` → `setDirCb`（不再 stopWatch→set→startWatch）；不重启 watch（前端重新 watch 新根） | MUST 顺序 recycle→set；MUST NOT startWatch 新目录；签名不变（call site 零改） | manager §9；session_workspace §4；红线⑥ | +8/-14 |
| manager | app/server/src/agent/session-workspace-manager.ts | `stopAll()` | 修改 | close 全部 dirWatchers + 清 registry（tab 列表+refcount）+ 清所有 emitter timer | MUST 串行 close | manager §3/§10 | +6/-8 |
| manager | app/server/src/agent/session-workspace-manager.ts | `getStatus()` | 修改 | 返 `WatcherStatus[]`（sessionId/absDir/ready/refcount）——诊断+无泄漏断言点 | 纯读，无副作用 | manager §3 | +4/-6 |
| manager | app/server/src/agent/session-workspace-manager.ts | `startWatch` / `stopWatch` / `WatchEntry` | 删除 | 递归模型 API 删除（被 watch/unwatch/releaseTab/recycleSession + DirWatchEntry 取代） | MUST 无残留调用（grep 归零） | delete-old-code-fully memory | -60 |
| manager | app/server/src/agent/workspace-watch-registry.ts | `WorkspaceWatchRegistry`（class + 方法） | 新增 | 纯内存记账：`tabDirs: Map<tabKey,Set<absDir>>` + `dirRefcount: Map<sid,Map<absDir,number>>`；addTabDir/removeTabDir/takeTabDirs/takeSessionTabs/refInc→bool(是否首引用)/refDec→bool(是否归零)；tabKey=`${sid}:${clientId}` | MUST 无 chokidar/IO 依赖（可 UT 直测）；MUST 记账与物理 watcher 解耦 | manager §3 拆分注；红线④ | +110（新文件） |
| manager | app/server/src/agent/workspace-dir-watcher.ts | `openDirWatcher(opts)` / `closeDirWatcher(h)` / `DirWatcher` | 新增 | chokidar 单目录 watcher 工厂：`watch(absDir,{depth:0,ignoreInitial:true,ignored,persistent})` + 挂 'all'→onFsEvent(sid,absDir,eventName,absPath) + 'error'→回调 + await waitForChokidarReady；close 幂等 | MUST depth:0 非递归；MUST NOT 注册 addDir→watcher.add（禁自动递归）；close 幂等 | manager §2/§3.1/§4；红线① | +120（新文件） |
| manager | app/server/src/agent/workspace-dir-watcher.ts | `WATCH_OPTIONS` / `IGNORED_DIR_NAMES` | 新增 | 从 manager 迁入 + 加 `depth:0`；ignored 保留函数匹配目录段（降级为噪声过滤） | MUST 含 `depth:0`；ignored MUST 函数匹配（chokidar v4 无 glob） | manager §4；hotfix 1ef2d61c | +10 |
| manager | app/server/src/agent/workspace-dir-watcher.ts | `waitForChokidarReady` / `mapKind` | 新增 | 从旧 manager 迁入（逻辑不变）；导出供 UT 直测 | 超时 resolve 不抛（不阻塞）；mapKind 仅 5 类 | manager §3.1/§8 | +26 |
| manager | app/server/src/agent/workspace-change-emitter.ts | `WorkspaceChangeEmitter`（class） | 新增 | per-session 100ms debounce 聚合 + emit `session_workspace_file_changed` 到 `session_id:<sid>`；relPath=relative(workspaceDir,absPath) 跨平台归一 '/'；push/flush/clear(sid) | MUST 每 relPath+kind 一条（不合并总 event）；MUST 用注入 statusBus | manager §8；session_event §2 | +90（新文件） |

### 模块 2：bootstrap 钩子接线（backend）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bootstrap | app/server/src/bootstrap.ts | `sseChannel.setSubscribeHooks({onSubscribe})` | 修改 | `onSubscribe(session_panel, group)` **删除 startWatch 调用**（懒监听下 subscribe 不再隐式建监听；watch 全由前端显式 API 驱动）；可退化为 no-op 或仅日志 | MUST NOT 在 subscribe 建任何 watcher（红线③精神：非显式不 watch） | manager §6/§11；红线① | +2/-12 |
| bootstrap | app/server/src/bootstrap.ts | `sseChannel.setSubscribeHooks({onUnsubscribe})` | 修改 | `onUnsubscribe(session_panel, group)`（1→0）从 stopWatch 改为 `await workspaceManager.recycleSession(sid)`（主人死亡兜底清算） | MUST 走既有 SESSION_PANEL_TOPIC 守卫 + extractSessionIdFromGroup；异常 try/catch 不影响退订 | manager §6②；红线②⑤；bootstrap.ts:937 | +3/-3 |

### 模块 3：API handlers + 路由（backend / app/server/src/handlers/ + router.ts）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| api-handlers | app/server/src/handlers/session-workspace.ts | `handleWorkspaceWatch(req, method, id, deps)` | 新增 | POST-only；解析 `{clientId, path}`；getSession(404)；whitelistResolve(path→absDir，穿越 400)；`deps.workspaceManager.watch(id, clientId, relDir)`；200 `{ok:true}` | MUST 复用既有 whitelistResolve 校验；缺 clientId→400；目标不存在→静默 200（非 400） | api §2.6.5；红线② | +45 |
| api-handlers | app/server/src/handlers/session-workspace.ts | `handleWorkspaceUnwatch(req, method, id, deps)` | 新增 | POST-only；解析 `{clientId, path?}`；path 省略→`releaseTab(id,clientId)`，有 path→`unwatch(id,clientId,relDir)`；200 | MUST path 省略=release-all；幂等 no-op 也 200 | api §2.6.5；红线②⑤ | +38 |
| api-handlers | app/server/src/handlers/session-workspace.ts | `handleWorkspaceTree`（GET） | 修改 | **仅确认无隐式 watch**（当前实现已无 startWatch）——不新增任何 watch 调用 | MUST NOT 在 tree handler 触发 watch（红线③） | api §2.6.1；红线③ | +0 |
| api-handlers | app/server/src/handlers/session.ts | DELETE handler（`deps.workspaceManager.stopWatch(id)`） | 修改 | `stopWatch(id)` → `recycleSession(id)`（懒监听回收全部 tab 监听，幂等） | 保持 `if (deps.workspaceManager)` 守卫 | api §2.4；session.ts:228 | +1/-1 |
| api-handlers | app/server/src/handlers/session-update.ts | switchDir call site | 修改 | 无需改调用（switchDir 签名不变）；仅更新注释 stop→set→start → recycle→set | 签名/参数不变，仅注释同步 | api §2.5；session-update.ts:108-116 | +2/-2 |
| api-handlers | app/server/src/router.ts | workspace 路由 regex + dispatch | 修改 | regex `(tree\|open\|pick-directory)` → 加 `watch\|unwatch`；dispatch 加 `workspace_watch`→handleWorkspaceWatch / `workspace_unwatch`→handleWorkspaceUnwatch | MUST 复用既有 sessionMatch.sub 分流模式 | router.ts:184/429-438 | +8 |

### 模块 4：前端接线（app/web / 展开=watch、收起=unwatch、卸载=release-all）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-workspace | app/web/src/lib/chat-api.ts | `watchWorkspaceDir(sid, {clientId, path}, base?)` | 新增 | `POST /session/:id/workspace/watch`；返 `{ok:true}` | 对齐既有 openWorkspaceItem 风格 | api §2.6.5；chat-api.ts:332 | +14 |
| ui-workspace | app/web/src/lib/chat-api.ts | `unwatchWorkspaceDir(sid, {clientId, path?}, base?)` | 新增 | `POST /session/:id/workspace/unwatch`；path 省略=release-all | best-effort（失败 catch 不阻塞） | api §2.6.5 | +14 |
| ui-workspace | app/web/src/components/chat-page/section-workspace-panel.tsx | `clientId`（useRef ULID） | 新增 | 每 ws-panel 实例生成一个稳定 clientId（跨展开/收起/切 session 稳定，标识 tab） | MUST 稳定不随 render 变（useRef 初始化一次） | manager §5；红线①⑤ | +3 |
| ui-workspace | app/web/src/components/chat-page/section-workspace-panel.tsx | 根 watch / release-all effect | 新增 | `useEffect([sessionId])`：run 时 `watchWorkspaceDir(sid,{clientId,path:''})`（根一层）；cleanup（切 session/卸载）`unwatchWorkspaceDir(oldSid,{clientId})`（release-all） | MUST cleanup 捕获旧 sessionId release-all；best-effort | manager §11；红线①⑤ | +14 |
| ui-workspace | app/web/src/components/chat-page/section-workspace-panel.tsx | `handleExpand` | 修改 | 展开成功路径追加 `watchWorkspaceDir(sid,{clientId,path})`（与既有 GET tree 并行；GET 只取数据不 watch） | MUST NOT 让 GET tree 隐式 watch（红线③）；幂等靠后端 | manager §11；红线①③；section-workspace-panel.tsx:114 | +5 |
| ui-workspace | app/web/src/components/chat-page/section-workspace-panel.tsx | `handleCollapse` | 修改 | 收起追加 `unwatchWorkspaceDir(sid,{clientId,path})`（release 该目录） | best-effort | manager §11；红线①；:130 | +5 |

### 模块 5：测试适配（UT — 冒烟集纪律，不新增 AT/ET 持久 case）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test | app/server/src/agent/__tests__/workspace-watch-registry.test.ts | registry UT | 新增 | 记账层直测：幂等 add、refcount 合并/归零、takeTab/takeSession；纯内存无 chokidar | 覆盖红线②⑤ 记账正确性 | manager §5 | +130（新） |
| test | app/server/src/agent/__tests__/session-workspace-manager-*.test.ts | manager UT×3 | 修改 | 适配新 API（watch/unwatch/releaseTab/recycleSession/switchDir）；补：幂等、多 tab refcount、两层回收无泄漏（getStatus 空）、快速 watch→unwatch→watch 同目录不崩（串行化）、depth:0 非递归（含大子目录不扫描） | MUST 覆盖不变量①②④⑤；delete 旧 startWatch/stopWatch 断言 | manager §5/§6/§7；bottom-up-layer-verify memory | +90/-70 |
| test | app/server/src/handlers/__tests__/session-workspace.test.ts | handler UT | 修改 | 加 watch/unwatch handler：200/404/400 穿越/缺 clientId/release-all/幂等 no-op | 断言基于 api §2.6.5 契约 | api §2.6.5 | +60 |
| test | app/web/src/components/chat-page/__tests__/（workspace 相关） | 前端 UT | 修改 | 适配 clientId + 展开 watch/收起 unwatch/卸载 release-all 调用（mock chat-api）；断言 GET tree 不触发 watch | vi.mock 绝对路径（test-vitest-mock-absolute-path memory） | 红线①③ | +40 |

## 影响面评估

- **跨模块**：backend manager 核心（4 文件：1 重写 + 3 新建）+ bootstrap 钩子 + 3 handler/router + frontend 2 文件 + 5 测试文件。
- **破坏性**：`SessionWorkspaceManager` 公开 API 换代（`startWatch/stopWatch`→`watch/unwatch/releaseTab/recycleSession`）——调用方全在本仓（bootstrap/session.ts/session-update.ts + 测试），无外部消费者。`switchDir` 签名不变（call site 零改）。新增 2 个 HTTP 端点（纯加法，不破既有 tree/open/pick）。
- **依赖顺序**：registry（纯记账，可独立先做+UT）→ dir-watcher（chokidar 封装）→ change-emitter → manager 编排（依赖前三）→ bootstrap 钩子 + handlers/router（依赖 manager 新 API）→ frontend 接线（依赖新端点）→ 测试适配。建议 task 切分：T1 manager 核心 4 文件（registry/dir-watcher/emitter/manager）+ 其 UT；T2 bootstrap 钩子 + handlers + router + handler UT；T3 frontend 接线 + 前端 UT。
- **风险点**：① Bun FSEvents close 段错误——串行化 close + close 幂等是硬约束，UT 必测快速连点（context findings 崩溃面）。② depth:0 语义——UT 须验「监听含大子目录的目录不触发内部扫描」（懒监听核心收益的回归防线）。③ 有界瑕疵（非末位 tab 异常死亡滞留至 1→0）已在 manager §6 记录为接受项，非 bug。④ 打包无关（无新第三方依赖、无 runtime-config/路径展开变更；chokidar 已在 app/server/package.json）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列 MUST/MUST NOT、影响行严重偏离）→ 退 coder。
- spec 落后代码时 coder 按代码实际调整 + 汇报偏离（orchestrator 记 doc-sync 待办，doc-modifier 阶段 5 统一修 spec）。
- 同一 task 退回 2 次仍违反核心不变量 → 升级退 architect 重新设计。
