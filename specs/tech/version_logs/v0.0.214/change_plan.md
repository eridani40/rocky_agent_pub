# v0.0.214 变更计划书 — Academy Skills 呈现改为目录/文件树（修实现偏离 spec）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 依据：`reqs/[working] v0.0.214.academy_skills_view/req.md`（排查结论已固化）。本版本**跳过 PRD**（契约早已存在：`reqs/[done] v0.0.210.new_academy/design.md §8 项9 L167`「skill 支持整体新增或单文件改变（文件级 diff）」+ `specs/ui/overall/12-academy.md §11`「skill-file 文件修改 mod-badge」——属补齐实现，非新概念）。

## 架构决策（本表约束的来源，coder 不得擅自翻转）

**D1 数据通道 = 方案 B（academy 专属端点），但只新增 2 个端点 + 复用底层原语。**
- 版本 skill 的文件树塞进**已有** `GET .../version/:vid`（18-academy §1.8 的 `content.skills`，把空洞的 `SkillSummary` 就地定义为「目录 + 文件树 + hash」）→ diff 拿两版本仍是现有 2 个请求，零新增往返。
- 只新增 `GET/PATCH .../version/:vid/skill/:name/file`（单文件读/写）。
- **不走** `GET /skill/:name/tree|file`（方案 A）理由：① workspace 锁定要靠结构而非参数——B 的目录由 server 从 `version.workspaceDir` 派生，`skills/skill.ts lookupScope` 的 app/builtin 回落根本不在链路上，A 必须给别人的域加 strict 开关；② A 要求前端把 `version.workspaceDir`（DATA_DIR 绝对路径）当 query 明文传，而 06-skill §6.2 的设计意图恰是「path 相对 skillDir 防泄漏绝对路径」；③ `/skill/*` 域语义是「用户已安装 skill」（enabled/governance/delete），版本资产没有这些语义，写路径更无处安放；④ B 复用 `resolveVersion()` 的三层 404 + formal 可写/process 只读校验（与 §1.9 PATCH 同处一致）。
- **复用发生在原语层不在路由层**：`skills/tree.ts buildFileTree` 直接复用；`handlers/skill.ts handleFile` 的路径越界守卫 + 二进制识别 + 截断抽成 `skills/file-io.ts` 供两域共用（净去重，不是复制）。

**D2 预览组件 = 把「树」提升到 `common/`，右侧内容面板各页自持。**
- `common/file-tree.ts`（纯函数）+ `common/component-file-tree.tsx`（递归树视图 + 图标）从 skill-page 平移——顺带把 `component-skill-preview-modal.tsx`（现 **322 行，已违反 ≤300 硬约束**）降到 ~170 行。
- **不共享右侧面板**：skill-page 恒 `<pre>`、academy 按扩展名分渲染（md / mono / binary）且 formal 可编辑，i18n ns 还不同（skill vs academy）；合并要塞 3 个开关 prop，比两份小面板更差。**skill-page 右侧渲染行为一行不改**（约束：不破坏既有行为）。

**D3 写路径 = 不新增 `saveKind='skillFile'`，而是让 Skills 卡彻底离开 md 编辑器通道。**
- Skills 卡「查看」改开 skill browser modal，写走 `PATCH .../version/:vid/skill/:name/file`。数据丢失 bug（`page-academy.tsx:126-134` 用 `saveKind='agentsMd'` 把目录名列表覆盖 AGENTS.md）**按构造消失**——不是「走对分支」，是「那条路不存在」。`MdEditorTarget.saveKind` 保持 `'agentsMd' | 'tools'` 不变（不新增 enum 值 = 不新增闭合性风险）。
- 这是对 req.md §3 两选项中**后者**的取舍（前者是加 `'skillFile'`），已在此显式记录。

**D4 diff = 两级嵌套 + hash 判定 + 只对变更文件取内容。**
- `SkillDirDiff`（skill 目录级 added/**removed**/modified/unchanged）× `SkillFileDiff`（文件级 added/removed/modified/unchanged + `binary`）。复用 `computeLineDiff` / `CmpCols` / `DiffLines` 不动。
- modified 判定靠后端给的 per-file `hash`（sha1 前 12），**不靠 size**（同长度改动会漏判）。
- binary 表达 = `binary: true` + 两侧无 content → 渲染「二进制变更」标签，**MUST NOT** 进 `computeLineDiff`。
- 内容按需：`section-training-result` 只为 `changeKind !== 'unchanged'` 且非 binary 的文件（上限 20）拉两侧内容，组装完整结构后交给 `ComponentDiffViewer`（保持纯展示、无异步）。

## 变更清单

### A. 后端 — skill 文件 IO 原语（去重 + 共用）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| skills | app/server/src/skills/file-io.ts | `MAX_FILE_CHARS` | 新增 | 256KB 截断阈值常量（从 `handlers/skill.ts:32` 迁入，原处删） | MUST 保持 256*1024 不变（06-skill §7.2 契约） | specs/api/overall/06-skill.md §7.2 | +2 |
| skills | app/server/src/skills/file-io.ts | `resolveInsideDir(rootDir, relPath)` | 新增 | 路径越界守卫：`resolve` 后必须 `startsWith(rootDir + sep)`，越界返 null（逻辑取自 `handlers/skill.ts:240-246`） | MUST 用 sep 结尾比较（防 `/a/bc` 冒充 `/a/b` 前缀）；MUST NOT 用字符串 includes | specs/api/overall/06-skill.md §7.3 | +12 |
| skills | app/server/src/skills/file-io.ts | `isBinaryBuffer(buf)` | 新增 | 前 8000 字节含 NUL → 二进制（从 `handlers/skill.ts:273-278` 迁入，原处删） | 判定口径不变（前 8000 字节 NUL） | 06-skill §7.2 | +8 |
| skills | app/server/src/skills/file-io.ts | `SkillFileReadResult` / `SkillFileIoError` | 新增 | `{ ok:true; path; content; truncated; binary }` \| `{ ok:false; error:'invalid_path'\|'not_found' }` 判别联合 | MUST 用判别联合，MUST NOT 抛异常做流控（caller 按 error 映射 400/404） | 06-skill §7.3 | +10 |
| skills | app/server/src/skills/file-io.ts | `readSkillFile(rootDir, relPath)` | 新增 | 越界守卫 → 存在性/isFile 检查 → 二进制标记 → utf8 + 截断；返 `SkillFileReadResult` | MUST 复用 resolveInsideDir + isBinaryBuffer；binary 时 content='' | 06-skill §7.2/§7.3 | +26 |
| skills | app/server/src/skills/file-io.ts | `writeSkillFile(rootDir, relPath, content)` | 新增 | 越界守卫 → **目标必须已存在且是文件** → 目标必须非 binary → utf8 覆写；返 ok/error | MUST NOT 创建新文件、MUST NOT 建目录、MUST NOT 删文件（本版无对应 UI，避免多余写权限面）；MUST 拒写 binary 目标 | 原则「不遗留死代码/最小写面」 | +26 |
| skills | app/server/src/handlers/skill.ts | `handleFile` | 修改 | 内部实现改为 delegate `readSkillFile(skillDir, rel)` + 把 error 映射 400/404；删除本文件内的越界判定/二进制/截断代码 | MUST 保持 HTTP 响应 shape + 状态码逐字节不变（06-skill §7 既有契约 + 既有 AT）；MUST NOT 改 locateSkillDir/lookupScope 行为 | specs/api/overall/06-skill.md §7 | +8/-30 |
| skills | app/server/src/handlers/skill.ts | `isBinary` / `MAX_FILE_CHARS`（本地私有） | 删除 | 迁至 `skills/file-io.ts`，本文件改 import | MUST 确认无其他 caller 后再删 | — | -10 |
| skills | app/server/src/skills/__tests__/file-io.test.ts | 用例集 | 新增 | UT：越界（`../`、绝对路径、前缀冒充）/ 不存在 / binary / 截断 / write 拒绝新建 / write 拒绝 binary | MUST 覆盖 6 条以上；用临时目录，不碰真实 dataDir | 项目 UT 规范 | +90 |

### B. 后端 — academy 版本 skill 读写

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy | app/server/src/academy/academy-version-dir.ts | `AcademySkillFileNode` | 新增 | `SkillFileNode & { hash?: string }`（file 才有 hash = sha1(bytes) 前 12；dir 无） | MUST NOT 改 `skills/types.ts` 的 `SkillFileNode`（那是 /skill 域契约） | specs/api/overall/06-skill.md §6.2 + 18-academy §1.8 | +8 |
| academy | app/server/src/academy/academy-version-dir.ts | `SkillSummary` | 新增 | `{ name; description?; fileCount; files: AcademySkillFileNode[] }` — 填 18-academy §1.8 引用了却从未定义的类型空洞 | MUST 与 `app/web/src/lib/academy-types.ts` 同名类型逐字段一致 | 18-academy §1.8（spec 空洞） | +10 |
| academy | app/server/src/academy/academy-version-dir.ts | `versionSkillDir(wsDir, skillName)` | 新增 | 返 `<wsDir>/.rocky/skills/<name>`；skillName 非法（含 `/`、`..`、空）返 null | MUST 校验 skillName（`isValidSkillName` 或等价 kebab 正则），MUST NOT 直接 join 未校验入参 | specs/tech/agent/skills/[P0]skill_definition.md §4 | +12 |
| academy | app/server/src/academy/academy-version-dir.ts | `listVersionSkills(wsDir)` | 新增 | 遍历 `.rocky/skills/*` 目录 → 每个 skill：`buildFileTree(dir)` 取文件树 + 对 file 节点算 hash + `parseSkillDir(dir,'workspace').description` + fileCount（只数 file）；目录不存在返 `[]`（0.0 空版本 graceful）；name asc 稳定序 | MUST 复用 `skills/tree.ts buildFileTree` 与 `skills/resolver.ts parseSkillDir`，MUST NOT 自写目录遍历/frontmatter 解析；parseSkillDir 返回值**只取 description**（scope/enabled/governance 字段丢弃——academy 版本资产不属四层 scope 语义）；无 SKILL.md 的目录仍进列表（description 缺省 undefined，不像 /skill 域那样跳过） | specs/tech/academy/[P0]data_model.md §3.1；skill_definition §1/§2 | +40 |
| academy | app/server/src/academy/academy-version-dir.ts | `listVersionSkillNames` | 保留不动 | 仍被 `handleStartStudentSession`（academy-student.ts:192）与 `resolveVersionContent` 使用；**不改签名、不加 hash**（会话启动路径不该付哈希 IO 成本） | MUST NOT 删除或改签名 | 现有 caller academy-student.ts:192 | 0 |
| academy | app/server/src/academy/__tests__/academy-version-dir.test.ts | 新增 describe | 修改 | 补 `listVersionSkills` / `versionSkillDir` UT：多 skill + 子目录 + 无 SKILL.md 目录 + 空 skills 根 + hash 随内容变 + skillName 非法拒绝 | MUST 用临时目录；MUST 断言 hash 对同内容稳定、改内容即变 | 同上 | +80 |
| academy | app/server/src/handlers/academy-student.ts | `handleGetVersionContent` | 修改 | `content.skills` 从 `content.skillNames.map(name=>({name}))`（L114 空洞）改为 `await listVersionSkills(ver.meta.workspaceDir)` | MUST 保持响应外层 shape（`{meta, content:{agentsMd,skills,memory,versionJson}}`）不变，只把 skills 元素从 `{name}` 升级为 SkillSummary | 18-academy §1.8 | +3/-1 |
| academy | app/server/src/handlers/academy-student.ts | `resolveVersion` | 修改 | 由 module-private 改为 `export`（供 academy-student-skill.ts 复用三层 id 校验 + 404 语义） | MUST NOT 复制一份校验逻辑到新文件 | 原则「不遗留冗余」 | +1 |
| academy | app/server/src/handlers/academy-student.ts | `handleStudentRoute` | 修改 | 在 version 分支**之前**加 `/version/:vid/skill/:name/file` 匹配 → delegate `handleVersionSkillRoute`；其余分支不动 | MUST 把新 pattern 放在 `versionMatch` 之前（否则被 `/version/([^/]+)$` 之外的兜底 404 吞）；MUST NOT 在本文件内实现 handler（本文件 233 行，≤300 硬约束） | 18-academy §7.1 最长前缀优先不变量 | +8 |
| academy | app/server/src/handlers/academy-student-skill.ts | `handleVersionSkillRoute(req, method, cid, sid, vid, skillName, deps)` | 新增 | 分发 GET / PATCH；GET 无 path → 405；method 其他 → 405 + allow 头 | MUST 与既有 handler 一致返回 `allow` 头（academy-student.ts:61 范式） | 18-academy §1.11（本版新增章节） | +30 |
| academy | app/server/src/handlers/academy-student-skill.ts | `handleGetVersionSkillFile` | 新增 | `resolveVersion` → `versionSkillDir` → `readSkillFile(skillDir, path)` → 200 `{path,content,truncated,binary}`；`invalid_path`→400、`not_found`→404、skill 目录不存在→404 `skill_not_found` | MUST 复用 `skills/file-io.ts readSkillFile`（MUST NOT 自己读文件/判二进制）；响应 shape MUST 与 06-skill §7.2 一致（前端可共用解析） | 18-academy §1.11 + 06-skill §7.2 | +26 |
| academy | app/server/src/handlers/academy-student-skill.ts | `handlePatchVersionSkillFile` | 新增 | body `{path, content}`；`resolveVersion` → **`meta.type !== 'formal'` → 409 `process_version_readonly`** → `versionSkillDir` → `writeSkillFile` → 200 `{ok:true, path}` | MUST 复用与 §1.9 相同的 formal-only 判定与错误码 `process_version_readonly`；MUST NOT 经 `writeVersionDirFiles`（那会重写 AGENTS.md/version.json——正是本版要堵的数据丢失形态）；MUST 拒绝 binary/新建（由 writeSkillFile 保证） | 18-academy §1.9 约束 + req.md 修复范围 3 | +36 |
| academy | app/server/src/handlers/__tests__/academy-student-skill.test.ts | 用例集 | 新增 | UT：GET 正常/缺 path 400/越界 400/不存在 404/skill 不存在 404；PATCH formal 成功 + 内容落盘、process 409、新建 404、binary 拒绝、越界 400 | MUST ≥8 case；MUST 断言 PATCH 后 AGENTS.md 与 version.json **未被改动**（防回归数据丢失 bug） | req.md 验收标准 2 | +130 |

### C. 前端 — 文件树提升到 common/（复用 + 顺带修 322 行超限）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-common | app/web/src/components/common/file-tree.ts | `SkillFileTreeNode` / `buildFileTree` / `findFirstFilePath` / `collectDirPaths` | 新增 | 从 `skill-page/skill-types.ts:28/48/88/100` **原样平移**（扁平 `SkillFileNode[]` → 嵌套树 + 深度优先首文件 + dir 全展开预填） | MUST 行为逐字节不变（既有 UT 断言不改语义）；MUST NOT 借机改排序/命名 | specs/api/overall/06-skill.md §6.2 | +75 |
| ui-common | app/web/src/components/common/component-file-tree.tsx | `ComponentFileTree` | 新增 | 递归文件树视图（dir twisty 旋转 + folder/folderOpen gold + file muted + active accent + 缩进 6+depth*14 / file +14），props `{ nodes, expanded, selPath, onToggleExpand, onSelect }`；从 `component-skill-preview-modal.tsx:196-274` 平移 `FileTreeNodeView` | MUST 视觉/缩进/aria 与平移前一致（skill-page 不得有可见变化）；MUST NOT 内置 i18n 文案（纯结构组件） | specs/ui/components/skill-page/component-skill-preview-modal.md 视觉基线 | +150 |
| ui-common | app/web/src/components/common/component-file-tree.tsx | 内联图标 `ChevronMini/FolderMini/FolderOpenMini/FileMini` | 新增 | 从 `component-skill-preview-modal.tsx:291-320` 平移 4 个 svg（`SkillStarIcon`/`CloseIcon` **留在** skill 弹层） | MUST 只搬树相关图标 | 同上 | +45 |
| ui-skill | app/web/src/components/skill-page/skill-types.ts | 平移的 4 个符号 | 删除 | 删 `SkillFileTreeNode` + 3 个纯函数；文件保留为 api 类型 re-export 模块 | MUST 更新全部 import 站点（现仅 `component-skill-preview-modal.tsx:13-19` + 1 个 UT） | — | -80 |
| ui-skill | app/web/src/components/skill-page/component-skill-preview-modal.tsx | `ComponentSkillPreviewModal` | 修改 | 改 import `common/file-tree` + `common/component-file-tree`；删除内联 `FileTreeNodeView` + 4 图标；左树渲染换成 `<ComponentFileTree …>` | MUST 右侧 `<pre>` 渲染 + `skill` ns 文案 + 尺寸 820×560 **一行不改**（D2 约束：不破坏既有行为）；改后文件 MUST ≤300 行（现 322 = 既有违规，本版顺带清） | specs/ui/components/skill-page/component-skill-preview-modal.md | +10/-160 |
| ui-web | app/web/src/components/__tests__/file-tree.test.ts | 用例集 | 新增 | 由 `skill-page/__tests__/skill-types.test.ts` 移入（import 改 `common/file-tree`），断言不变；原文件删除 | MUST 断言内容不改（纯搬迁），MUST NOT 降低覆盖 | 同上 | +115/-115 |

### D. 前端 — academy skill browser（预览 + 写）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-academy | app/web/src/lib/academy-types.ts | `AcademySkillFileNode` / `SkillSummary` | 新增 | 与后端同名类型逐字段镜像（`{name,path,type,size?,hash?}` / `{name,description?,fileCount,files}`） | MUST 与 B 节后端定义一致，MUST NOT 各自漂移 | 18-academy §1.8 | +14 |
| ui-academy | app/web/src/lib/academy-types.ts | `VersionContent.content.skills` | 修改 | 类型从 `Array<{name:string}>` 改 `SkillSummary[]`；顶部注释「skills 仅 name」的过时说明同步订正 | MUST 同步改 `academy-api.ts` 头部注释里同一句过时描述 | 同上 | +2/-2 |
| ui-academy | app/web/src/lib/academy-api.ts | `getVersionSkillFile(cid,sid,vid,skillName,path,base?)` | 新增 | GET `.../version/:vid/skill/:name/file?path=` → `{path,content,truncated,binary}`；path/skillName 都 encodeURIComponent | MUST 走既有 `req<T>`（不新造 fetch 封装）；MUST NOT 把 workspaceDir 放进 URL | 18-academy §1.11 | +14 |
| ui-academy | app/web/src/lib/academy-api.ts | `saveVersionSkillFile(cid,sid,vid,skillName,path,content,base?)` | 新增 | PATCH 同路径，body `{path,content}` → `{ok,path}` | MUST 仅在 formal 版本调用（调用方门禁），后端仍二次校验 | 18-academy §1.11 | +14 |
| ui-academy | app/web/src/components/academy-page/skill-file-view.ts | `classifySkillFile(path)` | 新增 | 按扩展名分类 → `'markdown' \| 'text' \| 'unknown'`：`.md/.markdown`→markdown；`.py/.sh/.yaml/.yml/.json/.txt/.ts/.js/.toml/.ini/.csv`→text；其余→unknown（配合后端 binary 标记决定右侧渲染） | MUST 是纯函数（可 UT）；MUST NOT 用 MIME 猜测/读内容嗅探 | req.md 修复范围 2 | +26 |
| ui-academy | app/web/src/components/academy-page/component-skill-browser-modal.tsx | `ComponentSkillBrowserModal` | 新增 | Skills 浏览弹层：左侧**两级树**（skill 目录为 root children，其下文件/子目录，用 `buildFileTree(skill.files)` 逐 skill 建子树后合成）+ 右侧按 `classifySkillFile` 分渲染（markdown→`PrimitiveMarkdownView`、text→mono `<pre>`、unknown/binary→「不可预览」提示）+ 头部 skill 名/路径 + formal 时「👁 查看 / ✏️ 编辑」toggle + 「保存」；props `{ open, skills, studentName, versionLabel, readOnly, onFetchFile, onSaveFile, onClose }` | MUST 走 `<Portal>` + 根节点显式 `pointer-events-auto`（`_conventions.md §13` L3 modal 不变式，漏则全按钮不可点）；MUST 复用 `common/component-file-tree` + `common/file-tree` + `common/primitive-markdown-view`，MUST NOT 复制树代码；MUST NOT 引用/触发 `component-modal-md-editor`（D3：Skills 卡彻底离开 md 编辑器通道）；`readOnly=true`（process 版本）时 MUST 不渲染编辑/保存按钮；文件内容懒取（选中才 fetch）；≤300 行 | specs/ui/components/academy-page/component-skill-browser-modal.md（本版新增）；_conventions.md §13 | +240 |
| ui-academy | app/web/src/components/academy-page/component-skill-browser-modal.tsx | `data-action-key` 埋点 | 新增 | 关闭 `academy.version.close-skill-browser`、编辑切换 `academy.version.edit-skill-file`、保存 `academy.version.save-skill-file` | MUST 用 `academy.` 板块前缀（`_conventions.md §12.2`），跨语言恒定 | _conventions.md §12 | 含上行 |
| ui-academy | app/web/src/components/academy-page/component-tuple-cards.tsx | Skills 卡 `onAction` | 修改 | 删掉「拼 `- skill-a\n- skill-b` 假 markdown + fileName `'SKILLS'` + `saveKind:'agentsMd'`」（L50-52）；改为 `onOpenSkillBrowser()`；sub 文案换 `t('tuple.skillsSub',{skills,files})`（M = `sum(fileCount)`）；chip 仍显 skill 名 + 每 chip 后缀「N 文件」 | MUST NOT 再向 `onOpenMdEditor` 传 skills 任何形态（数据丢失路径按构造关闭）；MUST NOT 改其他 4 张卡行为 | req.md 排查表行 1/2；specs/ui/components/academy-page/component-tuple-cards.md（本版新增） | +14/-6 |
| ui-academy | app/web/src/components/academy-page/component-tuple-cards.tsx | `Props.onOpenSkillBrowser` | 新增 | 新增回调 prop（无参，父级已知选中版本） | MUST 由 section 传入，MUST NOT 在卡内直接调 API | 同上 | +3 |
| ui-academy | app/web/src/components/academy-page/section-student-detail.tsx | `Props.onOpenSkillBrowser` | 新增 | 新增回调 prop 并透传给 `ComponentTupleCards`；内部组装 `{ skills, versionId, versionLabel, readOnly: !selectedIsFormal }` 上抛 page | MUST 与既有 `openMdEditor` 同范式（modal state 归 page-academy）；MUST NOT 在 section 内持 modal state | specs/ui/components/academy-page/section-student-detail.md | +18 |
| ui-academy | app/web/src/components/academy-page/section-student-detail.tsx | `SkillBrowserTarget` | 新增 | 导出 target 类型 `{ skills: SkillSummary[]; versionId; versionLabel; readOnly }`（与 `MdEditorTarget` 并列） | MUST NOT 复用/污染 `MdEditorTarget`（两条通道彻底分开） | 同上 | +8 |
| ui-academy | app/web/src/components/academy-page/page-academy.tsx | `skillBrowser` state + 渲染 | 新增 | `useState<SkillBrowserTarget \| null>`；渲染 `ComponentSkillBrowserModal`，`onFetchFile`→`getVersionSkillFile`、`onSaveFile`→`saveVersionSkillFile` 后 `versionContentHook.reload()` | MUST 与 mdEditor modal 同层级并列；MUST NOT 把 skill 保存混进 `handleMdSave` | 同上 | +22 |
| ui-academy | app/web/src/components/academy-page/page-academy.tsx | `handleMdSave` | 修改 | 仅核对：`saveKind` 仍只有 `'agentsMd' \| 'tools'`，else 分支不再可能收到 skills 数据（加一行注释锚定 D3） | MUST NOT 新增 `'skillFile'` 分支（D3）；MUST NOT 改 tools/agentsMd 现有行为 | req.md 排查表行 2 | +2 |
| ui-academy | app/web/src/components/academy-page/__tests__/component-skill-browser-modal.test.tsx | 用例集 | 新增 | UT：两级树渲染（skill → 文件）、选 `.md` 走 markdown、选 `.py` 走 `<pre>`、binary 显不可预览、`readOnly` 无保存按钮、formal 保存回调携带 `{skillName,path,content}` | MUST ≥6 case；MUST 断言 Portal 根 `pointer-events-auto`（§13 防回归范式，见 component-modal-md-editor.test.tsx） | _conventions.md §13 | +140 |
| ui-academy | app/web/src/components/academy-page/__tests__/skill-file-view.test.ts | 用例集 | 新增 | `classifySkillFile` 扩展名分类 UT（含大写扩展名、无扩展名、多点文件名） | 纯函数 UT | — | +40 |

### E. 前端 — 两级 skill diff

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-academy | app/web/src/components/academy-page/component-diff-viewer.tsx | `SkillFileDiff` | 修改 | 字段 `name` → `path`（相对 skill 目录）；`changeKind` 加 `'removed'`；新增 `binary?: boolean`；保留 `baseContent?/candContent?` | MUST NOT 保留旧 `name` 字段（避免双源）；binary 时两侧 content MUST 缺省 | req.md 修复范围 4；design.md §8 项9 | +6/-2 |
| ui-academy | app/web/src/components/academy-page/component-diff-viewer.tsx | `SkillDirDiff` | 新增 | `{ name: string; changeKind: 'added'\|'removed'\|'modified'\|'unchanged'; files: SkillFileDiff[] }` — skill 目录级 | MUST 是两级结构外层（不得把文件平铺回一级） | 同上 | +10 |
| ui-academy | app/web/src/components/academy-page/component-diff-viewer.tsx | `DiffItem.skills` | 修改 | `{ files: SkillFileDiff[] }` → `{ skills: SkillDirDiff[] }`（字段改名避免「files 里装目录」的误导） | MUST 同步改所有构造点（`build-diff-items.ts`）与渲染点 | 同上 | +2/-2 |
| ui-academy | app/web/src/components/academy-page/component-diff-viewer.tsx | `SkillFile`（旧一级卡） | 删除 | 移出到 `component-skill-diff-list.tsx`（两级重写）；diff-viewer 的 skills 分支改渲染 `<ComponentSkillDiffList …>` | MUST 保持 `CmpCols`/`ColTag`/`DiffLines` 留在本文件供 system/memory/model 用（并 export 给 diff-list 复用）；本文件改后 MUST ≤300 行 | specs/ui/components/academy-page/component-diff-viewer.md | +6/-40 |
| ui-academy | app/web/src/components/academy-page/component-diff-viewer.tsx | `CmpCols` / `ColTag` / `DiffLines` | 修改 | 由 module-private 改为 `export`（供 diff-list 复用行级 diff 渲染） | MUST NOT 复制一份渲染逻辑到 diff-list | 同上 | +3 |
| ui-academy | app/web/src/components/academy-page/component-skill-diff-list.tsx | `ComponentSkillDiffList` | 新增 | 两级渲染：外层 skill 目录卡（badge：`diff.newSkill`「整体新增」sage / `diff.removedSkill`「已移除」danger / `diff.modSkill`「文件修改」gold / `diff.unchanged`「不变」muted，可折叠）+ 内层文件行（badge：`diff.fileAdded`/`fileRemoved`/`fileModified`/`fileBinary`/`fileUnchanged`；text+有内容 → `CmpCols` + `computeLineDiff` 行级 diff） | MUST 复用 `computeLineDiff` + `CmpCols`/`ColTag`/`DiffLines`（不自写 diff 算法/样式）；**MUST NOT 把 binary 文件塞进 computeLineDiff**（binary 只显标签）；modified 的 skill 目录默认展开、unchanged 默认折叠；≤300 行 | design.md §8 项9；specs/ui/overall/12-academy.md §11「skill-file 文件修改 mod-badge」 | +150 |
| ui-academy | app/web/src/components/academy-page/skill-diff.ts | `buildSkillDirDiffs(baseSkills, candSkills)` | 新增 | 纯函数：name 集合 → `added`（仅 cand）/ **`removed`（仅 base，修「误标不变」）** / 两侧都有则按文件 `hash` 比对定 `modified`\|`unchanged`；文件级 added/removed/modified/unchanged 同法；binary 由「后端 file 节点无 hash 或后续读到 binary」标记（渲染层用 `binary` 字段） | MUST 用 hash 判 modified（**MUST NOT 用 size**）；MUST 输出 skill 名 asc + 文件 path asc 稳定序；纯函数、无 IO | req.md 排查表行 3（永不产 modified + 删除误标不变） | +80 |
| ui-academy | app/web/src/components/academy-page/skill-diff.ts | `collectDiffFileRefs(dirs, limit)` | 新增 | 从 `SkillDirDiff[]` 摘出需取内容的文件引用 `{skillName, path, needBase, needCand}[]`（`changeKind!=='unchanged'` 且非 binary），上限 `limit`（默认 20）；返回 `{ refs, truncated }` | MUST 有上限（防一次 fork 塞几十文件时的请求风暴）；`truncated=true` 时渲染层显 `diff.filesTruncated` 提示 | 原则「可维护 + 不炸请求」 | +36 |
| ui-academy | app/web/src/components/academy-page/build-diff-items.ts | `buildDiffItems(input)` | 新增 | 把 `section-training-result.tsx:91-144` 的 `diffItems` 组装逻辑整体搬出为纯函数：system（AGENTS.md 两侧）+ skills（接受已填内容的 `SkillDirDiff[]`）+ memory + model；summary 文案用注入的 `t` | MUST 是纯函数（无 fetch / 无 hook），便于 UT；MUST 保持 system/memory/model 三项现有行为不变（本版只改 skills 项） | specs/ui/components/academy-page/section-training-result.md | +90 |
| ui-academy | app/web/src/components/academy-page/section-training-result.tsx | `diffItems` useMemo | 修改 | 改为：`buildSkillDirDiffs` → `collectDiffFileRefs` → 并发 `getVersionSkillFile`(base/cand 两版本) 填 content → `buildDiffItems(...)`；删除原地的 skills name-集合逻辑（L103-121，永不产 modified 的死路径） | MUST 只为变更文件取内容（unchanged 不取）；取内容失败 MUST 降级为「无行级 diff」而非整页报错；`ComponentDiffViewer` MUST 保持纯展示（异步全在本 section） | req.md 排查表行 3 + 验收标准 3 | +55/-55 |
| ui-academy | app/web/src/components/academy-page/section-training-result.tsx | 顶部文件注释 | 修改 | 删除「skills 后端仅返 name 列表 → 文件级行 diff 无内容可比对（降级，已汇报）」这段已过时的降级说明，改写为两级 diff 数据源说明 | MUST 与实现一致（原则 12/13：spec/注释不得留过时描述） | 同上 | +4/-3 |
| ui-academy | app/web/src/components/academy-page/__tests__/skill-diff.test.ts | 用例集 | 新增 | UT：整体新增 / 已移除 / 文件级 modified（含 `references/*.py` 非 SKILL.md 文件）/ unchanged / hash 相同不误报 / binary 不进内容取用 / limit 截断 | MUST 含「被删除的 skill 判 removed 而非 unchanged」的防回归 case（原 bug）；MUST 含「SKILL.md 外附属文件改动能判 modified」case | req.md 验收标准 3 | +140 |
| ui-academy | app/web/src/components/academy-page/__tests__/build-diff-items.test.ts | 用例集 | 新增 | UT：4 项齐全 + defaultOpen 规则 + skills 项接两级结构 | MUST ≥4 case | — | +70 |

### F. i18n（单文件单 owner — 两组 key 一次性补齐，避免同文件双 task 互踩）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| i18n | app/web/src/i18n/locales/zh-CN/academy.json | `diff.modSkill` | 修改 | 「SKILL.md 修改」→「文件修改」（措辞过窄：skill_definition §2 允许任意附属文件） | MUST 与 en 对等改 | specs/tech/agent/skills/[P0]skill_definition.md §2 | +1/-1 |
| i18n | app/web/src/i18n/locales/zh-CN/academy.json | `diff.removedSkill` / `diff.fileAdded` / `diff.fileRemoved` / `diff.fileModified` / `diff.fileBinary` / `diff.fileUnchanged` / `diff.filesTruncated` | 新增 | 「已移除」/「新增文件」/「删除文件」/「修改」/「二进制变更」/「不变」/「文件较多，未加载全部行级 diff」 | MUST zh-CN 与 en 键集完全对等（无缺无多） | _conventions.md §8a | +7 |
| i18n | app/web/src/i18n/locales/zh-CN/academy.json | `tuple.skillsSub` | 新增 | 「{{skills}} 个 skill · {{files}} 个文件」（替代 Skills 卡 sub 里的 `tuple.skillsCount` 用法；`skillsCount` 保留给别处/en 对等） | MUST 用插值不用字符串拼接 | req.md 修复范围 2 | +1 |
| i18n | app/web/src/i18n/locales/zh-CN/academy.json | `skillBrowser.*` | 新增 | `title` / `sub` / `emptyTree` / `selectHint` / `loading` / `binary` / `unpreviewable` / `truncated` / `readFail` / `view` / `edit` / `save` / `saved` / `saveFail` / `readOnlyHint`（process 版本只读提示） | MUST 全部经 `t()`（禁硬编码可见文案）；ns = `academy` | _conventions.md §8a | +15 |
| i18n | app/web/src/i18n/locales/en/academy.json | 上述全部键 | 修改 | 与 zh-CN 键集逐键对等的英文文案 | MUST 键集与 zh-CN 完全一致（CI/UT 若有对等校验须绿） | 同上 | +23/-1 |

### G. spec 同步（api / tech / ui — 编码同期产出，doc-modifier 阶段 5 复核）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| api-spec | specs/api/overall/18-academy.md | §1.8 `SkillSummary` | 修改 | 定义 `SkillSummary` + `AcademySkillFileNode`（含 hash 语义 = sha1 前 12、fileCount 只数 file、description 来自 SKILL.md frontmatter 可缺省），删掉「引用未定义类型」的空洞 | MUST 与 B 节实现字段逐一致；MUST 标 `[v0.0.214]` | 18-academy §1.8（spec 空洞） | +30 |
| api-spec | specs/api/overall/18-academy.md | §1.11（新章节） | 新增 | `GET/PATCH /academy/classroom/:cid/student/:sid/version/:vid/skill/:name/file` 契约：query/body/响应/错误码；显式写明「**不复用 `/skill/:name/tree\|file`**，理由 = workspace 锁定 + 不外泄绝对路径 + formal/process 权限归位」 | MUST 同时更新 §1.9 的「skills/memory 经 dedicated 端点」指向本节（兑现 §1.9 承诺） | D1 | +55 |
| api-spec | specs/api/overall/18-academy.md | §7 错误码表 + §7.1 分发顺序 | 修改 | 补 `skill_not_found`(404) / `invalid path`(400) / `process_version_readonly`(409 已有则复用)；§7.1 规则 3 补「`/version/:vid/skill/*` 亦由 handleStudentRoute 承接并二次分发」 | MUST 与 handler 实际返回一致 | 18-academy §7/§7.1 | +8 |
| api-spec | specs/api/overall/06-skill.md | §7 实现注 | 修改 | 注明 file 读原语已抽 `app/server/src/skills/file-io.ts`，academy 版本 skill 端点共用同一原语（响应 shape 因此一致） | MUST NOT 改 §6/§7 对外契约描述（行为未变） | A 节 | +6 |
| api-spec | specs/api/overall/06-skill.md | §8 `SkillEntry` | 修改 | **顺带订正既有 spec 漂移**（非编码依赖，doc-only）：`source` 去掉 `'system'`（实际 `'user'\|'agent'`）、`mutable/mutableLocked` → `evolvable`（v0.0.55 已删 lock 维度）、补 `updatedAt`/`marketRef`/`marketSource`/`installedHash` | MUST 只改描述不改行为；如 planner 判定超范围可移交 doc-modifier 阶段 5 | skill_definition §2 注（v0.0.55/149/167）；原则 13 | +10/-4 |
| tech-spec | specs/tech/academy/[P0]data_model.md | §3.1 + §6.1 | 修改 | §3.1 补「d skills = `.rocky/skills/`，读侧 = `listVersionSkills` 返 SkillSummary（目录 + 文件树 + hash）」；§6.1 目录工具函数表补 `versionSkillDir` / `listVersionSkills` / 单文件读写走 `skills/file-io.ts` | MUST 说明「复用 skills/ 原语，academy 不重造遍历/frontmatter 解析」 | data_model §3.1/§6.1 | +18 |
| tech-spec | specs/tech/academy/[P0]academy_skills.md | §9 边界表 | 修改 | 加一行：「版本工作区 skill 的文件树/内容读写端点 → 本 KB（academy 域，复用 `../agent/skills/` 的 buildFileTree/parseSkillDir/file-io 原语）」，与既有「SKILL.md schema/四层扫描 → `../agent/skills/`」并列 | MUST 不改「skill 结构契约归 agent/skills」的归属（academy 只管版本资产的读写通道） | academy_skills §9 | +3 |
| tech-spec | specs/tech/academy/log.md | v0.0.214 行 | 新增 | 位置轴变更行：skills 呈现改目录/文件树（SkillSummary 定义 + 版本 skill 文件端点 + 两级 diff + 关闭 AGENTS.md 覆盖路径） | MUST 倒序置顶；MUST 精简（结论不写过程） | okf-skill / tech-spec-rules §4 | +2 |
| ui-spec | specs/ui/overall/12-academy.md | §8 字段边界 | 修改 | 「Skills 的 SKILL.md → 走 md 编辑器」改为「**Skills 走 skill browser 弹层**（目录/文件树 + 按扩展名分渲染；formal 可编辑单文件，process 只读）；md 编辑器只管 AGENTS.md + memory .md + tools」 | MUST 明确「Skills 不再经 md 编辑器」（堵住数据丢失形态的 spec 级表述） | D3；12-academy §8 | +10/-3 |
| ui-spec | specs/ui/overall/12-academy.md | §11 视觉基线（训练结果 diff） | 修改 | `skill-file` 描述升级两级：skill 目录级（整体新增 sage / 已移除 danger / 文件修改 gold / 不变 muted）× 文件级（新增/删除/修改/二进制变更/不变）；补 skill browser 弹层视觉一行 | MUST 与实现 badge 配色一致 | 12-academy §11 | +8/-2 |
| ui-spec | specs/ui/components/academy-page/component-skill-browser-modal.md | 全文 | 新增 | 组件 spec（职责/Props/状态交互/可见文案/复用关系/视觉基线 + data-action-key 清单 + §13 Portal 不变式） | MUST 按 `_conventions.md §6` 模板 6 段；可见文案清单 MUST 全列（E2E 定位契约） | _conventions.md §6 | +70 |
| ui-spec | specs/ui/components/academy-page/component-tuple-cards.md | 全文 | 新增 | **补既有 spec 空洞**：`component-tuple-cards.tsx` 早已存在却无组件 spec（内容散在 section-student-detail.md）。写清 5 卡职责/Props/各卡动作（Skills → skill browser、Tools/AGENTS.md → md 编辑器、模型 → InputModelPicker） | MUST 与 section-student-detail.md 的五元组表不矛盾（后者改为引用本文） | _conventions.md §5/§6；原则 13 | +80 |
| ui-spec | specs/ui/components/academy-page/component-diff-viewer.md | Props + 状态/文案 | 修改 | `SkillFileDiff` 两级契约（`SkillDirDiff` × `SkillFileDiff`）+ badge 文案清单改「文件修改 / 已移除 / 新增文件 / 删除文件 / 二进制变更 / 不变」（删掉「SKILL.md 修改」措辞）+ 说明 skills 渲染委托 `component-skill-diff-list` | MUST 与实现类型逐字段一致；MUST 保留 system/memory/model 段不变 | req.md 排查表行 6（措辞过窄） | +26/-8 |
| ui-spec | specs/ui/components/academy-page/component-skill-diff-list.md | 全文 | 新增 | 组件 spec（两级折叠 + badge 矩阵 + binary 表达 + 默认展开规则 + 可见文案） | MUST 按 `_conventions.md §6` 模板 | 同上 | +60 |
| ui-spec | specs/ui/components/academy-page/section-training-result.md | 状态/交互 + 可见文案 | 修改 | diff item 表的 Skills 行改两级描述；可见文案清单同步（「整体新增」「已移除」「文件修改」「不变」+ 文件级 badge）；补「只为变更文件取内容 + 超限提示」 | MUST 与 E 节实现一致 | 同上 | +12/-5 |
| ui-spec | specs/ui/components/academy-page/section-student-detail.md | 五元组表 + 复用关系 | 修改 | Skills 卡 sub 改「`.rocky/skills/ · N 个 skill · M 个文件`」、动作改「查看（开 skill browser）」；复用关系补 `component-skill-browser-modal` + 五元组细节引用新建的 `component-tuple-cards.md` | MUST 不与 component-tuple-cards.md 重复描述（单一权威） | 同上 | +8/-4 |
| ui-spec | specs/ui/components/academy-page/_overview.md | 组件树 + 映射表 | 修改 | 组件树加 `component-tuple-cards` / `component-skill-browser-modal` / `component-skill-diff-list`；spec↔实现映射表补对应行 | MUST 树层级正确（modal 归 section-student-detail 触发的 component 层） | _conventions.md §7 | +8 |
| ui-spec | specs/ui/components/common/component-file-tree.md | 全文 | 新增 | 通用递归文件树组件 spec（Props/交互/视觉基线/复用方：skill-page 预览弹层 + academy skill browser） | MUST 标注「跨 ≥2 页复用才进 common」的达成理由 | _conventions.md §2/§4 | +55 |
| ui-spec | specs/ui/components/skill-page/component-skill-preview-modal.md | 复用关系 + 决策 | 修改 | 注明左树改用 `common/component-file-tree` + 纯函数改用 `common/file-tree`；右侧 `<pre>` 渲染与文案不变；补「原 322 行超限已随平移解决」 | MUST 明确「行为未变」 | D2 | +8/-2 |

## 影响面评估

- **跨模块**：server（`skills/` 原语 + `academy/` 目录 IO + 2 handler）、web（`common/` 新增 2 文件 + academy-page 5 新 3 改 + skill-page 2 改 + lib 2 改 + i18n 2 改）、specs（api 2 / tech 3 / ui 9）。
- **破坏性变更**：
  1. `VersionContent.content.skills` 元素类型 `{name}` → `SkillSummary`（**向后兼容**：`name` 字段保留，新增字段可选消费）。唯一消费点是 academy 前端（tuple 卡 + 训练结果页），本版一并改。
  2. `DiffItem.skills` 字段 `files` → `skills` + `SkillFileDiff.name` → `path`：仅 academy-page 内部类型，无外部消费者。
  3. `skill-page/skill-types.ts` 删 4 个导出符号：import 站点仅 2 处（预览弹层 + 1 UT），本版一并改。
- **依赖顺序**（planner 切 task 必须遵守）：A（`skills/file-io.ts`）→ B（academy handler 依赖 A）→ C（`common/` 树）→ D（browser 依赖 B+C）→ E（diff 依赖 B 的 hash）。C 与 A/B 无依赖可并行。
- **风险点**：
  - `handleStudentRoute` 新 pattern 顺序放错 → 端点 404（18-academy §7.1 曾因分发顺序踩过 Critical，UT 必覆盖新 pattern）。
  - `handlers/skill.ts handleFile` 重构若改动响应 shape → 打破既有 06-skill AT。约束列已钉「逐字节不变」，coder 须跑既有 skill UT/AT。
  - `component-diff-viewer.tsx`（现 228 行）与 `section-training-result.tsx`（现 256 行）都贴近 300 上限——本表已把新逻辑外移到 `component-skill-diff-list.tsx` / `skill-diff.ts` / `build-diff-items.ts`，coder MUST NOT 就地膨胀这两个文件。
  - hash 计算引入 `node:crypto`（Node 内置，无新 npm 依赖 → 不触发「持续可打包护栏」依赖归属条款）。
- **测试**：本版 **不新增 AT/ET 持久 case**（用户铁律：普通 feature 走 UT + 冒烟集回归）。新增 UT 7 组（file-io / academy-version-dir 增补 / academy-student-skill handler / file-tree 搬迁 / skill-browser-modal / skill-diff / build-diff-items / skill-file-view）。回归口径：`bun run typecheck` + `bun run test` 全绿。

## 建议任务切分（3 个 task，按最粗 owning 级别）

| # | 名称 | coversFiles（owning） | 依赖 |
|---|---|---|---|
| T1 | 后端：skill 文件 IO 原语 + academy 版本 skill 端点 + SkillSummary（A + B + G 的 api-spec/tech-spec 行） | `app/server/src/skills/file-io.ts`、`app/server/src/skills/__tests__/file-io.test.ts`、`app/server/src/handlers/skill.ts`(handleFile/isBinary/MAX_FILE_CHARS 三符号)、`app/server/src/academy/academy-version-dir.ts`、`app/server/src/academy/__tests__/academy-version-dir.test.ts`、`app/server/src/handlers/academy-student.ts`、`app/server/src/handlers/academy-student-skill.ts`(+UT)、`specs/api/overall/18-academy.md`、`specs/api/overall/06-skill.md`、`specs/tech/academy/*` | — |
| T2 | 前端预览：common 文件树提升 + skill browser + Skills 卡改道（C + D + F 全部 i18n + G 的 browser/tuple/common/skill-page ui-spec 行） | `app/web/src/components/common/file-tree.ts`、`common/component-file-tree.tsx`、`components/__tests__/file-tree.test.ts`、`skill-page/skill-types.ts`、`skill-page/component-skill-preview-modal.tsx`、`academy-page/component-skill-browser-modal.tsx`(+UT)、`academy-page/skill-file-view.ts`(+UT)、`academy-page/component-tuple-cards.tsx`、`academy-page/section-student-detail.tsx`、`academy-page/page-academy.tsx`、`lib/academy-api.ts`、`lib/academy-types.ts`、`i18n/locales/{zh-CN,en}/academy.json`、`specs/ui/components/{common,academy-page,skill-page}/…`、`specs/ui/overall/12-academy.md` | T1（端点/类型） |
| T3 | 前端 diff：两级结构 + 渲染 + 纯函数（E + G 的 diff-viewer/diff-list/training-result ui-spec 行） | `academy-page/component-diff-viewer.tsx`、`academy-page/component-skill-diff-list.tsx`、`academy-page/skill-diff.ts`(+UT)、`academy-page/build-diff-items.ts`(+UT)、`academy-page/section-training-result.tsx`、`specs/ui/components/academy-page/{component-diff-viewer.md,component-skill-diff-list.md,section-training-result.md}` | T1（hash 字段）、T2（`SkillSummary` 前端类型 + `diff.*` i18n key） |

> 同文件双 owner 冲突已消除：`academy.json`（i18n）整体归 T2（含 T3 需要的 `diff.*` 键）；`lib/academy-types.ts` 归 T2；`section-student-detail.tsx` 归 T2；`section-training-result.tsx` 归 T3。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- D1–D4 属核心架构决策：coder 如判断需翻转（如改走方案 A），MUST 先报 orchestrator，不得擅自实现
