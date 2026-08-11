# component-skill-browser-modal（版本 Skills 浏览/编辑弹层）

> 层级: component
> 文件: app/web/src/components/academy-page/component-skill-browser-modal.tsx（纯函数 `academy-page/skill-file-view.ts`）

## 职责
学生某版本的 Skills 浏览弹层：左侧**两级目录树**（skill 目录 → 目录内文件/子目录）+ 右侧按文件类型分渲染的内容面板；formal 版本可编辑并保存单文件，process 版本全程只读。

边界：不管数据获取（`onFetchFile` / `onSaveFile` 由 page 注入，走 `18-academy §1.11` 端点）、不管 skill 的增删（本版无对应写权限面）、**不触发也不复用 md 编辑器**（`component-modal-md-editor`）——skill 是「目录 + 文件」，塞进 md 编辑器会经 `saveKind='agentsMd'` 覆盖 AGENTS.md（历史数据丢失形态，已按构造消除）。

## Props
```ts
interface Props {
  open: boolean;
  /** 版本内 skill 列表（目录 + 文件树，来自 GET .../version/:vid 的 content.skills） */
  skills: SkillSummary[];
  studentName: string;
  /** 展示用版本号（如 'v2.0'） */
  versionLabel: string;
  /** process 版本只读 → 不渲染编辑/保存 */
  readOnly?: boolean;
  /** 按 skill 名 + 相对 skill 目录的 path 懒取内容 */
  onFetchFile: (skillName: string, path: string) => Promise<VersionSkillFileContent>;
  /** 保存单文件（readOnly 时父级不传） */
  onSaveFile?: (args: { skillName: string; path: string; content: string }) => Promise<void>;
  onClose: () => void;
}
```

配套纯函数（`skill-file-view.ts`）：`classifySkillFile(path) → 'markdown' | 'text' | 'unknown'`（`.md/.markdown` → markdown；`.py/.sh/.yaml/.yml/.json/.txt/.ts/.js/.toml/.ini/.csv` → text；其余含无扩展名 → unknown）、`buildSkillsTree(skills)`（两级树，子节点 path 加 `<skill>/` 前缀保证跨 skill 唯一）、`splitSkillSelection(sel)`（`<skill>/<relPath>` 反解）、`stripMarkdownFrontmatter(source)`（**仅 markdown 分支调用**，见下「frontmatter 处理契约」）。

## 状态 / 交互
- **左树**：顶层 = 每个 skill 一个目录节点（顺序 = 后端 name asc），其下 = `buildFileTree(skill.files)` 的嵌套结果。默认全部 dir 展开、默认选中深度优先首个文件。空 skills → 「该版本还没有 skill」。
- **右侧（view 模式）**按类别渲染：
  | 条件 | 呈现 |
  |---|---|
  | 取内容中 | 「读取中…」 |
  | 取内容失败 | 「读取失败」（降级为提示，不整页报错） |
  | 后端 `binary=true` | 「二进制文件，不可预览」（binary **只信后端标记**，不做前端嗅探） |
  | `classifySkillFile` = unknown | 「该文件类型不支持预览」 |
  | markdown | `PrimitiveMarkdownView` 渲染（先剥离 frontmatter，见下） |
  | text | mono `<pre>` 原文 |
  | `truncated=true` | 正文后追加「（内容过长已截断，仅显示前 256KB）」 |
- **编辑（仅 formal）**：可编辑条件 = `!readOnly` 且已取到文本内容（binary / unknown / 读失败一律无编辑面）。head 「👁 查看 / ✏️ 编辑」二段 toggle；edit 模式为 mono textarea；foot 「保存」仅 edit 模式渲染 → `onSaveFile({skillName,path,content})`，成功后回 view 模式并显「已保存」，失败显错误消息（含后端 `binary_not_writable` / `invalid_input` / 404 / 409 的报错文本）。
- **readOnly（process 版本）**：无 toggle、无保存按钮，foot 显「过程版本只读，不可编辑」。
- 切换选中文件 → 回到 view 模式 + 清保存提示 + 重新懒取内容（`onFetchFile` 身份不稳定，组件内用 ref 固定，effect 只依赖选中项）。
- 关闭路径：head ✕ / foot「关闭」/ 点遮罩 / ESC。
- **可见文案**（E2E 定位契约）：「🧩 Skills · {学生名}」/ 「{版本} · .rocky/skills/ · N 个 skill · M 个文件」/ 「该版本还没有 skill」/ 「从左侧选择一个文件查看」/ 「读取中…」/ 「读取失败」/ 「二进制文件，不可预览」/ 「该文件类型不支持预览」/ 「（内容过长已截断，仅显示前 256KB）」/ 「👁 查看」/ 「✏️ 编辑」/ 「保存」/ 「保存中…」/ 「已保存」/ 「保存失败」/ 「过程版本只读，不可编辑」/ 「关闭」（i18n ns=`academy` 的 `skillBrowser.*`）。

### frontmatter 处理契约（md 分支专属）
`SKILL.md` 开头的 YAML frontmatter 是**元信息，不是正文**——md 分支渲染前必须经 `stripMarkdownFrontmatter` 剥离，否则最小 markdown 渲染器会把它当普通段落输出成一坨 `--- name: … description: … ---` 文本。
- **只剥离、不另展示**（对齐项目既有惯例）：frontmatter 的结构化消费权在后端——`skills/resolver.ts parseSkillDir` 用 gray-matter 解析出 `name` / `description` 并经 `SkillSummary` 下发；前端**不解析 YAML、不另造元信息卡**（web 侧零 frontmatter 解析实现，避免第三套模式）。skill 名已由左树节点呈现。
- **剥离规则**（与 gray-matter 分隔符语义对齐）：首行（忽略 BOM）为 `---` 且后续存在单独成行的 `---` 时，取闭合行之后的内容并去掉其前导空行；**首行非 `---`、或有起始无闭合 → 原样返回**（宁可不剥离也不吞正文）；正文中间的 `---` 永不被当分隔符。仅有 frontmatter 无正文 → 正文区空白。
- **只作用于 md 分支**：`text`（`.py/.yaml/.json/…`）与 `unknown` 分支**必须原样保留全部字符**（含 `---`、缩进、空行）——yaml 里的 `---` 是文档内容而非元信息。
- **编辑态 textarea 恒为文件原文（含 frontmatter）**：剥离只发生在 view 渲染路径，`onSaveFile` 提交的 content 不会丢元信息。

### data-action-key（`_conventions.md §12`）
| 元素 | key |
|---|---|
| head ✕ 关闭 | `academy.version.close-skill-browser` |
| 「✏️ 编辑」切换 | `academy.version.edit-skill-file` |
| 「保存」 | `academy.version.save-skill-file` |

### L3 modal 不变式（`_conventions.md §13`，硬规则）
走 `<Portal>`，且 Portal 根节点 className **必须显式含 `pointer-events-auto`**——overlay-root 容器为 `pointer-events:none` 且该属性可继承，漏写则整棵子树不接事件（所有按钮 click 全穿透，仅 ESC 可关）。UT 直接断 className（jsdom 无 hit-testing，click 断言抓不到）。

## 复用关系
- 被组合：`page-academy`（顶层挂载，state 归 page；由 `section-student-detail` → `component-tuple-cards` Skills 卡「查看」上抛 `SkillBrowserTarget` 打开）。
- 组合：`common/component-file-tree` + `common/file-tree`（左树）、`common/primitive-markdown-view`（md 渲染）、`lib/portal`、`academy-styles`（按钮/图标按钮样式）。
- 数据通道：`lib/academy-api` 的 `getVersionSkillFile` / `saveVersionSkillFile`（`18-academy §1.11`）——**不走** `/skill/:name/tree|file`（该域会回落 app/builtin 且需明文传 workspaceDir 绝对路径）。

## 视觉基线
- 与 skill 预览弹层同尺寸族：modal `820px`（max 94vw）× `560px`（max 88vh）、`rounded-xl` + `shadow-lg`；遮罩 `rgba(10,10,10,.4)`。
- 结构：head（title 13.5px/600 + sub 11px mono muted + toggle + ✕，底 border）→ body（左树 250px + 右 `flex-1`，左树 `bg-surface-2` + 右分隔 border）→ foot（提示 + 关闭 + 保存，顶 border）。
- 字体：markdown 13.5px/1.75；`<pre>` 与 textarea mono 12px/1.6；文件路径条 11px mono muted。
- 配色：toggle 激活 `bg-accent` + 白字；保存 `BTN_PRIMARY`；关闭 `BTN_SECONDARY`。

## 消费方

- `app/web/src/components/academy-page/component-academy-modals.tsx`
