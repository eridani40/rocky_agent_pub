# v0.0.214 跨版本发布说明 — Academy Skills 呈现改为目录/文件树

> 跨子系统发布说明（tech 各 KB 的 `log.md` 是位置轴，本文件是版本轴汇总）。契约见同目录 `change_plan.md`（A–G 七组）。
> 本版**跳过 PRD**：契约早已存在（v0.0.210 design §8 项 9「skill 支持整体新增或单文件改变（文件级 diff）」+ `specs/ui/overall/12-academy.md §11` 的 skill-file mod-badge），属补齐实现而非新概念。

## 交付物

### 后端（skills + academy）
- `app/server/src/skills/file-io.ts`（新增）= skill 单文件读写原语唯一权威：`resolveInsideDir`（越界守卫，用 `sep` 结尾比较防同前缀兄弟目录冒充）/ `isBinaryBuffer`（前 8000 字节 NUL）/ `MAX_FILE_CHARS`（256KB）/ `readSkillFile` / `writeSkillFile`（只覆写已存在的非二进制文件：不建文件、不建目录、不删、不写二进制）。错误走判别联合 `invalid_path | not_found | binary_target`，由 caller 映射 HTTP。
- `handlers/skill.ts handleFile` 改 delegate 该原语并删本地重复实现 —— `GET /skill/:name/file` 对外响应逐字段不变（既有 skill UT 全绿护栏）。
- `academy/academy-version-dir.ts`：新增 `AcademySkillFileNode`（= `SkillFileNode` + `hash`，file 才有）/ `SkillSummary` / `versionSkillDir`（先 `isValidSkillName` 校验再 join）/ `listVersionSkills`（复用 `skills/tree.ts buildFileTree` + `skills/resolver.ts parseSkillDir` 只取 description）；`listVersionSkillNames` 保留不动（会话启动路径不付哈希 IO 成本）。
- `GET .../version/:vid` 的 `content.skills` 从目录名列表升级为 `SkillSummary[]`，填上 `api 18-academy §1.8` 引用却从未定义的类型空洞。
- 新增 `handlers/academy-student-skill.ts`：`GET/PATCH /academy/classroom/:cid/student/:sid/version/:vid/skill/:name/file`（`api §1.11`）。formal-only 写（process → 409 `process_version_readonly`），**绝不经** `writeVersionDirFiles`。新 pattern 在 `handleStudentRoute` 内排在 `/version/([^/]+)$` 之前（该文件曾因分发顺序踩过 Critical，UT 锁定）。

### 前端
- `common/file-tree.ts` + `common/component-file-tree.tsx`（新增）= 树逻辑与树视图的唯一实现，skill 管理页预览弹层与 academy skill browser 共用；`skill-page/component-skill-preview-modal.tsx` 由 322 行（既有 ≤300 超限债）降至约 200 行，右侧渲染/文案/尺寸未变。
- `academy-page/component-skill-browser-modal.tsx`（新增）：左两级树（skill 目录 × 目录内文件）+ 右按扩展名分渲染（markdown / mono `<pre>` / 不可预览），formal 可编辑保存单文件；md 分支渲染前剥离 YAML frontmatter，编辑态 textarea 恒为文件原文。
- Skills 卡彻底离开 md 编辑器通道：`MdEditorTarget.saveKind` 保持 `'agentsMd' | 'tools'`（**不新增** `'skillFile'`）——「skill 目录名列表当 AGENTS.md 提交」的数据丢失路径按构造消失。
- 训练结果 skills 段升两级 diff：`skill-diff.ts`（`buildSkillDirDiffs` 四态含 removed / `collectDiffFileRefs` 上限 20 / `applySkillFileContents` 回填）+ `component-skill-diff-list.tsx`（目录卡 × 文件行 badge 矩阵）+ `build-diff-items.ts`（4 卡组装纯函数）。异步编排全在 section，`ComponentDiffViewer` 保持纯展示。
- 计划外新增 `component-academy-modals.tsx`：两个版本内容弹层的挂载与保存接线从 `page-academy.tsx` 外移（否则必破 ≤300 行），modal 开关 state 仍归 page。

### spec
- api：`18-academy.md` §1.8 类型补齐 / §1.11 新章节（含「为什么不复用 `/skill/:name/tree|file`」决策表）/ §7 + §7.1；`06-skill.md` §7 实现注 + §8 `SkillEntry` 既有漂移订正。
- tech：`academy/index.md` 补 2 条跨 KB 不变量（版本 skill = 目录 + 文件走专属端点 / 版本对比按全路径两级配对）；`academy/[P0]data_model.md` §3.1 + §6.1；`academy/[P0]academy_skills.md` §9 边界表；`agent/skills/[P0]skill_architecture.md` §2 模块图补 `file-io.ts`。
- ui：`12-academy.md` §8 + §8.1（skill browser）+ §11；新建 4 份组件 spec（`common/component-file-tree.md`、`academy-page/{component-skill-browser-modal,component-tuple-cards,component-skill-diff-list}.md`，其中 tuple-cards 补的是既有空洞）+ 3 份更新 + `_overview.md` 映射表。

## 实现偏离（已对齐到代码实际）

1. **错误码比架构表多两个**：`invalid_input`（PATCH body 非对象 / `content` 非字符串）+ `binary_not_writable`（PATCH 目标是二进制）→ 已入 `18-academy §1.11.3` + §7。
2. **skillName 校验从严**：走 `skills/resolver.ts isValidSkillName`（kebab-case + ≤64），故 `Demo`（大写）/ `a/b` / `..` / 空 一律 400 —— 与平台 skill name 契约一致，非本版引入。
3. **`SkillDirDiff` 目录名字段用 `skillName`**（架构表写 `name`），并多出 `baseSize`/`candSize`：二进制行无行级 diff，只能用字节变化表达「变了什么」。
4. **多一个纯函数 `applySkillFileContents`**：内容回填与四态派生分离，保证二进制文件按构造进不了 `computeLineDiff`（后端标 `binary` 即清空两侧内容）。
5. **计划外文件 `component-academy-modals.tsx`**：见上「前端」最后一条（架构表的行数预估自身不自洽）。
6. **md 分支 frontmatter 剥离**（review 后补）：`stripMarkdownFrontmatter` 只作用于 markdown 渲染路径；**不另造元信息卡**——frontmatter 的结构化消费权在后端 gray-matter，前端零 YAML 解析实现。

## 保留决策（不改）

- **`component-diff-viewer` ↔ `component-skill-diff-list` 互相引用**：前者渲染后者、后者复用其 `CmpCols`/`ColTag`/`DiffLines`。引用只在渲染期解析（ESM 循环安全），已有「经 ComponentDiffViewer 渲染」UT 守住；外移这三个原语需新建第 4 个组件文件 + 配套 spec，churn 大于收益。若将来要解，连 spec 一起改。
- **`i18n tuple.skillsCount` 暂无引用**：Skills 卡 sub 改用 `tuple.skillsSub`（skill 数 + 文件数），`skillsCount` 按架构表保留（zh/en 键集仍对等）。
- **`resolveInsideDir` 不解析 symlink**：与既有 `/skill/:name/file` 同口径；穿越需本机文件系统写权限（单用户桌面 app，攻击者已可直接改文件）。
- **每次 GET version content 读全量文件算 hash**、`writeSkillFile` 为判二进制读整文件：skill 目录通常很小，遇大附件再改为只读前 8KB。

## 回归

`bun run typecheck` 0 error；`bun run test` 全绿（新增/迁移 UT 8 组：file-io / academy-version-dir 增补 / academy-student-skill handler / file-tree 迁移 / skill-file-view / skill-browser-modal / skill-diff / build-diff-items，含 3 条任意深度目录护栏 case）。本版按用户铁律**不新增 AT/ET 持久 case**（普通 feature 走 UT + 冒烟集回归）。
