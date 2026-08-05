# v0.0.189.dsl_board — 业务全景（Panorama）：agent 可搭建的业务看板系统

> 类型：新功能面（UI + agent 工具 + skill + 存储 + 后端服务）· 引入版本 v0.0.189.dsl_board · 2026-07-22
> 需求来源：`reqs/[working] v0.0.189.dsl_board/req.md`（10 条已拍板决策）
> 调研基础（已用户确认）：`specs/research/v0.0.189.dsl_board/panorama_{dsl_schema,validation,migration}.md`
> 概念验证 demo：`reqs/[working] v0.0.189.dsl_board/demo/`（已验收，自验 11/11 全绿）
>
> **概念权威源（MANDATORY 对齐）**——本 PRD 引用的实体/视图/状态机/校验/迁移术语全部来自调研文档定义，不发明新概念：
> - DSL 规范：`panorama_dsl_schema.md`（顶层 meta/team/entities/views + 6 字段类型 + states 状态机 + display + card 模板 + 护栏）
> - 校验四层：`panorama_validation.md`（syntax→schema→semantic→data_safety + 实例写操作校验 + 错误码表）
> - 迁移模型：`panorama_migration.md`（增量自动 / 破坏性须方案 + handler 策略 + 重大/次要介入门槛 + 原子/幂等/备份）
> - UI 契约：`specs/ui/overall/06-studio.md`（MainView 路由态权威，panorama 为新增 `{kind:'panorama'}`）+ `specs/ui/components/studio-page/{_overview,component-team-entry-row,squad-board}.md`
> - 工具风格：`specs/tech/squad/[P1]squad_tools.md`（action-based 单工具对齐对象）

---

## 0. 决策基线（用户 2026-07-22 已拍板，本版本不推翻）

| # | 决策 | 理由 |
|---|------|------|
| D1 | DSL 作者 = leader（agent）；设计目标 = LLM 生成可靠 + 可校验 | 用户不手写 DSL，空态下一步是「说话」不是「配置」 |
| D2 | 校验-修复回路是核心机制：四层 + 结构化错误喂回 agent 自修复 | 减少 agent 修复轮次，一次报全 |
| D3 | 迁移容错：增量自动 / 破坏性须方案 + 审计 | 看板演进时数据不丢 |
| D4 | 视图原语 v1 = kanban/table/bar_chart；多 tab = views 数组 | demo 已验证 3 种够用 |
| D5 | 拖拽 = 状态机投影（group_by==states.field 即可拖）；非法跃迁拒绝 | 无独立拖拽配置 |
| D6 | 同一校验器三个写入口（UI/工具/API）；规则唯一源 = DSL | 规则不漂移 |
| D7 | 存储用文件：每项一文件 + append-only 事件流 | 不引数据库 |
| D8 | 无 OKF md 轨（刻意偏离 goal/task 双轨） | board.yaml 即主面，实例纯数据 |
| D9 | UI 与现有 app 风格一致 + 能力对齐现有 board | 全景吃 design token + 拖拽/弹层/乐观更新全有 |
| D10 | 模板库：CI/CD（demo 升格）+ 团队工作管理（goal/kr/req/task 抽象）两种子 | |

---

## 1. 背景

现有 squad 看板（goal/kr/req/task）是硬编码 schema 的任务完成追踪，**只能追踪系统内置实体**。但团队真实业务工作面远不止任务追踪（如 CI/CD 流水线、需求池、发布看板等），这些需要**可自定义的业务数据看板**。本版本交付 panorama：让 squad leader 用声明式 DSL 搭建任意业务看板，用户和 agent 双向操作，体现「团队如何工作」。

概念验证 demo 已验收（`demo/`，serve.sh :8189，11/11 自验全绿），验证了 DSL/引擎/渲染参考实现。本版本把 demo 升格为正式产品面。

---

## 2. 新增/变更清单（按交付面）

### 2.1 UI 产品（新增）

| 项 | 类型 | 说明 |
|---|---|---|
| 业务全景入口（第三个 link） | 新增 | `component-team-entry-row` 加 `seat-team-entry-panorama` link → `MainView {kind:'panorama'}` |
| `component-panorama-route` | 新增 | 顶部 back-btn + 全景内容（复用 board 路由返回键模式） |
| 空态引导页 | 新增 | schema 未定义时「去群聊 @leader」预填入口（不提供配置） |
| 多 tab 工作态 | 新增 | views = tab；三组件渲染器（kanban/table/bar_chart）走 registry 注册 |
| 拖拽改状态 | 新增 | kanban group_by==states.field 可拖；过 transitions+terminal+guard；非法拒绝+可读原因+回弹 |
| 弹层新建/编辑实体 | 新增 | 复用 board-entity-modal 模式，按 DSL 字段类型动态渲染表单 |
| 事件流面板 | 新增 | 从 events.jsonl 读，agent/用户双侧可见，source 区分 |
| SSE 实时刷新 | 新增 | agent 写入推 SSE，前端实时刷新 |

**变更（既有组件扩展）**：`component-team-entry-row`（2 link → 3 link，新 hue 待 UI spec）；`06-studio.md` MainView 路由态加 `panorama`（arch 落地时同步）。

### 2.2 agent 工具（新增，占 1 slot）

`panorama(action, ...)`：define / get_schema / create / update / transition / query / events。schema 面仅 leader/user，数据面全员。错误码 `panorama_*`。

### 2.3 skill（新增）

`panorama-designer`（leader 默认挂载）：DSL 规范手册 + 建模模式 + 工作流 + 模板库索引。

### 2.4 存储（新增目录）

`data_dir/squads/{squadId}/panorama/`：board.yaml + entities/{entity}/{id}.json + events.jsonl + .archive/。与 board OKF store 物理隔离。

### 2.5 后端服务（新增）

四层校验引擎 + 迁移引擎 + 泛化实体 store + 事件流 + HTTP API（schema/CRUD/transition/events/dry-run）+ SSE。

---

## 3. 关键用户路径（MANDATORY，9 条 — 详见 prd.md §4）

P1 空态引导 · P2 leader 首次搭建（含校验失败自修复回路，AT 核心）· P3 多 tab 呈现 · P4 拖卡改状态（合法）· P5 拖卡改状态（非法拒绝三情形）· P6 弹层新建/编辑过校验 · P7 agent 写入触发 SSE 实时刷新 · P8 leader 增量迭代 DSL 自动生效 · P9 leader 破坏性变更须迁移 + 重大须用户点头。

---

## 4. 测试范围（对齐 req §9）

- **UT 为主**：校验器（四层）/ 状态机 / 迁移（增量 + 各 handler strategy）/ 渲染器装配 / card 模板插值 / 模板。
- **AT 新增 1 条冒烟**（一进一出）：「LLM 定义看板 + 修复回路」——符合冒烟集入选标准（LLM 参与 + 行为不确定 + 跨层链路）。淘汰旧 case 待 test-plan 与用户协商。
- **ET**：独立 Playwright 脚本验证 P1-P7 UI 链路，**不走项目 ET 框架**（用户裁决）。
- 无设计稿 → 视觉保真 compare 门禁跳过。

---

## 5. 非目标（v1 外，决策 10）

外部数据接入适配器（webhook 直连 GitHub/Argo）/ DSL 编辑器 UI / 用户可视化配置 / 现有 board 迁移到 panorama 引擎 / DSL schema 跨大版本升级 / 图表高级形态（line/pie）。
