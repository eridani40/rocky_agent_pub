# component-coding-plans-quota-footer

> 层级: component（列表级区块，v0.0.350 引入 / v0.0.352 重构为分组双柱 v2）
> 文件: app/web/src/components/providers/component-coding-plans-quota-footer.tsx（258 行）
> 引入版本: v0.0.350 · PRD §2.2（cc-switch SubscriptionQuotaFooter 模式）；v2 重构 v0.0.352

## 职责
providers 列表页底部「额度总览」区块（**list 视图专属**；native coding plan provider 卡片之外）：按**套餐额度 / 充值余额**两组渲染渠道卡；额度卡每档**上下双柱**（已用% vs 时间进度%）+ 消耗偏快琥珀警示 + 周几 HH:mm 重置文案；余额卡千分位金额。数据经 `use-quota-polling` hook 拉取（**v0.0.363 起内部走 useProviderQuotaStore 共享 hook——GET store 秒开 + 打开触发增量 + SSE `provider_quota` 帧刷新，无轮询**；lastGood 失败保留语义不变）。
边界：纯展示组件；网络/数据逻辑全在 use-provider-quota-store（经 use-quota-polling 透传）；时间格式化在 quota-format（独立 spec）；不感知 provider CRUD。

## Props 与数据形状
- `providers: ReadonlyArray<{ id; label; baseUrl }>`——native 子集（section-providers 过滤 name ∈ 4 native 类型后传入；空数组由父级决定不渲染；baseUrl 当前未消费，声明保留）
- 消费 `QuotaSnapshot`（api spec 02-llm-chat §5.6）：`{providerId, providerLabel, implId, kind:'quota'|'balance', tiers?, membership?, balance?, isAvailable?, error?, fetchedAt}`
- **ProviderView `{latest, view}`**：`view = latest.error ? lastGood.get(p.id) ?? latest : latest`——error 时**有 lastGood 沿用旧值渲染卡体** + error 行并列展示；**首轮即失败** `?? latest` 兜底（tiers 为空的卡体 + error 行）
- `groupByKind(views)`：`view.kind === 'balance'` → balance，其余 → quota

## 渲染结构（v2）
`quota-footer` testid 根 → 标题行（`quota.title` + 右侧 `quota.lastUpdated` 插值 formatResetTime）→ **quota 组**（`quota.groupQuota` + `quota.providerCount` 渠道计数 + QuotaCard×N）→ **balance 组**（`quota.groupBalance` + 计数 + BalanceCard×N）；**组空不渲染**，quota 组在前 balance 组在后。

### QuotaCard（`quota-card-{providerId}`）
logo 首字母（`bg-sage-bg text-sage`）+ providerLabel + membership 徽标（sage mono）+ implId（muted mono）。
**error 时**：error.kind='auth' → `quota.errorAuth`（danger）；否则透原始 error.message；不渲染 tiers。正常时按档渲染 QuotaTierBlock × tiers.length。

### QuotaTierBlock（`quota-tier-{tier.window}`）
- 档名：`quota.fiveHour`（5 小时额度）/ `quota.weekly`（本周额度）；**fast 时**档名右侧「⚠ `quota.fast`」徽标（`bg-gold-bg text-gold border-gold/40` 琥珀）
- 重置文案：`quota.resetSuffix` + formatResetTime（周几 HH:mm）+ `· 剩 X 小时 Y 分`（formatRemaining）
- **双柱**（grid `32px_1fr_44px`，标签/条/右数值）：
  - 上柱「已用」（`quota.used`）：fill 宽 = clamp(usedPercent)，fast → `bg-gold` + 数值琥珀加粗；正常 `bg-fg`
  - 下柱「时间」（`quota.time`）：fill 宽 = clamp(timeProgress×100)，恒 `bg-muted`；**timeProgress null → 宽 0 + 数值「—」**
  - 宽度双向 clamp `Math.min(100, Math.max(0, …))`；数值 `Math.round`

### BalanceCard（`quota-card-{providerId}`）
logo + providerLabel + `isAvailable===false` → 「余额不足」danger 徽标 + implId + 右侧金额：currencySymbol + formatAmount（16px mono 右对齐）。
- **currencySymbol**：CNY→¥ / USD→$ / 其余原码+空格
- **formatAmount**：`toLocaleString('en-US', {min/maxFractionDigits:2})` 千分位两位小数（9,118.81）
- error 行同 QuotaCard（auth → errorAuth，否则原文）

## 退役清单（v0.0.350 v1 → v0.0.352 删除）
- ~~卡头点击展开完整明细~~（expanded state + toggle + `quota-detail-*` testid + 展开区 DOM 全删；卡头仅展示不可点）
- ~~30s tick 倒计时走动~~（「约 3 小时后重置」每 30s 重渲染；v2 剩余时间为渲染期静态文本，见 quota-format spec 设计决策）
- ~~「上次更新 HH:mm」error 态原值标注~~（v2 全局标题行统一 lastUpdated；error 行独立展示）
- use-quota-polling 仍输出 tick，但 footer 已不消费（review 知悉项：30s 空 setState 开销极小）

## i18n keys（namespace providers，zh/en 同步）
v2 新增：`quota.groupQuota`「套餐额度」/ `quota.groupBalance`「充值余额」/ `quota.providerCount`「{{count}} 渠道」/ `quota.time`「时间」/ `quota.fast`「消耗偏快」；既有复用：`quota.title` / `quota.lastUpdated` / `quota.used` / `quota.fiveHour` / `quota.weekly` / `quota.resetSuffix` / `quota.insufficient` / `quota.errorAuth`

## 复用关系
- 被组合：section-providers（list 分支底部、折叠区之后；native provider 非空才渲染）
- 组合：use-quota-polling（byProvider/lastGood/lastFetchedAt）+ quota-format（formatResetTime/formatRemaining/computeTimeProgress/isUsageFast）+ 既有 token 样式语言（老板铁律不自创视觉）
- **[v0.0.356] `TierBars` 子组件导出**：`component-quota-provider-card.tsx` 在展开态复用 `TierBars` 双柱（props：`tier`、`now`、`hideHeader?: boolean`；D8 提取面 ≤30 行未触发自绘 fallback）

## 消费方
- app/web/src/components/providers/section-providers.tsx（list 视图）
