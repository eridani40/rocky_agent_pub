# component-cron-freq-picker（cron 频率选择器）

> 层级: component
> 文件: app/web/src/components/chat-page/component-cron-freq-picker.tsx
> 本文是 cron 频率选择器的**概念权威源**：4 预设 + 高级折叠 + cron expr 程序生成 + 实时预览。

## 1. 定位 + 设计意图
让用户用**人话选择**频率（不直接写 cron expr），程序生成对应 5 字段 cron expr。覆盖 90% 场景的 4 个预设；剩下高级用户走折叠的「自定义 cron」raw 输入。**展示态用 cronstrue 翻译反向校验**（实时预览人话）。
**核心约束（PRD §5）**：raw cron expr 不直接暴露给普通用户路径——只在此组件的「高级」折叠区可见。

## 3. 状态 / 交互
- **切 preset chip** → 重算 cron expr → `onChange(newExpr)`
- **改 interval/time/weekday 输入** → 重算 cron expr → `onChange`
- **切到 advanced** → 把当前 cron expr 填入 raw input（用户可自由编辑）
- **advanced raw input 变化** → 直接 `onChange(rawStr)` ## 5. 视觉基线（无权威设计稿；按 demo HTML + 现有 chip / btn token）
- **chips**：12px mono；padding 2px 8px；border 1px var(--border) 圆角 999px；hover border+text var(--accent)；active bg var(--accent-surface) + color var(--accent) + 600 字重。
- **input**：border 1px var(--border) 圆角 6px padding 7px 9px；focus border var(--accent)。
- **time input**：等宽 mono；80px 宽。
- **advanced details**：上边框 1px dashed var(--border)；summary 12px var(--text-2)。

## 复用关系
- 被组合：`section-cron-panel`（新建表单内嵌）+ 可能 `component-cron-job-card` 编辑模式（本版本只新建用，编辑
- 组合：调 `cron-humanize.ts`（实时预览翻译）
