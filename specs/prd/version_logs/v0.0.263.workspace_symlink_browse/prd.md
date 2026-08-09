# v0.0.263 PRD — workspace file tab 支持 symlink 浏览 + 内置 editor 放开格式限制

> 版本：v0.0.263 · 主题：workspace 文件树识别 symlink 节点（可见 + 可浏览 + 视觉区分），保留路径安全校验但不是一刀切拒绝所有外部 symlink；同时放开内置 editor 格式限制——本地文件（含普通 + symlink）一律进 editor，远程链接走浏览器。
> PRD 边界（用户裁决 2026-07-14）：本文只覆盖**用户可感知**的产品逻辑/体验/反馈；白名单授权模型的具体实现（授权根/链式校验）、watch 对 symlink 目录的处理策略、WsTreeNode 字段扩展、isBuiltinEditable 语义变更归 architect 落 `specs/tech/version_logs/v0.0.263/change_plan.md`；组件 spec 由编码期补/改 `specs/ui/components/`。PRD 不发明技术细节，只描述产品语义到可落地。
> 需求来源：`reqs/[working] v0.0.263.workspace_symlink_browse/req.md`（leader 消息）+ `states/v0.0.263/context.md`（根因定位：app.asar 逆向分析）+ **2026-08-06 用户追加**（内置 editor 放开格式限制：本地文件一律进 editor，远程链接走浏览器）

---

## 1. 背景 + 目标

### 1.1 背景（现状）

用户在 squad workspace 根目录创建了指向项目目录的 symlink（如 `rocky_agent -> <project-root>`），但 workspace file tab 无法正常浏览该 symlink 指向的内容。

**根因（app.asar 逆向分析确认，`states/v0.0.263/context.md`）**：

| 层 | 现状 | 问题 |
|---|---|---|
| 后端 `whitelistResolve`（`src/handlers/session-workspace.ts`） | 对**所有**路径做 realpath 校验：`realpathSync(abs)` 后必须仍在 `realRoot` 内 | symlink 指向 workspaceDir 外部 → 判定为「穿越攻击」→ 返回 400。**一刀切拒绝所有外部 symlink**——包括用户主动创建的合法 symlink |
| 后端 `handleWorkspaceTree` | 用 `statSync`（**跟随** symlink）判断 type，只有 `file`/`dir` 两值 | symlink 节点的「symlink 身份」天然缺失——顶层 tree 里显示成普通 dir/file（若目标存在），无任何 symlink 标记；用户展开/打开时又被 `whitelistResolve` 400 拒绝 |
| 前端 file tab（`component-ws-tree-item.tsx`） | `WsTreeNode.type: 'file' \| 'dir'` 枚举，图标只有 FileIcon/FolderIcon | 无 symlink 视觉区分，也无「不可用/需授权」提示 |

**用户可见现象**：symlink 节点在文件树中不可见（或显示为普通文件夹但点不开），无法进入 symlink 目录浏览内容。

### 1.2 目标

1. **symlink 节点可见**：file tab 文件树能识别 symlink 节点并显示。
2. **symlink-dir 可浏览**：点击进入 symlink 指向的目录，在 file tab 内浏览其内容（含子目录逐层展开）。
3. **安全性保留**：浏览 symlink 目录时仍需路径安全校验——但不是一刀切拒绝所有外部 symlink，而是「用户显式浏览 = 授权」的语义。
4. **视觉区分**：symlink 节点有独立视觉标识（图标/标注），与普通 file/dir 可区分。
5. **内置 editor 放开格式限制**：本地文件（含普通 + symlink）一律进内置 editor（不限扩展名）；远程链接（http/https）走系统浏览器。

## 2. 范围与代决（orchestrator 代 AFK 用户拍板）

### 2.1 WsTreeNode 扩展：type 保持真实类型 + 新增 isSymlink/linkTarget 字段

- **不改 `type` 枚举**（保持 `'file' | 'dir'`，= statSync 跟随 symlink 后的**真实类型**）：向后兼容（既有 API 契约/前端消费/排序规则零破坏——symlink 目录按 dir 排序、symlink 文件按 file 排序，沿用现有分组规则）。
- **新增可选字段**：
  - `isSymlink: boolean`（true = 该节点是 symlink；缺省 false 兼容旧响应）
  - `linkTarget?: string`（symlink 解析后的目标路径；仅 isSymlink=true 时有意义；供前端 tooltip/标注显示）
- **理由**：symlink 是「叠加标记」不是「新类型」——真实类型决定行为（dir 可展开/file 可打开），isSymlink 决定视觉与授权语义。

### 2.2 浏览 symlink = 用户显式授权（授权根模型）

**产品语义**：用户点击展开/打开一个 symlink 节点 = **显式授权**该 symlink 指向的目标（realpath 最终解析结果）。授权后：

- **symlink→dir**：目标目录成为「授权浏览根」，其下子路径可在 file tab 内逐层浏览（tree 展开）。
- **symlink→file**：目标文件可打开——与普通文件完全一致：本地文件一律进内置 editor（不限扩展名，见 2.3）。

**校验规则（产品语义，实现归架构期）**：

| 场景 | 规则 |
|---|---|
| 常规路径（无 symlink 段） | 现状不变：resolve + realpath + startsWith(realRoot)（防 `../` + 绝对路径注入） |
| symlink 段（用户显式浏览） | 授权该 symlink 的 realpath 目标为浏览根；其下子路径在该浏览根内校验（沿用现有 realpath 白名单逻辑，root 换成授权根） |
| 未授权越界 | **仍拒绝**：如直接 `?parent=../../etc`、直接 `?parent=<外部绝对路径>`、未先展开 symlink 就访问其目标路径 → 400（穿越攻击语义不变） |

**关键点**：授权是「用户主动点击」触发（与系统 dialog 选目录同级的用户意图），不是「任何外部路径都放行」。威胁模型区分：**被动路径穿越（文件内容/URL 注入让后端意外读写外部）仍全拒**；**主动浏览（用户点开自己创建的 symlink）放行**。

### 2.3 内置 editor 放开格式限制（本地文件一律进 editor）

**用户要求（2026-08-06 扩大）**：只要是本地文件，内置 editor 全部能打开，不再限制扩展名。

- **本地文件**（含普通文件 + symlink 文件）→ **一律进内置 editor**，不限扩展名（.md / .json / .py / .png / 无扩展名等）。
- **远程链接**（http/https，如 `.url` 快捷方式文件或未来可能的远程链接）→ 走系统浏览器打开。
- **`isBuiltinEditable` 逻辑简化**：本地文件 = true（进 editor），远程链接 = false（走浏览器）——判定从「扩展名白名单」改为「本地/远程」二元。
- **判定依据（产品语义，实现归架构期）**：本地文件 = 内容是本地数据（任意扩展名/无扩展名）；远程链接 = 指向 http/https 的链接文件（如 `.url` 快捷方式，内容为 URL）。判定可用扩展名（`.url`）+ 内容嗅探组合，具体归架构期定。
- **理由（用户裁决 2026-08-06）**：用户已显式浏览 symlink，该目录已是「授权根」，editor 读写走同一个授权根校验就够了——限制 symlink 文件进 editor 没有意义；同理，格式白名单限制普通文件进 editor 也没有意义。`GET/POST /workspace/file` 端点同样纳入授权模型（与 tree/open/watch 统一，白名单共 4 处）。

### 2.4 symlink 目录的 watch 增量（v1 尽力而为，至少手动刷新可用）

- 展开 symlink 目录时前端照常 `POST watch(path)` → 后端对授权根解析后监听（chokidar 默认 `followSymlinks=false`，直接 watch symlink 路径可能收不到目标目录增量事件——具体监听策略归架构期定）。
- **v1 最低保证**：手动刷新 / 重新展开可拉到最新内容（tree 是 readdir 实时读，不依赖 watch 增量）。
- **v1 不做**：symlink 目录内文件变化的 SSE 实时推送若无法低成本实现，可接受延迟到手动刷新（产品语义：浏览 symlink 内容是「查看快照」，实时性不承诺）。

### 2.5 视觉区分：symlink 图标 + 目标标注

- **图标**：symlink 节点用独立图标（如 link/箭头角标，或 FolderIcon/FileIcon + 小 link 角标），与普通 dir/file 明显可区分。
- **标注**：symlink 节点 hover tooltip 显示 `→ <linkTarget>`（让用户知道指向哪）；行内可加 muted 小字 `→ <basename>`（架构期定具体形态，产品语义 = 目标可见）。
- **交互不变**：dir 类 symlink 有 twisty 可展开；file 类 symlink hover 有打开按钮（与普通节点同交互，只是视觉不同 + 打开进内置 editor）。

### 2.6 broken symlink（v1 P0 不处理，标注边界）

- **有效 symlink**（目标存在）：完整支持（显示/浏览/打开）。
- **broken symlink**（目标不存在/无权限）：`statSync` 失败 → **现状继续隐藏**（v1 P0 不做；架构期评估成本后，可选做「灰显不可操作」，非 P0）。

## 3. 功能需求

### 3.1 后端：tree 返回 symlink 节点信息（P0）

**描述**：`GET /session/:id/workspace/tree` 对 symlink 节点返回 `isSymlink: true` + `linkTarget`（realpath 解析结果），type 仍为真实类型（file/dir）。

**优先级**：P0

**产品规则**：
- `lstatSync` 识别 symlink（`statSync` 跟随后判真实类型，二者配合：先 lstat 判 isSymlink，再 stat 判真实类型）。
- `linkTarget` = `realpathSync(absChild)` 最终解析结果（绝对路径）。
- `hasChildren`：symlink→dir 沿用 `dirHasChildren`（readdir 目标目录）；symlink→file 无。
- 过滤规则不变（ignore `node_modules`/`.git`——按**节点名**过滤，与是否 symlink 无关）。
- 空/不可读目录等既有错误语义不变。

### 3.2 后端：tree 展开 symlink 目录（P0 核心）

**描述**：`GET tree?parent=<symlink 相对路径>` 允许浏览 symlink 指向的目录内容。

**优先级**：P0

**产品规则**：
- 用户展开 symlink→dir 节点 → 前端 GET `?parent=<该节点 path>`（relPath 仍是相对 workspaceDir 的路径，如 `rocky_agent`）→ 后端按 2.2 授权模型放行 → 返回目标目录的直接子项。
- 返回的子项 `path` 仍为相对 workspaceDir 的相对路径（如 `rocky_agent/src/auth`）——前端 key/open 入参语义不变。
- 深层展开（symlink 目录内再展开子目录）→ 前端继续 GET `?parent=rocky_agent/src` → 后端在授权根（rocky_agent 目标）内校验放行。
- **拒绝**：未授权越界（非 symlink 段的 `../`、绝对路径注入、未展开先访问目标路径）→ 400（语义不变）。

### 3.3 后端：open 打开 symlink 目录 / 远程链接（P0）

**描述**：`POST /session/:id/workspace/open` 允许打开 symlink 目录（kind=folder）；symlink 文件本地路径进内置 editor 不走本端点（见 3.5），远程链接（http/https，如 `.url`）走系统浏览器。

**优先级**：P0

**产品规则**：
- symlink→dir 点 hover 打开 → 系统文件管理器打开目标目录（`POST /workspace/open` kind=folder）。
- symlink→file / 普通本地文件 → **进内置 editor**（本地文件一律进 editor，见 2.3）——不调本端点（editor 走 `GET/POST /workspace/file`，复用授权根）。
- 远程链接（http/https）→ 系统浏览器打开（实现归架构期：`POST /workspace/open` kind 扩展或独立路由）。
- kind 语义：dir → `folder`；远程链接 → 新 kind（如 `link`，架构期定）；本地文件不再走 open（editor 接管）。
- 白名单按 2.2 授权模型放行 symlink 段。

### 3.4 后端：watch/unwatch symlink 目录（P1 尽力而为）

**描述**：展开 symlink 目录时 `POST watch` 对 symlink 路径放行（不 400），监听策略架构期定。

**优先级**：P1（不阻塞 P0；至少保证不报错 + 手动刷新可用）

**产品规则**：
- `POST watch` 对 symlink 段按 2.2 授权模型放行（当前 `resolveWatchTarget` 同样走 `whitelistResolve` → 会 400，需同改）。
- 监听是否真正覆盖目标目录增量 = 架构期评估（chokidar followSymlinks 策略）；若成本高，v1 接受「watch 静默 no-op + 手动刷新兜底」。

### 3.5 前端：symlink 节点渲染（P0）

**描述**：file tab 渲染 symlink 节点——专用图标 + 目标标注 + 保持既有交互。

**优先级**：P0

**产品规则**：
- `WsTreeNode` 类型加 `isSymlink?: boolean` + `linkTarget?: string`（workspace-types.ts）。
- `component-ws-tree-item.tsx`：`node.isSymlink` → 渲染 symlink 图标（link 角标/专用图标）+ tooltip `→ <linkTarget>`（行内标注形态架构期定）。
- twisty：`isSymlink && type==='dir' && hasChildren` → 显示 twisty 可展开（复用现有展开链路）。
- hover 打开按钮：symlink 节点照常显示；`handleOpen` 对本地文件（含 symlink）一律进内置 editor（跳过 `openWorkspaceItem` 系统打开分支），远程链接走系统浏览器（见 3.6）。
- 排序：沿用现有规则（type 分组 + 自然序），symlink 归属真实类型分组，不加额外排序分支。
- 展开后子层渲染：复用 `TreeLevel` 递归（childrenCache 机制不变）。

### 3.6 前端：handleOpen 统一为「本地文件 → 内置 editor；远程链接 → 浏览器」（P0）

**描述**：`handleOpen` 对本地文件（含普通 + symlink）一律进内置 editor（不限扩展名）；远程链接（http/https，如 `.url`）走系统浏览器。

**优先级**：P0

**产品规则**：
- 本地文件（`node.type === 'file'`，含 symlink 文件）→ `setFileEditorTarget(...)` 进内置 editor——**不再用 `isBuiltinEditable` 扩展名白名单**（该函数/判断逻辑简化为「本地/远程」二元，见 2.3；实现层可能重命名或保留但语义改，架构期定）。
- 远程链接（http/https 目标）→ 系统浏览器打开（`openWorkspaceItem` 或独立路由，架构期定）。
- 文件夹 → 展开/系统打开逻辑不变（twisty 展开；hover 打开 → `POST /workspace/open` kind=folder）。
- editor 打开 symlink 文件时，读走 `GET /workspace/file`（复用授权根），保存走 `POST /workspace/file/save`（复用授权根）。
- **内置 editor 对任意本地文件的显示**：文本可正常预览/编辑；二进制/图片（无法按文本渲染）→ editor 内显示占位提示（如「二进制文件无法预览」）或按架构期定的降级策略（如 hex/只读），不阻塞 editor 打开语义。

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | workspace 根目录有 symlink `rocky_agent -> <project-root>` → 打开 file tab | 文件树显示 `rocky_agent` 节点，带 symlink 图标 + `→ <project-root>` 标注（tooltip 至少） |
| UC-2 | 点 `rocky_agent` 的 twisty 展开 | 展开显示项目目录内容（如 `src/`、`package.json`）；不再 400 |
| UC-3 | 在 symlink 目录内继续展开子目录（如 `rocky_agent/src`） | 逐层浏览正常，path 语义连续（`rocky_agent/src/auth`） |
| UC-4 | 点 symlink 文件（如 `rocky_agent/README.md`）hover 打开 | 进内置 editor 打开 README.md（本地文件一律进 editor，不限扩展名） |
| UC-4b | 点 symlink 文件（如 `rocky_agent/script.py`、`rocky_agent/logo.png`）hover 打开 | 同样进内置 editor（.py 文本可预览/编辑；.png 二进制 → editor 显示占位提示或降级策略，不系统打开） |
| UC-4c | 点普通文件（非 symlink，如 `src/main.py`）hover 打开 | 同样进内置 editor（**范围扩大：普通文件不再受扩展名白名单限制**） |
| UC-5 | 点 symlink 目录（如 `rocky_agent/src`）hover 打开 | 系统文件管理器打开目标目录 `src` |
| UC-5b | 点 `.url` 快捷方式文件（内容指向 http/https）hover 打开 | 走系统浏览器打开目标 URL（不进 editor） |
| UC-6 | 安全回归：直接 GET `?parent=../../etc` 或 `?parent=<外部绝对路径>`（非 symlink 授权） | 仍 400（穿越攻击拒绝，语义不变） |
| UC-7 | symlink 目录内文件变化 → 手动刷新 | 刷新后显示最新内容（v1 watch 增量尽力而为，至少刷新可用） |
| UC-8 | 回归：普通 dir/file 浏览/展开行为不变 | 与 v0.0.262 前一致（无 symlink 时零变化）；普通文件打开从「白名单拦截/系统打开」变为「一律进 editor」是本版本预期变化 |

> **AT 入选评估**：本版本是**确定性 fs + UI 渲染逻辑**（无新 LLM 不确定性板块）——tree 节点字段、授权模型、渲染分支全部可 UT 确定性覆盖。**v1 不新增 AT case**（用户铁律）。
> **UT 范围（核心）**：后端 `whitelistResolve` 授权模型（symlink 授权根放行 / 未授权越界仍拒）；`handleWorkspaceTree` symlink 节点 isSymlink/linkTarget/hasChildren；`handleWorkspaceOpen` symlink 目录放行；`handleWorkspaceFile`（GET/POST /workspace/file）symlink 授权根放行；前端 `component-ws-tree-item` symlink 图标/tooltip 渲染 + `handleOpen` 本地文件一律进 editor（含 symlink）+ 远程链接走浏览器。既有 workspace UT（`section-workspace-panel*.test.tsx` 等）回归。
> **ET 评估**：workspace 面板是既有板块（有既有 ET/UT 覆盖）。symlink 是文件树增量特性——**v1 不新增持久 ET case**，靠 UT 覆盖 + 既有 workspace 相关测试回归。若 orchestrator 判定需要，可临时真机验证 symlink 展开（非持久 case，自由心证），不落库。

## 5. 概念对齐（PRD ↔ ui/tech spec — 不发明新概念）

| PRD 引用 | 权威 spec / 归属 |
|---|---|
| tree/open/watch 端点契约（WsTreeNode type=file\|dir、白名单校验） | `specs/api/overall/04-agent-session.md` §2.6.1/2.6.2/2.6.5 |
| 路径白名单安全校验（realpath + startsWith） | `specs/tech/agent/session/[P0]session_workspace.md` §6 + `session-workspace.ts` `whitelistResolve` |
| 懒监听 watch 模型（clientId + refcount + chokidar depth:0） | `specs/tech/agent/session/[P0]session_workspace_manager.md` §3/§4/§5 |
| WorkspacePanel 文件树渲染（tree-item / twisty / hover 打开 / 排序） | `specs/ui/components/chat-page/component-workspace-panel.md` §4.3/§4.4/§4.5 + `component-ws-tree-item.tsx` |
| 内置 editor（ComponentWsFileEditor + ComponentModalMdEditor，format 分流 view） | `component-workspace-panel.md` §4.4 + `component-ws-file-editor.tsx` |
| isBuiltinEditable 判定（v0.0.241 扩展名白名单 → v0.0.263 简化为本地/远程二元） | `lib/file-format.ts` + `component-workspace-panel.md` §4.4（本版本语义变更） |

**新概念（架构期/编码期补 spec，PRD 只定义产品语义）**：

- **「授权浏览根」模型（新）**：symlink 显式浏览 = 授权其 realpath 目标为浏览根，子路径在授权根内校验。这是对 `whitelistResolve` 的扩展（非推翻）——未授权越界仍拒。**实现细节（授权根生命周期/链式 symlink/缓存）归架构期落 change_plan**。
- **WsTreeNode 字段扩展**（新）：`isSymlink` + `linkTarget` 可选字段——API spec §2.6.1 需更新 WsTreeNode 定义 + 前端 `workspace-types.ts` 同步。
- **symlink 图标/标注视觉**（新）：`component-ws-tree-item.md` 补 symlink 渲染基线（图标 + tooltip/行内标注），对齐现有 design system（不引入新设计稿）。
- **内置 editor 本地/远程二元判定**（语义变更）：`isBuiltinEditable` 从「扩展名白名单」改为「本地文件 = true / 远程链接 = false」——API 层不新增端点（editor 复用既有 `GET/POST /workspace/file` + 授权根），`lib/file-format.ts` + `component-workspace-panel.md` §4.4 需同步语义。

**与既有 spec 的已知差异（doc-modifier 阶段 5 待同步）**：

- `04-agent-session.md` §2.6.1 WsTreeNode 定义（type 枚举 + 新增 isSymlink/linkTarget）
- `[P0]session_workspace.md` §6 安全（补充「显式浏览 symlink = 授权」语义，非一刀切拒绝）
- `[P0]session_workspace_manager.md`（watch 对 symlink 目录的监听策略）
- `component-workspace-panel.md` §4.4（isBuiltinEditable 语义变更：12 格式白名单 → 本地文件一律进 editor；symlink 文件同样进 editor；远程链接走浏览器）
- `specs/ui/overall/00-app-guide.md` → 补「symlink 节点浏览 + 本地文件进 editor」操作语义

## 6. 边界 / 不做（v1）

- **内置 editor 对二进制/图片的完整渲染**：文本文件完整预览/编辑；二进制/图片 v1 显示占位提示或降级策略（不阻塞 editor 打开语义；图片 viewer / hex 视图留后续）
- **broken symlink 显示**：目标不存在的 symlink 继续隐藏（现状），灰显不可操作留后续评估
- **symlink 写入/新建/删除**：file tab 不做文件操作（现状无此能力，不新增）
- **symlink 目录实时 watch 增量**：尽力而为；v1 最低保证 = 手动刷新/重新展开可用，不承诺 SSE 实时
- **symlink 链中间段可视化**：只显示最终 linkTarget，不展开中间链
- **远程链接类型扩展**：v1 只处理 http/https（如 `.url` 快捷方式）；其它协议/远程类型留后续
- **不新增 AT/ET 持久 case**（用户铁律）：UT 覆盖
- **不改 type 枚举语义**：type 保持真实类型（file/dir），isSymlink 是叠加标记
- **不放开「未授权外部路径」**：非用户显式浏览的外部路径访问仍 400（威胁模型不变）

## 7. 验收口径

- **功能**：UC-1~8 全部成立（UT：whitelistResolve 授权模型 + tree symlink 字段 + open 放行 + workspace/file 授权根 + 前端本地文件进 editor/远程走浏览器；回归：既有 workspace UT + 无 symlink 场景零变化）
- **能力不变量**：
  - symlink 节点在文件树中**可见**（图标 + 目标标注）
  - symlink→dir **可展开浏览**（含子目录逐层），不再 400
  - **本地文件（含普通 + symlink）一律进内置 editor**（不限扩展名；二进制降级提示）
  - 远程链接（http/https）→ 系统浏览器
  - symlink 目录 hover 打开 → 系统文件管理器
  - **未授权越界仍 400**（`../../`、绝对路径注入、未显式浏览的目标路径）
- **回归不变量**：
  - 普通 dir/file 浏览/展开行为零变化（type 枚举不变，isSymlink 缺省 false）
  - 排序规则不变（symlink 归属真实类型分组）
  - 过滤规则不变（ignore node_modules/.git 按节点名）
  - watch/unwatch 既有行为（非 symlink 路径）不变
  - **普通文件打开行为变更**（白名单拦截/系统打开 → 一律进 editor）是本版本预期，非回归
- **布局稳定性**（CLAUDE.md MANDATORY）：symlink 图标/标注出现不改变 tree-item 布局（图标槽位固定宽，标注用 tooltip 或行内预留位，不推动 name 位移）
- **性能护栏**：tree 响应只加两个小字段（isSymlink/linkTarget），无额外 IO 放大（lstatSync 与 statSync 各一次，同现有 stat 成本量级）；linkTarget 仅 symlink 节点计算（realpathSync 一次）
- **视觉保真门禁**：**无设计稿** → symlink 视觉复用现有 design system（图标槽位对齐 FileIcon/FolderIcon 尺寸，标注 muted 小字）→ 本项跳过 `vision_check compare`

## 8. spec 对齐备忘（读 spec 时发现的出入，供 doc-modifier 后续修）

- `04-agent-session.md` §2.6.1 WsTreeNode 定义（type/file\|dir）需补 isSymlink/linkTarget 字段 + 安全段补「显式浏览 symlink = 授权」语义
- `[P0]session_workspace.md` §6 安全当前写「打开文件/文件夹：resolve 后必须 startsWith(workspaceDir)，防目录穿越」——需补 symlink 授权例外说明（不是推翻，是语义细化）
- `component-workspace-panel.md` §4.4「文件点击分流（isBuiltinEditable 拦截）」——需改为「本地文件一律进 editor（不限扩展名，含 symlink）；远程链接走浏览器」
- `lib/file-format.ts`（isBuiltinEditable 12 格式白名单）——语义变更：本地/远程二元；12 格式 format 分类仍可用于 editor 内 view 分流（md→markdown 渲染 / structured→pre / 其它→文本/降级）
- `component-ws-tree-item.tsx` 头注释视觉基线引用 §6.5——symlink 图标归属待补（编码期随组件 spec 一起落）

## 9. 版本

**v0.0.263** — workspace file tab 支持 symlink 浏览 + 内置 editor 放开格式限制：文件树识别 symlink 节点（isSymlink + linkTarget 字段，type 保持真实类型）；symlink→dir 可展开浏览（用户显式浏览 = 授权其 realpath 目标为浏览根，子路径在授权根内校验；未授权越界仍 400）；本地文件（含普通 + symlink）一律进内置 editor（不限扩展名），远程链接（http/https）走系统浏览器；`GET/POST /workspace/file` 纳入授权模型（白名单共 4 处统一）；symlink 节点视觉区分（图标 + 目标标注）。详见本 PRD + change_plan（architect 落 `specs/tech/version_logs/v0.0.263/change_plan.md`）。
