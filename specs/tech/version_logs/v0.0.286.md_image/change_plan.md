# v0.0.286 变更计划书 — Markdown Viewer 图片渲染支持

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 |

## 架构裁决（对齐 PRD 5 留口）

1. **inline 嵌图 = 本版不做**：只做 block 级（独立行 `![alt](url)`）。renderInline 已 3 级切分（code→link→bold），加第 4 级 image 嵌图复杂度高且用户主场景是独立行插图。block 级在按行扫描主循环加一个分支（紧接 GFM 表格分支之前），识别 `^!\[.*\]\(.*\)$` 独立行。
2. **data:image/ 白名单 = 放行**：新增 `isDangerousImageScheme(url)` 纯函数——拦 javascript:/vbscript:/非 image data:；放行 `data:image/`（常见 base64 内联图片）。图片渲染走本函数（非 isDangerousScheme），链接仍走 isDangerousScheme（行为不变）。
3. **web 图片点击放大 = 新建轻量 modal**：WsImageViewer 绑 sessionId+IPC/HTTP 读链路不适合 web 直渲（web 图已有 URL 不需读）。新建 `PrimitiveImageLightbox`（Portal+遮罩+`<img src={url}>` 全尺寸+Esc 关闭，~60 行）。本地图片点击放大已有 data URL，也走 Lightbox（不走 WsImageViewer——避免绑 sessionId+异步重读已加载的 data URL，多此一举）。
4. **baseDir derive = 新增 filePath prop**：modal-md-editor 新增可选 `filePath?: string`（md 文件完整路径）。baseDir = `dirname(filePath)`。subtitle 可能是装饰性文案（academy 用「学生·版本·字段」），不一定是路径——不用 subtitle derive。ws-file-editor/chat-link-viewer 传 `filePath=target.path`（与 subtitle 同值但语义明确）。
5. **chat 气泡 fallback = 本版不做**：chat 气泡无 baseDir（LLM 生成文本无文件目录）→ 相对图片降级 alt 文本。后续版本可考虑 workspaceDir fallback。

## SVG 安全策略

`<img src="data:image/svg+xml;base64,...">` 天然不执行 SVG 内 `<script>` 标签（浏览器安全模型：img 标签加载的 SVG 脚本不执行）。本版本不额外做 SVG sanitization——PRD §6 边界已明确「SVG 作为 `<img src>` 渲染天然不执行脚本」。如果后续需要 inline SVG 渲染（直接 `dangerouslySetInnerHTML`），则需 sanitize，但本版本不涉及。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-link-lib | app/web/src/lib/link-target.ts | isDangerousImageScheme() | 新增 | 图片专用危险协议判定：拦 javascript:/vbscript:/data:(非 image)；放行 data:image/（白名单）。正则 `^\s*(javascript\|vbscript):` → true；`^\s*data:(?!image/)` → true；其余 → false | MUST 与 isDangerousScheme 共存（链接仍走原函数）；MUST data:image/ 放行（常见 base64 图片）；MUST 非 image data: 拦截 | PRD D2 §2；裁决2 | +12 |
| web-md-render | app/web/src/components/common/primitive-markdown-image.tsx | MarkdownImage | 新增 | 图片渲染组件（block 级 `<img>` + 异步加载 + 点击放大）。Props: `{ src: string; alt: string; baseDir?: string; sessionId?: string }`。渲染流程：①web(http/https)→直渲 `<img src>` ②data:image/→直渲 `<img src>` ③absolute→rockyShell.readFileBinary→base64→data URL ④relative+baseDir+sessionId→readWorkspaceFileBinary 或 absolute resolve→IPC ⑤relative 无 baseDir→降级 alt。加载态：loading/error/too-large 占位 placeholder（灰底+图标+alt）。点击→PrimitiveImageLightbox 放大 | MUST web/data:image 直渲不异步读；MUST absolute/relative 异步读有 loading/error/too-large 三态；MUST 复用 readFileBinary（≤2MB too-large）+ readWorkspaceFileBinary；MUST NOT 引入第三方库；MUST 点击放大用 Lightbox（非 WsImageViewer） | PRD D2/D5 §2；裁决1/3 | +120 |
| web-md-render | app/web/src/components/common/primitive-markdown-image.tsx | resolveImageUrl() | 新增 | 纯函数：resolve 图片 src 到 { type: 'web'\|'data'\|'absolute'\|'relative', url, resolvedPath? }。web=http/https 前缀；data=data:image/ 前缀；absolute=`/`\|`~`\|`file://`\|win 盘符；relative=其余。relative + baseDir → joinPath(baseDir, url) 后再判 absolute/workspace | MUST 纯函数无副作用可 UT；MUST joinPath 复用 toChatLinkTarget 同算法（不新开路径判定） | PRD D2/D3 §2 | +25 |
| web-md-render | app/web/src/components/common/primitive-markdown-image.tsx | joinPath() | 新增 | 纯函数：baseDir + relative → joined path。POSIX `/` join（baseDir 去尾 `/` + relative 去前 `/`）。若 relative 本身是 absolute 原样返回 | MUST 纯函数；MUST 不依赖 node path（浏览器环境） | PRD D3 §2.3 | +8 |
| web-md-render | app/web/src/components/common/primitive-markdown-image.tsx | PrimitiveImageLightbox | 新增 | 轻量放大 modal（Portal+遮罩+`<img src>` 全尺寸 max-h-88vh+Esc/遮罩关闭）。web 图传 src=url；本地图传 src=data URL（已加载）。~60 行 | MUST Esc/遮罩/✕ 三路关闭（对齐 L3 modal）；MUST NOT 走 IPC（web 已有 URL / 本地已加载 data URL）；MUST pointer-events-auto | PRD D4 §2.4；裁决3 | +55 |
| web-md-render | app/web/src/components/common/primitive-markdown-view.tsx | MarkdownViewProps.baseDir | 新增 | interface 加 `baseDir?: string`（md 文件目录，resolve 相对图片路径用） | MUST 可选（chat 气泡不传 → 相对图片降级 alt）；MUST 不破坏现有消费方（缺省 undefined 行为不变） | PRD D3 §2.3 | +2 |
| web-md-render | app/web/src/components/common/primitive-markdown-view.tsx | MarkdownViewProps.sessionId | 新增 | interface 加 `sessionId?: string`（workspace 相对图片走 readWorkspaceFileBinary 用） | MUST 可选（modal-md-editor 传；chat 气泡从 useChatLinkHandler 取）；MUST 不破坏现有消费方 | PRD D3 §2.3 | +1 |
| web-md-render | app/web/src/components/common/primitive-markdown-view.tsx | block image 分支 | 修改 | 按行扫描主循环加 block image 分支（紧接 GFM 表格分支之前）：识别 `^!\[([^\]]*)\]\(([^)\s]+)\)$`（独立行前置 `!` 区分链接）→ 渲染 `<MarkdownImage src=$2 alt=$1 baseDir sessionId />`。段落 break 条件加 image 独立行（防止段落吞图片行） | MUST 独立行才识别（前后空行包围，非段内嵌）；MUST `!` 前置区分链接（`![]()` = 图片 / `[]()` = 链接）；MUST 段落 break 加 image 行判定（防段落吞图片）；MUST NOT 改 renderInline（inline 嵌图本版不做） | PRD D1/F1/F12 §2.1；裁决1 | +12 |
| web-md-render | app/web/src/components/common/primitive-markdown-view.tsx | PrimitiveMarkdownView() | 修改 | 从 props 解构 baseDir/sessionId；传给 MarkdownImage。从 useChatLinkHandler 取 sessionId 作 fallback（chat 气泡场景） | MUST props.sessionId 优先于 handler.sessionId；MUST baseDir 只从 props 传（chat 气泡不传=undefined） | PRD D3 §2.3 | +5 |
| web-md-render | app/web/src/components/common/component-modal-md-editor.tsx | Props.filePath | 新增 | interface 加 `filePath?: string`（md 文件完整路径，derive baseDir 用） | MUST 可选（academy 场景不传→无 baseDir→相对图片降级 alt）；MUST NOT 用 subtitle derive（subtitle 可能是装饰文案） | PRD D3 §2.3；裁决4 | +2 |
| web-md-render | app/web/src/components/common/component-modal-md-editor.tsx | ComponentModalMdEditor() | 修改 | 解构 filePath；PrimitiveMarkdownView 传 `baseDir={filePath ? dirname(filePath) : undefined}` + `sessionId`（需新增 sessionId prop 或从上层传入） | MUST baseDir=dirname(filePath)；MUST filePath 缺省→baseDir undefined（academy 兼容） | PRD D3 §2.3 | +3 |
| web-viewer-mount | app/web/src/components/chat-page/component-ws-file-editor.tsx | ComponentWsFileEditor() | 修改 | ComponentModalMdEditor 传 `filePath={target.path}` + `sessionId`（已有 sessionId prop） | MUST filePath=target.path（workspace 相对路径）；MUST sessionId 已有直接传 | PRD D3；裁决4 | +2 |
| web-viewer-mount | app/web/src/components/chat-page/component-chat-link-viewer.tsx | ComponentChatLinkViewer() | 修改 | ComponentModalMdEditor 传 `filePath={target.source === 'workspace' ? target.path : target.path}` + `sessionId`（已有） | MUST absolute 路径也传 filePath（baseDir=dirname(absolute path)→absolute 图片 resolve） | PRD D3；裁决4 | +2 |
| web-md-render | app/web/src/components/common/primitive-markdown-view.tsx | import MarkdownImage | 修改 | 顶部 import `{ MarkdownImage } from './primitive-markdown-image'` | MUST 从同目录 helper import（范本 gfm-table import L15） | gfm-table.ts import 模式 | +1 |
| tests | app/web/src/components/common/__tests__/primitive-markdown-image.test.tsx | MarkdownImage + resolveImageUrl + joinPath | 新增 | ①resolveImageUrl 4 分支（web/data/absolute/relative）②joinPath（baseDir+relative→joined；absolute 原样）③MarkdownImage 渲染：web 直渲 `<img src>` / absolute mock readFileBinary→data URL / relative+baseDir+sessionId mock readWorkspaceFileBinary→data URL / relative 无 baseDir→alt 降级 ④三态：loading placeholder / error alt / too-large alt ⑤点击→Lightbox 渲染 ⑥isDangerousImageScheme：javascript:/vbscript:→true / data:image/→false / data:text/→true | MUST mock window.rockyShell.readFileBinary + readWorkspaceFileBinary（vi.fn）；MUST 断言渲染结果（testid/getByText）；MUT 不真调 IPC | PRD §8 | +120 |
| tests | app/web/src/components/common/__tests__/primitive-markdown-view.test.tsx | block image 渲染 | 新增 | ①独立行 `![alt](url)` → MarkdownImage 渲染（非原始文本）②`[text](url)` 仍是链接（前置无 `!`）③段落内嵌 `text ![img](x.png) more` → 段落不识别图片（inline 不做→原始文本）④危险协议 `![x](javascript:alert(1))` → 降级纯文本 ⑤回归：代码块/列表/表格/标题输出不变化（snapshot 对照既有 case） | MUST 回归用例零改动（链接/表格/列表/代码块/标题）；MUST 新增 image 识别用例 + `!` 区分链接 | PRD F11/F12 §7 回归 | +35 |
| tests | app/web/src/lib/__tests__/link-target.test.ts | isDangerousImageScheme | 新增 | javascript:/vbscript:→true；data:image/png→false / data:image/svg→false；data:text/html→true / data:application/→true；http/https→false | MUST 纯函数全用例；MUST 与 isDangerousScheme 用例独立（不混） | PRD D2 裁决2 | +12 |

## 影响面评估

- **跨模块**：web-link-lib（isDangerousImageScheme）→ web-md-render（primitive-markdown-image.tsx 新文件 + primitive-markdown-view.tsx block 分支 + modal-md-editor filePath）→ web-viewer-mount（ws-file-editor/chat-link-viewer 传 filePath）+ 3 测试文件。无 IPC 变更、无后端变更、无 API 变更。
- **无破坏性变更**：baseDir/sessionId/filePath 全 optional；block image 分支只在独立行 `^!\[...\]\(...\)$` 命中时触发，段落/链接/表格等不受影响。
- **关键设计裁决**：
  1. **block 级在主循环加分支**（不在 renderInline 加）：独立行 `![alt](url)` 在按行扫描识别，与 GFM 表格同层级（block 级）。renderInline 不改（inline 嵌图不做）——降低复杂度 + 回归面最小。
  2. **data:image/ 白名单新函数**（不改 isDangerousScheme）：isDangerousScheme 是链接拦截单一权威（280 依赖），改它影响面大。新增 isDangerousImageScheme 专为图片，data:image/ 放行。
  3. **点击放大统一用 Lightbox**（本地+web 都走）：WsImageViewer 绑 sessionId+IPC 异步读链路——本地图片在 MarkdownImage 内已加载 data URL，点击放大直接用已加载的 URL 即可，重走 WsImageViewer 多此一举（重新异步读一遍已加载的图片）。Lightbox 是纯展示 modal（src 已就绪），~60 行轻量。
  4. **filePath 新增 prop（不用 subtitle derive）**：subtitle 在 academy 场景是「学生·版本·字段」装饰文案不是路径——derive baseDir 会出错。filePath 语义明确（文件完整路径），dirname(filePath) = baseDir。
  5. **relative resolve 链路**：baseDir + relativeUrl → joinPath → 判 joined 结果是 workspace 相对还是 absolute → workspace 走 readWorkspaceFileBinary（需 sessionId）、absolute 走 readFileBinary IPC。sessionId 来源：modal-md-editor 从上层传入（ws-file-editor/chat-link-viewer 已有 sessionId prop）。
- **性能/安全**：
  - 大图 base64 内存：readFileBinary ≤2MB 限制（280 已有），超限 reason='too-large' → 降级 alt + 提示。
  - SVG XSS：`<img src="data:image/svg+xml;base64,...">` 天然不执行 SVG 内 script（浏览器安全模型）。不额外 sanitize。
  - dangerous 拦截：isDangerousImageScheme 拦 javascript:/vbscript:/非 image data:。
- **风险点**：block image 正则 `^!\[([^\]]*)\]\(([^)\s]+)\)$` 需精确匹配独立行（trim 后）——段内嵌 `text ![](x.png)` 不匹配（`^` + `$` 锚定整行）。段落 break 条件加 image 行判定防止段落吞图片行（对齐 GFM 表格 break 模式 L283）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
