# component-file-tree（通用文件树）

> 层级: component
> 文件: app/web/src/components/common/component-file-tree.tsx（纯函数 `common/file-tree.ts`）

## 职责
递归渲染文件树：dir 可折叠（twisty + folder/folderOpen 图标），file 可选中（file 图标 + active 高亮）。纯结构组件——不含任何 i18n 文案、不持状态、不发请求。

边界：不管空态文案（调用方渲染）、不管右侧内容面板（各页自持，见「复用关系」的决策）、不管数据获取。

## Props
```ts
interface Props {
  /** 顶层节点数组（一般传 buildFileTree(...).children） */
  nodes: SkillFileTreeNode[];
  /** dir 展开态（path → true） */
  expanded: Record<string, boolean>;
  /** 当前选中的 file path */
  selPath: string | null;
  onToggleExpand: (path: string) => void;
  onSelect: (path: string) => void;
}
```

配套纯函数（`common/file-tree.ts`，可单测）：

| 函数 | 语义 |
|---|---|
| `buildFileTree(flat: FlatFileNode[]) → SkillFileTreeNode` | 后端**扁平数组**（每项含相对 path）→ 嵌套树；同层 dir 在前、file 在后，各自 name 字母序（不区分大小写）；输入可乱序（父目录可后到）；空数组 → 空 children 虚拟根 |
| `findFirstFilePath(root) → string \| null` | 深度优先首个 file 的 path（默认选中项）；无文件 → null |
| `collectDirPaths(root) → Record<string, boolean>` | 全部 dir 的 path（默认全展开的初始 expanded） |

`FlatFileNode = { name; path; type: 'file' \| 'dir'; size? }` 为结构性契约，与 `06-skill §6.2 SkillFileNode`、academy 的 `AcademySkillFileNode`（多 `hash`）均兼容——common 层不绑定具体域类型。

## 状态 / 交互
- **dir 行**：`role="treeitem"` + `aria-expanded`；点击 → `onToggleExpand(path)`；展开时 twisty 旋转 90°、图标切 folderOpen。
- **file 行**：`role="button"`；点击 → `onSelect(path)`；`selPath === path` 时 accent 高亮（背景 `bg-accent-surface` + 文字 accent）。
- 无可见文案（节点文本 = 文件/目录名本身，E2E 按文件名定位）。
- 展开态与选中态由调用方持有 → 弹层重开可决定是否重置。

## 复用关系
- 被组合：`skill-page/component-skill-preview-modal`（skill 预览左树）、`academy-page/component-skill-browser-modal`（版本 skill 浏览左树，两级树的下层）。
- 组合：无（4 个树图标 chevron/folder/folderOpen/file 内联 svg 在本文件内；各页专属图标如 skill 星形/关闭留在各自弹层）。
- **进 common 的理由**（`_conventions.md §2`「跨 ≥2 页复用才进 common」）：skill 管理页与 academy 学生详情两个板块都要渲染「扁平 path 数组 → 嵌套树」，视觉与交互一致；**右侧内容面板不共享**（skill 页恒 `<pre>`，academy 按扩展名分渲染 + 可编辑，i18n ns 也不同——合并需塞 3 个开关 prop，比两份小面板更差）。

## 视觉基线
- 设计稿来源：`reqs/v0.0.21/easy-opc-skill-v10.html` 的 `.pv-item/.pv-twisty/.pv-ico/.pv-name`（:106-126）。
- 尺寸：行高 26px；右 padding 8px；缩进 = dir `6 + depth*14`px、file 再 +14px；twisty 14×14；dir/file 图标 13×13；chevron 10×10。
- 字体：节点名 12.5px，单行省略（`text-ellipsis`）。
- 边框：无边框，行 `rounded-md`。
- 配色：dir 图标 `text-gold`；file 图标 `text-muted`；节点名 `text-fg-2`，active 为 `text-accent` + `bg-accent-surface`；hover `bg-bg-warm`。
