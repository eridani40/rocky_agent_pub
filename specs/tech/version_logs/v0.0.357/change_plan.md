# v0.0.357 change_plan：picker 默认语义补「方案」维度（hover 显默认方案 + 菜单恢复默认入口）

> 版本：v0.0.357（主仓 ``，分支 dev1，单版本小修直改模式）
> 基线：`dev1@HEAD`（2026-08-15）
> 派单：Darvin leader · 老板拍板：picker 默认语义 bug（默认=默认模型 or 方案 双维度，视图层只实现了模型维度）
> 前置报告：`squads/.../outputs/bugs/picker-default-routing-ui.md`（bug-analyst 实证）
> 范围：server chrome 投影 + api spec + web picker + i18n + UT；不改 demo；i18n 新增不删旧

## 0. 需求边界（老板确认）

- **Bug1**：session 未手动选模型（保留字/空）→ picker hover 显示「未配置」，但实际走默认方案。应显示「方案 · <名>（默认）」。
- **Bug2**：session 选了模型后 → picker 菜单无「恢复默认/跟随配置」项，无法回退走默认。应补默认项入口（复用保留字 `'default'` 写回链路，后端零改动）。
- **核心语义**：默认 = 默认模型 **or** 挂载方案（T6 互斥，二选一）。当前 chrome 契约 + picker 只实现了模型维度。

## 1. 现状实证（源码层，已 grep/Read 核实）

| 事实 | 文件 | 行号 | 说明 |
|---|---|---|---|
| chrome `defaultModel` 三 kind 只读模型维度 | `app/server/src/services/session-chrome.ts` | L184-223 | playground→`default_models.default.chat`；studio→`squad.modelDefault`；**不读** `playgroundPlanId`/`squad.modelRoutingPlanId` |
| 运行时 resolve 已双维度 | `app/server/src/handlers/session-config.ts` | L145-179 | `resolveModelRoutingPlan` 读 `getPlaygroundPlanId`/`squad.modelRoutingPlanId` + `getPlan` 反查 → 走方案链；chrome 显示脱节 |
| picker `hasDefault` 仅由模型推导 | `app/web/src/components/chat-page/component-input-model-picker.tsx` | L133-156 | `defaultModelId` 空 → `effectiveDefault=null` → `hasDefault=false` |
| hover「未配置」产生点 | 同上 | L160, L169-171 | `isReservedDefault && !hasDefault` → `previewLabel='未配置'` |
| 菜单默认项消失产生点 | 同上 | L199-208 | `extraTopItems = hasDefault ? […] : undefined`——挂方案时整体消失 |
| 保留字 `'default'` 写回链路完整 | `app/web/src/components/chat-page/use-chat-chrome.ts` | L102-114 | `modelId==='default'` → PUT `{modelId:'default'}`；**恢复默认后端链路本已存在，缺 UI 入口** |
| squad schema 有方案字段 | `app/server/src/agent/schema_defs/squad/squad.ts` | L97 | `modelRoutingPlanId: { type:'string', required:false }` |
| playground 挂载读取函数已存在 | `app/server/src/services/model-routing-store.ts` | L110-116 | `getPlaygroundPlanId(svc)` 读 `model_routing.default.playgroundPlanId` |
| 方案反查函数已存在 | `app/server/src/services/model-routing-store.ts` | L33 附近 | `getPlan(svc, planId)` 读 `model_routing_plans` 组 → `ModelRoutingPlan{name,items,…}` |
| 前端 chrome view 形状 | `app/web/src/lib/chat-api/session-api.ts` | L195-214 | `SessionChromeView` 无方案字段（需同步加） |
| api spec 契约无方案字段 | `specs/api/overall/04a-session-chrome.md` | §3.1/§3.2 | `defaultModel` 数据源映射表只有模型列 |
| picker 组件 spec 三态表 | `specs/ui/components/chat-page/component-input-model-picker.md` | §3 | 无方案态（需补第四态） |

一句话：**运行时早已双维度（方案链），chrome 装饰视图 + picker 仍是单维度（模型）——显示与实际行为脱节；恢复默认的后端链路完整，纯 UI 入口缺失。**

## 2. 决策点

### D1 chrome 契约扩展 `defaultRoutingPlan` 字段（server 投影）

- `SessionChromeView` 加 `defaultRoutingPlan: { planId: string; planName: string } | null`。
- 同构承诺（api 04a §1）：字段恒在，academy kind 恒 `null`，未挂载/方案被删恒 `null`。
- 数据源（与 `resolveModelRoutingPlan` 同口径，保证「显示==实际行为」）：
  - playground → `getPlaygroundPlanId(appConfig)` 读 `model_routing.default.playgroundPlanId`；
  - studio（member/group）→ `squad.modelRoutingPlanId`（getSquad 已透传，类型放宽即可）；
  - academy → 恒 `null`（非目标，spec §9）。
- 反查方案名：拿到 planId 后 `getPlan(appConfig, planId)` 取 `plan.name`；方案被删（`getPlan` 返 undefined）→ `defaultRoutingPlan=null`（与 resolve「视为未挂载」同口径，spec §2.2）。
- `SessionChromeSources` 依赖接口需补 `appConfig` 能力（已含 `get`，足够调 `getPlaygroundPlanId`/`getPlan`——两者都只依赖 `svc.get`，零新依赖注入）。

### D2 picker 默认语义扩为 `hasDefaultRoute`（模型 or 方案）

- `InputModelPicker` 加 prop `defaultPlan?: { planId: string; planName: string } | null`。
- `hasDefaultRoute = hasDefault || hasPlan`（`hasPlan = defaultPlan != null`）。
- hover 四态（spec §3 表补第四态）：
  - `isReservedDefault && hasDefault` → `a（默认）`（现状保持）；
  - `isReservedDefault && !hasDefault && hasPlan` → `方案 · <planName>（默认）`（新增，i18n 新 key）；
  - `isReservedDefault && !hasDefault && !hasPlan` → `未配置`（现状保持）；
  - 具体 modelB → `b`（现状保持）。
- 菜单 `extraTopItems` 条件 `hasDefault` 改 `hasDefaultRoute`：
  - 模型态默认项 label=`a（默认）`（现状保持）；
  - 方案态默认项 label=`方案 · <planName>（默认）`，`onClick` 仍 `handleSelect({providerId:'', modelId:'default'})`（复用保留字，写回链路零改动）。
- 方案优先口径：T6 互斥保证「默认模型与挂载方案至多一个有值」（spec §2.2），UI 按「方案优先」与 resolve/UI 现状一致，无需处理双设。

### D3 接线 `component-chat-session-input.tsx`

- `<InputModelPicker>` 传 `defaultPlan={chrome.defaultRoutingPlan ?? null}`。
- 前端 `SessionChromeView`（session-api.ts）同步加 `defaultRoutingPlan` 字段。

### D4 i18n（chat ns，新增不删旧）

- 新 key（zh-CN / en 各一）：
  - `planDefaultLabel`：`方案 · {{name}}（默认）` / `Plan · {{name}} (default)`。
- 现状「未配置」「（默认）」为**硬编码中文字符串**（picker L167/L170/L203），本版**顺带收敛为新 i18n key**（`defaultModelSuffix`=`（默认）`、`unconfigured`=`未配置`）——这是合理的最小收敛（同属 picker 默认语义域），不扩面。
  - ⚠️ 收敛属可选优化：若 coder 评估收敛会动到既有多处断言，可保留硬编码 + 只新增 `planDefaultLabel`。**冻结口径：只新增 `planDefaultLabel` 必做；`defaultModelSuffix`/`unconfigured` 收敛为可选，做了需在 change_log 记偏离。**

### D5 token-usage-subscriber 同型风险——留 BUG，不纳入本 task

- `app/server/src/squad/token-usage/token-usage-subscriber.ts:147-149` model fallback 只到 `squad.modelDefault` 不到方案（挂方案时 model 落 `__unknown__`）。
- **不同根**：subscriber 不持有 `appConfig`（deps 只有 squadReader/sessionStore/statStore），无 `getPlan` 反查链路；修需注入 `appConfig` 依赖 + 方案反查，属独立改动（统计口径 vs 视图层显示，两条链）。
- 处置：落 `states/v0.0.357/bugs/BUG-TOKEN-USAGE-PLAN-FALLBACK-[open].md`，另版评估。

## 3. 变更清单（frozen 契约）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| server/chrome | `app/server/src/services/session-chrome.ts` | `SessionChromeView.defaultRoutingPlan` | 新增字段 | interface 加 `defaultRoutingPlan: { planId: string; planName: string } \| null` | MUST 同构（字段恒在）；academy 恒 null | api 04a §2 同构承诺 | +3 |
| server/chrome | 同上 | `buildSessionChrome` | 修改 | 三 kind 分支各补方案投影：playground 读 `getPlaygroundPlanId(appConfig)` + `getPlan` 反查 name；studio 读 `squad.modelRoutingPlanId` + `getPlan` 反查；academy 恒 null。方案被删（getPlan 返 undefined）→ null | MUST 与 `resolveModelRoutingPlan` 同口径（显示==实际）；MUST NOT throw（降级 null）；MUST NOT 改现有 defaultModel 逻辑 | model_routing §2.2 挂载语义；api 04a §3.2 | +20 |
| server/chrome | 同上 | import | 新增 | `import { getPlan, getPlaygroundPlanId } from './model-routing-store'` | MUST 复用既有函数，禁重造 | model-routing-store.ts L33/L110 | +1 |
| api/spec | `specs/api/overall/04a-session-chrome.md` | §2 shape + §3.2 数据源映射表 | 修改 | `SessionChromeView` 补 `defaultRoutingPlan` 字段；§3.2 表加方案列（playground→model_routing.default.playgroundPlanId；studio→squad.modelRoutingPlanId；academy→null） | MUST 保持同构承诺措辞 | 本 plan D1 | +8 |
| web/api | `app/web/src/lib/chat-api/session-api.ts` | `SessionChromeView.defaultRoutingPlan` | 新增字段 | 前端 view 形状同步加字段 | MUST 与 server 形状一致 | api 04a §2 | +2 |
| web/picker | `app/web/src/components/chat-page/component-input-model-picker.tsx` | `InputModelPickerProps.defaultPlan` | 新增 prop | 加 `defaultPlan?: { planId: string; planName: string } \| null` | MUST optional（默认 undefined 不影响既有消费方） | 本 plan D2 | +4 |
| web/picker | 同上 | `hasPlan` / `hasDefaultRoute` | 新增 | `hasPlan = defaultPlan != null`；`hasDefaultRoute = hasDefault \|\| hasPlan` | MUST 纯推导无副作用 | 本 plan D2 | +3 |
| web/picker | 同上 | hover preview 分支 | 修改 | `isReservedDefault && hasDefault` 保持；插新分支 `!hasDefault && hasPlan` → `t('planDefaultLabel',{name})`；`!hasDefaultRoute` → 未配置 | MUST 方案优先于「未配置」；MUST NOT 改具体模型分支 | 本 plan D2；ui spec §3 | +6 |
| web/picker | 同上 | `extraTopItems` | 修改 | 条件 `hasDefault` → `hasDefaultRoute`；方案态 label=`t('planDefaultLabel',{name})`，onClick 复用 `{providerId:'',modelId:'default'}` | MUST onClick 写回复用保留字（后端零改动）；MUST NOT 改模型态项 | 本 plan D2；use-chat-chrome L102-114 | +8 |
| web/input | `app/web/src/components/chat-page/component-chat-session-input.tsx` | `<InputModelPicker>` 接线 | 修改 | 传 `defaultPlan={chrome.defaultRoutingPlan ?? null}` | MUST 只加一行 prop；MUST NOT 动其他 props | 本 plan D3 | +1 |
| web/i18n | `app/web/src/i18n/locales/zh-CN/chat.json` + `en/chat.json` | `planDefaultLabel` | 新增 key | zh:`方案 · {{name}}（默认）`；en:`Plan · {{name}} (default)` | MUST 新增不删旧；MUST 双语 | 本 plan D4 | +4 |
| ui/spec | `specs/ui/components/chat-page/component-input-model-picker.md` | §3 三态表 + 职责 | 修改 | 补第四态「default + 挂方案」行；职责补方案维度默认语义 | MUST 消费方表不动 | 本 plan D2 | +4 |
| test/server | `app/server/src/services/__tests__/session-chrome.test.ts` | 方案投影 UT | 新增 | 2 例：playground 挂方案→defaultRoutingPlan 有值+defaultModel null；studio 挂方案→同；方案被删→null | MUST 构造含 modelRoutingPlanId 的 mock squad / model_routing appConfig | 本 plan D1 | +30 |
| test/web | `app/web/src/components/chat-page/__tests__/component-input-model-picker.test.tsx` | 方案态 hover/菜单 UT | 新增 | 2~3 例：方案态 hover 显「方案 · 名（默认）」；菜单顶部有默认项；点默认项 onChange({providerId:'',modelId:'default'}) | MUST 用 initI18n 真实 resources | 本 plan D2 | +40 |

## 4. 影响面评估

- **跨模块**：server(chrome) + api spec + web(picker/input/api) + i18n + UT。纯增量，无破坏性变更。
- **同构承诺**：新增字段恒在（academy 恒 null），不破坏 api 04a §1 同构契约（字段集恒定，kind 间只差值）。
- **依赖顺序**：server chrome 投影（底层）→ api spec → web 前端（上层）。单 task 串行即可。
- **风险点**：
  - `buildSessionChrome` 是 hot path（每次 chrome 拉取），方案反查 `getPlan` 是 `svc.get` 内存/磁盘读——与现有 `defaultModel` 读取同量级，无性能风险。
  - 方案被删 → `getPlan` 返 undefined → 降级 null，与 resolve 同口径，不 throw（chrome 装饰语义）。
  - picker 是 academy 消费方之一（component-tuple-cards.tsx）——`defaultPlan` optional，academy 恒 null，零影响。
- **不做**：不改写路径（PUT /session/:id 保留字链路零改动）；不改 ModelOrPlanPicker（配置侧互斥双向清已完整）；不改 demo；token-usage 留 BUG。

## 5. 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder。
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计。
- i18n 收敛可选项（D4）做了需在 change_log 记偏离。
