# component-quota-provider-card

> 层级: component
> 文件: app/web/src/components/chat-page/component-quota-provider-card.tsx（255 行）
> 引入版本: v0.0.356

## 职责
双态 provider 卡：收起窄卡（双档双环速览）↔ 展开替换层（详情）。点击卡片任意处 toggle，卡间独立（非手风琴）。

## Props
- `card: CardVM` — 由 `useSquadQuota` 组合好的视图模型（providerId / providerLabel / implId / model / baseUrl / status / items / tiers / balance）
- `now: number` — 当前毫秒时间戳（父级 `Date.now()` 或 tick 驱动）

## 收起态窄卡
- 状态点 + 头像（首字母色块）+ provider name / model 两行 + 双档双环（左右排列、环上字下）+ chevron
- 左环 = 用量百分比；右环 = 剩余重置时间（`formatSingleUnit`，单单位四分支）
- fast 时环与数字琥珀；余额型无环直接金额 + `chat:quotaModal.tierBalance`；无周限额只显 five_hour 一档

## 展开态替换层
- 卡头：状态点 + 头像 + 主标题（provider + model mono 徽标）+ 副标题（套餐名/余额徽标）+ baseUrl mono 行
- item 行：状态点 + 模型名 + 时间条件 + 状态词；熔断时倒计时 `chat:quotaModal.retryIn`；half-open 时 `chat:quotaModal.halfProbing`
- 时间条件文本：`fmtHours(card.hours ?? [])`（引用 `../app-dev-config-page/component-hour-grid-picker` 同一份实现——多段 `', '` 分隔 + 段末 exclusive 边界 24:00，如「00:00-14:00, 18:00-24:00」）；空数组/缺省返回 `''`（falsy）→ 走 `chat:quotaModal.timeAny`（不限时），分支零特判
- 额度详情：额度型复用 `TierBars`（`component-coding-plans-quota-footer.md` 导出）；余额型大字金额无柱

## 状态点合并规则
一 provider 多 item 时按最劣优先：熔断(红) > 观察中(橙) > 工作中(绿) > 不在时间内(灰白)；展开态 item 行逐条显示。

## 复用关系
- 被组合：`component-quota-entry-modal.md`
- 组合：`component-quota-ring.md` + `component-coding-plans-quota-footer.md` 的 `TierBars` + `../providers/quota-format.md`（formatSingleUnit/formatAmount/currencySymbol）+ `../app-dev-config-page/component-hour-grid-picker.md` 的 `fmtHours`（区间文本三消费方同源之一）

## i18n
chat ns 新增：`quotaModal.tierFiveHour/tierWeekly/tierBalance/timeAny/timeHit/timeMiss/retryIn/halfProbing/notRouting/used/time/resetAt/fast/insufficient`
