# v0.0.356 Squad Member 余额查询快捷入口（弹层）

> 状态：待老板确认（leader 12:49 转正式 PRD）→ 确认后走架构
> 基线：demo v2 终态 `specs/prd/squad-quota-entry-demo-v2.html`（commit 3e659be67）
> 拍板历史：11:07 需求提出（v1）→ 12:18 两态卡片拍板（v2）→ 12:29 双档余量+时间单单位 → 12:40 双档左右排列+环上字下 → 12:49 demo 通过转 PRD

## 1. 产品概述

**场景**：squad 挂载模型路由方案后，member 在对话页想快速知道「现在谁在工作、各家余量还剩多少」，不想跳设置页。

**方案**：member 对话右侧功能区（chat float menu）加「余额查询」入口（todo 上方倒数第二位），点击弹层展示：当前方案每个 provider 的合并状态点（时间+熔断三态）+ 双档余量（5 小时/周）。卡片两态：**收起窄卡**（默认，含双环速览）+ **展开替换层**（大卡详情）。

**价值**：对话内一眼看清方案健康状况与余量水位；熔断发生时直接看到剩余倒计时。

## 2. 功能需求

### 2.1 入口（chat float menu 第 6 项）

- **位置**：插在「团队状态」与「待办」之间（todo 上方，倒数第二位）；菜单项样式同既有项（32×32 图标、muted、hover fg）。
- **badge**：无数字 badge（无计数语义，对齐 skills 项无 badge 先例）。
- **渲染条件**：有 squad 上下文且已挂载方案（`SquadDetail.modelRoutingPlanId` 非空）才渲染入口；未挂载 → 不渲染（fail-safe，对齐 squad-status 项「无 Provider 不渲染」先例）。
- 图标形态：由设计/实现阶段定（demo 用 🔋 示意）。

### 2.2 弹层壳

L3 modal，对齐 todo/cron modal 壳：Portal + 遮罩 `rgba(30,25,20,0.45)` + backdrop-blur + 内容壳 720px / r14 / head（标题「模型方案额度」15px bold + 关闭钮）+ body overflow-y-auto。顶部方案信息栏：当前方案名 + 四色图例（🟢 工作中 / 🔴 熔断 / 🟠 观察中 / ⚪ 不在时间内）。

### 2.3 收起态窄卡（默认态）

每个 provider 一张窄卡，结构（左→右）：**状态点 + 头像（色块/首字）+ provider name / model（两行）+ 双档双环 + chevron**。

- **双档双环**：「5小时额度」「周额度」两组**左右并列**；每组内**环在上、标签在下**。
- 每组两环：**左环=用量百分比**（圈内数字精确 1%；烧快时环变琥珀色）；**右环=重置时间进度**（圈内数字=剩余重置时间）。
- **时间单单位规则（固化）**：圈内只显最大单位整数——≥1 天→`X天`；≥1 小时→`X小时`（不携分钟）；<60 分→`Xm`；<1 分→`0min`。
- **无周限额套餐**（如 MiniMax）：小卡只显「5小时额度」一组。
- **余额型 provider**（DeepSeek 按量付费）：无环，直接显示余额金额 +「充值余额」标签。
- 默认全部收起；点击卡片任意处切换展开/收起（卡片间独立 toggle，非手风琴）。

### 2.4 展开态（替换层）

展开**替换**收起窄卡（同卡片内二态切换），内容 = v1 大卡重排：

- **卡头**：状态点 + 头像 + **主标题 = provider name / model** + 套餐徽标；**副标题 = 套餐名**（如「Kimi Coding Plan」）；**base url** = 副标题下 mono 小字行。
- **item 行**（该 provider 下方案条目）：状态点 + 模型名（mono 徽标）+ 时间条件（`02:00-23:00 · 当前命中` / `不限时` / `00:00-08:00 · 当前未命中`）+ 状态词；熔断时附倒计时（`42 秒后自动重试`），half-open 附「半开探测中」。
- **额度详情**（v2 双柱，同模型页额度总览视觉）：每档一组「已用柱（黑/琥珀）+ 时间进度柱（灰）」+ 重置文案（`重置 周六 16:26 · 剩 5 小时 19 分`）；烧快档琥珀柱 + `⚠ 消耗偏快` 徽标。
- **余额型**：展开态大字金额（`¥ 9,118.81`），无柱。
- 展开态内时间文案可用完整格式（`5 小时 19 分`）；单单位规则仅约束收起态环内数字。

### 2.5 状态点合并规则（四态，固化）

「模型是否在时间内 + 熔断器状态」合并为单点：

| 条件 | 点色 | 状态词 | 附加 |
|---|---|---|---|
| 时间未命中（hours 不含当前） | 灰白 | 不在时间内 | 不参与路由 |
| 在时间内 + Closed | 🟢 绿 | 工作中 | — |
| 在时间内 + Open | 🔴 红 | 熔断 | 剩余倒计时（秒级） |
| 在时间内 + HalfOpen | 🟠 橙 | 观察中 | 半开探测中 |

- **状态词口径**：按 demo 现状「工作中/熔断/观察中/不在时间内」（老板多轮看 demo 未提异议；与模型页 D16「正常/异常/观察中」为不同场景并存呈现，UI 层各自映射，不做统一改造）。
- **停用条目**（enabled=false）：弹层内不展示（demo 现状；停用条目不参与路由）。

### 2.6 数据面

**只读弹层**，无写操作。数据组合（**全部复用既有 API，无新端点**）：

| 数据 | 来源 | 用途 |
|---|---|---|
| 挂载方案 id | `GET /squad/:id` → `modelRoutingPlanId`（11a §1.3） | 入口渲染条件 + 数据定位 |
| 方案 items | `GET /config/app?group=model_routing_plans`（21 §2.1） | provider/model/priority/hours → 卡片分组、时间条件、状态点 |
| 熔断状态 | `GET /model-routing/plans/:planId/status`（21 §2.6） | circuitState/remainingSeconds → 四态点 + 倒计时 |
| 额度/余额 | `GET /provider/quota`（02-llm-chat §5.6，v0.0.350） | QuotaSnapshot：kind quota/balance、tiers、balance、isAvailable → 双环/双柱/金额 |

- **刷新策略**：弹层打开即拉取全量四源；弹层开着期间每 5 分钟自动刷新（复用 v0.0.350 use-quota-polling 语义）；弹层关闭即停轮询。
- **失败保留**：任一源拉取失败保留上次成功值（LastGoodSnapshot 语义），底部脚注 `上次更新 HH:mm · 每 5 分钟自动刷新 · 失败保留上次成功值`；熔断中 provider 的额度沿用上次成功值（红点与正常双环可共存）。
- **倒计时**：Open 剩余秒数秒级跳动仅展示层 setInterval 驱动，不产生网络请求。
- **无周限额**：QuotaSnapshot tiers 无周档 → 小卡/大卡只渲染 5 小时档。

### 2.7 i18n 与无障碍

- 文案走 chat ns：`floatMenu.quota`（aria-label「余额查询」）、状态词、档位标签「5小时额度/周额度/充值余额」、图例、脚注。
- 环形进度加 `role="progressbar"` + aria-label（provider+档位+已用%）；卡片切换按钮语义（aria-expanded）；状态点附 aria-label（颜色不唯一承载信息，状态词并陈）。

## 3. E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|---|---|---|
| UC-1 | 打开已挂载方案的 squad member 对话 → 看右侧功能区 | 「余额查询」入口在团队状态与待办之间，无数字 badge |
| UC-2 | 未挂载方案的 squad 对话 → 看右侧功能区 | 无「余额查询」入口 |
| UC-3 | 点击入口 | 弹层开（L3 modal 壳）：方案名 + 四色图例 + 各 provider 收起窄卡 |
| UC-4 | 浏览收起窄卡 | 状态点颜色正确（绿/红/橙/灰白四态可辨识）；双档左右排列、环上字下；环内时间为单单位格式 |
| UC-5 | 点击某卡片 | 替换为展开大卡：主标题 provider/model、副标题套餐名、base url、item 行、双柱详情 |
| UC-6 | 再点该卡片 | 收起回窄卡；其他卡片展开态不受影响（独立 toggle） |
| UC-7 | 看 DeepSeek 卡 | 无环，直接金额 +「充值余额」；展开态大字金额无柱 |
| UC-8 | 看 MiniMax 卡 | 只显 5 小时档一组（无周限额） |
| UC-9 | 看熔断中 provider（红点） | 收起态状态词「熔断」；展开态 item 行有倒计时；额度仍显示（上次成功值） |
| UC-10 | 弹层停留 5 分钟以上 | 自动刷新；脚注「上次更新」时间更新；失败时保留旧值 |

## 4. 关键用户路径（测试最低覆盖要求）

- **P-A 小卡浏览**：入口点击 → 弹层开 → 默认全部收起 → 逐卡浏览：四状态可辨识（绿工作中/红熔断/橙观察中/灰白不在时间内）、双档左右排列环上字下、时间单单位、余额型金额形态、无周限额单档形态。
- **P-B 展开详情**：点击卡片 → 替换大卡（主标题 provider/model + 副标题套餐名 + base url + item 行 + 双柱）→ 再点收起；卡间独立 toggle 互不影响。
- **P-C 余额型形态**：DeepSeek 卡收起态金额 +「充值余额」；展开态大字金额、无环无柱。
- **P-D 刷新与容错**：弹层开着 5 分钟自动刷新；源失败保留上次成功值不空白；熔断倒计时秒级跳动。

## 5. 验收标准

1. 入口位置/无 badge/渲染条件（未挂载不渲染）符合 §2.1。
2. 弹层壳与 todo-modal 同款 L3 样式（720px/r14/遮罩），方案栏 + 图例齐全。
3. 收起窄卡：状态点四态映射正确（时间命中 × circuitState 组合全覆盖）；双档左右排列、环上标签下；环内数字符合时间单单位规则四分支（≥1天/≥1h/<60m/<1min）。
4. 展开态：主副标题正确（provider/model 为主、套餐名下沉）、base url 展示、item 行时间条件与状态词正确、双柱视觉对齐模型页 v2（烧快琥珀 + 徽标 + 重置文案）。
5. 余额型无环无柱只显金额；无周限额套餐只显 5 小时档。
6. 展开/收起独立 toggle，默认全收起，替换层语义（非追加）。
7. 刷新 5 分钟 + 失败保留上次成功值 + 倒计时纯前端跳动零网络。
8. i18n 全量 chat ns（无硬编码中文）；环/卡片 aria 达标。

## 6. 非目标

- 弹层内不做任何写操作（不切方案/不停用条目/不刷新额度强制按钮）。
- 不做 provider 管理或跳转设置页。
- 不替代模型页额度总览（specs/prd/v0.0.352-quota-overview-v2.md 为主视图，本弹层为 squad 场景速览剪裁版）。
- 不统一改造模型页 D16 状态词（两场景各自映射并存）。

## 7. 引用

- demo 终态：`specs/prd/squad-quota-entry-demo-v2.html`（3e659be67，三轮拍板视觉契约）；v1 对比 `squad-quota-entry-demo.html`
- 入口组件：`specs/ui/components/chat-page/component-chat-float-menu.md`（第 6 项扩展）
- 弹层壳基准：`component-todo-modal.md`；额度视觉：`specs/prd/v0.0.352-quota-overview-v2.md`（v2 双柱）
- API：`specs/api/overall/21-model-routing.md` §2.1/§2.6、`02-llm-chat.md` §5.6、`11a-squad-endpoints.md` §1.3
- UI spec：`specs/ui/components/chat-page/component-quota-entry-modal.md` + `component-quota-provider-card.md` + `component-quota-ring.md` + `use-squad-quota.md` + `specs/ui/components/providers/quota-format.md` + `component-coding-plans-quota-footer.md`（TierBars 复用）

## 8. 编码后 Bug 与修复记录

### BUG-356-1：展开态档位标题+重置文案重复渲染

- **发现**：ET-356 视觉复验 SMALL（commit `fc5d66d0b`）：展开 minimax 大卡后，档位标题与重置文案各出现 2 次（DOM 铁证 `fiveHourTitleCount=2, weeklyTitleCount=2, resetCount=4`）。
- **根因**：`component-quota-provider-card.tsx` 的 `ExpandedTier`（L234-246）自己渲染档位标题+重置行后，又调用 `TierBars`（L247），而 `TierBars`（`component-coding-plans-quota-footer.tsx` L158，v0.0.356 D8 复用导出）内部（L167-182）再次渲染标题+重置行 → 双层重复。
- **修复**：commit `ea75d49dc`——`ExpandedTier` 去掉自身标题/重置行，只保留 `TierBars` 调用；视觉复验 V1-V7 全部 PASS（commit `640b315e8`）。
- **影响面**：仅展开态视觉冗余；收起态、数据流、i18n、UT/AT 均无影响。
- 概念上游：模型路由方案（v0.0.347）、native coding plans 额度（v0.0.350）

## 9. 数据源演进追记（v0.0.363，doc-modifier）

> 版本轴历史不改写上文；演进在此追加。

本版（356）弹层的额度数据源 = `fetchProviderQuota()` 现拉 + 5min 轮询。**v0.0.363 起刷新语义演进**：`use-squad-quota` 的 quota 源换 `useProviderQuotaStore` 共享 hook——挂载 GET store 秒开（server QuotaStore 权威源）+ 打开触发 `POST /provider/quota/sync` 增量 + SSE `provider_quota` 帧刷新，额度轮询删除；方案库/熔断/provider 元数据三低频源轮询保留。弹层交互形态与视觉零变化。详见 `specs/tech/version_logs/v0.0.363/change_log.md`。
