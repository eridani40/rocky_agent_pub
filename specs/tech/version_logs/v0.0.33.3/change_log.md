# v0.0.33.3 技术变更日志 — OKF 双轨制 + 工作项三层 + system prompt 不落库

> 范围红线：在 v0.0.33.2 已接通的 4 scope 对话能力之上，落地**团队目标 / 需求 / 任务三层管理 + OKF 文件主面 + system prompt fragment 组装**。**AgentLoop 本体零改**（沿用 33.2 共用设计），差异落在 5 个子系统：**store 层**（OKF md 同根共存 + goal/requirement/task 每项一文件投影 + lastWriteMessageId）/ **prompt 层**（squad_role mapper + charter/tasks 迁 reminder provider + squad_board provider + member.systemPrompt 移除）/ **工具层**（goal/requirement/task 同步器 + CAS/DAG/source 必填 + team.update_charter）/ **skill 层**（3 skill 软约束）/ **UI 层**（看板只读）。
> 权威输入：PRD `specs/prd/version_logs/v0.0.33.3/change_log.md`（10 用户路径）+ 7 个 [P1] spec（**squad_okf / squad_store_projection / squad_workitems / squad_workspace / prompt_sections / squad_reminder_providers / squad_tools**）+ req3/req4/req5/req6-8/req9-11/req13。
> 父版本：v0.0.33（squad 启动）；**直接地基**：v0.0.33.2（4 scope 对话 + prompt builder + SessionConfig 5 字段 + send_message squad 别名 + charter/tasks 占位 mapper + reachable_agents reminder provider + studio 403 已拆，req13 §1 实测）。

---

## 1. 改动总览（9 块）

| # | 子系统 | 改动核心 | 权威 spec |
|---|---|---|---|
| **A** | OKF 文件层 | `data_dir/squads/{squadId}/` 之上**新建 OKF md 主面**（index/log/charter.md + board/{goals,krs,requirements,tasks}/*.md），与 store json **同根共存非替换**；6 type frontmatter（type 唯一必填）；坏链容忍；index 自动重生成 + log 倒序 append。建队 skeleton 扩建 OKF md | `[P1]squad_okf.md` |
| **B** | store 层 | goal/requirement/task **每项一文件** store 投影（`board/{goals\|requirements\|tasks}/{id}.json`，KR 嵌 `goal.krs[]` + `ownerMemberId`）+ `lastWriteMessageId`（store 独有，OKF 不带）+ 派生 health 持久化 | `[P1]squad_store_projection.md` |
| **C** | store 层 | **Squad entity 加 `lastWriteMessageId?` 字段**（裁决 C1=(a)，`team(update_charter)` 写时填，squad_charter provider 变化检测用，不独立 charter.json） | `[P1]data_model.md §1.1` v1.2 |
| **D** | prompt 层 | **squad_role mapper**（NEW，stable）按 sessionType 注入 `prompts/content/squad/{leader,mate,squad_chat}.md` 固定 fragment（人设 + 协作规则 + 工具↔OKF 关系 + 一致性自检 rules）；identity.ts/rules.ts studio 分支返空（squad_role 接管） | `[P1]prompt_sections.md §3.1/§7` |
| **E** | prompt 层 | **charter / tasks 从 stable system_prompt mapper 迁 system_reminder provider**（squad_charter 复用 renderCharter + 降 tier + shouldProduce 去重 + lastWriteMessageId 比对 + 10 条兜底；tasks 占位直接换 squad_tasks provider）；**新增 squad_board provider**（leader 全 board）；roster **留 stable mapper**（req13 C6） | `[P1]prompt_sections.md §4` + `[P1]squad_reminder_providers.md` |
| **F** | prompt 层 | **member.systemPrompt 移除**（3 步迁移：先建 squad_role mapper+fragment → 切 identity/rules studio 分支返空 → 删字段+5 写入点+team.query 摘要+input schema 必填+derive 改配置继承） | `[P1]prompt_sections.md §7` |
| **G** | 工具层 | `goal` / `requirement` / `task` 三个 action-based 工具（store 同步器 + CAS/DAG/source 必填/状态机强约束，**不碰 OKF**）+ `team(update_charter)` 加 `triggeredByMessageId`（对话驱动 charter 演化）；每个 action 写 store 记 lastWriteMessageId | `[P1]squad_tools.md` |
| **H** | skill 层 | **3 skill 软约束**：okf-skill（全员教 OKF 规范）+ teamwork-leader（接需求→拆 task→推 KR→管 charter→写日报）+ teamwork-mate（认领→干活→报进度）；workspace 可见性（leader 全队 / mate 透明只读 board + 自我写 + 不见 charter / subagent parent 子集）写进 skill | `[P1]squad_workspace.md §4` + req5 |
| **I** | UI 层 | 看板**只读**视图（HTTP 读 store，goals/requirements/tasks 三视图 + KR 进度条 + health 着色 + 依赖线 + 待认领池）；编辑走对话工具或 v1 既有 UI | `[P1]squad_workitems.md §8` |

**核心不变量**（MUST NOT violate）：
1. **AgentLoop 本体零改**（沿用 33.2 共用设计：mapper/provider 内 Option A 分流 `if(config.sessionType!==X) return []`；loop / stopReason / markIdle 不动）。
2. **工具只管 store，不碰 OKF**（req8 §4）——OKF↔store 同步是 agent 行为（prompt 引导 + skill 规范），无后台自动重算。
3. **member.systemPrompt 移除 = 迁移**（先建 squad_role → 切 identity → 再删字段），不是直接删；33.2 全部对话 case 回归 PASS 才能合并。
4. **同根共存非替换**（req13 I6）——OKF md 在现有 `data_dir/squads/{squadId}/` 之上新建，squad.json/members/*.json 保留。

---

## 2. 改动文件清单（A/M，按子系统）

> 字段 / action / schema 细节以 7 个 [P1] spec 为权威，本表只列文件 + 新增/修改 + 变更要点。

### 2.1 store 层（OKF 文件 + store 投影 + entity）

| 文件 | 操作 | 变更要点 | 权威 |
|---|---|---|---|
| `app/server/src/stores/squad-store.ts` | 修改 | Squad entity schema 加 `lastWriteMessageId?: string`（C1=a）；`createSquadService` 骨架扩建 OKF md（index/log/charter.md + board 子目录） | data_model §1.1/§4 + squad_okf §1 |
| `app/server/src/stores/{goal,requirement,task}-store.ts`（或合并 `board-store.ts`） | 新增 | 每项一文件 CRUD（`board/{goals\|requirements\|tasks}/{id}.json`，按 squadId 分片）+ KR 嵌 goal.krs[] + ID 序号自增（`.state/counters.json`）+ 写时填 lastWriteMessageId | squad_store_projection §1/§2 |
| `app/server/src/stores/member-store.ts` / `member-service.ts` / `squad-service.ts:163` / `handlers/member.ts:199` / `spawn-action.ts:105` | 修改 | **移除 systemPrompt 写入点**（迁移 step 3）+ derive 模式改配置继承（复制 parent.{role降mate,tools,skills,model}） | prompt_sections §7 |

### 2.2 prompt 层（mapper / provider / content fragment）

| 文件 | 操作 | 变更要点 | 权威 |
|---|---|---|---|
| `app/plugins/builtins/rocky_context/prompt/squad_role.ts` | 新增 | system_prompt_mapper（stable，priority 950）按 sessionType 注入 leader.md/mate.md/squad_chat.md fragment | prompt_sections §3.1 |
| `app/plugins/builtins/rocky_context/prompt/{leader,mate,squad_chat}.md`（content fragment） | 新增 | 固定规范：人设 + rules + 协作规则 + 工具↔OKF 关系 + 一致性自检（随代码走，非 DB 字段） | prompt_sections §3.1/§8 |
| `app/plugins/builtins/rocky_context/prompt/charter.ts` → `squad_charter.ts` | 改名+迁 EP | stable system_prompt_mapper → system_reminder provider（复用 renderCharter + 降 tier info + shouldProduce 去重 + lastWriteMessageId 比对 + 10 条兜底） | prompt_sections §4 + reminder_providers §2 |
| `app/plugins/builtins/rocky_context/prompt/tasks.ts` → `squad_tasks.ts` | 删+新建 | 占位 mapper 删 → squad_tasks provider（mate 自己 tasks + source 血缘） | prompt_sections §4 + reminder_providers §3 |
| `app/plugins/builtins/rocky_context/prompt/squad_board.ts` | 新增 | system_reminder provider（leader 全 board：goals+requirements+tasks） | reminder_providers §4 |
| `app/plugins/builtins/rocky_context/prompt/team_roster.ts` | 修改 | 留 stable mapper；渲染 member 字段**去 systemPrompt**（返 {name,role,sessionId,state}） | prompt_sections §3.2 |
| `app/plugins/builtins/rocky_context/prompt/identity.ts` / `rules.ts` | 修改 | studio 分支（leader/mate/squad）返空（squad_role 接管身份正文+角色规则）；standalone 不变 | prompt_sections §3.1/§7 step2 |
| `app/plugins/builtins/rocky_context/plugin.json` | 修改 | system_prompt_mapper EP：加 squad_role、删 charter/tasks；system_reminder EP：加 squad_charter/squad_tasks/squad_board | prompt_sections §9 |
| `app/server/src/agent/system_reminder_injector.ts:54-55` | 修改 | 触发条件扩：末尾 message `role==='user' \|\| source==='agent'`（a2a 也触发 reminder） | reminder_providers §8 |
| `rocky_context/types.ts` ReminderCtx + `bootstrap.ts` | 修改 | ReminderCtx 加 `squadContext`（squad/member/board store service 封装）+ `transcriptReader`（findLastReminder / messageCountSince）；bootstrap 注入 board store 句柄 | reminder_providers §1 |

### 2.3 工具层（goal / requirement / task / team）

| 文件 | 操作 | 变更要点 | 权威 |
|---|---|---|---|
| `app/server/src/agent/tools/goal-tool.ts` / `requirement-tool.ts` / `task-tool.ts` | 新增 | action-based 工具（goal: create_objective/create_kr/update_progress/edit/set_status/query；requirement: create/triage/promote_to_goal/set_status/query；task: create/assign/claim/update_status/query）；权限按 caller 角色；写 store 记 lastWriteMessageId；**强约束**：task(claim) CAS / source 必填 / DAG 无环 / 状态机非法跃迁拒写 | squad_tools §3/§4/§5/§5.6 |
| `app/server/src/agent/tools/team-tool.ts` | 修改 | 加 `update_charter` action（patch merge squad.charter + append charter_history + 记 lastWriteMessageId + 返 {charterVersion,historyId}）；移除 systemPromptSummary（team.query 不再返） | squad_tools §2/§2.1 |
| `app/server/src/agent/tools/runtime-context.ts` | 修改 | AgentToolRuntimeContext 加 board store 句柄 + currentMessageId（工具写 lastWriteMessageId 用） | squad_tools §0 |
| `app/server/src/tools/registry.ts` | 修改 | defaultTools 加 goal/requirement/task 工具导出 | squad_tools §1 |
| `app/server/src/agent/scope-allowed-tools.ts` + `agent-loop-stage-llm.ts` | 修改 | leader 可见 goal/requirement/task/team；mate 可见 task(claim/update_status/query)/requirement(create/query)/goal(update_progress 自己 KR)（schema 层裁剪 + allowedTools 维度） | squad_tools §3/§4/§5 + 33.2 §2.C |

### 2.4 skill 层（3 skill 软约束）

| 文件 | 操作 | 变更要点 | 权威 |
|---|---|---|---|
| `skills/okf-skill` / `teamwork-leader` / `teamwork-mate`（位置 TBD） | 新增 | 软约束载体：教 OKF 规范 + 协作规则 + workspace 可见性规则 + 工具↔OKF 关系；leader 全队 / mate 透明只读 board + 自我写 + 不见 charter / subagent parent 子集 | squad_workspace §4 + req5 §2-§4 |

### 2.5 UI 层（看板只读，组件 spec 由 coder 编码前置产出）

| 组件 spec | 新/改 | 归属 |
|---|---|---|
| `studio-page/squad-board-page.*`（goals/requirements/tasks 三视图） | 新建 | 看板只读（KR 进度条 + health 着色 + 依赖线 + 待认领池） |
| 现有 squad 管理 / 群聊 / 单聊组件 | 修改 | 入口接看板 + roster 去系统提示字段 |

> **组件 spec 总纲**：`specs/tech/app/frontend/[P0]component_architecture.md`（已有则增量）；规范：`specs/ui/components/_conventions.md`（已存在则增量）。无设计稿，按 `06-studio` + 既有 Studio 视觉对齐（卡片/列/进度条沿用 squad 面板风格）；看板特化视觉细节由 coder 编码前补组件 spec「视觉基线」字段（先 spec 后实现）。

---

## 3. 与 v0.0.33.2 集成点（复用已就绪基础）

v0.0.33.2 已接通 4 scope 对话（req13 §1 实测），本版本**不重造**，复用：

| 复用基础 | 33.2 落点 | 33.3 用法 |
|---|---|---|
| **4 scope 共用 AgentLoop**（本体零改 + Option A 分流） | 33.2 §1 | squad_role / 3 provider 内 `if(config.sessionType!==X) return []` 分流；新工具走 33.2 schema 裁剪 + allowedTools 框架 |
| **SessionConfig 5 字段**（sessionType/bizType/squadId/memberId/studioContext） | `context-types.ts:165` + `session-config.ts:135-234` | provider 工具取 caller 上下文（角色 filter + memberId 过滤）；ReminderCtx 扩展在此之上加 squadContext |
| **send_message squad 别名 + clique 校验** | `send-message-tool.ts:141-184` + `runtime-context.ts:213-271` | req5 协作回路（mate→leader 问老板 / leader→mate 下达）依赖；本版本不动 |
| **reachable_agents reminder provider** | `prompt/reachable_agents.ts` | 33.3 的 3 provider 与之并列（同 system_reminder EP），shouldProduce 逻辑复用 |
| **charter.ts 渲染逻辑**（stable mapper，33.2 已落） | `prompt/charter.ts` | **复用 renderCharter**，迁文件名 `charter.ts` → `squad_charter.ts` + 改 EP + 降 tier + 加去重（req13 C2：迁移非从零建） |
| **studio 403 已拆** | `session-messages.ts:195` | session 可 ingest → provider 实际可跑 reminder；工具可被 LLM 实际调用 |
| **team v2 只读工具** | `team-tool.ts`（list/query/get_charter） | 33.3 在此之上加 `update_charter` 写 action + 3 个新工作项工具 |
| **PromptFragment / SystemReminder EP**（v0.0.22/0.0.13） | 既有 | squad_role 走 system_prompt_mapper；3 provider 走 system_reminder，**不新增 EP** |

**关键迁移点**（非新建，req13 C2/C3）：
- charter：`stable system_prompt_mapper` → `system_reminder provider`（改 EP + 降 tier + 加去重），**复用 renderCharter 渲染**，文件改名 `charter.ts` → `squad_charter.ts`。
- tasks：33.2 占位 mapper（mate only，working tier）**直接删** → 换 `squad_tasks` provider。

---

## 4. 风险点

1. **member.systemPrompt 移除是破坏性迁移**（最高风险）：5 写入点全活（`squad-service.ts:163` / `member-service.ts:84,102` / `handlers/member.ts:199` / `spawn-action.ts:105`）+ team.query 摘要 + createSquad/hire input 必填约束。**必须严格 3 步**（先建 squad_role mapper+fragment → 切 identity/rules studio 分支返空 → 再删字段），删字段前确保 step 2 稳定。**回归门槛**：33.2 全部对话 case PASS 才能合并（UC-10）。**回滚**：step 2 失败可回退（字段仍在）；step 3 字段删除后不可回滚。
2. **charter lastWriteMessageId 一致性**：C1=(a) 已裁决落 squad entity，但 `team(update_charter)` 必须正确填当前 message id（caller 不直传，工具自动取），否则 squad_charter provider 变化检测失效（误判未变不刷新）。需单测覆盖「写后下轮 reminder 必刷新」。
3. **reminder provider 性能 + 去重**：每次 ingest 跑 provider 链（squad_charter/tasks/board + reachable_agents）；shouldProduce 必须先角色 filter 再 findLastReminder + lastWriteMessageId 比对，避免无谓 store 读 + transcript 扫描。board 大时分段（控量）+ transcript 扫描范围限近 N 条（TBD §10）。injector 触发扩 a2a 后，高频 a2a 可能频繁跑 provider——需确认不破坏现有 reminder 语义。
4. **OKF 并发写**：多 agent 同时改 board → 单进程内存锁 + 写盘前 lockfile（req1 §2.1）。高频小写（status/assignee）走 store（并发安全）；低频大写（charter/report）走 OKF 文件。lockfile 粒度（按文件 vs 按 board 目录）TBD（PRD 阶段拍板）。
5. **SquadChat 路由非确定性**（req13 I5）：UC-2/UC-8 涉及路由，路由 = LLM 驱动哑路由（非确定性），33.3 **不硬化**。**AT 用直调工具 + GET 验证落库绕开路由不确定性；ET 容忍路由判断**（不强求确定性路由到 leader）。协作回路可靠性留后续版本。
6. **双份数据短暂不一致**（非 bug，是可发现信号）：OKF vs store 并发写短暂不一致 → agent 对比 reminder 快照主动同步、下轮 reminder 对账。system prompt 必须说明（写进 squad_role fragment rules 段）。**不引入后台自动重算**。

---

## 5. 显式排除（推后版本）

| 排除项 | 承接版本 | 理由 |
|---|---|---|
| **SquadChat 路由确定性硬化（B1）** | 后续 | 路由 = LLM 驱动哑路由（非确定性，req13 I5），33.3 不硬化；AT 绕开 / ET 容忍 |
| **群聊回路完整时序（B4）** | 后续 | mate→leader 群聊回路完整时序依赖路由确定性（req8 §7 遗留） |
| **看板编辑 / drag-drop** | 后续 | 本版本看板**只读**；编辑走对话工具或 v1 既有 UI |
| **心跳 / scheduler / budget gate 实跑** | v0.0.33.4 | 字段占位（33.1 已落），scheduler 留 v4（req3 §8） |
| **file-watch 唤醒 board 变化触发 leader 醒** | v0.0.33.4 | reactive only（无心跳）足够本版本（req3 §8） |
| **workspace 硬约束（文件权限/沙箱）** | 后续 | 本版本仅 skill 软约束 + identity 隔离（charter 不落 mate prompt） |
| **reports 模板强约束** | 后续 | reports body 自由 markdown，模板 TBD |
| **视觉保真 compare（无设计稿）** | — | 按既有 Studio 视觉对齐，功能 PASS 即验收 |

---

## 6. spec 拆分 + 引用同步（本架构产出）

| 文件 | 操作 | 说明 |
|---|---|---|
| `specs/tech/squad/[P1]squad_store_projection.md` | 新增 | 从 `[P1]data_model.md §3.1/§3.2/§3.3` 拆出独立成文（data_model 超 300 行硬限）：store 投影 json schema + ID 生成 + lastWriteMessageId 语义（含 charter 落 squad entity，C1=a）+ 派生字段策略 |
| `[P1]data_model.md` | 修改 v1.2 | §3.1-§3.3 拆出 → §3 仅留存储布局总述 + 指针；§1.1 Squad entity 加 `lastWriteMessageId?`（C1=a） |
| `[P1]squad_workitems.md` / `[P1]squad_okf.md` / `[P1]squad_workspace.md` / `[P1]prompt_sections.md` / `[P1]squad_tools.md` / `[P1]squad_reminder_providers.md` | 修改引用 | 「data_model §3.1/§3.2/§3.3」schema 类引用 → `squad_store_projection.md §1/§2/§3`；存储布局类引用保留 `data_model §3`；reminder_providers §9.1 charter lastWriteMessageId 缺口标注 C1=a 已落 |

---

## 7. 版本

version: 1.0 `[v0.0.33.3]`（OKF 双轨制 + 工作项三层 + system prompt 不落库首版架构：①§1 9 块改动总览（OKF 文件层新建 / store 投影每项一文件 / squad entity lastWriteMessageId[C1=a] / squad_role mapper + member.systemPrompt 移除 / charter·tasks 迁 reminder provider + squad_board 新增 / goal·requirement·task 工具 + team.update_charter / 3 skill 软约束 / 看板只读）+ 4 核心不变量；②§2 文件级变更清单（store 层 / prompt 层 / 工具层 / skill 层 / UI 层，引用 7 个 [P1] spec 权威）；③§3 与 v0.0.33.2 集成点（4 scope AgentLoop / SessionConfig 5 字段 / send_message 别名 / reachable_agents provider / charter.ts 渲染迁移 / studio 403 已拆）；④§4 风险点（破坏性迁移顺序 / charter lastWriteMessageId 一致性 / provider 性能去重 / OKF 并发写 / SquadChat 路由非确定性 / 双份数据短暂不一致）；⑤§5 显式排除（B1/B4/看板编辑/心跳/file-watch/硬约束）；⑥§6 spec 拆分 + 引用同步（squad_store_projection 独立 + data_model v1.2 + 6 spec 引用更新）。基于 PRD v1.0 + 7 个已落 [P1] spec + req3-13 + 33.2 已就绪基础（req13 §1 实测）。命名一律 mate。）
