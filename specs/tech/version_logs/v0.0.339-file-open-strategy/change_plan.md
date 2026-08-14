# v0.0.339 change_plan：文件打开分流（CSV/TSV 系统打开 + 文本 >5MB 系统打开）

> 架构期冻结契约。coder 按此实现，reviewer 按此查偏离。coder/doc-modifier 不改本文件；事后偏差写 `change_log.md`。
> 上游：`reqs/[working] v0.0.339.file-open-strategy.md` + PRD `specs/prd/version_logs/v0.0.339-file-open-strategy.md`（已确认，commit 52063753a）。
> worktree：`worktrees/v0.0.339-file-open-strategy`（首次用需 bun install）。
> 边界（PRD §4，MANDATORY）：不改图片（6 格式内置弹层无大小限制）；不改 editor 内 view 分流（md/structured/plain/code 保留）；系统打开复用 openWorkspaceItem/openPath 不新造；不扩格式集不改 file-format 表；聊天链与文件树共用 openLocalPath 行为一致（消费方零改动）。

## 现状核实（代码实证，worktree）

| 项 | 文件:行 | 结论 |
|---|---|---|
| 共享分发 | `app/web/src/lib/open-local-path.ts:104-149` | 同步入口 `openLocalPath(path, opts)`，五路分流：folder→系统 / .url→嗅探 / image→viewer / getFileFormat≠null→editor / 其余→系统。系统打开复用内部 `openSystemWorkspace`（:66，openWorkspaceItem kind=file）+ `openSystemAbsolute`（:72，rockyShell.openPath）。 |
| CSV/TSV 判定 | `app/web/src/lib/file-format.ts:25-26` | `FileFormat` 含 'csv' \| 'tsv'；`getFileFormat(path)` 返回 FileFormat \| null（:162）。判定 = `getFileFormat(path) === 'csv' \|\| 'tsv'`。 |
| workspace stat | `app/server/src/handlers/session-workspace-file.ts:68-103` + `router-helpers.ts:96-99` | **无 stat 端点**。现有 GET `/session/:id/workspace/file` 读全文（返回 {content, version}，version=`${mtimeMs}:${size}` 但**不直接暴露 size**）。handler 已有 `resolveWsFilePath`（:30-58，realRoot+whitelistResolve 安全链）可复用。 |
| absolute stat | `app/electron/src/open-external-ipc.ts:61`（FsLike.stat 可选）+ `:229-275`（registerOpenExternalIpc 五 channel）+ `app/electron/src/preload.ts:51-63`（五方法） | **FsLike.stat 已声明但未暴露 IPC**；preload 无 stat；`app/web/src/types/rocky-shell.d.ts:33-44` RockyShellApi 无 stat。需三处补。 |
| 消费方 | `section-workspace-panel.tsx:183-193` + `component-message-stream.tsx:243-255` | 均同步调 `openLocalPath(path, opts)`（onEditor/onImageViewer 回调）。**消费方零改动**目标成立。 |
| 测试 | `app/web/src/lib/__tests__/open-local-path.test.ts` | 现有同步断言（folder/.url/editor/系统打开）。 |

## 架构决策（PRD §8 必答）

### 决策 1：stat 实现路径
- **workspace 源**：新增后端端点 `GET /session/:id/workspace/stat?path=<rel>`（新 handler `handleWorkspaceStat`，复用 `resolveWsFilePath` 安全链 + `statSync` 返 `{ size }`）。理由：现有 GET file 读全文返 size 需**读整个文件**（>5MB 大文件先读再判大小 = 本末倒置），且语义混杂；独立 stat 端点最小、安全（白名单复用）、只返 size 不读内容。
- **absolute 源**：新增 `shell:stat` IPC（main 侧 `fs.stat` 已具备能力，仅未暴露）。三处小改：open-external-ipc.ts 注册 `shell:stat` channel + preload.ts 暴露 `stat` + rocky-shell.d.ts 加 `stat(path): Promise<{ok:boolean; size?:number; reason?:string}>`。
- **不采用**：WsTreeNode 带 size（改动 tree 契约 + 后端 tree 扫描，影响面大且聊天链 target 无节点）；rockyShell.readFileText 返回 size（已限定 ≤2MB 读，大文件读不动）。

### 决策 2：openLocalPath 同步改异步的改造方式
- **采用「同步壳 + 内部 fire-and-forget」**（对齐现有 .url 嗅探模式 :116-131，已是先例）：
  - `openLocalPath(path, opts)` **签名不变**（仍同步 void，消费方零改动）。
  - 内部新增可选 `statFile?: (path) => Promise<{size:number} | undefined>` 依赖（缺省 = 按 source 走真实 stat：workspace→HTTP stat / absolute→rockyShell.stat；**注入便于 UT mock，且非 Electron/stat 失败降级内置**）。
  - ③.5/③.7 分支：`void statFile(path).then(size => size===undefined ? 内置(降级) : (size>5MB ? 系统打开 : 内置))`。
- **理由**：改 async/await 全链路需动 2 个消费方 handleOpen/onLocalViewer + 所有调用点，违反「消费方零改动」；回调注入保持同步壳，最小侵入。stat 失败降级内置（不因 stat 错误误伤打开行为；图片/CSV 分支不 stat 不受影响）。

### 决策 3/4：判定与阈值
- CSV/TSV：`getFileFormat(path) === 'csv' || 'tsv'`（无条件系统打开，**不 stat**）。
- 阈值：`5 * 1024 * 1024` bytes；`size > 5MB` → 系统打开；`size <= 5MB` → 内置（边界 5MB 整 = 内置）。
- **大小判定仅用于文本分支**：图片（③ isImagePath 先于大小判定）不 stat；CSV/TSV（③.5 先于大小判定）不 stat。

## 变更清单（method 级）

| # | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| **后端 workspace stat 端点** |
| A1 | `app/server/src/handlers/session-workspace-file.ts` | `handleWorkspaceStat` | 新增 | 新导出 `handleWorkspaceStat(req, method, id, deps)`：GET 校验 → getSession → query `path` 校验 → `resolveWsFilePath(workspaceDir, rel)`（复用 :30-58 安全链）→ `statSync(absPath)` → `json(200, { size: st.size })`；目录/不存在 → 404（对齐 file read）。 | MUST 复用 resolveWsFilePath（白名单安全链，不新写路径解析）；MUST 只返 size 不读内容（大文件不加载）；GET only | session-workspace-file.ts:30-58,68-103 | +15 |
| A2 | `app/server/src/routes/router-helpers.ts` | ws 路由正则（:96-99） | 修改 | alternation 加 `stat`：`(file\/save|tree|open|pick-directory|watch|watch-set|unwatch|save-image|file|search|stat)` → sub `workspace_stat`。 | MUST 加在 alternation（对齐现有风格） | router-helpers.ts:96-99 | +1 |
| A3 | `app/server/src/routes/session-routes.ts` | workspace 分发分支（:161-168 后） | 修改 | 加 `if (sessionMatch.sub === 'workspace_stat') return handleWorkspaceStat(req, method, sessionMatch.id, deps);` + import。 | MUST 对齐现有分发风格 | session-routes.ts:161-168 | +3 |
| **absolute stat IPC** |
| A4 | `app/electron/src/open-external-ipc.ts` | `computeFileStat` + registerOpenExternalIpc | 新增/修改 | 新导出纯函数 `computeFileStat(absPath, fs: FsLike): Promise<{ok:boolean; size?:number; reason?:string}>`（try fs.stat → ok:true,size；catch → ok:false,reason）。registerOpenExternalIpc 加第六 channel `ipcMain.handle('shell:stat', ...)`（computeResolveLocalPath 展开 → computeFileStat）。 | MUST 复用 computeResolveLocalPath 路径展开；FsLike.stat 已声明（:61）直接可用；返回形状对齐 RockyShellOpenResult 风格 | open-external-ipc.ts:48-61,229-275 | +12 |
| A5 | `app/electron/src/preload.ts` | contextBridge 暴露 | 修改 | 加 `stat: (path: string) => ipcRenderer.invoke('shell:stat', { path })`。 | MUST 对齐现有五方法风格 | preload.ts:51-63 | +2 |
| A6 | `app/web/src/types/rocky-shell.d.ts` | `RockyShellApi` | 修改 | 加 `stat(path: string): Promise<{ ok: boolean; size?: number; reason?: string }>` + 新接口 `RockyShellStatResult`（镜像 main 返回形状）。 | MUST 镜像 electron 返回形状（IPC 边界契约） | rocky-shell.d.ts:12-44 | +8 |
| **前端共享分发（核心）** |
| A7 | `app/web/src/lib/open-local-path.ts` | `OpenLocalPathOpts` + `openLocalPath` + 新 helper | 修改/新增 | ①Opts 加可选 `statFile?: (path: string) => Promise<{ size: number } \| undefined>`（缺省 undefined → 内部按 source 走真实 stat；注入便于 UT mock）。②新增模块级 `getSize(source, sessionId, path, statFile?)`: Promise<number \| undefined>——workspace→`req GET /session/:id/workspace/stat?path=`（新 chat-api 封装见 A8）；absolute→`window.rockyShell?.stat(path)`（非 Electron undefined）；statFile 注入优先。③`openLocalPath` 在 ③ image 之后、④ 文本之前插入：`const fmt = getFileFormat(path); if (fmt==='csv' \|\| fmt==='tsv') { 系统打开; return; } if (fmt !== null) { void getSize(...).then(size => { if (size!==undefined && size > 5MB) 系统打开; else onEditor(mk(fmt)); }); return; }`。④`TEXT_OVER_SIZE_BYTES = 5*1024*1024` 常量导出（UT 引用）。 | MUST 保持同步签名（消费方零改动）；MUST CSV/TSV 无条件系统打开**不 stat**；MUST 图片分支先于大小判定（不 stat）；MUST stat 失败降级内置（undefined → onEditor）；MUST 边界 `size > 5MB` 系统、`<= 5MB` 内置；系统打开复用 openSystemWorkspace/openSystemAbsolute | open-local-path.ts:104-149,66-75; file-format.ts:25-26,162 | +25 |
| A8 | `app/web/src/lib/chat-api/workspace-api.ts` | `statWorkspaceFile` | 新增 | 新导出 `statWorkspaceFile(sessionId, path, base?)`: `req<{size:number}>(`/session/${id}/workspace/stat?path=${encodeURIComponent(path)}`, undefined, base)`。 | MUST 对齐 openWorkspaceItem 封装风格（req + 3 参） | workspace-api.ts:38-53 | +8 |
| **测试** |
| A9 | `app/web/src/lib/__tests__/open-local-path.test.ts` | 新增用例 | 修改 | ①csv/tsv 无条件系统打开（不 stat，onEditor 不被调）②文本 size>5MB → 系统打开（statFile mock 返 6MB）③文本 size=5MB 整 → 内置（边界）④文本 size≤5MB → 内置 ⑤statFile 返 undefined（stat 失败）→ 降级内置 ⑥图片（含 size>5MB）→ viewer 不 stat ⑦未知格式 → 系统打开（现状）。 | MUST statFile 注入 mock（不真调 HTTP/IPC） | open-local-path.test.ts | +40 |
| A10 | `app/server/src/handlers/__tests__/session-workspace-file.test.ts` | handleWorkspaceStat 用例 | 修改 | stat 正常返 size / 不存在 404 / 越界 400 / 非 GET 405。 | 对齐现有 handler 测试风格 | session-workspace-file.test.ts | +20 |
| A11 | `app/electron/src/open-external-ipc.test.ts`（若存在） | computeFileStat 用例 | 修改 | stat 成功返 size / 失败返 ok:false+reason / 相对路径拒绝。 | 对齐现有 compute* 测试风格 | open-external-ipc.test.ts | +15 |

## 验收标准（锚定）

1. 文件树点击 `.csv`/`.tsv`（任何大小）→ 系统默认程序打开，不进预览区 tab。
2. 聊天链接点击 `.csv`/`.tsv` → 系统打开（两处一致，消费方零改动）。
3. 文件树/聊天链点击 >5MB 文本（.md/.json/.py）→ 系统打开，无预览 tab。
4. ≤5MB 文本正常内置打开（无回归）；恰好 5MB 内置（边界）。
5. 图片（含 >5MB）仍内置弹层 viewer（无回归，无大小限制）。
6. 系统打开复用 openWorkspaceItem/openPath（无新机制）。

## UT 要求（MANDATORY）

- 命令：仓库根 `bun --bun x vitest run`（**非** `bun test`）。
- A9 必覆盖：openLocalPath 分流（csv/tsv 无条件 / 文本大小边界 5MB 整 / 图片无限制）+ statFile mock（成功/失败/undefined 三分支）。
- A10/A11：后端 stat handler + electron computeFileStat（注入依赖）。
- 全量零回归 + tsc 0 error。
- 前端 UI 行为变化 → ET 冒烟（test-plan 阶段细化）：文件树点 csv/大文本系统打开、聊天链一致、图片弹层不回归。

## 影响面 / 风险

- 前端：仅 open-local-path.ts 一个 lib 文件 + workspace-api 加函数；**消费方两处零改动**（同步签名不变）。
- 后端：新 stat 端点（复用白名单安全链，无新路径解析）；不改 file read/save。
- electron：第六 IPC channel（FsLike.stat 已声明，仅暴露）；preload + d.ts 镜像。
- 图片/CSV 分支不 stat（性能零影响）；文本分支多一次 stat 请求（轻量，仅 statSync 不读内容）。
- stat 失败降级内置（不误伤打开行为）；非 Electron（dev web 浏览器）absolute 源 stat 不可用 → 降级内置（现状行为不变）。
