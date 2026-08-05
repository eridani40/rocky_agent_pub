# component-member-skill-filter

> 层级: component
> 文件: app/web/src/components/studio-page/component-member-skill-filter.tsx

## 职责
成员编辑面板「skills」section 在 `custom` 模式下展开的**简化版 skill 可见性筛选器**——一个纯「enable/disable 开关列表 + 顶部搜索」，不是 skill 资产管理器。
拉全局 skill catalog（`listSkills`），排除 `scope==='workspace'`（workspace 层恒对成员生效、不受局部快照治理，故不展示），把余下 builtin/app 层每个 skill 渲染为一行 `name + description(省略) + ToggleSwitch`。每行开关的**显示态 = 叠加后当前效果**。toggle 翻转上抛父级更新 overrides。拉到的 catalog 经 `onCatalog` 上抛父级（供保存时 R5 全量补齐快照）。
边界：**只做可见性 enable/disable + 搜索**——无 skill 详情预览 / 安装 drop-zone / 删除 / evolvable 治理开关（相对全局 skill 页 `page-skill` 全部去掉）。不持久化（父级负责 PATCH）。

## Props
- name: string
- description: string
- enabled: boolean
- open: boolean
- overrides: Record<string, boolean>
- onToggle: (name: string, next: boolean) => void
- onCatalog?: (entries: SkillFilterEntry[]) => void

## 状态 / 交互
- **自适应 + 可折叠组件（显式声明，_conventions §11 例外）**：随 skill 条数变高；`open` 控制展开/收起用 `grid-template-rows: 0fr↔1fr` +  子容器做高度过渡动画。**禁 `display:none`**——收起态高度过渡到 0（getBoundingClientRect.height≈0），展开态高度=内容。这样切换不使相邻 section（心跳）跳动，只平滑推移（R4 / member-panel A-7）。
- catalog 走 `listSkills` 一次性拉取（挂载即拉，缓存本地 entries）；`scope==='workspace'` 排除；按 name 排序。拉取失败/空 → 列表空（不阻塞面板）。
- 顶部搜索框按 name 子串过滤（大小写不敏感）；skill 多时用，不改 overrides。

## 视觉基线
每行**对齐全局 skill 页 `component-skill-item` 的设计语言**（req「和 skills 页面配置类似，但可以简化」），保持视觉一致：
- **启用 label + toggle（新增 label）**：右侧  内 —— 文字标签「启用」（，i18n 复用 skill ns `t('item.enableLabel')`）+ ToggleSwitch。对齐 skill-item 的 label+toggle 模式。
- **搜索框**：保留，复用 `studio-styles.INPUT`。
- **简化掉的 skill 资产管理元素**（相对 skill-item 删除）：preview 按钮、delete 按钮、evolvable（自进化）toggle、状态 badge——成员可见性筛选器不需要。
