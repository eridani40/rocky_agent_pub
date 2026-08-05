# budget-meter（团队 token 预算仪表 — consumed / remaining / limit / window）

> 文件: app/web/src/components/studio-page/component-budget-meter.tsx
> 数据源: 用量 `GET /budget/usage`（REST，`useLifecycle` GET-once + reload，**无 SSE**）+ 配置写 `PATCH /squad { budget }`（off→null / on→{limit,window:'daily',scope:'team'}）；`refreshKey` 父级触发即时 refetch。

## 职责
squad token 预算的**配置 + 实时仪表**二合一：
1. **配置**：预算 switch（off=不限量 / on=限量）——on 时配总量 limit（默认 1_000_000 token/天），写 `PATCH /squad budget`。
2. **仪表**：实时显示当前 daily 窗口消耗——已耗（consumed）/ 上限（limit）/ 剩余（remaining）/ 窗口回血时刻（windowEnd）+ 进度条。**reactive + proactive 都计入 consumed**（consumption always-on；budget gate 仅 proactive）。
边界：
- **budget switch off=不限量**（写 `budget=null`）：现有 `null → gate 放行` 语义天然对齐 req「off=不限量」，显示「无预算限制」态（limit=-1，consumed 仍算显示）。

## Props
- squadId: string
- budget: { limit: number; window: "daily"; scope: "team" } | null;  // 当前配置（sw...
- onSaveBudget: (budget: { limit: number; window: "daily"; scope: "team" } | nu...
- refreshKey?: string;  // 父级触发即时刷新（如 reactive 对话发出后）

## 状态 / 交互
- **预算配置**：
  - `budget-switch`（toggle-switch primitive）：off=不限量（`budget=null`）/ on=限量。切 on → 展开 limit 输入（默认 1_000_000）；切 off → `onSaveBudget(null)`。
  - **布局稳定**（`_conventions §11`）：off↔on 切换 limit 输入出现/收起不得挤动下方仪表——预留高度/过渡。
- **渲染**（仪表）：
  - `consumed` 数字（横向 Σ team sessions 当窗口 total_tokens）。
  - `limit` 数字（squad.budget.limit；未配 → 显示「无预算限制」label）。
  - `windowEnd` 回血时刻（次日 squad.timezone 0 点，按本地 tz 格式化显示倒计时或绝对时刻）。
  - `budget-bar` 进度条（consumed/limit 比例，>80% gold 警示，>100% accent 超限）。

## 视觉基线
> 本版本无设计稿（PRD §3 note），按既有 Studio 视觉对齐。
- 进度条： 槽 +  填充；>80%  警示；>100% 满溢  + 震动/TBD 动效。
- windowEnd 倒计时 （如「23:14 后回血」）。

## 复用关系
- **被组合**：**`component-autowork-tab`**（squad-panel「自动工作」tab 容器；自主性归位——与 squad-au
- **可复用**：可同时嵌入 squad 概览头部（summary 态），TBD coder 决策。
