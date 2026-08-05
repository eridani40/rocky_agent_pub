# section-skill-list

> 层级: section
> 文件: app/web/src/components/skill-page/section-skill-list.tsx

## 职责
Skill 列表区块容器。两种态：(1) 空态——skills 为空时渲染空态占位「还没有已安装的 Skill」；(2) 列表态——纵向排列多个 `component-skill-item` 卡片，`gap 8px`。
边界：只管列表布局 + 空态判断；单卡交互下沉到 `component-skill-item`。

## Props
- skills: SkillItem[];   // 来自后端 skill API list
- onToggle: (id: string) => void
- onPreview: (skill: SkillItem) => void
- onDelete: (skill: SkillItem) => void

## 状态 / 交互
- `skills.length === 0` → 渲染 `.skill-empty` 空态（虚框 + mono 文案）
- 否则 `skills.map` → `component-skill-item`（key=skill.id）
- loading 态由父级决定（page 可在 section 外包 loading 占位，本 section 不持有 loading）

## 复用关系
- 被组合：`page-skill`
- 组合：`component-skill-item`（多卡）

## 视觉基线
来源行段：`.skill-list` :95、`.skill-empty` :103；DOM :440-456。
- **font**：列表本身无字体；空态 13px `JetBrains Mono` `var(--muted)`。
- **border**：列表无外框；空态 `1px dashed var(--border)`。
- **color**：空态文字 `var(--muted)`。
