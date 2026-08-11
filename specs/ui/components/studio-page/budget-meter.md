# budget-meter（团队 token 预算仪表 — consumed / remaining / limit / window）

> 文件: app/web/src/components/studio-page/component-budget-meter.tsx
> 数据源: 用量 `GET /budget/usage`（REST，`useLifecycle` GET-once + reload，**无 SSE**）；配置写由父级 AutoworkTab 统一 PATCH（v0.0.316 受控化）；`refreshKey` 父级触发即时 refetch。

## 职责
squad token 预算的**配置 + 实时仪表**二合一：
1. **配置**：预算 switch（off=不限量 / on=限量）——on 时配总量 limit（默认 1_000_000 token/天）。
2. **仪表**：实时显示当前 daily 窗口消耗——已耗（consumed）/ 上限（limit）/ 剩余（remaining）/ 窗口回血时刻（windowEnd）+ 进度条。**reactive + proactive 都计入 consumed**（consumption always-on；budget gate 仅 proactive）。

> **[v0.0.316] 受控化**：配置区从「自管 budgetOn/limitInput/savePending + onSaveBudget PATCH」改为「受控 + onChange 上报」。budgetOn 从 useState 改为派生 `budget != null`；toggle off → `onChange(null)`；toggle on → `onChange(默认值)`；limit 变 → `onChange(更新 limit)`；去掉 save 按钮 + savePending。usage 展示（useLifecycle 轮询）不变。

边界：
- **budget switch off=不限量**（写 `budget=null`）：现有 `null → gate 放行` 语义天然对齐 req「off=不限量」，显示「无预算限制」态（limit=-1，consumed 仍算显示）。
- **配置区仅当 onChange 提供时显示**（v0.0.316：可选受控 prop）。

## Props
```ts
interface BudgetMeterProps {
  squadId: string;
  /** 当前 budget 配置（受控：来自父级 AutoworkTab draft；null=不限量） */
  budget?: { limit: number; window: 'daily'; scope: 'team' } | null;
  /** 上报变更（toggle/limit 改动）→ 父级 dirty（不再自管 PATCH） */
  onChange?: (budget: { limit: number; window: 'daily'; scope: 'team' } | null) => void;
  /** 父级触发即时刷新（如 reactive 对话发出后） */
  refreshKey?: string;
}
```

## 状态 / 交互
- **预算配置**（受控）：
  - `budgetOn` 派生 `budget != null`（非 useState）。
  - `limitValue` 派生 `budget?.limit ?? DEFAULT_LIMIT`（非独立 useState）。
  - toggle off → `onChange(null)`；toggle on → `onChange({ limit: limitValue, window:'daily', scope:'team' })`。
  - limit 变 → `onChange({ limit: parseInt(val), window:'daily', scope:'team' })`。
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
