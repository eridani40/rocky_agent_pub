# v0.0.352 change_log — 额度总览 UI v2 + Provider 列表折叠

> 版本日志 | 版本：v0.0.352 | 日期：2026-08-15 | 记录：doc-modifier（合并前门禁，编码后）
> worktree：`worktrees/v0.0.352-quota-overview-v2`
> 需求：老板钦定「额度总览 v2 分组双柱 + Provider 列表折叠」（PRD 定稿 `specs/prd/v0.0.352-quota-overview-v2.md`，入库 efde6e41c）
> 视觉契约：`specs/prd/quota-overview-demo-v2.html`（设计稿 = 视觉契约，功能 PASS ≠ 视觉还原）
> 契约：change_plan `specs/tech/version_logs/v0.0.352/quota-overview-v2/change_plan.md`（frozen，不改）
> commits：T1 `78edb80ab`（列表折叠+停用卡视觉，5 files +187/-3）· T2 `54e09e651`（额度总览 v2，7 files +380/-243）· review `b361334e8` PASSED

## 1. 需求与范围

Provider 列表按 enabled 分组折叠展示；额度总览按「套餐额度 / 充值余额」分组，套餐卡每档上下双柱（已用% vs 时间进度%），消耗偏快琥珀警示；**取消 v1 详情展开交互**。纯前端 UI 改造，无新增 API（数据沿用 v0.0.350 `GET /provider/quota`，use-quota-polling 不变）。

## 2. 变更摘要（决策 → 实现）

| 决策（change_plan） | 实现落点 | 状态 |
|---|---|---|
| D1 列表折叠：默认只显启用组 + 「已停用 (N)」折叠入口 | section-providers `disabledExpanded` state + `providers-disabled-fold`/`providers-disabled-list` testid | ✅ |
| D2 停用卡灰调视觉 | 复用既有 `bg-bg-warm text-muted` token（不自创色） | ✅ 偏离① |
| D3 footer 分组双列 | quota/balance 两组 + 组名 + `{{count}} 渠道` 计数，组空不渲染 | ✅ |
| D4 双柱 + 消耗偏快琥珀 | 上柱已用%（fast→`bg-gold`）+ 下柱时间进度%（`bg-muted`）；宽度双向 clamp | ✅ |
| D5 时间文案：周几 HH:mm + 剩余时间 | formatResetTime（weekday short + hour12:false）+ formatRemaining 分钟级 | ✅ 偏离②③ |
| D6 余额千分位 + 余额不足徽标 | `toLocaleString('en-US')` 千分位两位小数 + currencySymbol + danger 徽标 | ✅ |
| D7 退役 v1 展开详情 | expanded state / `quota-detail-*` testid / 展开区 DOM 全删 | ✅ |
| D8 数据层不变 | use-quota-polling 未改（tick 仍输出但 footer 已不消费） | ✅ 知悉① |
| D9 i18n keys | 实际命名与草案不同：`groupQuota`/`groupBalance`/`providerCount`/`time`/`fast`/`fold.disabled`（zh/en 同步，review python diff 验证零孤儿 key） | ✅ 偏离④ |

## 3. 实现核对表

- [x] T1 `78edb80ab`：section-providers 按 `provider.enabled` useMemo 拆组；停用组非空才渲染折叠入口（chevron rotate-180 翻转）；展开渲染同一 ComponentProviderListCard（可点进 detail）；添加卡恒在启用组后；`provider-card-{id}` testid 加在 list-card；i18n `fold.disabled` zh/en
- [x] T2 `54e09e651`：footer v2 重构（258 行）；quota-format.ts 拆分（68 行，超 300 行门禁的产物）；双柱 grid `32px_1fr_44px`；error 态 lastGood 降级（`view = latest.error ? lastGood.get(id) ?? latest : latest`，首轮失败兜底 latest）；i18n 5 新 key zh/en
- [x] Review `b361334e8`：PASSED（无 Critical/Major/Minor；6 重点核验：双柱 clamp/fast 判定/时间格式/折叠默认态/停用 token/退役负向断言）
- [x] UT：新增 13/13（quota-format+footer 10 / section-providers 折叠 3）+ 全量 10725/0 + tsc -b 0 error
- [x] ET：et1-provider-fold + et2-quota-dual-bar 全 PASS（steps 留证 `states/v0.0.352/verify/e2e/`）
- [x] 文件体量：footer 258 / quota-format 68 / section-providers 262（均 < 300 门禁）

## 4. 实现偏差（以代码为准）

1. **停用卡灰调复用既有 token**（`bg-bg-warm text-muted`）：demo 手写色 → 项目 token 映射；coder3 报偏离，review 接受（符合「不自创视觉」铁律）
2. **剩余时间分钟级静态文本**：渲染期 `Date.now()` 计算「剩 X 小时 Y 分」，替代 D5 草案的 30s tick 倒计时走动；coder3 报偏离，review 接受（v1 tick 走动已随展开交互一并退役）
3. **时间文案未走 i18n key**：formatResetTime 走 `navigator.language` locale 感知；formatRemaining 中文字面量硬编码——D5 草案的 `resetWeekdayHHMM`/`remaining*` keys 未建
4. **i18n key 命名与 D9 草案不同**：`quotaGroup→groupQuota`、`balanceGroup→groupBalance`、`channelCount→providerCount`、`consumingFast→fast`（leader 派单已按实际命名收录）

## 5. 知悉项（review，不阻塞）

1. use-quota-polling 仍输出 30s tick 但 footer v2 已不消费（空 setState 开销极小；长期可在 hook 层移除）
2. footer props `baseUrl` 声明未消费（无害保留，props 形状与 section-providers 传入对齐）

## 6. 标准沉淀

- **归一化口径**：`usedPercent` 0-100 vs `timeProgress` 0-1，唯一比较点 `isUsageFast` 内显式 `usedPercent / 100 > timeProgress`（严格 >）——新增展示复用此约定
- **纯函数拆分**：展示组件超 300 行门禁 → 格式化纯函数拆独立文件（quota-format.ts 68 行，UT 直测无渲染开销）
- **退役负向断言**：删除的交互（expanded/`quota-detail-*`）在 UT 以负向断言守卫，防回潮

## 7. 关键文件

| 文件 | 行数 | 角色 |
|---|---|---|
| app/web/src/components/providers/section-providers.tsx | 262 | 折叠分组 + footer 挂载 |
| app/web/src/components/providers/component-provider-list-card.tsx | 75 | +`provider-card-{id}` testid |
| app/web/src/components/providers/component-coding-plans-quota-footer.tsx | 258 | v2 分组双柱 |
| app/web/src/components/providers/quota-format.ts | 68 | 时间/进度纯函数 |
| app/web/src/i18n/locales/{zh-CN,en}/providers.json | — | 6 key zh/en 同步 |

## 8. 文档同步清单（本次 doc 同步产出）

- specs/ui/components/providers/section-providers.md——新增「列表分组折叠（v0.0.352）」段
- specs/ui/components/providers/component-coding-plans-quota-footer.md——v2 全文重写 + 退役清单段
- specs/ui/components/providers/quota-format.md——新建（纯函数 spec，归一化口径）
- specs/prd/version_logs/v0.0.352/change_log.md——本文件（双文件制主文档；PRD 正文 `specs/prd/v0.0.352-quota-overview-v2.md`）
