# v0.0.339 change_log — 文件打开分流（CSV/TSV 系统打开 + 文本 >5MB 系统打开）

> 对应需求：`reqs/[working] v0.0.339.file-open-strategy.md` + PRD `specs/prd/version_logs/v0.0.339-file-open-strategy.md`（已确认，commit 52063753a）。
> 权威契约：`specs/tech/version_logs/v0.0.339-file-open-strategy/change_plan.md`（A1-A11，frozen）。
> commits：`ab5d19261`（T1 stat 能力三端——workspace stat 端点 + shell:stat IPC + 前端封装）+ `e851c00eb`（T2 openLocalPath 分流——CSV/TSV 无条件系统打开 + 文本 >5MB 系统打开）。
> 验证：全量 UT 10422 passed + tsc 0 error + 双 code-review PASS；AT `workspace_stat_tc4`（5 态断言）已设计。

## 变更摘要（老板拍板三条 + 实现）

| # | 决策 | 实现 |
|---|---|---|
| ① | CSV/TSV **无条件系统打开**（不 stat、不内置，任何大小——表格文件交 Numbers/Excel） | `open-local-path.ts` ④ 分支前插 `fmt==='csv' \|\| 'tsv'` → `openSystemWorkspace`/`openSystemAbsolute` 直接 return（不 stat） |
| ② | 内置文本（12 格式 + code）**>5MB 系统打开** / ≤5MB 内置；stat 失败降级内置 | `getSize()` stat 判定：workspace→HTTP `GET /workspace/stat`（A8 `statWorkspaceFile`）/ absolute→`rockyShell.stat`（A6 `shell:stat` IPC）；`statFile?` 注入优先（UT mock）；失败/非 Electron undefined → 降级 `onEditor` |
| ③ | 图片不动（6 格式无大小限制，不 stat） | 图片分支（isImagePath）先于大小判定，零改动 |

## 实现核对（method 级，对齐 change_plan A1-A11）

| 计划项 | 实现一致性 |
|---|---|
| A1（`handleWorkspaceStat` 新端点） | ✅ `session-workspace-file.ts` 新导出：method 非 GET → 405（Allow: GET）→ getSession → 404 → query `path` 缺失/空 → 400 → `resolveWsFilePath` 白名单安全链（traversal→400 / not_found→404）→ `statSync`（**isDirectory → 404**；只返 `{ size: st.size }` 不读内容；stat 异常 → 404）→ workspaceDir 缺失/realpath 失败 → 500。注释显式「>5MB 大文件先读再判大小 = 本末倒置」 |
| A2（router-helpers alternation 加 stat） | ✅ `router-helpers.ts` ws 路由正则 alternation 加 `stat` → sub `workspace_stat`（对齐现有风格） |
| A3（session-routes 分发分支） | ✅ `session-routes.ts` 加 `workspace_stat` 分支 → `handleWorkspaceStat(req, method, id, deps)` + import |
| A4（`computeFileStat` + shell:stat 第六 channel） | ✅ `open-external-ipc.ts` 新导出纯函数 `computeFileStat(absPath, fs)`：`fs.stat` → `{ok:true, size}`；catch 按 `error.code` 归类——ENOENT→`not-found` / EACCES→`permission-denied` / 其余→`stat-unavailable`（stat 缺省防御）；registerOpenExternalIpc 加第六 channel `ipcMain.handle('shell:stat')`（computeResolveLocalPath 展开 → computeFileStat） |
| A5（preload 暴露 stat） | ✅ `preload.ts` 加 `stat: (path) => ipcRenderer.invoke('shell:stat', { path })`（对齐现有五方法风格） |
| A6（rocky-shell.d.ts 镜像） | ✅ `rocky-shell.d.ts` 加 `RockyShellStatResult { ok; size?; reason? }` + `stat(path): Promise<RockyShellStatResult>`（镜像 main 返回形状） |
| A7（openLocalPath 分流核心） | ✅ `open-local-path.ts`：`TEXT_OVER_SIZE_BYTES = 5*1024*1024` 导出；`OpenLocalPathOpts.statFile?` 可选注入；模块级 `getSize(source, sessionId, path, statFile?)`（statFile 注入优先 → workspace `statWorkspaceFile` / absolute `window.rockyShell?.stat`，失败/非 Electron → undefined）；④ 分支 csv/tsv 无条件系统打开（不 stat）；其余文本 `void getSize(...).then(size => size!==undefined && size>5MB ? 系统打开 : onEditor(mk(fmt)))`；图片分支先于大小判定不 stat；同步签名不变（消费方零改动） |
| A8（`statWorkspaceFile` 前端封装） | ✅ `workspace-api.ts` 新导出 `statWorkspaceFile(sessionId, path, base?)` = `req<{size:number}>(...)`（对齐 openWorkspaceItem 3 参风格） |
| A9-A11（测试） | ✅ UT：open-local-path.test.ts 新增分流用例（csv/tsv 无条件不 stat / >5MB 系统 / =5MB 边界内置 / ≤5MB 内置 / statFile undefined 降级内置 / 图片不 stat）+ session-workspace-file.test.ts stat handler 用例 + open-external-ipc.test.ts computeFileStat 用例；全量 UT 10422 passed。AT：`tests/api/workspace/workspace_stat_tc4/case.yaml`（200 size / 404 不存在 / 400 越界 / 405 非 GET / 400 path 缺失） |

## 偏离记录

无静默偏离。A4 reason 枚举（not-found / permission-denied / stat-unavailable）为 change_plan `reason?: string` 的具体化（实现定枚举，未改契约语义）；A7 用 `getSize` 模块级 helper 承载 stat 逻辑（change_plan 决策 2 同步壳 + fire-and-forget 原样达成）。

## 关键文件

| 文件 | 变更 |
|---|---|
| `app/server/src/handlers/session-workspace-file.ts` | +`handleWorkspaceStat`（A1） |
| `app/server/src/routes/router-helpers.ts` | ws alternation +`stat`（A2） |
| `app/server/src/routes/session-routes.ts` | +`workspace_stat` 分发（A3） |
| `app/electron/src/open-external-ipc.ts` | +`computeFileStat` + `shell:stat` channel（A4） |
| `app/electron/src/preload.ts` | +`stat`（A5） |
| `app/web/src/types/rocky-shell.d.ts` | +`RockyShellStatResult` + `stat`（A6） |
| `app/web/src/lib/open-local-path.ts` | +`TEXT_OVER_SIZE_BYTES` + `getSize` + csv/tsv 分支 + stat 判定（A7） |
| `app/web/src/lib/chat-api/workspace-api.ts` | +`statWorkspaceFile`（A8） |

## 文档同步（doc-modifier 合并前门禁）

- `specs/ui/components/chat-page/component-workspace-panel.md` §4.4：文本分支三分流（csv/tsv 无条件 + >5MB 系统打开 + stat 失败降级内置；图片不 stat）
- `specs/ui/components/chat-page/section-preview-area.md` §10：csv/tsv 与 >5MB 文本不进预览区边界
- `specs/ui/components/chat-page/_overview.md` 规则 8 + `specs/ui/overall/00-app-guide.md`：12 格式分流例外（v0.0.339）
- `specs/tech/app/frontend/index.md` ① 概念表 openLocalPath 行：④ 分支 v0.0.339 升级
- `specs/tech/app/package/[P0]package_structure.md` §4.4：三 channel → 四 channel（+`shell:stat`）
- `specs/tech/app/frontend/log.md` + `specs/tech/app/package/log.md`：v0.0.339 条目
- `specs/api/overall/04-agent-session.md`：§2.6.9 `GET /session/:id/workspace/stat` 端点定义 + 版本尾注 2.8
- `specs/api/version_logs/v0.0.339/change_log.md`：API 契约变更（新建）
- tech index/API 版本尾注已同步；PRD 已有（v0.0.339-file-open-strategy.md，commit 52063753a）

## 已知缺陷 / 待办

- 无。stat 失败降级内置（不误伤打开行为）；非 Electron absolute 源 stat 不可用 → 降级内置（现状行为不变）。
