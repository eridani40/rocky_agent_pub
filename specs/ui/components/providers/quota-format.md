# quota-format

> 层级: 纯函数模块（无 UI / 无 hook / 无网络）
> 文件: app/web/src/components/providers/quota-format.ts（120 行）
> 引入版本: v0.0.352（footer v2 拆分，超 300 行门禁的产物）

## 职责
额度总览的时间/进度格式化纯函数集，被 component-coding-plans-quota-footer（QuotaTierBlock + 标题行 lastUpdated）与 chat 页额度弹层（component-quota-provider-card / use-squad-quota）消费。全部纯函数，UT 直测。

## 归一化口径（核心约定）
- `tier.usedPercent`：**0-100**（百分比数值）
- `computeTimeProgress` 返回：**0-1**（比例）
- 两口径**唯一比较点**在 isUsageFast 内显式换算：`usedPercent / 100 > timeProgress`（严格 `>`，相等不算偏快）

## 函数清单
| 函数 | 签名 | 语义 |
|---|---|---|
| formatResetTime | `(ts: number \| string, locales = navigator.language) => string` | `weekday:'short' + hour12:false` → 「周四 13:22」 |
| formatRemaining | `(resetsAt, nowMs) => string \| null` | diff≤0 → null；≥1 天「剩 X 天 Y 小时」；<24h「剩 X 小时 Y 分」 |
| computeTimeProgress | `(tier: QuotaTier, nowMs) => number \| null` | 无 resetsAt / 未知 window → null；elapsed≤0 → 0；≥duration → 1；否则线性 `elapsed / duration` |
| isUsageFast | `(usedPercent, timeProgress) => boolean` | `timeProgress !== null && usedPercent / 100 > timeProgress` |
| **formatSingleUnit** | **(resetsAt, nowMs, labels) => string** | **单单位四分支：≥1d→X天；≥1h→X小时；<60m→Xm；<1m→0min（labels i18n 驱动）** |
| **formatAmount** | **(n) => string** | **千分位 + 两位小数（9,118.81）** |
| **currencySymbol** | **(currency) => string** | **CNY→¥ / USD→$ / 其余原码+空格** |
| **hourHit** | **(hours?, now) => boolean** | **白名单小时命中；用 Intl hourCycle:'h23'（禁 hour12:false 防午夜 '24'）；唯一消费方 = use-squad-quota** |

内部 `windowDurationMs`（不导出）：`five_hour`→5h / `weekly`→7d / `daily`→24h / `monthly`→30d / 其他 → null。`start = resetsAt - duration`，`elapsed = now - start`。

## null 语义（不画时间柱不告警）
`computeTimeProgress` 返回 null（未知窗口 / 无 resetsAt）时：时间柱宽 0 + 数值「—」；`isUsageFast` 恒 false。已用柱照常渲染。

## 设计决策
- 剩余时间**分钟级静态文本**：渲染期 `Date.now()` 计算，不挂 30s tick（v1 倒计时走动已退役；v0.0.352 偏离②）
- 时间文案未走 i18n key：formatResetTime 走 `navigator.language` locale 感知；formatRemaining 中文字面量硬编码（v0.0.352 偏离③；change_plan D5 的 resetWeekdayHHMM/remaining* keys 未建）
- **formatSingleUnit 四分支文案走 i18n key**（`chat:quotaModal.singleUnitDay/Hour/Minute/Zero`），组件层用 `useTranslation('chat')` 传入 `SingleUnitLabels`，模块本身不硬编码中文
- **白名单小时的「文本展示」不在本模块**：唯一实现 = `component-hour-grid-picker` 的 `fmtHours`（picker footer/tooltip + plan-item-row tooltip + quota-provider-card 弹层 item 行三方同源 import；多段 `', '` 分隔 + 段末 exclusive 边界 24:00）。本模块只保留「命中判定」hourHit——曾自创的 min-max 拼区间版（多段并一段 + 段末差 1h）已删，杜绝第二套解读（states/v0.0.364/bug-analysis-tier-hour-range.md）
- **hourHit 用 Intl hourCycle:'h23'** 取本地小时（0-23），**禁 hour12:false**（en-US 午夜会输出 "24" 撞 0-23 白名单；change_plan D5 / intl-hour12-false-midnight-24-gotcha）

## 复用关系
- 被组合：component-coding-plans-quota-footer（独立 spec；消费 formatResetTime/formatRemaining/computeTimeProgress/isUsageFast）
- 被组合：component-quota-provider-card（消费 formatSingleUnit/formatAmount/currencySymbol）
- 被组合：use-squad-quota（消费 hourHit）
- 消费：无（纯函数模块）
