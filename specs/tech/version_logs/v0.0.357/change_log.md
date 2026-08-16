# v0.0.357 change_log — picker 默认语义修复 + 圆环渲染修复

> 版本轴：随 bump 至 0.0.356 发布，本目录沿用工作版本号 v0.0.357（记录该版本周期内的 bug 修复）。
> 性质：两个独立 bug 修复（A=picker 默认语义、B=圆环渲染），均已 review PASSED 合在 dev1。纯 bug 修复跳 PRD。
> change_plan：`specs/tech/version_logs/v0.0.357/change_plan.md`（修复 A frozen 契约）；修复 B 为单行视觉修复无独立 change_plan。

## 修复 A：picker 默认语义补「方案」维度

### 需求（bug）
- **Bug1**：session 未手动选模型（保留字/空）→ picker hover 显示「未配置」，但实际走默认方案。应显示「方案 · <名>（默认）」。
- **Bug2**：session 选了模型后 → picker 菜单无「恢复默认」项，无法回退走默认。
- **根因**：运行时 `resolveModelRoutingPlan`（session-config.ts）早已双维度（默认模型 or 挂载方案，T6 互斥），但 chrome 装饰视图 + picker 只实现了模型维度 → 显示与实际行为脱节。恢复默认的后端链路（保留字 `'default'` 写回）本已完整，纯 UI 入口缺失。
- 前置报告：`outputs/bugs/picker-default-routing-ui.md`（bug-analyst 实证）。

### 实现核对表（change_plan D1-D5）

| 决策 | 实现实况 | commit |
|------|---------|--------|
| D1 chrome 契约加 `defaultRoutingPlan` | ✅ `session-chrome.ts` interface + 三 kind 分支投影（playground→`getPlaygroundPlanId`；studio→`squad.modelRoutingPlanId`；academy 恒 null），`getPlan` 反查 name，方案被删→null（与 resolve 同口径） | `1d42d2ba5` |
| D2 picker `hasDefaultRoute` + hover 四态 + 菜单默认项 | ✅ `component-input-model-picker.tsx` 加 `defaultPlan` prop、`hasDefaultRoute=hasDefault\|\|hasPlan`、hover 方案态显「方案 · 名（默认）」、extraTopItems 条件放宽、方案态 onClick 复用保留字 `default` | `1d42d2ba5` |
| D3 接线 `component-chat-session-input` + session-api view | ✅ L172 `defaultPlan={chrome.defaultRoutingPlan ?? null}`；session-api.ts L209 view 同步加字段 | `1d42d2ba5` |
| D4 i18n 新增 `planDefaultLabel` | ✅ 双语新增（zh `方案 · {{name}}（默认）` / en `Plan · {{name}} (default)`），不删旧 | `1d42d2ba5` |
| D5 token-usage 同型风险留 BUG | ✅ 落 `states/v0.0.357/bugs/BUG-TOKEN-USAGE-PLAN-FALLBACK-[open].md`，另版评估 | — |

### 实现偏差
- **i18n 收敛未做**（D4 可选项）：旧「未配置」「（默认）」仍为 picker 内硬编码中文字符串，未收敛为 `unconfigured`/`defaultModelSuffix` key。change_plan 冻结口径「只新增 `planDefaultLabel` 必做；收敛可选」——本版只做了必做项，未做收敛，不记为违规偏离（可选项未启用）。
- **review Minor**（`93d8d8933`）：chat-actor-strategy mock 工厂 `defaultRoutingPlan` 行缩进对齐（纯样式，无语义）。

### 验证
- UT：server 方案投影 2 例 + web picker 方案态 hover/菜单/onChange 3 例（`session-chrome.test.ts` / `component-input-model-picker.test.tsx`）。
- Review：**PASSED**（`states/v0.0.357/verify/review/code-review-task1.md`，commit `2daeb9fc1`）。

## 修复 B：圆环渲染修复（quota-ring）

### 需求（bug）
- 模型方案额度弹层圆环缺失：`QuotaRing` 用 `text-*` 类给 SVG circle 着色，但 `text-*` 只设 `color`、circle `stroke` 计算值 = `none` → 底环 + 进度环都不画，只剩百分比数字。
- 参考：`outputs/bugs/quota-entry-ring-missing.md`。

### 实现
- `component-quota-ring.tsx` 两个 circle（底环 + 进度环）各补 `stroke="currentColor"`，继承 `text-*` 类已设好的 `color`，颜色决策逻辑零改动。
- commit `9a8e1e676`（dev1 独立单行修复）。

### 验证
- UT 防回归：断言 circle `stroke` 非 `none`（`component-quota-ring.test.tsx`）。

## 标准沉淀
- **同构契约扩展**：chrome `SessionChromeView` 新增 `defaultRoutingPlan` 字段恒在（academy 恒 null），不破坏 api 04a §1 同构承诺；显示与运行时 resolve 同口径（「显示 == 实际行为」）。
- **SVG 着色陷阱**：`text-*` 工具类只设 CSS `color`，不直接作用于 SVG `stroke`/`fill`；SVG 元素描边须显式 `stroke="currentColor"` 才能继承 `text-*` 色。
- **互斥双维度默认**：picker 默认语义 = 默认模型 or 挂载方案（T6 互斥，方案优先），UI 经 `hasDefaultRoute` 统一推导。

## 关键文件

| 文件 | 变更 |
|------|------|
| `app/server/src/services/session-chrome.ts` | interface + buildSessionChrome 三 kind 方案投影 |
| `app/web/src/lib/chat-api/session-api.ts` | view 加 `defaultRoutingPlan` |
| `app/web/src/components/chat-page/component-input-model-picker.tsx` | defaultPlan prop + hasDefaultRoute + hover/菜单方案态 |
| `app/web/src/components/chat-page/component-chat-session-input.tsx` | 接线 defaultPlan（L172） |
| `app/web/src/i18n/locales/{zh-CN,en}/chat.json` | 新增 `planDefaultLabel` |
| `app/web/src/components/chat-page/component-quota-ring.tsx` | 双 circle 补 `stroke="currentColor"` |

## 文档同步清单（doc-sync 2026-08-15）

| 文件 | 变更 | 状态 |
|------|------|------|
| `specs/api/overall/04a-session-chrome.md` | §2 契约 + §3.2 数据源映射表加 `defaultRoutingPlan`（coder 已改） | ✅ 核对一致 |
| `specs/ui/components/chat-page/component-input-model-picker.md` | §3 三态表扩四态 + 职责补方案维度（coder 已改） | ✅ 核对一致 |
| `specs/ui/components/chat-page/component-quota-ring.md` | 渲染节补 stroke currentColor 继承机制 + updated（本 doc-sync） | ✅ 已补 |
| 消费方核对 | `component-chat-session-input.tsx` L172 接线、`session-api.ts` L209 字段、`component-tuple-cards.tsx`（academy，optional 兼容不传 defaultPlan） | ✅ 一致 |
