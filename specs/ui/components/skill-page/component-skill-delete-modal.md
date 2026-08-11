# component-skill-delete-modal

> 层级: component
> 文件: app/web/src/components/skill-page/component-skill-delete-modal.tsx

## 职责
Skill 删除确认 modal。展示「删除 Skill」标题 + 确认文案（含 skill name + 「此操作无法撤销」警告）+ 两按钮（取消 / 确认删除 danger）。确认后触发**物理删除**（不可撤销）。
## Props
- skill: SkillItem;       // {id, name, ...}
- onCancel: () => void
- onConfirm: (id: string) => void;   // page → 后端 DELETE → 关闭 + 刷新

## 状态 / 交互
- 点 overlay / 取消 / 关闭按钮 → `onCancel`
- 点「确认删除」→ `onConfirm(skill.id)`
- 删除进行中可禁用按钮（可选，page 持有 deleting 态时传入 disabled）

## 复用关系
- 被组合：`page-skill`
- 组合：无（图标内联 SVG `close`）

## 视觉基线
- **layout**：overlay 全屏 、`rgba(30,25,20,0.4)` + `backdrop-filter blur(4px)`、`z-index 200`、居中 flex。modal 宽 420px（`max-width 90vw`），，纵向：header `padding 20px 24px 12px`（flex 两端：title 左 / close 右）+ body `padding 0 24px 20px` + footer `padding 16px 24px` + 顶分隔线（flex 右对齐 `gap 8px`）。
- **font**：title 16px/700 `var(--fg)`。body 13px `var(--muted-2)`，其中 skill name 用 `<strong>` `color var(--fg)` 强调。按钮 12px/600（`.btn` 通用）。
- **双主题**：全 token；danger/danger-light token 双主题都有（:17,:25）。overlay 半透明 + blur 双主题一致。
- **文案**：title「删除 Skill」；body「确定要删除 **{name}** 吗？该 Skill 将不再可用，此操作无法撤销。」；按钮「取消」/「确认删除」。

## 消费方
- `app/web/src/components/skill-page/page-skill.tsx`
