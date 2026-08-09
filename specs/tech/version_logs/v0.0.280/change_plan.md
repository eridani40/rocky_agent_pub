# v0.0.280 变更计划书 — 聊天链接打开行为统一（≡ 右侧文件区）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（如 electron-ipc / web-link-lib / web-viewer-mount / web-workspace / web-i18n / tests） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 变更清单

<!-- 每行一个函数/符号；相关方法的行放在一起（同模块/同文件相邻） -->

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-link-lib | app/web/src/lib/open-local-path.ts | OpenLocalTarget | 新增 | 共享分发回调 target：`{ path: string; fileName: string; subtitle: string; format: FileFormat \| null; source: 'workspace' \| 'absolute' }`（format=null 表示 image 分支或 .url 降级 txt 前） | MUST source 透传调用方（消费方据此分流读/存）；MUST format nullable | PRD D1 §2.1 | +8 |
| web-link-lib | app/web/src/lib/open-local-path.ts | openLocalPath() | 新增 | 共享本地文件分发（唯一权威，聊天链 + 右侧 handleOpen 共用）。分流顺序固定：①kind==='folder' → 系统文件管理器（workspace→openWorkspaceItem kind=folder；absolute→rockyShell.openPath）②isRemoteLinkPath → .url 嗅探（workspace→openRemoteLink 失败降级 onEditor(format:'txt')；absolute→rockyShell.readFileText + parseUrlFileContent 命中→openLinkTarget(url) / 未命中→onEditor(format:'txt')）③isImagePath → onImageViewer ④getFileFormat!=null → onEditor(format) ⑤其余 → 系统打开（workspace→openWorkspaceItem kind=file；absolute→rockyShell.openPath）。内部 basename 派生 fileName/subtitle=path | MUST 分流顺序逐字保留（对齐右侧 v0.0.269 MUST 顺序）；MUST 复用 file-format.ts 单一权威（getFileFormat/isImagePath/isRemoteLinkPath）；MUST NOT 新开格式集/图片白名单；MUST NOT 做任何危险协议处理（调用方已拦）；kind=undefined（聊天链）跳过文件夹分支 | PRD D1 §2.1/D3；269 change_plan 行 34 | +70 |
| web-link-lib | app/web/src/lib/link-target.ts | OpenLinkTargetOpts.sessionId | 修改 | opts 加 `sessionId?: string`（openLocalPath workspace 源 .url 嗅探 + 系统打开用） | MUST 可选（无 Provider 消费方不传，行为不变） | PRD D1 | +1 |
| web-link-lib | app/web/src/lib/link-target.ts | openLinkTarget() | 修改 | local 分支改调 openLocalPath：有 onLocalViewer 时 → `openLocalPath(target, { sessionId, source: toChatLinkTarget(target).source, onEditor: (t)=>opts.onLocalViewer!({path: target, source, fileName: t.fileName}), onImageViewer: 同 })`（回调只传 path/source/fileName——ChatLinkTarget 零改动）；无 onLocalViewer（无 Provider）→ 降级 rockyShell.openPath 不变 | MUST web/dangerous 分支零改动（openExternal / 拦截语义逐字保留）；MUST isDangerousScheme 不放宽不收紧；MUST 无 Provider 降级行为不变（12 格式也系统打开） | PRD D1/§3.1 F6；253 change_plan 行 60 | +12/-8 |
| web-md-render | app/web/src/components/common/primitive-markdown-view.tsx | renderInline linkOpts | 修改 | linkOpts 构造带 sessionId（`handler ? { onLocalViewer: handler.onLocalViewer, sessionId: handler.sessionId } : null`） | MUST 无 Provider 时不带（null 分支不变）；MUST NOT 改 <a> 渲染/危险协议降级分支 | PRD D1；253 change_plan 行 68 | +1 |
| web-viewer-mount | app/web/src/components/chat-page/component-chat-link-viewer.tsx | ComponentChatLinkViewer | 修改 | ①去 readOnly：渲染 ComponentModalMdEditor 传 `onSave`（workspace→saveWorkspaceFile(sessionId,{path,content})；absolute→rockyShell.writeFileText(path,content)）+ 成功 toast「已保存」（复用 ws-file-editor flash 范式 2.6s）②渲染分流：target 就绪后 `isImagePath(target.path)` → 挂 ComponentWsImageViewer（传 source=target.source）；否则 → ComponentModalMdEditor（format=getFileFormat ?? 'txt'，onSave）③读内容逻辑不变（workspace→readWorkspaceFile / absolute→readFileText） | MUST 覆盖 v0.0.253 强制只读（readOnly 不再传）；MUST 保存 last-write-wins + toast（与右侧一致）；MUST 保留 reqId 防竞态 + loading/error pill；MUST 非 Electron absolute 读/写友好错误；MUST NOT 改 ComponentModalMdEditor 组件本身 | PRD D2/D3 §3.1 F1-F5；253 change_plan 行 74 | +40/-5 |
| web-viewer-mount | app/web/src/components/chat-page/component-ws-image-viewer.tsx | WsImageTarget.source + ComponentWsImageViewer | 修改 | WsImageTarget 加 `source?: 'workspace' \| 'absolute'`（缺省 workspace）；读分流：source==='absolute' → rockyShell.readFileBinary(path) → base64 data URL；否则 → readWorkspaceFileBinary（现状） | MUST 缺省 workspace → 右侧 handleOpen 调用零变化；MUST 错误语义对齐（not-found/permission-denied/too-large → loadFail）；MUST 6 格式白名单/mediaType 映射零改动 | PRD D3 §3.1 F2；269 change_plan 行 | +12 |
| web-workspace | app/web/src/components/chat-page/section-workspace-panel.tsx | handleOpen() | 修改 | 内部改调 openLocalPath：`openLocalPath(node.path, { sessionId, source:'workspace', kind: node.type, onEditor: (t)=>setFileEditorTarget({path:t.path, fileName:t.fileName, subtitle:t.subtitle, format:t.format ?? 'txt'}), onImageViewer: (t)=>setWsImageTarget({path:t.path, fileName:t.fileName, subtitle:t.subtitle}) })` | MUST 行为零变化（五路分流语义原样保留——folder/.url/image/12格式/系统打开）；MUST NOT 改 openRemoteLink/readWorkspaceFile/saveWorkspaceFile 既有调用 | PRD D5 §2.5；269 change_plan 行 34 | +8/-14 |
| electron-ipc | app/electron/src/open-external-ipc.ts | WriteFileTextResult | 新增 | 返回形状 `{ ok: boolean; reason?: string }`（复用 OpenExternalResult 形状即可，不新增 interface——如复用则本行并入 computeWriteFileText） | MUST 与 openExternal 返回形状一致（ok/reason） | PRD D4；253 范本 | +0 |
| electron-ipc | app/electron/src/open-external-ipc.ts | computeWriteFileText() | 新增 | 写绝对路径文本（utf8，fs.writeFile 直接覆盖=last-write-wins）。接收已展开绝对路径。ENOENT（父目录不存在）/ EACCES / 异常 → reason 不抛 | MUST 对齐 readFileText 错误语义（not-found/permission-denied/errText）；MUST 无目录白名单（信任策略沿用 v0.0.253 §2.3）；MUST 无大小上限强制（文本编辑保存，写入方已读限 2MB） | PRD D4 §2.4；253 computeReadFileText 范本 | +18 |
| electron-ipc | app/electron/src/open-external-ipc.ts | ReadFileBinaryResult | 新增 | 返回形状 `{ ok: boolean; content?: string; reason?: string }`（content=base64） | MUST 镜像 workspace readWorkspaceFileBinary 返回形态（前端拼 data URL） | PRD D4 | +5 |
| electron-ipc | app/electron/src/open-external-ipc.ts | computeReadFileBinary() | 新增 | 读绝对路径二进制 → Buffer → base64（图片 viewer 用）。大小上限对齐 readFileText 2MB（防超大拖垮 viewer），超限 reason='too-large'；ENOENT/EACCES → reason | MUST 大小上限 2MB（与 readFileText 对称）；MUST 错误语义同 readFileText；MUST 不检测内容类型（前端 mediaTypeFromPath 已按扩展名） | PRD D4 §2.4；253 computeReadFileText 范本 | +20 |
| electron-ipc | app/electron/src/open-external-ipc.ts | registerOpenExternalIpc() | 修改 | 加 `shell:writeFileText`（args {path, content}）+ `shell:readFileBinary`（args {path}）两 channel；均先 computeResolveLocalPath 展开（相对路径 → reason='relative-not-allowed'） | MUST channel 名 `shell:*` 硬编码（对齐既有三通道）；MUST 在 main.ts app.whenReady 后注册（同既有） | PRD D4；253 change_plan 行 32 | +12 |
| electron-preload | app/electron/src/preload.ts | rockyShell expose | 修改 | contextBridge 加 `writeFileText: (path, content) => invoke('shell:writeFileText', { path, content })` + `readFileBinary: (path) => invoke('shell:readFileBinary', { path })` | MUST sandbox=true 下仅 ipcRenderer.invoke（同范式）；MUST payload 对象（{path, content} / {path}） | PRD D4；253 change_plan 行 45 | +6 |
| web-types | app/web/src/types/rocky-shell.d.ts | RockyShellApi | 修改 | 加 `writeFileText(path: string, content: string): Promise<{ok, reason?}>` + `readFileBinary(path: string): Promise<{ok, content?, reason?}>` | MUST 与 open-external-ipc.ts 返回形状逐字一致；MUST NOT import electron | PRD D4；253 change_plan 行 51 | +8 |
| web-i18n | app/web/src/i18n/locales/en/chat.json + zh-CN/chat.json | linkViewer.saved / linkViewer.writeFail | 新增 | 「已保存」（保存成功 toast，对齐 workspace.mdEditor.saved 文案）+「保存失败」错误文案 | MUST en/zh 双语言齐；MUST 复用现有 linkViewer namespace | PRD D2 | +4 |
| tests | app/web/src/lib/__tests__/open-local-path.test.ts | openLocalPath 分发分支 | 新增 | 5 分支 × 2 source（workspace/absolute）× kind（file/folder/undefined）组合：folder→openWorkspaceItem/openPath；.url 命中→openRemoteLink/readFileText+openLinkTarget；.url 未命中→onEditor txt；image→onImageViewer；12 格式→onEditor(format)；其余→openWorkspaceItem kind=file/openPath | MUST mock workspace-api + window.rockyShell + openLinkTarget（jsdom）；MUST 断言真实分发（不复制逻辑） | PRD §8 | +85 |
| tests | app/electron/__tests__/open-external-ipc.test.ts | computeWriteFileText / computeReadFileBinary | 新增 | 写成功/ENOENT（父目录缺）/EACCES；读成功 base64/超 2MB too-large/ENOENT/EACCES | MUST 注入 fake fs（对齐 computeReadFileText 既有测试范式） | PRD D4 | +45 |
| tests | app/web/src/components/chat-page/__tests__/component-chat-link-viewer.test.tsx | 可编辑 + image 分支 | 新增 | 12 格式：mode-toggle/保存按钮出现 + onSave 落盘（workspace→saveWorkspaceFile 调用 / absolute→rockyShell.writeFileText 调用）+ toast；图片：isImagePath 命中 → image viewer 渲染（source 透传）；.url 降级 txt editor | MUST 断言真实渲染（testid）+ 保存调用参数 | PRD §8 | +55 |
| tests | app/web/src/lib/__tests__/link-target.test.ts | openLinkTarget local 分支 | 修改 | local 分支调 openLocalPath 断言（mock openLocalPath 验证调用参数 path/source/onEditor/onImageViewer）；web/dangerous 用例保留零改动 | MUST 保留既有 web/dangerous/classify 用例（回归不变量）；MUST 无 Provider 降级 openPath 用例保留 | PRD §7/§8 | +12 |
| tests | app/web/src/components/chat-page/__tests__/component-ws-image-viewer.test.tsx | source 分支 | 修改 | 缺省 workspace → readWorkspaceFileBinary（既有用例回归）；source='absolute' → rockyShell.readFileBinary → data URL | MUST 既有 workspace 用例零改动（缺省语义） | PRD D3 | +10 |

## 影响面评估

- **跨模块**：electron-ipc（新 2 通道）→ preload/d.ts（bridge）→ web-link-lib（openLocalPath 新文件 + link-target 改造）→ web-viewer-mount（chat-link-viewer 去只读 + ws-image-viewer source）→ web-workspace（handleOpen 改调）+ primitive-markdown-view（sessionId 透传）+ i18n + 4 测试文件。依赖顺序：electron-ipc（T1）→ web 层（T2，d.ts 类型先行）。
- **破坏性变更**：无（全部 additive/改造；ChatLinkTarget 形状零改动、右侧 handleOpen 行为零变化、web/dangerous 拦截零变化、12 格式集/6 图片白名单零变化）。
- **覆盖旧决策**：v0.0.253 PRD §2.2「强制只读」作废（老板 2026-08-07 拍板）——本版本显式覆盖。
- **关键设计裁决**：
  1. **openLocalPath 独立新文件**（不扩展 link-target.ts）——link-target 是「链接分类 + web/dangerous 拦截」职责，openLocalPath 是「本地文件分发」职责；且 section-workspace-panel 调 openLocalPath 若放 link-target 会引入 panel→link-target 的无关依赖。独立文件职责清晰 + 两处消费方直接 import。
  2. **ChatLinkTarget 零改动**——viewer 内部按 `isImagePath(target.path)` 分流渲染（image→WsImageViewer / 其他→ModalMdEditor），message-stream state / Context 契约 / toChatLinkTarget 全不动，回归面最小。
  3. **absolute 图片 = 新 IPC `shell:readFileBinary`**（返回 base64）——readFileText 是 utf8 读取，二进制会损坏不可复用；base64 形态与 workspace readWorkspaceFileBinary 完全一致（前端拼 `data:image/{ext};base64,` 复用 mediaTypeFromPath）。
  4. **ComponentWsImageViewer 加 source prop（缺省 'workspace'）**——右侧 handleOpen 调用零改动；聊天链 absolute 图传 source='absolute'。
  5. **.url 嗅探复用**：workspace 源直接复用 openRemoteLink（内部已 readWorkspaceFile+parseUrlFileContent+openLinkTarget）；absolute 源无现成封装（openRemoteLink 绑 workspace HTTP 读）→ openLocalPath 内 3 行（readFileText + parseUrlFileContent + openLinkTarget），parseUrlFileContent 纯函数复用。
  6. **writeFileText 无大小上限**（保存侧；读侧已限 2MB 防拖垮，写回同规模内容对称安全）。
- **风险点**：ComponentChatLinkViewer 同时挂两种 modal（ModalMdEditor / WsImageViewer）——if/else 单分支渲染不冲突；WsImageViewer 的 Esc 关闭与 ModalMdEditor 各自独立（同一时刻只挂一个）；openLocalPath 的 fileName 派生需内部 basename（file-format basename 私有，不导出——内部实现 5 行，不破坏 file-format 封装）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
