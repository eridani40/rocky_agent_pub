# v0.0.263 tech change log — workspace symlink 浏览 + 内置 editor 放开格式限制

> 对应需求：`reqs/[working] v0.0.263.workspace-symlink/req.md`（用户可感知的行为改动 → 走完整 PRD）。
> PRD：`specs/prd/version_logs/v0.0.263.workspace_symlink_browse/prd.md`。
> 权威契约：`specs/tech/version_logs/v0.0.263/change_plan.md`（method 级 21 行表，frozen）。

## 变更摘要

### 需求与动机

workspace 文件树两个能力缺口：① **symlink 不能浏览**——workspace 内用户放置的 symlink（如指向外部共享目录）在 tree 里不可见或打开被 400 拒绝（旧白名单校验一刀切拒绝越界），「用户显式放置 = 授权」语义未落地；② **内置 editor 格式白名单过窄**——`handleOpen` 只用 `isBuiltinEditable` 12 格式判定，`.py`/`.png`/无扩展名等一律走系统打开，用户无法在 app 内预览任意本地文件。

### 方案（4 口子裁决，详见 change_plan「架构决策记录」）

1. **授权模型 = whitelistResolve step2 链式授权解析**（决策①）：step1 字符串前缀检查保留（挡 `../` + 绝对路径注入）；step2 从 realRoot 出发逐段 resolve，每段 `lstatSync` 判 symlink → 命中则 `realpathSync` 授权该目标为继续解析的根。workspace 内存在的 symlink = 用户放置 = 授权（目标可在 workspace 外）；4 处调用点（tree/open/watch/file）自动统一。
2. **isBuiltinEditable 保留原 12 格式语义**（决策②）：该函数继续服务 link-target.ts markdown 链接点击分发（v0.0.253 契约）；新增 `isRemoteLinkPath`（.url 判定）+ workspace handleOpen 改用「本地文件一律进 editor && !isRemoteLinkPath」新判定。
3. **远程链接走前端浏览器能力**（决策③）：handleOpen 遇 `.url` → readWorkspaceFile → parseUrlFileContent 提取 http/https → openLinkTarget(url)（Electron shell.openExternal / window.open fallback）；嗅探失败返回 `{opened:false}` → 降级 editor。后端 open 端点 kind 保持 file|folder 不变。
4. **whitelistResolve 拆独立文件**（决策④）：`session-workspace-path.ts`（新文件），session-workspace.ts 已 298 行（接近 300 上限）。

### T1 — 后端链式授权 + tree symlink 字段

- **`session-workspace-path.ts` NEW**：whitelistResolve 迁出 + step2 改链式授权解析。返回 `{ ok: true, realAbs } / { ok: false, reason: 'traversal'|'not_found' }` 语义不变；无 symlink 段时结果与旧 realpathSync 等价（普通路径零行为变化）；lstatSync 失败（broken symlink）→ not_found。
- **`session-workspace.ts`**：WsTreeNode 加可选 `isSymlink?: boolean` + `linkTarget?: string`；handleWorkspaceTree 节点循环 `lstatSync(absChild).isSymbolicLink()` 判 isSymlink + `realpathSync` 算 linkTarget（仅 symlink 节点）；type 仍由 statSync 跟随后的真实类型判定（`'file'|'dir'` 枚举不变）；过滤规则按节点名不变。
- **`session-workspace-watch.ts` / `session-workspace-file.ts`**：仅 import 路径改到 `./session-workspace-path`（json 保持从 session-workspace import），零逻辑改动（resolveWatchTarget / resolveWsFilePath 走链式后自动放行 symlink 目录/文件）。

### T2 — 前端 handleOpen 新语义 + symlink 渲染 + 二进制降级

- **`file-format.ts`**：新增 `isRemoteLinkPath(path)`（`.url` 大小写不敏感 → true）；isBuiltinEditable 判定逻辑不变（仅更新头注释说明 workspace 打开不再用它）。
- **`remote-link.ts` NEW**：`parseUrlFileContent(content)`（正则 `/(https?:\/\/[^\s]+)/i` 首个命中 → URL；无命中 → null）+ `openRemoteLink(sessionId, path)`（readWorkspaceFile → parse → openLinkTarget(url)；嗅探失败返 `{opened:false}`）。
- **`section-workspace-panel.tsx` handleOpen**：`node.type === 'file'` → ① isRemoteLinkPath → openRemoteLink（嗅探失败降级 setFileEditorTarget）② 否则本地文件一律进 editor（`format: getFileFormat(node.path) ?? 'txt'`，fallback 从 'md' 改 'txt'）；`node.type === 'dir'` → openWorkspaceItem kind='folder' 不变（symlink dir 后端链式放行）。
- **`component-ws-tree-item.tsx`**：isSymlink → ① 图标叠加 link 角标（absolute 右上角不占位）② tooltip `→ {linkTarget}`（i18n `workspace.tree.symlinkTooltip`）③ 交互不变（symlink→dir 有 twisty；hover 打开照常）。
- **`component-ws-file-editor.tsx`**：readWorkspaceFile 后 `looksBinary(content)`（NUL `\u0000` 或替换符 `\uFFFD` 占比 >5%）→ 占位 pill「二进制文件无法预览」（i18n `workspace.mdEditor.binaryUnsupported`），不渲染 editor modal。
- **i18n**：`workspace.tree.symlinkTooltip`（"→ {{target}}"）+ `workspace.mdEditor.binaryUnsupported`（en "Binary file cannot be previewed" / zh "二进制文件无法预览"）双语同步。

## 设计决策

- **链式授权而非持久化授权状态 / 仅 tree 放行**：symlink 的存在本身就是用户授权声明（后端无法区分「用户点击」vs「注入请求」，但 workspace 内 symlink 必然由用户/agent 放置）；持久化「已授权根列表」请求间状态泄漏 + 复杂度高；仅 tree 放行 = 半吊子（open/watch/file 仍 400）。链式实时解析天然满足「子路径在授权根内校验」——用户逐层展开时 path 连续经过 symlink 段。
- **isBuiltinEditable 保留语义（PRD 表述的实现调整）**：该函数有两个消费者——workspace handleOpen（PRD 想改的）+ link-target.ts openLinkTarget local 分支（markdown 链接点击：12 格式进 viewer / 其它系统打开）。直接改会让 markdown 链接点击 .py/.png 意外进 viewer，超出 PRD 范围。产品语义不变：workspace 文件打开 = 本地一律 editor / 远程浏览器；markdown 链接点击 = 保持 v0.0.253。
- **远程链接走前端浏览器能力**：URL 打开是前端平台能力（link-target.ts v0.0.253 已有 IPC 通道）；后端 open 端点保持纯文件路径语义（白名单模型不被 URL 字符串污染）；.url 内容读取已由 file 端点（授权根）覆盖。否决后端 kind='link'（白名单语义破坏 + 平台 open URL 分支重复实现）。
- **format fallback 'md' → 'txt'**：不支持的格式 → plain view `<pre>` 文本渲染，防止二进制/未知格式被当作 markdown 渲染（配合 looksBinary 降级双保险）。
- **looksBinary 阈值 >5%**：任一 `\u0000` 或 `\uFFFD` 占比 >5% 才判二进制（文本文件含正常 Unicode 替换符罕见，阈值保守防误判）。
- **symlink 角标 absolute 叠加不占位**：图标槽位 `.ws-ico` 固定宽 13px 不变，link 角标 absolute 右上角叠加——布局稳定性 MANDATORY（PRD §7），不推动 name 位移。

## 代码↔spec 核实（doc-modifier 阶段 5）

| 项 | 核验 | 状态 |
|---|---|---|
| whitelistResolve 链式授权（step1 前缀 + step2 逐段 lstat→realpath） | session-workspace-path.ts（new） | ✓ |
| broken symlink（lstatSync 失败）→ not_found | session-workspace-path.ts | ✓ |
| 返回 `{ ok, realAbs } / { ok: false, reason: 'traversal'\|'not_found' }` 语义不变 | session-workspace-path.ts | ✓ |
| 无 symlink 段时与旧 realpathSync 等价（普通路径零行为变化） | session-workspace-path.ts（既有测试保持绿） | ✓ |
| WsTreeNode 加 `isSymlink?: boolean` + `linkTarget?: string`（可选缺省兼容） | session-workspace.ts + workspace-types.ts | ✓ |
| type 保持 statSync 跟随后的真实类型（'file'\|'dir' 枚举不变） | session-workspace.ts handleWorkspaceTree | ✓ |
| linkTarget 仅 symlink 节点计算（realpathSync 一次） | session-workspace.ts | ✓ |
| 过滤规则按节点名不变（与 isSymlink 无关） | session-workspace.ts | ✓ |
| watch/file import 改到 session-workspace-path（json 保持） | session-workspace-watch.ts + session-workspace-file.ts | ✓ |
| isRemoteLinkPath 纯函数（.url 大小写不敏感） | file-format.ts | ✓ |
| isBuiltinEditable 判定逻辑不变（仅注释更新） | file-format.ts | ✓ |
| parseUrlFileContent 正则首个 http/https 命中 | remote-link.ts | ✓ |
| openRemoteLink 嗅探失败返 {opened:false} 供降级 | remote-link.ts | ✓ |
| handleOpen：本地文件一律进 editor（format ?? 'txt'） | section-workspace-panel.tsx:171-190 | ✓ |
| handleOpen：.url → openRemoteLink（失败降级 editor） | section-workspace-panel.tsx | ✓ |
| handleOpen：dir（含 symlink→dir）→ openWorkspaceItem 不变 | section-workspace-panel.tsx | ✓ |
| symlink 角标 absolute 叠加（data-testid=symlink-badge-{path}，不占位） | component-ws-tree-item.tsx | ✓ |
| tooltip title `→ {linkTarget}`（i18n symlinkTooltip） | component-ws-tree-item.tsx | ✓ |
| looksBinary（\u0000/\uFFFD >5%）→ 占位 pill 不渲染 modal | component-ws-file-editor.tsx | ✓ |
| i18n symlinkTooltip + binaryUnsupported 双语同步 | en/chat.json:167,181 + zh-CN/chat.json:167,181 | ✓ |
| 2 条后端测试预期反转（symlink 越界 400 → 200）= 预期行为变更 | session-workspace.test.ts L247/L391 | ✓（变更声明） |

**偏离记录**：
- **isBuiltinEditable 语义保留**（change_plan 架构决策②明确记录）——PRD §5「isBuiltinEditable 语义变更」表述的实现差异，change_plan 冻结 + 已上报 orchestrator。非静默偏离。
- ariaLabel 嵌套键（v0.0.262 遗留 Minor，本版本无关）。
- 无其他静默偏离；spec（api §2.6 / session_workspace §6 / manager watch 策略 / component-workspace-panel §4.4+§6.5 / app-guide）已按实际实现同步。

## 文档同步（doc-modifier 阶段 5 已完成）

- `specs/api/overall/04-agent-session.md`：§2.6.1 WsTreeNode 补 `isSymlink?: boolean` + `linkTarget?: string`；§2.6 安全段补「workspace 内存在的 symlink = 用户放置 = 授权」链式授权模型（step1 前缀 + step2 逐段 lstat→realpath）；§2.6.2 补「打开语义收窄」段（本地文件不再走 open 端点；kind 保持 file|folder）；§2.6.7 补「文件打开判定（前端 handleOpen）」段（本地一律 editor / .url 浏览器 / 二进制降级）+ 安全段链式授权。
- `specs/tech/agent/session/[P0]session_workspace.md`：§6 安全补「显式浏览 symlink = 授权」链式授权语义细化；frontmatter updated；边界表补 whitelistResolve 归属行。
- `specs/tech/agent/session/[P0]session_workspace_manager.md`：§4 chokidar 配置段补「watch symlink 目录策略」（放行不 400，chokidar v4 followSymlinks 默认 true，v1 最低保证手动刷新）；frontmatter updated。
- `specs/ui/components/chat-page/component-workspace-panel.md`：§4.4 文件点击分流改 v0.0.263 新语义（本地一律 editor / .url 浏览器 / dir 系统打开 + isBuiltinEditable 保留说明 + 二进制降级）；§6.5 补 symlink 渲染基线（link 角标 + tooltip）。
- `specs/ui/overall/00-app-guide.md`：workspace 面板行补「symlink 节点浏览 + 本地文件全量进 editor」操作语义。
- frontend KB `log.md` 加 v0.0.263 条目；`index.md` ① 加「symlink 浏览 + 本地文件全量进 editor」概念行。
