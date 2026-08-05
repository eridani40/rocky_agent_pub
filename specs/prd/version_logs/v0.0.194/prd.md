# v0.0.194 PRD — squad token 用量统计入口

> 版本主题：squad 团队/成员 LLM token 流量可视化（by 天/小时、by 类型 输入/输出/缓存/缓存率，日历热力 + 时间轴堆积图）
> 引入版本：v0.0.194 · 状态：PRD 待用户确认
> 概念权威源：`specs/ui/overall/06-studio.md`（Studio 页面契约）+ `specs/ui/components/studio-page/`（组件 spec）+ `specs/tech/persistence/index.md`（SchemaDef/CrudStore/Engine 存储体系）+ `specs/prd/overall/08-squad-studio.md`（squad 产品文档）
> demo（已落地验证形态）：`app/web/src/components/studio-page/__token_stats_demo__/`（mock 数据，正式版改造基础）
> 本版无独立设计稿：demo 形态即视觉参考；按 `_conventions.md §9` 视觉保真 compare 跳过

---

## 1. 背景 + 目标

### 1.1 背景
squad 团队的 LLM token 消耗当前只在坐席面板左列 `SeatStats` 2×2 格中以「已用 token」单值呈现（取 `GET /squad/:id/budget/usage` 当日窗口近似值，无历史落表）。用户无法看清「谁在烧 token / 烧在哪类（输入/输出/缓存）/ 什么时段烧 / 缓存命中率如何 / 历史趋势怎样」。

### 1.2 目标
在 squad seats 页头部 tab 条右侧新增「Token 统计」入口，提供**团队级 + 成员级**的 token 流量可视化，支持按时间（天/小时）+ 类型（总/输入/输出/缓存/缓存率）维度切换，日历热力 + 时间轴堆积双视图，hover 看明细。统计写入走异步事件、不阻塞主流程；存量历史数据从 transcript/run 复原。

### 1.3 用户故事
- 作为**团队管理者（用户）**，我希望一眼看到整队 token 流量趋势 + 缓存命中情况，以便评估成本与缓存策略效果
- 作为**团队管理者**，我希望下钻到单个 member 看「谁烧得多 / 烧在哪类 / 什么时段集中」，以便定位异常消耗
- 作为**团队管理者**，我希望看到历史数据（迁移后），以便回溯对比

---

## 2. 功能需求

### 2.1 入口位置 [v0.0.194]

**位置**：squad seats 页（`SeatsPanel`）头部 tab 条（坐席 / 管理 / 自动工作）**右侧** `ml-auto` 处，新增「Token 统计」入口按钮（图标 + 文案）。点击 → `MainView` 切到 `token-stats` kind（**独立路由态**，与 board / panorama 同范式），头部显返回键退出。

**对齐 UI spec**：入口挂在 SeatsPanel 头部 tab 条右端（`06-studio.md §2.3` 的 `seats-header` = 团队名 + `seats-online-badge` + `seats-tab-{seats|panel|autowork}`）；点击后主区切独立路由态 `MainView {kind:'token-stats'; squadId}`（由 v0.0.168 `{seats\|board\|chat\|member\|member-create}` + v0.0.189 `panorama` 扩展，新增 `token-stats` kind），与 board（`board-topbar-back-btn`）/ panorama 同范式——**非 seats tab 主体覆盖**，不影响 tab 语义。

**交互**：
- 点击入口 → 进入 token-stats 独立视图（主区切 `MainView {kind:'token-stats'}`，渲染统计视图容器）；入口按钮呈激活态（深底反白）
- 头部返回键（视觉复用 `ChatTopbarBackBtn` primitive，与 board-topbar-back-btn 同款）→ 退出回首页 seats
- 切其他 nav（侧栏 squad / nav-rail）→ 自然离开 token-stats 路由态（与 board/panorama 行为一致）

**E2E Use Cases（入口）**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-0 | 进入 squad seats 页 → 看到 tab 条右侧「Token 统计」按钮 → 点击 | 主区切到 `MainView {kind:'token-stats'}` 独立路由态（头部返回键 + 统计视图：控制条 + 汇总条 + 主图）；按钮激活态 |
| UC-0b | token-stats 路由态 → 点头部返回键 | 退出路由态，回首页 seats；按钮恢复常态 |

### 2.2 统计维度（4 组切换 + 1 日期） [v0.0.194]

控制条（统计视图顶部）含 4 组控制 + 单日粒度下的日期选择，全部对齐 `_conventions.md §10`（禁原生 select，用自定义下拉/chip）+ §11（尺寸恒定，状态切换不跳动）。

| 维度 | 取值 | 控件 | 说明 |
|------|------|------|------|
| **粒度 Granularity** | `day`（跨天，每点=1 天）/ `hour`（单日，每点=1 小时） | 2 段 chip | 跨天=日序列；单日=选中日的 24h 序列 |
| **范围 Scope** | `__team__`（整个团队=Σ 所有 member）/ 单个 `memberId` | 自定义下拉 | 列表第 1 项「整个团队」+ 本 squad 全 member（标 leader「队长」） |
| **类型 Kind** | `total`（总览=三段和）/ `input` / `output` / `cache` / `cacheRate`（缓存率） | 5 段 chip | 前 4 类为 token 量（单位 M）；cacheRate 是比率（单位 %），Y 轴/色阶按 kind 区分口径 |
| **视图 View** | `calendar`（日历热力）/ `timeline`（时间轴堆积图） | 2 段 chip | calendar 仅跨天粒度有意义；单日 + calendar 显空态引导切时间轴 |
| **日期 Date**（仅 `hour` 粒度显） | `YYYY-MM-DD` | date input | 选中日的 24h 序列；默认选中今天 |

**单位口径（用户裁决，MANDATORY）**：
- token 数一律 **M**（÷1,000,000）：`<0.01M` 显 `<0.01M` 兜底；`<1M` 显 2 位小数；`<100M` 显 1 位小数；`≥100M` 显整数
- **缓存率** = `cache / (cache + input) * 100`（分母**不含** output），单位 **%**，1 位小数（去尾 0）；分母 ≤0 显 `0%`

**E2E Use Cases（维度切换）**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 打开统计视图（默认 team + day + total + timeline）→ 看汇总条 + 时间轴 | 显示团队近 N 天总览堆积图 + 合计量 |
| UC-2 | 切 Scope：整个团队 ↔ 某 member | 主图/汇总条切换为该 member 的数据；team 视图额外显团队口径说明条 |
| UC-3 | 切 Granularity：跨天 ↔ 单日 | 跨天=日序列点；单日=24h 点（显日期选择） |
| UC-4 | 切 Kind：总览 ↔ 输入/输出/缓存 ↔ 缓存率 | 主图按类型重绘；cacheRate 切换 Y 轴/色阶口径为比率 |
| UC-5 | 切 View：日历 ↔ 时间轴 | 日历=月历热力色块；时间轴=横坐标堆积柱 |

### 2.3 视图形态 [v0.0.194]

#### 2.3.1 日历热力视图（`calendar`）
- **结构**：按月分组（跨月时多月卡），每月一张 7 列日历表（周一首列），每天一格色块
- **色深**：按 `value / max` 归一到 4 档透明度阶梯（0.15 / 0.35 / 0.55 / 0.8）；0 值透明
- **着色**：token 类（total/input/output/cache）用 hue-blue 基底；cacheRate 用 hue-amber 基底（绝对 0-1 作色阶，max=1）
- **格内**：日期数字（周末弱化）+ 右下角值（cacheRate 显 `%`，token 类显 M）
- **图例**：色阶图例「少 ▢▢▢▢ 多」
- **边界**：单日粒度（`hour`）+ 日历组合 → 显空态引导「切到时间轴查看 24h 分布」（demo 沿用，正式版保留此引导）

#### 2.3.2 时间轴堆积图（`timeline`）
- **结构**：横坐标=时间点（跨天=`M/D` 日序列 / 单日=`0-23` 小时序列），纵坐标=堆积色块
- **堆积分段**：按 input/output/cache 三段堆叠（各段颜色同 `kindColor` 映射：input=hue-blue / output=hue-violet / cache=hue-green）
- **Y 轴**：按 kind 区分——token 类（total/单类）显 token 量刻度（漂亮步长 0.25/0.5/1/5/10M）；cacheRate 显 0-100% 刻度
- **kind 切换影响**：`total` → 三段堆积；单类（input/output/cache）→ 仅该段；`cacheRate` → 折线/单柱比率（非堆积）

#### 2.3.3 汇总条（统计视图顶部，主图之上）
- **合计**：当前序列 token 总量（M）+ 轴标签（如「近 60 天」/「M/D 24h」）
- **三段占比**：input / output / cache 各显色块 + label + 量（M）+ 占比 %
- **团队口径说明**（仅 `scope=team` 显）：「团队口径：总量 = Σ 所有 member 的 usage（leader + mate）；subagent 消耗已隐含计入其 parent member」

#### 2.3.4 hover 明细（`createPortal` 浮层 + native title 兜底）
hover 任一数据点（日历格 / 时间轴柱）→ 浮层显明细：
- `kind=total` → head（日期/时段）+ 总体 / 输入 / 输出 / 缓存 / 缓存率 **5 行**
- `kind=cacheRate` → head + 缓存率 **1 行**（%）
- `kind=单类 token` → head + 该分项 **1 行**（M）

浮层走 `createPortal` 脱离 overflow 裁剪（demo 已修此问题）；native `title` 作同口径兜底。

### 2.4 团队聚合口径（MANDATORY） [v0.0.194]

- **团队 = Σ 所有 member 的 usage**（不能只取 leader）—— 校验：Σ 各 member session 全部消耗 ≈ 团队总量
- **subagent 已统计给 parent**：member session 的 usage 已含其调用的 subagent 消耗 → 每个 member session 全部消耗加总 = 该 member 真实消耗，无需额外统计 subagent
- **mate 不统计给 leader**：mate（同级成员）消耗不归 leader session → 团队总量必须 Σ 所有 member，**不能从 leader session 读**

> 此口径在 PRD 与 demo mock 数据中均须遵循；架构阶段须设计「session→member 归属 + 团队求和」查询逻辑对齐此口径（context.md 标注「session→member 映射待查」为架构前置）。

### 2.5 数据来源 + 存储 + 异步写入（产品层口径） [v0.0.194]

> 技术实现（schema 字段 / SQLite engine 扶正 / 迁移步骤 / 事件挂载点）归架构 change_plan；PRD 只写产品层要求。

- **新用量写入 = 异步事件**：每次 LLM 调用产生的 usage（已有 `RunSchema.usage` + `SessionSchema.usage` 落库链路）**额外**通过异步事件写入时序表；**写入失败不阻塞主流程**（LLM 调用、对话、agent loop 不受影响）
- **持久化时序存储**：用量按「member × 时间桶（天/小时）× 类型」聚合后落入时序表（项目 schema store 体系内的 SchemaDef，engine 由架构评估）；查询走该时序表，不在运行时重算 transcript
- **不破坏主流程**：统计是新时序聚合层 + 异步写入，**非补采集**——usage 本地落库链路（`accumulateUsage`/`persistUsage`/`notifyUsageChanged`）不动，统计挂同款 `ReplayableEventBus`

### 2.6 历史数据 migration（不做 — 最终决策，用户核实无精确数据源） [v0.0.194 modified]

> **最终决策（覆盖早期「兜底」提案）**：migration 不做。token_usage_stat 从空表开始，subscriber 从上线后统计新数据（首见记 0，不灌历史累计）。

**真相查证**（用户实测 + 代码确认）：
- `persistUsage`（session-store-usage-impl.ts:188）只有 `runUsage` 传入才写 `run.usage`，用户实测 run JSON **无 usage 字段** → 实际没落（调用没传 runUsage），`RunSchema.usage` 无数据
- usage 流式 emit UsageBlock，但 message/transcript **不持久化**（前端不渲染，过滤）
- `SessionSchema.usage` 只有累计总量（三分区），**无 per-call 时间分布 + 无 model 维度**

→ migration（遍历 run 复原）**无精确数据源** → 不做。详细见 `specs/tech/persistence/[P1]token_usage_stat.md §6`。

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

每条路径 ≥1 case 覆盖（AT/UT 为主；ET 按冒烟集原则评估，本版属「普通 feature 不新增持久 AT/ET case」——版本验证 = 冒烟集回归 + UT，除非架构阶段识别出「新 LLM 不确定性场景」）。

| # | 路径 | 验证层 | 说明 |
|---|------|--------|------|
| P1 | 点 token 统计入口 → 看团队近 N 天用量（默认视图 team+day+total+timeline） | ET/UT | 入口可见 + 默认视图呈现 + 汇总条/主图渲染 |
| P2 | 切 Scope（整个团队 ↔ 单个 member） | UT | 数据切换正确，team 显口径说明条 |
| P3 | 切 Granularity（跨天=每天 1 点 ↔ 单日=每小时 1 点） | UT | 序列点数 + 日期选择显隐 |
| P4 | 切 Kind（总览/输入/输出/缓存/缓存率） | UT | 主图重绘 + cacheRate 切比率口径 |
| P5 | 切 View（日历热力 ↔ 时间轴堆积图） | ET/UT | 双视图均渲染正常 |
| P6 | hover 看明细（总体 5 行 / 分项 1 行 / 缓存率 1 行） | UT | 浮层口径正确（含缓存率） |
| P7 | （存量）迁移后看历史数据 | UT/AT | 时序表有回填数据 + 总量准确（兜底时间可能失真） |

**额外路径（数据层，非用户直接操作但须验证）**：
- P8（异步写入）：新 LLM 调用 → usage 异步落时序表 → 查询可见；写入失败不阻塞 LLM（UT/AT）
- P9（团队口径）：Σ 各 member session 消耗 ≈ 团队总量（UT，守口径不变量）
- P10（不破坏主流程）：统计链路异常 → 主对话/agent loop 正常（UT）

---

## 4. 界面要素 + 视觉契约 [v0.0.194]

### 4.1 入口按钮
- 视觉：`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12.5px] font-medium`；图标=简易柱图 SVG（13×13，currentColor）
- 状态：常态 `border-border bg-surface text-fg hover:bg-surface-2`；激活态（统计视图打开）`border-fg bg-fg text-surface`（深底反白）

### 4.2 视觉系统（复用 regulation hue palette）
- 配色（demo 已对齐 `tokens.css`）：input=`--hue-blue` / output=`--hue-violet` / cache=`--hue-green` / cacheRate=`--hue-amber`
- 银灰 token：`--bg`/`--surface`/`--fg`/`--border` 与全站一致（详见 `specs/ui/regulation/01-tokens.md`）
- 字体：数字 `font-mono`；label `text-muted`/`text-muted-2` 弱化

### 4.3 组件 spec 落地（新概念 → coder 编码前置）
本版引入新 UI 概念（token 统计视图），按「先 spec 后实现」原则，coder 编码前置产出/更新 `specs/ui/components/studio-page/` 组件 spec（标准见 `_conventions.md`）：
- `component-token-stats-panel.md`（统计视图容器：控制条 + 汇总条 + 主图切换 + 口径说明）
- `component-token-stats-controls.md`（4 组控制 + 日期）
- `component-token-stats-calendar.md`（日历热力）
- `component-token-stats-timeline.md`（时间轴堆积图）
- `component-token-stats-tooltip.md`（hover 明细浮层）

> 新 testid 族建议：`token-stats-entry`（入口按钮）/ `token-stats-panel`（视图根）/ `token-stats-controls` / `token-stats-summary` / `token-stats-{granularity|scope|kind|view}` + `-{value}` / `token-stats-scope-{trigger|list|opt-{team|memberId}}` / `token-stats-calendar` + `-cal-cell-{dateKey}` / `token-stats-timeline` + `-point-{idx}` / `token-stats-date`（date input）。最终命名以 coder 组件 spec 为准。

---

## 5. 设计决策（用户 2026-07-23 确认，不推翻） [v0.0.194]

1. **存储方案 = schema store 时序表（SQLite engine 由架构评估扶正），不引入 MySQL**：避免与现有体系正交的新维度 + packaged 内嵌不了 MySQL 的代价；用 schema store 加 SchemaDef 做 `token_usage_stat` 时序表
2. **团队口径 = Σ 所有 member**（含 leader + mate，subagent→parent 已含，mate 不→leader）—— 不能只取 leader
3. **缓存率 = cache / (cache + input)**，分母不含 output，单位 **%**；token 数单位 **M**（÷1,000,000）
4. **存量迁移 = transcript/run 复原**（最差兜底历史量记迁移时刻，时间失真但总量准确）
5. **异步事件 = 不影响主流程**（写入失败不阻塞 LLM 调用）
6. **demo 形态即视觉参考**（本版无独立设计稿，视觉保真 compare 跳过；功能 PASS + 对齐既有 token 即验收）

---

## 6. 范围边界

### IN SCOPE（v0.0.194）
- seats 页 tab 条右侧 token 统计入口（独立路由视图 `MainView {kind:'token-stats'}`，头部返回键，IA 对齐 board/panorama）
- 4 维度切换（粒度/范围/类型/视图）+ 日期选择
- 日历热力 + 时间轴堆积双视图 + hover 明细 + 汇总条 + 团队口径说明
- 时序表 SchemaDef + 异步事件写入（engine 扶正归架构）
- 存量 transcript/run 复原 migration + 兜底
- 团队 Σ member 口径

### OUT OF SCOPE（明确排除，归架构或后续版本）
| 排除项 | 归属 | 理由 |
|--------|------|------|
| 时序表 schema 字段定义 / SQLite engine 扶正步骤 / bootstrap 装配 / packaged 注入 | 架构 change_plan | 技术实现层（持续可打包护栏评估） |
| 异步事件挂载点（`ReplayableEventBus` 订阅）+ session→member 映射查询 | 架构 change_plan | 技术实现层 |
| cost/费用维度（Usage 已有 cost 字段） | 后续版本 | 本版只做 token 量 + 缓存率；费用维度独立立项 |
| 单日粒度日历视图（小时热力） | 后续版本 | demo 显空态引导，本版切时间轴查看 24h |
| 时区配置 UI | 后续版本 | 默认本地时区（架构定）；时区切换 UI 独立 |

---

## 7. 非功能需求 [v0.0.194]

- **性能**：统计查询走时序表（已聚合），不在运行时重算 transcript；近 N 天（默认 60 天）+ 单日 24h 序列查询响应 < 500ms
- **可靠性**：异步写入失败不阻塞主流程（LLM 调用/对话/agent loop 不受影响）；时序表异常时统计视图显降级空态（不崩页面）
- **packaged 可打包**：engine 扶正须过持续可打包护栏（`runtime-config` 白名单 + 路径展开 + 依赖归属 + bootstrap 装配），dev 能跑 ≠ packaged 能跑
- **布局稳定性**：所有 toggle/switch 状态切换尺寸恒定（守 `_conventions.md §11`）；按钮 hover/激活不导致相邻元素位移

---

## 8. 验收口径 [v0.0.194]

- **功能**：P1-P10 关键路径全覆盖（UT 为主 + 必要 AT）；团队口径校验通过（Σ member ≈ team）
- **视觉保真**：本版无独立设计稿 → 视觉保真 compare 跳过；功能 PASS + 对齐既有银灰 token + hue palette 即验收
- **packaged**：engine 扶正后跑 packaged 版验证（后端起 + 统计端点 200 + 时序表非空），dev 全绿 ≠ packaged 可用
- **不破坏主流程**：统计链路异常 → 主对话/agent loop 正常（UT 守）
- **ET 范围**：按冒烟集原则，本版属「普通 feature」——版本验证 = 冒烟集回归 + UT；不新增持久 ET case（除非架构识别新 LLM 不确定性场景，届时评估一进一出）

---

## 9. spec 同步（本版 PRD 触发） [v0.0.194]

- `specs/prd/overall/08-squad-studio.md`：新增 §8.10 token 统计 + §8.7 承接表 v0.0.194 行 + §8.8 版本行（本 PRD 已规划同步）
- `specs/ui/overall/06-studio.md`：SeatsPanel 头部加 token 统计入口说明（coder/doc-modifier 阶段 5 同步）
- `specs/ui/components/studio-page/component-token-stats-*.md`：新组件 spec（coder 编码前置产出）
- `specs/tech/persistence/log.md` + 新 SchemaDef 文档：时序表 schema（架构产出）
- `specs/api/overall/`：统计查询端点契约（架构产出）
