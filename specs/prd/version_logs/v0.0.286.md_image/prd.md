# v0.0.286 PRD — Markdown Viewer 图片渲染支持

- **版本号**: v0.0.286
- **版本主题**: PrimitiveMarkdownView 支持 `![alt](url)` 图片语法（本地相对/绝对 + 网络 + 点击放大）
- **需求文件**: `reqs/[working] v0.0.286/req.md`（老板拍板 2026-08-08 07:45：范围 B 本地+网络+点击放大，需 ET）
- **工作目录**: `worktrees/0.0.286-md-image`
- **类型**: 用户可感知行为变化（渲染新语法 + 新交互）→ 完整 PRD

---

## 1. 背景

### 1.1 现状

- **渲染内核** `primitive-markdown-view.tsx`（300 行零依赖自研）支持 block：段落 / 代码块 / 标题 / 列表 / 引用 / GFM 表格；inline：加粗 / 行内代码 / 链接。**不支持 `![alt](url)` 图片语法**——md 里的图片全部渲染成原始文本 `![image](images/img1.svg)`。
- **renderInline 切分层级**（L29-93）：一级行内代码 `` ` `` → 二级链接 `[]()` → 三级加粗 `**`；无图片分支。
- **4 处消费方**：
  - `component-message-stream.tsx`（chat answer 气泡）——无文件目录上下文，source 来自 LLM 生成文本
  - `component-modal-md-editor.tsx`（md 文件 viewer/editor）——有 fileName / subtitle，但不传 md 文件目录
  - `component-skill-browser-modal.tsx`（skill 预览）——content 从 frontmatter 提取
  - `component-feishu-setup-doc.tsx`（feishu 文档）——内置静态文案
- **IPC 能力已就绪**（v0.0.280）：
  - `shell:readFileBinary`（absolute → base64 ≤2MB，超限 reason='too-large'）
  - `readWorkspaceFileBinary`（workspace 相对 → HTTP GET ?binary=1 → base64）

### 1.2 痛点

用户 md 文件含 `![image](images/img1.svg)`，相对 md 所在目录 resolve——PrimitiveMarkdownView 直接输出原始文本，用户看不到图片。

### 1.3 老板拍板（req.md）

- **范围 B**：本地图片（相对路径相对 md 目录 + 绝对路径 → IPC 读 base64）+ 网络图片（http/https 直渲 `<img src>`）
- **点击放大**：支持（内联图片点击 → 弹出放大预览）
- **危险协议**：file:// 直链 / javascript: 拦截；data: 图片是否放行需架构定
- **需 ET**

---

## 2. 核心决策

### D1. 图片 = block 级优先（独立行），inline 可选

- **block 级**（独立行 `![alt](url)`，前后空行包围）：渲染为 `<img>` 独立块（`max-w-full` + `my-2` 居中 / 左对齐 + caption=alt）；用户主场景（md 文件插图）= 独立行。
- **inline 级**（段落内嵌 `![alt](url)`）：在 renderInline 加图片分支，`<img>` inline 渲染（小尺寸 `max-h-[1.5em]` inline-block）。
- **建议**：block 优先实现（用户场景），inline 嵌图可选（架构裁决——renderInline 已 3 级切分，加第 4 级复杂度可控但优先级低）。

### D2. 图片 URL 三源分流（对齐 IPC 能力，复用 280 双源）

| URL 形式 | 分类 | 渲染方式 |
|---|---|---|
| `http://` / `https://` | web | `<img src={url}>` 直渲（浏览器/Electron 原生加载） |
| 相对路径（`images/x.svg` / `./img.png`） | local-relative | resolve 相对 md 目录 → workspace 相对走 `readWorkspaceFileBinary`（HTTP）；absolute resolve 后走 `shell:readFileBinary`（IPC base64）→ data URL |
| 绝对路径（`/` / `~` / `file://`） | local-absolute | `shell:readFileBinary`（IPC base64 ≤2MB）→ data URL |
| `data:image/...` | data URI | **架构裁决**：放行 or 拦截（data: 在 isDangerousScheme 拦截列表——图片 data URI 常见，建议白名单 `data:image/` 放行，拦截非 image data:） |
| `javascript:` / `vbscript:` | dangerous | 拦截降级纯文本（现状 isDangerousScheme） |

### D3. 相对路径 resolve：新增 `baseDir` prop + Context 传递

- PrimitiveMarkdownView 新增可选 prop `baseDir?: string`（md 文件所在目录，用于 resolve 相对图片路径）。
- **消费方传递链路**：
  - `component-modal-md-editor.tsx`：有 `subtitle`（workspace 相对路径或绝对路径），derive baseDir = dirname(subtitle)（或新增 filePath prop，架构定）；传给 PrimitiveMarkdownView。
  - `component-message-stream.tsx`：chat 气泡无文件目录上下文（LLM 生成的 md 文本）→ baseDir 不传（undefined）→ 相对图片路径无法 resolve → 降级显示 alt 文本 + 错误提示。
  - skill-browser-modal / feishu-setup-doc：内置 content 无本地图片依赖 → baseDir 不传。
- **resolve 规则**（产品语义，实现归架构）：`baseDir` 有值 → `joinPath(baseDir, relativeUrl)` → 判断 join 后是 workspace 相对还是 absolute → 选对应 IPC 通道。

### D4. 点击放大：复用 ComponentWsImageViewer

- 内联 `<img>` onClick → 弹 ComponentWsImageViewer（复用 v0.0.269 既有组件，已支持 source 分流 workspace/absolute + data URL 渲染）。
- **传递**：点击时将当前图片的 resolved source + path + data URL 传给 viewer（workspace/absolute 走原 read 通道；web 图片点击放大需 viewer 支持 `src` URL 模式——**架构裁决**：viewer 新增 web source 或新建轻量放大 modal）。
- **简化方案（建议）**：web 图片点击放大 = 新建轻量 modal（直接 `<img src={url}>` 放大，不走 IPC）；本地图片 = 复用 WsImageViewer（已有 data URL）。

### D5. 加载状态 UI（loading / error / too-large）

- 本地图片异步读（IPC / HTTP）有延迟 → 需 loading / error 态：
  - **loading**：占位 placeholder（轻量灰底 + 图标 + alt 文案，不撑开布局）
  - **error**（文件不存在/权限拒绝）：显示 alt 文本 + 错误图标 muted
  - **too-large**（>2MB）：显示 alt 文本 + 「图片过大」提示
  - **not-found**：显示 alt 文本 + 「图片未找到」提示
- web 图片 loading/error 由浏览器原生 `<img>` onError/onLoad 处理（alt fallback）。
- **新增组件**：`primitive-markdown-image.tsx`（image 渲染 + 异步加载 + 点击放大），拆出独立文件保持渲染内核 ≤300 行（范本 `primitive-markdown-gfm-table.tsx`）。

---

## 3. 功能需求

### 3.1 图片语法渲染（核心）

| # | 需求 | 说明 |
|---|------|------|
| F1 | block 级 `![alt](url)` 渲染 | 独立行图片 → `<img>` 块（max-w-full + caption=alt） |
| F2 | 网络图片 http/https 直渲 | `<img src={url}>`（浏览器原生加载） |
| F3 | 本地绝对路径图片 | IPC readFileBinary → base64 → data URL → `<img>` |
| F4 | 本地相对路径图片 | baseDir resolve → workspace/absolute 分流读取 → data URL |
| F5 | 危险协议拦截 | javascript:/vbscript: 降级纯文本（isDangerousScheme 现状） |

### 3.2 点击放大

| # | 需求 | 说明 |
|---|------|------|
| F6 | 点击图片 → 放大预览 | 本地图片复用 WsImageViewer；web 图片轻量 modal（架构定） |
| F7 | 放大可关闭 | Esc / 遮罩点击 / ✕（对齐 L3 modal 统一交互） |

### 3.3 加载状态

| # | 需求 | 说明 |
|---|------|------|
| F8 | loading 占位 | 异步读取中显示轻量 placeholder |
| F9 | error 降级 | 失败显示 alt + 错误提示（不崩布局） |
| F10 | too-large 提示 | >2MB 显示 alt + 「图片过大」 |

### 3.4 回归不变量

| # | 需求 | 说明 |
|---|------|------|
| F11 | 现有 md 渲染不破坏 | 链接分发(280) / 表格 / 列表 / 代码块 / 标题 零变化 |
| F12 | 非 `!` 开头的 `[]()` 仍是链接 | `![alt](url)` = 图片；`[text](url)` = 链接（前置 `!` 区分） |

---

## 4. 关键用户路径

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 打开含 `![图](images/img1.svg)` 的 md 文件（workspace viewer） | 图片渲染（相对路径 resolve 到 md 目录 → IPC 读 base64 → data URL → `<img>`），不显示原始语法 |
| UC-2 | 打开含 `![logo](https://example.com/logo.png)` 的 md 文件 | 网络图片直渲（`<img src="https://...">`），浏览器/Electron 原生加载 |
| UC-3 | 打开含 `![pic](/Users/x/abs/path.png)` 绝对路径图片 | IPC readFileBinary → base64 → data URL → `<img>` 渲染 |
| UC-4 | 在 md viewer 点击已渲染的内联图片 | 弹出放大预览（WsImageViewer / 轻量 modal），Esc/遮罩关闭 |
| UC-5 | md 含 `![图](not-exist.svg)` 不存在的图片 | 显示 alt 文本「图」+ 错误图标 muted（不崩布局，不报错弹窗） |
| UC-6 | md 含 `![big](huge.svg)` 超大图片（>2MB） | 显示 alt + 「图片过大」提示 |
| UC-7 | md 含 `javascript:alert(1)` 伪图片 URL | 拦截降级纯文本（isDangerousScheme） |
| UC-8 | chat answer 气泡含 `![img](relative.png)` | baseDir 不可用 → 降级显示 alt 文本（chat 无文件目录上下文，相对路径无法 resolve） |
| UC-9 | md 含普通链接 `[doc](notes.md)` | 仍是链接（280 分发不变，前置无 `!`） |

---

## 5. 概念对齐（specs/ui + specs/tech）

| 概念 | 位置 | 关系 |
|------|------|------|
| PrimitiveMarkdownView | `common/primitive-markdown-view.tsx`（渲染内核） | 本版本扩展：加 block/inline 图片分支 |
| renderInline 切分层级 | 同上 L29-93 | 加图片分支（`![]()` 前置 `!` 区分链接） |
| isDangerousScheme | `lib/link-target.ts` | 危险协议拦截复用（data: 图片白名单架构裁决） |
| readFileBinary IPC | `open-external-ipc.ts`（v0.0.280） | absolute 图片 base64 读取复用 |
| readWorkspaceFileBinary | `chat-api/workspace-api.ts`（v0.0.269） | workspace 相对图片 base64 读取复用 |
| ComponentWsImageViewer | `chat-page/component-ws-image-viewer.tsx`（v0.0.269/280） | 点击放大复用（已支持 source + data URL） |
| GFM table helper | `common/primitive-markdown-gfm-table.tsx` | 拆分范本（image helper 同模式） |
| 280 openLocalPath | `lib/open-local-path.ts` | 图片渲染不调（渲染 ≠ 打开链接）；但点击放大 viewer 概念对齐 |

**新概念**：
- `baseDir` prop（PrimitiveMarkdownView 可选，md 文件目录用于 resolve 相对图片）
- `primitive-markdown-image.tsx`（图片渲染 helper 组件，异步加载 + 点击放大）

---

## 6. 边界 / 不做

- ❌ 不引入第三方 markdown/图片库（保持零依赖克制风格）
- ❌ 不做图片编辑（无裁剪/滤镜/保存——点击放大只读预览）
- ❌ 不做图片懒加载 / 虚拟滚动（md 图片量小，不引入复杂度）
- ❌ 不做 SVG 安全沙箱（SVG 作为 `<img src>` 渲染天然不执行脚本，浏览器安全模型已覆盖）
- ❌ 不做 base64 inline data URI 的通用支持（data:image/ 白名单由架构裁决，非 image data: 仍拦截）
- ❌ 不改 chat 气泡无 baseDir 场景（LLM 生成文本无文件目录，相对图片降级 alt——后续版本可考虑 workspaceDir fallback）
- ❌ 不做图片格式限制（IPC 读二进制→base64→data URL，浏览器决定能否渲染；6 格式白名单只管 ws-image-viewer 点击放大，不影响 md 内联渲染）

---

## 7. 验收口径

### 能力不变量
- [ ] `![alt](url)` block 级图片渲染（本地相对/绝对 + 网络 三源）
- [ ] 点击放大预览（本地复用 WsImageViewer；web 轻量 modal）
- [ ] loading / error / too-large 三态 UI
- [ ] 危险协议拦截（javascript:/vbscript: 降级纯文本）

### 回归不变量
- [ ] 现有链接 `[text](url)` 分发（280）零变化
- [ ] 表格 / 列表 / 代码块 / 标题 / 引用 / 加粗 / 行内代码 零变化
- [ ] 渲染内核拆分后 ≤300 行（image helper 独立文件）
- [ ] 布局稳定性：图片加载不撑开/抖动现有布局（max-w-full + placeholder 占位）

### ET 覆盖（老板要求）
- [ ] 本地相对路径图片渲染（UC-1）
- [ ] 网络图片渲染（UC-2）
- [ ] 点击放大（UC-4）
- [ ] 危险协议拦截（UC-7）

---

## 8. 测试建议

- **UT（主要）**：
  - `primitive-markdown-image.tsx`：三源分流（web/absolute/relative）+ loading/error/too-large 三态 + 点击放大回调
  - renderInline block 图片识别：`![alt](url)` 正则匹配 + `!` 前置区分链接
  - baseDir resolve：joinPath(baseDir, relative) → workspace/absolute 判定
  - 回归：现有渲染输出不变化（snapshot 对照）
- **ET（老板要求）**：4 条 case 覆盖 UC-1/2/4/7（本地相对 / 网络 / 点击放大 / 危险拦截）
- **AT**：不新增（纯前端渲染，无 API 变化）

---

## 9. 版本总结

- **新增**：PrimitiveMarkdownView 支持 `![alt](url)` 图片渲染（block 级优先 + inline 可选）；本地三源（web 直渲 / absolute IPC / relative baseDir resolve）+ 点击放大（复用 WsImageViewer）+ 加载三态
- **架构**：新增 `primitive-markdown-image.tsx` helper（异步加载 + 点击放大）；PrimitiveMarkdownView 加 `baseDir` prop + image block 分支；data:image/ 白名单由架构裁决
- **复用**：280 readFileBinary IPC + 269 readWorkspaceFileBinary HTTP + 269/280 WsImageViewer
- **零改动**：280 链接分发 / 现有 md block/inline 渲染 / IPC 通道本身
- **ET 覆盖**：本地相对 / 网络 / 点击放大 / 危险拦截 4 条
