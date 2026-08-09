# v0.0.280 tech change log — 聊天链接打开行为统一（≡ 右侧文件区）

> 对应需求：`reqs/[working] v0.0.280/req.md`（老板铁律 2026-08-07：同一本地文件聊天区与右侧文件区打开行为永远一样）。
> PRD：`specs/prd/version_logs/v0.0.280/prd.md`（D1-D5 + UC-1~9）。
> 权威契约：`specs/tech/version_logs/v0.0.280/change_plan.md`（method 级 24 行表，frozen）。
> **覆盖旧决策**：v0.0.253 PRD §2.2「强制只读」作废（老板 2026-08-07 拍板）。

## 变更摘要

### 需求与动机

v0.0.253 引入聊天链接点击分发时，12 格式本地文件强制 readOnly（无编辑/保存按钮）。老板铁律：同一本地文件聊天区与右侧文件区打开行为永远一样——右侧可编辑、聊天链也应可编辑；右侧五路分流（folder/.url/image/12 格式/系统打开）、聊天链也应统一。核心 = 抽共享 `openLocalPath` 分发 lib 两处共用 + 聊天链 viewer 去只读 + 补 image/.url/absolute 分流 + 新增 absolute 写/读二进制 IPC。

### 方案（6 架构裁决，详见 change_plan「关键设计裁决」）

1. **openLocalPath 独立新文件**（裁决①）：不扩展 link-target.ts——link-target 职责=分类+拦截，openLocalPath=本地分发；panel 直接 import 不引入无关依赖。
2. **ChatLinkTarget 零改动**（裁决②）：viewer 内部 `isImagePath(target.path)` 分流渲染（image→WsImageViewer / 其他→ModalMdEditor），message-stream state / Context 契约全不动。
3. **absolute 图片 = 新 IPC `shell:readFileBinary`**（裁决③）：readFileText 是 utf8 不可复用；base64 形态与 workspace readWorkspaceFileBinary 一致（前端拼 data URL 复用）。
4. **WsImageViewer 加 source prop 缺省 workspace**（裁决④）：右侧 handleOpen 调用零变化；聊天链 absolute 图传 source='absolute'。
5. **.url 嗅探复用**（裁决⑤）：workspace 源复用 openRemoteLink；absolute 源 3 行内联（readFileText+parseUrlFileContent+openWebUrl）。
6. **writeFileText 无大小上限**（裁决⑥）：读侧已限 2MB，写回同规模内容对称安全。

### T1 — electron IPC（commit 1b27788ee，8 文件 +280/-13）

- **open-external-ipc.ts（191→267）**：`computeWriteFileText()`（utf8 覆盖 last-write-wins；ENOENT→not-found / EACCES→permission-denied / 其他→errText）+ `computeReadFileBinary()`（stat 预检 size>2MB→too-large；base64 返回；错误语义同 readFileText）+ `registerOpenExternalIpc` 加 `shell:writeFileText` / `shell:readFileBinary`（均先 computeResolveLocalPath 展开→相对路径 relative-not-allowed）。FsLike 扩展 readFile TS 重载 + writeFile 必填。
- **preload.ts + rocky-shell.d.ts**：镜像 `writeFileText(path, content)` + `readFileBinary(path)` 两方法。
- **UT**：computeWriteFileText 4 用例 + computeReadFileBinary 6 用例（fakeFs 注入断言真实依赖调用，含 too-large 短路断言 readFile 不调）。**30/30 全绿（bun --bun）+ tsc 0**。

### T2 — web 共享分发 + viewer 改造（commit 41dd98d22，16 files +875/-92）

- **`open-local-path.ts` NEW（151 行）**：共享本地文件分发 lib（5 分支 × 2 源）——①folder→系统文件管理器 ②`.url`→嗅探浏览器（workspace→openRemoteLink / absolute→readFileText+parseUrlFileContent+openWebUrl；失败降级 txt editor）③image→onImageViewer ④12 格式→onEditor(format) ⑤其余→系统打开。basename 内部 5 行（file-format basename 私有不导出）。
- **link-target.ts（+12/-8）**：local 分支改调 openLocalPath（有 onLocalViewer → `openLocalPath(target, { sessionId, source, onEditor, onImageViewer })`；无 Provider → 降级 openPath 不变）；opts 加 `sessionId?: string`；web/dangerous 分支零改动。
- **component-chat-link-viewer.tsx（+40/-5）**：去 readOnly 传 onSave（workspace→saveWorkspaceFile / absolute→writeFileText）+ 渲染分流（isImagePath→WsImageViewer source 透传 / 否则→ModalMdEditor format=getFileFormat ?? 'txt'）+ image 分支不读文本（直接清态走渲染分流）+ 成功 toast「已保存」（2.6s flash）。
- **component-ws-image-viewer.tsx（+12）**：WsImageTarget 加 `source?: 'workspace'|'absolute'`（缺省 workspace）；source='absolute' → readFileBinary IPC → base64 data URL。
- **section-workspace-panel.tsx（+8/-14）**：handleOpen 改调 openLocalPath（行为零变化，五路分流语义原样保留；WsTreeNode type 'dir'→'folder' 映射）。
- **remote-link.ts**：`openWebUrl` 导出（断循环依赖——remote-link 不再 import link-target）。
- **primitive-markdown-view.tsx（+1）**：linkOpts 构造带 sessionId。
- **i18n en/zh chat.json**：`linkViewer.saved` / `linkViewer.writeFail`。
- **UT**：open-local-path 16 + link-target 27 回归 + chat-link-viewer 9 + ws-image-viewer 11 + workspace-panel 30 回归 + markdown-view 36 回归 = **8 集 129 全绿（bun --bun）+ tsc 0**。

### 代码↔spec 核实（doc-modifier 阶段 5）

| 契约点 | 代码 | 结果 |
|---|---|---|
| openLocalPath 5 分支×2 源 == spec 分发表 | open-local-path.ts L104-149（folder→.url→image→12格式→系统；workspace/absolute 双源分流） | ✅ |
| chat-link-viewer 去 readOnly 传 onSave == spec | L191-200 传 onSave=handleSave（L128-145 workspace→saveWorkspaceFile / absolute→writeFileText） | ✅ |
| 右侧 handleOpen 行为零变化 == spec 声明 | section-workspace-panel L154-166 改调 openLocalPath（五路语义原样；30 回归佐证） | ✅ |
| 零改动边界（ModalMdEditor/file-format/web 分发/危险拦截/图片白名单） | T1/T2 commit 文件清单 + review git diff 核实（ModalMdEditor / file-format.ts / link-target web+dangerous 分支 / isDangerousScheme 全未碰） | ✅ |

### 偏离记录

- **偏离1：循环依赖断环（remote-link.ts 越界修改）— coder2 自报，reviewer 4Q 判断合理**：openLocalPath → openRemoteLink → openLinkTarget(link-target) → openLocalPath 形成环（vitest mock 下命名绑定 undefined，5 轮 debug 确认）。断环 = remote-link.ts 不再 import link-target（`openWebUrl` 内联导出，与 link-target web 分支逐字等价：Electron→openExternal / 非→window.open），open-local-path 从 remote-link 复用 openWebUrl，link-target → open-local-path 单向。**语义零变化 + 断环方案最优（不移动 openLocalPath，独立文件是裁决①）+ 已报备**。
- **偏离2：image 分支不读文本（change_plan 遗漏修复）— reviewer 核为真实缺陷修复**：change_plan 行 29「读内容逻辑不变」指非 image 分支。原 useEffect 无条件先读文本（v0.0.253 遗留——只有 readOnly editor 一条路），image 二进制文件 readFileText 失败 → error pill 挡住 image viewer。修复 = image 分支直接清态走渲染分流（对齐右侧 handleOpen image 直接 onImageViewer 不读文本）。WsImageViewer 内部自行读二进制。

## 文档同步（doc-modifier 阶段 5）

- `component-chat-link-viewer.md`：标题去「只读」+ 职责段重写（可编辑 + image 分流 + 覆盖 v0.0.253）+ 状态/交互段（渲染分流 + onSave 双源 + image 不读文本）+ 可见文案（toast saved）+ 复用关系（去 readOnly 描述 + 加 WsImageViewer/writeFileText）。
- `component-ws-image-viewer.md`：source prop（缺省 workspace / absolute→readFileBinary IPC）+ Props WsImageTarget 加 source + 数据读取段加 absolute 分流。
- `component-workspace-panel.md §4.4`：handleOpen 段补「v0.0.280 改调共享 openLocalPath lib」+ 共享分发 lib 说明段。
- `00-app-guide.md`：聊天链接分发段重写（去「只读 viewer」→「可编辑 + image/.url 分流 + ≡ 右侧文件区」+ 共享 openLocalPath lib）。
- `specs/tech/app/frontend/index.md`：v0.0.253 link-target 概念行扩 v0.0.280 openLocalPath 共享分发 + 去 readOnly + 新 IPC 通道。
