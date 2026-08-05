# component-board-selector（看板关联字段 native 选择器 — 禁原生 select）

> 层级: component
> 文件: app/web/src/components/studio-page/component-board-selector.tsx

## 职责
- **选项 ≤4 且单选 且未传 `forceDropdown` → choice 卡**（可点卡片，选中 = accent 边框 + 浅底 + 勾）：复用  视觉。典型：priority（5 选项，归到下拉）、WorkStatus（5 态）。
- **选项 >4 / 多选 / `forceDropdown=true` → 自定义下拉**（popover + 列表 + 键盘导航）。典型：relatedKRId（同 squad KR 列表）/ source（同 squad Requirement，**强制下拉**）/ owner+assignee（同 squad member）/ dependsOn（同 Req 内 task，多选）。
- **禁原生 `<select>`**（`_conventions.md §10` 硬规则）——code-reviewer 出现 `<select` 或 `KeySelect` 直接 FAILED。
- 选项数据全部来自当前 squad board 响应（已 join 好），不另发请求。

## Props
- entity: 'goal' | 'kr' | 'req' | 'task'
- entityId: string
- field: 'relatedKRId' | 'owner' | 'assignee' | 'source' | 'priority' | 'depend...
- value: string | string[] | null
- options: SelectorOption[];  // 父组件（modal）从 board 数据预处理
- multiple?: boolean;         // dependsOn=true，其他单选
- nullable?: boolean;         // true 时置顶「（野生 / 无）」选项
- forceDropdown?: boolean
- onChange: (v: string | string[] | null) => void
- value: string;              // KR-0001 / R-0001 / member ulid / urgent|high|m...
- label: string;              // 渲染文案（含 KR title / Req title / member name）
- hint?: string;              // 副标（如 KR progress、Req 野生标记）

## 状态 / 交互
  - `forceDropdown === true` → 直接 false（强制走 Dropdown）
  - 其他（多选 / 选项 >4） → 自定义下拉
  - priority（5 选项）固定下拉（>4）；task.source（即使 ≤4 选项）固定下拉（`forceDropdown=true`，v0.0.76）
- **choice 卡**：点击切换 selected；selected 卡 `border-accent + bg-accent/8 + 勾 icon`。
- **自定义下拉**：点击 trigger 展开 popover（绝对定位 + z-index）；键盘 ↑↓ 导航 + Enter 选中 + Esc 关闭；外部点击关闭（`useEffect` 监听 mousedown）。
- **多选**：popover 内 checkbox 列表；已选项以 chip 形式回显 trigger 区（× 移除）。
- **环检测错误**：父组件（modal）PATCH 失败返 400 `dag_cycle` → toast「检测到循环依赖」+ 还原 dependsOn 本地值。

## 视觉基线
- **野生置顶项**：，label「（野生 / 不挂 KR）」。
- 字体沿用 Studio light token（`studio-styles.ts`）；不硬编码颜色。

## 复用关系
- **被组合**：`component-board-entity-modal`每个关联字段一个 selector 实例
