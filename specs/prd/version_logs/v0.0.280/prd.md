# v0.0.280 PRD — 聊天链接打开行为统一（≡ 右侧文件区）

- **版本号**: v0.0.280
- **版本主题**: 聊天链接打开行为统一 ≡ 右侧文件区（同一本地文件两处打开行为永远一致）
- **需求文件**: `reqs/[working] v0.0.280/req.md`（老板铁律 2026-08-07）
- **工作目录**: `worktrees/0.0.280-chat-link-unify`
- **类型**: 用户可感知行为变化（跨两处打开链路统一 + 覆盖旧「强制只读」决策）→ 完整 PRD

---

## 1. 背景

### 1.1 现状：两条打开链路分叉

**聊天链接链（v0.0.253 建立）**：
- `PrimitiveMarkdownView` 渲染 md 链接 `<a>` → onClick → `openLinkTarget(url, linkOpts)`（lib/link-target.ts）
- 分发：dangerous 拦截 → web 浏览器 → local：`isBuiltinEditable`（12 格式）→ `onLocalViewer` 弹 `ComponentChatLinkViewer`；其它 → `openPath` 系统打开
- **12 格式强制只读**：`ComponentChatLinkViewer` 挂 `ComponentModalMdEditor readOnly=true`（无 mode-toggle / 无保存）；absolute 路径走 IPC `readFileText`（无写能力）

**右侧 workspace 链（v0.0.269 建立）**：
- `SectionWorkspacePanel.handleOpen(node)` 五路前置分流：文件夹 → 系统文件管理器（kind=folder）→ .url → 浏览器嗅探（嗅探失败降级 editor）→ image 6 格式 → 内置 viewer → text 12 格式 → **内置 editor 可编辑**（saveWorkspaceFile 落盘）→ 其余 → 系统打开（kind=file）
- 全部 workspace 相对路径，走 HTTP read/save

### 1.2 痛点（老板铁律）

同一个本地文件，聊天区点链接与右侧文件区点开**行为不一样**：聊天区只读、右侧可编辑；聊天区图片走系统应用、右侧内置 viewer；聊天区 .url 走系统应用、右侧浏览器打开。老板拍板：**同一个本地文件，聊天区域和右侧文件区域打开行为永远一样，无例外。**

### 1.3 统一后行为（对齐右侧 handleOpen，老板已定）

| 类型 | 统一行为 |
|---|---|
| http/https | 浏览器（openExternal） |
| 认识文本 12 格式（md/json/yaml 等） | 内置 editor（**可编辑**，去强制只读） |
| 图片（6 格式） | 内置 image viewer（只读） |
| .url 快捷方式 | 嗅探 URL → 浏览器；失败降级 editor |
| 文件夹 | 系统文件管理器 |
| 不认识格式 | 系统默认应用（openPath） |
| 危险协议 | 拦截（不变） |

### 1.4 关键设计原则（leader 拍板，进 PRD）

1. **一套分发逻辑两处共用**：抽共享 lib，聊天链接点击与右侧 handleOpen 调同一套——杜绝再分叉
2. **本地文件含 workspace 相对 + 绝对路径**：聊天区可能有绝对路径，按同一规则分发
3. **本版本 = 覆盖 v0.0.253「强制只读」旧决策**（老板 2026-08-07 新拍板），PRD 显式标注

---

## 2. 核心决策

### D1. 抽共享分发 lib：`openLocalPath`（统一两处）

- 新增 `app/web/src/lib/open-local-path.ts`（或扩展 link-target.ts，架构期定），核心函数统一分流：
  ```
  openLocalPath(target, opts: {
    sessionId: string;          // workspace 相对路径 HTTP 读/存用
    source: 'workspace'|'absolute';  // 路径来源（右侧恒 workspace；聊天链 toChatLinkTarget 派生）
    kind?: 'file'|'folder';     // 已知类型（右侧传 node.type；聊天链不传 = undefined）
    onEditor: (t: EditorTarget) => void;      // 12 格式 → 挂内置 editor（可编辑）
    onImageViewer: (t: ImageTarget) => void;  // 6 格式图片 → 挂内置 viewer
  })
  ```
- **分流顺序（对齐右侧 v0.0.269 MUST 顺序）**：
  1. `kind === 'folder'`（右侧）→ 系统文件管理器（workspace → `openWorkspaceItem kind=folder`；absolute → `openPath`）
  2. `isRemoteLinkPath`（.url）→ 嗅探浏览器（workspace → `openRemoteLink` HTTP 读；absolute → IPC readFileText + parseUrlFileContent）；嗅探失败 → 降级 editor（format='txt'）
  3. `isImagePath`（6 格式）→ `onImageViewer`（workspace → `readWorkspaceFileBinary`；absolute → IPC 读二进制）
  4. `getFileFormat != null`（12 格式）→ `onEditor`（**可编辑**，带 onSave）
  5. 其余 → 系统打开（workspace → `openWorkspaceItem kind=file`；absolute → `openPath`）
- **kind=undefined（聊天链）**：无 type 信息 → 跳过文件夹分支；12 格式/图片/.url 命中按类型分发，不命中落「系统打开」——`openPath` 对目录同样打开系统文件管理器，行为等价。

### D2. 去强制只读：聊天链 12 格式可编辑

- `ComponentChatLinkViewer` 渲染 `ComponentModalMdEditor` **不再传 readOnly**，改传 `onSave`（workspace 相对 → `saveWorkspaceFile` HTTP；absolute → 新 IPC `writeFileText`，架构期补通道）
- 覆盖 v0.0.253 PRD §2.2「chat 链接打开的本地文件 = 只读（v1 不做写回）」——老板 2026-08-07 新拍板作废该决策
- 保存语义与右侧一致：last-write-wins + 成功 toast「已保存」

### D3. 聊天链补 image viewer + .url 嗅探 + 文件夹分支

- **图片**：`isImagePath` 命中 → 挂 `ComponentWsImageViewer`（复用，只读）；workspace 相对走 `readWorkspaceFileBinary`，absolute 走 IPC 二进制读（新通道，架构期定）
- **.url**：`isRemoteLinkPath` 命中 → 嗅探浏览器（复用 `parseUrlFileContent`）；absolute .url 内容读取走 IPC readFileText
- **文件夹**：聊天链 kind=undefined，不显式区分；目录路径落「系统打开」→ openPath 打开系统文件管理器（行为等价右侧）

### D4. absolute 路径能力补齐（架构期定实现，PRD 定义语义）

- absolute 12 格式**可编辑保存**：需 IPC `writeFileText` 新通道（现有只有 readFileText）
- absolute 图片**内置 viewer**：需 IPC 二进制读通道（或复用 readFileText 二进制形态，架构期定）
- 安全：absolute 路径沿用 v0.0.253 §2.3「个人 agent app 信任任意路径」决策，不做目录白名单（与右侧 workspace 白名单独立）

### D5. 右侧 handleOpen 改调共享 lib（零行为变化）

- `SectionWorkspacePanel.handleOpen` 内部改调 `openLocalPath(node.path, { sessionId, source:'workspace', kind:node.type, onEditor:setFileEditorTarget, onImageViewer:setWsImageTarget })`
- 右侧现有行为**完全不变**（五路分流语义原样保留），只换实现入口——回归面最小

---

## 3. 功能需求

### 3.1 聊天链接分发统一（核心）

| # | 需求 | 说明 |
|---|------|------|
| F1 | 聊天 md 链接点 12 格式文件 → 内置 editor **可编辑** | 去 readOnly；mode-toggle + 保存按钮出现；保存落盘 + toast |
| F2 | 聊天 md 链接点图片（6 格式）→ 内置 image viewer | 复用 ComponentWsImageViewer；只读图片弹层 |
| F3 | 聊天 md 链接点 .url → 嗅探浏览器 | 复用 parseUrlFileContent；嗅探失败降级 editor（txt） |
| F4 | 聊天 md 链接点不认识格式 → 系统打开 | 现状保留（openPath） |
| F5 | 聊天 md 链接点绝对路径文件 | 同规则分发（可编辑保存/图片 viewer/.url 嗅探/系统打开） |
| F6 | 危险协议拦截 | 不变（isDangerousScheme） |

### 3.2 共享 lib 统一两处

| # | 需求 | 说明 |
|---|------|------|
| F7 | 抽 `openLocalPath` 共享分发函数 | 聊天链接 + 右侧 handleOpen 调同一套；杜绝再分叉 |
| F8 | 右侧 handleOpen 改调共享 lib | 行为零变化（五路分流语义保留） |
| F9 | 格式判定单一权威 | 复用 file-format.ts（getFileFormat/isImagePath/isRemoteLinkPath）不新开格式集 |

### 3.3 absolute 路径能力

| # | 需求 | 说明 |
|---|------|------|
| F10 | absolute 12 格式保存落盘 | IPC writeFileText（新通道，架构期定） |
| F11 | absolute 图片内置 viewer | IPC 二进制读（架构期定） |
| F12 | absolute 信任策略 | 沿用 v0.0.253 §2.3 不做目录白名单 |

---

## 4. 关键用户路径

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 聊天区点 agent 回复里 `[notes.md](notes.md)` 链接 | 弹内置 editor（md 渲染）→ 点「编辑」→ 修改 → 点「保存」→ 落盘 + toast「已保存」（与右侧打开同一文件行为一致） |
| UC-2 | 聊天区点 `[logo.png](logo.png)` 链接 | 弹内置 image viewer（只读图片弹层，img 完整渲染），无编辑按钮 |
| UC-3 | 聊天区点 `[快捷方式](shortcut.url)` 链接 | 嗅探 URL → 系统浏览器打开目标；无 URL → 降级 editor（txt plain） |
| UC-4 | 聊天区点 `[配置](/Users/x/proj/config.yaml)` 绝对路径链接 | 弹内置 editor（可编辑）→ 保存 → 落盘到绝对路径 + toast |
| UC-5 | 右侧 workspace 文件树点文件 | 行为与 v0.0.269 完全一致（同一套 lib，回归验证） |
| UC-6 | 聊天区点 `[文档](https://example.com)` | 系统浏览器打开（不变） |
| UC-7 | 聊天区点 `[脚本](run.py)`（不认识格式） | 系统默认应用打开（不变） |
| UC-8 | 聊天区点 `[目录](src/)` 或绝对目录路径 | 系统文件管理器打开目录（openPath 对目录等价右侧 kind=folder） |
| UC-9 | 聊天区点 `javascript:alert(1)` | 拦截降级纯文本不可点（不变） |

---

## 5. 概念对齐（specs/ui + specs/tech）

| 概念 | 位置 | 关系 |
|------|------|------|
| openLinkTarget 分发 | `lib/link-target.ts`（v0.0.253） | local 分支改调共享 openLocalPath；web/dangerous 不变 |
| handleOpen 五路分流 | `section-workspace-panel.tsx`（v0.0.269） | 改调共享 lib；语义零变化 |
| 格式判定 | `lib/file-format.ts`（getFileFormat/isImagePath/isRemoteLinkPath） | 单一权威复用，不新开 |
| ComponentModalMdEditor | `common/component-modal-md-editor.md` | readOnly 可选能力保留；聊天链不再强制 readOnly |
| ComponentWsImageViewer | `chat-page/component-ws-image-viewer.md`（v0.0.269） | 复用（聊天链图片打开） |
| ComponentChatLinkViewer | `chat-page/component-chat-link-viewer.md`（v0.0.253） | 改可编辑 + 补 image/.url/文件夹分支 |
| rockyShell IPC | `types/rocky-shell.d.ts` + `open-external-ipc.ts` | 补 writeFileText（+二进制读，架构期定） |
| openRemoteLink / parseUrlFileContent | `lib/remote-link.ts`（v0.0.263） | 复用 .url 嗅探 |

**新概念**：`openLocalPath`（共享本地文件分发函数）——先落 specs/tech（frontend lib），本 PRD 引用。

---

## 6. 边界 / 不做

- ❌ 不改 web 链接分发（openExternal / window.open 兜底）——不变
- ❌ 不改危险协议拦截（isDangerousScheme 语义逐字保留）
- ❌ 不改右侧 workspace 现有行为（只换实现入口，语义零变化）
- ❌ 不做目录白名单（absolute 信任策略沿用 v0.0.253 §2.3）
- ❌ 不新建图片格式白名单（6 格式闭合不变，范围不扩大）
- ❌ 不做 .url 类型扩展（v1 只 .url，PRD §6 边界保留）
- ❌ 不改 12 格式分类表（md + structured 7 + plain 4 不变）
- ❌ 不引入第三方 markdown/图片库（克制零依赖保持）

---

## 7. 验收口径

### 能力不变量
- [ ] 聊天链接点 12 格式文件 → 内置 editor 可编辑 + 保存落盘（workspace 相对 + absolute 两源）
- [ ] 聊天链接点 6 格式图片 → 内置 image viewer（两源）
- [ ] 聊天链接点 .url → 浏览器嗅探（失败降级 editor）
- [ ] 聊天链接点不认识格式 → 系统打开（不变）
- [ ] 右侧 handleOpen 行为与 v0.0.269 完全一致（回归）

### 回归不变量
- [ ] web 链接 / 危险协议行为零变化
- [ ] 12 格式分类表 / 6 图片白名单 / .url 判定零变化
- [ ] 右侧打开文件保存链路（saveWorkspaceFile + toast）零变化
- [ ] 布局稳定性：editor/viewer modal 视觉与 v0.0.253/269 基线一致

### 一致性铁律
- [ ] 同一文件（workspace 相对或 absolute）聊天区与右侧打开**行为逐项一致**（编辑能力/图片查看/.url 嗅探/系统打开/文件夹）

---

## 8. 测试建议

- **UT（主要）**：
  - `openLocalPath` 分发纯函数：5 分支 × 2 source（workspace/absolute）× kind（file/folder/undefined）——mock IPC/HTTP
  - ComponentChatLinkViewer：可编辑渲染（mode-toggle + 保存按钮出现）+ onSave 落盘调用 + image/.url 分支
  - link-target.ts 回归：web/dangerous 不变；local 分支调 openLocalPath
  - handleOpen 改调共享 lib 后现有测试回归（行为零变化）
- **AT/ET**：按核心冒烟集纪律**不新增持久 case**——分发是确定性前端行为（非 LLM 不确定性）；聊天主链路回归现有 send-message case 即可

---

## 9. 版本总结

- **统一**：聊天链接打开行为 ≡ 右侧文件区（老板铁律）——12 格式可编辑 / 图片内置 viewer / .url 浏览器嗅探 / 文件夹系统打开 / 不认识系统打开 / 危险拦截不变
- **架构**：抽共享 `openLocalPath` 分发 lib，聊天链接 + 右侧 handleOpen 共用一套——杜绝再分叉；格式判定复用 file-format.ts 单一权威
- **覆盖旧决策**：v0.0.253 PRD §2.2「强制只读」作废（老板 2026-08-07 新拍板）
- **新增能力**：absolute 路径编辑保存（IPC writeFileText）+ absolute 图片查看（IPC 二进制读），架构期定实现
- **零变化**：web 分发 / 危险拦截 / 右侧 workspace 现有行为 / 12 格式分类 / 6 图片白名单
