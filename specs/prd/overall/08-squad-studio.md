# Squad 团队管理 + Studio — 产品需求文档 [v0.0.33.1]

> version: 2.2 · **[v0.0.250 modified]** hire derive 入参删 `inheritMemory`（dead：声明「派生复制父记忆」从未落地；memory 已 v0.0.232 团队盘 `.rocky/memory/` 全队共享）+ derive 补齐复制父成员个人 AGENTS.md（`copyPersonalAgentsMd` in `member-academy-bridge.ts`，父无/失败 → 静默 no-op 不回滚）+ 前端 Derive 区 inheritMemory toggle 删除（dead UI）。详见 §8.3 路径 2 + §8.2 B 行 + `specs/prd/version_logs/v0.0.250/change_log.md` · **[v0.0.169 modified]** 新增成员从弹层改为**主区创建页**——`seat-add-card` 不再弹 hire 弹层，改切主区 member-create 创建页（复用编辑页 section 结构）：Fresh = name/intro 必填 + workStyle 可空 + skills Card（inherit/custom）；Derive = 父成员选择 + inheritMemory + 可选覆盖 name/intro/workStyle（skills 继承父不暴露）；底部常驻 创建/取消（非 dirty FAB）；创建成功/取消均回首页 seats。**hire API 扩 `workStyle?`**（fresh 直传 trim 回写/空串=空串无 400；derive 默认复制父 + `overrides.workStyle` 覆盖，空串=清空）。**编辑页删「当前任务」占位区**（收敛为 姓名介绍 + skills 两 section）。原 `component-hire-modal` 弹层软删。详见 §8.7 承接表 v0.0.169 行 + `specs/prd/version_logs/v0.0.169.member_page/change_log.md` · **[v0.0.168 modified]** Studio 首页 IA 收敛为**单页中枢**（纯前端零后端）：SquadPanel 3-tab 容器 + 成员 tab / MemberCard 整体解体（`MainView {kind:'panel'}` 路由态取消）；SeatsPanel 3 tab（坐席/管理/自动工作）内联切主体（本组件内切换 ManageTab / AutoworkTab）；坐席卡「更多」按钮激活为菜单（编辑 + bench/deploy，leader 硬规则无 bench）承接旧单成员操作；leader 独立行 + 强 highlight；「+」新增成员虚线卡承接 hire 入口；侧栏手风琴展开树彻底删除（sidebar 只留 squad 单行 + 新建按钮），chat/board 入口全部改为首页坐席卡与团队入口卡；看板路由头部新增返回键；chat topbar 返回键常驻（`from` 门控 + `showBackButton` 删）；member 编辑唯一入口 = 坐席卡菜单编辑，返回恒回首页 seats；单聊顶栏角色头像纯身份展示不可点（唯一 member 编辑入口 = 坐席卡菜单）。详见 §8.7 承接表 v0.0.168 行 + `specs/prd/version_logs/v0.0.168.ui_opt/change_log.md` · 引入版本 v0.0.33.1 · [v0.0.117 modified] board 管理实体四面对齐（存储↔HTTP↔UI↔agent tools）：所见即所得修 Goal.description/Req.detail 编辑错位 + 全实体 status 下拉（全 5 态不过滤，服务端 400 兜底）+ KR.status 三方打通 + Requirement triage 用户入口 + 全实体清空语义（空串=显式清空）+ 卡片 reason/deadline/KR status 展示 + agent 三工具补 edit/archive/restore/duplicate + create body/priority/deadline + query detail 读面 + health 共享派生 applyKrPatchWithHealth。详见 §8.7 承接表 v0.0.117 行 + `specs/prd/version_logs/v0.0.117.md` · [v0.0.116 modified] 心跳机制 squad 级升级 + 团队成员状态记录（presence）：心跳从 per-member 升级为 squad 级统一调度（AutoWork tab 一处配全队——总开关默认关 + 预算 switch off/on 默认 1M/天 + 多工作时段 + 心跳范围 all/白名单 + 间隔 5/15/30/60min 默认 15）；到点整队一次 gate 链调度，符合条件成员逐个 deliverTo 固定心跳提示词（含 `<EOS>` 出口句·零机制改动）；废弃 per-member 心跳（字段 dead / `PATCH /member/:mid/heartbeat` 删除 / member-panel 心跳 section 移除）。新增 presence：成员用独立 `presence(set/clear)` 工具标记「当前在做的事」（自由文本每人一条），leader system prompt 加「团队当前状态」段（只列 session running 的成员及标记）。详见 §8.9 + `specs/prd/version_logs/v0.0.116/prd.md` · [v0.0.60 modified] squad 看板概念优化（联合检查归档 + 全实体可编辑 + 统一链路 O→KR→Requirement→Task + body 正文 + Task priority/deadline + Goal completion% 简单平均 + 编辑感知下次启动）。详见 §8.7e + `specs/prd/version_logs/v0.0.60/change_log.md` · [v0.0.57 modified] squad 管理 UI 整理（纯前端重组，零 API / schema 变化）：squad 面板 5 tab → 3 tab（删介绍/目标，重排为 管理/成员/自动工作）；团队看板从 goals tab 提升为侧栏独立 board 路由态节点（`squad-tree-board-{squadId}` testid，点 → page-studio `MainView {kind:'board';squadId}`）；自主性归位（toggle + budget 从管理 tab 迁入新建 `component-autowork-tab` 容器，与 history 同 tab）；成员 tab 横排网格 → 单列；副标题「squad · 团队看板」→「squad · 管理面板」。详见 `specs/prd/version_logs/v0.0.57/change_log.md` + `specs/ui/overall/06-studio.md` v1.5 · [v0.0.56 modified] SessionKind 统一 session 类型维度——leader/mate/squad session 字段 type→role+derivation+biz（用户行为不变）。详见 `specs/prd/version_logs/v0.0.56-session_type/change_log.md` · 最后更新：2026-07-01（v1.4：v0.0.42 studio chat UI 对齐——component-message-stream 加 sideResolver prop（单聊 a2a→右，群聊默认）+ studio 两页 textarea IME 守护（组字中 Enter 不发送）+ member-chat 同享两层状态分离（stop 圆环 + on-message spinner，零额外接线）；squad 管理骨架不动。详见 §8.7c + `specs/prd/version_logs/v0.0.42/change_log.md`）· v1.3：v0.0.33.4 已完成——squad 自主性 infra 收官：scheduler 心跳 + budget gate + file-watch 事件唤醒 + autonomy 总开关 + 4 端点 + UI 4 组件；squad 层收官。完成态入 §8.7 后续版本承接表
> 本文承载 squad 层 + Studio view 的全量产品定义（v0.0.33.1 首版交付管理骨架；v0.0.33.2 交付 squad/leader/mate/subagent 4 scope 对话；v0.0.33.3 交付 OKF 双轨 + 工作项管理 + 看板；v0.0.33.4 交付自主性 infra）。增量见 `specs/prd/version_logs/v0.0.33.{1,2,3,4}/change_log.md`。
> 概念权威源：`specs/tech/squad/`（overall + [P1] 文件）+ `specs/tech/multi_agent/` + `specs/tech/agent/session/[P0]session_biztype.md` + `specs/ui/overall/06-studio.md` + `specs/ui/components/studio-page/`。
> API 契约：`specs/api/overall/11-squad.md`（框架）+ `11a-squad-endpoints.md`（端点主体）+ `10-multi-agent.md` / `10a-multi-agent-tool-ref.md`（a2a 与工具）。系统设计：`states/v0.0.33.1/design.md` + `specs/research/v0.0.33.2-dialogue-architecture.md`。

## 目录

| 章节 | 说明 |
|------|------|
| §8.1 产品概述 | squad 定位、目标用户、核心价值、bizType 二分 |
| §8.2 功能需求（IN SCOPE v0.0.33.1） | 10 项：建 squad / hire / bench / edit / charter / squad 面板 / 占位 chat / bizType 隔离 / nav-rail / 列表展开树 |
| §8.3 关键用户路径（MANDATORY） | 8 条核心路径（测试最低覆盖） |
| §8.4 范围边界（IN / OUT） | v0.0.33.1 scope + 后续版本承接 |
| §8.5 设计决策（用户拍板） | squad 权威源 / 字段一次到位 / 对话全占位 / 不可删 / bizType 隔离 / B 方案命名 |
| §8.6 验收口径 | 功能 / 视觉 / API / known-issue |
| §8.7 v0.0.33.2 对话完成态 | 4 scope 真聊、关键路径、验证摘要 |
| §8.7e v0.0.60 squad 看板概念优化 | 联合检查归档 + 全实体可编辑 + 统一链路 + body 正文 + Task priority/deadline + Goal completion% 简单平均 + 编辑感知下次启动。**详见 §8.7e + `specs/prd/version_logs/v0.0.60/change_log.md`** | ✅ 已完成（phase=completed；6 task 全 verified；带 BUG-001 known-issue 合并） |
| §8.7b v0.0.33.3 OKF 双轨完成态 | OKF 双轨制 + 工作项三层 + 看板 + systemPrompt 不落库 |
| §8.9 v0.0.116 心跳 squad 级 + presence | 心跳 per-member→squad 级统一调度（AutoWork tab 总开关/预算/时段/范围/间隔 + gate 链 + 固定提示词 + 废弃 per-member）+ 成员状态记录 presence（set/clear 工具 + leader 团队当前状态段）。**详见 §8.9 + `specs/prd/version_logs/v0.0.116/prd.md`** |
| §8.10 v0.0.194 squad token 用量统计入口 | seats 页 tab 条右侧新增「Token 统计」入口（**独立路由视图** `MainView {kind:'token-stats'}`，IA 对齐 board/panorama，头部返回键）：4 维度切换（粒度/范围/类型/视图）+ 日历热力 + 时间轴堆积双视图 + hover 明细；团队口径=Σ 所有 member；token 单位 M / 缓存率 cache/(cache+input) %；存储=schema store 时序表（SQLite engine 架构评估扶正，不引入 MySQL）+ 异步事件不阻塞主流程 + 存量 transcript/run 复原 migration。**详见 §8.10 + `specs/prd/version_logs/v0.0.194/prd.md`** |

---

## 8.1 产品概述 [v0.0.33.1]

**squad** = 多角色 agent 团队（leader + mates，全 agent 无 human）。squad 是**团队信息权威源**：member / role / sessionId 靠 squad 双向同步（应用层 service 单点维护，无 DB 外键）。**Studio** = nav-rail 顶部第 2 个业务 view，squad 团队管理入口；与 **Playground**（原"会话"，个人对话）物理隔离。

一句话定位：用户在 Studio 里走完「建 squad → hire member → bench/edit member → 群聊/单聊真对话 → 业务全景（panorama）」全流程；squad/leader/mate/subagent 共用统一 AgentLoop + SystemPromptBuilder，squad 相关 session 不污染 Playground 列表。

### bizType 二分（UI 侧）

| tab | view | 数据源 | 列表隔离 |
|---|---|---|---|
| **Playground**（原"会话"） | `currentView='playground'` | `GET /session?bizType=playground`（缺省） | 不含 studio session |
| **Studio** | `currentView='studio'` | `GET /squad` + `GET /session?bizType=studio`（树展开） | 不含 playground session |

bizType 三处必须都覆盖（session 字段 + GET 过滤 + UI 路由分离），任一漏则 Playground 列表被污染。

---

## 8.2 功能需求（IN SCOPE v0.0.33.1）

| 编号 | 功能 | 描述 | 权威 spec |
|---|---|---|---|
| **A** | **建 squad**（wizard + 事务） | POST /squad → createSquadService 8 步事务：squad record + leader member + leader session + 群聊 session + 目录骨架，含补偿回滚 | `11a §1` + data_model §1.1/§4 |
| **B** | **hire member**（fresh + derive） | POST /squad/:id/member：fresh（填新字段）或 derive（deriveFrom + overrides）→ 建 mate member + mate session + workspace。**`[v0.0.169 modified]`**：body 扩 `workStyle?`——fresh 直传（trim 回写，空串=空串无 400）；derive 默认复制父 workStyle，`overrides.workStyle` 覆盖（空串=清空）。入口从弹层改为**主区创建页**（`seat-add-card` → member-create：Fresh 加 skills Card + workStyle；Derive 加 workStyle 覆盖；原 `component-hire-modal` 软删）。**`[v0.0.250 modified]`**：删 derive 入参 `inheritMemory`（dead：声明「复制父记忆」从未落地；memory 已团队盘共享）+ derive 补齐复制父成员个人 AGENTS.md。详见 `specs/prd/version_logs/v0.0.169.member_page/change_log.md` | `11a §2.1` + data_model §5 |
| **C** | **bench / deploy member** | bench（reason 必填 → benched + 通知 user）/ deploy（恢复 deployed）。**leader 不可 bench 返 403** | `11a §2.3/§2.4` |
| **D** | **edit member**（角色面板） | PATCH /squad/:id/member/:mid：姓名/介绍（= systemPrompt）/ systemPrompt / skills / model；当前任务/记忆管理占位。**`[v0.0.48 modified]`**：`tools` 字段**移除**——leader/mate 工具集改 static-by-type（查 JSON tool policy.roles[leader\|mate].bound），hire/member 面板不再有「工具管理」UI。详见 `specs/prd/version_logs/v0.0.48/change_log.md` §3.4。**`[v0.0.113]`**：成员编辑面板重构（已实现）——skills 板块改「继承/自定义」switch + 叠加快照筛选器（废弃旧白名单 D4 交集，改 overlay）、**删 model 模块**（改由对话 `InputModelPicker` 编辑；member.model 数据/接口仍在）、**删记忆 section**（会话已有入口）、板块改名 skills。详见 §8.7f + `specs/prd/version_logs/v0.0.113/change_log.md`。**`[v0.0.169]`**：删「当前任务」占位区（长期无实际功能）——编辑页收敛为 姓名介绍（name/intro/workStyle）+ skills 两 section | `11a §2.2` + 06-studio §4 |
| **E** | ~~**charter 编辑 + history**~~ **`[v0.0.237 removed]`** | charter 全链路（endpoint + history + UI 编辑器）于 v0.0.237 移除——squad 不再有 charter 字段 / charter endpoint / charter 编辑器；leader 的「何时向用户汇报/提问」由 leader.md prompt 直接承载，不再走 charter.escalation 字段 | ~~`11a §3`~~ + ~~data_model §1.3~~（均退役） |
| **F** | **Squad 面板（多 tab）** | 介绍（实跑）/ 成员（实跑：列表 + hire + bench/deploy/edit）/ 管理（实跑：squad 元信息 + budget/enableHeartBeat 占位）。**`[v0.0.237 removed]`**：原「目标 tab（看板 section：Goals/Requirements/Tasks 三视图）」随 charter/task/goal/requirement/board 工作项链路整体移除——业务数据看板改由 **panorama（业务全景，§8.7 v0.0.189.dsl_board）** 承载，agent 用 DSL 搭建动态 views（kanban/table/bar_chart），无固定三视图 tab | 06-studio §3 |
|   | **`[v0.0.57 modified]`** | **5 tab → 3 tab（管理/成员/自动工作，按此顺序）**——删介绍 tab（description + charter 摘要并入管理 tab）；删目标 tab（看板搬家至侧栏独立 board 路由态）；自主性 infra（toggle + budget）从管理 tab 迁入新建 autowork-tab 容器（与 history 同 tab）；成员 tab 横排网格 → 单列；头部副标题「squad · 团队看板」→「squad · 管理面板」。详见 §8.7e + `specs/prd/version_logs/v0.0.57/change_log.md` | 06-studio §3 + studio-page/_overview |
| **G** | **占位 chat `[v0.0.33.1]`** | 点群聊/leader/mate/subagent → 占位 banner；POST /session/:id/messages 对 studio squad/leader/mate 返 403 `studio_chat_not_ready`；GET messages 可读。**已被 `[v0.0.33.2]` 真聊替换** | `11 §4.5` + 06-studio §5 |
| **H** | **bizType 隔离** | session.bizType 字段（playground|studio，optional 空=playground）；GET /session?bizType=playground 缺省过滤；studio session 显式 studio；subagent 跟 parent；现存 lazy 默认 | `11 §2/§4.1` + session_biztype |
| **I** | **nav-rail 改造** | 顶部 Playground（原 chat 改名）+ Studio；底部设置组折叠（齿轮收纳 5 项，从下向上展开）；删 theme-toggle；brand「R」置顶不变 | nav-rail.md（[v0.0.33.1] 改造段） |
| **J** | **squad 列表 + 展开树** | GET /squad 列表；studio-sidebar 卡片视图 + 顶部「新建 squad」按钮；展开树显示该 squad 下所有 chat session | 06-studio §2 |

> **MemberEntity 无 description 字段**：Member 面板"介绍"section 实际编辑 `systemPrompt`（非独立 description）。已在 `specs/ui/components/studio-page/member-panel.md §视觉基线` + 06-studio §4.1 文档化。

---

## 8.3 关键用户路径（MANDATORY — 测试最低覆盖）

每条路径 = 至少一个 API/E2E case。详见 `change_log.md §4`。

1. **建 squad wizard 事务**：wizard 填字段 → POST /squad 8 步事务 → sidebar 新卡片 + 展开见 leader + 群聊
2. **hire member（fresh + derive）**：`[v0.0.169]` 首页坐席网格 `seat-add-card` → 主区创建页切 Fresh/Derive → 填字段（Fresh 可配 workStyle + skills；Derive 选父 + 可选覆盖 name/intro/workStyle）→ 提交 POST → 回首页见新坐席卡 + mate session（旧路径「成员 tab → hire 弹层」已废：v0.0.168 成员 tab 解体、v0.0.169 弹层改主区页面）。**`[v0.0.250]`** Derive 区原 inheritMemory toggle 已删（dead UI，复制记忆从未实现）
3. **bench/deploy + leader 不可 bench**：mate bench（reason）→ deploy 恢复；leader bench 返 403
4. **edit member**：`[v0.0.168/0.0.169]` 首页坐席卡菜单 → 编辑 → member 面板（仅 姓名介绍 + skills 两 section，任务占位区已删）改字段 → 悬浮保存 PATCH → 返回恒回首页 seats（旧入口「单聊点头像」已废）
5. ~~**charter 编辑 + history**~~ **`[v0.0.237 removed]`**：charter 全链路已移除（详见 §8.2 E 行）；leader 升级/汇报走 prompt + send_message，不再有 charter endpoint
6. **占位 chat `[v0.0.33.1]`**：树点节点 → 占位 banner；POST studio messages 返 403；GET messages 可读
7. **Playground 隔离**：建 squad 后切 Playground → 列表不含 squad session
8. **nav-rail 改造**：顶部切换 Playground/Studio；底部齿轮向上展开 5 项

路径 1-7 全 HTTP（AT 直接 curl 全验），路径 8 纯 UI（ET 覆盖）。

### 8.3a 关键用户路径（v0.0.33.2 真聊完成态）

1. **群聊**：user 在 `squadChat` 发消息 → SquadChat 路由 leader/mate → 角色回复回群聊 → UI 渲染角色名前缀。
2. **leader 单聊**：user 打开 leader chat → 发送 `{content}` → leader 直接 final text 回复。
3. **mate 单聊**：user 打开 mate chat → 发送 `{content}` → mate 直接 final text 回复。
4. **leader↔mate 协作**：leader 用 `send_message` 委派 mate → mate 回 leader → leader 综合后回群聊。
5. **mate peer**：mate A 给 mate B 发 a2a 消息，B 可回 A；此路径受 LLM 调度质量影响，见 BUG-001。
6. **spawn subagent**：mate 用 `agent(spawn)` 派生 subagent → subagent 按 explorer 人设工作 → 回 parent mate。
7. **EOS**：SquadChat 输出 `<EOS>` 结束路由 run；后端 stop seq + strip 保证 UI/transcript 不显示 `<EOS>`。
8. **reachable_agents**：prompt 动态注入同 squad 可达对象；不含 user，跨 squad 拒绝依赖 LLM 主动尝试。
9. **记忆面板**：单聊头像进 member 面板 → 记忆 section 展示 summary → 触发 compact。
10. **bizType 隔离回归**：studio 真聊后仍不污染 Playground 会话列表。

---

## 8.4 范围边界

### IN SCOPE（v0.0.33.1）
squad/member CRUD + 管理 UI 全实跑（A-J 10 项，其中 E 行 charter 已于 `[v0.0.237]` 移除）+ session bizType/squadId/memberId 字段 + 占位 chat 403 + 命名统一（member→mate）+ 目录骨架一次建对 + 字段一次到位（v2/v3/v4 占位）。**`[v0.0.237 removed]`**：charter 字段 / charter_history entity / board 工作项链路（goal/requirement/task）整体移除，详见 §8.7 承接表 v0.0.237 行。

### OUT OF SCOPE（显式不做）

| 排除项 | 承接版本 | 理由 |
|---|---|---|
| LLM 调用 / agent loop / chat 真实跑 | v0.0.33.2 ✅ | 本版本只立管理骨架 |
| 工作项（goal/requirement/task）+ 看板 UI | v0.0.33.3 ✅ | 仅 tab 占位 banner |
| leader 对话驱动 update_charter + LLM team/task 工具 | v0.0.33.3 ✅ | 本版管理全走 HTTP + UI |
| SquadChat 路由确定性硬化（B1）/ 群聊回路完整时序（B4）/ 看板编辑 drag-drop | 后续版本 | 33.3 不硬化；编辑走对话工具 |
| 心跳 / scheduler / budget gate / enableHeartBeat 实跑 | v0.0.33.4 | 字段占位，scheduler 留 v4 |
| DELETE squad / fire member | 不做 | squad 不可删；member bench 兜底 |
| charter PUT 乐观锁 / hire derive overrides 精确字段集 | 本版细化 | design.md §6 待定，非阻塞 |

---

## 8.5 设计决策（用户拍板 + design.md 锁定）

1. **squad 是团队信息权威源**：member/role/sessionId 靠 squad 双向同步；管理操作全走 HTTP + UI（本版本不做对话驱动）。
2. **数据字段一次到位**：v2/v3/v4 字段位（heartbeat / budget / enableHeartBeat）v1 就有（存但不生效），避免后续 migration。**`[v0.0.237 removed]`**：原 charter 字段位已随 charter 全链路移除，不再占位。
3. **对话全占位 `[v0.0.33.1]`**：session.type 字段持久化（squad/leader/mate）但不跑 agent loop；POST messages 对 studio session 返 403 `studio_chat_not_ready`。**`[v0.0.33.2]` 已拆除 squad/leader/mate 的 403，subagent 仍只读。**
4. **squad / member 不可删，leader 不可 bench**：API 两层都拒（squad 无 DELETE 端点；leader bench 返 403；member 用 bench 兜底，无 fire）。**推翻 req.md 旧版 `DELETE /squad → _archived`**。
5. **bizType 隔离**：squad/leader/mate session 显式 `bizType=studio`；现存 session lazy 默认 playground；GET /session 缺省按 playground 过滤。
6. **命名 B 方案**：`member` entity（含 leader+mate，role 字段区分）+ `session.type = 'squad'|'leader'|'mate'|'subagent'`（原 `'member'`→`'mate'`，避免与 member entity 名撞）。

---

## 8.6 验收口径

- **功能**：API 7/7 PASS（路径 1-7 全 HTTP 验）+ e2e DOM 全绿（路径 8 nav-rail 改造）。
- **视觉保真（有设计稿 MANDATORY）**：vision_check.py compare 逐维度比对（layout/font/border/color）。v0.0.33.1 round-2 compare 5/6 FAIL（仅 new-squad PASS）→ BUG-004 known-issue 合并（见下）。
- **agent 侧**：v0.0.33.1 不接 agent loop（占位 chat），无 agent 行为可验。

### Known-Issue（合并门槛放松）

**BUG-001 — 多跳 a2a LLM 调度质量 `[v0.0.33.2]`**：mate peer、群聊多跳终答、reachable cross-squad 拒绝等 case 的失败集随轮次轮换；结构链路已通，问题是 LLM 不一定在 needReply 终答时主动 `send_message` 回请求方，或不一定主动尝试跨 squad 动作触发拒绝。用户确认本版本不补 auto-relay，不阻塞合并。

**BUG-004 — Studio 视觉保真系统偏差（5/6 FAIL）**：6 个设计稿 compare，仅 `new-squad` PASS。两类偏差：
- **A 类（真 impl 偏差）**：accent 色偏粉橙（系统性）/ role-panel section border 用 dashed（设计实线）/ charter-editor font+圆角 / hire-member chip 形状（impl pill vs 设计直角）
- **B 类（需裁决）**：chat-placeholder/role-panel compare 设计稿画局部 vs impl 整页（多 256px 侧栏）→ compare 口径问题；hire-member 缺 DESCRIPTION 字段（设计稿有 / spec 无）→ 设计 vs spec 权威问题

**功能层不受影响**（API 7/7 + e2e DOM 全绿）。用户确认 known-issue 合并，待后续版本修。详见 `states/v0.0.33.1/bugs/BUG-004-studio-视觉保真系统偏差-[open].md`。

---

## 8.7 后续版本承接

| 版本 | 承接 | PRD 状态 |
|---|---|---|
| **v0.0.33.2** | 对话接通：拆占位 403 / 4 scope（squad/leader/mate/subagent）共用统一 SystemPromptBuilder + AgentLoop / SquadChat 哑路由 + `<EOS>` 协议 / a2a squad clique + reachable_agents / subagent identity 修复 / member 记忆管理实跑 / skill 黑白名单 + 模型回退链 / bizType 隔离回归。**详见** `specs/prd/version_logs/v0.0.33.2/change_log.md` | **已完成**（UT/typecheck 通过；AT 14/16 pass，2 fail=BUG-001 known-issue；ET 8 pass / 1 conflict / 1 BUG-001 hard_fail；无设计稿 visual_compare=0） |
| **v0.0.33.3** | OKF 双轨制 + 工作项三层管理：OKF md 主面 + store 投影 / Goal(OKR)+Requirement+Task + WorkStatus 状态机 / goal·requirement·task·team(update_charter) 工具（CAS/DAG/source 强约束）/ member.systemPrompt 移除（squad_role fragment）/ charter·tasks·board 迁 reminder provider / 3 skill 软约束 / 看板只读三视图。**详见** `specs/prd/version_logs/v0.0.33.3/change_log.md` | **已完成**（UT 全绿；AT 26 pass / 3 a2a known=BUG-001/B1/B4；ET 11 pass / 2 a2a known=B1；BUG-001/002/003 fixed） |
| **v0.0.33.4** | 自主性 infra 收官：scheduler 1s 轮询 + lastFiredAt 续接 + gate chain（killswitch→activeWindow→budget→busy→deliverTo）/ budget 横向聚合（baseline-delta daily 窗口，Display/Gate null 分离）/ squad 级 file-watch watcher（board+outputs+reports 路由 + 2s debounce + activeWindow 放宽）/ 4 HTTP 端点（PATCH /squad 字段生效 + PATCH /member/:mid/heartbeat + GET /budget/usage + GET /scheduler/history）/ UI 4 组件（autonomy toggle + budget meter + heartbeat config + 自动工作第 5 tab）。**详见** `specs/prd/version_logs/v0.0.33.4/change_log.md` + `specs/tech/version_logs/v0.0.33.4/change_log.md` | **已完成**（AT 10/10 + ET 2 pass / 2 conflict vision-known + UT 全绿；BUG-005 await-ready / BUG-006 addDir 递归 fixed；squad 层收官） |
| **v0.0.42** | studio chat UI 对齐 playground：① `component-message-stream` 加 `sideResolver` prop（单聊 a2a 收件→右与 user 同侧，群聊沿用默认 a2a→左）；② studio 两页 textarea 抄 playground IME 守护（`isComposing \|\| keyCode===229`，组字中 Enter 不发送）；③ member-chat 同享 chat 域两层状态分离（session 层 stop 圆环 + run 层 on-message spinner）。**详见** `specs/prd/version_logs/v0.0.42/change_log.md` | **已完成**（UT 全绿；AT 核心 case PASS；ET infra-blocked 待用户定夺） |
| **v0.0.60.squad_ui_2** | squad 看板概念优化（**本期**）：① 联合检查归档（archived 只在自身，可达性=祖先链联合检查）+ 活跃/归档 switch + 发现性提示条；② 看板从只读改**全实体全字段可编辑**（含 owner / 正文 / 关联 / 状态 / priority / deadline）；③ 统一关联链路 O→KR→Requirement→Task（Task.source 只挂 Requirement；Requirement.relatedKRId 可空=野生）；④ 全实体加 `body` 正文 markdown；⑤ Task priority（urgent/high/medium/low/none）+ 列内 priority→updatedAt 排序；⑥ KR + Task deadline + 动态 health（进度×时间）；⑦ Goal completion% 简单平均；⑧ Task 筛选（全部/按需求/按 KR）+ Task 复制；⑨ 编辑写回 store，agent 下次启动感知（无实时 event）。**详见** §8.7e + `specs/prd/version_logs/v0.0.60/change_log.md` | ✅ 已完成（phase=completed；6 task 全 verified；带 BUG-001 known-issue 合并） |
| **v0.0.57** | squad 管理 UI 整理（纯前端重组，零 API/schema 变化）：① 看板搬家——goals tab → 侧栏独立 board 路由态节点（`squad-tree-board-{squadId}` testid + page-studio `MainView {kind:'board';squadId}`）；② squad 面板 5 tab → 3 tab（管理/成员/自动工作）——删介绍 tab（description 并入 manage-tab `squad-admin-desc-input`）、删目标 tab（看板搬家）、自动工作从纯 history → 组合 toggle+budget+history（新建 `component-autowork-tab`）；③ 成员 tab 横排网格 → 单列；④ 头部副标题「squad · 团队看板」→「squad · 管理面板」。**详见** `specs/prd/version_logs/v0.0.57/change_log.md` | **已完成**（UT 4303 全绿；AT/ET 豁免——server 零改动 + 用户自测；零 tech/api spec 变化） |
| **v0.0.117** | board 管理实体**四面对齐**（存储 ↔ HTTP ↔ UI ↔ agent tools）——代码补齐到已有 spec 声明：① **所见即所得**修 Goal.description / Requirement.detail 列表渲染但编辑弹层缺字段（编辑视图见得到改得了）；② 全实体弹层加 `status` 下拉（展示 WorkStatus 全 5 态、前端不过滤、非法跃迁服务端 400 兜底 + blocked/cancelled 展开 reason）+ KR.status 三方打通（此前恒 pending）+ Requirement triage 决策区（accept/defer/reject，仅 pending）；③ 全实体**清空语义**（dirty 才提交、空串=显式清空，旧「空值跳过」作废）；④ 卡片展示补 task reason/deadline + KrRow status badge/deadline；⑤ agent 三工具补 edit/archive/restore（+task duplicate）+ create body/priority/deadline + query `detail?`/`withDetail?` 读面；⑥ health 共享派生 `applyKrPatchWithHealth`（agent==HTTP 两通道唯一入口，落 `handlers/board-shared.ts`）；⑦ team.query 补只读 intro/去 dead tools + PATCH req 补 raisedBy/triage。**详见** `specs/prd/version_logs/v0.0.117.md` + 审计 `specs/research/v0.0.117-entity-field-alignment.md` | ✅ 已完成（6 task 全 verified；AT 10/10 + ET 8/8 + hard_fail=0；无设计稿；零实现 bug——遗留 fail 均 case 设计缺陷已修） |
| **v0.0.128** | team 工具 member **写 action 接入**（兑现「team 写 member 留 v3」豁免，`index.md ④#17`）：tool 层补齐 `hire / deploy / bench / edit` 4 个 action（全部 leader/user only，对齐 `update_charter`），复用 `handlers/member.ts` 的 `handleHire/handleDeploy/handleBench/handlePatchMember` 同源逻辑——HTTP/UI/tool 三路不重写、无 UI/HTTP/schema/状态机变更。`edit` patch 按实际 data_model = `{ skillConfig?, model?, intro? }`（spec §2 line60 的 `tools?/heartbeat?` 已 dead，doc-modifier 修）。**详见** `specs/prd/version_logs/v0.0.128/prd.md` | 🚧 待启动（PRD 待用户确认） |
| **v0.0.152** | squad 支持 effort + 审批模式（v0.0.148 能力补齐到 studio）：studio leader/mate 单聊 input-bar 接入 effort picker + 审批模式 picker（复用 playground `component-input-{effort,approval-mode}-picker` 契约，session 级 `PUT /session/:id` 零后端改动）；同时补渲染 `component-pending-approval-card`（修复此前 studio 单聊只挂提问卡、`need_approval` 触发时 run 悬挂无出口的缺陷）；squad 群聊裁决**不放**两 picker（`studio-squad` tool bound 无 bash，审批语义空洞）。**详见** `specs/prd/version_logs/v0.0.152/change_log.md` | ✅ 已完成（3 task 全 verified；code review PASSED；UT 全绿，纯前端零 API 契约变更） |
| **v0.0.168** | Studio 首页 IA 收敛为**单页中枢**（纯前端零后端）：① `SeatsPanel` 3 tab（坐席/管理/自动工作）从 v0.0.165「跳 SquadPanel 二级 tab」改为**本组件内切主体渲染 ManageTab / AutoworkTab**；② `SquadPanel` 3-tab 容器 + 成员 tab（`section-squad-panel.tsx` + `component-members-tab.tsx` + `component-member-card.tsx`）**整体解体**（不 @deprecated），`MainView {kind:'panel'}` 路由态取消；③ 坐席卡「更多」按钮激活为菜单弹层（编辑 + bench[mate+deployed] / deploy[benched]，**leader 硬规则无 bench**，UI 双层拒），承接旧成员 tab 单成员操作；④ leader 独立行 + 强 highlight（`shadow-sm` 常态 + `border-t-2 border-t-fg` 顶端强调条）；⑤ 坐席网格末尾「+」虚线卡 `seat-add-card` 承接 hire 入口；⑥ **侧栏手风琴展开树彻底删除**（`component-squad-tree.tsx` mv 到 `soft_deleted/v0.0.168/`），sidebar 只留 squad 单行 + 新建按钮；⑦ chat/board 入口全部改为首页坐席卡与团队入口卡；⑧ 右键「复制 Session ID」菜单迁到坐席卡与首页群聊入口卡（testid `studio-context-menu` / `-copy-id` 沿用，实现抽出为 `component-studio-context-menu.tsx` primitive）；⑨ 看板路由头部新增返回键 `board-topbar-back-btn`；⑩ chat topbar 返回键常驻（`MainView.chat.from` 门控 + `showBackButton` prop 删）；⑪ member 编辑唯一入口 = 坐席卡菜单编辑，返回恒回首页 seats（`MainView.member.fromChatNode` 删）；⑫ 单聊顶栏角色头像 `squad-chat-role-avatar` 从 `<button onClick={onOpenMember}>` 改 `<div>` 纯身份展示（保留 testid + name + tag 供 ET 观测，`MemberChatPage.onOpenMember` prop 删）；⑬ `useSquadMutations.bump` prop 删（sidebar detail 缓存不复存在无消费方）。**详见** `specs/prd/version_logs/v0.0.168.ui_opt/change_log.md` + `specs/ui/version_logs/v0.0.168.ui_opt/change_log.md` | ✅ 已完成（2 task 全 verified；code review CONDITIONAL PASS；UT 全绿 675 files 7965 tests all pass；纯前端零 API 契约变更；豁免 AT/ET 用户人工验证） |
| **v0.0.169** | squad 成员页优化：① 新增成员从弹层改为**主区创建页**（`seat-add-card` → `MainView {kind:'member-create'}`，新组件 `section-member-create` 复用 member-panel section 结构/视觉基线；保留 Fresh/Derive 双模式——Fresh = name/intro 必填 + **workStyle 可空** + **skills Card**（inherit/custom switch + 简化筛选器）；Derive = 父成员选择 + 可选覆盖 name/intro/workStyle，skills 继承父不暴露）；底部常驻 创建/取消（非 dirty FAB）；创建成功/取消均回首页 seats。② **hire API 扩 `workStyle?`**（11a §2.1 v1.7）：fresh 直传 trim 回写（空串=空串无 400）；derive 默认复制父 workStyle + `overrides.workStyle` 覆盖（空串=清空）；`team.hire` 服务端剔除 `overrides.workStyle` 守「仅用户可编辑」不变量。③ **编辑页删「当前任务」占位区**（`member-section-tasks` + `member-tasks-placeholder-banner` 移除，收敛为 姓名介绍 + skills 两 section）。④ 原 `component-hire-modal` + 死代码 `component-multi-check` 软删；`hire-*` testid 归零；i18n `hireModal.*` → `memberCreate.*`。**`[v0.0.250 follow-up]`** Derive 区原 `inheritMemory` toggle 已删（dead UI：server 删字段后 toggle 成虚假承诺；详见 `specs/prd/version_logs/v0.0.250/change_log.md`）。**详见** `specs/prd/version_logs/v0.0.169.member_page/change_log.md` + `specs/ui/overall/06-studio.md` v1.11 | ✅ 已完成（1 task verified；code review CONDITIONAL PASS；UT 全绿 679 files 8017 tests；AT 用户裁决豁免 + ET 豁免；最终用户人工验收） |
| **v0.0.189.dsl_board** | **panorama（业务全景，新增功能面）**——squad leader 用声明式 DSL 搭建的**可操作业务数据看板**（代码 id `panorama`），与现有硬编码看板并列、数据隔离。① **入口**：团队入口卡 `component-team-entry-row` 加第三个 link（`seat-team-entry-panorama`）→ `MainView {kind:'panorama'}`（路由态由 v0.0.168 `{seats\|board\|chat\|member}` 扩展含 panorama）。② **agent 是作者**：leader 听需求 → 生成 DSL → 四层校验（语法/schema/语义/数据安全）→ 失败按 `{code,path,message,suggestion}` 自修复 → 落盘 → 空态消失转多 tab 工作态；空态「更多」tab 引导「找 leader 搭看板」（跳 leader 单聊 + composer 预填搭看板模板文本，不提供 DSL 配置入口；v0.0.248 起，原为去群聊 @leader）。③ **视图原语 v1** = kanban/table/bar_chart（多 tab = views 数组）；拖拽 = 状态机投影（`group_by==states.field` 即可拖，过 transitions+terminal+guard，非法跃迁拒绝+可读原因）。④ **同一校验器三写入口**（用户拖拽 HTTP / agent `panorama(action)` 工具 / 直接 API），规则唯一源 = DSL 不漂移。⑤ **迁移容错**：增量变更自动生效；破坏性变更须 leader 提 migration 方案（handler=archive/purge/mapping/transform/clip）+ 审计 + .archive 备份，**重大变更须用户点头**（`panorama_breaking_change_requires_approval`）。⑥ **存储文件制无 OKF md 轨**：`panorama/{board.yaml,entities/{entity}/{id}.json,events.jsonl}` + SSE 实时刷新。⑦ skill `panorama-designer`（leader 默认挂载）+ 2 种子模板（CI/CD demo 升格 / 团队工作管理抽象）。**详见** `specs/prd/version_logs/v0.0.189.dsl_board/prd.md` + `specs/research/v0.0.189.dsl_board/panorama_{dsl_schema,validation,migration}.md` | ✅ 已完成（UT 697 全绿 + AT 冒烟集全绿 + ET 全绿；AT 新增 1 条冒烟「LLM 定义看板+修复回路」；无设计稿视觉保真门禁跳过） |
| **v0.0.194** | **squad token 用量统计入口**（新增功能面）——squad seats 页头部 tab 条右侧新增「Token 统计」入口（**独立路由视图** `MainView {kind:'token-stats'}`，IA 对齐 board/panorama，头部返回键退出；非 seats tab 主体覆盖），提供团队级 + 成员级 LLM token 流量可视化：① **4 维度切换**（粒度 day/hour × 范围 team/单 member × 类型 total/input/output/cache/cacheRate × 视图 calendar/timeline）+ 单日粒度日期选择；② **双视图**（日历热力色块 + 时间轴堆积柱图）；③ **团队口径 = Σ 所有 member**（含 leader + mate，subagent→parent 已含，mate 不→leader，不能只取 leader）；④ **单位口径**：token 数 M（÷1e6）/ 缓存率 = cache/(cache+input) %（分母不含 output）；⑤ **hover 明细**（总体 5 行 / 分项 1 行 / 缓存率 1 行，createPortal 浮层 + native title 兜底）；⑥ **存储 = schema store 时序表**（SQLite engine v0.0.194 扶正为生产/packaged 可用，**不引入 MySQL**），新用量写入走**异步事件不阻塞主流程**（投递走 direct call 非 bus 订阅，避免 double-count）；⑦ **migration 不做**（用户核实无精确数据源——run.usage 实际没落、session.usage 无 per-call 时间分布，覆盖早期「兜底」提案）；⑧ **model 筛选下拉**（distinct model 从 token_usage_stat 数据派生，非 squad.modelDefault）。**详见** §8.10 + `specs/prd/version_logs/v0.0.194/prd.md` | 🚧 dev verified（三 task 全 UT 8831 全绿 + code-review 全 CONDITIONAL PASS；packaged 真机验证合并前 build dmg 门禁） |
| **v0.0.223** | **OKR/requirement 漏出移除（hidden-by-gate，不删代码）+ 全景 task 视图优化 + todo 工具（session 双层待办）**：① **OKR/req 从界面/agent 能力隐藏**——工具 + prompt 走 plugin 配置直接摘（leader/mate/squad profile 全摘 goal/requirement 工具 + 相关 system prompt 段）；task 卡「所属 requirement」+ 全景 goals/requirements tab 走 **feature gate `__FEATURE_OKR__`**（build-time vite define，默认关、长期保留代码/spec/测试，未来开 gate 即重启）；squad_board reminder 滤掉 OKR/req 只留 task。② **全景 task 视图优化**（panorama kanban）——列宽从固定 `w-[240px] shrink-0` 改 min-w + flex 自适应；甬道色块从 8×8px 小圆点改列头色带/底色 + 状态文字带色（多通道编码防色弱，视觉精修待 demo）。③ **task reminder 改名收窄**（squad_tasks → task，mate reminder 注入规则改 assignee=me ∪ assignee=null，**无「关注」概念**零新字段）。④ **todo 工具**（session 级双层待办，与 task 拆开）——todo=当前 session 手头主 item（source/output/memo）+步骤，5 态 free-form，绑全部 parent.main profile；配 todo reminder（`[todo]` 标头填壳）+ chat 悬浮菜单第 4 项只读视图（badge=未完成主 item 数；用户侧入口见 `03-llm-chat.md`）。**详见** `specs/prd/version_logs/v0.0.223.md` + `states/v0.0.223/okr-req-gate-plan.md` | ✅ 已完成（2 task 全 verified；AT todo-crud-flow/todo-reminder 全绿 + ET todo 视图 pass + UT 9085 全绿；视觉精修待设计师 demo） |
| **v0.0.237** | **studio squad 体系减法（删 task/goal/requirement/charter/board 全链路，保留 todo/panorama/member）**：① 删 task/goal/requirement 三工具 + 三 store（goal/requirement/task-store）+ board 整套（board-store/shared/archive + 8 board handler + okf-helper）+ charter（service/handler/schema 字段/charter_history entity）+ squad_charter/squad_tasks/squad_board 三 reminder provider + workitem mention provider + teamwork-leader/teamwork-mate 两 skill 目录 + 前端 charter-editor + board 全套组件 + panorama 的 Tasks/Goals/Requirements 三固定 tab + `__FEATURE_OKR__` feature gate + `/squad/:id/board/*` + `/squad/:id/charter*` endpoint。② **team tool 摘 charter 留 6 action**：list/query/hire/deploy/bench/edit（去 update_charter/get_charter）。③ **保留 todo**（独立 TodoStore，session 级，零耦合）+ **panorama**（独立业务全景，动态 views）+ member + scheduler/heartbeat/filewatch/autonomy。④ **OKF 双轨制（OKF=工作目录/store=汇报PPT）降级为轻量建议**——okf-skill 留作可选文档组织方法，agent 工具不依赖文件布局。⑤ **workspace 5 类强管（goals/requirements/tasks/topics/diary）改轻量建议**——区分 `交付/`（最终成果）与 `temp/`（草稿/试错），命名带日期版本。⑥ **leader.md/mate.md 大改写**（去双轨制 + 5 类强管 + task/charter 提及，保留评估优先/适度反思等成功基因 + presence 协作规则）。全文件型 JSON 存储，**无 DB migration**（只删文件 + 字段）。**详见** `specs/tech/version_logs/v0.0.237/change_plan.md` + `reqs/[working] v0.0.237/` | 🚧 进行中 |
| **v0.0.240** | **squad task（轻量任务机制 = panorama builtin entity + reminder 注入 + 首页 IA 改造）**：① **task = panorama builtin schema 首个固定 entity**（方案 A+，不造专用工具——agent 用通用 `panorama(action, entity=task)`；task 字段 = title/description/owner(string member id)/dependencies(string+pattern)/status(4 态: todo/waiting/in_progress/done)/archived(boolean) + 4 态状态机，waiting = 被依赖 block 全自动维护）；builtin schema 通道 = 代码声明 EntityDef/ViewDef + `readEffectiveSchema` 单一 chokepoint 合并 DSL（builtin 只在 read 层合并，board.yaml 永远纯 leader DSL；不写盘、不被 leader 编辑）。② **依赖全自动**（afterTaskWrite hook：依赖未满足 todo→waiting / 全 done waiting→todo，source=system 直调 transitionInstance 不走用户路径防 self-loop）。③ **task reminder 注入**（新 squad_task provider 挂 SystemReminderPoint，leader 全队 / mate owner∪依赖，每轮瞬时值交 dedup reducer）。④ **首页 IA 改造**：tab「坐席」→「首页」；左列 SeatStats 2×2 + TeamEntryRow → TokenWidget（图文小组件，整卡点击进 token-stats）；roster「坐席·N」→「成员·N」（N 减队长）；全景从独立路由（`MainView {kind:'panorama'}` + onBack）改为**首页第二栏内嵌**（删 onBack 头部 + 删 PanoramaIdle「更多」tab——builtin task 恒在首 tab schema 永不空）。⑤ **panorama 前置增强**：ViewDef 加 `filter`（field:value 精确匹配 + 前端 fetch 透传，修「3 table 筛一样」）+ 归档能力（entity archived 字段 + view filter 默认隐藏 + 卡片 hover 归档按钮 + 「活跃/含归档」ArchiveSwitch 开关）+ field 中文 label。**详见** `specs/prd/version_logs/v0.0.240/prd.md` + `specs/tech/version_logs/v0.0.240/change_plan.md` | 🚧 进行中 |

---

### 8.7a v0.0.33.2 完成态摘要

- **核心概念**：Studio chat 不再是占位；squad/leader/mate/subagent 统一通过 `deliverTo(sessionId) → AgentManager.activate() → buildSessionConfigFromDeps() → AgentLoop` 进入同一对话架构。
- **设计思路**：不引入 6 个 extension scope，因为 reachable_agents、charter、tasks 都是运行时数据；改用 SessionConfig 字段 + mapper 内部分流 + schema 层工具裁剪，减少 type↔scope 双源维护。
- **接口签名**：`POST /session/:id/messages` 对 studio squad/leader/mate 返回 `202 {runId, enqueueId}`；subagent 仍 `403 subagent_readonly`。前端 studio 通常只发 `{content}`，model 从 member/squad 派生。
- **代码路径**：`app/server/src/handlers/session-messages.ts.handleMessagesPost() → app/server/src/agent/agent-manager.ts.deliverTo() → app/server/src/handlers/session-config.ts.buildSessionConfigFromDeps() → app/server/src/agent/agent-loop-stage-llm.ts.stageLLMRequest()`。
- **版本演进**：`[v0.0.33.2]` 完成 4 scope 对话与记忆面板；多跳 a2a LLM 调度质量作为 BUG-001 known-issue 后续按需处理。

---

### 8.7b v0.0.33.3 OKF 双轨完成态（squad「能干活」）

squad 从「能聊」（v0.0.33.2 4-scope 对话）升级到「能干活」：基于 OKF 双轨制落地工作项三层管理 + 看板。一句话：OKF md 是 agent 干活的舞台（可 grep/git），store json 是给用户/leader 看的镜子（看板 UI），工具是把舞台变化刷进镜子且兜住强约束（CAS/DAG/状态机）的手；agent 人设由固定 fragment 组装（不再落库），动态上下文（charter/tasks/board）由 reminder 变化时流式补充。

**关键用户路径（UC-1~10，对齐 PRD change_log §3）**：
1. **UC-1 建 Goal+KR**：leader `goal(create_objective, create_kr)` → store + OKF 同步 → 下轮 reminder 含新 KR
2. **UC-2 群聊提需求 triage**：SquadChat 路由 leader → `requirement(create)` → `requirement(triage, accept)`（路由非确定性，AT 直调工具绕开）
3. **UC-3 task assign+claim CAS**：leader `task(create, source, assignee)` → mate reminder 见血缘 → mate `task(update_status)`
4. **UC-4 并发 claim CAS**：mate A/B 并发 `task(claim)` → 仅一成功，另一 `already_claimed`
5. **UC-5 DAG 依赖**：task B `dependsOn=[A]` → A done 前 B 难推进 → A done 后 B 解锁
6. **UC-6 update_progress + health**：mate（KR 责任）`goal(update_progress, krId, current)` → 派生 kr.health + 联动 goal.health 持久化
7. **UC-7 promote_to_goal**：leader `requirement(promote_to_goal)` → 建 goal + req.status=done + relatedGoalId 回填
8. **UC-8 charter 演化**：user↔leader 确认 patch → `team(update_charter, triggeredByMessageId)` → charter.md + store + history append → 下轮 reminder 刷新
9. **UC-9 mate 代提 requirement**：mate `requirement(create, raisedBy={kind:member, id:self})`
10. **UC-10 identity fragment**：member.systemPrompt 移除后单聊 leader/mate 自报身份对齐 fragment；33.2 对话 case 全回归 PASS

**设计要点（权威：`specs/tech/squad/overall.md §7`）**：
- **OKF 双轨制**：OKF md（agent 主面）+ store json（投影）同根共存；工具只管 store 不碰 OKF，同步靠 agent（prompt+skill 引导）；双份数据短暂不一致是可发现信号非 bug。
- **system prompt 不落库**：member.systemPrompt 移除（accept-and-ignore 旧 payload），identity 走 squad_role mapper 按 sessionType 注入 leader/mate/squad_chat fragment。
- **reminder 动态补充**：charter/tasks/board 迁 system_reminder provider，shouldProduce 去重（lastWriteMessageId ulid 比较 + 10 条兜底）。
- **工具三层可见性 + 强约束**：registry 注册 → schema 裁剪（LLM 视角）→ 执行层 config.tools；CAS/DAG/source 必填/状态机/append-only 强约束。**`[v0.0.48 modified]`**：三层裁剪改为由 `resolveTools()` 单方法读单一权威源 `TOOL_POLICY`（`tool-policy.ts`，5 角色 bound：leader=15/mate=15 等），替代旧 `member.tools ∩ + sessionType 保底` 双入口；`Member.tools` entity 标 dead（不读不写，保留避免 migrate）。详见 `specs/tech/agent/tools/[P0]tool_policy.md`。
- **3 skill builtin seeding**：okf-skill（全员）/ teamwork-leader / teamwork-mate，SkillResolver 第三扫描层（builtin<app<workspace）。
- **看板三视图**：`GET /board`（11b）全员可读不裁剪，Goals[KR 进度+health]/Requirements[status 分组]/Tasks[kanban 列=status+group=assignee]；纯只读，编辑走对话工具。

---

### 8.7c v0.0.42 studio chat UI 对齐（sideResolver + IME + 两层状态受益）

v0.0.42 不动 squad 管理骨架，只对齐 studio chat 渲染层与 playground（共享内核 ChatStream）：

**① `component-message-stream` 加 `sideResolver` prop（消息来源左右对齐）**：
- **单聊**（`chat-actor-strategy.memberSideResolver`，chrome.memberId 非空时启用）：传 `sideResolver = msg => isA2aInbox(msg) ? 'user' : sideOfMessage(msg)`——a2a 收件消息（`role='user'` + `sender.source='agent'` + ref）→ **右**（与 human user 同侧，对该 session 是「输入」）；assistant 自答 + tool → 左。
- **群聊**（`capabilities.groupRender=true` 时启用）：**不传** sideResolver——沿用内核默认 a2a→左（群聊 a2a = 「他人发言」→ 与 member 同侧，现状已正确）。
- **单一职责**：sideResolver 只控左右侧；头像/名字仍由 `resolveActor` 决定（解耦）。否决 actor.side 字段方案（耦合头像与左右语义）。
- 技术权威 `specs/tech/app/frontend/[P0]component_architecture.md §3.6`；组件 spec `specs/ui/components/studio-page/{member-chat-page,squad-chat-page}.md` v2.1/v2.3。

**② IME 守护（中文输入法组字回车不发送）**：
- chat 输入区（共享 ChatComposer，统一输入区装配）`onKeyDown` IME 守护：`const imeComposing = e.nativeEvent.isComposing || e.keyCode === 229; if (e.key === 'Enter' && !e.shiftKey && !imeComposing) { ... }`。
- 组词中（`isComposing` 或 `keyCode === 229`）的 Enter 是「确认组词」，不发送；`compositionend` 后用户再按 Enter 才进发送分支。Shift+Enter 仍换行。修 v0.0.39 复刻输入框时漏抄守护的 bug。

**③ 两层状态分离受益（member-chat 同享 chat 域改动）**：
- studio 单聊 run 态由 `SectionChatSession` 内置装配（useRunState，capabilities.runState 门控），自动受益于 replay 粘住（切走切回 spinner 恢复）+ 两层状态 UI（stop 圆环 + on-message spinner），页面侧零接线。
- **studio squad-chat 不涉及**（纯轮询无 SSE，本版不加 loading/stop——task.json 设计方向已排除）。

> **OUT OF SCOPE**：studio squad-chat loading/stop 按钮（群聊纯轮询，后续单独立项）；playground a2a 场景是否传 sideResolver（默认零回归，后续按需）。

---

## 8.7d v0.0.55 squad workspace + 右侧区域（leader/mate）

> 引入版本 v0.0.55 · 详见 `specs/prd/version_logs/v0.0.55.memory_ui_session_lock/change_log.md` §2.5。
> 概念权威源：`specs/ui/components/studio-page/_overview.md`（待 architect 落 leader/mate 右侧 tab 区域组件 spec）。

**背景 gap**：v0.0.33.1 起 studio squad leader/mate 主区只有 member-panel（编辑角色配置），无右侧 tab 区域（不像 playground 有 ws-panel）。v0.0.55 补齐。

**功能**：
- **workspace tab 语义区分**：leader=团队工作区 / mate=个人工作区 / squad chat=团队工作区（新加）/ playground session=个人（不变）。
- **右侧 tab 区域**（leader/mate）：workspace tab（复用 `component-workspace-panel` 文件树）。**[v0.0.131]** 长期记忆/定时任务从右侧 tab 迁至聊天区右上悬浮菜单弹层（`component-chat-float-menu`，studio 三处 chat 各挂 `component-chat-right-overlay`；squad 群聊 `hideCron`），右侧 tab 仅剩 workspace。
- squad chat 主区加 workspace（团队）。

**关键用户路径**（承接 §8.3 测试覆盖）：路径 4 · studio leader 右侧区域（切「长期记忆」见 leader session_memory / 切「workspace」见团队工作区）。

---

## 8.7e v0.0.60 squad 看板概念优化（联合检查归档 + 可编辑 + 统一链路）

> 引入版本 v0.0.60.squad_ui_2 · 状态：**已完成（phase=completed；6 task 全 verified；带 BUG-001 known-issue 合并）**
> 概念权威源（讨论定稿）：`reqs/[working] v0.0.60.squad_ui_2/board.md`（字段表 + 归档机制图解）+ `states/v0.0.60/task.json`（decisions 全部拍板，pending_decisions 空）。
> **完整 PRD 内容**：`specs/prd/version_logs/v0.0.60/change_log.md`（10 项概念变更 + 14 条 UC + spec 缺口 + 决策表）。
> **概念先行核对**：本节标注「⚠ spec 缺口」处需 arch 落 tech/api spec、coder 编码前置落 ui/components/ spec，详见 change_log §5。

**背景 delta（相对 v0.0.57 只读看板）**：v0.0.33.3 起看板纯只读（编辑走对话工具），v0.0.57 看板搬家到独立路由态。**本期起看板可编辑**（全实体全字段 UI 编辑），引入「联合检查归档」机制、Task 看板状态分列+priority 排序、统一关联链路、body 正文、deadline + 动态 health。

**关键用户路径摘要（共 14 条，详见 change_log §3）**：
- **编辑→感知**：UC-1 编辑 Goal 字段+正文 → 重启 agent 感知；UC-2 编辑 KR → 派生 health/completion% 联动；UC-3/UC-4 编辑关联字段（relatedKRId/source/priority/deadline）；UC-14 编辑写回 store → 下次启动 reminder 含最新
- **归档机制**：UC-7 归档 Goal（自身）；UC-8 联合检查 fail → 活跃区提示条；UC-9 恢复 Goal → 子树自动可读回（O(1) 对称）；UC-10 恢复叶子向上检测祖先；UC-13 dependsOn 断链提示
- **看板视图**：UC-5 状态分列 + priority 排序；UC-6 筛选（全部/按需求/按 KR）
- **链路与复制**：UC-11 野生 Requirement；UC-12 Task 复制

**关键 invariants（不可违背）**：
- `o_not_measured`：Goal 不带 target/current；completion% 是 KR 聚合投影
- `archive_self_only`：归档只改自身 archived 字段；可达性交给读取层联合检查
- `unified_task_source`：Task.source 统一为 Requirement；废弃 `{kind:"kr"|"requirement"}` 二选一
- `read_only_board_deprecated`：v0.0.33.3 只读看板契约作废，本期起看板可编辑

**主要 spec 缺口（⚠ 需 arch/coder 先落 spec）**：
- tech: 联合检查归档模型 / 统一关联链路 / body 字段 / Task priority / deadline+动态 health / Goal completion% / 编辑感知 / Task 复制（详见 change_log §5.1）
- api: 11b 写端点（POST/PATCH + duplicate + archive/restore）+ 响应字段扩展（body/priority/deadline/archived + 派生 readable/effectiveArchived）+ zone/filter/sort query（详见 change_log §5.2）
- ui: squad-board.md v1.1→v2.0 从只读改可编辑 + 新 testid（zone-switch / archive-notice / edit / selector / filter / duplicate / archive / restore / depends-on-archived）+ native 选择器组件（禁原生 select，_conventions §10）+ body markdown 编辑器（详见 change_log §5.3）

**OUT OF SCOPE（明确排除）**：独立 metric 实体 / O 直接衡量 / 归档级联改子 / O/KR/Requirement 复制 / 实时编辑感知（同会话内 event 推送）/ effective_archived 落库 / 取消对话工具写 board（双轨保留）。

---

## 8.7f v0.0.113.ui_opt 成员编辑面板重构（skills 叠加快照 + 删 model/记忆）+ 模型 hover 展示

> 引入版本 v0.0.113.ui_opt · 状态：**已完成（AT 7/7 + ET 6/6 verified）**
> 概念权威源：`specs/prd/version_logs/v0.0.113/change_log.md` + `2-member-skills-mechanism.md`（② 叠加快照机制详解）。
> tech spec：`specs/tech/squad/[P1]data_model.md §1.2`（skillConfig 数据模型）+ `[P1]session_config_studio.md §3.2`（overlay resolve）；组件 spec：`member-panel.md` + `component-member-skill-filter.md` + `chat-page/component-input-model-picker.md §10`。

**背景 delta**：v0.0.113 前成员编辑「技能与模型」section 用 4 个死占位 skills（planning/testing/research/coding，运行时 D4 交集恒空）+ model 模块（与对话入口冗余）+ 独立记忆 section。本版本已重构（现状见下四点）。

**四点摘要（详见 change_log）**：
- **①**（skill 页，非 squad）：全局 skill 管理页内容超视口可上下滚动（bug 修）。
- **② 成员 skills 板块重构**：switch `off=继承全局 / on=自定义`；on 展开简化版全量 skill 筛选器（只 enable/disable + 搜索，无预览/安装/删除）。生效 = **workspace（永远）+ 全局配置叠加局部开关快照**；新增 skill 按全局；off 存后再 on = 快照清空恢复全局。**废弃 D4 交集**（`catalog ∩ member.skills`），改 overlay。删 model 模块，标题改 skills。
- **③ 删记忆 section**：会话界面已有记忆入口，`member-section-memory` 移除。
- **④ studio 模型 hover 展示**：member+squad 均未配（继承全局）时，对话 picker（`InputModelPicker`）hover 应展示实际生效模型 +「（默认）」而非「未配置」；三级链 member→squad→global。

**关键 invariants（不可违背）**：`workspace_skill_always_on`（R2）/ `overlay_not_intersection`（废弃 D4）/ `new_skill_follows_global`（R3）/ `off_save_clears_snapshot`（R6）。

**技术决策（已定）**：O-1 快照数据模型 = `member.skillConfig:{mode,overrides}`（`data_model.md §1.2`）· O-2 overlay resolve 替换 D4（`session_config_studio.md §3.2`）· O-4 **studio resolve 不读 global 默认**（`model-resolver.ts` 权威正确；「未配置」bug 是纯前端 `parseModelRef` 格式错配，非 resolve 问题——已同步修 `session-config.ts:134` stale 注释）· O-5 前端反查生效默认 = picker 对纯 modelId 调 `findProviderIdByModelId`（`component-input-model-picker.md §10`）。详见 change_log §6/§7。

**关键用户路径（测试最低覆盖，详见 change_log §3）**：P-1 skill 页滚动 / P-2 skills-off 继承 / P-3 skills-on 自定义+新增 skill / P-4 off 再 on 恢复 / P-5 记忆已移除 / P-6 模型 hover 默认 / P-7 model 模块已删。

---

## 8.9 v0.0.116 心跳机制 squad 级升级 + 团队成员状态记录（presence）[v0.0.116]

> 权威全文：`specs/prd/version_logs/v0.0.116/prd.md`。本节为 overall 快照。

**优先级 P1**。两大块：① 心跳 per-member → squad 级统一调度；② 团队成员状态记录 presence。

### 8.9a 心跳机制 squad 级升级

**用户故事**：作为老板（用户），我希望在一个面板里为整队开关自主工作 + 设预算 + 划工作时段 + 选范围 + 定间隔，让符合条件的成员按节奏自主干活。

**落点 = Squad 面板「自动工作」tab**（`component-autowork-tab`），四块垂直堆叠：总开关（`squad-autonomy-toggle`）+ 心跳配置（`heartbeat-config`，本版本从 member-panel 迁入）+ 预算（`budget-meter`，本版本加配置交互）+ 历史（`auto-work-history`）。写入统一走 `PATCH /squad/:id` → 后端 `scheduler.reloadSquad()` 热加载。

- **总开关**（`enableHeartBeat`）：默认关；关则下方配置全收起/禁用；开启前提示「开启自动工作（可能会带来较大 token 消耗）」。reactive 对话不受总开关影响。
- **预算**（`budget`）：switch off=不限量（`budget=null`）/ on=限量（默认 1,000,000 token/天）。只记团队总消耗/天（reactive+proactive 都计 consumed，gate 仅拦 proactive）；超限当日心跳停发、reactive 仍响应、次日 tz 0 点回血。
- **工作时段**（`activeWindows[]`）：多段增删，段间不重叠、单段不跨 0 点（`start<end`），空=全天；跟 `squad.timezone`；后端 400 校验兜底。
- **心跳范围**（`scope`）：off=全员（含 leader）/ on=白名单勾选（仅唤醒勾选成员，新增成员不自动纳入）；benched 任何模式不唤醒。
- **心跳间隔**（`interval`）：5/15/30/60 分钟单选，默认 15。

**触发机制**：squad 级 heartbeat job（`heartbeat:<squadId>`），到点整队一次；gate 链 `killswitch → activeWindows → budget → 逐成员(scope∩deployed∩非busy) → deliverTo`。队级 gate 全通过 → 逐成员投递**固定心跳提示词**（含 `<EOS>` 出口句，权威文案见 `specs/tech/scheduling/[P1]heartbeat_handler.md §0.1`）。**`<EOS>` 零机制改动**——只作提示词软出口引导，成员无活时输出 `<EOS>` 后无工具调用自然结束 run。

**废弃 per-member 心跳**：member-panel 心跳 section 移除（`member-panel.md`）；`member.heartbeat` 字段 dead（保留 schema、停读写）；`PATCH /squad/:id/member/:mid/heartbeat` 端点删除（`11a §4.2`）；旧 member 级调度不再触发。

### 8.9b 团队成员状态记录（presence）

**用户故事**：作为成员（leader/mate），我希望接任务/被唤醒后标记「当前在做什么」、结束时清除，让 leader 一眼看到谁忙什么；作为 leader，我希望 system prompt 有「团队当前状态」段列出正在活跃工作的成员及标记。

- **presence 工具**（独立小工具，不塞 task 工具）：`presence(set, text)` 覆盖标记 / `presence(clear)` 取消。每人一条自由文本；只能写自己 session 对应 member（防越权）；leader/mate 可用，SquadChat 不需要。数据 = `member.currentWork`（`data_model.md §1.2b`）。
- **prompt 维护提醒**：leader/mate system prompt 加「被唤醒/接任务后先 `presence(set)`，结束/无事时 `presence(clear)`」。
- **leader「团队当前状态」段**（`squad_team_status` reminder，`squad_reminder_providers.md §4.6`）：只展示 session 正在 running 的成员及其 `currentWork`（可能为空显示「（未标记）」）；睡着（非 running）的成员不展示；无 running 成员时显示「当前无成员在活跃工作」。每轮直接产出，不做变化检测/去重。仅 leader 产出。
- **无 presence 专用端点**：写走工具，读走 `GET /squad/:id` 的 `SquadDetail.members[].currentWork` 回显。

### 8.9c 关键用户路径（测试最低覆盖）

| # | 路径 | 验证层 |
|---|------|--------|
| P1 配置路径 | 开总开关 → 配间隔/时段/预算/白名单 → 保存 PATCH /squad → GET 反映 → scheduler 热加载 | API + E2E |
| P2 心跳触发 | 到点 → gate 通过 → 白名单内 deployed 非 busy 成员收到固定心跳提示词 → 有活干活/无活输出 `<EOS>` 自然结束 | API |
| P3 预算拦截 | 当日团队总消耗超 limit → 心跳整队停发；reactive 不受影响 | API |
| P4 时段拦截 | 时间在 activeWindows 之外 → 不发心跳；时段内正常发 | API |
| P5 presence | 成员 `presence(set)` → leader team-status 段可见 → `presence(clear)` → 段内为空；睡着成员不出现 | API + E2E |
| P6 废弃 | member 面板无心跳 section；旧 member 级调度不触发 | E2E |

**设计决策**（用户 2026-07-11 确认，7 条）：心跳粒度 squad 级废弃 per-member / activeWindows 多段不重叠不跨 0 点 / `<EOS>` 零机制改动 / 只记团队总消耗 / presence 自由文本独立工具 + leader team-status 段 / 全 member 含 leader + benched 不唤醒 + SquadChat 无心跳 / UI 落 AutoWork tab 无设计师权威稿功能 PASS 即验收。

**验收**：本版本无设计师权威稿（req 附方向 HTML 原型）→ **不强制视觉保真 compare**，功能 PASS + UI 对齐既有 autowork-tab token 即验收。E2E use cases 全表见版本 PRD §2.5/§3.4。

---

## 8.10 v0.0.194 squad token 用量统计入口 [v0.0.194]

> 引入版本 v0.0.194 · 状态：🚧 dev verified（三 task T0/T1/T2 全 UT 全绿 + code-review CONDITIONAL PASS，packaged 真机验证 + 合并待门禁）
> 权威全文：`specs/prd/version_logs/v0.0.194/prd.md`（本节为 overall 快照）
> 概念权威源：`specs/ui/overall/06-studio.md §2.3`（SeatsPanel 头部 tab 条）+ `specs/ui/components/studio-page/component-seat-stats.md`（现有「已用 token」单值）+ `specs/tech/persistence/index.md`（SchemaDef/CrudStore/Engine 存储体系）
> demo（已落地验证形态）：`app/web/src/components/studio-page/__token_stats_demo__/`

**优先级 P1**。一句话：squad seats 页 tab 条右侧新增「Token 统计」入口，可视化整队 + 每个 member 的 LLM token 流量（by 天/小时、by 类型 输入/输出/缓存/缓存率），日历热力 + 时间轴堆积双视图。

**用户故事**：作为团队管理者（用户），我希望一眼看到整队 token 流量趋势 + 缓存命中情况下钻到单个 member，看清「谁烧得多 / 烧在哪类 / 什么时段集中 / 缓存率如何 / 历史趋势」，以便评估成本与缓存策略。

### 8.10a 入口 + 统计维度
- **入口**：`SeatsPanel` 头部 tab 条（坐席/管理/自动工作）**右侧** `ml-auto` 新增「Token 统计」按钮（图标 + 文案）；点击 → `MainView` 切到 `token-stats` kind（**独立路由态**，IA 对齐 board/panorama 范式），头部显返回键退出；入口激活态（深底反白）；返回键或切其他 nav → 退出回首页 seats。**不改 tab 语义**（tab 仍切 seats/管理/自动工作主体；token 统计是独立 `MainView {kind:'token-stats'; squadId}` 路由态，由 v0.0.168 `{seats\|board\|chat\|member\|member-create}` + v0.0.189 `panorama` 扩展新增）
- **4 维度切换**：
  - 粒度 `day`（跨天，每点=1 天）/ `hour`（单日，每点=1 小时，显日期选择）
  - 范围 `__team__`（整个团队=Σ 所有 member）/ 单个 `memberId`（下拉第 1 项「整个团队」+ 全 member，leader 标「队长」）
  - 类型 `total`（总览=三段和）/ `input` / `output` / `cache` / `cacheRate`（缓存率，比率非 token 量）
  - 视图 `calendar`（日历热力）/ `timeline`（时间轴堆积图）
- **单位口径（用户裁决 MANDATORY）**：token 数一律 **M**（÷1e6）；**缓存率 = cache / (cache + input) * 100**（分母不含 output），单位 **%**

### 8.10b 团队聚合口径（MANDATORY）
- **团队 = Σ 所有 member 的 usage**（含 leader + mate，不能只取 leader）
- **subagent 已统计给 parent**：member session usage 已含其调用的 subagent 消耗 → 每个 member session 全部消耗加总 = 该 member 真实消耗
- **mate 不统计给 leader**：mate 消耗不归 leader session → 团队总量必须 Σ 所有 member
- 校验不变量：Σ 各 member session 全部消耗 ≈ 团队总量

### 8.10c 视图形态
- **日历热力**：按月分组 7 列日历（周一首），每天色块深度按 value/max 归一 4 档透明度；token 类用 hue-blue 基底，cacheRate 用 hue-amber 基底（绝对 0-1 作色阶）；格内显日期 + 值（cacheRate `%` / token 类 M）；色阶图例
- **时间轴堆积图**：横坐标=时间点（日 `M/D` / 小时 `0-23`），纵坐标=堆积色块（input=hue-blue / output=hue-violet / cache=hue-green）；Y 轴按 kind 区分（token 量漂亮步长刻度 / cacheRate 0-100%）；`total` 三段堆积，单类仅该段，cacheRate 比率非堆积
- **汇总条**：合计（M）+ 轴标签 + 三段占比（色块 + label + 量 + %）+ 团队口径说明（仅 team 视图）
- **hover 明细**：`createPortal` 浮层（脱离 overflow 裁剪）+ native title 兜底；`total` 显 5 行（总体/输入/输出/缓存/缓存率）、分项显 1 行、cacheRate 显 1 行

### 8.10d 数据来源 + 存储 + 异步写入（产品层口径）
> 技术实现（schema 字段 / SQLite engine 扶正 / 迁移步骤 / 事件挂载）归架构 change_plan；本节只写产品层要求。
- **新用量写入 = 异步事件**（usage 已有 `RunSchema.usage` + `SessionSchema.usage` 落库链路）→ 额外异步写入时序表（投递机制走 direct call 非 bus 订阅，避免 double-count；实现细节归架构 change_plan + tech `[P1]token_usage_stat.md §4`）；**写入失败不阻塞主流程**（LLM 调用/对话/agent loop 不受影响）
- **持久化时序存储**：用量按「member × 时间桶（天/小时）× 类型」聚合落入时序表（schema store 体系内新 SchemaDef `token_usage_stat`，engine='sqlite' v0.0.194 扶正为生产/packaged 可用）；查询走时序表，运行时不重算 transcript
- **不破坏主流程**：统计是新时序聚合层 + 异步写入，**非补采集**——usage 落库链路不动；现有 `seat-stats`「已用 token」(budget.consumed 当日近似) + `GET /squad/:id/budget/usage` 是本版的历史化升级

### 8.10e 历史数据 migration（不做 — 用户核实无精确数据源，最终决策）

**决策**：不做 migration，`token_usage_stat` 从空表开始，subscriber 从上线后统计新数据（首见记 0，避免把历史累计一次性写入）。

**真相查证**（用户实测 + 代码确认，覆盖 PRD 早期「兜底」提案）：
- `persistUsage`（session-store-usage-impl.ts:188）只有 `runUsage` 传入才写 `run.usage`，用户实测 run JSON 无 usage 字段 → 实际没落（调用没传 runUsage），`RunSchema.usage` 无数据
- usage 流式 emit UsageBlock，但 message/transcript 不持久化（前端不渲染过滤）
- `SessionSchema.usage` 只有累计总量（三分区），无 per-call 时间分布 + 无 model 维度

→ migration（遍历 run 复原）**无精确数据源** → 不做。详见 `specs/tech/persistence/[P1]token_usage_stat.md §6`。

### 8.10f 关键用户路径（测试最低覆盖，详见版本 PRD §3）
| # | 路径 | 验证层 |
|---|------|--------|
| P1 | 点入口 → 看团队近 N 天用量（默认 team+day+total+timeline） | ET/UT |
| P2 | 切 Scope（整个团队 ↔ 单个 member） | UT |
| P3 | 切 Granularity（跨天 ↔ 单日） | UT |
| P4 | 切 Kind（总览/输入/输出/缓存/缓存率） | UT |
| P5 | 切 View（日历 ↔ 时间轴） | ET/UT |
| P6 | hover 看明细（总体 5 行 / 分项 1 行 / 缓存率 1 行） | UT |
| P7 | model 筛选下拉（distinct model 列表，非 squad.modelDefault） | UT |
| P8-P10 | 异步写入不阻塞 / 团队口径校验 / 不破坏主流程 | UT/AT |

**设计决策（用户 2026-07-23 确认）**：① 存储 = schema store 时序表（SQLite engine v0.0.194 扶正，**不引入 MySQL**）；② 团队 = Σ 所有 member（subagent→parent 已含，mate 不→leader）；③ 缓存率 = cache/(cache+input) %，token 单位 M；④ **migration 不做**（用户核实无精确数据源——run.usage 实际没落、session.usage 无 per-call 时间分布，覆盖早期「兜底」提案）；⑤ 异步事件不影响主流程；⑥ demo 形态即视觉参考（本版无独立设计稿，视觉保真 compare 跳过）。

**OUT OF SCOPE**（归架构或后续版本）：时序表 schema 字段 / SQLite engine 扶正步骤 / bootstrap 装配 / packaged 注入 / 异步事件挂载点 / session→member 映射查询（→ 架构 change_plan）；cost 费用维度 / 单日粒度日历视图（小时热力）/ 时区配置 UI（→ 后续版本）。

**新 UI 概念落地（coder 编码前置 spec）**：token 统计视图属新组件 → 按「先 spec 后实现」产出 `specs/ui/components/studio-page/component-token-stats-{panel,controls,calendar,timeline,tooltip}.md`；新 testid 族 `token-stats-*`（最终命名以组件 spec 为准）。

**验收**：本版无独立设计稿（demo 即视觉参考）→ **不强制视觉保真 compare**，功能 PASS + 对齐既有银灰 token + hue palette 即验收。ET 按冒烟集原则——本版属「普通 feature」，版本验证 = 冒烟集回归 + UT（不新增持久 ET case，除非架构识别新 LLM 不确定性场景）。packaged 须过持续可打包护栏（engine 扶正后跑 packaged 版验证）。

---

## 8.8 版本

v0.0.116 — 心跳机制 squad 级升级（AutoWork tab 一处配全队：总开关默认关 + 预算 off/on 默认 1M/天 + 多工作时段 + 范围 all/白名单 + 间隔 5/15/30/60min 默认 15 + squad 级 gate 链调度 + 固定心跳提示词含 `<EOS>` 零机制改动 + 废弃 per-member 心跳）+ 团队成员状态记录 presence（独立 set/clear 工具 + leader「团队当前状态」段只列 running 成员）。详见 §8.9 + `specs/prd/version_logs/v0.0.116/prd.md`。状态：✅ 已完成（本版相关 AT 7/7 + ET 2/2 verified；PRD P1-P6 关键路径全覆盖）。

v0.0.113.ui_opt — 成员编辑面板重构（skills 继承/自定义 switch + 叠加快照筛选器 + 删 model/记忆 + 标题改 skills）+ studio 模型 hover 展示实际生效模型（默认）+ 全局 skill 页滚动修复。详见 §8.7f + `specs/prd/version_logs/v0.0.113/change_log.md`。状态：✅ 已完成（AT 7/7 + ET 6/6 verified）。

v0.0.60.squad_ui_2 — squad 看板概念优化（联合检查归档 + 全实体可编辑 + 统一链路 O→KR→Requirement→Task + body 正文 + Task priority/deadline + Goal completion% 简单平均 + 编辑感知下次启动）。详见 §8.7e + `specs/prd/version_logs/v0.0.60/change_log.md`。状态：✅ 已完成（phase=completed；6 task 全 verified；带 BUG-001 known-issue 合并，UC-1/14 两 LLM case 阻塞待独立版本注册 squad_board provider）。

v0.0.55 — squad workspace + leader/mate 右侧区域（workspace tab 团队/个人语义 + 长期记忆 tab）。详见 `specs/prd/version_logs/v0.0.55.memory_ui_session_lock/change_log.md`。

v0.0.42 — studio chat UI 对齐 playground（component-message-stream 加 sideResolver：单聊 a2a→右、群聊默认；studio 两页 textarea IME 守护；member-chat 同享两层状态分离）。squad 管理骨架不动。验证：UT 全绿；AT 核心 case PASS；ET infra-blocked 待用户定夺。权威变更日志 `specs/prd/version_logs/v0.0.42/change_log.md`。

v0.0.33.3 — squad OKF 双轨完成态（OKF md 主面 + store 投影 + Goal/Requirement/Task 三层 + WorkStatus 状态机 + goal/requirement/task/team(update_charter) 工具强约束 + member.systemPrompt 移除→squad_role fragment + charter/tasks/board reminder provider + 3 skill 软约束 + 看板只读三视图）。验证：UT 全绿；AT 26 pass / 3 a2a known（BUG-001/B1/B4）；ET 11 pass / 2 a2a known（B1）；BUG-001/002/003 fixed；无设计稿 visual_compare=0。权威变更日志 `specs/prd/version_logs/v0.0.33.3/change_log.md`。

v0.0.33.2 — Studio 对话完成态（4 scope 真聊 + unified builder + a2a squad clique + EOS + reachable_agents + member memory panel）。验证摘要：UT/typecheck 通过；AT 14/16 pass（2 fail=BUG-001 known-issue）；ET 8 pass / 1 conflict / 1 BUG-001 hard_fail；无设计稿，visual_compare=0。

v0.0.33.1 — squad 团队/角色 CRUD + Studio 管理 UI 首版（管理全实跑 + 对话全占位 + bizType 隔离 + 命名 B 方案统一）。基于 `reqs/v0.0.33.1/{req,design-brief}.md` + 6 个 html 设计稿 + `states/v0.0.33.1/design.md` + 概念 spec（data_model / squad_definition / session_biztype / 06-studio / nav-rail）。权威变更日志 `specs/prd/version_logs/v0.0.33.1/change_log.md`。
