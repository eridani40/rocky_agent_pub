# v0.0.60.squad_ui_2 Tech Change Log — 看板可编辑 + 联合检查归档 + 统一关联链路 + body/priority/deadline + 动态 health

> version: 1.0 · 2026-07-04
> 范围：squad 看板从**只读**升级为**全实体全字段可编辑**（HTTP 写端点 + 工具写 action），新增**联合检查归档机制**（archived self-only，readable 联合检查派生）+ **统一关联链路**（O→KR→Requirement→Task）+ `body`/`priority`/`deadline` 字段 + **动态 health 算法**（进度×时间）+ Goal completion%（KR 算术平均）+ 编辑感知（下次启动重建）。AgentLoop 本体零改；OKF 双轨 + 工具同步器 + reminder provider 框架沿用。
> 权威输入：`reqs/[working] v0.0.60.squad_ui_2/{req,board}.md`（用户要求 + 概念定稿）+ `specs/prd/version_logs/v0.0.60/change_log.md`（PRD §5 spec 缺口清单）+ `states/v0.0.60/task.json`（decisions 全拍板）。
> 父版本地基：v0.0.33.3（OKF 双轨 + 工作项三层 + system prompt 不落库）+ v0.0.48（static-by-type 工具集）+ v0.0.56（SessionKind）。

---

## 1. 改动总览（8 块）

| # | 子系统 | 改动核心 | 权威 spec |
|---|---|---|---|
| **A** | 归档机制（联合检查） | 新增 `[P1]squad_archive.md`：`archived` self-only + `readable`/`effective_archived` 派生（响应层算）+ 祖先链 + UI/Agent 两层规则分家 + 横向 dependsOn 断链降级 + 恢复语义（聚合自动 / 叶子向上检测）+ 编辑感知 | `[P1]squad_archive.md`（新增） |
| **B** | 统一关联链路 | Task.source 统一为 `{requirementId}`（去 kind 二选一）；Requirement 用 `relatedKRId` 替代 `relatedGoalId`（字段废弃）；祖先链按统一链路推导 | `[P1]squad_workitems.md §3-§5` + `[P1]squad_store_projection.md §1.2/§1.3` + `[P1]squad_tools.md §3-§5` |
| **C** | body 正文字段 | 全实体加 `body?: string`（长正文 markdown），区别 title（短）+ 摘要（description/detail） | 同上 |
| **D** | Task priority + 看板排序 | Task 加 `priority: urgent\|high\|medium\|low\|none`；列内按 priority → updatedAt 排序（替代 v0.0.33.3 assignee 分组） | `[P1]squad_workitems.md §5/§8` |
| **E** | deadline + 动态 health | KR + Task 加 `deadline?: date`；KR health 改为**进度×时间动态**（容差 -0.1/-0.3）；无 deadline 回退静态阈值 0.7/0.3；§10 TBD 划掉 | `[P1]squad_workitems.md §2.2` |
| **F** | Goal completion% | KR completion% 算术平均（简单平均，task.json `goal_completion_algo`） | `[P1]squad_workitems.md §2.2` |
| **G** | 编辑感知（下次启动重建） | UI 编辑写 store + 记 `lastWriteMessageId`；reminder provider shouldProduce 下次跑检测变化重出；无实时 event 推送（沿用 v0.0.33.3 既有契约） | `[P1]squad_archive.md §6` + `[P1]squad_reminder_providers.md §0` |
| **H** | Task 复制（duplicate） | 工具加 `task(duplicate)` action：复制 source/assignee/deadline；status=pending；priority=none；不复制 dependsOn（避免环）；新自增 id | `[P1]squad_tools.md §3` |

**核心不变量**（MUST NOT violate）：
1. **`archive_self_only`**：归档只改自身 archived 字段；禁止级联改子数据；可达性交给读取层联合检查派生（响应层算）。
2. **`unified_task_source`**：Task.source 统一为 Requirement ref；不保留 Task 直挂 KR 特例（旧 schema migrate 走「建观测 Requirement 中转」）。
3. **`read_only_board_deprecated`**：v0.0.33.3 只读看板契约作废，本期起看板可编辑（所有实体全字段）。
4. **`o_not_measured`**：Goal 不带 target/current；completion% 是 KR 聚合投影（简单平均），非 O 自身度量。
5. **AgentLoop 本体零改**——所有变更落在 spec / store schema / 工具 / reminder provider / HTTP 端点五处。
6. **OKF 双轨 + 工具同步器不变**——store 与 OKF md 同步仍由 agent 负责（prompt 引导 + skill 规范）；工具只管 store。

---

## 2. 设计决策（task.json decisions → spec 落地）

### 2.1 归档联合检查（vs 级联）— `archive_model`

**问题**：归档 Goal 时是否级联改所有后代 archived=true？级联需要 O(N) 遍历 + 并发风险 + 恢复时反向遍历（子自身原本归档的状态可能被错误复活）。

**决策**：联合检查（非级联）。`archived` 只表自身；可达性 = `self.archived==false ∧ 所有祖先.archived==false`（`readable` 派生）。归档 Goal 只改 1 个字段；恢复 O(1) 天然对称；无悬空引用。

**spec 落地**：`[P1]squad_archive.md` 新章 §1（核心模型）+ §2（祖先链）+ §3（UI/Agent 两层规则）；`squad_workitems.md` 各实体 interface 加 `archived/archivedAt?/archivedBy?`；`squad_store_projection.md §1` 同步；`squad_reminder_providers.md §3/§4` 加 `filter readable==true`。

### 2.2 统一关联链路 — `link_chain`

**问题**：Task.source 二选一（`kind:"kr"|"requirement"`）+ Requirement.relatedGoalId（直挂 Goal）违反「O→KR→Requirement→Task」概念分层；观测 KR 类 Task 缺统一溯源。

**决策**：Task.source 统一为 `{requirementId}`（去 kind 二选一）；Requirement 用 `relatedKRId` 挂 KR（可空 = 野生）；观测 KR 类 Task 先建「观测 KR-X」Requirement 中转再挂 Task；祖先链按统一链路推导（归档联合检查用）。

**spec 落地**：`squad_workitems.md §1/§3-§5` schema 改；`squad_store_projection.md §1.2/§1.3` 同步；`squad_tools.md §3-§5` schema 跟改（含野生 Requirement 语义 + promote_to_goal 回填链路改 relatedKRId）；`11b-squad-workitems.md` 字段对齐表更新。旧字段（`relatedGoalId` / `source.kind`）标 deprecated。

### 2.3 health 进度×时间动态 — `deadline`

**问题**：v0.0.33.3 KR health 静态阈值 0.7/0.3（仅看 progress）——「进度 0.5 + 还剩 3 个月」被标 behind 不合理；缺时间维度。

**决策**：KR + Task 加 `deadline?`；有 deadline 时 health = 进度 vs 时间流逝比动态判定（slack=progress-elapsed/total；slack≥-0.1=on_track / ≥-0.3=behind / 否则 at_risk；progress≥1=on_track）；无 deadline 回退静态阈值。

**spec 落地**：`squad_workitems.md §2.2` 重写算法（保留旧阈值作「无 deadline 回退分支」）；`squad_store_projection.md §1.1/§1.3` 加 deadline 字段；`squad_tools.md §3-§4` create/edit 接 deadline。

### 2.4 编辑感知下次启动重建 — `edit_awareness`

**问题**：UI 编辑字段后，agent 在同会话内是否实时感知？实时 = SSE/polling/event 推 reminder（基础设施重）。

**决策**：下次启动重建。UI 编辑写 store 记 `lastWriteMessageId`；下次 user 发消息触发 ingest → reminder provider shouldProduce 检测变化重出（沿用 v0.0.33.3 既有契约）。代价：当轮对话 agent 仍按旧状态回复（轮次延迟）。

**理由**：编辑是用户主导动作，不需要 agent 即时反馈；强制即时会破坏 chat fire-and-forget 语义 + 重塑 reminder 生命周期。

**spec 落地**：`squad_archive.md §6`（编辑感知章）+ `squad_reminder_providers.md §0` 加 v0.0.60 说明。

### 2.5 Goal completion% 简单平均 — `goal_completion_algo`

**问题**：聚合算法候选 min（木桶，太悲观）/ 加权平均（需权重字段，缺数据）/ 简单平均。

**决策**：简单平均（`sum(kr.completion%) / count(krs)`）。UI 可视化辅以 KR 列表展示明细，避免「一个 KR 拖延 = Goal 0%」的误导。

**spec 落地**：`squad_workitems.md §2.2` 加 Goal completion% 派生规则；`squad_store_projection.md §3` 派生字段策略表加（不持久化，响应层算）。

---

## 3. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `specs/tech/squad/[P1]squad_archive.md` | 新增 | 归档机制独立 spec：联合检查模型 + 祖先链 + UI/Agent 两层规则 + 横向 dependsOn 断链 + 恢复语义 + 编辑感知 + 边界（148 行） |
| `specs/tech/squad/[P1]squad_workitems.md` | 修改 | frontmatter `updated: 2026-07-04`；§1 Task source 统一化；§2.2 health 动态算法 + Goal completion%；§3 Goal interface 加 body/archived/relatedKRId 派生；§3 KR interface 加 body/deadline/archived；§4 Requirement interface 加 body/relatedKRId（替 relatedGoalId）/archived；§5 Task interface 加 body/priority/deadline/archived + source 去 kind；§8 看板视图 priority 排序 + zone；§9 边界引用 archive.md；§10 TBD 划掉 |
| `specs/tech/squad/[P1]squad_store_projection.md` | 修改 | frontmatter `updated: 2026-07-04`；§1.1-§1.3 各实体 schema 加 body/priority/deadline/archived；§1.2 relatedGoalId→relatedKRId；§1.3 source 去 kind；§3 派生字段策略加 readable/effectiveArchived/completionPct（响应层算）；§4 边界引用 archive.md |
| `specs/tech/squad/[P1]squad_reminder_providers.md` | 修改 | frontmatter `updated: 2026-07-04`；§0 加 v0.0.60 说明（filter readable + 编辑感知）；§3 squad_tasks 数据源 filter readable + dependsOn 降级；§4 squad_board filter readable |
| `specs/tech/squad/[P1]squad_tools.md` | 修改 | frontmatter `updated: 2026-07-04`；§0 加 v0.0.60 说明（统一 source + 新字段 + archive/duplicate）；§3 task 加 edit/duplicate/archive/restore action；§4 goal + §5 requirement 加 archive/restore + edit patch 含 body/deadline；§5 relatedGoalId→relatedKRId；query 各工具默认 filter readable==true |
| `specs/tech/squad/index.md` | 修改 | ④核心设计原则加 4 条（archive 联合检查 / 统一关联链路 / health 动态 + completion% / 编辑感知）；workitem 概念表更新；⑤导航加 squad_archive.md |
| `specs/tech/squad/log.md` | 修改 | 顶部加 v0.0.60.squad_ui_2 条目（ISO 倒序） |
| `specs/api/overall/11b-squad-workitems.md` | 重写 v1.0→v2.0 | 新增 §3 写端点（POST/PATCH goals/krs/requirements/tasks + duplicate + archive/restore）；§2 响应 schema 扩展（body/priority/deadline/archived + 派生 readable/effectiveArchived/completionPct）；§4 zone/filter/sort query；§6 字段废弃（relatedGoalId/source.kind）；详见 api change_log |
| `specs/api/version_logs/v0.0.60/change_log.md` | 新增 | API 跨版本发布说明 |

---

## 4. 关键设计原则落 spec 位置（教训：核心决策必须落 spec，否则下游 agent 迷路）

| 核心设计原则 | spec 落点 |
|---|---|
| 归档只在自身，可达性读取层派生（不级联） | `[P1]squad_archive.md §1`（性质 + 反例）+ `index.md ④第9条` + `squad_workitems.md §9 边界` |
| 横向 dependsOn 不在祖先链，断链降级不报错 | `[P1]squad_archive.md §4`（独立章）+ `squad_reminder_providers.md §3`（dependsOn 降级） |
| UI vs Agent 两层规则分家（活跃区 vs readable） | `[P1]squad_archive.md §3`（独立章 + 理由） |
| 编辑写回与 agent 推理解耦（下次启动重建） | `[P1]squad_archive.md §6`（独立章 + 不引入项 + 理由）+ `index.md ④第12条` |
| 统一关联链路（Task.source=Requirement；relatedKRId 替 relatedGoalId） | `index.md ④第10条` + `squad_workitems.md §1/§3-§5` |
| health 进度×时间动态（容差 -0.1/-0.3） | `squad_workitems.md §2.2`（重写算法 + 语义说明）+ `index.md ④第11条` |
| Goal completion% 简单平均（不取 min / 不加权） | `squad_workitems.md §2.2`（含理由） |
| Task duplicate 不复制 dependsOn（避免环） | `squad_tools.md §3`（duplicate 行 + 约束章） |
| 派生字段（readable/effectiveArchived/completionPct）响应层算不落库 | `squad_store_projection.md §3`（派生字段策略表）+ `squad_archive.md §1`（反例：避免冗余存储） |

---

## 5. 代码-spec 一致预留（实现须走 X 链路）

为防 coder 静默偏离 spec（教训 v0.0.49：`ForkedContextPort` 绕过 spec 链），明确实现路径：

| spec 声明 | 实现层归属 | 禁止偏离 |
|---|---|---|
| 归档过滤（readable==true）在 reminder provider 层 | `app/plugins/builtins/rocky_context/prompt/squad_*.ts` provider 读取 store 后 filter | ❌ 不在 store 层做 filter（store 保留全部 record；过滤在读取/响应层） |
| readable / effectiveArchived / completionPct 派生在响应层算 | HTTP 端点 response builder + 工具 query output 拼装 | ❌ 不冗余落 store（避免数据漂移） |
| 归档 archive/restore 只改 self.archived（不级联） | `squad_tools` 工具 handler / HTTP board write endpoint handler | ❌ 不在 handler 里遍历改子（违反 archive_self_only invariant） |
| 横向 dependsOn 降级滤除（agent 视图） | reminder provider format 阶段 + 工具 task query output | ❌ 不在 store 层删 dependsOn 引用（保留依赖关系历史） |
| health 派生（含动态算法）在工具/HTTP 写时算并写 | `goal(update_progress)` / `create_kr` / `PATCH /board/krs/:kid` / `PATCH /board/goals/:gid` 写时算 | ❌ 不在响应层每次重算（性能 + 一致性；health 持久化免重算） |
| Task source 统一为 Requirement | `task.create` handler 校验 source.requirementId 必填 + 工具 schema inputSchema.properties 跟改 | ❌ 不在 handler 容忍旧 kind 字段（旧 record 走 migrate 路径，不在新写入兼容） |
| 编辑感知走 lastWriteMessageId（不引入 event 推送） | HTTP 写端点写 store 时取 session context 当前 message id 写入（与 LLM 工具一致） | ❌ 不在 HTTP 写端点额外触发 reminder 重算 / 不引 SSE 推送 |

---

## 6. 与 PRD §5 spec 缺口清单对齐

PRD §5.1 Tech spec 8 项缺口 + §5.2 API spec 4 项缺口全部落地：

| PRD §5 项 | 落 spec 文件 | 章节 |
|---|---|---|
| 联合检查归档模型 | `[P1]squad_archive.md`（新增） | §1-§7 |
| 统一关联链路 | `[P1]squad_workitems.md §3-§5` + `[P1]squad_store_projection.md §1.2/§1.3` + `[P1]squad_tools.md §3-§5` | schema 改 |
| body 字段 | `[P1]squad_workitems.md §3-§5` + `[P1]squad_store_projection.md §1` | interface 加 body? |
| Task priority + 看板排序 | `[P1]squad_workitems.md §5/§8` | priority 字段 + §8 排序规则 |
| deadline + 动态 health | `[P1]squad_workitems.md §2.2` + `[P1]squad_store_projection.md §1.1/§1.3` | deadline 字段 + health 算法重写 |
| Goal completion% | `[P1]squad_workitems.md §2.2` + `[P1]squad_store_projection.md §3` | 派生规则 |
| 编辑感知 | `[P1]squad_archive.md §6` + `[P1]squad_reminder_providers.md §0` | 下次启动重建 |
| Task 复制 | `[P1]squad_tools.md §3` | task(duplicate) action |
| API 写端点（11b） | `specs/api/overall/11b-squad-workitems.md` v2.0 | §3 写端点章 |
| API 响应字段扩展 | `11b-squad-workitems.md §2.2` | schema 扩展 |
| API zone/filter/sort query | `11b-squad-workitems.md §4` | query 参数 |
| API 字段废弃 | `11b-squad-workitems.md §6` | relatedGoalId / source.kind deprecated |

---

## 7. 与 PRD 决策表对齐（task.json decisions → spec 落地）

| 决策点 | spec 落点 |
|---|---|
| `archive_model`（联合检查） | `[P1]squad_archive.md §1` |
| `ancestor_chain`（Task→Req→KR?→Goal?） | `[P1]squad_archive.md §2` |
| `link_chain`（O→KR→Req→Task 统一） | `index.md ④第10条` + `squad_workitems.md §1/§3-§5` |
| `body_field`（全实体 body） | `squad_workitems.md §3-§5` + `squad_store_projection.md §1` |
| `no_metric_entity`（不引入 metric） | `squad_workitems.md §3`（KR 自带 target/current/unit） |
| `task_priority`（urgent/high/medium/low/none） | `squad_workitems.md §5/§8` + `squad_tools.md §3` |
| `ui_vs_agent_rules`（两层规则分家） | `[P1]squad_archive.md §3` |
| `restore`（聚合级联 / 叶子向上） | `[P1]squad_archive.md §5` |
| `ui_align`（design_system token + 禁原生 select） | UI spec（coder 编码前置落 squad-board.md v2.0，本 tech 不碰） |
| `no_research`（跳过 researcher） | 流程（board.md 已融入 multica 调研） |
| `deadline`（KR + Task 都加） | `squad_workitems.md §3/§5` + `squad_store_projection.md §1` |
| `goal_completion_algo`（简单平均） | `squad_workitems.md §2.2` |
| `edit_awareness`（下次启动重建） | `[P1]squad_archive.md §6` |

---

## 8. 不做项 / 排除（PRD §4.2 + 本 tech 边界）

- ❌ 独立 metric（指标）实体 — KR 自带度量（`no_metric_entity`）
- ❌ O 层直接衡量 — Goal 不带 target/current（`o_not_measured`）
- ❌ 归档级联改子 — 联合检查（`archive_self_only`）
- ❌ O/KR/Requirement 复制 — 仅 Task 可复制
- ❌ 实时编辑感知 — 仅下次启动重建（`edit_awareness`）
- ❌ `effective_archived` 落库 — 派生在响应层算
- ❌ 取消对话工具写 board — 双轨保留（对话工具仍可写 + 新增 HTTP 写端点）
- ❌ 改动 specs/ui/ — UI 缺口 5 项由 coder 编码前置落 `specs/ui/components/studio-page/squad-board.md` v2.0
- ❌ 改动 specs/prd/ — PRD 已定稿

---

## 9. 后续工作（coder 编码前置）

1. **UI 组件 spec 落地**：`specs/ui/components/studio-page/squad-board.md` v1.x → v2.0（编辑入口 + new testid + native 选择器 + body 编辑器 + 视觉基线）。
2. **测试用例设计**（test-plan 后）：API 写端点 case（编辑/归档/恢复/筛选/复制）+ 联合检查 fail 验证 + ET 编辑流程/归档 switch/提示条。
3. **代码实现**（coder）：照本文 §5「代码-spec 一致预留」实现，禁止偏离 spec 链路。
