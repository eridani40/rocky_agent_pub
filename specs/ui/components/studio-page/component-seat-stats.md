# component-seat-stats

> 层级: component
> 文件: app/web/src/components/studio-page/component-seat-stats.tsx

## 职责
4 格统计：**2×2 无缝格**（C 指挥台左列中卡）= 成员在线（在线/总数）/ 进行中任务 / 今日消息 / 已用 token。每格 = 数字（18px 700）+ label（11px muted）纵向紧凑排列，**无图标**。**不可得字段（null）→ 数字位显「—」弱化色不隐藏整格**（占位稳定，避免布局跳动）。
边界：纯展示；数据全由 `use-seats-data` 派生传入；不 fetch。

## Props
- onlineCount: number;             // deployed 数
- totalCount: number;              // detail.members 总数
- inProgressCount: number;         // stateMap running/interrupting/suspended c...
- todayMsgCount: number | null;    // 后端无 per-day 聚合 → 恒 null（降级「—」）
- tokenUsed: number | null;        // budget.consumed；未配 budget→null

## 状态 / 交互
- 每格白底
- token 大数格式化：≥1000 → `k` 缩写（`22.5k`），mono font（语义/formatCount 不变）

## 视觉基线
- 数字：Inter 18px/700 fg leading-none；「—」降级
- label：Inter 11px muted，margin-top 4px（mt-1）
- 无 hex 硬编码；无图标/无 hue

## 消费方

无（零引用，疑似死代码）。
