# component-skill-tabs

> 层级: component
> 文件: app/web/src/components/skill-page/component-skill-tabs.tsx

## 职责
Skill 页的 tab 栏容器。预埋多 tab 支持；实际启用两 tab「我的（manage）」+「市场（market）」。受控组件：由父 `page-skill` 下发 tab 列表 + active + onChange，不持有激活态。
边界：只管 tab 视觉 + 转发 onChange；不渲染 tab 对应内容区。
## Props
- id: string
- label: string
- tabs: SkillTabItem[];      // 传入 [{id:'manage', label:'Skill 管理'}]
- active: string;            // 当前激活 tab id
- onChange: (tabId: string) => void
- disabled?: string[]
- actionSlot?: React.ReactNode;  // [v0.0.198] 右槽位通用槽（ml-auto self-center）；page-skill 塞「+」按钮

## 状态 / 交互
- 点 tab → `onChange(tabId)`；只有 1 个 tab，不切换但保留交互能力（hover/active 视觉）
- 激活 tab：accent 文字色 + 底 2px accent 下划线
- 非激活：`var(--muted-2)` 文字，透明下划线
- actionSlot：[v0.0.198] 通用右槽，tabs 不关心槽内是何元素；不传时行为不变（既有渲染不动）。槽位在 flex 容器末尾 `ml-auto self-center`，槽内元素垂直居中、不继承 tab 底下划线

## 复用关系
- 被组合：`page-skill`
- 组合：无（纯展示）
- [v0.0.198] `page-skill` 通过 actionSlot 塞「+」安装按钮（token 配色 + expanded 时 rotate-45）

## 视觉基线
来源行段：`.skill-tabs` :80、`.skill-tab` :81、`.skill-tab.active` :82；DOM 结构 :421-423。
- **border**：每 tab 底 2px 下划线，默认 `transparent`；激活 `border-bottom 2px solid var(--accent)`。栏底线 1px。
- **双主题**：全 token，无特殊处理。
- **决策**：组件按多 tab props 实现，调用方 v0.0.21 仅传 1 项；视觉与设计稿单 tab 一致（栏底线 + 1 个激活项）。

## 消费方
- `app/web/src/components/skill-page/page-skill.tsx`
