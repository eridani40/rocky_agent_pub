# v0.0.356 change_plan — squad member 余额查询快捷入口（弹层）

> PRD：`specs/prd/version_logs/v0.0.356-squad-quota-entry/change_log.md`（老板 13:12 拍板开发推进）
> 视觉契约：`specs/prd/squad-quota-entry-demo-v2.html` 终态（三轮拍板固定，3e659be67）
> 基线：worktree `v0.0.356-squad-quota-entry`（7ff9635ee，含 352 已合并：quota-format/footer 在树）

## 决策记录

| # | 决策 | 依据 |
|---|------|------|
| D1 | 纯前端 feature，无新端点、无 server 改动 | PRD §2.6 全复用既有 API |
| D2 | 入口渲染条件 = `squadCtx && squadCtx.detail?.modelRoutingPlanId`；**方案 id 零请求**——直接读 SquadStatusContext.detail（page-studio Provider 已持有，含 refreshDetail），不新调 GET /squad/:id | 源码实证 squad-status-context.ts（detail: SquadDetail 含 modelRoutingPlanId，squad-types.ts:137）；对齐 squad-status 项 fail-safe 先例 |
| D3 | 数据 hook `useSquadQuota` 挂在 **modal 内部**（open 时挂载即拉、关闭即卸载停轮询），不学 float-menu 恒挂载——本入口无 badge，未打开零网络 | PRD §2.6 刷新策略（弹层开着才 5min 轮询） |
| D4 | 四源 + 1 辅助源：① planId=ctx.detail（零请求）② `fetchModelRoutingPlans()`（方案 items+名）③ `fetchModelRoutingStatus(planId)` ④ `fetchProviderQuota()`（额度/余额）⑤ `listProviders()`（baseUrl——展开态副标下 mono 行需要，PRD 四源表未列但「全部复用既有 API」语义内） | 源码实证：QuotaSnapshot 无 baseUrl 字段；model-routing-api.ts/api-client.ts 均已有现成函数 |
| D5 | 时间命中判定（hours 含当前？）用浏览器本地时区 `Intl.DateTimeFormat(locales, {hour:'2-digit', hourCycle:'h23'})`——**MUST NOT 用 hour12:false**（en-US 午夜输出 "24" 撞 0-23 白名单，已知 gotcha） | RoutingItem.timeCondition.hours 0-23；intl-hour12-false-midnight-24-gotcha |
| D6 | 收起窄卡单状态点合并规则（一 provider 多 item 时）：**最劣优先 熔断(红) > 观察中(橙) > 工作中(绿) > 不在时间内(灰白)**；展开态 item 行逐条四态点（PRD §2.5 表逐条套用） | 警示优先于正常展示；PRD 未规定多 item 合并，此为架构期补充（leader review 可调） |
| D7 | 状态词与模型页并存不统一：本弹层「工作中/熔断/观察中/不在时间内」（PRD §2.5 拍板），模型页 D16「正常/异常/观察中」不动；不复用 CircuitStatusBadge 组件（ns/词不同），复用其**本地每秒倒计时模式**（remainingSeconds 快照 + setInterval 递减零网络） | PRD §2.5 状态词口径；component-circuit-status.tsx 先例 |
| D8 | 展开态双柱：优先从 352 footer 提取 TierBars 导出共享；若耦合 footer 内部结构致提取面大，则 card 内自绘紧凑版（视觉 token 对齐模型页 v2 为契约，不做第三种视觉） | PRD §2.4「同模型页额度总览视觉」；DRY vs 回归风险折中 |
| D9 | task 切分：**单 task T1**（入口+hook+弹层+双态卡+i18n 内聚一链路；拆两 task 需接口先行协商，收益低） | leader 建议 1-2 倾向单 |

## 现状实证（关键符号全部 grep 核实）

- `component-chat-float-menu.tsx`（177 行）：5 项菜单（memory/cron/skills/squad-status/todo），`open` union 待扩 `'quota'`；squad-status 项 `{squadCtx && ...}` fail-safe 先例（L128）；Badge count<=0 不渲染。
- `component-todo-modal.tsx`（186 行）：L3 壳基准——Portal + `bg-[rgba(30,25,20,0.45)] backdrop-blur-sm` + `w-[720px] rounded-[14px]` + head/body overflow-y-auto。
- `squad-status-context.ts`：`SquadStatusContextValue { detail: SquadDetail|null, refreshDetail, ... }`；`SquadDetail.modelRoutingPlanId?: string`（squad-types.ts:137）。
- `model-routing-api.ts`：`fetchModelRoutingPlans(): ModelRoutingPlanRecord[]`（§2.1）、`fetchModelRoutingStatus(planId): ModelRoutingStatus`（§2.6，item 含 circuitState/presentation/remainingSeconds）。
- `api-client.ts`：`fetchProviderQuota(): {items: QuotaSnapshot[]}`（providerId/providerLabel/membership/kind/tiers/balance/isAvailable/error）；`listProviders(): ProviderInstance[]`（id/label/baseUrl/enabled）。
- `quota-format.ts`（68 行，352 并入）：formatResetTime/formatRemaining/computeTimeProgress/isUsageFast 现成；**缺** formatSingleUnit（四分支单单位）与 formatAmount（千分位两位小数）——本版新增。
- `use-quota-polling.ts`（100 行）：5min 轮询 + lastGood + 30s tick 语义参考（不直接复用：其恒挂载 + 单源；本版 modal 内挂载 + 多源组合）。
- `component-coding-plans-quota-footer.tsx`（258 行）：TierBars 双柱（usedPercent 上柱 + timeProgress 下柱 + fast 琥珀）——D8 复用目标。
- i18n：chat ns `floatMenu.*` 已有（chat.json:75）；`icons.tsx` 无电池图标（demo 🔋 示意，实现选 lucide `BatteryMedium` 或同库现有——遵循 chat-page icons 现有引入模式）。

## 四源数据流

```
SquadStatusContext.detail ──modelRoutingPlanId──┐（入口渲染条件 + 定位，零请求）
                                                ├→ useSquadQuota(planId) ──→ 组合视图模型
GET /config/app?group=model_routing_plans ──────┤   （按 providerId 分组的卡片 VM：
GET /model-routing/plans/:id/status ────────────┤    状态点四态/条目/tiers/余额/baseUrl）
GET /provider/quota ────────────────────────────┤
GET /provider（辅助：baseUrl）──────────────────┘
```
- 打开即全量首拉；5min setInterval 自动刷新；**每源独立 lastGood**（源失败保留上次成功值，脚注「上次更新 HH:mm · 每 5 分钟自动刷新 · 失败保留上次成功值」）；关闭卸载停全部 interval。
- 倒计时/环内剩余时间：快照 + 本地 setInterval 秒级递减重渲染，零网络。

## 契约表（method 级）

| 模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计行 |
|------|------|----------|------|---------|------|------|--------|
| chat-page | app/web/src/components/chat-page/component-chat-float-menu.tsx | `open` union / 第 6 按钮 / modal 挂载 | 修改 | union 加 `'quota'`；squad-status 按钮后、todo 前插「余额查询」按钮（32×32 muted hover fg，无 badge，`data-action-key="chat.quota.open"`）；`{open==='quota' && <ComponentQuotaEntryModal onClose planId/>}`；渲染条件 `{squadCtx?.detail?.modelRoutingPlanId && ...}` | MUST：todo 保持最后一位；未挂载方案不渲染入口 | PRD §2.1 | ~25 |
| chat-page | app/web/src/components/chat-page/component-quota-entry-modal.tsx | `ComponentQuotaEntryModal` | 新增 | L3 弹层壳（抄 todo-modal 壳）+ 顶部方案信息栏（方案名+四色图例）+ `useSquadQuota(planId)` + provider 卡列表（`expandedId` 独立 toggle 由卡自持）+ 底部脚注 | MUST：壳样式与 todo-modal 同款（720/r14/遮罩/blur）；loading/error/空态对齐 todo-modal 模式 | PRD §2.2 | ~200 |
| chat-page | app/web/src/components/chat-page/component-quota-provider-card.tsx | `ComponentQuotaProviderCard` | 新增 | 双态卡：收起窄卡（状态点+头像+name/model 两行+双档双环+chevron）/ 展开替换层（卡头主副标题+baseUrl mono+item 行+双柱详情或余额大字）；点击卡片任意处 toggle（`aria-expanded`） | MUST：默认收起；卡间独立 toggle 非手风琴；余额型无环无柱；无周限额只显 5h 档；≤300 行（超则拆出展开层子组件） | PRD §2.3/2.4 | ~290 |
| chat-page | app/web/src/components/chat-page/component-quota-ring.tsx | `QuotaRing` | 新增 | 单环（SVG circle stroke-dashoffset）：props {percent, label, centerText, fast?}；`role="progressbar"` + aria-label（provider+档位+已用%）；fast 时环与数字琥珀 | MUST：纯展示无状态 | PRD §2.3 双环 | ~80 |
| chat-page | app/web/src/components/chat-page/use-squad-quota.ts | `useSquadQuota(planId)` | 新增 | 四源组合：首拉 + 5min 轮询 + 每源 lastGood + 1s tick（倒计时驱动）+ 卸载清理；输出 `{ cards: CardVM[], planName, lastUpdatedAt, loading, error }`（CardVM=分组视图模型：状态点/条目/tiers/balance/baseUrl） | MUST：aliveRef 防卸载后 setState；单源失败不炸整体；providersKey/planId 变化重建轮询 | PRD §2.6；use-quota-polling 语义 | ~180 |
| providers | app/web/src/components/providers/quota-format.ts | `formatSingleUnit(ms)` / `formatAmount(n)` | 新增（导出） | formatSingleUnit 四分支：≥1d→`X天`；≥1h→`X小时`；<60m→`Xm`；<1m→`0min`（**圈内单单位，i18n key 驱动**）；formatAmount：千分位+两位小数（¥ 9,118.81） | MUST：时间文案走 i18n（不硬编码中文）；复用现有 4 函数不改动 | PRD §2.3 单单位规则 | ~35 |
| providers | app/web/src/components/providers/component-coding-plans-quota-footer.tsx | `TierBars`（导出） | 修改 | 双柱子组件导出（export + props 显式化）供 356 展开态复用；**若提取面 >30 行改动则放弃（D8 fallback：card 自绘）** | MUST NOT：改变 footer 既有渲染/UT 断言 | D8 | ~10 |
| i18n | app/web/src/i18n/locales/{zh-CN,en}/chat.json | `floatMenu.quota` + `quotaModal.*` | 修改 | 入口 aria「余额查询」；标题「模型方案额度」；状态词四态；档位「5小时额度/周额度/充值余额」；图例四色；脚注；重置/剩余文案 | MUST：全量 chat ns 双语；无硬编码 | PRD §2.7 | ~45 |
| tests | app/web/src/components/chat-page/__tests__/use-squad-quota.test.ts | 新增 | 新增 | hook UT（fetch 全 mock）：①四源组合成 CardVM（分组/状态点四态映射/余额型/无周档）②源失败 lastGood 保留 ③5min 轮询+卸载清理（fake timers）④tick 零网络（断言 fetch 不再被调） | MUST：fake timers 推进轮次；断言 lastGood 命中 | 记忆 interval-polling-hook-ut 配方 | ~140 |
| tests | app/web/src/components/chat-page/__tests__/component-quota-provider-card.test.tsx | 新增 | 新增 | 卡 UT：①收起态结构（点+头像+两行+双环左右/环上字下+chevron）②单单位四分支（formatSingleUnit 直测 + 卡内渲染）③toggle 独立（A 展开不影响 B）④展开态替换层结构（主副标题/baseUrl/item 行/双柱/倒计时）⑤余额型/无周档形态 ⑥aria（progressbar/expanded） | MUST：烧快琥珀断言（fast class） | PRD §5 验收 3/4/5/6 | ~160 |
| tests | 既有 float-menu UT | 修改 | 修改 | `component-chat-float-menu.test.tsx` 补：第 6 项渲染条件（挂载方案显/未挂载隐）+ 位置序（squad-status 后 todo 前） | MUST：既有 5 项断言不回归 | PRD UC-1/2 | ~20 |

## 风险清单

| 风险 | 应对 |
|------|------|
| hours 判定时区 gotcha（hour12:false→"24"） | D5 固定 hourCycle:'h23'；UT 含午夜 0 点 case |
| planId 对应方案被删（fetchModelRoutingPlans 找不到 key） | planName 回退 `planId 前 8 位`，卡片列表按 status 空 → 全灰白降级，不炸 |
| status 端点 404/失败 | 该源 lastGood；无历史 → 状态点灰白 + 脚注提示 |
| 非 native provider（quota fetch 无该 id） | 额度区显「—」，状态点照常（源独立） |
| TierBars 提取引发 352 回归 | D8 双路径：提取改动 >30 行即 fallback 自绘；footer UT 必须全绿 |
| 卡片超 300 行 | 契约表已预案拆展开层子组件 |
| 弹层开着时 squad 切方案/解除挂载 | detail.modelRoutingPlanId 变化 → hook key 重建（providersKey 同款模式）；弹层内方案名跟随 |

## 影响面外（零改动）

- server 全部（无新端点）；use-quota-polling.ts（模型页路径独立）；CircuitStatusBadge（D7 不复用组件）；squad-status 入口/弹层；模型页 352 组件（除 D8 可能的 TierBars 导出）。
- AT：无新端点 → 不新增 case，冒烟集回归即可（纯前端 feature）。ET：UI 新板块 → leader test-plan 定（预计 1-2 条：UC-1/2/3 入口+弹层+双态卡）。
