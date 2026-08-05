---
type: interface
title: Session Workspace Manager（懒监听 fs watch + watcher 生命周期）
priority: P0
status: active
updated: 2026-07-14
since: v0.0.17
---

# Session Workspace Manager（懒监听 fs watch + watcher 生命周期 + event 发射）

> 关联：`[P0]session_workspace.md`（workspaceDir 字段 + 切目录）+ `[P0]session_event.md`（`session_workspace_file_changed`）+ `[P0]session_store.md`（session 删除触发回收）。
> 本文是后端 `SessionWorkspaceManager` 的**概念权威源**：**懒监听模型**（目录级非递归 watcher + tab 监听列表 + 目录引用计数）+ watch/unwatch 生命周期 + 文件变化 → emit event。
>
> **[v0.0.139 结构性重写]** 监听模型从「每前台 session 一个**递归** watcher（watch 整个 workspaceDir）」→「**懒监听**：workspace 根一层 + 当前所有展开目录各一层（非递归）；展开=watch / 收起=unwatch / tab 消失回收」。旧「watch 不按子目录动态管理」正文作废，被本文取代。

## 1. 定位

**为什么必须后端 watch**：本应用是 web app（vite + 后端 server），**非 Electron**（grep `ipcRenderer`/`ipcMain` → 0 命中）。浏览器无法直接 `fs.watch` 任意路径，必须「后端 watch → event → SSE → 前端」。前端复用 `session_panel` SSE topic 接收 `session_workspace_file_changed` event。

**懒监听模型（lazy watch，v0.0.139 核心）**：

```
监听集合 = workspace 根（一层，非递归）+ 当前所有展开的文件夹（各一层，非递归）

打开 session tab   → watch(根)          文件树顶层可用
展开文件夹          → watch(该目录一层)    一次显式操作（acquire）
收起文件夹          → unwatch(该目录)      一次显式操作（release）
tab 消失（关/断连）→ 回收该 tab 名下全部监听  主人死亡自动清算
```

**收益（与树大小彻底解耦）**：监听数 = 展开目录数（通常 <50），**不再等于 workspace 文件总数**；`.venv` / `node_modules` 只要不展开就零成本（不再依赖 ignore 名单兜性能）；打开 session tab 零全树扫描（「扫描风暴」概念结构性消失）；收起目录不再产生无效 SSE 事件。

**Manager 定位**（单例，bootstrap 构造，注入 `statusBus`）：
- 持**目录级** watcher（每个被监听目录一个非递归 chokidar watcher），不是每 session 一个递归 watcher。
- 持**tab 监听列表**（`clientId` → 该 tab 展开的目录集）+ **目录引用计数**（多 tab 展开同一目录 → 计数 N，只 1 个物理 watcher）。
- watcher 生命周期与「有无 tab 引用」绑定：某目录首个引用 → 建 watcher；末个引用回收 → close。
- **收起→展开的兜底**：收起期间无 watcher 接增量，重新展开时前端 GET tree 重拉即最新（同「切回兜底」思路）。

## 2. 选型：chokidar depth:0（非递归一层）

沿用 chokidar（`app/server/package.json` `"chokidar": "^4.0.0"`，实测 4.0.3），但**监听单元从递归整树改为单目录一层**：

- `depth: 0`（chokidar v4 支持，`handler.js`：`oDepth==null || depth<=oDepth` 门控）= 只监听该目录的**直接子项**（文件 add/change/unlink + 直接子目录 addDir/unlinkDir），**不下降进子目录**。
- 后果：监听一个含 `.venv` 子目录的目录时，chokidar 只 stat `.venv` 这一个目录**条目**（emit addDir 可选，见 §4 ignore），**绝不扫描其 26k 内部文件**——`.venv` 卡顿的根因结构性消失，**不再依赖 ignore 名单兜性能**。
- 每个被监听目录一个独立 watcher，`ignoreInitial: true`（初始/展开树走 GET tree API，watcher 只负责增量）。

## 3. 接口

```typescript
interface SessionWorkspaceManager {
  /** 展开目录 / 打开 tab（watch 根）时调用：为 (sid, clientId) 登记对 relDir 一层的监听。
   *  - workspaceDir = 该 session 当前工作目录根（绝对路径，handler 从 `session.workspaceDir` realpath 后传入）；
   *    relDir = 相对 workspaceDir 的路径，'' 或 '.' = workspace 根。**manager 不持 SessionStore（§12 边界）**，
   *    故 workspaceDir 由 caller 传入——既用于把 relDir resolve 成 absDir，也作为 emitter relPath 的计算基准
   *    （一个 session 同时监听根 + 多个展开子目录，relPath 必须始终相对 workspaceDir 根算，§8）。
   *  - 幂等（MANDATORY）：同 (sid,clientId,relDir) 重复 watch **不叠加**（tab 目录集是 Set）→ no-op。
   *  - 引用计数：该 absDir 首个引用 → 建非递归 watcher（await ready）；已有 watcher → 仅 refcount++。
   *  - 校验 absDir 在 workspaceDir 内 + 存在 + 是目录；否则忽略（不报错，等重试）。 */
  watch(sessionId: string, clientId: string, workspaceDir: string, relDir: string): Promise<void>;

  /** 收起目录时调用：为 (sid, clientId) 注销对 relDir 的监听（workspaceDir 同 watch，用于 resolve absDir）。
   *  - 幂等（MANDATORY）：该 tab 未持有 relDir → 静默 no-op。
   *  - 引用计数：refcount--；归零 → 串行 close watcher（§7）。 */
  unwatch(sessionId: string, clientId: string, workspaceDir: string, relDir: string): Promise<void>;

  /** 回收一个 tab 名下全部监听（tab 优雅卸载 / 切 session）：遍历该 (sid,clientId) 目录集逐个 refcount--，归零者 close。
   *  - 幂等：该 tab 无监听 → no-op。前端在 ws-panel 卸载 / 切 session 时经 unwatch(无 relDir 语义) 触发（见 api §2.6.5）。 */
  releaseTab(sessionId: string, clientId: string): Promise<void>;

  /** 回收一个 session 名下**全部 tab**的监听（兜底：session_panel 订阅归零 / DELETE session / 切目录）。
   *  - 「主人死亡自动清算」：遍历该 sid 所有 clientId → releaseTab；物理 watcher 全 close。幂等。 */
  recycleSession(sessionId: string): Promise<void>;

  /** 切目录（PUT /session/:id）：recycleSession(旧目录全部监听) → setDirCb（更新字段 + emit dir_changed）。
   *  - 不重启 watch：前端收 dir_changed 后重置 tree + 重新 watch 新目录根（相对路径基准变了，旧监听无意义）。 */
  switchDir(sessionId: string, newDir: string, setDirCb: (sid: string, dir: string) => Promise<void>): Promise<void>;

  /** app shutdown（bootstrap shutdown hook）：close 所有 watcher + 清所有 tab 列表 + refcount。 */
  stopAll(): Promise<void>;

  /** 诊断/测试用：当前物理 watcher 快照（无监听主体存活时应为空 → 无泄漏 invariant 断言点）。 */
  getStatus(): WatcherStatus[];
}

/** 目录级监听条目（每个被监听 absDir 一个；引用计数合并多 tab）。 */
interface DirWatchEntry {
  sessionId: string;
  absDir: string;                 // 监听的目录绝对路径（一层非递归）
  watcher: chokidar.FSWatcher;
  ready: boolean;                 // chokidar 'ready' 后 true
  refcount: number;              // 持有该目录的 tab 数（∑ clientId）；归零 → close
}

/** 诊断快照 */
interface WatcherStatus { sessionId: string; absDir: string; ready: boolean; refcount: number; }
```

> **拆分（≤300 行/文件，见 §12 边界）**：接口/编排落 `session-workspace-manager.ts`（orchestrator + public API + 关闭串行化）；tab 列表 + 目录 refcount 纯内存记账落 `workspace-watch-registry.ts`（无 IO，可 UT 直测）；chokidar 单目录 watcher 工厂（config/ready/close/mapKind）落 `workspace-dir-watcher.ts`；per-session debounce + emit 落 `workspace-change-emitter.ts`。文件切分具体行数由 coder 定位，但**记账与 chokidar IO 必须解耦**（记账层无 chokidar 依赖）。

### 3.1 chokidar ready 等待 + **非递归（不自动 add 子目录）**

- **await ready**（chokidar BUG-005 模式）：`watch(absDir, {depth:0, ignoreInitial:true})` 后 `await waitForChokidarReady(watcher, 5000)`（5s 超时**resolve 不抛**，不阻塞 hook 主路径）。`waitForChokidarReady` 导出供单测直测（避免 vi.mock chokidar 模块污染）。
- **禁止 addDir → watcher.add**（v0.0.139 **移除**旧递归模式的核心变更）：旧模型对运行时新建子目录 `watcher.add()` 强制纳入递归监听；懒监听下**绝不自动 add 子目录**（否则重新退化为递归、re-introduce 扫描风暴）。新子目录出现 → 仍 emit `addDir`（前端文件树显示新文件夹 + hasChildren）→ 用户展开时才**显式 watch**该子目录（acquire）。

## 4. chokidar 配置

```typescript
const WATCH_OPTIONS = {
  depth: 0,                       // [v0.0.139] 一层非递归——根治大目录扫描风暴的结构性开关
  ignored: (p: string) => p.split('/').some((seg) => IGNORED_DIR_NAMES.has(seg)),
  ignoreInitial: true,            // 初始/展开树走 GET tree API，watcher 只负责增量
  persistent: true,
};
// IGNORED_DIR_NAMES = Set(['node_modules', '.git', '.venv', '__pycache__'])
```

> **chokidar v4 `ignored` 是函数匹配目录段**（字符串=全路径精确相等、**无 glob**——旧 glob 数组静默失效即事故根因，hotfix `1ef2d61c`）。懒监听下 `depth:0` 已让扫描风暴结构性消失，`ignored` 降级为**事件噪声过滤**（不再是性能关键路径），保留即可。
> **`ignoreInitial:true` + await ready**：ignoreInitial 仅在初始扫描窗口生效；await ready 保证 caller 拿到的 watcher 已过窗口，增量事件不被吞。

## 5. tab 身份 + 监听列表 + 引用计数

**tab 身份 = `clientId`（前端生成 ULID，一个 ws-panel 实例一个，跨展开/收起稳定）**。前端在每个 watch/unwatch 请求携带 `clientId`（api §2.6.5）。后端按 `(sessionId, clientId)` 键一份**目录集**（该 tab 展开的目录）。

**为什么用 clientId 而非复用 SSE subId**：SSE `subId` 由 `SseClient.subscribe` **内部生成、不暴露给 caller**（`sse-client.ts:222`），且页面 `session_panel` 订阅归 `useSessionPanelFanout` 持有、非 ws-panel 持有——复用它需改 SSE 契约（接受外部 subId）+ 跨组件透传，过度侵入。`clientId` 由 ws-panel 自生成即用，最小改动。

**引用计数合并（同 session 多 tab）**：目录 refcount = 持有该目录的 tab 数。同一目录被 N 个 tab 展开 → refcount=N，**只 1 个物理 watcher**；任一 tab 收起/回收只 refcount--；归零才真正 close（对齐用户裁决「任一 tab 死只减它那份」）。

**幂等（增量，非声明式全量）**：tab 目录集是 Set——同 (sid,clientId,relDir) 重复 watch 是 Set.add 幂等（不叠加 refcount）；unwatch 不在集内 = 静默 no-op。快速连点展开/收起、重试天然安全，**不做全量对账**。

## 6. tab 回收：两层触发（主人死亡自动清算）

监听列表随 tab 生命周期回收，**两层触发互补，都不泄漏**：

| 层 | 触发 | 动作 | 覆盖场景 |
|---|---|---|---|
| **① 优雅（per-tab，主）** | ws-panel 卸载 / 切 session → 前端显式 `unwatch(clientId, 无 relDir)`（api §2.6.5 release-all-for-tab） | `releaseTab(sid, clientId)` | SPA 切 session、app 内正常关面板（最常见路径）。逐目录 refcount--，归零者 close |
| **② 兜底（session 级）** | 现有 `session_panel` unsubscribe 钩子（group 订阅 **1→0**，已存在计数） | `recycleSession(sid)` | 异常死亡：浏览器直接关 tab / 网络断 / OS kill（① 未跑）。1→0 = 该 session 已无 viewer → 回收全部 clientId 名下监听 |

> **兜底挂现有钩子**（用户裁决红线 #2）：`bootstrap.ts` 的 `onUnsubscribe(session_panel, group)` 由「startWatch/stopWatch」改为「`recycleSession(sid)`」；`onSubscribe` **不再** startWatch（懒监听下 watch 全由前端显式 watch API 驱动，subscribe 不再隐式建监听）。

**有界瑕疵（明确记录，可接受）**：同 session 的**非末位** tab 异常死亡（浏览器崩溃）且尚有兄弟 tab 存活时，其监听因 group 未归零而**滞留**（refcount 仍被计），直到该 session group 1→0 才由 ② 兜底回收。此瑕疵**有界**（必在 1→0 清算，无永久泄漏）、**廉价**（监听=展开目录，个位数）、**无害**（存活 tab 只对这些目录变化标 stale）。这是「clientId 不绑定 SSE subId」的取舍代价；多浏览器 tab 同 session + 其一崩溃是极端边角，接受。

## 7. 关闭串行化 / 防重入（Bun FSEvents 崩溃面）

**崩溃面**：Bun ≤1.3.11 FSEvents `watcher.close()` use-after-free 竞态 → 段错误（已升 1.3.14 缓解）。懒监听下 watcher 生命周期操作更频繁（展开/收起即开/关），**快速连点展开/收起不得触发 create/close 交错竞态**。

**MANDATORY 设计**：对同一 `(sessionId, absDir)` 的 create / close 操作**串行化**——每个 absDir 一条操作队列（promise chain），close 未完成前不得对同一 absDir 起新 watcher；create 未完成前不得 close。`close()` 幂等（已 close 再 close = no-op）。refcount 的读改写在串行段内完成（防「refcount 0→1 与 1→0 交错」）。UT 必须覆盖：快速 watch→unwatch→watch 同一目录、并发多目录、close 期间再 watch。

## 8. 文件变化 → emit event（per-session debounce）

chokidar `'all'` 事件（含 absDir + absPath）→ 归属 sid（watcher 创建时闭包捕获 sid+absDir）→ `handleFsEvent` → **per-session** 100ms debounce 聚合（同一 sid 所有目录 watcher 的变化共用一个 debounce 窗口）→ 每 relPath+kind 一条 `session_workspace_file_changed` emit 到 `session_id:<sid>`（topic=session_panel）。

- `relPath = path.relative(workspaceDir, absPath)`（相对 workspaceDir，防泄漏绝对路径；跨平台 sep 归一 '/'）。
- kind 映射（chokidar eventName → SessionEvent kind）不变：`add`/`change`/`unlink`/`addDir`/`unlinkDir`，其余忽略。**新子目录 addDir 照常 emit（前端显示新文件夹）但不自动 watch（§3.1）**。
- 不合并成总 event（前端按 relPath 局部 re-fetch 子目录，性能优）。

> emit 走 `statusBus.emit(\`session_id:<sid>\`, { data: SessionWorkspaceFileChangedEvent, timestamp })`（payload/topic 契约见 `[P0]session_event.md §2`，本版本不变）。

## 9. 切目录换监听（与 `session_workspace.md §4` 协调）

切 workspaceDir（PUT /session/:id）时 handler 调 `switchDir(sid, newDir, setDirCb)`：

```
1. recycleSession(sid)             // 回收旧目录全部监听（相对路径基准 = 旧 workspaceDir，切后失效）
2. setDirCb(sid, newDir)           // SessionStore.setWorkspaceDir（更新字段 + 持久化 + emit dir_changed）
```

> 不重启 watch（旧模型的 stop→set→**start** 的 start 步骤取消）：切目录后相对路径基准变了，旧监听无意义；前端收 `session_workspace_dir_changed` → 重置 tree + 重新 GET 顶层 + **重新 watch 新目录根**（同新 tab 打开路径）。顺序 recycle→set MANDATORY（避免旧 watcher 在 set 窗口继续推旧目录变化）。

## 10. 生命周期

| 时机 | 动作 |
|------|------|
| bootstrap | 构造 Manager 单例，注入 statusBus。不主动启动任何 watcher。 |
| `POST /session`（create） | 不 watch（懒：等前端 ws-panel 挂载显式 watch 根）。 |
| 前端 ws-panel 挂载 → `POST watch{clientId, path:''}` | watch 根一层（refcount 0→1 建 watcher）。 |
| 前端展开目录 → `POST watch{clientId, path:relDir}` | watch 该目录一层（幂等 + refcount）。 |
| 前端收起目录 → `POST unwatch{clientId, path:relDir}` | unwatch（refcount--，归零 close）。 |
| 前端 ws-panel 卸载 / 切 session → `POST unwatch{clientId}`（无 path） | `releaseTab`（回收该 tab 全部）。 |
| `session_panel` 订阅 1→0（关 tab/断连/崩溃兜底） | `recycleSession(sid)`（回收该 session 全部 tab 监听）。 |
| `PUT /session/:id`（切目录） | `switchDir`（recycle 旧 + setDir；前端重新 watch 新根）。 |
| `DELETE /session/:id`（删 session） | `recycleSession(sid)`（幂等）。 |
| app shutdown | `stopAll()`（close 全部 + 清列表/refcount）。 |
| reconcileOnStartup | 不主动恢复（懒天然不需：前端 ws-panel 挂载重新 watch）。 |

## 11. 前端接线协调（显式控制，GET tree 绝不隐式 watch）

**用户裁决 #1 红线**：`GET /session/:id/workspace/tree` **只取数据、绝不建立监听**。旧模型「GET tree handler 兜底 startWatch」**移除**。watch 全由前端在展开/收起触点显式调用 watch/unwatch API。

```
前端 ws-panel 挂载 session A（clientId=C）：
  1. GET /session/A/workspace/tree                 // 顶层数据（不 watch）
  2. POST /session/A/workspace/watch {C, path:''}  // 显式 watch 根一层
  3. subscribe(session_panel, session_id:A)        // 接 SSE 增量（既有，独立于 watch）

展开目录 src：
  1. GET tree?parent=src                           // 子项数据
  2. POST watch {C, path:'src'}                    // 显式 watch src 一层

收起目录 src：POST unwatch {C, path:'src'}          // 停 src 监听（其内变化不再推）
重新展开 src：GET tree?parent=src（拉回收起期间变化，兜底）+ POST watch {C, path:'src'}
卸载/切走：POST unwatch {C}（release-all）；兜底靠 session_panel 1→0 → recycleSession
```

## 12. 边界 + 依赖

| 零件 | 归属 |
|---|---|
| 懒监听模型 + Manager 接口 + chokidar depth:0 config + tab 列表/refcount + 两层回收 + 关闭串行化 + debounce | 本文 ✅ |
| `session_workspace_file_changed` event 类型 + payload | `[P0]session_event.md §2/§3` |
| workspaceDir 字段 + 切换流程（recycle→set 顺序） | `[P0]session_workspace.md §4` |
| 前端文件树 reducer + 展开/收起触发 watch/unwatch 接线 | `specs/ui/components/chat-page/component-workspace-panel.md §3.4/§4.3` |
| HTTP 端点（tree / open / pick / **watch / unwatch**） | `specs/api/overall/04-agent-session.md §2.6` |
| `session_panel` subscribe/unsubscribe 钩子（兜底回收挂点） | `app/server/src/sse/sse-channel.ts` + `bootstrap.ts` |

- 依赖 `chokidar@^4.0.0`（depth:0 一层非递归）+ 复用 `EventHub`/`EventBus` + `session_panel` topic（已通）。

> **实现文件落点**：编排器 `session-workspace-manager.ts` / 纯记账 `workspace-watch-registry.ts` / chokidar 单目录工厂 `workspace-dir-watcher.ts` / debounce+emit `workspace-change-emitter.ts`。**HTTP watch/unwatch handler 落 `app/server/src/handlers/session-workspace-watch.ts`**（从 `session-workspace.ts` 拆出——并入会超单文件 300 行；复用其 export 的 `json`/`whitelistResolve`），契约/符号名不变；tree/open/pick 仍在 `session-workspace.ts`。

> 变更历史见 [`log.md`](log.md) + [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
