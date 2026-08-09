# v0.0.286 tech change log — Markdown Viewer 图片渲染支持

> 对应需求：`reqs/[working] v0.0.286/req.md`（用户可感知行为变化 → 走完整 PRD）。
> PRD：`specs/prd/version_logs/v0.0.286.md_image/prd.md`（D1-D5 + UC-1~9）。
> 权威契约：`specs/tech/version_logs/v0.0.286.md_image/change_plan.md`（method 级 18 行表，frozen）。

## 变更摘要

### 需求与动机

PrimitiveMarkdownView 不支持 `![alt](url)` 图片语法（渲染成原始文本）。老板拍板范围 B：本地图片（相对路径相对 md 目录 + 绝对路径 → IPC 读 base64）+ 网络图片（http/https 直渲）+ 点击放大。

### 方案（5 项架构裁决，详见 change_plan）

1. **block 级优先（renderInline 不改）**：独立行 `![alt](url)` 在按行扫描主循环加分支（紧接 GFM 表格之前），识别 `^!\[...\]\(...\)$` 独立行。inline 嵌图不做（renderInline 已 3 级切分，加第 4 级复杂度高且用户主场景是独立行）。
2. **data:image/ 白名单新函数**：新增 `isDangerousImageScheme(url)`（拦 javascript:/vbscript:/非 image data:，放行 `data:image/`）。不改 `isDangerousScheme`（保链接单一权威，280 依赖）。
3. **点击放大新建 PrimitiveImageLightbox**（不走 WsImageViewer）：WsImageViewer 绑 sessionId+IPC 异步读链路，本地图片 data URL 已加载重读多此一举，web URL 不需 IPC 读。Lightbox = 纯展示 modal（Portal+遮罩+`<img>` 全尺寸+Esc/遮罩/✕），~55 行。
4. **filePath 新增 prop（不用 subtitle derive）**：subtitle 在 academy 场景是装饰文案不是路径。filePath 语义明确（文件完整路径），`deriveBaseDir(filePath)` = baseDir。
5. **chat 气泡 fallback 不做**：chat 气泡无 baseDir（LLM 生成文本无文件目录）→ 相对图片降级 alt 文本。

### T1 — 实现（含 2 BUG 修复）

**新增文件**：
- `primitive-markdown-image.tsx`（234 行）：MarkdownImage 渲染组件 + resolveImageUrl/joinPath/deriveBaseDir 纯函数 + PrimitiveImageLightbox

**修改文件**：
- `link-target.ts`：新增 `isDangerousImageScheme`（L55，不改 isDangerousScheme）
- `primitive-markdown-view.tsx`：import MarkdownImage + Props 加 baseDir/sessionId + block image 分支（L268，独立行 `^!\[...\]\(...\)$` 正则→MarkdownImage 渲染）
- `component-modal-md-editor.tsx`：Props 加 filePath/sessionId（L42-45）+ `deriveBaseDir(filePath)` 传 PrimitiveMarkdownView（L207）
- `component-ws-file-editor.tsx`：传 `filePath={target.path}` + `sessionId`（L126-127）
- `component-chat-link-viewer.tsx`：传 `filePath={target.path}` + `sessionId`（L198-199）

**2 BUG 修复**（ET 发现 → coder 修复）：
- **BUG-001**（baseDir 拼接把 md 文件名当目录）：`modal-md-editor.tsx` 原用 `filePath.replace(/\/[^/]*$/, '')` 正则——对纯文件名（无 `/`）匹配失败返回原值。修复 = 提取 `deriveBaseDir` 纯函数（lastIndexOf 截取，纯文件名→空串=根目录）+ `joinPath` 空 baseDir 返 relative 原样。
- **BUG-002**（resolveImageUrl 空串 baseDir 判定 bug）：`if (baseDir)` 对空串 `''` 返 false（JS falsy）→ resolvedPath undefined → relative 分支跳过 → error 降级。修复 = `if (baseDir !== undefined)` + readBinary DI prop（绕过 vi.mock 模块缓存）。

UT 106 tests 全绿（29 image + 43 md-view + 34 link-target）+ tsc 0。

## 代码↔spec 核实表（doc-modifier）

| 核实项 | 代码位置 | 核实结果 |
|---|---|---|
| isDangerousImageScheme 拦截 javascript:/vbscript:/非 image data:，放行 data:image/ | `link-target.ts L55` | ✅ 不改 isDangerousScheme（链接单一权威） |
| MarkdownImage 三源分流（web/data 直渲 / absolute IPC / relative joinPath→workspace HTTP 或 IPC） | `primitive-markdown-image.tsx` resolveImageUrl L58-67 + effect L135-192 | ✅ 三源 + 四态精确对齐 change_plan |
| joinPath（空 baseDir 返 relative）+ deriveBaseDir（纯文件名→空串） | L24-31 + L39-44 | ✅ BUG-001 修复核实 |
| resolveImageUrl `baseDir !== undefined`（空串是有效根目录值） | L63 | ✅ BUG-002 修复核实 |
| PrimitiveImageLightbox（Portal+遮罩+Esc/遮罩/✕ 三路关闭） | L72-103 | ✅ 不走 WsImageViewer（本地 data URL 已加载 + web 已有 URL） |
| block image 分支（独立行 `^!\[...\]\(...\)$` → MarkdownImage） | `primitive-markdown-view.tsx L268` | ✅ renderInline 不改（inline 嵌图不做） |
| modal-md-editor filePath/sessionId props + deriveBaseDir | L42-45 + L207 | ✅ 不用 subtitle derive（academy 装饰文案） |
| ws-file-editor + chat-link-viewer 传 filePath+sessionId | ws-file-editor L126-127 / chat-link-viewer L198-199 | ✅ 传递链路完整 |
| readBinary DI prop（BUG-002 绕过 vi.mock 模块缓存） | L113 + L168 | ✅ UT 可注入 mock 测成功路径 |

## 文档同步

| 文件 | 变更 |
|------|------|
| `specs/ui/components/common/primitive-markdown-image.md` | **新建** 组件 spec（职责/导出/状态交互/复用关系/视觉基线） |
| `specs/ui/components/common/component-modal-md-editor.md` | Props 加 filePath/sessionId + md-body view 模式补图片渲染说明 |
| `specs/ui/overall/00-app-guide.md` | L62 聊天链接段 + L66 workspace 面板段补 md 图片渲染用户可感知行为 |
| `specs/tech/app/frontend/index.md` | L42 link-target 概念行扩 v0.0.286（isDangerousImageScheme + MarkdownImage 三源 + Lightbox + filePath/sessionId props） |
| `specs/tech/app/frontend/log.md` | 加 v0.0.286 条目 |

## 偏离

**2 BUG 修复**（ET 发现，coder 修复，非 change_plan 预见）：
1. BUG-001 deriveBaseDir 纯函数替代有 bug 的正则 + joinPath 空 baseDir 处理
2. BUG-002 resolveImageUrl `baseDir !== undefined` 替代 falsy 判定 + readBinary DI prop

两 BUG 均为 change_plan 遗漏的真实缺陷修复（ET 暴露 → coder 修复 → UT 验证），非设计偏离。
