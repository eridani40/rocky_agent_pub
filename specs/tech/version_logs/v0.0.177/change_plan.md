# v0.0.177 变更计划书 — 粘贴剪切板图片 → 存 ws/images → 插 @file pill

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
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| workspace_api（后端 route） | app/server/src/routes/router-helpers.ts | matchSessionPath | 修改 | 在 workspace 子段正则 `(tree\|open\|pick-directory\|watch\|unwatch)` 末尾追加 `\|save-image`，使 `/session/:id/workspace/save-image` 命中并产 sub=`workspace_save-image` | MUST 只追加新 leaf，不动既有 5 个 leaf 的匹配顺序（INV-R-1 路由顺序保留）；save-image 含连字符，正则字符组中作为字面量 | specs/api/overall/04-agent-session.md §2.6（workspace 端点组） | +1/0 |
| workspace_api（后端 route） | app/server/src/routes/session-routes.ts | dispatchSessionRoutes | 修改 | 在 workspace_watch/workspace_unwatch 分支后新增分支：`if (sessionMatch.sub === 'workspace_save-image') return handleWorkspaceSaveImage(req, method, sessionMatch.id, deps);` | MUST 复用既有 `sessionDeps(bs, dataDir)` 实例（不新建 deps）；MUST 走 matchSessionPath 已命中的 sessionMatch.id（不重解析 path） | specs/api/overall/04-agent-session.md §2.6.6 | +4/0 |
| workspace_api（后端 route） | app/server/src/routes/session-routes.ts | (import statement) | 修改 | 顶部从 `../handlers/session-workspace-save-image` 新增 import `handleWorkspaceSaveImage`，与既有 workspace handler import 并列 | MUST 与既有 workspace handler import 风格一致；不从 `session-workspace.ts` re-export（避免后者超 300 行） | — | +2/0 |
| workspace_api（后端 handler） | app/server/src/handlers/session-workspace-save-image.ts | handleWorkspaceSaveImage | 新增 | POST `/session/:id/workspace/save-image` 主 handler。流程：①method 非 POST→405 ②`deps.store.getSession(id)` 未命中→404 ③解析 body `{ mediaType, base64 }`；mediaType 非 `image/*`→400；base64 空→400 ④取 `session.workspaceDir`，缺失→500；realpathSync 异常→500 ⑤调 `mediaTypeToImageExt(mediaType)` 推 ext（不识别→400） ⑥生成 id=`ulid()`，filename=`image-${id}${ext}` ⑦absPath=path.resolve(realRoot,'images',filename) ⑧**白名单二次守卫**：absPath 必须 startsWith(realRoot+sep)（虽自生成仍守卫防 ulid/ext 注入） ⑨`fsp.mkdir(dirAbs,{recursive:true})`+`fsp.writeFile(absPath, Buffer.from(base64,'base64'))` ⑩返 200 `{ path: relPath }`，relPath=POSIX 风格 `images/<filename>`；任一 fs 步骤 reject→500 | MUST 复用 `session-workspace.ts` 的 `json()` + `whitelistResolve()`（已 export）；MUST NOT 把 base64 / 文件内容 / 绝对路径 echo 进 error message（避免泄漏）；MUST NOT 假设 images 目录已存在（mkdir recursive）；MUST 透传 fs 错误为 500 不抛；返回 Promise\<Response\> | specs/api/overall/04-agent-session.md §2.6 安全校验范式 + 新 §2.6.6；原则#7（路径绝对化）；snapshot-store.ts 落盘范式借鉴（INV-157-2/3/4 同款确定性命名） | +120/0 |
| workspace_api（后端 handler） | app/server/src/handlers/session-workspace-save-image.ts | mediaTypeToImageExt | 新增 | 形如 `(mediaType: string) => string`：`image/png→'.png'`、`image/jpeg\|image/jpg→'.jpg'`、`image/gif→'.gif'`、`image/webp→'.webp'`；其余 throw `Error('unsupported image mediaType')`（caller 转 400）。文件内 private export（不导出给其他模块） | MUST 闭合集合 4 类（与 PRD §交互细节一致）；未知类型 throw 不返 ''（caller 须能区分）；MUST 不复用 snapshot-store.ts 的 `extFromMediaType`（后者只覆盖 png/jpeg 且 private） | specs/prd/version_logs/v0.0.177.md §交互细节 | +12/0 |
| workspace_api（后端 handler） | app/server/src/handlers/session-workspace-save-image.ts | SaveImageBody / SaveImageResponse | 新增 | TS interface 声明：`SaveImageBody={ mediaType: string; base64: string }`、`SaveImageResponse={ path: string }`（path=相对 workspaceDir 的 POSIX relPath）。仅供本 handler 类型化 body/response 用 | MUST 字段名与 API spec §2.6.6 完全一致（mediaType/base64/path） | specs/api/overall/04-agent-session.md §2.6.6（本版本新增） | +6/0 |
| chat_composer（前端 API 客户端） | app/web/src/lib/chat-api/workspace-api.ts | saveImage | 新增 | 形如 `(sessionId: string, body: { mediaType: string; base64: string }, base?: string) => Promise<{ path: string }>`。复用 `req<T>` helper（同文件其他 ws API 风格），POST `/session/:id/workspace/save-image` + JSON body。失败 throw（带 status，与既有 ws API 一致） | MUST 复用 `req<T>` 不自造 fetch；MUST NOT 在 client 推断 ext（server 是单一权威）；URL 用 `encodeURIComponent(sessionId)` 与既有 4 个 ws API 一致 | specs/api/overall/04-agent-session.md §2.6.6；既有 workspace-api.ts 风格 | +18/0 |
| chat_composer（前端 paste 逻辑） | app/web/src/components/chat-page/paste-image-handler.ts | processImagePaste | 新增 | 形如 `async (editor: { chain: () => ... }, sessionId: string, clipboardData: DataTransfer) => Promise<boolean>`。流程：①遍历 `clipboardData.items`，filter `kind==='file' && type.startsWith('image/')` ②对每个 image item，`await blobToBase64(item.getAsFile())` 取 base64（不含 data: 前缀）③`await saveImage(sessionId, { mediaType: file.type, base64 })` ④成功 → `editor.chain().focus().insertMention({ type:'file', path: relPath, icon:'file', label: basename(relPath) }).run()`；多图依次 chain ⑤任一失败 → console.warn + 不插入对应 pill（不阻塞其他成功的）⑥返 boolean=是否有 image item 被处理（true 阻止 Tiptap 默认粘贴文本，false 交默认）。**多图**：顺序 await（禁并发，避免 pill 顺序错乱） | MUST 复用既有 `insertMention` command（chat-composer-extension.tsx 已 export 类型），attrs signature=`{type, path, icon, label}`；MUST icon='file'（message-content.md §3.2 glyph 表）；MUST label=basename(relPath)（与 MentionPopover 选 file pill 一致，不带 path 前缀）；MUST NOT 在 client 生成 filename / ulid（server 单一权威，确定性）；MUST 阻止默认行为（返 true）仅当至少一张图成功落盘 + 插入；非 image item 一律跳过不处理；多图顺序保证 pill DOM 顺序与剪切板 items 一致 | specs/tech/mention/message-content.md §3.1（file mention path 字段）+ §3.2（icon='file'）；specs/ui/components/chat-page/chat-composer.md §编辑器；PRD 路径1/2/3 | +95/0 |
| chat_composer（前端 paste 逻辑） | app/web/src/components/chat-page/paste-image-handler.ts | blobToBase64 | 新增 | 形如 `(blob: Blob) => Promise<string>`：`FileReader.readAsDataURL` → 剥 `data:*/*;base64,` 前缀 → 返纯 base64 字符串。private fn 不 export | MUST 剥前缀（server 只接纯 base64）；MUST 用 Promise wrap FileReader.onload/onerror；MUST NOT 用 await blob.text() 等会乱码的 API | — | +15/0 |
| chat_composer（前端 editorProps 接线） | app/web/src/components/chat-page/component-chat-composer.tsx | useEditor.editorProps.handlePaste | 新增 | 在 `useEditor({ editorProps: { ..., handlePaste: (view, event) => { const items = event.clipboardData?.items; if (!items) return false; const hasImage = Array.from(items).some(it => it.kind==='file' && it.type.startsWith('image/')); if (!hasImage) return false; event.preventDefault(); void processImagePaste(editor, sessionId, event.clipboardData); return true; } } })`。**纯短路层**：判有无 image → preventDefault + 触发异步 processImagePaste；非 image 走 Tiptap 默认（返 false） | MUST 是同步短路（快速决定是否拦截默认粘贴）；MUST 把异步工作甩给 processImagePaste（fire-and-forget with void）；MUST NOT 在 handlePaste 内 await（Tiptap editorProps 不支持 async）；MUST NOT 触发非 image 文件的拦截（PRD 不覆盖）；MUST 复用闭包内既有 `editor` + `sessionId` 变量（不引入新 prop） | specs/ui/components/chat-page/chat-composer.md §状态/交互 §编辑器（本版本新增 handlePaste 节，由 doc-modifier 阶段补 ui spec） | +18/0 |

## 新端点 API 契约（ specs/api/overall/04-agent-session.md §2.6.6 新增 ）

- **path**：`POST /session/:id/workspace/save-image`
- **request body**（JSON）：
  ```typescript
  interface SaveImageBody {
    mediaType: string;  // MIME，必须 image/*（如 'image/png'）
    base64: string;     // 纯 base64（无 data:image/...;base64, 前缀），非空
  }
  ```
- **response 200**：
  ```typescript
  interface SaveImageResponse {
    path: string;  // 相对 workspaceDir 的 POSIX 路径，如 'images/image-01JK...'
  }
  ```
- **error codes**：
  - `400` body 非 JSON / 缺 mediaType 或 base64 / mediaType 非 `image/*` / mediaType 不在 {png,jpeg,jpg,gif,webp} 闭合集
  - `404` session 不存在
  - `405` 非 POST（带 `Allow: POST`）
  - `500` session 无 workspaceDir / workspaceDir realpath 失败 / images mkdir 失败 / writeFile 失败（权限/磁盘）
- **安全**（路径白名单 MANDATORY）：filename 由 server 端 `image-<ulid>.<ext>` 生成（ulid + 闭合 ext），客户端无路径控制权；server 仍守 `absPath.startsWith(realRoot + sep)` 二次兜底，防任何注入。
- **命名确定性**（INV-177-1）：`image-<ulid>.<ext>` 用 `app/server/src/config/ulid.ts` 的 `ulid()`（同进程单调，Crockford Base32）。禁纯 `Date.now()` —— record/replay 友好（AT 录制文件名稳定）。

## 拆分建议（单文件 ≤300 行硬约束）

| 文件 | 现行 | 增量后预估 | 处理 |
|------|------|-----------|------|
| `app/server/src/handlers/session-workspace.ts` | **298 行**（已贴顶） | 超 300 | **新建 `session-workspace-save-image.ts`**（约 120 行），save-image 全部逻辑进新文件，复用 `json()` + `whitelistResolve()` via import；旧文件不动（仅可能由 doc-modifier 同步 import 注释） |
| `app/web/src/components/chat-page/component-chat-composer.tsx` | **300 行**（已到顶） | 超 300 | **新建 `paste-image-handler.ts`**（约 110 行），把 paste 处理 + base64 转换 + saveImage 调用全部抽出；component 内只加 ~18 行 `handlePaste` 短路层 |
| `app/web/src/lib/chat-api/workspace-api.ts` | 99 行 | ~117 行 | 不拆，加 1 个 saveImage fn |
| `app/server/src/routes/router-helpers.ts` / `session-routes.ts` | — | +1 / +6 | 不拆 |

> coder 注意：`component-chat-composer.tsx` 当前 300 行已是临界，加 18 行 handlePaste 后将达 318 —— 必须先抽出 `paste-image-handler.ts` 再加 handlePaste 接线（顺序不可颠倒，避免 commit 中间态超限）。

## 影响面评估

- **跨模块**：后端（routes + handlers）+ 前端（chat-api + chat-composer 组件）。无 schema 持久化变更（图片不进 DB，只落盘 ws）。
- **破坏性变更**：无。新端点 + 新前端行为（paste 之前无处理）。既有 5 个 workspace 端点 + 4 个 mention type 零改动。
- **依赖顺序**：先建后端 → 后端 AT case 录制通过 → 前端接线（前端依赖 saveImage fn）。两侧可并行开工，前端可先 mock saveImage 返 stub 开发。
- **复用关系**：file mention type（INV-2 type-agnostic）零改动；icon='file' glyph 已存在；insertMention command 已存在；workspace 路径白名单安全范式（whitelistResolve）已 export；ulid 生成器已存在（server + web 两份）。
- **风险点**：
  1. AT 录制：新端点本版本豁免 AT 录制（用户铁律「普通 feature 不新增 AT case」，本版本非新 LLM 不确定场景），用 UT 覆盖 handler（参考既有 `session-workspace.test.ts` 风格）。
  2. Tiptap handlePaste 异步：必须 fire-and-forget（不在 handlePaste 内 await），否则阻塞 Tiptap 事件循环；落盘成功后再 `editor.chain().focus().insertMention()`（编辑器此时仍在挂载态，paste 后立即失焦的概率极低；不做 editor destroyed 守卫——YAGNI）。
  3. 多图顺序：必须顺序 await（禁 Promise.all），保 pill DOM 顺序与剪切板 items 一致。

## coder 需注意的 gap

- **`relPath` helper 不 export**：`session-workspace.ts:179` 的 `relPath(workspaceDir, absChild)` 是 private fn。新 handler 不要 import 它——直接在 save-image handler 内用模板字符串拼 `images/${filename}`（filename 由 server 自生成，无跨平台分隔符问题，POSIX 一致）。这条已在表中体现。
- **`extFromMediaType` 不要复用**：`snapshot-store.ts:71` 的同名 fn 只覆盖 png/jpeg 且 private；本版本需 png/jpeg/gif/webp 闭合集，必须新建 `mediaTypeToImageExt`（表内独立行）。
- **packaged 护栏（CLAUDE.md BUG-002）**：本版本**不引入新第三方依赖**（fsp/path/node:crypto 已在 server 用，ulid 是项目内既有 lib）；新前端文件只 import 项目内既有模块 + 浏览器原生 FileReader/DataTransfer。无须更新 `app/server/package.json` / `app/web/package.json` 依赖。
- **packaged 护栏（BUG-004 路径）**：handler 用 `path.resolve(realRoot, 'images', filename)` 拼 absPath，realRoot 来自 `realpathSync(workspaceDir)`（已是绝对路径），不拼字面 `~`；`workspaceDir` 来自 session 持久化字段，由 `resolveDataDir` 单一权威派生（既有 invariant），新代码不破坏。

## spec↔code 偏离（供 doc-modifier 阶段 5 对齐）

架构阶段核对未发现 spec↔code 偏离。所有引用符号均已 grep 确认存在：
- `whitelistResolve` / `json` 已 export（session-workspace.ts:35, :53）✓
- `ulid()` server 端 export（config/ulid.ts:73）✓
- `ulid()` web 端 export（lib/ulid.ts）✓
- `SessionHandlerDeps.store.getSession` 既有调用范式（session-workspace.ts:87）✓
- `matchSessionPath` workspace 子段正则在 router-helpers.ts:87 ✓
- `insertMention` command 类型声明（chat-composer-extension.tsx:172）✓
- `req<T>` helper export（session-api.ts:13）✓
- `icon: 'file'` glyph（primitive-mention-pill.tsx:33 + message-content.md §3.2）✓

**doc-modifier 阶段须补**（spec 落后于代码，正常增量）：
- `specs/api/overall/04-agent-session.md` §2.6 加 §2.6.6 save-image 节
- `specs/ui/components/chat-page/chat-composer.md` §状态/交互 加「粘贴图片（handlePaste）」节
- 不需要修任何既有 spec（无偏离）

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
