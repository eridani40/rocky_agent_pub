# component-derive-academy-preview-panel（继承预览面板 · 纯展示子组件）

> 层级: component
> 文件: app/web/src/components/academy-page/component-derive-academy-preview-panel.tsx
> [v0.0.233] 新增——从 `component-derive-academy-picker` 拆出（保 picker ≤300 行）。纯展示，无自有数据生命周期；由 picker 透传 PreviewResult + 同名 toggle 状态。

## 职责
渲染 derive_academy 派生前的「将带入」清单（PreviewResult 分组 AGENTS.md / skills / memory + 同名 amber 标 + 覆盖 toggle）。

边界：不拉数据（picker 通过 useDeriveAcademyPreview 拉好透传）；不产 resolution（picker 持 toggle 状态 + build resolution）；只渲清单 + 上抛 toggle 翻转。

## Props
```ts
interface Props {
  data: PreviewResult;                       // 11a §2.5 schema
  /** 同名项 toggle 状态（key = `${kind}:${name}`，kind='skill'|'memory'）；true=overwrite */
  toggles: Record<string, boolean>;
  /** toggle 翻转（key 同上）；不同名项不渲染 toggle 故不会触发 */
  onToggle: (key: string) => void;
}
```

## 状态 / 交互（可见文案 = E2E 定位契约）
- **preview-summary**（顶部一行 11px/600）：「将带入 X 项 · 其中 Y 项同名默认保留原 squad」（X = agentsMd.exists?1:0 + skills.length + memory.length；Y = skills/memory sameNameConflict=true 计数）。
- **group-agents**（仅 agentsMd.exists 为 true 渲染）：1 行「AGENTS.md」+ status-badge sage「将带入」（无同名开关）。
- **group-skills**（skills.length > 0 才渲染）：group label「SKILLS」+ skills 项行。
- **group-memory**（memory.length > 0 才渲染）：group label「MEMORY」+ memory 项行。
- **项行**：name + status-badge（!sameNameConflict = sage「新增」/ sameNameConflict = amber「同名 · 保留原 squad」）+ 仅 sameNameConflict 项右侧覆盖 toggle（默认 off = skip；on = overwrite）。toggle 复用 `framework/primitives/toggle-switch`（aria-label「覆盖 {name}」+ action-key `academy.derive.toggle-overwrite`）。
- **固定槽位不位移**：每行右侧预留 toggle 槽位（不同名项 invisible 占位，而非不渲染）——toggle 出现/消失不影响相邻项位置（对齐 _conventions §11）。

## 复用关系
- 被 `component-derive-academy-picker` 在 preview ready 时嵌入（select-cols 与 derive-foot 之间）。
- 复用 `framework/primitives/toggle-switch`（同名覆盖开关）。

## 视觉基线
- 设计稿来源：无（v0.0.233 新增，coder 编码前置定，遵循 `_conventions.md §9`）；对齐 derive-panel 容器风格 + status-badge 现有风格 + toggle 复用 primitive。
- 尺寸：preview-summary p-11/14（同 copy-note 内边距）；group label 行 px-14 pt-12 pb-6；项行 px-14 py-9 + `rounded-lg`（与 pick-item 一致）。
- 字体：preview-summary 11px/600 fg-2（同 sel-label 字号但不大写）；group label 11px/600/uppercase muted-2（与 sel-label 一致）；项名 13px/500 fg；status-badge 11px/500。
- 边框：preview-summary 顶部 bottom border 分隔 select-cols；group 之间无额外 divider（靠 group label + padding 自然分隔）；项行 hover bg-bg-warm（同 pick-item hover）。
- 配色：status-badge sage（bg-sage-bg text-sage）=「新增」/「将带入」；amber（bg-gold-bg text-[#b45309]）=「同名 · 保留原 squad」；toggle off 灰 / on accent（沿用 primitive-toggle-switch 配色）；不同名项 toggle 槽位 invisible 透明占位。
