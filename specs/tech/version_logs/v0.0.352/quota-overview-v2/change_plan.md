# v0.0.352 change_plan：额度总览 UI v2 + Provider 列表折叠

> 版本：v0.0.352（worktree `worktrees/v0.0.352-quota-overview-v2`）
> 派单：Darvin leader · 老板 AFK，PRD 已代验收（`specs/prd/quota-overview-demo-v2.html` 视觉契约 + `specs/prd/v0.0.352-quota-overview-v2.md` 204 行）
> 范围：只出 plan + task.json，不编码；T1/T2 由 coder3 并行实施

## 0. 老板拍板（PRD 关键约束）

1. Provider 列表折叠：默认只渲染 enabled=true；底部「已停用 (N)」入口，点击展开灰色调停用卡；无停用不渲染入口。
2. 额度总览分组：「套餐额度」组（`kind='quota'`）+「充值余额」组（`kind='balance'`），标题右侧渠道计数。
3. 套餐组每档上下双横条：上=已用%（黑色，烧快变琥珀），下=时间进度%（灰色）；判定 `usageProgress > timeProgress` → 琥珀柱 + 琥珀粗体值 +「⚠ 消耗偏快」徽标。
4. 余额组：金额右对齐「¥9,118.81」，余额不足红徽标。
5. 取消详情展开；保留轮询 hook（首拉+5min+LastGood+30s tick）。
6. 5小时文案要带「周几 HH:mm」；剩余时间文案「剩 X 小时 Y 分」/「剩 X 天 Y 小时」。
7. 数据沿用 v0.0.350 `GET /provider/quota` 形状，无新端点。

## 1. 现状（v0.0.350 已落地）

| 文件 | 当前形态 | 改造点 |
|---|---|---|
| `app/web/src/components/providers/section-providers.tsx` | list 渲染全部 provider，底部挂 `CodingPlansQuotaFooter` | 拆分 enabled/disabled 列表 + 折叠入口 |
| `app/web/src/components/providers/component-provider-list-card.tsx` | 已有启用/未启用色区分（logo + badge） | 未启用态需对齐 demo 灰色（logo off、bg-warm 等） |
| `app/web/src/components/providers/component-coding-plans-quota-footer.tsx` | 渠道卡 + 点击展开详情 | 重排为分组 + 双柱 + 取消展开 |
| `app/web/src/components/providers/use-quota-polling.ts` | 5min 轮询 + LastGood + 30s tick | **不变** |
| `app/web/src/lib/api-client.ts` | `QuotaSnapshot`/`QuotaTier` 类型已定义 | 不变 |

## 2. 决策点

### D1 Provider 列表折叠：section-providers 负责分组与入口

- `section-providers.tsx` 内按 `provider.enabled` 拆 `enabledProviders` / `disabledProviders`。
- 默认渲染 `enabledProviders` + 添加 provider 按钮。
- `disabledProviders.length > 0` 时才渲染折叠入口按钮「已停用 (N)」。
- 入口点击切换本地 `disabledExpanded` 状态；展开后渲染 disabled 组（使用同一 `ComponentProviderListCard`，传 `variant='disabled'` 或组件内部读 `enabled`）。

### D2 Provider 卡停用态视觉：新增 disabled 变体

`component-provider-list-card.tsx`：
- logo 背景/文字色：启用 `bg-sage-bg text-sage`；停用 `bg-bg-warm text-muted`（与当前 `!enabled` 一致，但 demo 显示更灰；确保用现有 tokens 不偏色）。
- 徽章：启用「启用」sage；停用「停用」muted（`bg-bg-warm text-muted`）。
- 整卡背景保持 `bg-surface-2`，hover 保持 `border-border-strong`。

### D3 额度总览 v2 结构：footer 内部分组渲染

`component-coding-plans-quota-footer.tsx` 改 props：
- 仍接收 `providers: { id, label }[]`（来自 section-providers 的 native 子集）。
- 内部按 `byProvider` 的 `snap.kind` 分 `quotaItems` / `balanceItems`。
- 渲染顺序：先「套餐额度」组，后「充值余额」组。
- 每组标题行：组名 + 右侧渠道计数（如「4 渠道」）。

### D4 双柱进度条与「消耗偏快」判定

每档 `tier`（five_hour / weekly / daily）渲染两行：
- 上行：标签「已用」+ 进度条（fill 宽度 = `tier.usedPercent`）+ 右侧数值 `Math.round(tier.usedPercent)%`。
- 下行：标签「时间」+ 进度条（fill 宽度 = `timeProgress`）+ 右侧数值 `Math.round(timeProgress)%`。
- `timeProgress = (周期总时长 - 剩余时间) / 周期总时长 × 100`，基于 `tier.resetsAt` 与当前时间计算。
- 判定：`tier.usedPercent > timeProgress` → 上行 fill 变琥珀（`bg-amber-500` / 项目 token `bg-warning`）、上行数值加粗琥珀、档名右侧加「⚠ 消耗偏快」徽标（`bg-amber-100 text-amber-700` 或现有 danger/fast tokens）。
- 否则上行 fill 黑色（`bg-fg` / `#18181b`）。

### D5 时间文案格式化

- 重置时间：`new Date(resetsAt).toLocaleString(..., { weekday: 'short', hour: '2-digit', minute: '2-digit' })` → 「周四 13:22」「周六 11:47」。
- 剩余时间：
  - <24h：「剩 X 小时 Y 分」
  - ≥24h：「剩 X 天 Y 小时」
- 文案 key：`quota.resetWeekdayHHMM`、`quota.remainingHoursMinutes`、`quota.remainingDaysHours`。

### D6 余额展示

- 余额组卡：左侧 provider 信息，右侧金额右对齐。
- 金额格式：币种符号 + 千分位 + 两位小数（`¥ 9,118.81`）。
- `isAvailable === false` 时 label 右侧显示红徽标「余额不足」。

### D7 取消详情展开

- 删除 `expanded` state、toggle 逻辑、`quota-detail-*` testid 与展开区 DOM。
- 卡头不再可点击展开；仅作展示。

### D8 use-quota-polling 与数据层不变

- 不重写轮询；footer 只消费 `byProvider`、`lastGood`、`lastFetchedAt`、`tick`。
- `tick` 继续驱动倒计时重渲染。

### D9 i18n keys

新增/修改 keys（namespace `providers`）：
- `list.disabled`（已存在，复用）
- `fold.disabled` → 「已停用 ({{count}})」
- `quota.quotaGroup` → 「套餐额度」
- `quota.balanceGroup` → 「充值余额」
- `quota.channelCount` → 「{{count}} 渠道」（或直接用 count 裸数字按 demo）
- `quota.used`（已存在）
- `quota.time` → 「时间」
- `quota.resetWeekdayHHMM` → 「重置 {{weekday}} {{time}}」
- `quota.remainingHoursMinutes` → 「剩 {{h}} 小时 {{m}} 分」
- `quota.remainingDaysHours` → 「剩 {{d}} 天 {{h}} 小时」
- `quota.consumingFast` → 「⚠ 消耗偏快」
- `quota.insufficient`（已存在）
- `quota.granted`、`quota.toppedUp`（已存在）

## 3. 方法级契约表

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 (MUST/MUST NOT) | 参考 | 预计影响行 |
|---|---|---|---|---|---|---|---|
| providers list | `app/web/src/components/providers/section-providers.tsx` | `SectionProviders` / list branch | modify | 按 enabled 拆分列表；加 disabled 折叠入口与展开态 | MUST 无停用时不渲染入口；MUST 保持添加 provider 卡位置 | PRD §1 | ~+35 |
| provider card | `app/web/src/components/providers/component-provider-list-card.tsx` | `ComponentProviderListCard` / `Badge` | modify | 未启用态视觉对齐 demo（logo off、停用徽章） | MUST 复用现有 tokens；MUST 不影响启用态 | PRD §1, demo HTML | ~+10/-5 |
| quota footer | `app/web/src/components/providers/component-coding-plans-quota-footer.tsx` | `CodingPlansQuotaFooter` | rewrite(major) | 取消展开；按 kind 分组；套餐组双柱；余额组右对齐金额；时间文案新格式 | MUST 保留 useQuotaPolling 消费；MUST 单文件 ≤300 行（过大则拆子组件） | PRD §2-§5, demo HTML | ~+140/-80 |
| quota helper | `app/web/src/components/providers/quota-format.ts`（新） | `timeProgressOf` / `remainingText` / `weekdayHHMM` | new | 时间进度、剩余文案、重置时间格式化纯函数 | MUST 无副作用；MUST 可 UT | PRD §6 | ~+50 |
| i18n | `app/web/src/i18n/locales/zh-CN/providers.json` | 新增 keys | modify | 折叠入口、分组标题、双柱标签、时间文案、消耗偏快徽标 | MUST 同步 en 文件；MUST 占位符一致 | PRD §8 | ~+15 |
| i18n | `app/web/src/i18n/locales/en/providers.json` | 新增 keys | modify | 同上英文 | MUST 与 zh-CN 占位符一致 | PRD §8 | ~+15 |
| UT | `app/web/src/components/providers/__tests__/section-providers.test.tsx` | 新增用例 | modify | 折叠入口显隐；启用/停用分组 | 不读截图 | PRD §1 | ~+60 |
| UT | `app/web/src/components/providers/__tests__/component-coding-plans-quota-footer.test.tsx`（新） | 新增用例 | new | 双柱琥珀判定；余额不足；分组计数；时间文案 | 用 QuotaSnapshot fixture；fake timers 控 tick | PRD §3-§6 | ~+120 |

## 4. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| **R1 视觉 token 与 demo 色差** | 实际 CSS tokens 名称/色值与 demo 手写 #hex 不完全一致 | 使用现有语义 token（sage/bg-warm/danger/amber 或最接近的 warning token），demo 仅作布局参考 |
| **R2 timeProgress 计算口径** | 周期总时长未在 API 中显式返回，需从 resetsAt 反推 | 约定基于当前时间到 resetsAt 的剩余时长与已用比例；5h/weekly/daily 周期由 tier.window 决定，按标准小时数：five_hour=5h，weekly=7d，daily=24h |
| **R3 取消展开后「上次更新」位置** | 原展开区有 per-channel lastUpdated，v2 取消展开 | footer 顶部保留全局 lastUpdated；per-channel 上次成功时间可简化到 error 态「上次成功获取：...」或tooltip，本版按 demo 只在 error 卡显示 |
| **R4 单文件行数膨胀** | 双柱+分组逻辑可能让 footer 超过 300 行 | 拆 `quota-format.ts` + 行内子组件；coder 实施时监控 |
| **R5 i18n 占位符不一致** | zh/en 占位符名不同导致渲染失败 | architect 在契约表写明 key+占位符名；coder/reviewer 双向核对 |
| **R6 LastGood 与分组计数** | 失败渠道无 kind，分组计数应基于 providers 原始 native 子集还是 byProvider | 标题计数用实际成功/有 kind 的渠道数；如 demo 中「4 渠道」「2 渠道」指有数据的渠道数；无数据渠道不显示计数 |

## 5. 范围边界

- **要**：
  - Provider 列表 enabled/disabled 分组 + 折叠入口。
  - Provider 卡停用态视觉变体。
  - 额度总览 v2 分组双柱渲染。
  - 时间/余额文案与徽标。
  - i18n 新增 keys。
  - UT（列表折叠 + footer 渲染）。
- **不要（本轮）**：
  - 不改 `use-quota-polling`。
  - 不改 API 端点/后端。
  - 不新增 Provider 详情页内容。
  - 不新增动画/过渡。
  - 编码在派单后执行。

## 6. task 拆分

- **T1**：Provider 列表折叠 + 停用卡视觉（低复杂度）。
- **T2**：额度总览 v2 分组双柱（中复杂度，依赖 T1 的列表数据流但可并行开发 footer）。
- **T3**：回归 UT/ET（中复杂度，依赖 T1/T2）。

T1/T2 文件零交集（T1 改 section/card；T2 改 footer + helper + i18n），coder3 可并行。

## 7. 关键接口草案

```ts
// app/web/src/components/providers/quota-format.ts
export function timeProgressOf(tier: QuotaTier, now: number): number;
export function remainingText(resetsAt: string, now: number, t: TFunction): string;
export function weekdayHHMM(ts: string | number): string;

// component-coding-plans-quota-footer.tsx 内按 kind 分组
const quotaItems = providers
  .map((p) => byProvider.get(p.id))
  .filter((s): s is QuotaSnapshot => s?.kind === 'quota');
const balanceItems = providers
  .map((p) => byProvider.get(p.id))
  .filter((s): s is QuotaSnapshot => s?.kind === 'balance');
```

## 8. 视觉验收对照（来自 demo HTML）

- 列表默认：4 启用卡 + 「已停用 (2)」虚线入口。
- 列表展开：启用卡 + 「已停用 (2)」实心入口 + 2 灰色停用卡。
- 套餐额度组标题：「套餐额度」「4 渠道」。
- Kimi 卡：5h 已用 3%/时间 10%（健康）；本周已用 39%/时间 26%（琥珀+「⚠ 消耗偏快」）。
- GLM 卡：5h 已用 21%/时间 42%；本周已用 68%/时间 77%。
- MiniMax 卡：每日额度、本周额度两档。
- 余额组标题：「充值余额」「2 渠道」；DeepSeek ¥ 9,118.81；MiniMax 余额不足红徽标。
