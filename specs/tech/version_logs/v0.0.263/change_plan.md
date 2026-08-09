# v0.0.263 变更计划书 — workspace symlink 浏览 + 内置 editor 放开格式限制

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD：`specs/prd/version_logs/v0.0.263.workspace_symlink_browse/prd.md`。版本上下文：`states/v0.0.263/context.md`。
> **架构期裁决**（详见「架构决策记录」）：① 授权模型 = `whitelistResolve` step2 改「链式授权解析」（workspace 内存在的 symlink = 用户放置 = 授权，4 处调用点自动统一）；② `isBuiltinEditable` **保留原 12 格式语义**（link-target 连锁），新增 `isRemoteLinkPath` + workspace handleOpen 改用「本地文件一律进 editor」新判定；③ 远程链接打开走前端浏览器能力（Electron shell.openExternal），后端 open 端点不加 kind='link'；④ `whitelistResolve` 拆到独立文件（session-workspace.ts 已 298 行，加改动超 300 硬限）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（workspace / ui-ws） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| workspace | app/server/src/handlers/session-workspace-path.ts（新） | whitelistResolve() | 新增（从 session-workspace.ts 迁出 + 改造） | 路径白名单校验，step2 改为**链式授权解析**：step1 字符串前缀检查不变（挡 `../` + 绝对路径注入）；step2 从 realRoot 出发**逐段** resolve——每段 `lstatSync(cur).isSymbolicLink()` 为 true 则 `cur = realpathSync(cur)`（授权该 symlink 目标为继续解析的根），最终 realAbs = 链式解析结果。返回 `{ ok: true, realAbs } / { ok: false, reason: 'traversal'|'not_found' }` 语义不变 | MUST step1 前缀检查原样保留（未授权越界 `../../`、绝对路径注入仍 traversal）；MUST 无 symlink 段时结果与旧 realpathSync 等价（普通路径零行为变化）；MUST lstatSync 失败（broken symlink）→ not_found；MUST 保留 caller 先 realpath workspaceDir 再传 realRoot 的约定 | PRD §2.2（授权根模型）/§3.2/UC-6；[P0]session_workspace.md §6（doc-modifier 补「显式浏览 symlink = 授权」语义） | +22/-18（迁移净 +4） |
| workspace | app/server/src/handlers/session-workspace.ts | whitelistResolve（迁出） | 删除 | 从本文件移除 whitelistResolve + 其 import（realpathSync/sep 等），改从新文件 `session-workspace-path.ts` import | MUST 不遗留死代码；MUST json() 留在本文件（watch/file 继续从本文件 import json） | 行 1；文件 ≤300 行硬限制（本文件现 298 行） | -20 |
| workspace | app/server/src/handlers/session-workspace.ts | WsTreeNode interface | 修改 | 新增可选字段 `isSymlink?: boolean`（true = 该节点是 symlink）+ `linkTarget?: string`（realpath 解析的绝对路径；仅 isSymlink=true 时有意义）。type 枚举 `'file'\|'dir'` **不变**（真实类型） | MUST 可选字段缺省 false/undefined 时旧响应兼容（既有 API 契约/前端消费零破坏）；MUST type 保持 statSync 跟随后的真实类型 | PRD §2.1/§3.1；api §2.6.1（doc-modifier 补字段） | +2 |
| workspace | app/server/src/handlers/session-workspace.ts | handleWorkspaceTree() | 修改 | 节点循环加 symlink 识别：`lstatSync(absChild).isSymbolicLink()` 判 isSymlink；isSymlink=true 时 `linkTarget = realpathSync(absChild)`（catch 失败 → 跳过该节点，broken symlink 现状隐藏语义）；`type` 仍由 `statSync(absChild).isDirectory()` 判定（跟随 symlink） | MUST lstatSync/statSync 各一次（性能护栏：同现有 stat 成本量级）；MUST linkTarget 仅 symlink 节点计算（realpathSync 一次）；MUST 过滤规则（IGNORED_NAMES）按节点名不变；MUST hasChildren 对 symlink→dir 沿用 dirHasChildren | PRD §3.1/§7 性能护栏；UC-1 | +10 |
| workspace | app/server/src/handlers/session-workspace-watch.ts | import 更新 | 修改 | `whitelistResolve` import 路径从 `./session-workspace` 改到 `./session-workspace-path`（json 保持从 session-workspace import） | MUST 无逻辑改动（resolveWatchTarget 走链式后自动放行 symlink 目录） | 行 1；PRD §3.4（watch 放行不 400，v1 尽力而为） | +0/-1 |
| workspace | app/server/src/handlers/session-workspace-file.ts | import 更新 | 修改 | `whitelistResolve` import 路径改到 `./session-workspace-path`（json 保持）；`resolveWsFilePath` 无逻辑改动（链式后自动放行 symlink 文件读/写） | MUST 无逻辑改动 | 行 1；PRD §2.3/§3.6（file 端点纳入授权模型第 4 处） | +0/-1 |
| ui-ws | app/web/src/lib/file-format.ts | isRemoteLinkPath() | 新增 | 远程链接判定纯函数：`path` 扩展名 `.url`（大小写不敏感，basename 处理同 getFileFormat）→ true；其余 → false。v1 只处理 .url（PRD §6 边界） | MUST 纯函数无 IO（内容嗅探在 openRemoteLink 异步做）；MUST 与 isBuiltinEditable 独立（不改变 12 格式判定） | PRD §2.3/§6（远程链接类型扩展 v1 只 http/https） | +12 |
| ui-ws | app/web/src/lib/file-format.ts | isBuiltinEditable() | 修改 | **保留原 12 格式白名单语义不变**（link-target.ts + getCategory 生态消费，见架构决策②）——仅更新头注释说明「workspace 文件树打开不再用本函数判定，改用 isRemoteLinkPath + 本地一律进 editor」 | MUST 不改判定逻辑（link-target.test.ts 断言 `.py→false`/`.png→false` 保持）；MUST 不删 getFileFormat（editor 内 format 分流仍用） | 架构决策②；link-target.ts local 分支 | +2 |
| ui-ws | app/web/src/lib/remote-link.ts（新） | parseUrlFileContent() | 新增 | 纯函数：从 .url 文件内容提取 http/https URL——正则 `/(https?:\/\/[^\s]+)/i` 首个命中 → URL；无命中 → null（降级 editor） | MUST 只提取 http/https（危险协议不提取——openLinkTarget 内部另有 isDangerousScheme 拦截，双保险） | PRD §2.3/§3.6（内容嗅探） | +12 |
| ui-ws | app/web/src/lib/remote-link.ts（新） | openRemoteLink() | 新增 | 异步：`readWorkspaceFile(sessionId, {path})` → `parseUrlFileContent(content)` → 命中 URL → `openLinkTarget(url)`（web 分支：Electron shell.openExternal / 浏览器 window.open fallback）；null（嗅探失败）→ 抛特殊错误或返 `{ opened: false }` 供 caller 降级 editor | MUST 走 link-target.ts openLinkTarget（复用平台能力，不新开 IPC）；MUST 嗅探失败不静默——返 opened:false 让 handleOpen 降级 editor | PRD §3.6/UC-5b；link-target.ts openLinkTarget | +18 |
| ui-ws | app/web/src/components/chat-page/workspace-types.ts | WsTreeNode interface | 修改 | 新增可选字段 `isSymlink?: boolean` + `linkTarget?: string`（对齐后端 WsTreeNode） | MUST 可选缺省（旧响应/测试零破坏） | PRD §3.5；行 3 | +2 |
| ui-ws | app/web/src/components/chat-page/component-ws-tree-item.tsx | ComponentWsTreeItem() | 修改 | `node.isSymlink` → ① 专用图标：现有 FileIcon/FolderIcon 基础上叠加小 link 角标（absolute 右上角，不占位；图标槽位 .ws-ico 固定宽 13px 不变）② tooltip：`title={node.linkTarget ? \`→ \${node.linkTarget}\` : undefined}`（hover 显示目标）③ 交互不变（isSymlink && type==='dir' 有 twisty；hover 打开按钮照常） | MUST 布局稳定性：link 角标 absolute 叠加不推动 name 位移（PRD §7 布局稳定性 MANDATORY）；MUST 排序不变（symlink 归属真实类型分组，不加排序分支） | PRD §2.5/§3.5/UC-1；component-workspace-panel.md §6.5（视觉基线，doc-modifier 补 symlink） | +14 |
| ui-ws | app/web/src/components/chat-page/section-workspace-panel.tsx | handleOpen() | 修改 | 文件分流改新语义：`node.type === 'file'` → ① `isRemoteLinkPath(node.path)` → `void openRemoteLink(sessionId, node.path)` 异步打开（嗅探失败降级 `setFileEditorTarget`）② 否则（本地文件一律，含 symlink）→ `setFileEditorTarget({ path, fileName, subtitle, format: getFileFormat(node.path) ?? 'txt' })`。`node.type === 'dir'` → openWorkspaceItem kind='folder' 不变（symlink dir 后端链式放行） | MUST 本地文件（任意扩展名）一律进 editor（不再受 isBuiltinEditable 白名单限制，PRD §2.3）；MUST format fallback 从 'md' 改 'txt'（unsupported → plain view `<pre>` 文本渲染，防二进制当 markdown）；MUST 不再 import isBuiltinEditable（若 import 仅 handleOpen 用则删） | PRD §2.3/§3.6/UC-4b/UC-4c/UC-5b；行 8/9 | +8/-4 |
| ui-ws | app/web/src/components/chat-page/component-ws-file-editor.tsx | ComponentWsFileEditor() | 修改 | 二进制降级：readWorkspaceFile 后 `looksBinary(content)`（含 `\u0000` 或 `\uFFFD` 替换符占比高）→ 渲染「二进制文件无法预览」占位 pill（复用现有 statusMsg pill 范式），**不**渲染 ComponentModalMdEditor；非二进制正常 editor | MUST 不阻塞 editor 打开语义（PRD §3.6：二进制显示占位提示即可，图片 viewer/hex 留后续）；MUST looksBinary 为纯函数（可 UT） | PRD §3.6/§6（二进制降级边界）/UC-4b | +16 |
| ui-ws | app/web/src/i18n/locales/en/chat.json + zh-CN/chat.json | workspace.tree.symlinkTooltip + workspace.mdEditor.binaryUnsupported | 新增 | `workspace.tree.symlinkTooltip`（en "→ {{target}}" / zh "→ {{target}}"）+ `workspace.mdEditor.binaryUnsupported`（en "Binary file cannot be previewed" / zh "二进制文件无法预览"） | MUST en + zh-CN 双语同步；MUST 不覆盖既有键（纯新增） | PRD §2.5/§3.6；行 10/12 消费 | +4×2 |
| workspace | app/server/src/handlers/__tests__/session-workspace.test.ts | 既有 2 条 symlink 测试预期反转 + 新增授权测试 | 修改 | ① line 247 `?parent=escape（symlink 指向外部）→ 400` **改为 → 200 返回目标内容**（授权放行，UC-2 核心）；② line 391 open symlink 穿越 → 400 **改为 → 200**（spawn mock，UC-5）；③ 新增：tree 返回 isSymlink/linkTarget 字段断言；链式深层 `?parent=escape/sub`（UC-3）；未授权越界 `?parent=../../etc`/绝对路径仍 400（UC-6 回归） | MUST 两条既有断言反转是**本版本预期行为变更**（PRD §7 回归不变量注明），非测试修错；MUST 新增未授权越界用例保持 400 语义 | PRD §4 UC-2/3/5/6/8；行 1/2/3/4 | +40/-2 |
| workspace | app/server/src/handlers/__tests__/session-workspace-file.test.ts | symlink 文件读写放行测试 | 新增 | symlink 文件 GET 读 → 200 内容正确；POST save → 200 写入目标文件；未授权越界（非 symlink 段 ../）→ 400 | MUST symlink 目标在 workspace 外部时读/写放行（授权根模型） | PRD §2.3/UC-4/UC-8；行 6 | +30 |
| workspace | app/server/src/handlers/__tests__/session-workspace-watch.test.ts | symlink 目录 watch 放行测试 | 新增 | `POST watch { path: '<symlink-dir>' }` → 200（不 400）；unwatch 同；未授权越界 → 400 保持 | MUST watch 对 symlink 段放行（PRD §3.4 至少不报错） | PRD §3.4/UC-7；行 5 | +20 |
| ui-ws | app/web/src/components/chat-page/__tests__/section-workspace-panel-md.test.tsx | 文件分流断言更新 | 修改 | ① `.png`/`.markdown`（原断言走 openWorkspaceItem）→ **改为进 editor**（本地文件一律）；② 新增 `.url` 远程链接 → openRemoteLink（mock readWorkspaceFile 返 URL 内容 → 浏览器打开，openWorkspaceItem 不调）；③ `.md/.json` 等 12 格式 → editor 保持；文件夹 → openWorkspaceItem 保持 | MUST 断言与 PRD UC-4b/4c/5b 对齐 | PRD §4 UC-4b/4c/5b；行 11 | +20/-8 |
| ui-ws | app/web/src/components/chat-page/__tests__/component-ws-tree-item.test.tsx | symlink 渲染测试 | 新增 | `isSymlink=true` → 渲染 link 角标（testid 或 class 断言）+ title 含 linkTarget；`isSymlink` 缺省（undefined）→ 与旧渲染零差异（回归）；dir-symlink twisty 正常 | MUST 缺省 false 回归断言（向后兼容） | PRD §3.5/UC-1；行 10 | +25 |
| ui-ws | app/web/src/lib/file-format/__tests__/file-format.test.ts | isRemoteLinkPath 测试 | 新增 | `.url` → true（大小写不敏感：`.URL`）；`.md`/`.py`/`.txt`/无扩展名 → false | MUST 纯函数断言 | PRD §2.3；行 7 | +12 |

## 影响面评估

- **跨模块**：workspace 后端（handlers 3 文件 + 新 1 文件 + manager 零改动）+ ui-ws 前端（types/tree-item/panel/editor/file-format/remote-link/i18n）。无 API 端点新增（复用既有 tree/open/watch/file 4 端点，行为扩展）。
- **破坏性变更**：**2 条后端测试预期反转**（symlink 指向外部 400 → 200）= 本版本核心行为变更（PRD §7 明确「symlink 浏览」是新能力，非回归）；`isBuiltinEditable` **保留原语义**（架构决策②，避免 link-target 连锁）；其余全部向后兼容（isSymlink/linkTarget 可选字段缺省兼容）。
- **依赖顺序**：T1 后端（whitelistResolve 链式 + tree 字段 + 后端测试）→ T2 前端（types/渲染/handleOpen/editor/i18n/前端测试）。T2 依赖 T1 的 API 契约（tree 返回 isSymlink/linkTarget）——契约已在 change_plan 冻结，前端可并行编码。
- **风险点**：
  1. **link-target 连锁（架构决策②已规避）**：isBuiltinEditable 若直接改语义会让 markdown 链接点击 .py/.png 意外进 viewer——保留原函数 + 新增 isRemoteLinkPath，handleOpen 不再用 isBuiltinEditable。
  2. **watch 对 symlink 的增量监听**：WATCH_OPTIONS 未显式 followSymlinks；chokidar v4 默认值需 coder 确认——若默认不跟随，v1 接受「手动刷新兜底」（PRD §2.4 已允许）；必要时 WATCH_OPTIONS 显式 `followSymlinks: true`（对普通目录无影响，安全）。
  3. **文件 ≤300 行**：session-workspace.ts 现 298 行 → whitelistResolve 拆新文件后 -20 行净腾挪；section-workspace-panel.tsx 现 297 行 → handleOpen 改动 +8/-4 微增，若超限把 openRemoteLink 调用逻辑再压到 remote-link.ts（已拆），coder 按需挤注释/import。
  4. **二进制降级判定**：looksBinary 用 `\u0000`/`\uFFFD` 检测——文本文件含正常 Unicode 替换符（罕见）可能误判；阈值保守（任一 \u0000 或 \uFFFD 占比 >5% 才判二进制），编码期调。
- **doc-modifier 阶段 5 待同步**：`04-agent-session.md` §2.6.1 WsTreeNode 字段 + 安全段「显式浏览 symlink = 授权」；`[P0]session_workspace.md` §6；`[P0]session_workspace_manager.md`（watch symlink 策略）；`component-workspace-panel.md` §4.4（文件点击分流语义）；`component-ws-tree-item.md` §6.5（symlink 图标）；`00-app-guide.md`（symlink 浏览 + 本地文件进 editor）。

## 架构决策记录（PRD 留白 + 实现差异裁决）

### 决策 ①：授权模型 = whitelistResolve step2 链式授权解析（4 处统一）
- **裁决**：改 `whitelistResolve` 本身（step2 逐段解析 + symlink 段 realpath 授权），4 处调用点（tree/open/watch/file）自动统一，零额外接线。
- **理由**：workspace 内存在的 symlink = 用户放置 = 用户显式意图（后端无法区分「用户点击」vs「注入请求」，但 symlink 的存在本身就是授权声明）；威胁模型保持——不经过 symlink 段的越界（`../`、绝对路径、`~`）仍被 step1 前缀检查拒绝。链式解析天然满足「子路径在授权根内校验」：用户逐层展开时 path 连续经过 symlink 段。
- **否决**：持久化授权状态（session 级记录已授权根列表——请求间状态泄漏 + 复杂度高，链式实时解析足够）；仅 tree 放行（open/watch/file 仍 400 = 半吊子，PRD 明确 4 处统一）。

### 决策 ②：isBuiltinEditable 保留原语义（PRD 表述的实现调整）
- **裁决**：`isBuiltinEditable` 保持 12 格式白名单（link-target.ts + getCategory 生态零影响）；新增 `isRemoteLinkPath(path)`（.url 判定）+ handleOpen 改用「本地文件一律进 editor && !isRemoteLinkPath」新判定。
- **理由**：isBuiltinEditable 有**两个消费者**——workspace handleOpen（PRD 想改的）+ link-target.ts openLinkTarget local 分支（markdown 链接点击：12 格式进 viewer / 其它系统打开，v0.0.253 契约）。直接改 isBuiltinEditable 会让 markdown 链接点击 .py/.png 意外进 viewer，**超出 PRD 范围**（PRD 聚焦 workspace 文件树打开语义）。产品语义不变：workspace 文件打开 = 本地一律 editor / 远程浏览器；markdown 链接点击 = 保持 v0.0.253。
- **上报**：这是 PRD §5「isBuiltinEditable 语义变更」表述的实现差异，change_plan 冻结 + 汇报 orchestrator。

### 决策 ③：远程链接打开走前端浏览器能力（后端 open 端点零扩展）
- **裁决**：handleOpen 遇 .url → readWorkspaceFile 读内容 → parseUrlFileContent 提取 URL → openLinkTarget(url)（Electron shell.openExternal / 浏览器 window.open）。后端 open 端点**不加** kind='link'（kind 校验保持 file/folder）。
- **理由**：URL 打开是前端平台能力（link-target.ts v0.0.253 已有 IPC 通道）；后端 open 端点保持纯文件路径语义（白名单模型不被 URL 字符串污染）；.url 内容读取已由 file 端点（授权根）覆盖。
- **否决**：后端 kind='link'（open 端点需处理「非路径 body」→ 白名单语义破坏 + 平台 open URL 分支重复实现）。

### 决策 ④：whitelistResolve 拆独立文件（≤300 行硬限）
- **裁决**：新增 `session-workspace-path.ts`（whitelistResolve），session-workspace.ts / watch / file 三处 import 路径同步；json() 留在 session-workspace.ts。
- **理由**：session-workspace.ts 现 298 行，链式解析（+22）+ tree symlink（+10）必超 300 硬限；拆 whitelistResolve（-20）净腾挪。watch/file 只改 1 行 import（最小侵入）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
