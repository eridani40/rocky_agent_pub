# component-usage-panel

> 层级: component（挂于 `chat-page` topbar 右侧）
> 视觉契约: `reqs/v0.0.16/mqnbr367-easy-opc-chat-v9a.html` §143-258（usage / topbar-right / usage-ring / usage-panel / ctx-stack / ctx-legend / cum-table）
> 本文是 usage-panel 的概念权威源：定义子组件构成、数据契约、三态交互、视觉基线、按钮状态绑定。PRD/编码对齐本文。
> 数据源: `usage` prop（纯展示）。父级 `useUsage` area-hook 提供：`onInit GET /session/:id/usage` 拉基线 + `subscribe(session_panel)` 收 `session_usage_update` 全量 replace。

## 消费方

- `components/chat-page/component-chat-topbar-right.tsx`
- `components/chat-page/section-chat-session.tsx`

## 0. 设计意图（一句话）
topbar 右侧一个紧凑的 token 用量圆环 + 「已用/总」（如 23k/200k）+ 一个展开按钮 + compact 按钮 + clear 按钮；点展开弹出完整面板（context window 进度条 3 分段 + 累积消耗表格三分区行）；compact 按钮状态绑定 summaryTask，clear 按钮 hover danger 色 + 确认 modal。

## 3. 三态交互
### 3.1 收起态（默认）
- 显示：`UsageRing`（28×28，stroke 4）+ 「已用/总」（k 单位，如 `23k/200k`）+ `UsageExpandBtn`（chevron）。
- hover trigger（非 open 时）→ 显示 `UsageTip`（tooltip）：标题「累积消耗」+ 简表（最简实现：仅展示 total 合计 input/output/cache；行项文案 v0.0.16 不强制）。
- hover bg `var(--bg-warm)`，圆角 8px（CSS §151-152）。
### 3.2 展开态（`.open`）
- 点 `UsageExpandBtn` → `.usage.open` → `UsagePanel` 浮出，opacity 1 + translateY 0）。
- chevron 旋转 180°（CSS §159）。
- 点 panel 内部不关闭（`onClick={e => e.stopPropagation}`）；点 panel 外部（document mousedown）→ 关闭。

## 视觉基线
### 4.2 UsageRing（SVG，CSS §550-561）
| 维度 | 值 |
|---|---|
| size | 收起 28×28 stroke 4 / 展开大号 52×52 stroke 6 |
