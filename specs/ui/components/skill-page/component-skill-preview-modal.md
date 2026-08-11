# component-skill-preview-modal

> 层级: component
> 文件: app/web/src/components/skill-page/component-skill-preview-modal.tsx

## 职责
Skill 内容预览 modal。左文件树（250px，整树一次性返回）+ 右内容预览（`<pre>` mono，按文件懒取内容）。header 显示 skill name + 星形图标 + 关闭按钮。点文件树文件项 → 右侧切该文件路径 + 内容。
## Props
- skill: SkillItem;          // id + name
- tree: SkillFileNode;       // 来自后端 /tree（整树）
- onClose: () => void
- onFetchFile: (skillId: string, path: string) => Promise<string>

## 状态 / 交互
- `expanded: Record<string, boolean>`：dir 展开态，默认全部 dir 展开（挂载时遍历树填 path→true）
- `selPath: string | null`：当前选中文件路径；挂载时默认选中「深度优先第一个文件」（见设计稿 `findFirstFile`）
- `content / loading`：selPath 变化 → `onFetchFile(skill.id, selPath)` → 设 content；loading 期间显示「（加载中…）」
- 点文件树 dir 项 → toggle expanded[path]
- 点文件树 file 项 → setSelPath(path)
- 点 overlay / 关闭按钮 → `onClose`
- 首次无文件 → 右侧空态「选择左侧文件查看内容」（或 skill 全空时「（空）」）
- 二进制 / 取不到内容 → 显示「（空文件 / 二进制）」

## 复用关系
- 被组合：`page-skill`
- 组合：`common/component-file-tree`（左侧递归树视图）+ `common/file-tree`（`buildFileTree` / `findFirstFilePath` / `collectDirPaths` 纯函数）；skill 星形与关闭图标仍内联在本组件。
- **右侧内容面板本组件自持**（恒 `<pre>` mono + `skill` ns 文案），与 `academy-page/component-skill-browser-modal` 的右侧面板（按扩展名分渲染 + 可编辑 + `academy` ns）**不共享**——合并需塞 3 个开关 prop，反而更差。左树共享、右面板各自，是刻意取舍。

## 视觉基线
- **layout**：modal `820×560px`（`max-width 94vw` `max-height 88vh`），flex 纵向、、。header `padding 14px 18px` + 底分隔线（flex 两端对齐：title 左 / close 右），`flex-shrink 0`。body flex 横向、`min-height 0`、`flex 1`：左树 250px+ 右内容（`flex 1` 纵向：filepath 条 + `<pre>` `flex 1`）。overlay 全屏 、`rgba(30,25,20,0.45)` + `backdrop-filter blur(4px)`、居中 flex。
- **color**：modal 底 `var(--surface)`；树底 `var(--surface-2)`；`<pre>` 底 `var(--surface)`。twisty chevron 关闭 → 0deg，展开 `.open` → rotate 90deg。dir 图标 `folder`/`folderOpen`（`var(--gold)`），file 图标（`var(--muted)`）。树的具体尺寸/缩进/配色基线以 `common/component-file-tree.md` 为准（**行为与视觉平移前后一致**）。
- **双主题**：全 token；overlay 半透明 + blur 在双主题一致。dir gold / file muted token 双主题都有。
- **决策**：树一次性整树（API 返回 `SkillFileNode` 整树），文件内容按 path 懒取；默认所有 dir 展开（设计稿 `collectDirs` 预填）。树视图与纯函数提升到 `common/` 后，本组件从 322 行（曾违反 ≤300 硬约束）降至约 200 行——超限债随复用一并清掉。

## 消费方
- `app/web/src/components/skill-page/page-skill.tsx`
