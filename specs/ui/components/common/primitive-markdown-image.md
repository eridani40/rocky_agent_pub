# primitive-markdown-image（Markdown 图片渲染 helper）

> 层级: primitive（common/，渲染内核拆分 helper）
> 文件: app/web/src/components/common/primitive-markdown-image.tsx
> 消费方：`primitive-markdown-view.tsx` block image 分支（唯一消费方）
> 参考范本: `primitive-markdown-gfm-table.tsx`（同模式拆分——渲染内核 ≤300 行）

## 职责

从渲染内核拆出的图片渲染 helper：block 级 `![alt](url)` 图片独立行 → `<MarkdownImage>` 渲染组件 + 纯函数（resolveImageUrl / joinPath / deriveBaseDir）+ 轻量放大 modal（PrimitiveImageLightbox）。

**三源分流**（resolveImageUrl 分类 → effect 分流）：
- **web**（`http://` / `https://`）→ 直渲 `<img src={url}>`（浏览器/Electron 原生加载，不异步读）
- **data**（`data:image/`）→ 直渲 `<img src={url}>`（白名单放行，非 image data: 由 isDangerousImageScheme 拦截）
- **absolute**（`/` / `~` / `file://` / win 盘符）→ `rockyShell.readFileBinary` IPC → base64 → data URL（≤2MB，超限 too-large 降级）
- **relative + baseDir** → joinPath resolve → workspace 相对走 `readWorkspaceFileBinary` HTTP（需 sessionId）/ joinPath 后是 absolute 走 readFileBinary IPC
- **relative 无 baseDir**（chat 气泡场景）→ 降级 alt 文本

**不做**：inline 嵌图（段内嵌 `text ![](x.png) more`——本版仅 block 级独立行）、图片编辑/裁剪、懒加载/虚拟滚动、SVG sanitization（`<img src>` 天然不执行 SVG script）。

## 导出

### 纯函数

```ts
// POSIX / join：baseDir 去尾 / + relative 去前 /。relative 已是绝对路径原样返回。
// baseDir 为空串（md 在根目录）→ relative 原样返回。
function joinPath(baseDir: string, relative: string): string;

// 从文件路径提取所在目录。含 / → lastIndexOf 截取；纯文件名 → ''（根目录）；空值 → undefined。
function deriveBaseDir(filePath?: string): string | undefined;

// 图片 src 分类 → { type: 'web'|'data'|'absolute'|'relative', url, resolvedPath? }
// relative + baseDir（含空串=根目录，baseDir !== undefined 判定）→ joinPath resolve 后附 resolvedPath。
function resolveImageUrl(src: string, baseDir?: string): ImageUrlInfo;
```

### MarkdownImage（渲染组件）

```ts
interface MarkdownImageProps {
  src: string;           // 图片 URL（web/data/absolute/relative 四类）
  alt: string;           // alt 文本（降级时显示）
  baseDir?: string;      // md 文件目录（resolve 相对图片用；chat 气泡不传 → 相对图降级 alt）
  sessionId?: string;    // 会话 ID（workspace 相对图走 readWorkspaceFileBinary HTTP）
  readBinary?: (sessionId: string, path: string) => Promise<string>;  // DI：workspace 二进制读取（默认走 readWorkspaceFileBinary HTTP；UT 可注入 mock）
}
```

### PrimitiveImageLightbox（放大 modal）

```ts
// 轻量图片放大 modal：Portal + 遮罩 + 全尺寸 <img> + Esc/遮罩/✕ 三路关闭。
// 本地图传已加载的 data URL；web 图传原始 URL。不走 IPC（图片已加载/已有 URL，不重读）。
function PrimitiveImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }): JSX.Element;
```

## 状态 / 交互

**加载四态**（`ImgLoadState`）：`loading`（异步读占位 placeholder：灰底 🔄 + alt）→ `loaded`（`<img>` + cursor-zoom-in onClick→Lightbox）/ `error`（危险协议/无 baseDir/加载失败：alt + 🖼️ italic muted）/ `too-large`（>2MB：alt + ⚠️ 超过 2MB 限制）。

**危险协议拦截**：`isDangerousImageScheme(src)` → 拦 javascript:/vbscript:/非 image data: → 降级 error span。**与 isDangerousScheme 共存**（链接仍走原函数行为不变）；图片专用函数放行 `data:image/` 白名单。

**点击放大**：loaded 态 `<img>` onClick → `PrimitiveImageLightbox`（Portal+遮罩+`max-h-[88vh]` 全尺寸+Esc/遮罩/✕ 三路关闭+`pointer-events-auto`）。本地+web 统一走 Lightbox（不走 WsImageViewer——本地 data URL 已加载重读多此一举，web URL 不需 IPC 读）。

**DI readBinary**（BUG-002 修复引入）：`readBinary` 可选注入 prop 绕过 `vi.mock` 模块缓存问题，UT 直接覆盖 workspace 相对成功路径。默认走 `readWorkspaceFileBinary(sid, {path}).then(r => r.content)`。

## 复用关系

- **从 `primitive-markdown-view.tsx` 拆出**（渲染内核 ≤300 行约束，范本 `primitive-markdown-gfm-table.tsx`）
- **复用 `isDangerousImageScheme`**（`lib/link-target.ts`，v0.0.286 新增——不改 isDangerousScheme 保链接单一权威）
- **复用 `readFileBinary` IPC**（`open-external-ipc.ts` v0.0.280：absolute 图片 base64 ≤2MB）
- **复用 `readWorkspaceFileBinary` HTTP**（`workspace-api.ts` v0.0.269：workspace 相对图片 base64）
- **复用 `Portal`**（Lightbox 挂 overlay-root，对齐 L3 modal 不变式）

## 视觉基线

- loaded `<img>`：`max-w-full rounded-lg my-1.5 cursor-zoom-in`
- loading placeholder：`inline-flex items-center gap-2 text-muted text-[12px] my-1.5 px-3 py-2 bg-bg-warm rounded-lg` + 🔄
- error 降级：`text-muted text-[12px] italic` + 🖼️
- too-large：同 loading 样式 + ⚠️ +「超过 2MB 限制」
- Lightbox 遮罩：`rgba(10,10,10,.8)`；图片 `max-h-[88vh] max-w-[92vw] object-contain rounded-lg shadow-2xl`；✕ `top-4 right-4 text-white/80`
