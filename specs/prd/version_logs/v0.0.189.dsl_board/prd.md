# v0.0.189.dsl_board PRD — 业务全景（Panorama）：agent 可搭建的业务看板系统

> version: 1.0 · 引入版本 v0.0.189.dsl_board · 2026-07-22
> 承载本版本产品定义：squad leader 用 DSL 搭建的业务看板（业务全景 / Panorama，代码 id `panorama`），与现有硬编码看板并列。**agent 是看板作者，用户是操作者**。
> 概念权威源（PRD 引用皆对齐，不发明新概念）：
> - 调研（已用户确认）：`specs/research/v0.0.189.dsl_board/panorama_{dsl_schema,validation,migration}.md`
> - 需求权威：`reqs/[working] v0.0.189.dsl_board/req.md`（10 条已拍板决策）
> - UI 契约：`specs/ui/overall/06-studio.md`（MainView 路由态权威）+ `specs/ui/components/studio-page/{_overview,component-team-entry-row,squad-board}.md`
> - 技术契约（待 arch 落地）：`specs/tech/squad/[P1]squad_tools.md`（action-based 工具风格对齐）
> overall 落点：`specs/prd/overall/08-squad-studio.md` §8.7 承接表（panorama 为新增功能面）。

---

## 1. 功能概述

业务全景（Panorama）是 squad 团队的**可操作业务数据看板**。它的内容不由系统硬编码，而是由 **squad leader（agent）用声明式 DSL 搭建**：leader 听懂用户在群聊里提的需求 → 生成 DSL → 四层校验 → 自我修复 → 落盘 → 看板出现。用户随后可在看板上拖拽改状态、新建/编辑实体，agent 也可经工具读写——**同一个 DSL 约束三个写入入口**。

| | 现有看板（board） | 业务全景（panorama） |
|---|---|---|
| 内容 | goal/kr/req/task 任务完成追踪（硬编码 schema） | agent 搭建的业务数据看板（DSL 声明式 schema） |
| 作者 | 系统内置 | squad leader 生成 DSL 搭建 |
| 可操作性 | 可编辑 | **可操作**（拖拽/新建/编辑，双侧写入） |
| 数据 | 硬编码实体 + OKF md 主轨 | DSL 主面 + 纯数据实例（**刻意无 OKF md 轨**） |

核心机制（决策 1-6）：
- **DSL 设计目标 = LLM 生成可靠 + 可校验**（啰嗦但无二义、显式优于省略、JSON Schema 可逐条校验）。
- **校验-修复回路**：四层校验（语法 → schema → 语义 → 数据安全），结构化错误 `{code, path, message, suggestion}` 喂回 leader 自我修复。
- **拖拽 = 状态机投影**：`group_by == states.field` 即可拖，拖动即发起状态跃迁，过 transitions 表 + 终态锁 + guard；非法跃迁拒绝并给可读原因。
- **规则唯一源 = DSL**：用户拖拽 / agent 工具 / 直接 API 三个写入口共用同一校验器，规则不漂移。
- **迁移容错**：增量变更自动生效；破坏性变更须 leader 提交迁移方案 + 审计日志，重大变更要用户点头。

视图原语 v1 = 3 种：kanban / table / bar_chart（demo 已验证）。多 tab = DSL `views` 数组，一 view 一 tab。

---

## 2. 范围边界（IN / OUT SCOPE）

### 2.1 IN SCOPE（本版本交付）

| 面 | 交付项 |
|---|---|
| **UI 产品** | 业务全景入口（团队入口卡第三个 link，`MainView {kind:'panorama'}`）+ idle 空态引导 + 多 tab 工作态渲染（kanban/table/bar_chart）+ 拖拽改状态 + 弹层新建/编辑实体 + 事件流面板 + SSE 实时刷新 |
| **agent 工具** | `panorama(action, ...)` 单工具占 1 slot：define / get_schema / create / update / transition / query / events |
| **skill** | `panorama-designer`（leader 默认挂载）：DSL 规范手册 + 建模模式 + 工作流 + 模板库索引 |
| **存储** | squad workspace 文件制：`board.yaml`（DSL 主面）+ `entities/{entity}/{id}.json`（每项一文件）+ `events.jsonl`（append-only 事件流）+ `.archive/`（迁移备份） |
| **后端服务** | 四层校验引擎 + 迁移引擎 + 泛化实体 store + 事件流 + HTTP API（schema 读写 / 实体 CRUD / transition / events / dry-run）+ SSE 实体变更推送 |
| **模板库** | 两个种子模板：CI/CD（demo 升格）+ 团队工作管理（goal/kr/req/task 抽象） |

### 2.2 OUT OF SCOPE（v1 外，决策 10）

- **外部数据接入适配器**（webhook 直连 GitHub/Argo）——v1 数据全靠 agent/用户经工具/API 写入。
- **DSL 编辑器 UI / 用户可视化配置器**——DSL 由 leader 生成，用户不手写 DSL（空态引导的下一步是「说话」不是「配置」）。
- **现有看板迁移到 panorama 引擎**（goal/kr/req/task 留硬编码，后续另行评估）。
- **DSL schema 跨大版本升级**（v1 meta.version 固定 "1.0"；v2 引擎读 v1 的兼容路径属后续版本）。
- **图表高级形态**（v1 bar_chart 仅 day 粒度 + 近 N 天窗口 + 可选 stack_by；line/pie 等后续）。

---

## 3. 详细需求

### 3.1 UI 产品

#### 3.1a 入口与路由（对齐 06-studio.md MainView）

业务全景是 **团队入口卡（`component-team-entry-row`）的第三个 link**，与现有「看板」「群聊」并列：

- 新增 link：`seat-team-entry-panorama`（hue 待 UI spec 定，与 board-blue / groupchat-pink 区分；建议 hue=teal 或 violet），点击 → `MainView {kind:'panorama'; squadId}`。
- 全景主区 = 新组件 `component-panorama-route`（顶部 back-btn 复用 board 路由的返回键模式，返回 seats 首页）+ 全景内容。
- MainView 路由态由 v0.0.168 的 `{kind:'seats'|'board'|'chat'|'member'}` 扩展为含 `panorama`（arch 落地时同步 06-studio.md）。

#### 3.1b idle 空态（schema 未定义）

leader 搭建前，`board.yaml` 不存在 → 空态引导页：

- 文案「业务全景由 leader 搭建」+ 按钮「去群聊 @leader」（复用现有 @ 预填链路：点击跳群聊 + 输入框预填 `@leader` 前缀）。
- **空态的下一步是「说话」不是「配置」**——用户对 leader 说「给我们搭个 XX 看板」，不点配置。

#### 3.1c 多 tab 工作态（schema 已定义）

leader 落盘后呈现多 tab 工作态：

- **顶部 tab = DSL views**（一 view 一 tab，顺序即数组顺序）。
- **toolbar** 沿用 board-toolbar 单行模式（新建/筛选/刷新，按 view 类型适配——kanban 显新建，table 显筛选+新建，bar_chart 不显新建）。
- **三组件渲染器**（走 registry 注册，DSL 语法不变）：
  - **kanban**：`group_by` 分列 + 列序 `columns` + 卡片模板 `card`（`{field}` 插值 + ref 一级嵌套 + fallback）；`group_by==states.field` 时可拖。
  - **table**：`columns` 列定义 + 可选 `sort` + 可选 `filter`。
  - **bar_chart**：`bucket{field,unit:day,days}` 时间分桶 + 可选 `stack_by`（enum 堆叠 + 图例）。

#### 3.1d 交互能力（与现有 board 对齐，决策 9）

全景必须有现有看板的全部交互能力：
- **拖拽改状态**（kanban，`group_by==states.field`）：发起 transition，过 transitions 表 + 终态锁 + guard；非法跃迁拒绝 + 可读原因（toast/卡回弹）；乐观更新 + 回滚（与服务端校验结果一致）。
- **弹层新建/编辑实体**（复用 board-entity-modal 模式）：按 DSL 字段类型动态渲染表单（string/number/boolean/enum/ref/datetime 各自控件），提交过校验。
- **三态**（加载/空/失败）。
- **事件流面板**：agent/用户双侧操作可见（双向工作面，从 `events.jsonl` 读，按时间倒序）。

#### 3.1e SSE 实时刷新（决策「双向工作面」）

agent 经工具写入实体 → 后端推 SSE 事件 → 前端实时刷新对应 view + 事件流面板（用户旁观团队工作）。用户操作与 agent 操作在事件流里以 `source` 字段区分（`user` / agent session id）。

### 3.2 agent 工具（action-based，对齐 squad_tools 收敛风格，占 1 tool slot）

```typescript
panorama(action, ...args)
```

| action | 入参 | 谁可调 | 说明 |
|---|---|---|---|
| `define` | `dsl` 全文 + `dryRun?` + `migration?` + `approved?` | leader / user | 定义/更新 schema+views；先 dryRun 四层校验全过才落盘，失败返 `{code, path, message, suggestion}`；破坏性变更需 migration；重大变更需 `approved:true` |
| `get_schema` | — | 全员 | 读当前 DSL（改前必读） |
| `create` | `entity, fields{}` | 全员 | 新建实例，过 DSL 校验（类型/枚举/ref 闭合/required） |
| `update` | `entity, id, patch{}` | 全员 | 改字段过校验 |
| `transition` | `entity, id, to` | 全员 | 状态跃迁过状态机（非法 → `panorama_illegal_transition`） |
| `query` | `entity, filter?, sort?, limit?` | 全员 | 读实例 |
| `events` | `since?, limit?` | 全员 | 读事件流（感知用户操作） |

约束：错误码 `panorama_*` 前缀；写操作记 `lastWriteMessageId`；**schema 面仅 leader/user，数据面全员**。

### 3.3 skill：panorama-designer（leader 默认挂载）

1. **DSL 规范手册**：字段类型集 / 状态机 / 视图配置 / card 模板语法 / 护栏上限（生成时不猜字段名）。
2. **建模模式**：业务描述 → 实体 + 状态机 + 视图（状态机优先：先理工作流流转再定字段）。
3. **工作流**：听懂需求 → 选模板 → `get_schema` → `define(dryRun)` → 按 suggestion 修错 → 落盘 → 汇报。
4. **模板库索引**：CI/CD（demo 升格）+ 团队工作管理（goal/kr/req/task 抽象）。

### 3.4 存储（文件制，决策 7-8）

```
data_dir/squads/{squadId}/panorama/
├── board.yaml                    # DSL 主面（含 meta.version + author + 审计三件套）
├── entities/{entity}/{id}.json   # 实例，每项一文件（CrudStore 惯例）
├── events.jsonl                  # append-only 事件流（双侧共享，即审计日志）
└── .archive/pre-migration-{seq}/ # 破坏性变更前自动备份（回滚用）
```

刻意偏离 goal/task 双轨（无 OKF md 轨）：`board.yaml` 即主面，实例是纯数据 json，无 agent 手写 markdown 需求。结构化约束靠 DSL 写入校验，不引数据库。

### 3.5 后端服务

- **四层校验引擎**：Layer1 语法（YAML parse + 根类型，短路）→ Layer2 schema（字段类型/必填/enum/护栏，收集全）→ Layer3 语义（跨引用闭合：ref/template/group_by/transitions/view.entity，收集全）→ Layer4 数据安全（存量实例 vs 新 DSL 兼容性，仅 define 非 dryRun 且有存量数据时执行）。原子性：要么全过全落，要么全拒。
- **迁移引擎**：增量变更自动生效（加实体/字段/视图/扩枚举/放宽约束）；破坏性变更（删字段/收窄枚举/改类型/改 states.field）须 migration 方案 JSON（operations + handler：archive/purge/mapping/default/transform/drop/clip），原子执行 + 审计日志 + .archive 备份 + 幂等可恢复。
- **泛化实体 store**：按 DSL 动态校验读写，每项一文件。
- **事件流**：每次写操作 append `events.jsonl`（`{seq, ts, type, entity, summary, payload:{id, from, to, source}}`）。
- **HTTP API**：schema 读写 / 实体 CRUD / transition / events / dry-run 校验。
- **SSE**：实体变更推送（前端实时刷新）。

### 3.6 用户介入门槛（迁移）

| 级别 | 标准 | 机制 |
|---|---|---|
| **重大** | 数据丢失/不可逆/影响业务语义（删实体有数据 / 删字段有值 / 收窄枚举有存量值 / 改字段类型 / 改 states.field） | 引擎返 `panorama_breaking_change_requires_approval`，leader 转达用户，用户确认后 leader 附 `approved:true` 重提 |
| **次要** | 可逆/范围可控（删 transition 无依赖 / 扩 terminal / 收紧约束少量违规 / 删无数据实体 / 删视图） | leader 自决，提交 migration 即可 |

---

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

> 每条路径 = 至少一个 API/E2E case 的最低覆盖要求。本版本 **ET 用独立 Playwright 脚本验证，不走项目 ET 框架**（用户裁决）；AT 评估新增 1 条冒烟 case（LLM 定义看板 + 修复回路，符合冒烟集入选标准 + 一进一出）。

| # | 路径 | 触发/结果 | 验证层 |
|---|------|----------|--------|
| **P1** | **空态引导**：squad 未搭 panorama → 进全景见空态 → 点「去群聊 @leader」 | 跳群聊 + 输入框预填 `@leader` 前缀；空态不提供配置入口 | ET |
| **P2** | **leader 首次搭建**：用户群聊提需求「搭个流水线看板」→ leader 选模板 → 生成 DSL → `define(dryRun)` → 校验失败（如某 ref 闭合错）→ 按 suggestion 自修复 → 再 dryRun 全过 → `define` 落盘 → 全景入口出现 + 多 tab 呈现 | board.yaml 落盘 + audit 记录；空态消失转工作态 | AT（LLM 不确定性场景）+ ET |
| **P3** | **搭建成功多 tab 呈现**：leader 落盘含 N 个 view 的 DSL → 全景渲染 N 个 tab（kanban/table/bar_chart 各按 DSL 配置） | tab 数 = views 数；卡片标题/列/图表按 card 模板 + group_by/columns/bucket 渲染正确 | ET |
| **P4** | **用户拖卡改状态（合法）**：kanban 中 `group_by==states.field` → 拖卡到目标列 → 发起 transition → 过 transitions 表 + 终态锁 + guard → 成功 | 实例状态变更 + 事件流追加（source=user）+ 实时刷新 | ET + API |
| **P5** | **用户拖卡改状态（非法拒绝）**：① 拖到 transitions 表不允许的列；② 拖到终态实例（terminal locked）；③ guard 不满足 | 三种均拒绝 + 卡回弹/弹原因（`panorama_illegal_transition` / `panorama_terminal_locked` / `panorama_guard_failed`）+ 数据不变 | API + ET |
| **P6** | **用户新建/编辑实体（弹层，过校验）**：toolbar 点新建 → 弹层按 DSL 字段渲染表单 → 填值 → 提交过校验（类型/枚举/ref 闭合/required）→ 实例创建/更新 | 实例落盘 + 事件流追加；非法值（如 ref 指向不存在）被拒并提示 | ET + API |
| **P7** | **agent 写入触发 SSE 实时刷新**：用户停在全景页 → agent 经工具 create/transition 写入 → 后端推 SSE → 全景实时刷新（卡片移动/新增 + 事件流面板新条，source=agent） | 用户页面无需手动刷新即看到 agent 操作 | API（SSE）+ ET |
| **P8** | **leader 迭代 DSL（增量变更自动生效）**：用户说「加个部署实体」→ leader `get_schema` → 生成含新增 entity/field/view 的 DSL → `define`（增量类）→ 引擎自动落盘 + 存量实例新字段补 null + 审计 → 全景出现新 tab/字段 | 无需 migration、无需用户确认；增量变更审计 `change.kind=entity_added/field_added` | API + AT |
| **P9** | **leader 破坏性变更（须迁移方案，重大要用户点头）**：leader 收窄枚举（有存量值受影响）→ `define` 触发 Layer4 `panorama_enum_narrowed` → leader 生成 migration 方案（mapping）→ `define(dryRun, migration)` 预检 → 引擎判为重大变更返 `panorama_breaking_change_requires_approval` → leader 转达用户 → 用户确认 → `define(migration, approved:true)` → 引擎执行 + .archive 备份 + 审计 | 重大变更未经 user approved 不落盘；次要变更（如删无数据视图）leader 自决直接生效 | API + AT |

---

## 5. 验收标准

### 5.1 功能验收（对应 P1-P9）

1. 空态正确引导「去群聊 @leader」，不提供配置入口（P1）。
2. leader 能从群聊需求出发生成合法 DSL 并自修复校验错误后落盘（P2）——**核心回路**。
3. 多 tab 按 views 正确渲染三组件（P3）。
4. 拖拽合法跃迁成功 + 非法跃迁（三种）拒绝并给可读原因（P4/P5）。
5. 弹层新建/编辑过校验、非法值被拒（P6）。
6. agent 写入触发 SSE 实时刷新，双侧操作可区分（P7）。
7. 增量变更自动生效、存量数据兼容（P8）。
8. 破坏性变更须 migration、重大变更须 user approved，原子性 + .archive 备份 + 审计日志可查（P9）。

### 5.2 契约一致性

- 三个写入口（UI 拖拽 / agent 工具 / 直接 API）共用同一校验器，规则不漂移（抽测同一非法 transition 三入口结果一致）。
- 错误码 `panorama_*` 前缀统一，返回结构含 `{code, path, message, suggestion}`。

### 5.3 测试范围（对齐 req §9）

- **UT 为主**：校验器（四层各层）/ 状态机（transitions + terminal + guard）/ 迁移（增量自动 + 破坏性 handler 各 strategy）/ 渲染器装配（kanban/table/bar_chart + card 模板插值）/ 模板。
- **AT 新增 1 条冒烟 case**（一进一出）：「LLM 定义看板 + 修复回路」——新增 LLM 不确定性场景，符合冒烟集入选标准。
- **ET**：独立 Playwright 脚本验证全景入口 + 多 tab + 拖拽 + 弹层（P1-P7 的 UI 链路），不走项目 ET 框架。
- **无设计稿**（req 无权威设计稿）→ 视觉保真 compare 门禁跳过，功能 PASS + UI 对齐既有 board token 即验收。

### 5.4 文档同步（MANDATORY）

- arch 落地时同步 `specs/tech/squad/[P1]panorama_dsl.md`（权威 DSL spec）+ `specs/api/`（HTTP 端点）+ `specs/ui/components/`（panorama 组件契约 + testid）+ `06-studio.md` MainView 路由态扩展。

---

## 6. 与现有产品的关系

- **与现有看板（board）并列共存**：board = 硬编码 goal/kr/req/task 任务追踪；panorama = agent 搭建的业务数据看板。两者入口分立（团队入口卡的 board link vs panorama link），数据互不干扰（board 走 squad OKF store，panorama 走 `panorama/` 文件目录）。v1 不迁移 board 到 panorama 引擎。
- **复用 Studio IA**：panorama 入口挂在团队入口卡（`component-team-entry-row`），走 `MainView {kind:'panorama'}`——与 board 的 `{kind:'board'}` 同级路由态模式。toolbar 复用 board-toolbar 单行模式；弹层编辑复用 board-entity-modal 模式。
- **复用 squad 工具风格**：`panorama(action)` action-based 单工具，对齐 `[P1]squad_tools.md` 收敛风格（一个工具多 action），占 1 tool slot。
- **leader 是看板作者**：panorama-designer skill 随 leader 默认挂载；用户不写 DSL，只对 leader 说话。这是「空态下一步 = 说话」的产品定位根因。
- **存储隔离**：panorama 数据在 squad 自己的 workspace（`panorama/` 子目录），与 board 的 OKF store 物理隔离，不引数据库、不引 OKF md 轨。

---

## 7. 开放问题（留待 arch / 实现阶段）

1. panorama 入口 link 的 hue 色（与 board-blue / groupchat-pink 区分）—— UI spec 阶段定。
2. SSE 事件 topic 命名（建议 `panorama:squad:{squadId}:entity`）+ 与现有 squad SSE 通道的共存—— arch 阶段定。
3. AT 冒烟集「一进一出」淘汰哪一条旧 case —— test-plan 阶段与用户协商。
4. 独立 Playwright ET 脚本的归属目录与执行方式 —— test-plan 阶段定。
