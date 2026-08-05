# v0.0.227 变更计划书 — workspace .md 拦截 + 内置 md viewer/editor

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder 不改本文件；事后偏差写进 `change_log.md`。
> 依据：`specs/prd/version_logs/v0.0.227.md`（PRD 已用户确认 2026-07-31）+ `states/v0.0.227/context.md`（导航地图）。

## 架构决策（architect 落点，coder 遵守）

1. **组件提升路径**：`component-modal-md-editor.tsx` 从 `app/web/src/components/academy-page/` → `app/web/src/components/common/`。组件**行为/Props 零改动**（onSave 纯回调模型不变），但 **import 路径必须调 2 处**（文件移动后编译需要）：
   - `../common/primitive-markdown-view` → `./primitive-markdown-view`（common/ 内同目录）
   - `./academy-styles` → `../academy-page/academy-styles`（common 反向引用 academy-page 样式 = **已知技术债**，本版本不顺手扩；follow-up 可把 BTN_PRIMARY/SECONDARY/ICON_BTN 提到 common 样式。doc-modifier 阶段 5 记入 log）
   - `../../lib/portal` **不变**（common/ 与 academy-page/ 同在 `components/` 下，相对 lib 深度一致）
2. **workspace 侧挂载层落点 = 新建 `component-ws-md-editor.tsx`**（独立挂载层组件，仿 `component-academy-modals.tsx` 模式），**不**把 modal state 塞进 `SectionWorkspacePanel`。理由：(a) `section-workspace-panel.tsx` 已 298 行接近 300 上限，加 modal+toast+onSave 必超；(b) 仿 academy 既有「挂载层独立组件 + 父级持 target state」模式，结构一致；(c) 三处复用（chat-page/academy/studio）走同一 `SectionWorkspacePanel` → 同一挂载层，拦一处全覆盖不变。
3. **toast 反馈机制 = 复用项目自造轻量范式**（studio `page-studio.tsx` 的 `useState<string|null> + flash(msg) + setTimeout 2.6s` 模式），**零第三方依赖、零全局 toast 系统**。grep 确认项目无 toast 库 / 无 ToastProvider，studio/skill-page 多处用此局部 state 范式。挂载层 `component-ws-md-editor.tsx` 内置 flash，onSave 成功后 flash「已保存」。
4. **`.md` 大小写不区分**（PRD §6.4 裁决）：拦截判定 `node.type==='file' && node.path.toLowerCase().endsWith('.md')`。
5. **后端 handler 拆独立文件**：`session-workspace.ts` 已 298 行（接近 300 上限），新增 file 读/存两 handler 必拆。新建 `session-workspace-file.ts`（对齐 `session-workspace-save-image.ts` 拆分先例），复用 `session-workspace.ts` export 的 `json()` + `whitelistResolve()`。
6. **路径穿越校验 = 复用现成 `whitelistResolve(realRoot, rel)`**（`session-workspace.ts:53` export，返 `WhitelistResult`，已含字符串前缀 + realpath 双层防护）。新 handler 直接调，**不新写校验逻辑**。
7. **持续可打包护栏自检（CLAUDE.md MANDATORY）**：
   - **BUG-004 路径展开**：新端点读/写文件用 `session.workspaceDir`（已由 server 启动时 `resolveDataDir` 展开为绝对路径落库），handler 内 `realpathSync(workspaceDir)` 取 realRoot 后交 `whitelistResolve`。**禁字面 `~` / 禁相对路径拼接**。
   - **BUG-002 依赖归属**：新 handler 只用 Node 内置 `node:fs`（`readFileSync` / `writeFileSync`）+ 现有 `node:path`，**零新第三方依赖**，无需改 workspace package.json。
   - **BUG-001 runtime-config**：新端点无新增 env 键需求（非敏感），不动 `runtime-config.ts` 白名单。
   - **BUG-003 plugin 进 asar**：本版本不动 plugin，不涉及。
   - 结论：本版本后端改动属「纯 Node 内置 fs + 现有校验 helper」，dev 测试 = packaged 行为（无打包专属崩点）。**packaged 验证不强制**（dev AT 即可覆盖），但 coder 须按护栏自检。

## 变更清单（8 列，行 = 函数/符号）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-md-editor | app/web/src/components/common/component-modal-md-editor.tsx | ComponentModalMdEditor（文件移动） | 移动 | 从 academy-page/ 提升到 common/；git mv 保留 git 历史 | MUST 保持组件行为/Props 零改动（onSave 纯回调 `(newValue)=>Promise<void>\|void` 不变）；MUST 改 2 处 import 路径（见下行） | PRD §4 概念对齐；context.md intro；academy _overview §8.2 | +0/-0（移动） |
| ui-md-editor | app/web/src/components/common/component-modal-md-editor.tsx | import PrimitiveMarkdownView | 修改 | 路径 `../common/primitive-markdown-view` → `./primitive-markdown-view`（提升后同目录） | MUST NOT 改语义（仍是 PrimitiveMarkdownView 同款渲染内核） | 组件自身现状 L14 | +1/-1 |
| ui-md-editor | app/web/src/components/common/component-modal-md-editor.tsx | import BTN_PRIMARY/SECONDARY/ICON_BTN | 修改 | 路径 `./academy-styles` → `../academy-page/academy-styles`（common 反向引用 academy 样式，已知技术债） | MUST NOT 改样式 token 值；MUST NOT 顺手把 academy-styles 提到 common（超范围，follow-up） | 组件自身现状 L15 | +1/-1 |
| ui-md-editor | app/web/src/components/academy-page/component-academy-modals.tsx | import ComponentModalMdEditor | 修改 | 路径 `./component-modal-md-editor` → `../common/component-modal-md-editor` | MUST NOT 改 academy 侧 onSave 接线逻辑（handleMdSave 不动） | component-academy-modals.tsx L18 | +1/-1 |
| ui-md-editor | app/web/src/components/academy-page/component-skill-browser-modal.tsx | import ComponentModalMdEditor | 修改 | 同上路径调整 | MUST NOT 改 skill browser 逻辑 | grep 确认引用（L?） | +1/-1 |
| ui-md-editor | app/web/src/components/academy-page/__tests__/component-modal-md-editor.test.tsx | import ComponentModalMdEditor | 修改 | 路径调整对齐新位置 | MUST 保持 L3 Portal 不变式 UT 仍断 className（防回归） | 现有 UT | +1/-1 |
| ws-panel | app/web/src/components/chat-page/section-workspace-panel.tsx | handleOpen | 修改 | 加 .md 分支：`if (node.type==='file' && node.path.toLowerCase().endsWith('.md'))` → setMdTarget({path, fileName: basename, subtitle: node.path})；其余（dir / 非 .md file）原样 openWorkspaceItem | MUST 用 toLowerCase().endsWith('.md')（大小写不区分，PRD §6.4）；MUST NOT 改 dir 展开 / 非 .md 系统打开路径（回归保护 PRD §2.4）；MUST NOT 在 onInit 内 dispatch（useLifecycle 不变量②不涉及，本处是事件回调非生命周期） | PRD §2.1+§2.4+§6.4；component-workspace-panel.md | +8/-1 |
| ws-panel | app/web/src/components/chat-page/section-workspace-panel.tsx | mdEditorTarget state | 新增 | `useState<{path,fileName,subtitle}\|null>(null)`；渲染 `<ComponentWsMdEditor target={mdEditorTarget} onClose={()=>setMdTarget(null)} />` | MUST 放 SectionWorkspacePanel 内（state 就近，三处复用全覆盖）；MUST NOT 把 modal 逻辑塞本文件（已 298 行，超 300 风险） | PRD §1 三处统一覆盖；决策#2 | +6 |
| ws-md-mount | app/web/src/components/chat-page/component-ws-md-editor.tsx | ComponentWsMdEditor | 新增 | workspace 侧 md editor 挂载层（仿 component-academy-modals）：props { target, onClose }；target 变化 → readWorkspaceFile(sid, path) 读内容 → 渲染 `<ComponentModalMdEditor open fileName=target.fileName subtitle=target.subtitle initialValue=content versionLabel=basename onSave→handleSave onClose>`；loading / error 态 | MUST 复用 ComponentModalMdEditor（不造第二套 md editor，PRD §1 不变量）；MUST 每次 target 变化重新读（PRD §2.3 重开取最新，禁 stale）；MUST L3 Portal 不变式（组件内置，不改）；MUST NOT 组件内耦合 workspace API（落盘走挂载层 onSave） | PRD §2.1+§2.3；component-academy-modals.tsx 模式 | +55 |
| ws-md-mount | app/web/src/components/chat-page/component-ws-md-editor.tsx | handleSave | 新增 | onSave(newValue) 回调 → saveWorkspaceFile(sid, {path: target.path, content: newValue}) → 成功 flash(t('workspace.mdEditor.saved')) → 失败 throw（component-modal-md-editor 内 catch 显 saveError，编辑态保留） | MUST 走 saveWorkspaceFile client（不经其他路径）；失败 MUST throw（让组件保留 textarea 内容供重试，PRD §2.2 失败规则）；MUST NOT 组件内自处理错误吞掉 | PRD §2.2+§6.2；saveImage 落盘模式参考 | +12 |
| ws-md-mount | app/web/src/components/chat-page/component-ws-md-editor.tsx | flash toast (useState + setTimeout) | 新增 | 复用 studio page-studio.tsx 范式：`const [toast,setToast]=useState<string\|null>(null)` + `flash(msg){ setToast(msg); setTimeout(()=>setToast(null),2600) }`；toast 渲染为组件内 fixed 底部 pill | MUST 复用 studio 自造范式（零第三方依赖，决策#3）；MUST NOT 引入 toast 库（打包护栏 + 不新造）；MUST 2.6s 自动消失（对齐 studio） | PRD §6.2；page-studio.tsx L69-75 | +14 |
| ws-md-mount | app/web/src/components/chat-page/component-ws-md-editor.tsx | versionLabel 传值 | 新增 | 传 `target.fileName`（basename，如 'notes.md'）—— academy hint 模板「保存后版本号不变（{{label}} 仍是 {{label}}）」对文件场景勉强通顺（文件名不变）；primary 反馈靠 toast「已保存」 | MUST NOT 改组件加 hint Props（守「组件零改动」，决策#1）；若 hint 文案别扭，coder 报偏离由 orchestrator 裁决是否 follow-up 加可选 hint Props（本版本不做） | PRD §6.2；决策#1 | +0（传参） |
| ws-api-client | app/web/src/lib/chat-api/workspace-api.ts | readWorkspaceFile | 新增 | `GET /session/:id/workspace/file?path=<rel>` → `{ content: string }`；req helper 对齐既有 ws API（经 chat-api.ts barrel 自动 re-export，消费方零改） | MUST 用现有 req helper（session-api.ts export）；MUST path 走 query param（对齐 getWorkspaceTree 模式）；MUST NOT 在 client 侧做路径校验（后端单一权威） | workspace-api.ts L18-32 模式；api §2.6.7（本版本补） | +14 |
| ws-api-client | app/web/src/lib/chat-api/workspace-api.ts | saveWorkspaceFile | 新增 | `POST /session/:id/workspace/file/save` body `{ path, content }` → `{ ok: true }`；last-write-wins 直接覆盖 | MUST 用 req helper；MUST NOT 客户端加 mtime 冲突检测（PRD §6.3 last-write-wins） | workspace-api.ts L38-48 模式；api §2.6.7 | +10 |
| ws-handler | app/server/src/handlers/session-workspace-file.ts | handleWorkspaceFileRead | 新增 | GET handler：method 校验 → getSession（404） → realpathSync(workspaceDir) 取 realRoot（500 失败） → whitelistResolve(realRoot, path) 路径校验（traversal→400 / not_found→404） → readFileSync(absPath,'utf8') → 200 { content } | MUST 复用 session-workspace.ts export 的 json() + whitelistResolve（决策#6）；MUST realpath+前缀双层校验（防 ../ + symlink 穿越外部）；MUST readFileSync UTF-8 文本（.md 文本文件）；MUST NOT 用裸 path.resolve 拼接（打包护栏 BUG-004，禁字面 ~ / 相对路径）；路径不在 workspaceDir 内→400；文件不存在→404 | api §2.6.7；session-workspace.ts L53 whitelistResolve；PRD §5 安全面；config.ts resolveDataDir | +38 |
| ws-handler | app/server/src/handlers/session-workspace-file.ts | handleWorkspaceFileSave | 新增 | POST handler：method 校验 → getSession（404） → body 解析 { path, content }（非 string → 400） → realRoot → whitelistResolve（traversal→400 / not_found→404） → writeFileSync(absPath, content, 'utf8') 覆盖（last-write-wins） → 200 { ok: true } | MUST 复用 json() + whitelistResolve；MUST writeFileSync 直接覆盖（PRD §6.3 last-write-wins，无 mtime 校验、无冲突提示）；MUST NOT 写文件前 realpath 子项不存在判定后报错——writeFileSync 自身会失败（ENOENT→500）；路径越界→400；磁盘/权限失败→500 | api §2.6.7；PRD §6.3；whitelistResolve | +34 |
| ws-route | app/server/src/routes/session-routes.ts | workspace_file 分发 | 修改 | 加 `if (sessionMatch.sub === 'workspace_file') return handleWorkspaceFileRead(...)` 分支（仿 workspace_save-image:150 模式） | MUST 仿既有 sub 分发模式；MUST import handleWorkspaceFileRead from session-workspace-file | session-routes.ts L150 模式 | +4 |
| ws-route | app/server/src/routes/session-routes.ts | workspace_file-save 分发 | 修改 | 加 `if (sessionMatch.sub === 'workspace_file-save') return handleWorkspaceFileSave(...)` | 同上 | 同上 | +4 |
| ws-route | app/server/src/routes/session-routes.ts | matchSessionPath sub 模式 | 修改 | 在 matchSessionPath（路径→sub 解析）加 `workspace_file`（GET /workspace/file）+ `workspace_file-save`（POST /workspace/file/save）两个 sub 识别 | MUST 与既有 workspace_tree/workspace_open/workspace_save-image 同款 sub 命名风格（下划线 + 路径段映射）；MUST NOT 破坏既有 sub 解析 | matchSessionPath 定义（session-routes 顶部） | +4 |
| test-ut | app/server/src/handlers/__tests__/session-workspace-file.test.ts | UT handleWorkspaceFileRead/Save | 新增 | 路径穿越拒绝（../ + 绝对路径 + symlink 外部）→ 400；文件不存在→404；正常读/存 round-trip（writeFileSync 后 readFileSync 取回等值）；越界 path 不落盘；size 大小写无关（.md/.MD 均命中拦截 —— 此条在 web UT 覆盖，本 UT 只覆盖后端读/存契约） | MUST 走真实 tmpdir（不 mock fs，对齐 no-mock 原则）；MUST 覆盖 traversal/not_found/正常三态 | session-workspace.test.ts 模式；no-mock-api-e2e-tests memory | +85 |
| test-ut | app/web/src/components/chat-page/__tests__/section-workspace-panel-md.test.tsx | UT handleOpen .md 拦截 | 新增 | .md 文件 → setMdTarget（不调 openWorkspaceItem）；.MD/.Md → 同（大小写不区分）；.png/.json/文件夹 → 走 openWorkspaceItem（回归）；modal target 字段正确（fileName=basename, subtitle=相对路径） | MUST 断「.md 不调 openWorkspaceItem + 非 .md 仍调」（PRD §2.4 回归不变量）；MUST 覆盖大小写不区分 | PRD §2.1+§2.4+§6.4 | +55 |

## 文件级变更清单（feature 维度叙事，与上行表数据一致）

### Feature 1: 组件提升（academy-page/ → common/）
| 文件 | 操作 | 变更内容 |
|------|------|---------|
| app/web/src/components/common/component-modal-md-editor.tsx | 新增（git mv 自 academy-page/） | 提升位置；改 2 处 import 路径（primitive-markdown-view / academy-styles）；组件行为零改 |
| app/web/src/components/academy-page/component-academy-modals.tsx | 修改 | import 路径 → `../common/component-modal-md-editor` |
| app/web/src/components/academy-page/component-skill-browser-modal.tsx | 修改 | 同上 |
| app/web/src/components/academy-page/__tests__/component-modal-md-editor.test.tsx | 修改 | import 路径对齐 |
| app/web/src/components/academy-page/component-modal-md-editor.tsx | 删除（git mv 目标） | 旧位置移除 |

### Feature 2: workspace 拦截 + md editor 挂载
| 文件 | 操作 | 变更内容 |
|------|------|---------|
| app/web/src/components/chat-page/section-workspace-panel.tsx | 修改 | handleOpen 加 .md 分支 + mdEditorTarget state + 渲染挂载层 |
| app/web/src/components/chat-page/component-ws-md-editor.tsx | 新增 | workspace 侧 md editor 挂载层：readWorkspaceFile 读 + 渲染 ComponentModalMdEditor + onSave 调 saveWorkspaceFile + flash toast |

### Feature 3: workspace-api client
| 文件 | 操作 | 变更内容 |
|------|------|---------|
| app/web/src/lib/chat-api/workspace-api.ts | 修改 | 新增 readWorkspaceFile + saveWorkspaceFile（经 chat-api.ts barrel re-export） |

### Feature 4: 后端 file 读/存端点
| 文件 | 操作 | 变更内容 |
|------|------|---------|
| app/server/src/handlers/session-workspace-file.ts | 新增 | handleWorkspaceFileRead + handleWorkspaceFileSave（复用 json/whitelistResolve） |
| app/server/src/routes/session-routes.ts | 修改 | 加 workspace_file / workspace_file-save 两个 sub 分发 + matchSessionPath sub 模式 |

### Feature 5: UT
| 文件 | 操作 | 变更内容 |
|------|------|---------|
| app/server/src/handlers/__tests__/session-workspace-file.test.ts | 新增 | 后端路径校验 + 读/存契约 |
| app/web/src/components/chat-page/__tests__/section-workspace-panel-md.test.tsx | 新增 | .md 拦截判定 + 非 .md 回归 |

## 影响面评估

- **跨模块**：ui-md-editor（组件提升）+ ws-panel（拦截）+ ws-api-client（HTTP client）+ ws-handler（后端）+ ws-route（路由）+ test-ut。五模块，无破坏性 API 变更（仅新增端点 + 组件路径变）。
- **依赖顺序**：底层先于上层 —— (1) 后端 handler + 路由 → (2) api client → (3) 拦截 + 挂载层（消费 client）→ (4) 组件提升（academy 侧 import 改路径，可与 (3) 并行或先做）。组件提升独立，无强依赖。
- **回归风险点**：
  - academy 侧 md editor 提升后 import 路径错 → academy 编辑功能崩（UT 兜底 + typecheck）
  - 非 .md 文件 / 文件夹行为变化 → 回归 UT 断言覆盖
  - 路径穿越校验遗漏 → 安全漏洞（whitelistResolve 双层校验 + UT 覆盖 traversal/symlink）
  - SectionWorkspacePanel 超 300 行 → 挂载层独立文件规避
- **打包护栏**：后端纯 Node 内置 fs + 现有 helper，dev 测试 = packaged 行为，无打包专属崩点（决策#7 自检通过）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现更优实现或约束已变（如 hint Props 通用化）→ 合理偏离 + 向 orchestrator 汇报，orchestrator 裁决是否 follow-up

## 跨文档同步待办（doc-modifier 阶段 5 落，coder 不动）

- `specs/api/overall/04-agent-session.md §2.6` → 补 §2.6.7 file 读/存端点契约（本版本 architect 已落，见该文件）
- `specs/ui/components/common/component-modal-md-editor.md` → 从 academy-page/ 路径提升到 common/（§复用关系「待跨 ≥2 页复用」→ 标记已落实：academy + workspace 双消费）
- `specs/ui/components/chat-page/component-workspace-panel.md` → 补「.md 文件点击走内置 editor」分支（非 .md / 文件夹不变）
- `specs/ui/overall/00-app-guide.md` → 补「workspace 点 .md → 内置 editor 查看/编辑/保存」操作路径
- `specs/tech/app/frontend/log.md` → 记组件提升 + workspace 拦截机制（本版本 architect 已落要点，doc-modifier 润色）
