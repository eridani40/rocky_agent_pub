# v0.0.17 PRD 变更日志

## 概述

本版本在会话区右侧新增 **workspace 工作区面板**（可收起/可调宽/tab/文件树/hover 按钮/切换目录/刷新）+ **workspace 文件监听**（后端 fs watch → 新 event → SSE → 前端）+ **workspace system reminder**（接线现有 provider 读 session.workspaceDir）+ **workspace 持久化**（Session 加 workspaceDir 字段）+ **打开文件/文件夹**（后端 spawn + 路径白名单）。

一句话：**给每个 session 配一个真实工作目录，用户在右侧面板直接看到目录文件、切换目录、打开文件，后端自动监听变化、自动把工作目录写进 reminder 让 LLM 感知。**

权威输入：`reqs/v0.0.17/req.md` + `reqs/v0.0.17/mqnbr367-easy-opc-chat-v9a.html`（视觉契约 §209-242 + WorkspacePanel §706-800）+ `states/v0.0.17/research.md`（7 维度现状 + 差异）。
spec 权威源：`specs/ui/components/chat-page/_overview.md`（现有两栏布局）+ `specs/tech/agent/session/`（session_store / session_event / session_state）+ `specs/tech/agent/context/`（system_reminder + extension point）。

---

## 1. 版本定位

### 1.1 范围

**IN（v0.0.17 六方向）**：
1. **workspace 面板 UI**（右侧第 3 栏）：可收起/可调宽（拖分隔线）/tab（目前仅 1 个「工作区」tab）/文件树（文件夹展开收起）/item hover 显示打开按钮/切换目录按钮/刷新按钮；视觉契约按设计稿 §209-242
2. **初始目录 + 持久化**：新 session 在全局 data dir 自动建独立目录 `data_dir/workspaces/{sessionId}`，用户可随时切换；Session schema 加 `workspaceDir` 字段持久化
3. **切换目录 UI**：后端原生 dialog（macOS osascript / Windows FolderBrowserDialog / Linux zenity/kdialog），**支持新建文件夹**
4. **workspace 文件监听**：新建 `SessionWorkspaceManager`（后端 chokidar fs watch），文件变化发新 event `session_workspace_file_changed`，复用 `session_panel` SSE topic 推前端；切目录换 watch；手动刷新按钮兜底
5. **workspace reminder**：接线现有 `workspace` provider 读 `session.workspaceDir`（链路 session.workspaceDir → SessionConfig.workdir → provider）；env/time 已可用，组合成「workspace + env + time」提醒
6. **打开文件/文件夹**：后端 `child_process.spawn`（mac `open` / win `explorer`+`start` / linux `xdg-open`）+ 路径白名单（必须在 workspaceDir 内）

**OUT（本版本明确排除）**：

| 排除项 | 理由 |
|--------|------|
| 跨平台 fs watch 边缘行为覆盖（NFS/远程目录/大文件量万级） | future；本版本聚焦本地常规目录，监听不到时手动刷新按钮兜底 |
| 多 workspace tab（设计稿预留 wsIdx 多 workspace 切换） | future；本版本仅 1 个 workspace tab，但 UI 结构留扩展 |
| workspace 子目录单独 watch 配置 / ignore glob 配置 UI | future；默认 ignore `node_modules` / `.git`，不暴露配置 |
| 文件内容编辑/上传 | 非本版本范围，只读 + 打开外部 |
| time provider 提到时分精度 | 破 prompt cache，明确不在本版本（保日期精度） |

### 1.2 已定决策（直接采纳）

| 决策点 | 选择 |
|--------|------|
| workspace reminder 语义 | 接线现有 provider（workspace provider 改读 session.workspaceDir，链路 session.workspaceDir → SessionConfig.workdir → provider；env/time 已可用，零新增 provider、零破 cache） |
| 初始目录策略 | 新 session 自动建独立目录 `data_dir/workspaces/{sessionId}`，用户可切换 |
| 切换目录 UI | 后端原生 dialog（macOS osascript / Windows FolderBrowserDialog / Linux zenity/kdialog，原生支持新建文件夹） |

---

## 2. 关键用户路径（MANDATORY — 测试最低覆盖要求）

| 路径 | 用户操作链路 | 预期结果 |
|------|-------------|---------|
| **路径 A** | 新建 session → 右侧自动显示 workspace 面板（初始空文件树，路径为 `data_dir/workspaces/{sid}`）→ 在该目录手动放一个文件 → 发消息给 LLM | 面板路径栏显示 `…/workspaces/{sid}`；文件出现（经 fs watch 推送）；LLM reminder 含 workspace 路径 + env + time |
| **路径 B** | 打开 session → 点切换目录按钮 → 系统原生 dialog 弹出（可新建文件夹）→ 选/建一个目录 → 确认 | 面板路径刷新为新目录；文件树换新内容；旧 watch 取消、新 watch 启动；reminder workspace 更新；workspaceDir 持久化（重开 session 仍是新目录） |
| **路径 C** | 打开 session → workspace 面板展示文件树 → 点文件夹 twisty 展开/收起 → hover 某文件夹 → 点「打开文件夹」按钮 → hover 某文件 → 点「打开文件」按钮 | 文件夹子项展开/收起；点「打开文件夹」系统文件管理器打开该目录；点「打开文件」系统默认应用打开该文件 |
| **路径 D** | 打开 session（workspace 已监听）→ 在外部修改 workspace 内文件（新建/改名/删除）→ 观察面板 → 点刷新按钮 | 文件变化经 fs watch → `session_workspace_file_changed` event → SSE → 面板自动刷新；即使 watch 漏报，点刷新按钮也能手动重拉 |
| **路径 E** | 打开 session → 点面板收起按钮 → 面板折叠成 36px 窄栏 → 点窄栏展开按钮恢复 → 拖动左侧分隔线调宽/调窄 → 刷新页面 | 收起/展开切换平滑；拖动实时调宽（clamp [232, 560]）；刷新后宽度/收起态保持（持久化） |
| **路径 F** | session A 在前台（已 watch）→ 切到 session B → 再切回 A | 切到 B 时 B 先 GET workspace tree API 渲染再启动 B 的 watch；切回 A 时 A 先读 API（拿到最新 workspaceDir + 文件树）再监听 watch（保证切走期间的变化能被 API 补回） |

> **路径 = 测试最低覆盖要求**。每条路径至少 1 个 API case + 视情况 1 个 E2E case。具体 case 映射在 `states/v0.0.17/verify/test-plan.md` 落。

---

## 3. 需求清单（产品视角）

### 3.1 workspace 面板（右侧第 3 栏，可收起/可调宽）[v0.0.17]

**描述**：在现有两栏（conv-panel + chat-detail）右侧新增第 3 栏 workspace 面板。面板可收起（折叠成 36px 窄栏）、可拖动分隔线调宽（clamp [232, 560]）、内含 tab（目前仅 1 个「工作区」）、文件树、切换目录按钮、刷新按钮。视觉契约严格按设计稿 §209-242（`.ws-panel` / `.ws-resize` / `.ws-header` / `.ws-tab` / `.ws-tree` / `.ws-item` 等）。

**优先级**：P0

**用户故事**：作为对话用户，我希望在右侧一眼看到当前 session 的工作目录文件，并能展开收起、调节宽度，以便在不离开对话的情况下浏览项目文件。

**布局（两栏 → 三栏，nav-rail 是 framework 既有不算）**：

```
┌──────┬────────────┬──────────────────────────────┬─────────────┐
│ nav  │ conv-panel │ chat-detail                  │ ws-panel    │
│ 56px │  220px     │  flex-1                      │ 232-560     │
│ rail │ 会话列表    │  对话区（topbar/messages/input）│ (或 36 收起)│
└──────┴────────────┴──────────────────────────────┴─────────────┘
```

- **展开态**（`.ws-panel`，width 可调 [232, 560]，默认 272）：左侧拖宽手柄 + 顶部 header（tab + actions）+ 路径栏 + 文件树
- **收起态**（`.ws-rail`，36px 窄栏）：仅一个展开按钮（`chevron-left` icon）
- **拖宽手柄**（`.ws-resize`）：absolute left:-2px width:6px，cursor col-resize，hover 显示 accent 竖线；mousedown → window mousemove 算 `innerWidth - clientX` → setState width；mouseup 解绑
- **宽度/收起态持久化**：localStorage（per session 或全局，架构定）

**面板内部结构**（展开态）：
- **header**（`.ws-header`）：左 tabs（`.ws-tabs`，仅 1 个 active「工作区」tab，含 folder icon）+ 右 actions（切换目录 swap icon + 收起 chevron-right icon，均 `.ws-icon-btn` 26×26 hover bg-warm）
- **路径栏**（`.ws-path`）：10px mono muted，ellipsis 显示当前 workspaceDir 绝对路径，hover title 显示完整
- **文件树**（`.ws-tree`）：flex-1 滚动，递归渲染 `.ws-item`

**item 结构**（`.ws-item`，height 26，hover bg-warm，position relative）：
- **文件夹**：twisty（14×14 chevron-right，展开旋转 90°）+ folder icon（gold 色，展开变 folderOpen）+ name（12.5px ellipsis）+ hover「打开文件夹」按钮（`.ws-act` external icon）
- **文件**：twisty placeholder（占位保持对齐）+ file icon（muted 色）+ name + hover「打开文件」按钮
- **hover 按钮**（`.ws-act`，22×22）：默认 opacity:0，item hover 时 opacity:1（**布局稳定性 MANDATORY**：按钮绝对空间预留，不因出现/消失导致 name 位移）
- **缩进**：`padding-left: 6 + depth * 14`（递归层级）

**testid 锚点**（新概念，待架构补 ui spec 落具体）：`ws-panel`（展开态）/ `ws-rail`（收起态窄栏）/ `ws-resize`（拖宽手柄）/ `ws-collapse-btn` / `ws-expand-btn` / `ws-tab-workspace`（tab）/ `ws-switch-btn`（切换目录）/ `ws-refresh-btn`（刷新）/ `ws-path`（路径栏）/ `ws-tree`（文件树）/ `ws-item-{path}`（单 item，path 相对 workspaceDir）/ `ws-item-{path}-twisty` / `ws-item-{path}-open`（hover 打开按钮）

**E2E Use Cases**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-17.1 | 新建 session → 观察右侧 | 出现 ws-panel（默认宽 272）+ 「工作区」tab + 切换/收起按钮 + 路径栏 `…/workspaces/{sid}` + 空文件树 |
| UC-17.2 | 点 ws-collapse-btn → 面板折叠为 36px 窄栏 → 点 ws-expand-btn | 折叠成窄栏仅显示展开按钮；点展开恢复原宽 |
| UC-17.3 | 鼠标按住 ws-resize 拖动 → 释放 | 实时变化（clamp [232, 560]）；释放后宽度保持 |
| UC-17.4 | 在外部目录新建一个文件 → 回到面板 | 文件树出现新文件 item（经 fs watch → SSE） |
| UC-17.5 | 刷新页面 | ws-panel 宽度/收起态保持（localStorage 持久化） |

---

### 3.2 初始目录 + 持久化 [v0.0.17]

**描述**：每个 session 创建时自动在全局 data dir 下建一个独立工作目录 `data_dir/workspaces/{sessionId}` 作为默认 workspaceDir；Session schema 加 `workspaceDir: string` 字段持久化（落 `<root>/session/<id>.json`）；用户可随时切换（见 §3.3）。

**优先级**：P0

**用户故事**：作为对话用户，我希望每个 session 自动有一个独立工作目录（无需每次手动选），LLM 的工具调用默认在这个目录下工作；切换目录后重开 session 仍是新目录。

**产品行为**：
- **创建 session 时**：后端建目录 `data_dir/workspaces/{sessionId}`（若已存在不报错，幂等）→ 写入 `session.workspaceDir`
- **历史 session（无 workspaceDir）**：兼容回退——读取时若缺失按同样规则补建并回填（lazy 修复）
- **持久化**：`workspaceDir` 进 Session schema（string，required: true，新 session 必填）；落盘 json
- **LLM 工具消费**：loop 构造期 `SessionConfig.workdir = session.workspaceDir`，bash/file 工具默认根 = workdir（**沿用现有机制**）
- **reminder 消费**：workspace provider 读 SessionConfig.workdir（即 session.workspaceDir，见 §3.5）

**约束**：
- 目录名 = sessionId（ULID），全局唯一，不冲突
- 不在本版本做「全局默认目录配置项」（用户要换就点切换）

**E2E Use Cases**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-17.6 | 新建 session → 查 `data_dir/workspaces/{sid}` | 目录存在；`session.workspaceDir` 字段 = 该绝对路径；落盘 json 含该字段 |
| UC-17.7 | 切换目录到 `/tmp/myproj` → 关闭 app → 重开 → 打开该 session | workspaceDir 仍是 `/tmp/myproj`（持久化生效）；面板显示 `/tmp/myproj` 内容 |
| UC-17.8 | 打开一个历史（无 workspaceDir）session | 自动补建 `data_dir/workspaces/{oldSid}` + 回填字段；面板正常显示 |

---

### 3.3 切换工作区目录（系统原生 dialog）[v0.0.17]

**描述**：用户点切换按钮 → 后端 spawn OS 原生选目录对话框（macOS `osascript -e 'choose folder'` / Windows PowerShell `FolderBrowserDialog` / Linux `zenity --file-selection --directory` 或 `kdialog --getexistingdirectory`）→ 用户选/建目录 → 返回真实路径 → 更新 session.workspaceDir + 重启 watch。

**优先级**：P0

**用户故事**：作为对话用户，我希望用熟悉的系统文件选择器切到我的项目目录（能直接在 dialog 里新建文件夹），以便让 session 工作在我真实的项目上。

**产品行为**：
- 点 `ws-switch-btn` → 前端调 `GET /workspace/pick-directory?currentDir={当前 workspaceDir}` → 后端 spawn 原生 dialog → 返回 `{ path: string }` 或 `{ path: null }`（用户取消）
- 前端拿到新 path → 调 `PUT /session/:id { workspaceDir: path }` → 后端更新 session + 重启 watch（取消旧 watch 换新，见 §3.4）
- 前端面板刷新（GET 新文件树）+ 路径栏更新
- **支持新建文件夹**：macOS osascript / Windows FolderBrowserDialog / Linux zenity 均原生支持
- **取消**：用户点取消 → 后端返 null → 前端无操作（不报错）

**约束**：本应用是本地 desktop 起本地 server，dialog 在本地弹；Linux 需 zenity 或 kdialog 至少其一（缺失则报错提示用户安装）。

**E2E Use Cases**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-17.9 | 点 ws-switch-btn → 系统弹原生选目录 dialog → 选 `/Users/me/project` → 确认 | 面板路径栏更新为 `/Users/me/project`；文件树换内容；旧 watch 取消新 watch 启动；session.workspaceDir 持久化 |
| UC-17.10 | 点 ws-switch-btn → dialog 内新建文件夹 `sub` → 选 `sub` → 确认 | 新目录被创建并设为 workspaceDir；面板显示空文件树 |
| UC-17.11 | 点 ws-switch-btn → 点取消 | 无变化（路径栏/文件树/watch 均不动） |

---

### 3.4 workspace 文件监听 + 新 event [v0.0.17]

**描述**：新建后端 `SessionWorkspaceManager`（概念新，待架构补 tech spec），用 chokidar fs watch 监听每个 active session 的 workspaceDir；文件变化（add/change/unlink/addDir/unlinkDir）发新 SessionEvent `session_workspace_file_changed`；复用 `session_panel` SSE topic 推前端；切目录换 watch；手动刷新按钮兜底。

**优先级**：P0

**用户故事**：作为对话用户，我希望在面板里实时看到工作目录的文件变化（外部新增/修改/删除自动反映）；即使监听漏了，点刷新也能立即同步。

**产品行为**：
- **自动 watch**：session 到前台（前端 subscribe session_panel）→ 后端启动该 session 的 watch（chokidar watch workspaceDir，ignore `node_modules` / `.git`）→ 文件变化构造 event emit
- **event 流**：fs change → SessionWorkspaceManager.handleFsEvent → 构造 `session_workspace_file_changed` event（data: `{ path: 相对路径, kind: "add"|"change"|"unlink"|"addDir"|"unlinkDir" }`）→ bus.emit `session_id:<sid>` → SSE 推 session_panel 订阅方 → 前端 chat-slice reducer 更新文件树
- **切目录换 watch**：用户切换 workspaceDir → 后端先 `stopWatch(sid)`（取消旧 watch）→ 更新 session → `startWatch(sid, newDir)`
- **前台读 API 再监听**：session 切到前台时，前端先 GET `/session/:id/workspace/tree`（拿最新 workspaceDir + 全量文件树）渲染，再靠 SSE 增量更新（**保证切走期间的变化能被 API 补回**）
- **手动刷新**：点 `ws-refresh-btn` → 前端 GET `/session/:id/workspace/tree` 重拉全量树（兜底 fs watch 漏报）
- **watcher 生命周期**：session 删除 → stopWatch；app shutdown → 全部 stopWatch
- **watcher 常驻**：每个 active session 一个 watcher，不随前端订阅启停（避免切来切去抖动）

**新 event 定义**（产品语义，技术细节归架构）：type `session_workspace_file_changed`（命名遵循现有 snake_case 惯例，req 写的 kebab-case 在 spec 显式校正）；触发 = fs watcher 检测到 add/change/unlink/addDir/unlinkDir；data = `{ path: 相对 workspaceDir, kind }`；复用 `session_panel` topic，前端 chat-slice reducer 加新 case。

**约束**：跨平台 watch 边缘（NFS/远程/万级文件量）不保证实时，手动刷新兜底；ignore glob 默认 `node_modules` / `.git`（不暴露配置 UI）。

**E2E Use Cases**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-17.12 | 打开 session（workspace 已 watch）→ 外部 `touch new.txt` → 观察面板 | new.txt 自动出现在文件树（经 SSE） |
| UC-17.13 | 外部 `rm old.txt` → 观察面板 → 点 ws-refresh-btn | old.txt 自动消失（SSE）；即使没消失，点刷新后必然消失 |
| UC-17.14 | session A 前台 → 切到 B → 在外部改 A 的文件 → 切回 A | 切回时先 GET tree（含外部改动）渲染，再继续 watch |
| UC-17.15 | 切换 workspaceDir 到新目录 → 外部 touch 新文件 | 旧目录的 watch 已停（旧目录变化不推）；新目录的 watch 工作（新文件变化推） |

---

### 3.5 workspace system reminder（接线现有 provider）[v0.0.17]

**描述**：不新增 provider，接线现有 `workspace` provider（priority 700）读 `session.workspaceDir`。链路：`session.workspaceDir`（持久化字段）→ loop 构造期填入 `SessionConfig.workdir` → workspace provider 读 `config.workdir` → 生成 `Working directory: <wd>, git branch: <branch>.`。env（priority 900）+ time（priority 800）已可用，组合成「workspace + env + time」提醒，每 turn 注入最后一条 user message（保 prompt cache）。

**优先级**：P0

**用户故事**：作为 LLM，我希望每轮对话都被告知「当前工作目录、环境、日期」，以便我的工具调用（bash/file）落在正确目录、感知环境。

**产品行为**：
- **零新增 provider**：现有 env/time/workspace 三个 provider 都在 `rocky_context` plugin，扩展点 `system_reminder`（ordered），无需新增
- **接线点**：loop 构造 SessionConfig 时 `workdir = session.workspaceDir`（架构落具体）
- **切换目录后**：下一轮 ingest 注入的 reminder workspace 自动反映新路径（无需用户重启 session）
- **time 保日期精度**：不破 prompt cache（明确不提升到时分）
- **注入规则沿用**（`[P0]system_reminder.md` §4）：只看 ingest 最后一条且必须 role==='user'，加 reminder content block 到末尾，落库持久化

**约束**：本版本不改 reminder 注入机制、不改 provider 实现，只在 SessionConfig 构造期接线；不聚合 env+time+workspace 成单条 reminder（保持分立 provider）。

**E2E Use Cases**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-17.16 | 新建 session → 发消息「你在哪」 → 看 LLM 回复 + transcript | LLM 回复含 workspaceDir 路径；transcript 最后一条 user message 的末尾 content block 含 `Working directory: …/workspaces/{sid}` |
| UC-17.17 | 切换 workspaceDir 到 `/tmp/proj` → 发消息 → 看 transcript | 新 ingest 的 user message reminder 含 `Working directory: /tmp/proj`（旧 message 的 reminder 不动） |

---

### 3.6 打开文件/文件夹（后端 spawn + 白名单）[v0.0.17]

**描述**：workspace 面板 item hover 显示「打开」按钮（文件夹=打开文件夹，文件=打开文件）。点击 → 前端调 `POST /session/:id/workspace/open { path, kind }` → 后端 spawn（mac `open` / win `explorer`+`start` / linux `xdg-open`）+ 路径白名单校验（必须 resolve 后在 workspaceDir 内）。

**优先级**：P1

**用户故事**：作为对话用户，我希望直接在面板里点开文件/文件夹（用系统默认应用），不必手动切到文件管理器找。

**产品行为**：
- hover `.ws-item` → 「打开」按钮（`.ws-act`）出现（opacity 0→1，**布局稳定性**：绝对空间预留）
- 文件夹：button title「打开文件夹」+ external icon；点击 → `POST open { path: 相对路径, kind: "folder" }` → 后端 spawn 平台对应命令打开目录
- 文件：button title「打开文件」+ external icon；点击 → `POST open { path, kind: "file" }` → 后端 spawn 用系统默认应用打开
- **安全**：path 必须在 `session.workspaceDir` 内（`path.resolve(workspaceDir, relPath)` 后 `startsWith(workspaceDir)` 校验，防目录穿越）；越界 → 400 拒绝
- **错误**：spawn 失败（如 Linux 无 xdg-open）→ 返回错误，前端 toast 提示

**平台命令**（架构落具体，PRD 仅记录语义）：macOS `open` / Windows folder `explorer` + file `start ""` / Linux `xdg-open`。

**E2E Use Cases**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-17.18 | hover 文件夹 item → 点「打开文件夹」 | 系统 Finder/Explorer/文件管理器打开该目录 |
| UC-17.19 | hover 文件 item → 点「打开文件」 | 系统默认应用打开该文件（如 .txt 用文本编辑器） |
| UC-17.20 | 构造恶意 path `../../etc/passwd` → POST open | 400 拒绝（白名单：resolve 后不在 workspaceDir 内） |

---

## 4. 对齐 ui/tech spec 声明（MANDATORY）

### 4.1 引用的已有概念（对齐，无矛盾）

| 概念 | spec 位置 | 对齐点 |
|------|----------|--------|
| chat-page 两栏布局 | `specs/ui/components/chat-page/_overview.md §1` | workspace 是**右侧新增第 3 栏**，不动现有两栏 |
| Session schema + createSession | `specs/tech/agent/session/[P0]session_store.md §2/§4` | workspaceDir 是 Session **新字段**，进 schema + createSession 入参 |
| SessionEvent + session_panel topic | `specs/tech/agent/session/[P0]session_event.md §2/§4` | 新 event 加入联合，**复用 session_panel topic** |
| system_reminder EP + 5 内置 provider | `specs/tech/agent/context/[P0]system_reminder.md §3` + `[P0]extension point and implementations.md §3.6` | workspace provider 已存在，**接线读 session.workspaceDir**，零新增 provider |
| reminder 注入规则 | `[P0]system_reminder.md §4` | 沿用，不改注入机制 |
| SessionConfig.workdir | `[P0]system_reminder.md` + `context-types.ts` | loop 构造期 `workdir = session.workspaceDir`（沿用，不新增字段语义） |
| 设计稿视觉契约 | `reqs/v0.0.17/mqnbr367-easy-opc-chat-v9a.html §209-242 + §706-800` | testid + 产品行为对齐；coder 实现前按 _conventions §9 填组件 spec「视觉基线」 |

### 4.2 新概念（待架构阶段补 ui/tech spec）

| 新概念 | spec 落点（架构阶段） | PRD 引用声明 |
|--------|----------------------|-------------|
| **WorkspacePanel UI 组件**（section + 子组件 tree/tab/resize-handle/path-bar/switch-dialog） | `specs/ui/components/chat-page/component-workspace-panel.md`（新建）+ 改 `_overview.md §1` 两栏→三栏（含 ws-panel） | §3.1 引用，视觉基线按设计稿 §209-242 |
| **SessionWorkspaceManager**（后端 fs watch + event 发射 + watcher 生命周期 + 切目录换 watch） | `specs/tech/agent/session/[P0]session_workspace_manager.md`（新建） | §3.4 引用 |
| **Session.workspaceDir 字段** + 初始目录策略 + 持久化 | `specs/tech/agent/session/[P0]session_workspace.md`（新建）+ 改 `[P0]session_store.md §2`（加字段）+ `[P0]session_state.md`（createSession 入参） | §3.2 引用 |
| **新 event `session_workspace_file_changed`** | 改 `specs/tech/agent/session/[P0]session_event.md §2/§3`（加 type + interface + 触发时机） | §3.4 引用 |
| **新 API**：`GET /session/:id/workspace/tree` / `POST /session/:id/workspace/open` / `GET /workspace/pick-directory` / 改 `POST /session`（workspaceDir 入参）/ 改 `PUT /session/:id`（可更新 workspaceDir） | `specs/api/overall/` + version_logs/v0.0.17/change_log.md（架构产出） | §3.1/3.2/3.3/3.4/3.6 引用 |
| **chokidar 依赖** | tech spec（SessionWorkspaceManager）声明 | §3.4 引用 |

> **PRD 是产品视角**（是什么 + 用户路径），不写技术实现细节（fs watch 架构 / manager 字段级 / spawn 命令分支 / SSE reducer 实现 等归架构）。

---

## 5. 不覆盖项（future）

| 不覆盖项 | 理由 |
|---------|------|
| 跨平台 fs watch 边缘（NFS / 远程目录 / 万级文件量） | 本版本聚焦本地常规目录；监听不到时手动刷新兜底 |
| 多 workspace tab（设计稿预留 wsIdx 切换） | 本版本仅 1 个 tab；UI 结构留扩展（wsIdx state 已预留） |
| workspace ignore glob 配置 UI | 默认 ignore `node_modules` / `.git`，不暴露配置 |
| 文件内容编辑/上传 | 非本版本（只读 + 打开外部） |
| time provider 时分精度 | 破 prompt cache，明确不做（保日期精度） |
| 全局默认 workspaceDir 配置项 | 本版本每 session 自动建独立目录 |
| workspace 文件搜索/过滤 / 符号链接跟随策略 | 本版本仅树形浏览 + resolve+startsWith 简单校验 |

---

## 6. 版本对齐检查

- **概念先行**：workspace 是新概念，架构阶段必须先落 `specs/ui/components/chat-page/component-workspace-panel.md` + `specs/tech/agent/session/[P0]session_workspace.md` + `[P0]session_workspace_manager.md`，再编码。
- **PRD ↔ ui/tech spec 对齐**：§4.1 已核对，引用的组件/布局/数据概念/接口语义与已有 spec 一致；新概念已在 §4.2 声明待架构补 spec。
- **关键用户路径 = 测试最低覆盖要求**：§2 六条路径（A-F），每条至少 1 个 API case，视情况加 E2E case。具体映射在 `states/v0.0.17/verify/test-plan.md` 落。
- **视觉保真度门禁（设计稿存在，MANDATORY）**：本版本带设计稿（`mqnbr367-easy-opc-chat-v9a.html` §209-242 + §706-800），verifier 须用 `vision_check.py compare` 逐维度（layout/font/border/color）对照实现截图与设计稿，明显偏差建 BUG（标「视觉保真」）。
