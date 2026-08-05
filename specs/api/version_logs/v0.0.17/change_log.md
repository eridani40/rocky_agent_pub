# v0.0.17 API 变更日志

> 对应 spec：`specs/api/overall/04-agent-session.md`（version 1.3 → 1.4）
> 权威输入：`specs/prd/version_logs/v0.0.17/change_log.md` §3.1/3.2/3.3/3.4/3.6 + `states/v0.0.17/research.md`

## 概述

v0.0.17 新增 workspace 工作区面板所需 HTTP 端点：Session 加 `workspaceDir` 字段 + 切换目录 + 文件树（**lazy 一层**）+ 打开文件/文件夹 + 系统 dialog 选目录 + **ET seed 端点（test-only）**。

## 1. 变更端点

### 1.1 `POST /session` — 创建会话（修订）

- `CreateSessionBody` 加 `workspaceDir?: string`（可选）。
- `Session` 响应加 `workspaceDir: string` 字段（required）。
- **[BUG-001 修复，落 v1.4]** workspaceDir 初始策略：
  - body 提供 workspaceDir → 校验（abs + exists + isDir，任一失败 400，复用 `validateCallerWorkspaceDir`）→ **用该值**（caller 负责建目录，不自动建）。
  - body 未提供 → 后端建 `<DATA_DIR>/workspaces/<sid>`（`fs.mkdir recursive`，幂等）+ 写入 `session.workspaceDir`。
- 错误码加：`400` workspaceDir 提供但非绝对路径 / 不存在 / 非目录。

### 1.2 `PUT /session/:id` — 更新 session（新增，§2.5）

- `UpdateSessionBody { workspaceDir?, title? }`。
- body 含 `workspaceDir` → router 分流到 `handleSessionUpdate`（切目录路径）：校验 → `SessionWorkspaceManager.switchDir`（编排 stop→set→start）→ 若 session 不在前台（无 watcher）只 stop + set 不 start。
- body 仅含 `title`（无 workspaceDir）→ session.ts 原 PUT 路径（`store.updateSession({title})`）。
- 响应 `200 + Session`。
- 错误：404 session；400 workspaceDir 缺失或非绝对/不存在/非目录；400 空更新（既无 workspaceDir 也无 title）。

### 1.3 `GET /session/:id/workspace/tree` — 工作区文件树（新增，§2.6.1，**lazy 一层**）

- 返回 `WorkspaceTreeResponse { workspaceDir, parent: string|null, tree: WsTreeNode[] }`。
- `WsTreeNode { name, path(相对路径，`/` 跨平台统一), type: "file"|"dir", hasChildren: boolean }`（**lazy：用 `hasChildren` 替代 `children?`，不递归**）。
- query：`parent?`（相对路径，缺省=顶层）/ `depth?`（默认 1，[1,10]；本版本固定 1 层）。
- `parent` 字段（顶层=null / 子目录=相对路径）：前端据此定位 childrenCache key。
- **lazy 语义**：单次 GET 只返一层（顶层缺省 / 指定 parent 返该 parent 直接子项）；前端按需逐层 GET。
- 默认 ignore `node_modules` / `.git`（与 chokidar WATCH_OPTIONS 一致）。
- 安全校验（白名单 + realpath + startsWith workspaceDir，防 `../` + symlink 穿越外部）。
- 错误：404 session；400 parent 越界 / depth 非 [1,10]；500 workspaceDir 不可读。

### 1.4 `POST /session/:id/workspace/open` — 打开文件/文件夹（新增，§2.6.2）

- `OpenBody { path(相对路径), kind: "file"|"folder" }`。
- 后端 spawn：mac `open` / win folder `explorer`+file `start ""` / linux `xdg-open`。
- **路径白名单 MANDATORY**：`path.resolve(workspaceDir, relPath)` + `realpath` 必须 `startsWith(workspaceDir)`，防目录穿越 + symlink 外部。
- 响应 `{ ok: true }`；400 kind 非 file/folder / 路径越界；404 session / 文件不存在；500 spawn 失败。

### 1.5 `POST /session/:id/workspace/pick-directory` — 系统 dialog 选目录（新增，§2.6.3）

- 后端 spawn OS 原生 dialog：mac `osascript` / win `FolderBrowserDialog` / linux `zenity`/`kdialog`。
- **支持新建文件夹**（系统 dialog 原生支持）。
- 请求体 `{ currentDir?: string }`（可选，dialog 默认位置，必须绝对路径否则 400）。
- 响应 `{ path: string | null }`（用户取消 → null，非错误 200）。
- 错误：400 currentDir 非绝对路径；500 Linux 缺 zenity/kdialog / spawn 失败。

### 1.6 `DELETE /session/:id` — 删除会话（修订）

- 新增副作用：触发 `SessionWorkspaceManager.stopWatch(sid)`（关闭该 session 的 fs watcher，幂等 no-op）。

### 1.7 `/api/workspace/*` — ET seed 端点（新增，**test-only**）

- **仅 `NODE_ENV=test` 生效**；生产环境（router gate）→ `404 Not Found`，避免生产暴露写端点。
- 路由 3 个：
  - `POST /api/workspace/ensure-dir { path, sessionId }` → 递归 mkdir（body.path 相对/绝对均可，越界 400）。
  - `POST /api/workspace/touch { path, sessionId, content? }` → writeFile（父目录自动 mkdir recursive）。
  - `POST /api/workspace/ensure?path=<abs>` → 幂等 mkdir（query 形式；switch_tc1 step3 用，**放宽白名单**，专供「先建临时目录，再 PUT 切到该目录」flow）。
- 复用 `session-workspace.ts` 白名单语义（resolve + realpath + startsWith workspaceDir）；`ensure` 端点例外（无 session 校验，PUT 切目录时校验存在 + 是目录兜底）。
- 仅供 ET seed fs（建测试目录结构、写 marker 文件）；非生产 API。

## 2. 文件变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/handlers/session.ts` | 修改 | POST /session handler 加 workspaceDir 初始策略（caller 提供校验后用；缺省建 `<DATA_DIR>/workspaces/<sid>`）；GET 单 lazy 修复（无 workspaceDir 历史 session 补建 + 回填） |
| `app/server/src/handlers/session-update.ts` | 新增 | PUT /session/:id 切 workspaceDir handler（校验 → manager.switchDir stop→set→start） |
| `app/server/src/handlers/session-workspace.ts` | 新增 | GET tree（lazy 一层 + 白名单）/ POST open（白名单 + spawn）/ POST pick-directory（spawn 原生 dialog） |
| `app/server/src/handlers/session-workspace-seed.ts` | 新增 | ET seed 端点（ensure-dir / touch / ensure；test-only gate；validateCallerWorkspaceDir 共享权威实现） |
| `app/server/src/server/router.ts` | 修改 | 注册路由：PUT /session/:id 分流 + 3 个 workspace 子路由 + 3 个 /api/workspace seed 路由（NODE_ENV=test gate） |
| `app/server/src/agent/session-store.ts` | 修改 | SessionStore.setWorkspaceDir（更新 + 持久化 + emit dir_changed）+ ensureWorkspaceDir（lazy 修复历史 session） |
| `app/server/src/agent/session-workspace-manager.ts` | 新增 | SessionWorkspaceManager（lazy startWatch/stopWatch/stopAll/switchDir + chokidar + 100ms debounce + event 发射） |
| `app/server/src/agent/session-event-types.ts` | 修改 | SessionEventType 加 `session_workspace_file_changed` + `session_workspace_dir_changed`；SessionEvent union 扩展 |
| `app/server/src/agent/session-store-types.ts` | 修改 | Session interface 加 `workspaceDir: string` |
| `app/server/src/agent/schema_defs/session.ts` | 修改 | SessionSchema 加 `workspaceDir: { type: 'string', required: true }` |
| `app/server/src/bootstrap.ts` | 修改 | 构造 SessionWorkspaceManager 单例 + 注入 SessionStore/EventHub + 注册 shutdown hook |
| `package.json` | 修改 | 加 `chokidar@^4.0.0` dep |
| `app/server/src/platform/workspace-dialog.ts` | 新增 | 跨平台 spawn：osascript / FolderBrowserDialog / zenity/kdialog 分支 |
| `app/server/src/platform/workspace-open.ts` | 新增 | 跨平台 spawn：open / explorer+start / xdg-open 分支 |

## 3. AT 覆盖路径

| 路径 | 关联 case（tests/api/workspace/） |
|------|------------------------|
| 创建 session（含 workspaceDir 自动建 / BUG-001 caller 提供） | `session_create_ws_tc1`（不传 → 自动建 + 返 workspaceDir）+ `session_create_caller_ws_tc1`（BUG-001 回归：传 body.workspaceDir → 用该值） |
| 切换 workspaceDir | `session_switch_ws_tc1`（PUT /session/:id → GET tree 验证新目录内容 + 重读持久化） |
| GET tree lazy | `ws_tree_tc1`（顶层）+ `ws_tree_subdir_tc1`（GET `?parent=<dir>` 返该层 + hasChildren） |
| POST open | `ws_open_tc1`（合法 path）+ `ws_open_traversal_tc1`（恶意 ../../ → 400） |
| POST pick-directory | `ws_pick_dir_tc1`（返 path 或 null） |

## 4. 版本

version: 1.1（v0.0.17 修订：§1.1 加 BUG-001 修复（caller 提供 workspaceDir 校验后用，不强制默认）；§1.3 GET tree 改 lazy 一层（`WsTreeNode.hasChildren` 替代 `children?`，加 `parent` 字段，加 `depth` query param）；§1.5 加 `currentDir` 必须绝对路径校验；§1.7 新增 `/api/workspace/*` ET seed 端点（test-only，NODE_ENV=test gate，非 test 404）；§2 文件清单更新）。

version: 1.0（v0.0.17 新建：workspace 端点组 API 变更日志；对应 `04-agent-session.md` v1.3 → v1.4）。
