# v0.0.240 PRD — squad task（轻量任务机制）+ 首页改造

> 版本主题：squad 内置轻量任务机制（task = panorama builtin entity，复用全景存储/渲染/工具，状态走 reminder 注入）+ Studio 首页改造（tab 改名 / token 小组件 / 成员计数 / 全景内嵌第二栏）
> 引入版本：v0.0.240 · 状态：PRD 待用户确认
> 概念权威源：`specs/ui/overall/06-studio.md`（Studio 页面契约）+ `specs/ui/components/studio-page/`（组件 spec）+ `specs/api/overall/14-panorama-endpoints.md`（panorama API）+ `specs/tech/squad/`（panorama DSL/校验/迁移）+ `specs/prd/overall/08-squad-studio.md`（squad 产品文档）
> 需求/调研：`reqs/[working] v0.0.240.squad_task/{req,research}.md`；现状 dump：`reqs/[working] v0.0.240.squad_task/dump/`；首页方向 demo：`reqs/[working] v0.0.240.squad_task/demo-home.html`
> 设计稿：`demo-home.html`（布局方向已和用户确认：kanban 任务 tab + token 小组件图文 + 归档开关）→ 按 `_conventions.md §9` 视觉保真 compare MANDATORY

---

## 1. 背景 + 目标

### 1.1 背景
- charter / okr / goal / requirement / board 已于 v0.0.237 全链路移除；panorama 现仅 DSL 动态 views + 「更多」tab，**无固定 tab、schema 纯 DSL**（leader 自搭）
- 用户原诉求：要一个**轻量**任务机制（参考 claude code 的 task），之前的 charter 之类太重
- panorama 三处前置债：① ViewDef 无 `filter` 字段（leader 在 view 写 filter 被静默忽略 → 「3 个 table 筛出一样」根因）；② entity 无归档字段（spec 写死「panorama 无归档」）；③ schema 纯 DSL，无固定 builtin 通道
- field 中文机制在（`field.label` + `display.{field}_labels`），但 leader DSL 常不配 → 英文 key 兜底
- reminder 注入机制现成：`SystemReminderPoint` + `context-ingest-pipeline` + `squad-reminder-deps`（squad 已在注入 squad/member reminder）

### 1.2 目标
- 给 squad 一个轻量、零新增专用工具的任务机制：task = **panorama builtin entity**（全景第一个固定 view），agent 用通用 panorama 工具操作
- task 状态走 **reminder 注入**（每轮/触发，非 system prompt 全量）让队员感知待办，依赖关系全自动（依赖结束自动解除 block）
- 改造 Studio 首页：tab 改名「坐席」→「首页」、4 宫格 SeatStats → token 小组件（点击进 token-stats）、roster 计数「坐席·N」→「成员·N」（N 减队长）、全景从二级页**内嵌为首页第二栏**
- 顺带补 panorama 三处前置债（view.filter / 归档 / builtin schema 通道）+ field 中文

### 1.3 用户故事
- 作为 **leader**，我希望有一个轻量任务机制跟踪队员待办，不必造重型工作流
- 作为 **mate**，我希望每轮工作时知道队里有哪些待办 task、哪些归我、哪些被依赖 block，不必去翻看板
- 作为 **用户**，我希望首页一眼看到 token 流量趋势（输入/输出/缓存 + 7 日趋势 + 累计/预算）+ 团队全景（任务一栏看到待办、归档可切）
- 作为 **agent**，我希望操作 task 不学新工具——继续用已在用的 panorama 工具

---

## 2. 关键设计决策（方案 A+，已和用户拍板）

| 决策 | 选择 | 理由 |
|------|------|------|
| task 形态 | **panorama builtin entity**（内置固定 schema，非 leader DSL） | 复用全景存储/渲染/工具，零新增专用工具层 |
| task 工具 | **不造专用工具**——agent 用通用 panorama 工具（create/transition/update，entity=task） | 避免「task 工具 vs panorama 工具」两套写入口之争；task 语义靠 schema 约束 |
| task 状态感知 | **reminder 注入**（挂 `SystemReminderPoint` provider，和 squad/member reminder 并列） | 非系统提示词全量；每轮/触发注入活跃 task 列表 |
| 状态机 | 4 态：**未开始 / 等待中 / 进行中 / 已结束** | 等待中 = 被依赖 block；**全自动**（依赖结束自动解除，非手动 transition） |
| 任务 tab 渲染 | **kanban 看板**（按状态分 **4 列**：未开始 / 等待中 / 进行中 / 已结束） | 复用全景 kanban 渲染；等待中**单独列**（一眼见 block，非并入未开始）——orchestrator 裁决覆盖原"3 列+徽标"案，按用户 demo 确认 |
| 归档 | **默认活跃视图**（过滤归档）+ 卡片「归档」按钮 + 「活跃 / 含归档」开关 | 默认清爽、需要时可查归档 |
| 全景位置 | **从二级页内嵌为首页第二栏** | 不再独立路由；首页 = 坐席 + 全景 一屏 |
| token 小组件 | 图文结合（今日三色比例条 + 7 日迷你柱 + 累计/预算进度），点击进 token-stats | 复用现有 token-stats 详情页 |

---

## 3. 功能需求

### 3.1 task = panorama builtin entity [v0.0.240]

**描述**：task 是 panorama 的第一个**固定 builtin entity**（非 leader DSL 搭、非 native 存储）。schema 全 squad 通用、固定：字段、状态机、归档由 builtin 通道定义（前置增强 §3.7）。

**字段**（builtin schema 固定，配死中文展示名）：
- `title` 标题（string，必填）
- `description` 描述（string，可空）
- `owner` 负责人（ref → member，可空=未指派）
- `dependencies` 依赖（ref[] → 其他 task id，可空）
- 状态字段：`status` ∈ {`todo` 未开始 / `waiting` 等待中 / `in_progress` 进行中 / `done` 已结束}
- 归档字段：`archived` boolean（默认 false）

**状态机**（transitions）：
- `todo → in_progress`（开始）
- `in_progress → done`（完成）
- `waiting ⇄ todo`（**自动**：依赖未结束 → waiting；依赖结束 → 回 todo）
- `done` 为 terminal（锁，不可再 transition）

**操作通道**：agent 用通用 panorama 工具操作（`create / update / transition / query`，entity=`task`），**不另造 task 专用工具**。

**优先级**：P0 · **用户故事**：作为 leader，我用 panorama 工具建 task 派给 mate，靠 schema 约束语义，不必新学工具。

#### E2E Use Cases（task builtin）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-T1 | leader agent 调 panorama 工具 `create entity=task {title, owner, dependencies?}` | task 实例创建；status 缺省 `todo`；dependencies 未结束 → 后端自动置 `waiting`；append `entity.created` + SSE 推送 |
| UC-T2 | 依赖 task `done` → 被依赖 task 自动从 `waiting` 回 `todo` | 全自动，非工具 transition；SSE 推送状态变更 |

### 3.2 task 状态 reminder 注入 [v0.0.240]

**描述**：挂 task provider 到 `SystemReminderPoint`（与 squad/member reminder 并列）。每轮/触发注入**活跃 task 列表**（仅未归档）。

**过滤口径**：
- **leader** 看全队活跃 task
- **mate** 按 `owner == 自己` ∪ `dependencies 含自己负责的 task` 过滤
- 只注入 `archived=false`

**注入时机**：复用现有 reminder 注入节奏（每轮/触发，非系统提示词全量）。技术挂载点见 context.md（`SystemReminderPoint` provider + `context-ingest-pipeline` 聚合）。

**优先级**：P0 · **用户故事**：作为 mate，我每轮工作前看到 reminder 告诉我归我的待办 + 我在等的 block，不必主动查。

#### E2E Use Cases（reminder 注入）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-R1 | leader 建 task A 派给 mate M → 触发 mate M 的下一轮 | M 的 reminder 段含 task A |
| UC-R2 | mate M 完成自己的工作 → reminder 仅剩未完成 task | 已结束 task 不再注入 |

### 3.3 首页改造 [v0.0.240]

**对齐 UI spec**：改造 `component-seats-body.tsx`（双列指挥台）左列三卡堆叠 + roster 头（06-studio §3.1）。全景内嵌第二栏 = 新增 `seats` 内联结构（不再独立路由态）。

#### 3.3.1 tab 改名「坐席」→「首页」
- SeatsPanel 头部三 tab 第一项文案改名（i18n key `studio:tabs.seats` → `首页`）；激活态/视觉规则不变（regulation 02 §8 下划线式）
- 三 tab 顺序保持：首页 / 管理 / 自动工作

#### 3.3.2 第一栏坐席区改造
左列（`seats-side` 296px）原三卡（队长 mini / SeatStats 2×2 / TeamEntryRow）改为：
- **队长 mini 卡**（保持现状 `SeatCard`，wrapper `seats-leader-row`）
- **token 小组件**（新组件，替代 SeatStats 2×2 格；见 §3.3.3）
- **去掉 TeamEntryRow**（业务全景 link 由第二栏全景 tab 取代；token 统计 link 改为 token 小组件点击入口）

右列 roster：
- roster 头计数文案「坐席 · N」→「**成员 · N**」，**N = 总人数 − 队长**（原 N 含队长）
- roster 体内 mate 行不变（`SeatRowView` × N）

#### 3.3.3 token 小组件（图文结合，点击进 token-stats 详情）
**布局**（白卡 `rounded-xl border p-3.5`，复用 token-stats 配色：input=hue-blue / output=hue-violet / cache=hue-green / 累计=hue-amber）：
- **今日**（label「今日」+ 三色比例条）：input / output / cache 三段，按当日各值占比填色条 + 各段量（M 单位，口径同 token-stats §2.2）
- **7 日趋势**（迷你柱状）：近 7 天每日总 token（input+output+cache）迷你柱（高 ~26px，色蓝→青渐变）
- **累计 / 预算**（进度条）：consumed / limit 比例条（hue-amber 渐变）+ 数字 `已用 M / 限额 M`；budget=null 显「不限量」
- **点击整卡** → 主区切 `MainView {kind:'token-stats'; squadId}`（复用现有 token-stats 路由态，头部返回键回首页 seats）
- **数据源**：复用 `getBudgetUsage` + token-stats 派生口吻；hover 整卡 box-shadow 反馈（无位移）

#### 3.3.4 第二栏全景内嵌（原二级页 → 首页第二栏）
- 首页底部追加「项目全景」栏（标题 + tab 条 + 工作面板）
- 删除原独立 panorama 路由态入口（`TeamEntryRow` 业务全景 link 已随左列去 TeamEntryRow 移除）
- 全景 tab 条 = 「任务」（固定第一，§3.4）+ DSL 动态 views 顺延 + 「更多」（仅动态为空时引导和 leader 聊天创建）

**优先级**：P0（tab 改名/token 小组件/全景内嵌 = P0；成员计数减队长 = P1）

#### E2E Use Cases（首页改造）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-H1 | 进 squad seats 页 → 看 tab 条第一项 | 文案「首页」（非「坐席」） |
| UC-H2 | 看左列 | 队长卡 + token 小组件（无 4 宫格、无 TeamEntryRow） |
| UC-H3 | 点击 token 小组件 | 主区切 token-stats 路由态（返回键回首页） |
| UC-H4 | 看 roster 头计数 | 「成员 · N」（N = 总人数 − 队长；含 leader 的旧口径废） |
| UC-H5 | 看首页底部 | 第二栏全景：tab 条「任务」+ 动态 views + 工作面板 |

### 3.4 全景固定「任务」tab（首页第二栏内嵌） [v0.0.240]

**描述**：在 DSL 动态 views 之前**固定加一个「任务」tab**（第一项）。task = builtin schema（固定，非 leader 搭）。

**渲染**：复用全景 kanban 渲染原语（`component-panorama-view` component=kanban）：
- 列 = task 状态机 **4 列**（未开始 / 等待中 / 进行中 / 已结束；等待中单独列，一眼见被 block 项）
- 列头色带 + 卡片左缘色条（v0.0.223 四通道编码沿用）；等待中列配色 hue-amber（block 警示）
- 卡片标题 = `title`，badges = owner avatar + 依赖计数 + archived 标
- 拖拽改状态（kanban + group_by=states.field）→ `POST .../transition`
- 卡片点击 → 弹 `component-panorama-entity-modal`（mode=edit）

**tab 装配顺序**：① 「任务」固定 tab（builtin schema） → ② DSL `schema.views` 动态 tab → ③ 「更多」tab（仅动态为空时）。「任务」始终首项、不可删。

**优先级**：P0 · **用户故事**：作为用户，我在首页第二栏直接看到队里任务流转，按状态分列、卡片可拖。

#### E2E Use Cases（任务 tab）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-P1 | 首页第二栏 → 点「任务」tab | kanban **四列**（未开始 / 等待中 / 进行中 / 已结束）+ 卡片按 status 分列 |
| UC-P2 | 拖卡片从「未开始」→「进行中」 | 调 `POST transition {to:in_progress}`；成功乐观移动 + toast；失败回弹 + toast reason |
| UC-P3 | 点卡片 | 弹 entity-modal mode=edit（status 字段只读，状态变更走 transition） |

### 3.5 task 依赖与「等待中」（全自动） [v0.0.240]

**描述**：task 有 `dependencies`（ref[] → 其他 task id）。**全自动**（非 agent 手动 transition、非手动工具调用）：
- 依赖 task 未 `done` → 被依赖 task **自动**进入 `waiting`（即使 owner 想 start）
- 所有依赖 `done` → **自动**从 `waiting` 解除回 `todo`（可被 owner start）

**状态可观测**：
- 任务 kanban 卡片：`waiting` 状态并入「未开始」列、卡片显 block 徽标（如「⏸ 等 N 项」）
- entity-modal：dependencies 字段展示依赖 task 列表 + 各依赖当前状态

**优先级**：P0 · **用户故事**：作为 leader，我建带依赖的 task 链，依赖关系自动维护，不必手动催。

#### E2E Use Cases（依赖自动）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-D1 | 建 task B 依赖 task A（A 未 done）→ 试图 start B | B 自动 `waiting`；B 卡片显「等 A」徽标 |
| UC-D2 | A 完成（transition to done）→ 看 B | B 自动从 `waiting` → `todo`；SSE 推送 |

### 3.6 task 归档（默认活跃 + 开关 + 卡片归档按钮） [v0.0.240]

**描述**：task 有 `archived` boolean。视图默认**只看活跃**（过滤 `archived=true`），「活跃 / 含归档」开关切换。

**交互**：
- 任务 kanban toolbar 右侧加「活跃 / 含归档」segmented 开关（默认「活跃」）
- 卡片 hover 显示「归档」按钮（icon，预占位布局稳定，禁 `display:none`）→ `PATCH` 设 `archived=true` + SSE 推送 → 卡片从活跃视图消失（切「含归档」可见）
- entity-modal 内也可改 archived（与 kanban 卡片按钮等效）

**前置增强**（§3.7）：panorama entity 加 archive 字段 + view 默认过滤归档项（机制保障，leader DSL views 也享受过滤）。

**优先级**：P0 · **用户故事**：作为用户，我看任务 kanban 默认只见活跃、需要时可切看归档；归档一键完成。

#### E2E Use Cases（归档）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-A1 | 任务 kanban → 卡片 hover → 点「归档」按钮 | PATCH archived=true；卡片从活跃视图消失；SSE 推送 |
| UC-A2 | 切「含归档」开关 | 归档 task 重新出现在列尾（视觉弱化，如 opacity 0.6） |

### 3.7 前置增强（panorama，方案 A+ 绕不开） [v0.0.240]

> 这些是 panorama 概念层的扩展。PRD 只描述**用户可感知行为**，纯技术实现（数据结构/校验/SSE/迁移）留给架构期落 `specs/tech/squad/` + `specs/api/overall/14-panorama-endpoints.md`。

#### 3.7.1 view.filter（修「3 个 table 筛出一样」）
- ViewDef（kanban/table/bar_chart）新增 `filter` 声明（field:value 精确匹配，多条件逗号）
- 前端 fetch 实体时透传 `?filter=`（后端 `GET entities?filter=` 已支持，§2.1）
- **用户可感知**：leader 在 view 写 filter 后，该 view 只显示匹配项（不再被静默忽略、不再 3 个 table 筛出一样）

#### 3.7.2 归档能力（panorama entity + view 默认过滤）
- panorama entity 加 `archived` 字段（与 task 同机制；task 是首个受益者）
- view 默认过滤归档项（task「活跃 / 含归档」开关即此能力的 UI 投影）
- **用户可感知**：task + 后续 leader DSL entity 都可归档、默认不显示归档项

#### 3.7.3 builtin schema 通道（task 固定 schema 被识别）
- 现 schema 纯 DSL（leader 搭、`GET schema` 返 DSL 文本）；新增**固定 builtin schema**通道（不经 DSL parse、全 squad 通用）
- **用户可感知**：首页第二栏「任务」tab 恒在（不受 leader DSL 变化影响）；task 字段/状态机固定（所有 squad 一致）

#### 3.7.4 field 展示名 / 中文（task 配死 + panorama 机制保障）
- task builtin：field/enum label 直接配死中文（`标题 / 描述 / 负责人 / 依赖 / 状态`；status enum `未开始 / 等待中 / 进行中 / 已结束`）
- panorama 机制（`field.label` + `display.{field}_labels`）保障：配了就用 + 引导 leader DSL 配展示名

**优先级**：P0（view.filter + builtin schema + 归档 = 阻塞 task，必须前置；field 中文 = P1）

#### E2E Use Cases（前置增强）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-E1 | leader DSL 写带 filter 的 table view | 该 table 只显匹配项（不与无 filter view 重复） |
| UC-E2 | 任务 kanban 表头/卡片字段 | 全中文（标题/状态等，非英文 key 兜底） |

---

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

> 用户路径 = 测试最低覆盖（每条至少一个 AT/UT 或 ET case）。版本验证 = 冒烟集回归 + UT（用户铁律：普通 feature 不新增持久 AT/ET，仅 LLM 不确定/新板块入选）。

| # | 路径 | 覆盖建议 |
|---|------|---------|
| **P1** | agent 用 panorama 工具 create task → reminder 注入到 owner → owner 看到 → transition 到 in_progress → done → 归档 | AT（LLM + reminder + transition 跨层链路）+ UT（schema/状态机/归档）|
| **P2** | 建 task B 依赖 A（A 未 done）→ B 自动 waiting → A done → B 自动 todo（全自动非工具 transition） | UT（依赖自动维护核心逻辑） |
| **P3** | 进首页 → token 小组件 → 点击进 token-stats 详情 → 返回 | ET（首页板块冒烟）+ UT（token 小组件派生） |
| **P4** | 首页第二栏全景 → 任务 tab（kanban 按状态）→ 卡片归档 → 切「含归档」开关 | ET（任务 kanban + 归档开关） |
| **P5** | leader DSL 写带 filter 的 table view → 看到筛选生效 | UT（view.filter 前端透传） |
| **P6** | 首页 tab「首页」+ roster「成员·N」（N 减队长）+ 第二栏全景（无独立路由） | ET（首页 IA 改造回归） |

**ET 候选评估**：本版本改动用户可感知界面（首页 IA + 任务 tab），需 ET blocking=0 才能合并。建议 1 条 ET（首页全景：进首页 → token 小组件点击 → 任务 tab → 归档 → 切开关），不新增 AT（无新 LLM 不确定场景——task 走 panorama 工具链路、AT 已覆盖）。

---

## 5. 范围边界（IN / OUT）

### IN SCOPE（v0.0.240）
- task = panorama builtin entity（固定 schema：title/desc/owner/deps/status/archived + 4 态状态机 + 自动依赖）
- task 状态 reminder 注入（挂 SystemReminderPoint provider）
- 首页改造（tab 改名 / SeatStats 2×2 → token 小组件 / 成员计数减队长 / 全景内嵌第二栏）
- 全景固定「任务」tab（kanban 按状态）
- task 归档（默认活跃 + 卡片归档按钮 + 活跃/含归档开关）
- panorama 前置增强：view.filter / 归档 / builtin schema 通道 / field 中文

### OUT OF SCOPE（显式不做）
| 排除项 | 理由 |
|--------|------|
| task 专用工具（task.create/transition 等） | 方案 A+ 决策：复用 panorama 工具，避免两套写入口 |
| task 状态机可视化编辑（leader 自定义状态） | task = builtin 固定 schema，状态机不可改 |
| reminder 注入策略 UI 配置 | 注入口径写死（leader 全队 / mate 按 owner+依赖），不暴露配置 |
| 任务 tab 切其他渲染原语（table/bar_chart） | 任务 tab 固定 kanban（按状态分列），不支持切换渲染原语 |
| 全景独立路由态（导航回二级页） | 全景已内嵌首页第二栏，独立路由入口删除 |

---

## 6. 验收口径

**功能**：
- task create/transition/归档链路全跑通（panorama 工具操作 + SSE 推送 + reminder 注入）
- task 依赖全自动：依赖未结束 → waiting；依赖结束 → 自动 todo（非工具 transition）
- 首页 IA：tab「首页」/ token 小组件（点击进 token-stats）/ roster「成员·N」（N 减队长）/ 第二栏全景
- 任务 tab：kanban 三列 + 拖拽 transition + 卡片归档 + 活跃/含归档开关
- view.filter：leader DSL 写 filter 生效（修「3 table 筛一样」）

**视觉**：有设计稿（`demo-home.html`）→ 视觉保真 compare MANDATORY（layout/font/border/color 四维度 + brand/三色比例条/kanban 列色带关键元素）

**API**：panorama 工具操作 task 走现有端点（POST entities / PATCH / transition / events），builtin schema 通道 + archive 字段 + view.filter 由架构期落 api/overall/14

**known-issue**：暂无（待验证发现）

---

## 7. spec 过时发现 + doc-sync 待办

> 读 spec 发现以下过时项（PRD 描述按当前正确概念，doc-modifier 阶段 5 统一修 spec 对齐）：

| spec 文件 | 过时内容 | 正确概念 |
|-----------|---------|---------|
| `specs/ui/components/studio-page/component-panorama-route.md` | §职责/§统一 tab 装配/§tab 分发 还写 `FIXED_TABS=[goals/requirements/tasks]` + `isFeatureOkrOn()` gate + 内嵌 `<SquadBoard>` | v0.0.237 已随 charter/task/goal/requirement/board 全链路移除（06-studio §4 已正确记录）；v0.0.240 新增「任务」固定首 tab（builtin task schema，非 gate 残留、非 SquadBoard） |
| `specs/ui/components/studio-page/component-team-entry-row.md` | §职责「看板三视图整组件已并入业务全景路由前 3 固定 tab」 | 同源过时；v0.0.240 全景内嵌首页第二栏、TeamEntryRow 在首页左列已删（被 token 小组件取代） |
| `specs/ui/components/studio-page/component-panorama-view.md` | §toolbar「无 zone switch / archive，panorama 无归档概念」 | v0.0.240 引入归档能力（panorama entity 加 archive 字段 + view 默认过滤 + 任务 tab「活跃/含归档」开关）；toolbar 需新增 archive 开关槽位 |
| `ViewDef 类型（panorama-types.ts）` | 三种 ViewDef（kanban/table/bar_chart）全无 `filter` 字段 | v0.0.240 加 `filter` 声明 + 前端 fetch 透传（修「3 table 筛一样」）|

**新概念前置**：task builtin schema / view.filter / panorama 归档属 panorama 概念层扩展，PRD 描述用户可感知行为，**纯技术实现（DSL 扩展 / 校验层 / SSE 字段 / 迁移）由架构期落 `specs/tech/squad/` + `specs/api/overall/14-panorama-endpoints.md`** 后再进编码。
