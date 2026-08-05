# v0.0.60.squad_ui_2 — PRD 变更日志（squad 看板概念优化）

> 版本：v0.0.60.squad_ui_2 · 状态：PRD 设计中（待用户确认）
> 主 PRD：`specs/prd/overall/08-squad-studio.md` §8.7e（摘要 + 跳转）
> 概念定稿（权威输入）：
> - `reqs/[working] v0.0.60.squad_ui_2/req.md`（6 条用户要求）
> - `reqs/[working] v0.0.60.squad_ui_2/board.md`（实体字段表 + 联合检查归档机制 + 关联链路 + 派生关系）
> - `states/v0.0.60/task.json`（decisions 全部拍板，`pending_decisions` 空）
> 用户路径覆盖：本文 §3 的 14 条 UC = 测试最低覆盖要求。

---

## 1. 背景

**v0.0.57 基线**：看板从 squad-panel goals tab 搬家到独立路由态，仍**只读**（编辑走对话工具）；Task 看板按 status 分列 + 列内按 assignee 分组；Requirement 通过 `relatedGoalId` 关联 Goal；Task.source 二选一 `{kind:"kr"|"requirement", id}`。

**v0.0.60 delta**：用户要求看板可编辑 + 归档机制 + 状态分列+优先级排序 + 统一概念链路 + body 正文 + deadline/health 联动。详细概念讨论稿见 board.md（逐字段表 + 归档机制图解）。

---

## 2. 概念变更清单（10 项）

| # | 变更 | 概念 | 现有 spec 状态 |
|---|---|---|---|
| 1 | **联合检查归档**（非级联） | `archived` 只表自身；`readable = self.archived==false ∧ 所有祖先.archived==false`；`effective_archived` 派生（不落库）。归档不碰子，恢复 O(1) 天然对称，无悬空引用 | ⚠ spec 缺口 |
| 2 | **统一关联链路** | `O → KR → Requirement → Task`；**Task.source 只能是 Requirement**（去 kind 二选一）；Requirement 用 `relatedKRId` 挂 KR（可空=野生），**`relatedGoalId` 字段废弃** | ⚠ spec 缺口 |
| 3 | **body 正文**（全实体） | Goal/KR/Requirement/Task 加 `body: text`（长正文 markdown）；区别于 title（短标题）+ 摘要（Goal.description / Requirement.detail） | ⚠ spec 缺口 |
| 4 | **Task priority** | `urgent\|high\|medium\|low\|none`；看板列内按 priority→updatedAt 排序 | ⚠ spec 缺口 |
| 5 | **deadline + 动态 health** | KR + Task 都加 `deadline?: date`；health 改为**进度×时间动态判定**（修复 workitems §2.2 + §10 TBD）；无 deadline 回退静态阈值 | ⚠ spec 缺口 |
| 6 | **Goal completion%** | **简单平均**：`Goal completion% = avg(KR completion%)` | ⚠ spec 缺口 |
| 7 | **编辑感知**（下次启动重建） | UI 编辑写回 store（OKF）；agent **下次启动**构建 system prompt/reminder 时带最新；**不引入实时 event 推送** | ⚠ spec 缺口 |
| 8 | **全实体全字段可编辑** | UI 直接编辑字段/关联/状态/正文（含 owner）；不再依赖对话工具；11b 增 HTTP 写端点 | ⚠ spec 缺口 |
| 9 | **UI vs agent 两层规则分家** | agent 可读=联合检查（readable）；**UI 活跃区可见=self.archived==false**；祖先归档的后代（self 活但 !readable）在活跃区以**发现性提示条**暴露 | ⚠ spec 缺口 |
| 10 | **Task 复制** | task 支持 `duplicate` action；O/KR/Requirement 暂不复制 | ⚠ spec 缺口 |

**沿用概念（不变）**：
- WorkStatus 五态机：`pending | in_progress | blocked | done | cancelled`
- health 三值：`on_track | behind | at_risk`（**算法改**，取值不变）
- KR 嵌入 `goal.krs[]`（store 层聚合）
- charter 编辑（11a §3）
- member/role/sessionId 权威源（squad 双向同步）
- `lastWriteMessageId` 语义（store 内部，reminder provider 变化检测）

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

每条路径至少一个 API/E2E case。

| ID | 用户操作链路 | 预期结果 | 类型 |
|----|-------------|---------|------|
| **UC-1** | 选中 Goal → 改 `title/body/ownerMemberId` → 保存 → **重启 agent** → 与 leader 对话 | UI 字段即时更新；重启后 leader system prompt / reminder 含最新 Goal body；agent 据此回复 | AT（PATCH）+ AT（重启后 reminder 含新内容） |
| **UC-2** | 选中 KR → 改 `current/target/deadline` → 保存 | KR `completion%` 重算；health 按 进度×时间 重派生；父 Goal health 联动 worst-case 重算并持久化；Goal completion% 重算 | AT（PATCH + 派生字段断言） |
| **UC-3** | 选中 Requirement → 改 `relatedKRId`（野生→挂 KR）/ `raisedBy` → 保存 | 链路正确切换；UI 选择器只列同 squad KR / 同 squad member | AT + ET |
| **UC-4** | 选中 Task → 改 `source`（切到另一 Requirement）/ `assignee` / `dependsOn` / `priority` / `deadline` → 保存 | 字段更新；列内 priority 重排；DAG 写入由工具兜底 | AT + ET |
| **UC-5** | Task 看板 → 切「按状态分列」视图 → 列内按 priority→updatedAt 排序 | 5 列：pending/in_progress/blocked/done/cancelled；列内顺序符合 priority 序（urgent>high>medium>low>none） | ET（vision 主 + dom 断言 priority 序） |
| **UC-6** | Task 看板顶部筛选器 → 选「全部」/「绑定 R-0001」/「绑定 KR-0001」 | 列表过滤正确（按 KR 含其下所有 Requirement 的 Task） | AT（query filter）+ ET |
| **UC-7** | 归档 Goal G1 → 切到归档区查看 G1 | G1.archived=true（只自身）；G1 在归档区显示；活跃区不显示 G1 | AT（PATCH archived + GET 区分） |
| **UC-8** | 归档 Goal G1（其下 KR-1→Req-1→Task-1） → 活跃区顶部发现性提示条「⚠ N 项因祖先归档移入归档区 [查看]」 → 点 [查看] 切归档区 → 看到 KR-1/Req-1/Task-1 | 联合检查：G1 归档后 KR-1/Req-1/Task-1 self.archived 仍 false 但 readable=false；agent 工具读不到（GET board active 只返 readable） | AT（联合检查 fail）+ ET（提示条 + 切区） |
| **UC-9** | 归档 Goal G1 后 → 在归档区点 G1「恢复」 → 切回活跃区 | G1.archived=false；KR-1/Req-1/Task-1 联合检查自动恢复 readable=true；O(1) 天然对称无级联改数据 | AT（恢复后 readable 恢复） |
| **UC-10** | 归档 Requirement R1（其下 Task-2 self.archived=false） → 活跃区提示「Task-2 因祖先归档移入归档区」 → 在归档区点 Task-2「恢复」 → 提示「它因 R1 归档而隐藏，需先恢复 R1」 → 点 R1 恢复 → Task-2 自动可读回 | 恢复叶子向上检测祖先归档状态；恢复聚合节点级联恢复从属 | AT + ET |
| **UC-11** | 野生 Requirement（relatedKRId=null） → 创建 Task（source=R-野生） → 看板 tasks 视图可见 → 按「按需求」筛选选 R-野生 → 仅见该 task | 野生路径正常工作；筛选正确 | AT（POST + filter）+ ET |
| **UC-12** | 选 Task-1 → 点「复制」 → 新 Task（title=副本；source/assignee/deadline 同步；status=pending；priority=none） → 列入看板 | 复制 action 成功；新 task id 自增 | AT（POST duplicate）+ ET |
| **UC-13** | 归档被活跃 Task-X dependsOn 的 Task-Y → 提示「N 个活跃任务依赖它，归档后将断链，是否继续？」 → 确认归档 → 活跃 Task-X 的 dependsOn 显示「（已归档）」灰链 → agent 读不到该依赖（降级，不报错） | 横向 dependsOn 断链提示 + agent 降级 | ET + AT |
| **UC-14** | 编辑写回 store → 启动新 leader/mate session → 检查 system prompt / reminder 含最新字段（body 正文 / 关联链路 / priority / deadline） | 编辑感知下次启动（无实时 event） | AT（reminder 变化检测 lastWriteMessageId） |

> **覆盖核对**：req.md 6 条 + board.md 关键机制全部覆盖（编辑→感知、归档→提示、恢复→对称、归档 Req→Task 联合检查 fail、状态分列+priority、筛选、野生、复制）。

---

## 4. 范围 / 非目标

### 4.1 IN SCOPE

1. 看板从**只读**改为**全实体全字段可编辑**（含 owner / 正文 / 关联 / 状态 / priority / deadline）
2. 联合检查归档机制 + 活跃/归档 switch + 发现性提示条 + 反向 dependsOn 断链提示
3. Task 看板按状态分列 + **列内 priority 排序**（替代 v0.0.33.3 的 assignee 分组）
4. Task 筛选：全部 / 按需求 / 按 KR（含其下所有需求的 task）
5. 关联字段 native 选择器（source/relatedKRId/ownerMemberId/raisedBy/assignee/dependsOn）—— 禁原生 select（`_conventions.md §10`），用 choice 卡 / 自定义下拉
6. Task 复制（duplicate action）
7. body 正文 markdown 编辑区
8. KR + Task deadline 字段 + 动态 health 派生
9. Goal completion% 派生（简单平均）
10. 编辑写回 store + agent 下次启动感知

### 4.2 OUT OF SCOPE（明确排除）

| 排除项 | 理由 |
|---|---|
| 独立 metric（指标）实体 | KR 自带 target/current/unit 已够（board.md 不做；invariants 隐含） |
| O 层直接衡量 | Goal 不带 target/current；completion% 是 KR 投影（`o_not_measured` 不变） |
| 归档级联改子 | 改用联合检查（`archive_self_only`） |
| O/KR/Requirement 复制 | 仅 Task 可复制（req.md 第 6 条） |
| 实时编辑感知（同会话内 event 推送） | 仅下次启动重建（`edit_awareness` 决策） |
| effective_archived 落库 | 派生在响应层；store 不冗余存（避免数据漂移） |
| 取消对话工具写 board | 对话工具仍可写（双轨保留）；本期增 HTTP 写端点是补 UI 入口，不替换 |

---

## 5. spec 缺口清单（⚠ 概念先行 — arch / coder 必须先落 spec）

PRD 引用的下列概念在 `specs/ui/` 或 `specs/tech/` 中**未覆盖或与现状冲突**——PRD 不发明概念（权威输入是 board.md + task.json），需 arch 阶段落 tech/api spec、coder 编码前置落 ui/components/ spec。

### 5.1 Tech spec（arch 落 `specs/tech/squad/`）

- ⚠ **联合检查归档模型**：`[P1]squad_workitems.md` 加新章「归档机制」（ancestors 链 + `readable`/`effective_archived` 派生 + 横向 dependsOn 断链 + 恢复向上检测）；`[P1]squad_store_projection.md §1` 各实体加 `archived/archivedAt/archivedBy`；`[P1]squad_reminder_providers.md` 加「归档项不进 prompt」过滤
- ⚠ **统一关联链路**：`workitems §3/§4/§5` 改 schema——`Task.source: ref(Requirement)`（去 kind 二选一）、`Requirement.relatedKRId?`（替代 `relatedGoalId`）；`store_projection §1.2/§1.3` 同步；`[P1]squad_tools.md` 工具 schema 跟改（含「野生 Requirement」语义）
- ⚠ **body 字段**：`workitems` 各实体 interface 加 `body: text`；`store_projection §1` 同步
- ⚠ **Task priority + 看板排序**：`workitems §5` Task 加 `priority` 字段；`§8` 看板视图改「列内按 priority→updatedAt」（替代 assignee 分组）
- ⚠ **deadline + 动态 health**：`workitems §2.2` 重写 KR health 算法（进度×时间，无 deadline 回退静态）；KR/Task schema 加 `deadline?: date`；`§10` TBD 划掉
- ⚠ **Goal completion%**：`workitems §2.2` 加「Goal completion% = KR 算术平均」+ 持久化策略
- ⚠ **编辑感知**：`workitems` / `reminder_providers` 注明「编辑写回 store，下次启动重建，无实时 event」
- ⚠ **Task 复制**：`[P1]squad_tools.md` 加 `task(duplicate)` action 语义（复制 source/assignee/deadline；status=pending；priority=none；新 id）

### 5.2 API spec（arch 落 `specs/api/overall/11b-squad-workitems.md`）

- ⚠ **写端点**（当前 11b 纯只读）：
  - `POST /squad/:id/board/goals` / `PATCH /squad/:id/board/goals/:gid`（含 KR 子端点 `/krs` `/krs/:kid`）
  - `POST /squad/:id/board/requirements` / `PATCH /squad/:id/board/requirements/:rid`
  - `POST /squad/:id/board/tasks` / `PATCH /squad/:id/board/tasks/:tid`
  - `POST /squad/:id/board/tasks/:tid/duplicate`
  - `PATCH /squad/:id/board/{goals|requirements|tasks}/:id/archive` / `/restore`
- ⚠ **响应字段扩展**：BoardItem schema 加 `body` / `priority`（Task）/ `deadline`（KR + Task）/ `archived` / `archivedAt` / `archivedBy`；新增派生 `readable: bool` + `effectiveArchived: bool`（不落库）
- ⚠ **zone/filter/sort query**：`?zone=active|archive`（active 默认；archive 返 `effectiveArchived==true`）；`?filter=reqId|krId|all`（task）；`?sort=priority,updatedAt`（task 列内）
- ⚠ **字段废弃**：`RequirementBoardItem.relatedGoalId` → `relatedKRId`；`TaskBoardItem.source.kind` 去枚举（统一 Requirement ref）

### 5.3 UI spec（coder 编码前置落 `specs/ui/components/studio-page/squad-board.md` v1.1 → v2.0）

- ⚠ **从只读改可编辑**：本 section 全实体编辑入口；refresh 策略改「编辑后乐观更新 + 失败回滚」（替代 v0.0.33.3 的 user 手动 refresh）
- ⚠ **新 testid**：
  - 区切换：`squad-board-zone-switch`（active/archive）+ `squad-board-archive-notice`（发现性提示条）
  - 编辑入口：`squad-board-{goal|kr|req|task}-{id}-edit`（触发编辑面板）
  - 字段编辑：`squad-board-{entity}-{id}-{field}-input`（title/body/owner/source/relatedKRId/priority/deadline/...）
  - 选择器：`squad-board-{entity}-{id}-selector-{field}`（native choice 卡 / 自定义下拉，禁原生 select）
  - Task 筛选：`squad-board-task-filter-{all|req|kr}` + 选中值 `squad-board-task-filter-value`
  - Task 复制：`squad-board-task-{id}-duplicate`
  - 归档/恢复：`squad-board-{entity}-{id}-archive` / `-restore`
  - dependsOn 断链提示：`squad-board-task-{id}-depends-on-{depId}-archived`（灰链标记）
- ⚠ **native 选择器组件**：choice 卡 / 自定义下拉（`_conventions.md §10` 禁原生 select）—— 复用现有 component spec 或新建
- ⚠ **body markdown 编辑器**：复用或新建 component spec（参考 charter-editor 视觉）
- ⚠ **视觉基线**：本版本**无设计稿**（req/board.md 是讨论稿，无 html 设计图）；按既有 Studio token + board.md v1.1 视觉对齐；视觉保真 compare 暂不强制（无设计稿，PRD §视觉契约口径同 v0.0.57）

### 5.4 Test plan 关联（后续 orchestrator 写 test-plan.md）

14 条 UC → 新建 case 分布（粗估）：
- AT 新增：board 写端点 case × 4-6（编辑/归档/恢复/筛选/复制）；联合检查 fail 验证 × 2
- ET 新增：编辑流程 × 2-3；归档 switch + 提示条 × 2；筛选 + 排序 × 2；复制 × 1
- AT 已有：v0.0.33.3 UC-1~10 board 读端点回归（schema 字段扩展需更新 checkpoint）

---

## 6. 设计决策（task.json 已拍板，PRD 直接采用）

`states/v0.0.60/task.json` decisions 全部拍板（`pending_decisions` 空），不复述全部：

| 决策点 | 取值 | 影响 UC |
|---|---|---|
| `archive_model` | 联合检查（非级联），archived 只表自身 | UC-7/8/9/10 |
| `ancestor_chain` | Task→Req→KR?→Goal?；横向 dependsOn 不在祖先链 | UC-8/10/13 |
| `link_chain` | O→KR→Requirement→Task 统一；Task.source=Requirement；Requirement.relatedKRId 可空 | UC-3/4/11 |
| `body_field` | 全实体 body（长正文 markdown） | UC-1 |
| `no_metric_entity` | 不引入 metric 实体 | 不做项 |
| `task_priority` | urgent/high/medium/low/none；列内排序 | UC-4/5 |
| `ui_vs_agent_rules` | 两层规则分家；活跃区发现性提示条 | UC-8/10 |
| `restore` | 聚合节点级联恢复从属；叶子向上检测祖先；归档反向提示 | UC-9/10/13 |
| `ui_align` | 对齐 design_system.md light token + 三字体；禁原生 select | 全 UI |
| `no_research` | multica 调研已融入 board.md，跳过正式 researcher | 流程 |
| `deadline` | KR + Task 都加；health 改为进度×时间动态判定 | UC-2/4 |
| `goal_completion_algo` | 简单平均 | UC-2 |
| `edit_awareness` | 下次启动重建；不引入实时 event | UC-1/14 |

**Invariants（不可违背）**：
- `o_not_measured`：Goal 不带 target/current；completion% 是 KR 聚合投影
- `archive_self_only`：归档只改自身 archived 字段；可达性交给读取层联合检查
- `unified_task_source`：Task.source 统一为 Requirement；观测 KR 类任务也走需求
- `read_only_board_deprecated`：v0.0.33.3 只读看板契约作废，本期起看板可编辑

---

## 7. 验收口径（待测试计划细化）

- **功能**：14 条 UC 全 AT 覆盖 + 关键流程 ET 覆盖（编辑 / 归档 / 恢复 / 筛选 / 复制）
- **联合检查正确性**：归档 G1 → KR-1/Req-1/Task-1 readable=false（agent 工具读不到）；恢复 G1 → 全部恢复（无级联改数据）
- **视觉保真**：本版本无设计稿，视觉保真 compare 不强制（同 v0.0.57 口径）
- **回归**：v0.0.33.3 UC-1~10 board 读端点回归（schema 扩展后字段不丢）
