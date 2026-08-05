# component-channel-type-dropdown

> 层级：component
> 文件：app/web/src/components/channel-page/component-channel-type-dropdown.tsx

## 职责
渠道类型单选自定义下拉。落实 `specs/ui/components/_conventions.md §10`（单选禁原生 `<select>` 硬规则）——用 trigger button + popover listbox 替代原生 select，统一视觉、支持键盘导航与外部点击关闭。
边界：**只单选、无 nullable（必选一项）、无多选 chip**。比 `component-board-selector-dropdown` 更简单（后者多选+nullable+环检测）。不适配其他多选/可空场景——那些走各自的专属组件。

## Props
- value: string;   // implId（如 feishu）
- label: string;   // 展示名（如「飞书」）
- testidRoot: string;            // trigger 的 data-testid（如 "channel-form-impl"）
- value: string;                 // 当前选中 value（必存在 options 中，或回退显 value 原文）
- options: Option[]
- onChange: (v: string) => void; // 选中某项 → 回调父级，组件内自动关 popover
- disabled?: boolean;            // 锁定（编辑态 implId 不可改）

## 状态与交互
- `open`（popover 显隐）+ `activeIdx`（键盘高亮项索引，初值 0）
- **trigger button**：显示当前选中 label + ▾；点击 toggle popover；`disabled` 时禁用点击与键盘展开
- **popover**（`role="listbox"`）：列选项按钮（`role="option"` + `aria-selected`），选中项前显 ✓
- **键盘导航**（trigger 或 popover 内按键）：
  - 展开态：`↑`/`↓` 移动 activeIdx；`Enter` 选中并关闭；`Esc` 关闭
- **外部点击关闭**：`useEffect` 挂 `document.mousedown`，点击根 ref 外部 → 关闭（仅 open 时挂载，卸载时摘监听）
- **hover 同步 activeIdx**：鼠标移到某项 → setActiveIdx（让键盘后续 Enter 与鼠标 hover 一致）

## 复用关系
- 仿（不依赖）：`component-board-selector-dropdown`（同构 trigger+popover+键盘，但本组件只单选无 chip
- 被组合于：`section-channel-form`（类型选择字段）

## 视觉基线
对齐渠道表单其它 input（border / rounded-md / px-[12px] py-[8px] / text-[13px]）。popover 绝对定位脱离文档流，不挤压下方字段（§11 尺寸稳定性）。
