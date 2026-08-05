# v0.0.33.3 PRD 变更日志 — OKF 双轨制 + 工作项管理 + system prompt 不落库

## 概述

v0.0.33.2 把 squad 4 scope 对话接通（占位 403 拆除 + 共用 prompt builder + a2a + `<EOS>`）。本版本在对话能力之上，落地**团队目标 / 需求 / 任务的真正管理**——让一个 squad 能接住用户交给它的目标，自己反思、拆解、推进、汇报。

**一句话定位**：OKF 文件系统是 agent 干活的舞台（md 主面，可 grep/cat/git），结构化 store 是给用户/leader 看的镜子（看板 UI），工具是把舞台变化刷进镜子、且兜住文件做不到的强约束（CAS / DAG / 状态机）的手；agent 人设由固定 fragment 组装（不再落库 `member.systemPrompt`），动态上下文（charter/tasks/board）由 reminder 在变化时流式补充。

**父版本**：v0.0.33（squad 启动）；**直接地基**：v0.0.33.2（4 scope 对话 + prompt builder + SessionConfig 5 字段 + send_message squad 别名 + charter/tasks 占位 mapper + reachable_agents reminder provider 已就绪，req13 §1 实测）。

**权威输入**：`reqs/v0.0.33.3/req1`（用户诉求）/ `req3`（双轨方向基线，已用户确认）/ `req4`（OKF 文件系统）/ `req5`（协作协议 + 3 skill）/ `req6-8`（prompt 组装 / reminder 注入 / 动态补充统一机制）/ `req9`（工具 action 全表）/ `req10`（store schema）/ `req11`（reminder provider 详细）/ `req12`（33.2 依赖矩阵）/ `req13`（review 修正）。**概念已全部落定**（7 个 [P1] spec），本 PRD 是其产品化表达，不发明概念。

> **命名一律 `mate`**（role / session.type / 字段语义），延续 33.2；Member entity 字段名（member.tools/skills/model）保留——那是 entity 字段非 role。

---

## 1. 版本目标 [v0.0.33.3]

1. **OKF 双轨制落地**：在 `data_dir/squads/{squadId}/` 之上新增 OKF md 主面（`index.md`/`log.md`/`charter.md`/`board/{goals,krs,requirements,tasks}/*.md`），与现有 store json **同根共存非替换**。md = agent 工作面（bash/grep/cat/write/git），json = 看板/管理投影；冲突以 OKF 为准重算 store；同步责任在 agent（工具只管 store）。
2. **工作项三层管理**：新增 Goal(OKR: O+KR) / Requirement / Task 三层独立 store + 统一 WorkStatus 5 态状态机。Task 必带 `source`（kr|requirement，禁 orphan），支持 `dependsOn` DAG。
3. **管理工具 = store 同步器 + 强约束**：`goal` / `requirement` / `task` 三个 action-based 工具收敛落工具层（LLM 可调），只读写 store，不碰 OKF；兜住强约束：`task(claim)` CAS 原子 / `source` 必填 / DAG 写入时无环检测 / 状态机非法跃迁拒写。`team(update_charter)` 加 `triggeredByMessageId` 对话驱动。
4. **system prompt 不落库（member.systemPrompt 移除）**：3 步迁移——先建 `squad_role` mapper + `prompts/content/squad/{leader,mate,squad_chat}.md` fragment → 切 identity.ts/rules.ts studio 分支返空 → 删 `member.systemPrompt` 字段 + 5 写入点 + input schema 必填约束（derive 模式改配置继承）。
5. **reminder 动态补充**：`charter` / `tasks` 从 stable system_prompt mapper 迁 system_reminder provider（复用 renderCharter，降 tier，加 shouldProduce 去重 + `lastWriteMessageId` 比对 + 10 条兜底）；新增 `squad_board` provider（leader 全 board）。roster 留 stable mapper（频率低，cache 友好）。
6. **3 个 skill（软约束载体）**：`okf-skill`（全员教 OKF 规范）+ `teamwork-leader`（接需求→拆 task→推 KR→管 charter→写日报）+ `teamwork-mate`（认领→干活→报进度）；workspace 可见性规则（leader 全队 / mate 透明只读 board + 自我写 / subagent parent 子集）写进 skill 软约束。
7. **看板只读**：HTTP 读 store 渲染 goals/requirements/tasks 三视图（KR 进度 + 派生 health + 依赖线 + 待认领池）；本版本**只读**，编辑走对话工具或 v1 既有 UI。
8. **双份数据一致性自检**：system prompt 说明「OKF vs store 两份表示」，agent 是一致性维护者（发现 reminder 快照与 OKF 不一致 → 调工具同步），不靠后台自动重算。

---

## 2. 范围（IN / OUT）

### 2.1 IN SCOPE（对齐 req12 §3「可先实现」+ 33.2 已就绪基础）

| 编号 | 模块 | 权威 spec |
|---|---|---|
| **A** | OKF 文件系统（根布局 + 6 type frontmatter + 坏链容忍 + index/log 自动重生成） | `[P1]squad_okf.md` |
| **B** | goal/requirement/task store 投影（每项一文件 json，含 lastWriteMessageId + 派生 health 持久化） | `[P1]data_model.md §3.1-§3.3` |
| **C** | WorkStatus 5 态状态机 + 合法跃迁表 + KR/goal health 派生算法 | `[P1]squad_workitems.md §2` |
| **D** | `goal` / `requirement` / `task` 工具（store 同步器 + CAS/DAG/source 必填/状态机强约束）+ `team(update_charter)` | `[P1]squad_tools.md` |
| **E** | workspace 可见性**软约束**（skill 规则 + prompt 白名单注入） | `[P1]squad_workspace.md §4` |
| **F** | `squad_role` mapper + 3 content fragment（leader/mate/squad_chat.md）+ member.systemPrompt 移除 3 步迁移 | `[P1]prompt_sections.md §3.1/§7` |
| **G** | `squad_charter` / `squad_tasks` / `squad_board` 3 个 system_reminder provider + shouldProduce 去重 + ReminderCtx 扩展 | `[P1]squad_reminder_providers.md` |
| **H** | okf-skill / teamwork-leader / teamwork-mate 三 skill（软约束 + 协作规则 + 工具↔OKF 关系说明） | `req5 §2-§4` |
| **I** | 看板只读视图（HTTP 读 store，goals/requirements/tasks 三视图 + KR 进度条 + health 着色 + 依赖线 + 待认领池） | `[P1]squad_workitems.md §8` |
| **J** | charter 对话演化（user↔leader final text 确认 → update_charter → charter.md + store 同步 + reminder 刷新） | `req5 §6` + `[P1]squad_tools.md §2.1` |

### 2.2 视觉保真口径（无设计稿）

`reqs/v0.0.33.3/` 下**无设计稿**（req3-13 均为方向/skill/工具文字稿）。看板 UI 属新设计——本版本**不强制视觉保真 compare**，按 `06-studio` spec + 现有 Studio 既有视觉对齐（卡片/列/进度条沿用 squad 面板风格）。看板特化视觉细节由 coder 编码前补组件 spec「视觉基线」字段（先 spec 后实现）。

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

每条路径 = 至少一个 AT（真 LLM 真 squad 实跑）或 ET case。**注**：SquadChat 路由 = LLM 驱动哑路由（非确定性，req13 I5），涉及路由的路径 AT 用「直调工具 + GET 验证落库」绕开路由不确定性，ET 容忍路由判断。

| ID | 用户操作链路 | 预期结果 | 覆盖 |
|----|---|---|---|
| **UC-1** | user 看板侧/对话让 leader 建 Goal+KR → `goal(create_objective, create_kr)` → store 落 `goals/{id}.json` + OKF `board/goals/{id}.md`+`board/krs/{id}.md` → 下轮 leader reminder（squad_board）含新 KR | leader 看板出现 Goal+KR；leader prompt 见新 KR；health 派生持久化 | AT |
| **UC-2** | user 群聊提需求 → SquadChat 路由 leader → leader `requirement(create)` → 看板 requirements 视图出现 R-0001[pending] → leader `requirement(triage, accept)` → status 待拆 | 看板出现 requirement；triage 后状态/决策字段落库 | AT（create/triage 直调）+ ET（路由容忍） |
| **UC-3** | leader `task(create, source={requirement,R-0001}, assignee=memberA)` → store+OKF 同步 → memberA 下轮 reminder（squad_tasks）见 T-0001+血缘（→R-0001）→ memberA `task(update_status, in_progress)` → 看板 task 列变化 | mate prompt 见新 task+血缘；update_status 落库；看板刷新 | AT + ET |
| **UC-4** | leader `task(create, source=R-0001)` 不指 assignee → 待认领池（assignee=null）→ memberA `task(claim)` 与 memberB `task(claim)` 并发 → CAS 仅一成功，另一收 `already_claimed` | 并发仅一认领成功；失败方查到 assignee 已变更 | AT（并发 CAS） |
| **UC-5** | leader 建 task A + task B（`dependsOn=[A]`）→ B 初始难推进（依赖未 done）→ A `update_status(done)` → 解锁 B → B 可 `in_progress` | DAG 依赖语义正确；A done 前 B 难推进；A done 后 B 解锁 | AT |
| **UC-6** | memberA 完成 T-0001 → `task(update_status, done)` → memberA（KR 责任 mate）`goal(update_progress, krId, current)` → 派生 kr.health + 联动 goal.health 持久化 → 看板 KR 进度条 + health 着色更新 | 进度落库；health 派生正确；看板进度条/颜色更新 | AT + ET |
| **UC-7** | leader `requirement(promote_to_goal, objective, krs)` → 建 goal（同 create_objective）+ `requirement.status=done` + `relatedGoalId` 回填 | requirements 视图 req 标 done；goals 视图出现新 goal；关联回填 | AT |
| **UC-8** | user 单聊 leader 提 charter 调整 → leader final text 确认 patch → user 确认 → leader `team(update_charter, patch, reason, triggeredByMessageId)` → squad.charter + charter_history append + agent 同步 charter.md → 下轮 leader reminder（squad_charter）含新 charter | charter 双轨同步；history append-only；reminder 下轮刷新 | AT + ET |
| **UC-9** | memberA 工作中发现需求 → `requirement(create, raisedBy={kind:member, id:self})` → 看板 requirements 出现 R-0002（raisedBy=member）→ leader `requirement(triage)` | mate 代提诉求落库；raisedBy 正确；leader 可 triage | AT |
| **UC-10** | member.systemPrompt 字段移除后 → identity.ts/rules.ts studio 分支返空 → squad_role mapper 注入 leader.md/mate.md fragment → 单聊 leader/mate 仍有人设（自报身份对齐 fragment）→ 33.2 对话 case 全回归 PASS | 人设来自 fragment 不来自字段；33.2 backward compat 不破坏 | AT（真 LLM 自报身份）+ ET（33.2 case 回归） |

> **路径归类**：UC-1/4/5/7/9 = 纯工具/store/OKR 逻辑（AT 主覆盖，可单测先行不阻塞）；UC-2/3/6/8/10 = 涉及 reminder 刷新 + 对话 + 看板（AT+ET，依赖 33.2 已接通的 session ingest）。

---

## 4. 对齐 spec（概念权威源，PRD 不复述）

本 PRD 全部概念来自以下 7 个已落定的 [P1] spec，遇歧义以 spec 为准：

| 权威点 | spec |
|---|---|
| OKF 根布局 + 6 type frontmatter + 坏链容忍 + index/log | `[P1]squad_okf.md` |
| 双轨存储 + goal/requirement/task store 投影 schema + lastWriteMessageId + 派生字段策略 | `[P1]data_model.md §3/§3.1/§3.2/§3.3` |
| WorkStatus 5 态状态机 + 合法跃迁表 + KR/goal health 派生算法 + 权限矩阵 + intake 流 + 看板视图 | `[P1]squad_workitems.md §2/§6/§7/§8` |
| 目录布局 + workspace 可见性层级（软约束/硬约束路线） | `[P1]squad_workspace.md §1/§4` |
| 固定 vs 动态归属 + squad_role/roster/parent_task section + system prompt 生命周期 + member.systemPrompt 移除迁移 + 双份数据一致性自检 | `[P1]prompt_sections.md §1/§3/§6/§7/§8` |
| squad_charter/squad_tasks/squad_board 3 provider + shouldProduce 去重 + ReminderCtx 扩展 + 角色注入矩阵 | `[P1]squad_reminder_providers.md` |
| goal/requirement/task/team 工具 action 全表 + store 写 + CAS/DAG/source 必填强约束 + WorkStatus 引用 | `[P1]squad_tools.md §2-§5.6` |

**保留不变（33.2 已落）**：squad/member/charter_history entity schema（`data_model.md §1`）+ a2a 协议 + multi_agent 地基（subagent 派生 / scope EP / 工具可见性）+ SessionConfig 5 字段（sessionType/bizType/squadId/memberId）+ send_message squad 别名 + reachable_agents reminder provider。

---

## 5. 显式排除（推后版本）

| 排除项 | 承接版本 | 理由 |
|---|---|---|
| **SquadChat 路由确定性硬化（B1）** | 后续版本 | 路由 = LLM 驱动哑路由（非确定性，req13 I5），33.3 不硬化；协作回路可靠性留后续 |
| **群聊回路完整时序（B4）** | 后续版本 | mate→leader 群聊回路完整时序依赖路由确定性（req8 §7 遗留） |
| **看板编辑 / drag-drop** | 后续版本 | 本版本看板**只读**；编辑走对话工具或 v1 既有 UI |
| **心跳 / scheduler / budget gate 实跑** | v0.0.33.4 | 字段占位（.1 已落），scheduler 留 v4（req3 §8） |
| **file-watch 唤醒 board 变化触发 leader 醒** | v0.0.33.4 | reactive only（无心跳）足够本版本（req3 §8） |
| **workspace 硬约束（文件权限/沙箱）** | 后续版本 | 本版本仅 skill 软约束 + identity 隔离（charter 不落 mate prompt） |
| **reports 模板强约束** | 后续版本 | reports body 自由 markdown，模板 TBD |
| **视觉保真 compare（无设计稿）** | — | 按既有 Studio 视觉对齐，功能 PASS 即验收 |

---

## 6. 用户验收标准

1. **OKF 双轨可见**：建 squad 后 `data_dir/squads/{id}/` 下同时存在 OKF md（index/log/charter/board/*）与 store json（squad.json/members/board/*），agent 可 grep OKF，看板读 store。
2. **工具可被 LLM 调用**：leader 真聊中调 `goal/requirement/task` 成功写 store + 记 lastWriteMessageId；mate 真调 `task(claim/update_status)`、`requirement(create 代提)`、`goal(update_progress 自己 KR)`。
3. **强约束生效**：CAS 并发仅一成功（`already_claimed`）；DAG 写环 → `dag_cycle`；task 无 source → 拒；状态机非法跃迁 → `illegal_transition`。
4. **reminder 动态刷新**：工具写 store 后，下轮 leader/mate reminder 含新 charter/tasks/board；未变不重复（shouldProduce）；10 条兜底刷新。
5. **member.systemPrompt 移除后人设不丢**：单聊 leader/mate 自报身份对齐 fragment；33.2 全部对话 case 回归 PASS。
6. **看板只读正确**：goals（KR 进度+health）/ requirements（按 status 分组）/ tasks（列=status+依赖线+待认领池）三视图渲染正确。
7. **charter 对话演化**：user↔leader 确认后 charter.md + squad.json.charter + charter_history 同步，下轮 reminder 见新 charter。
8. **数据一致性自检**：system prompt 含「OKF vs store 两份表示 + agent 是一致性维护者」说明（写在 squad_role fragment rules 段）。

---

## 7. 风险点 / 设计注意

- **member.systemPrompt 移除是破坏性迁移**：5 写入点全活（`squad-service.ts:163` / `member-service.ts:84,102` / `handlers/member.ts:199` / `spawn-action.ts:105`）+ team.query 摘要 + createSquad/hire input 必填约束。必须严格按 3 步迁移（先建 mapper→切 identity→再删字段），删字段前确保步骤 2 稳定。**回归门槛**：33.2 全部对话 case PASS 才能合并。
- **SquadChat 路由非确定性**：UC-2/UC-8 涉及路由，ET 容忍路由判断（不强求确定性路由到 leader）；AT 用直调工具绕开。
- **双份数据短暂不一致**：OKF vs store 并发写可能短暂不一致——这是可发现信号（非 bug），靠 agent 对比 reminder 快照主动同步、下轮 reminder 对账。不引入后台自动重算。
- **工具层强约束实现**：CAS（单进程内存锁 + lockfile）、DAG 循环检测、状态机跃迁——这些是文件/OKF 做不到、必须工具层强制的，单测必须覆盖并发/环/非法跃迁边界。
- **reminder injector 触发扩展**：现状只对末尾 `role==='user'` 追加 reminder；squad a2a message（`source==='agent'`）也需触发 → 扩条件（req7 §8.4）。需确认不破坏现有 reminder 语义。
- **看板数据源**：读 store（投影，渲染快），由 agent 同步保证不落后；不直接聚合 OKF（聚合慢）。

---

## 8. spec 对齐问题（留架构/裁决）

PRD 对齐 [P1] spec 自检发现以下需裁决/落地的点（PRD 不擅自改 spec，仅记录）：

1. **charter 的 `lastWriteMessageId` 缺口（需裁决）**：`[P1]data_model.md §1.1` Squad entity schema **无 `lastWriteMessageId` 字段**，但 `[P1]squad_reminder_providers.md §9.1` 的 squad_charter provider 变化检测需要它。**裁决选项**：(a) Squad entity 加字段（data_model 改，与其他 workitem 一致，**倾向**）；(b) charter 投影独立成 `charter.json` 单独记；(c) 用 charter_history 最后一条近似。→ **建议选 (a)**，架构阶段落 data_model §1.1。
2. **data_model.md 体量增长**：§3 新增 store 投影 schema 后 data_model.md 已接近 350 行，超出单文件 300 行硬限。→ **建议架构阶段拆分**（store 投影 schema §3 独立成 `[P1]squad_store_projection.md` 或类似），TBD 非阻塞。
3. **KR health 阈值精调**：`[P1]squad_workitems.md §2.2` 初版阈值 0.7/0.3（on_track/behind/at_risk），且当前 KR schema 无 deadline 字段按 progress 静态判定。→ 待真机数据校准，本版本用初版阈值，TBD。
4. **snapshotMessageId 进 SystemReminder 接口？**：`[P1]squad_reminder_providers.md §9.2` 当前 `SystemReminder={id,content,tier?}` 无该字段，倾向塞进 content 正文末尾（不改接口）。→ 实现层确认。
5. **新 section / 工具 schema 落 tech spec**：`squad_role` mapper / 3 content fragment 文件 / 3 provider / 看板 HTTP 端点 → 架构阶段落 `specs/tech/version_logs/v0.0.33.3/` + 同步 overall；API 端点落 `specs/api/overall/`。

---

## 9. 版本

version: 1.0 `[v0.0.33.3]`（OKR 双轨制首版 PRD：①§1 8 目标（OKF 双轨 / 工作项三层 / 工具=同步器+强约束 / member.systemPrompt 移除 / reminder 动态补充 charter+tasks+board / 3 skill 软约束 / 看板只读 / 双份数据一致性自检）；②§2 10 条 IN（A-J）+ 视觉保真口径（无设计稿按既有 Studio 对齐）；③§3 10 条关键用户路径（建 Goal+KR / 群聊提需求→triage / 拆 task→mate reminder→update_status / 并发 claim CAS / DAG 依赖解锁 / KR 进度推动+health / promote_to_goal / charter 对话演化 / mate 代提 requirement / systemPrompt 移除后人设不丢+33.2 回归）；④§4 7 个 [P1] spec 权威指针；⑤§5 显式排除（SquadChat 路由确定性 / 群聊回路 / 看板编辑 / 心跳 budget / file-watch / workspace 硬约束）；⑥§6 8 条验收标准；⑦§7 风险点（破坏性迁移 / 路由非确定性 / 双份短暂不一致 / 强约束实现 / injector 触发扩展）；⑧§8 spec 对齐问题（charter lastWriteMessageId 缺口裁决 / data_model 拆分 / KR health 阈值 / snapshotMessageId / 新 section 落 tech spec）。基于 req1+req3-13 + 7 个已落 [P1] spec + 33.2 已就绪基础（req13 §1 实测）。命名一律 mate。）
