# component-chat-link-viewer（chat 链接只读 viewer 挂载层）

> 层级: component（chat-page/，聊天区专属消费方挂载）
> 文件: app/web/src/components/chat-page/component-chat-link-viewer.tsx
> 消费方：`component-message-stream`（PrimitiveMarkdownView 内 `<a>` 点击 12 格式本地链接 → 弹本只读 viewer）

## 职责
chat markdown 链接点击的「内置只读 viewer」挂载层：消费方（message-stream）持 chatLinkTarget state，本组件按 target 是否为空渲染；target 变化 → 按 `ChatLinkTarget.source` 分流取内容（workspace 相对 → HTTP readWorkspaceFile；absolute → Electron IPC readFileText）→ 灌给 `ComponentModalMdEditor`（readOnly=true 强制，复用既有 viewer）。
- **强制只读**：v1 不实现写回 / 编辑保存链路（PRD §2.2）；mode-toggle / 保存按钮由 ComponentModalMdEditor readOnly 模式隐藏。
- **内容源分流**（PRD §3.3）：workspace 相对路径走 HTTP（后端 whitelistResolve）；绝对路径 / `~` / `file://` 走 Electron `shell:readFileText` IPC（main 侧 computeResolveLocalPath 展开）。
- **附带 Context Provider**：本文件同时导出 `ChatLinkHandlerProvider`，供 message-stream 包裹渲染树注入 onLocalViewer 回调（PrimitiveMarkdownView 内 `<a>` onClick 经 `useChatLinkHandler` 取用）。

边界：不管写回（v1 强制只读）；不管路径白名单（chat 链接路径直接信任，PRD §2.3）；不管非 12 格式（图片/pdf 等走 openPath 系统打开，不进本组件）。

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
- **取内容（target 变化触发 useEffect）**：
  - `source === 'workspace'` → `readWorkspaceFile(sessionId, { path })` HTTP（既有 chat-api，后端白名单校验）；用递增 reqId 屏蔽过期响应（范本 ws-file-editor L48/64，防 target 快速切换旧请求覆盖新值）。
  - `source === 'absolute'` → `window.rockyShell.readFileText(path)` Electron IPC；非 Electron（`window.rockyShell` undefined）→ 友好错误（i18n `linkViewer.loadFail`）。
  - readFileText 返 `reason='not-found'` → 显「文件未找到：{{path}}」（i18n `linkViewer.fileNotFound`）；其它 reason / 异常 → 显 `linkViewer.loadFail`。
- **loading 态**：取内容中显底部 pill「读取中…」（复用 `workspace.mdEditor.loading` 文案）。
- **error 态**：取内容失败显底部 pill（错误文案）；modal 不开（避免空内容弹层）。
- **渲染**：内容就绪后挂 `ComponentModalMdEditor`（open + readOnly=true + format=getFileFormat(path) ?? 'md' 兜底 + 不传 onSave）；fileName = target.fileName，subtitle = target.path（标识来源）。
- **关闭**：ESC / 关闭按钮 / onClose → 清 target state + 清内部 content/error。

## 可见文案（E2E 定位契约）
- pill（loading）：`workspace.mdEditor.loading`（「读取中…」/「Loading…」）
- pill（error-not-found）：`linkViewer.fileNotFound`（「文件未找到：{{path}}」/「File not found: {{path}}」）
- pill（error-other）：`linkViewer.loadFail`（「打开失败」/「Failed to open」）
- modal 内可见文案（fileName / subtitle / hint / 关闭按钮 / ✕）由 `ComponentModalMdEditor` 提供（readOnly 模式：无 mode-toggle、无保存按钮、无格式化/校验按钮；详见 `component-modal-md-editor.md`）。

## 复用关系
- **复用 ComponentModalMdEditor（common/）**：挂 readOnly=true 模式（v0.0.227 既有能力，v0.0.241 扩 format）；本组件是其「chat 链接 viewer（只读，第三消费场景）」消费方。
- **复用 readWorkspaceFile**（lib/chat-api/workspace-api.ts）：workspace 相对路径内容源（与 ComponentWsFileEditor 同源）。
- **复用 getFileFormat**（lib/file-format.ts）：识别 12 格式 → format prop（决定 modal view 分流：md → PrimitiveMarkdownView 渲染 / 其余 → `<pre>`）。
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
