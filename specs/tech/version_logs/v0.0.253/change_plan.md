# v0.0.253 变更计划书 — 聊天区链接渲染 + 可点击打开（http→浏览器 / 本地→内置 viewer 或系统打开）+ system prompt 配套

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离，planner 按本表切 task。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 上下文：`reqs/[working] v0.0.253/req.md`、`states/v0.0.253/context.md`、`specs/prd/version_logs/v0.0.253.md`、`specs/tech/app/package/[P0]package_structure.md §4.4`（新概念权威落点）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（electron-ipc / electron-main / web-link-lib / web-md-render / web-viewer-mount / web-i18n / system-prompt / web-shell-todo / tests） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 变更清单

### A. Electron IPC 三件套（新文件 `app/electron/src/open-external-ipc.ts` — 范本 `computer-permissions-ipc.ts`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| electron-ipc | app/electron/src/open-external-ipc.ts | computeResolveLocalPath | 新增 | 纯函数：(raw, home) → {ok, absPath?, reason?}。strip `file://` 前缀 → 展开 `~`/`~/` 用注入的 home → 验证结果为绝对路径（POSIX `/` 或 win 盘符），非绝对（如 workspace 相对）返 ok=false reason='relative-not-allowed' | MUST 注入 `home: string` 不读 process.env（packaged cwd=`/` 不依赖工作目录）；MUST NOT 接受 workspace 相对路径（仍走 HTTP readWorkspaceFile）；纯函数无 IO | package_structure §4.4 不变量1；BUG-004 教训 | +28 |
| electron-ipc | app/electron/src/open-external-ipc.ts | computeOpenExternal | 新增 | 纯函数：(url, shell) → {ok, reason?}。调注入 shell.openExternal(url)；catch 异常返 reason | MUST 注入 ShellLike 不 import electron 顶层；MUST NOT 在 url 做协议白名单（renderer 侧 classify 已过滤，main 信任 renderer 调用） | computer-permissions-ipc.ts 范本；package_structure §4.4 | +12 |
| electron-ipc | app/electron/src/open-external-ipc.ts | computeOpenPath | 新增 | 纯函数：(absPath, shell) → {ok, reason?}。调注入 shell.openPath(absPath)；catch 异常返 reason | MUST 接收绝对路径（computeResolveLocalPath 已展开）；MUST NOT 自行展开 `~`（职责分离） | package_structure §4.4 不变量1 | +10 |
| electron-ipc | app/electron/src/open-external-ipc.ts | computeReadFileText | 新增 | 纯函数：(absPath, fs) → {ok, content?, reason?}。调注入 fs.readFile(absPath, 'utf8')；ENOENT/EACCES/异常返 reason | MUST 注入 FsLike；MUST 限 utf8 文本（非二进制；图片/pdf 走 openPath 不进本通道）；大小上限 coder 定（防 LLM 链接指向超大文件拖垮 viewer，建议 ≤2MB reason='too-large'） | package_structure §4.4 | +18 |
| electron-ipc | app/electron/src/open-external-ipc.ts | ShellLike | 新增 | 依赖接口：`{ openExternal(url): Promise<void>; openPath(p): Promise<void> }`（不 import electron 类型） | MUST 仅声明本模块用到的最小面；MUST NOT 与 computer-permissions-ipc.ts 的 ShellLike 共享 import（保持文件自包含） | computer-permissions-ipc.ts L78-81 范本 | +6 |
| electron-ipc | app/electron/src/open-external-ipc.ts | FsLike | 新增 | 依赖接口：`{ readFile(p, enc): Promise<string> }` | 同上 | 同上 | +4 |
| electron-ipc | app/electron/src/open-external-ipc.ts | OpenExternalResult / ReadFileTextResult | 新增 | IPC 返回形状 type（{ok, reason?} / {ok, content?, reason?}） | 与 renderer 类型镜像 `rocky-shell.d.ts` 逐字一致（无法跨包共享 type） | package_structure §4.4 末段 | +6 |
| electron-ipc | app/electron/src/open-external-ipc.ts | registerOpenExternalIpc | 新增 | 注册 `shell:openExternal` / `shell:openPath` / `shell:readFileText` 三 channel；内部 require('electron') 拿 ipcMain + shell + require('fs') ；openPath/readFileText 先调 computeResolveLocalPath 展开 | MUST channel 名硬编码 `shell:*` 非 protocols（对齐 v0.0.105 computer:*）；MUST 在 main.ts app.whenReady 后调；openPath/readFileText 收到相对路径（renderer 异常调用）→ ok=false reason='relative-not-allowed' 不崩 | package_structure §4.4 不变量2；main.ts 注册点 | +22 |

### B. Electron main 注册 + window/navigate 拦截（`app/electron/src/main.ts`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| electron-main | app/electron/src/main.ts | createMainWindow() | 修改 | BrowserWindow 创建后挂两道拦截：(a) `win.webContents.setWindowOpenHandler(({url}) => { void shell.openExternal(url); return {action:'deny'} })` 兜底所有 target=_blank/window.open；(b) `win.webContents.on('will-navigate', (e, url) => { 若非 dev server origin → e.preventDefault() + void shell.openExternal(url) })` | MUST setWindowOpenHandler 返 `{action:'deny'}` 禁开新 Electron 窗口；MUST will-navigate 放行同 origin dev server（VITE_DEV_SERVER_URL HMR 跳转）；allowPopups 不开；shell 在本文件已 require('electron').shell 或新增 import | package_structure §4.4 不变量3 | +18 |
| electron-main | app/electron/src/main.ts | 顶层 IIFE（register 调用点） | 修改 | 在 `registerComputerPermissionsIpc()` 旁加 `registerOpenExternalIpc()` | MUST app.whenReady 后调（与 computer IPC 同时序） | main.ts L152 范本 | +1 |

### C. Preload contextBridge（`app/electron/src/preload.ts`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| electron-preload | app/electron/src/preload.ts | contextBridge expose rockyShell | 修改 | `exposeInMainWorld('rockyShell', { openExternal: (url)=>invoke('shell:openExternal',{url}), openPath: (path)=>invoke('shell:openPath',{path}), readFileText:(path)=>invoke('shell:readFileText',{path}) })` | MUST sandbox=true 下只用 ipcRenderer.invoke（与 rockyComputer 同范式）；payload 用 `{url}`/`{path}` 对象（不是裸 string，便于未来扩字段） | preload.ts L29-38 范本；package_structure §4.4 末段 | +10 |

### D. Renderer 类型镜像（新文件 `app/web/src/types/rocky-shell.d.ts`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-types | app/web/src/types/rocky-shell.d.ts | RockyShellApi | 新增 | interface 镜像 IPC 三方法：`openExternal(url): Promise<{ok,reason?}>` / `openPath(path): Promise<{ok,reason?}>` / `readFileText(path): Promise<{ok,content?,reason?}>` | MUST 与 open-external-ipc.ts 返回形状逐字一致；MUST NOT import electron（web 不 reference electron 包） | rocky-computer.d.ts 范本 | +14 |
| web-types | app/web/src/types/rocky-shell.d.ts | Window.rockyShell | 新增 | `declare global { interface Window { rockyShell?: RockyShellApi } }`（仅 Electron 桌面存在，undefined 降级） | 消费方 guard `typeof window!=='undefined' && window.rockyShell` | rocky-computer.d.ts L49-54 范本 | +5 |

### E. Renderer 点击分发 lib（新文件 `app/web/src/lib/link-target.ts`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-link-lib | app/web/src/lib/link-target.ts | isDangerousScheme | 新增 | 纯函数：(url) => boolean。正则 `/^\s*(javascript|vbscript|data):/i`（从 primitive-markdown-view.tsx isSafeUrl 提取语义，单一权威） | MUST 与原 isSafeUrl 语义逐字一致（不放宽不收紧）；MUST export 给 primitive-markdown-view 共用（删本地 isSafeUrl，DRY） | PRD §1/§3.1 isSafeUrl 保留 | +6 |
| web-link-lib | app/web/src/lib/link-target.ts | classifyLinkTarget | 新增 | 纯函数：(target) => 'web' \| 'local' \| 'dangerous'。web scheme（http/https/mailto/ftp 等 `^[a-z][a-z0-9+.-]*:` 命中且非 dangerous）→ 'web'；dangerous 协议 → 'dangerous'；其余（file://、绝对路径、~、workspace 相对）→ 'local' | MUST 先判 dangerous 再判 web scheme（顺序不变，dangerous 优先）；MUST NOT 解析扩展名（isBuiltinEditable 在 openLinkTarget 内判） | PRD §3.2 分发逻辑表 | +18 |
| web-link-lib | app/web/src/lib/link-target.ts | openLinkTarget | 新增 | 路由：(target, opts: { onLocalViewer?: (t: ChatLinkTarget)=>void, sessionId, workspaceDir }) => void。dangerous 不动；web → window.rockyShell?.openExternal(target)；local → isBuiltinEditable(target) ? opts.onLocalViewer?.(toChatLinkTarget(target)) : window.rockyShell?.openPath(target)。非 Electron + web → 降级 window.open(target,'_blank','noopener') 兜底 | MUST 消费方先 classify 后 open（或本函数内统一判，coder 定）；workspace 相对路径的 onLocalViewer 回调内由 viewer 自行 readWorkspaceFile（HTTP），绝对路径走 readFileText IPC；MUST NOT 对危险协议做任何打开动作 | PRD §3.2/§3.3；package_structure §4.4 不变量1（workspace 相对仍走 HTTP） | +32 |
| web-link-lib | app/web/src/lib/link-target.ts | LinkTargetKind / ChatLinkTarget | 新增 | type：LinkTargetKind = 'web'\|'local'\|'dangerous'；ChatLinkTarget = { path: string; source: 'workspace'\|'absolute'; fileName: string }（onLocalViewer 回调参数，viewer 据此分流内容源） | ChatLinkTarget.source 由 target 形式判（file:///绝对/~ → 'absolute'；其余 local → 'workspace'） | PRD §3.3 内容源分流 | +10 |

### F. Markdown 渲染（`app/web/src/components/common/primitive-markdown-view.tsx`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-md-render | app/web/src/components/common/primitive-markdown-view.tsx | isSafeUrl | 删除 | 提取到 link-target.ts（isDangerousScheme），本文件 import 共用 | MUST 删本地副本避免两份正则漂移 | link-target.ts isDangerousScheme | -3 |
| web-md-render | app/web/src/components/common/primitive-markdown-view.tsx | renderInline 内 `<a>` 渲染分支 | 修改 | L56-67 的 `<a>` 加 `onClick={(e)=>{ e.preventDefault(); openLinkTarget(url, useChatLinkHandler()); }}`；保留 href={url}（accessibility + hover 状态栏）；target/rel 删或留由 coder 定（setWindowOpenHandler 已兜底，href preventDefault 后不会真跳转）。useChatLinkHandler 从 Context 取 onLocalViewer 回调（无 Provider 返默认 opts） | MUST preventDefault 阻止 renderer 内导航；MUST 保留文案、isDangerousScheme 拦截分支不变（危险协议仍降级纯文本）；MUST NOT 在 primitive 内挂 viewer modal（UI 关注点上提到 message-stream） | PRD §3.1/§3.2；package_structure §4.4 不变量3 | +12/-3 |

### G. Chat 链接 viewer 挂载（新文件 `app/web/src/components/chat-page/component-chat-link-viewer.tsx` — 仿 `component-ws-file-editor.tsx`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-viewer-mount | app/web/src/components/chat-page/component-chat-link-viewer.tsx | ComponentChatLinkViewer | 新增 | 挂载层组件：props { target: ChatLinkTarget \| null, sessionId, onClose }。target 变化 → 按 target.source 分流取内容：'workspace' → readWorkspaceFile(sessionId,{path})；'absolute' → window.rockyShell.readFileText(target.path 绝对)。取内容后渲染 ComponentModalMdEditor（readOnly=true, fileName, format=getFileFormat(path) ?? 'md', onSave 不传）。loading/error 走 ws-file-editor 同款 pill | MUST 强制 readOnly=true（隐藏 mode-toggle/保存按钮，复用 ComponentModalMdEditor 既有能力）；MUST NOT 实现写回（v1 不做）；MUST 用 reqId 防竞态（范本 ws-file-editor L48/64）；非 Electron + absolute 路径 → 友好错误提示（i18n key）；getFileFormat 返 null 走 'md'（防御，classify 已过滤非 12 格式进 onLocalViewer 但兜底） | PRD §2.2/§3.3；component-ws-file-editor.tsx 范本；ComponentModalMdEditor readOnly prop | +95 |
| web-viewer-mount | app/web/src/components/chat-page/component-chat-link-viewer.tsx | useChatLinkHandler (hook) | 新增 | hook：useContext(ChatLinkHandlerContext) → { onLocalViewer, sessionId, workspaceDir } \| null。供 primitive-markdown-view `<a>` onClick 获取 openLinkTarget opts。无 Provider 返 null（其它消费方降级：链接点击走默认 web→openExternal / local→openPath，不弹 viewer modal） | MUST Provider 由 message-stream 提供（§H）；MUST default null 不抛；MUST useContext 不引入新 store（轻量 Context） | PRD §2.4（4 处消费方） | +14 |

### H. Message stream 集成（`app/web/src/components/chat-page/component-message-stream.tsx`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-message-stream | app/web/src/components/chat-page/component-message-stream.tsx | ComponentMessageStream | 修改 | 加 chatLinkTarget state + 渲染 `<ComponentChatLinkViewer target={chatLinkTarget} ... />`；用 `<ChatLinkHandlerContext.Provider value={{ onLocalViewer: setChatLinkTarget, sessionId, workspaceDir }}>` 包裹现有渲染树（让 PrimitiveMarkdownView 内 `<a>` 经 useChatLinkHandler 拿到回调） | MUST Provider 包住整个对话流渲染树（含 agent answer bubble）；MUST NOT 改 user 气泡（MentionRender 非 md）；workspaceDir 来自 chat-slice state（既有） | PRD §3.3；context.md chat 渲染 intro | +22 |

### I. i18n（`app/web/src/i18n/locales/{zh-CN,en}/chat.json`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-i18n | app/web/src/i18n/locales/zh-CN/chat.json | linkViewer.fileNotFound / linkViewer.loadFail | 新增 | 两 i18n key：`linkViewer.fileNotFound` = "文件未找到：{{path}}" / `linkViewer.loadFail` = "打开失败"；走 t() 占位符方法渲染 | MUST 中英文资源同步加（两文件）；MUST t() 占位符（不 defaultValue；项目 parseMissingKeyHandler 覆盖失效） | i18n-key-add-checklist memory | +2 |
| web-i18n | app/web/src/i18n/locales/en/chat.json | linkViewer.fileNotFound / linkViewer.loadFail | 新增 | 英文：`linkViewer.fileNotFound` = "File not found: {{path}}" / `linkViewer.loadFail` = "Failed to open" | 同上 | 同上 | +2 |

### J. System prompt 配套（`app/server/src/prompts/content/rules.md`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| system-prompt | app/server/src/prompts/content/rules.md | # Tool Use section | 修改 | 末尾加一条 bullet（措辞 coder 定，语义：引用文件路径/URL 时用 markdown 链接语法 `[显示文本](路径或URL)`，例 workspace 文件 `[config.yaml](config.yaml)`、绝对路径 `[日志](/var/log/app.log)`、网页 `[文档](https://example.com/docs)`，不输出裸路径） | MUST 落在 # Tool Use 末（不新开 section，保 3-section 结构 ≤20 行）；MUST 覆盖 standalone+subagent+academy（rules mapper 对 leader/mate/squad 返空，本指令不污染 squad）；不改 mapper / handler / CRITICAL_CONTENT_FILES（rules.md 已在清单）；build 期 src→dist 镜像已有（check-server-build-assets 守门） | PRD §3.4；prompt_content_files §5 rules.md 约束 ≤20 行 | +1 |

### K. App shell TODO 消化（`app/web/src/components/framework/app-shell/app-shell.tsx`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-shell-todo | app/web/src/components/framework/app-shell/app-shell.tsx | onOpenLogDir handler (L91) | 修改 | TODO(v0.0.150) 消化：调 `window.rockyShell?.openPath(logsDir)`（logsDir 由 caller 传入或 app-shell 已知 DATA_DIR/logs 绝对路径）；非 Electron → noop（保留现状降级） | MUST 传绝对路径（openPath 不展开 ~，本场景是 DATA_DIR/logs，已是绝对路径）；MUST NOT 为此新加 IPC channel（复用 shell:openPath） | PRD §8；package_structure §4.4 | +3/-2 |

### L. 单元测试

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tests | app/electron/src/__tests__/open-external-ipc.test.ts | computeResolveLocalPath / computeOpenExternal / computeOpenPath / computeReadFileText 纯函数覆盖 | 新增 | 覆盖：file:// strip / ~ 展开（注入 fake home）/ 相对路径拒绝 / shell.openExternal 成功+异常 / shell.openPath / fs.readFile 成功+ENOENT+EACCES+大文件；纯函数注入 mock，无 electron runtime | MUST 范本 computer-permissions-ipc.test.ts；MUST 覆盖 reason 字段自解释；不依赖真实 fs/shell | computer-permissions-ipc.test.ts | +120 |
| tests | app/web/src/lib/__tests__/link-target.test.ts | classifyLinkTarget / openLinkTarget 分发 | 新增 | 覆盖：http/https/mailto → web；file://、绝对、~ → local；javascript/vbscript/data → dangerous；openLinkTarget 各分支调对应 mock（window.rockyShell.openExternal/openPath + onLocalViewer 回调）；isDangerousScheme 三协议 | MUST mock window.rockyShell（jsdom）；MUST 不真调 IPC | PRD §3.2 分发逻辑 | +80 |
| tests | app/web/src/components/common/__tests__/primitive-markdown-view.test.tsx | 链接 case（v0.0.145） | 修改 | L171-234 链接 case：保留 isSafeUrl 危险协议降级 case（改用 isDangerousScheme）；新增「点击 → openLinkTarget 调用 + preventDefault」case（mock openLinkTarget 验调用参数）；href 仍渲染保留 case | MUST 同步更新既有 case（点击行为从「默认」→「分发路由」，PRD §7 回归不变量）；MUT NOT 删危险协议降级 case | PRD §7；primitive-markdown-view.test.tsx L171-234 | +30/-6 |

## 影响面评估

**跨模块**：electron（IPC + main + preload）→ web（types + lib + 渲染 + viewer + i18n + shell-todo）→ server（rules.md）→ tests。强耦合一条链：IPC 契约（types.d.ts + preload）→ renderer 调用方（lib + 渲染）→ UI 挂载（viewer + message-stream）。**无破坏性变更**：rules.md 加 bullet 不破坏现有 mapper/builder；primitive-markdown-view 加 onClick 是新增行为（preventDefault + 路由），保留 href 不破坏现有渲染 UT（仅改断言从默认→分发）。

**依赖顺序（底层 → 上层）**：A（IPC 实现）→ C/D（preload + 类型镜像契约）→ B（main 注册）→ E（lib）→ F（渲染接入）→ G/H（viewer + 挂载）→ I（i18n）→ J/K（prompt + todo）→ L（tests，贯穿）。

**风险点**：
1. **packaged 行为一致性**（CLAUDE.md 持续可打包护栏）：IPC 走 main 进程 `shell.*`/`fs.readFile`，packaged asar 内 main 进程能正常调用（dev/packaged 行为一致，无 asar 路径问题）；channel 名硬编码非 env，runtime-config 白名单不引入新键（合规）。coder 须跑 packaged 验证（解包 asar → 真后端 → curl 链接点击端到端，或真机装 dmg）。
2. **路径展开单一权威**：computeResolveLocalPath 注入 home，不依赖 process.env / cwd（防 packaged cwd=`/` BUG-004）。**不 import server `expandTilde`**（未 export + electron 已依赖 server 较深），main 侧封装纯函数（3 行 ~ 展开 unix 标准逻辑，非 dataDir 派生，不破坏 resolveDataDir 单一权威）。
3. **Context vs props 透传**：onLocalViewer 用 React Context（`ChatLinkHandlerContext`），避免 primitive-markdown-view 加 prop 强迫 4 处消费方传 null。无 Provider 时返 null（其它消费方链接点击走 web→openExternal / local→openPath 系统打开，**不弹内置 viewer modal**）。UC-F「链中链」v1 简化为「md-editor viewer 内链接走系统打开」（非内置 viewer modal）——不在 ET 范围（ET 只 UC-A/B/C），可接受。
4. **i18n key 双确认**（memory `i18n-key-add-checklist`）：zh-CN/en 同步加 + t() 占位符（不 defaultValue）。
5. **`will-navigate` 误伤 dev HMR**：放行同 origin dev server（VITE_DEV_SERVER_URL），仅拦截跨 origin / file:// 导航。

**doc-sync 待办（architect 预防性核对发现，doc-modifier 阶段 5 统一修）**：
- `specs/ui/components/chat-page/_overview.md §4.7` 引用号实际已不存在（与本版本无关，顺手修）
- `specs/ui/components/common/component-modal-md-editor.md` 消费方列表（academy + workspace）需补「chat 链接 viewer（只读，第三消费场景）」
- `specs/ui/overall/00-app-guide.md` 补「聊天链接点击分发」操作语义
- `specs/ui/components/common/`（或 chat-page/）补新组件 spec：`component-chat-link-viewer.md`（coder 编码期产出 .md + .tsx spec，标准见 `_conventions.md`）+ `primitive-markdown-view` 增量更新「链接点击分发路由」段

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 与本表关系 = 参考 + 决策权 + 汇报偏离（核心约束如 IPC 走 main / setWindowOpenHandler 兜底 / readOnly 强制 / 路径单一权威不可擅自偏离；实现细节如 onClick href 是否保留、Context 命名、UT 切分可由 coder 决定 + 汇报）
