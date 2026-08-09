# component-chat-link-viewer（chat 链接 viewer 挂载层 — 可编辑 + image/.url/absolute 分流）

> 层级: component（chat-page/，聊天区专属消费方挂载）
> 文件: app/web/src/components/chat-page/component-chat-link-viewer.tsx
> 消费方：`component-message-stream`（PrimitiveMarkdownView 内 `<a>` 点击本地链接 → openLocalPath 分发 → 弹本 viewer）
> v0.0.280：覆盖 v0.0.253「强制只读」决策（老板 2026-08-07 拍板——聊天链 ≡ 右侧文件区）：去 readOnly 传 onSave（可编辑保存）+ image 6 格式分流挂 WsImageViewer + .url 降级 txt editor。

## 职责
chat markdown 链接点击的「内置 viewer」挂载层：消费方（message-stream）持 chatLinkTarget state，本组件按 target 是否为空渲染；target 变化 → 渲染分流（image 6 格式 → `ComponentWsImageViewer`；否则 → `ComponentModalMdEditor` **可编辑 + onSave**）→ 按 `ChatLinkTarget.source` 分流取内容（workspace 相对 → HTTP readWorkspaceFile；absolute → Electron IPC readFileText）。
- **可编辑保存（v0.0.280 覆盖 v0.0.253 强制只读）**：`ComponentModalMdEditor` 不再传 readOnly，改传 `onSave`（workspace→saveWorkspaceFile HTTP / absolute→writeFileText IPC）→ 获得编辑能力（mode-toggle / 保存按钮可见）；保存 last-write-wins + 成功 toast「已保存」（2.6s flash，复用 ws-file-editor 范式）。
- **image 分流（v0.0.280）**：`isImagePath(target.path)` 命中 → 挂 `ComponentWsImageViewer`（source 透传）；**不读文本**（二进制 readFileText 失败会挡住 image viewer——直接清态走渲染分流，对齐右侧 handleOpen image 直接 onImageViewer）。
- **内容源分流**：workspace 相对路径走 HTTP（后端 whitelistResolve）；绝对路径 / `~` / `file://` 走 Electron `shell:readFileText` IPC（main 侧 computeResolveLocalPath 展开）。
- **附带 Context Provider**：本文件同时导出 `ChatLinkHandlerProvider`，供 message-stream 包裹渲染树注入 onLocalViewer 回调（PrimitiveMarkdownView 内 `<a>` onClick 经 `useChatLinkHandler` 取用）。

边界：不管路径白名单（chat 链接路径直接信任，PRD §2.3）；不管非 12 格式且非 image（pdf 等走 openPath 系统打开，不进本组件——openLocalPath 系统打开分支）；不改 ComponentModalMdEditor 组件本身（readOnly 可选能力是 v0.0.227 既有）。

## Context 契约
```ts
interface ChatLinkHandlerContextValue {
  onLocalViewer: (target: ChatLinkTarget) => void;  // 12 格式本地链接点击回调（消费方挂本 viewer）
  sessionId: string;                                  // workspace 相对路径走 HTTP readWorkspaceFile 用
}
```
- `ChatLinkHandlerContext` + `useChatLinkHandler` 在独立文件 `chat-link-handler-context.ts`（断开 primitive-markdown-view 循环依赖：primitive-markdown-view → context（纯 TS）← component-chat-link-viewer → ComponentModalMdEditor → primitive-markdown-view）。
- 无 Provider 返 null（其它消费方：md-editor viewer / skill 预览 / feishu doc）→ primitive-markdown-view 链接点击走默认 web→openExternal / local→openPath 系统打开，不弹内置 viewer modal。

## Props（ComponentChatLinkViewer）
```ts
interface ViewerProps {
  target: ChatLinkTarget | null;  // 当前点击的链接 target（null = 不渲染）
  sessionId: string;              // workspace 相对路径走 HTTP readWorkspaceFile 用
  onClose: () => void;            // 关闭回调（清 target state）
}

/** ChatLinkTarget（onLocalViewer 回调参数，来自 lib/link-target.ts toChatLinkTarget） */
interface ChatLinkTarget {
  path: string;                              // 原始 target（main 侧展开 ~ / file://；workspace 相对原样）
  source: 'workspace' | 'absolute';          // 路径来源：workspace（HTTP 读）/ absolute（IPC 读）
  fileName: string;                          // basename（modal fileName 用）
}
```

## 状态 / 交互
- **渲染分流（v0.0.280 target 就绪后）**：
  - `isImagePath(target.path)` 命中 → 挂 `ComponentWsImageViewer`（source = target.source 透传，WsImageTarget = `{path, fileName, subtitle: path, source}`）；**不读文本**（image 分支直接清态走渲染分流——二进制 readFileText 会失败挡住 viewer，对齐右侧 handleOpen）。
  - 否则 → 挂 `ComponentModalMdEditor`（open + format=getFileFormat(path) ?? 'txt' 兜底 + `onSave={handleSave}`，**不传 readOnly**）；fileName = target.fileName，subtitle = target.path。
- **取内容（target 变化触发 useEffect，非 image 分支）**：
  - `source === 'workspace'` → `readWorkspaceFile(sessionId, { path })` HTTP（既有 chat-api，后端白名单校验）；用递增 reqId 屏蔽过期响应（范本 ws-file-editor L48/64，防 target 快速切换旧请求覆盖新值）。
  - `source === 'absolute'` → `window.rockyShell.readFileText(path)` Electron IPC；非 Electron（`window.rockyShell` undefined）→ 友好错误（i18n `linkViewer.loadFail`）。
  - readFileText 返 `reason='not-found'` → 显「文件未找到：{{path}}」（i18n `linkViewer.fileNotFound`）；其它 reason / 异常 → 显 `linkViewer.loadFail`。
- **保存（v0.0.280 onSave，去强制只读）**：
  - `source === 'absolute'` → `window.rockyShell.writeFileText(path, content)` IPC（last-write-wins 覆盖；reason='not-found' → 友好错误，其它 → `linkViewer.writeFail`）。
  - `source === 'workspace'` → `saveWorkspaceFile(sessionId, { path, content })` HTTP（与 ComponentWsFileEditor 同源）。
  - 成功 → flash toast「已保存」（`linkViewer.saved`，2.6s 自动消失）。
- **loading 态**：取内容中显底部 pill「读取中…」（复用 `workspace.mdEditor.loading` 文案）。
- **error 态**：取内容失败显底部 pill（错误文案）；modal 不开（避免空内容弹层）。
- **关闭**：ESC / 关闭按钮 / onClose → 清 target state + 清内部 content/error。

## 可见文案（E2E 定位契约）
- pill（loading）：`workspace.mdEditor.loading`（「读取中…」/「Loading…」）
- pill（error-not-found）：`linkViewer.fileNotFound`（「文件未找到：{{path}}」/「File not found: {{path}}」）
- pill（error-other）：`linkViewer.loadFail`（「打开失败」/「Failed to open」）
- toast（保存成功）：`linkViewer.saved`（「已保存」/「Saved」，2.6s flash）
- modal 内可见文案（fileName / subtitle / hint / 关闭按钮 / ✕ / mode-toggle / 保存按钮）由 `ComponentModalMdEditor` 提供（**可编辑模式**：有 mode-toggle / 保存按钮 / 格式化/校验按钮；详见 `component-modal-md-editor.md`）。

## 复用关系
- **复用 ComponentModalMdEditor（common/）**：挂**可编辑模式**（传 onSave 不传 readOnly，v0.0.227 既有能力）；本组件是其「chat 链接 viewer（可编辑，第三消费场景）」消费方。
- **复用 ComponentWsImageViewer（chat-page/）**：image 分支挂载（source 透传，v0.0.280 加 source prop 缺省 workspace；absolute 源走 readFileBinary IPC）。
- **复用 readWorkspaceFile / saveWorkspaceFile**（lib/chat-api/workspace-api.ts）：workspace 相对路径读/存源（与 ComponentWsFileEditor 同源）。
- **复用 writeFileText**（Electron IPC shell:writeFileText）：absolute 源保存（last-write-wins 覆盖，v0.0.280 新通道）。
- **复用 getFileFormat / isImagePath**（lib/file-format.ts）：识别 12 格式 → format prop / image 分流判定。
- 被组合于 `component-message-stream`（Provider 包裹 + 本组件挂载）；Context value 注入。
- Context 由 `chat-link-handler-context.ts` 提供（独立文件断循环依赖）；`primitive-markdown-view` 经 `useChatLinkHandler` 取 onLocalViewer。

## 视觉基线
- modal 视觉复用 `ComponentModalMdEditor` 现有基线（720px / max-h 88vh / rounded-xl / shadow-lg，详见 `component-modal-md-editor.md §视觉基线`）。
- loading / error pill：底部居中悬浮（`fixed bottom-6 left-1/2 -translate-x-1/2` + bg-fg + text-surface + shadow-xl + rounded-lg + text-[12.5px]），复用 ws-file-editor 同款（v0.0.227 既有风格）。
- 无设计稿（v0.0.253 PRD §6）→ 视觉保真 compare 跳过。

## 注
- **链中链简化（PRD §6 / UC-F 范围外）**：md-editor viewer 内的 md 内容若再含链接，点击走系统打开（md-editor 未包 ChatLinkHandlerContext → useChatLinkHandler 返 null → 12 格式 local 走 openPath 降级，不弹本 viewer）。ET 不覆盖此场景。
- **known-issue（BUG-253-01 open，随版本合并经用户确认）**：loading/error pill 无自动消失 / 无 dismiss 交互——pill 渲染条件 = `loading || error` 非空即显示，error 后常驻聊天区底部（观感瑕疵非阻塞；修复方向：timer 自动消失 + 可点 dismiss，统一收口同模式 pill）。
- **packaged 一致性**：本组件纯 renderer，IPC 调用经 preload `window.rockyShell`；packaged 下 main 进程 shell/fs 可正常调用（package_structure §4.4 不变量4）。
