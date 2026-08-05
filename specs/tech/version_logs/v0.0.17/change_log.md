# v0.0.17 技术变更日志

> 对应 spec：
> - `specs/tech/agent/session/[P0]session_workspace.md`（新建 v1.0）
> - `specs/tech/agent/session/[P0]session_workspace_manager.md`（新建 v1.0）
> - `specs/tech/agent/session/[P0]session_event.md`（1.3 → 1.4）
> - `specs/tech/agent/session/[P0]session_store.md`（2.1 → 2.2）
> - `specs/tech/agent/context/[P0]system_reminder.md`（1.1 → 1.1 + 接线说明）
> - `specs/ui/components/chat-page/component-workspace-panel.md`（新建 v1.0）
> - `specs/ui/components/chat-page/_overview.md`（布局两栏 → 四栏 + 组件清单加 section-workspace-panel）
> - `specs/api/overall/04-agent-session.md`（1.4 → 1.5）
>
> 权威输入：`specs/prd/version_logs/v0.0.17/change_log.md`（PRD 6 方向 + 3 已定决策）+ `states/v0.0.17/research.md`（7 维度现状）

## 概述

v0.0.17 为每个 session 配一个真实工作目录，右侧新增 workspace 面板（可收起/可调宽/tab/文件树/切换目录/刷新）+ 后端 chokidar 监听文件变化 + workspace reminder 接线 + Session 加 workspaceDir 持久化字段 + 打开文件/文件夹（后端 spawn + 白名单）。

一句话：**给每个 session 配一个真实工作目录，用户在右侧面板直接看到目录文件、切换目录、打开文件，后端自动监听变化、自动把工作目录写进 reminder 让 LLM 感知。**

## 1. 已定决策（直接采纳）

| 决策点 | 选择 | 落点 |
|--------|------|------|
| workspace reminder | 接线现有 provider（workspace provider 读 session.workspaceDir，env/time 已可用，零新增 provider 零破 cache） | `context/[P0]system_reminder.md` §3 表 + loop 构造 SessionConfig |
| 初始目录 | 新 session 在全局 data dir 自动建独立目录 `data_dir/workspaces/{sessionId}`，用户可切换 | `session/[P0]session_workspace.md §3` |
| 切换目录 UI | 后端原生 dialog（mac osascript / linux zenity/kdialog / win FolderBrowserDialog），支持新建文件夹 | `api/overall/04-agent-session.md §2.6.3` + `platform/workspace-dialog.ts` |
| **watcher 生命周期（v0.0.17 用户决策变更）** | **lazy**（替代初版「常驻」）：session 切前台才 startWatch，切走 stopWatch；N session 只 1 前台 watcher | `session/[P0]session_workspace_manager.md §1/§7/§9` + §2.2 |
| **文件树加载（v0.0.17 用户决策）** | **lazy**：顶层 + 展开拉子目录；GET tree 仅返一层；不返全量递归 | `api/overall/04-agent-session.md §2.6.1` + `component-workspace-panel.md §3.1/§3.4` + §2.7 |

## 2. 核心设计决策

### 2.1 workspaceDir 与 SessionConfig.workdir 解耦

| 字段 | 归属 | 持久化 | 何时设 |
|------|------|--------|--------|
| `session.workspaceDir` | Session schema | ✅ 落 json | createSession / PATCH 切换 |
| `SessionConfig.workdir` | loop 运行时 | ❌ 每次 loop 重建 | loop 启动 `workdir = session.workspaceDir` |

**workspaceDir 是 session 的持久化真相源，workdir 是 loop 运行时的快照**。本版本不改 workdir 语义，只在 loop 启动时接线 `workdir = session.workspaceDir`。详见 `session/[P0]session_workspace.md §1`。

### 2.2 SessionWorkspaceManager 生命周期（lazy，省资源）

- watcher **lazy 启停**（v0.0.17 用户决策：省资源，替代初版「常驻」）：session 切到前台（前端 subscribe `session_panel:<sid>` 或 GET tree）→ startWatch；切走（前端 unsubscribe，订阅计数归零）→ stopWatch。
- N 个 session 并存时只有当前前台的 1 个 session 持 watcher，其余 N-1 个不占 inotify/fd。
- 生命周期：前台 → startWatch（幂等）；切走 → stopWatch；切换 workspaceDir → stop→set→start（顺序保证 MANDATORY，§见 session_workspace_manager.md §5；不在前台时只 stop 不 start）；DELETE → stopWatch；app shutdown → stopAll。
- reconcileOnStartup 不主动恢复 watcher（lazy 天然不需要：下次切前台时由前端 subscribe 钩子按需 startWatch）。
- **切回兜底**：切走期间 workspaceDir 可能有外部变化但无 watcher，切回时前端 GET tree 重拉最新（lazy 下唯一变化来源）。chokidar 重建有初始扫描延迟，手动刷新按钮兜底。
- **切走判定**：后端通过 session_panel topic 订阅计数判断，归零即视为无前端 viewer → stopWatch（不依赖前端显式 signal，关 tab/断网同样触发）。
- 详见 `session/[P0]session_workspace_manager.md §1/§7/§9`。

### 2.2a watch 不按子目录动态管理（关键澄清）

- chokidar watch **整个 workspaceDir**（recursive，固定一个 watcher per 前台 session），跟前端展开了哪些子目录**无关**。
- 文件树 lazy（§2.7）是前端 GET 按需，watch 是后端全量监听——**两者独立**。
- watch 检测到变化 → emit event → 前端按展开状态分流：**已展开**子目录局部刷新（GET `?parent` 拉该层）、**未展开**标记 stale（下次展开 GET 拉最新）。
- watch 永远不会因前端收起某文件夹就 unwatch 该子目录（chokidar 整树监听不变）。

### 2.3 fs watch 选型 + 跨平台

- 选 **chokidar v4**（业界标准，封装 mac fsevents / linux inotify / win readiry，支持 ignored glob + ignoreInitial + ready 事件）。
- ignore `node_modules` / `.git`；`ignoreInitial: true`（初始树走 GET tree API，watcher 只负责增量）。
- 不覆盖 NFS/远程/万级文件量；手动刷新按钮兜底。
- 详见 `session/[P0]session_workspace_manager.md §2/§4/§8`。

### 2.4 event 发射 + debounce

- 新 event `session_workspace_file_changed`（payload: `{ path: 相对路径, kind, isDir }`）+ `session_workspace_dir_changed`（payload: `{ workspaceDir, prevDir }`）。
- 命名遵循 snake_case 惯例（req 的 kebab-case 在 spec 显式校正）。
- 复用 `session_panel` SSE topic（已通）；100ms debounce 聚合同 sid 多变化（防编辑器保存风暴）。
- 每个变化一条 event（不合并成总 event），前端按 relPath 局部 re-fetch 子目录（性能优）。
- 详见 `session/[P0]session_event.md §2/§3`。

### 2.5 前端先读 API 再 watch 协调（lazy 主路径）

- session 切到前台：前端 GET tree（补回切走期间变化 + 拿当前 workspaceDir，lazy 下唯一变化来源）→ subscribe session_panel（接 SSE 增量 + 后端 subscribe 钩子触发 startWatch）。
- session 切走：前端 unsubscribe → 后端 unsubscribe 钩子（订阅计数归零）→ stopWatch。
- chokidar 重建有初始扫描延迟（小目录 <100ms，大目录稍慢），手动刷新按钮兜底。
- 详见 `session/[P0]session_workspace_manager.md §9`。

### 2.7 文件树 lazy 加载（v0.0.17 用户决策）

- GET `/session/:id/workspace/tree` **不返全量递归**，只返一层（`depth=1`）：顶层缺省 / `?parent=<relPath>` 返该路径直接子项。
- `WsTreeNode` 用 `hasChildren: boolean` 替代 `children?`（前端据 hasChildren 决定 twisty 是否显示，不递归）。
- 响应加 `parent: string|null` 字段（顶层=null，子目录=相对路径；前端据此定位 childrenCache key）。
- 前端展开文件夹 → GET `?parent=<path>` → 填 `childrenCache[path]`；收起保留缓存（不重拉）；下次展开直接用缓存。
- watch event 推未展开子目录变化 → 前端标记 stale（不立即拉）；下次展开时清缓存重拉。
- 大目录性能优化（避免万级文件全量 GET）。
- 详见 `api/overall/04-agent-session.md §2.6.1` + `ui/components/chat-page/component-workspace-panel.md §3.1/§3.4`。

### 2.6 路径白名单安全（MANDATORY）

- POST open：`path.resolve(workspaceDir, relPath)` 必须 `startsWith(workspaceDir + sep)`，防目录穿越。
- 切换目录：newDir 必须存在且是目录（防手输错误）。
- fs watch：仅监听 workspaceDir 内（chokidar root = workspaceDir）。
- 详见 `api/overall/04-agent-session.md §2.6.2` + `session/[P0]session_workspace.md §6`。

## 3. 与 PRD 6 新概念对应

| PRD 新概念 | spec 落点 | 代码落点（文件变更清单）|
|-----------|----------|------------------------|
| 1. WorkspacePanel UI 组件 | `specs/ui/components/chat-page/component-workspace-panel.md`（新）+ `_overview.md`（布局两栏→四栏） | `app/web/src/components/chat-page/section-workspace-panel.tsx`（新）+ 子组件 + `page-chat.tsx` 追加 `<SectionWorkspacePanel>` |
| 2. Session.workspaceDir 字段 + 初始目录 + 持久化 | `specs/tech/agent/session/[P0]session_workspace.md`（新）+ `[P0]session_store.md`（加字段 + setWorkspaceDir） | `app/server/src/agent/session-store-types.ts` + `schema_defs/session.ts` + `session-store.ts` |
| 3. 切换目录 UI（系统原生 dialog） | `specs/api/overall/04-agent-session.md §2.6.3` | `app/server/src/platform/workspace-dialog.ts`（新）+ handler |
| 4. SessionWorkspaceManager（fs watch + event） | `specs/tech/agent/session/[P0]session_workspace_manager.md`（新）+ `[P0]session_event.md`（加 2 event） | `app/server/src/agent/session-workspace-manager.ts`（新）+ `session-event-types.ts` |
| 5. workspace reminder（接线现有 provider） | `specs/tech/agent/context/[P0]system_reminder.md §3`（接线说明，不改 provider 实现） | loop 构造 SessionConfig 时 `workdir = session.workspaceDir`（接线点） |
| 6. 打开文件/文件夹（后端 spawn + 白名单） | `specs/api/overall/04-agent-session.md §2.6.2` | `app/server/src/platform/workspace-open.ts`（新）+ handler |

## 4. 文件变更清单（汇总）

### 4.1 后端（app/server）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `src/agent/session-store-types.ts` | 修改 | Session interface 加 `workspaceDir: string` |
| `src/agent/schema_defs/session.ts` | 修改 | SessionSchema 加 `workspaceDir: { type: 'string', required: true }` |
| `src/agent/session-store.ts` | 修改 | 实现 `setWorkspaceDir(sid, newDir)`（更新 + 持久化 + emit dir_changed）+ createSession 入参接 workspaceDir + getSession lazy 修复 |
| `src/agent/session-event-types.ts` | 修改 | SessionEventType 加 `session_workspace_file_changed` + `session_workspace_dir_changed`；union 扩展；interface 定义 |
| `src/agent/session-workspace-manager.ts` | 新增 | SessionWorkspaceManager（startWatch/stopWatch/stopAll + chokidar + handleFsEvent debounce + event 发射；**lazy 语义：startWatch/stopWatch 幂等，stopWatch 不报错**） |
| `src/agent/agent-loop.ts`（或 SessionConfig 构造点） | 修改 | loop 启动构造 SessionConfig 时 `workdir = session.workspaceDir`（接线 workspace reminder） |
| `src/bootstrap.ts`（或等价） | 修改 | 构造 SessionWorkspaceManager 单例 + 注入 + 注册 shutdown hook + **不再 POST /session 后强制 startWatch**（lazy：等前端 subscribe） |
| `src/server/handlers/session.ts` | 修改 | POST /session 加 workspaceDir 初始策略（**BUG-001 修复**：body 提供 → `validateCallerWorkspaceDir` 校验 abs+exists+isDir 通过后用该值；缺省建 `<DATA_DIR>/workspaces/<sid>`）；DELETE 触发 stopWatch（幂等）；GET 单 lazy 修复（无 workspaceDir 历史 session 补建 + 回填） |
| `src/server/handlers/session-workspace-seed.ts` | 新增（v1.2） | **ET seed 端点（test-only，NODE_ENV=test gate，非 test 404）**：`/api/workspace/ensure-dir` / `touch` / `ensure`；复用 `session-workspace.ts` 白名单语义；导出 `validateCallerWorkspaceDir`（POST /session + PUT 切目录共用单一权威实现） |
| `src/server/handlers/session-update.ts` | 新增 | PUT /session/:id（切换 workspaceDir，stop→set→start；不在前台时只 stop 不 start） |
| `src/server/handlers/session-workspace.ts` | 新增 | GET tree（**支持 `?parent=<relPath>` + `?depth=1` lazy param + 路径白名单校验 parent**）/ POST open / POST pick-directory；**GET tree handler 内部兜底：若 watcher 未启动可按需 startWatch** |
| `src/server/handlers/sse.ts`（或 hub subscribe 钩子） | 修改 | **session_panel topic 的 subscribe/unsubscribe 钩子**：subscribe 时若 group=`session_id:<sid>` → 检查订阅计数，首个订阅触发 `startWatch(sid, workspaceDir)`；unsubscribe 时订阅计数归零 → `stopWatch(sid)` |
| `src/server/router.ts` | 修改 | 注册新路由 |
| `src/platform/workspace-dialog.ts` | 新增 | 跨平台 spawn：osascript / FolderBrowserDialog / zenity/kdialog |
| `src/platform/workspace-open.ts` | 新增 | 跨平台 spawn：open / explorer+start / xdg-open + 路径白名单校验 |

### 4.2 前端（app/web）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `src/components/chat-page/page-chat.tsx` | 修改 | render `<SectionChatDetail>` 后追加 `<SectionWorkspacePanel>`；三栏 flex |
| `src/components/chat-page/section-workspace-panel.tsx` | 新增 | 容器：collapsed/expanded 双态 + width state（localStorage）+ SSE 订阅 + GET tree |
| `src/components/chat-page/component-ws-tab-bar.tsx` | 新增 | header：tabs + actions（切换/刷新/收起） |
| `src/components/chat-page/component-ws-path-bar.tsx` | 新增 | 路径栏 ellipsis |
| `src/components/chat-page/component-ws-file-tree.tsx` | 新增 | 文件树 + **lazy 加载**：顶层 GET tree（无 parent）+ 展开 GET `?parent=<path>` 子目录；SSE file_changed 按展开状态分流（已展开 re-fetch / 未展开标记 stale）；state 含 `childrenCache` / `loadingChildren` / `stalePaths` |
| `src/components/chat-page/component-ws-tree-item.tsx` | 新增 | 单 item：twisty（testid `-expand`，仅 hasChildren=true 显示）+ icon + name + hover 打开按钮 |
| `src/components/chat-page/component-ws-resize-handle.tsx` | 新增 | 拖宽手柄（mousedown/mousemove/mouseup + clamp [232,560]） |
| `src/slices/chat-slice.ts`（或等价 state 管理） | 修改 | reducer 加 `session_workspace_file_changed`（按展开状态分流：已展开父目录 re-fetch、未展开标记 stale）+ `session_workspace_dir_changed`（重置 tree state）case |

### 4.3 依赖

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `package.json`（server） | 修改 | 加 `chokidar@^4.0.0` dep |

## 5. 测试覆盖（指引，具体 case 在 test-plan.md 落）

| 路径 | 类型 | case 范围 |
|------|------|----------|
| 路径 A（创建 → 面板 + reminder） | API | session_create_ws_tc1（POST /session 验 workspaceDir + 目录）+ transcript 验 reminder content |
| 路径 B（切换目录 + 持久化） | API | session_switch_ws_tc1（PUT → GET tree 新内容 + 重读验持久化） |
| 路径 C（展开收起 + 打开） | E2E | UC-17.18/19（hover + 点打开按钮）+ API ws_open_tc1 |
| 路径 D（fs watch + 刷新） | API + E2E | ws_tree_tc1（GET 顶层 + GET `?parent=<sub>` 懒加载）+ 外部 touch → 验 SSE event 推送（前台 session 才有 watcher） |
| 路径 E（收起/拖宽/持久化） | E2E | UC-17.2/3/5（localStorage 持久化） |
| 路径 F（lazy watcher：切走 stop / 切回 GET tree 补变化） | API + E2E | UC-17.14（切到 session A → subscribe → 验 watcher 启动；切走 A → unsubscribe → 验 watcher 停止；外部 touch 文件 → 无 SSE event；切回 A → GET tree 补回变化） |
| 路径 G（lazy 文件树展开加载） | API + E2E | ws_tree_subdir_tc1（GET `?parent=<dir>` 返该层子项 + hasChildren）+ UC-17.x（展开文件夹 → 验 ws-tree-loading → 验子节点渲染；收起再展开用缓存） |
| 安全 | API | ws_open_traversal_tc1（恶意 ../../ → 400） |

## 6. 视觉保真度门禁（设计稿存在 MANDATORY）

设计稿：`reqs/v0.0.17/mqnbr367-easy-opc-chat-v9a.html` §209-242（CSS）+ §706-800（WorkspacePanel）。
verifier 须用 `vision_check.py compare` 逐维度比对（compare checks 见 `component-workspace-panel.md §7`）：
- layout-3col / layout-ws-collapse
- font-tab / font-path / font-item-name
- border-left / border-resize-hover
- color-folder-icon / color-hover / color-act-hover
- size-icon-btn / size-item-h

明显偏差建 `BUG-xxx-[open].md` 标 `视觉保真`。

## 7. 版本

version: 1.2（v0.0.17 修订后续：**BUG-001 修复**——POST /session handler 加 `validateCallerWorkspaceDir`（abs + exists + isDir），caller 在 body 提供 workspaceDir 时校验通过后用该值（不再强制默认 `<DATA_DIR>/workspaces/<sid>`，未提供才自动建）；权威实现集中在 `session-workspace-seed.ts` 导出，session.ts + session-update.ts 共用。**新增 ET seed 端点（test-only）**：`/api/workspace/ensure-dir` / `touch` / `ensure`，router gate `NODE_ENV=test` 非 test → 404（避免生产暴露写端点），仅供 ET seed fs（建测试目录结构、写 marker 文件）；`ensure` 端点放宽白名单专供 switch_tc1 「先建 `/tmp/ws_x` 临时目录再 PUT 切到该目录」flow；新增文件 `app/server/src/handlers/session-workspace-seed.ts`。**BUG-017-001 修复**：前端 `ws-refresh-btn` 手动刷新实现补「按当前 expanded state 逐层 GET `?parent=<path>` 补回子目录」（spec `component-workspace-panel.md §3.3` 已规定，原实现只重拉顶层导致已展开子节点丢失）。**主题默认 light**：`theme-init.ts` fallback 在 GET /config/app 失败 / 未配 appearance.theme 时回落到 `light`（对齐设计稿默认亮色基调；已设置过 theme 的用户配置仍以 GET 返回值为准）。

version: 1.1（v0.0.17 修订：§1 决策表加 watcher lazy + 文件树 lazy 两行；§2.2 watcher 生命周期改 lazy（替代常驻）；新增 §2.2a watch 不按子目录动态管理的关键澄清；新增 §2.7 文件树 lazy 加载设计；§2.5 前端协调改 lazy 主路径；§4.1/§4.2 文件变更清单同步（sse.ts 加 subscribe/unsubscribe 钩子；session-workspace-handler 加 parent/depth param；ws-file-tree 加 childrenCache/loadingChildren/stalePaths state）；§5 测试覆盖加路径 F（lazy watcher 切走/切回）+ 路径 G（lazy 文件树展开加载））。

version: 1.0（v0.0.17 新建：workspace 工作区功能技术变更；3 已定决策 + 6 核心设计决策 + 文件变更清单 + 测试覆盖指引）。
