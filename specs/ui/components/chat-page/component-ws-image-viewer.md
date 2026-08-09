# component-ws-image-viewer（workspace 图片只读查看器）

> 层级: component
> 文件: app/web/src/components/chat-page/component-ws-image-viewer.tsx
> since: v0.0.269
> 数据契约: specs/api/overall/04-agent-session.md §2.6.7（GET /workspace/file?binary=1 → base64）
> 分流入口: section-workspace-panel.tsx handleOpen（isImagePath → 本组件）/ component-chat-link-viewer.tsx（image 分支 → 本组件，v0.0.280）

## 职责

workspace 文件树 / chat 链接点开 6 格式图片（png/jpg/jpeg/gif/webp/svg）时的**只读查看弹层**：
L3 modal（Portal + modal shell）内 `<img>` 完整渲染图片，**无编辑/保存/格式化/校验入口**。

**source prop（v0.0.280 加）**：`source?: 'workspace' | 'absolute'`（缺省 `'workspace'`）——workspace 源走 HTTP `readWorkspaceFileBinary`（右侧文件树，既有行为零变化）；absolute 源走 Electron IPC `shell:readFileBinary`（chat 链接 absolute 图片，base64 同形态拼 data URL）。

**边界（不做什么）**：
- 不做图片编辑（无裁剪/缩放/滤镜/保存——PRD §6）。
- 不做缩略图/预览图（文件树仍显示文件名）。
- 不做 6 格式以外的图片（.bmp/.tiff/.ico 等走系统打开——范围不扩大铁律）。

## Props

```ts
/** image viewer 目标（handleOpen / chat-link-viewer image 分支命中时设置，关闭置空） */
interface WsImageTarget {
  /** 路径（workspace 源=相对 workspaceDir；absolute 源=绝对路径原样） */
  path: string;
  /** basename（如 'logo.png'），标题用 */
  fileName: string;
  /** 副标题：路径原样（workspace 源=相对 workspaceDir；absolute 源=绝对路径） */
  subtitle: string;
  /** [v0.0.280] 路径来源：缺省 'workspace'（HTTP readWorkspaceFileBinary）；'absolute' → IPC readFileBinary（base64 同形态） */
  source?: 'workspace' | 'absolute';
}

interface WsImageViewerProps {
  /** owner session id（readWorkspaceFileBinary 目标） */
  sessionId: string;
  /** 目标（null = 不渲染） */
  target: WsImageTarget | null;
  /** 关闭弹层（父置空 wsImageTarget） */
  onClose: () => void;
}
```

> 挂载：`section-workspace-panel.tsx`（`wsImageTarget` state，null 不渲染；与 `fileEditorTarget` 互斥）。

## 数据读取（二进制通道）

- **source 分流（v0.0.280）**：
  - `source === 'absolute'`（缺省 workspace）→ `window.rockyShell.readFileBinary(path)` Electron IPC → `{ ok, content?: base64, reason? }`；非 Electron / 失败 → loadFail。2MB 上限（stat 预检，reason='too-large'）。
  - `source === 'workspace'`（缺省，右侧文件树既有行为）→ `readWorkspaceFileBinary(sessionId, { path })` HTTP → `{ content: base64 }`。
- 拼 data URL：`data:image/{ext};base64,{content}`（ext 从 path 扩展名取，去除前导 `.`；svg → `image/svg+xml`）。
- 失败（404 文件不存在 / 400 越界 / IPC not-found / 网络）→ 轻量错误提示「图片加载失败」（`wsImageViewer.loadFail`），**不显示乱码/占位 pill**。

## 渲染

```
┌────────────────────────────────────────┐
│ screenshot.png          [×]            │  ← 标题 fileName + 关闭
│ /path/to/screenshot.png                 │  ← 副标题 subtitle
│ ┌────────────────────────────────────┐ │
│ │                                    │ │
│ │            <img>                   │ │  ← max-w/max-h 适配，保持纵横比
│ │                                    │ │
│ └────────────────────────────────────┘ │
└────────────────────────────────────────┘
```

- L3 modal base（`_layering.md` §3A）：`<Portal>` 到 overlay-root + 根节点 `pointer-events-auto`（脱离祖先 pointer-events:none 链）。
- 遮罩点击关闭 + 右上关闭按钮（同 todo/cron modal 壳）。
- `<img>`：`max-w-full max-h-[70vh] object-contain mx-auto`（不裁剪不缩放失真，保持纵横比）。

## 状态 / 交互

- 打开即读（loading 态轻量文案）→ 成功渲染 img / 失败 error 文案。
- 关闭：遮罩点击 / 右上 × / Esc → `onClose()`（父置空 wsImageTarget）。
- 只读：无 mode-toggle / 无保存 / 无格式化校验按钮。

## 可观测节点

- 弹层根：`data-testid="ws-image-viewer"`。
- 图片：`data-testid="ws-image-viewer-img"`。
- 错误提示：`data-testid="ws-image-viewer-error"`。

## 视觉基线

- 复用 L3 modal 壳（720px 内 shell + border-border-2 + bg-surface + shadow-2xl，同 todo modal）。
- 标题 15px bold fg；副标题 11px muted；关闭按钮 hover bg-bg-warm。
- 图片区：浅色底（bg-bg-warm/40）衬托，居中 object-contain。

## 复用关系

- 组合：Portal + CloseIcon + readWorkspaceFileBinary（workspace-api）。
- 挂载：section-workspace-panel.tsx（handleOpen image 分支 → wsImageTarget state）。
- 兄弟：component-ws-file-editor.tsx（文本 editor——image 与 editor 互斥，同一时刻只开一个）。
