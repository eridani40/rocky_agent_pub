# v0.0.244 PRD — squad 成员列表默认隐藏 bench（在岗视图 + 查看全部 + 手动恢复）

> 版本主题：把 spec `design.md §9.2` 早已写明却从未落地的「UI 隐藏 benched 成员」补上——默认在岗视图（认知/协作层/UI/mention 全场景过滤 bench）+ roster 头视图筛选 toggle（在岗/全部）看下岗 + 复用现有菜单 deploy 恢复（零新增按钮）；数据层不动、leader team tool 零改。
> 引入版本：v0.0.244 · 状态：PRD 待用户确认
> 概念权威源（PRD 对齐，不发明概念）：
> - `specs/tech/squad/design.md §9.2`（bench 设计意图权威：「长期 bench=离队；UI 隐藏 benched 成员即可，数据层不动」）
> - `specs/tech/squad/[P1]squad_tools.md §2`（member 状态机 `deployed ⇌ bench` + leader `team` tool）
> - `specs/tech/squad/[P1]prompt_sections.md §3.2/§5`（team_roster stable mapper / reachable_agents reminder provider）
> - `specs/ui/components/studio-page/component-seats-panel.md` + `component-seats-body.md` + `component-seat-card.md` + `component-seat-row.md` + `component-seat-card-menu.md` + `component-seat-stats.md`（seats 相关组件契约）
> - `specs/api/mention/GET-search.md`（mention search 契约：provider=member）
> 需求来源：`reqs/[working] v0.0.244.member_bench_filter/req.md` + `states/user_query.md` v0.0.244 段（已确认决策）

---

## 1. 背景 + 目标

### 1.1 背景

member 状态机 `deployed ⇌ bench`（bench = 下岗/暂离队，停心跳；deploy = 上岗恢复）。spec `design.md §9.2` 早已写明设计意图——**"长期 bench = 离队；UI 隐藏 benched 成员即可（数据层不动）"**——但这层「隐藏」**从未落地**。

现状：bench 成员在各**消费点**仍全量外显，造成 agent 认知错乱 + UI 混杂，并藏一个真 bug：

| 消费点 | 现状 | 问题 |
|--------|------|------|
| system prompt `team_roster`（`prompt/team_roster.ts`） | 读 `studioContext.members` 全量渲染花名册 | agent 以为下岗的还是当前队伍一员（认知错乱） |
| system reminder `reachable_agents`（`prompt/reachable_agents.ts`） | 把 bench 成员列为「可 `send_message` 对端」 | **真 bug**：bench 无心跳不运行，`send_message` 给死人 |
| UI 成员列表（`use-seats-data` → `seats-mates-grid`） | seats 渲染全量（bench 标 `presence='offline'`） | 下岗的混在在岗列表里；`totalCount` 含 bench |
| mention search（`GET /mention/search?provider=member`） | 待架构期核实 | 用户要求「@ 列表不含 bench」（用户原话） |
| `squad_team_status` reminder | 天然只列 running session | 已排除 bench（核对即预期零改） |

### 1.2 目标

**默认在岗视图**——除 leader 管理工具外，所有场景只看 deployed：
1. 认知层（system prompt roster）+ 协作层（reminder reachable_agents + mention search）只看 deployed
2. UI 成员列表默认只展示 deployed，统计只算在岗
3. 修 reachable_agents 真 bug（bench 不可达）

**管理视角保留全量**——leader `team` tool 不动（`team list` 返全量 + 带 `state` 字段，leader 可 `team deploy {roleId}` 恢复下岗成员）。

**UI 视图筛选 + 恢复（复用）**——成员列表加视图筛选 toggle（在岗/全部，默认在岗）看下岗成员；恢复走现有「更多」菜单 deploy 项（零新增按钮）。

### 1.3 用户故事

- 作为 **agent**，我希望我的「当前队伍」认知只含活跃成员，不被下岗成员干扰对队形的判断
- 作为 **agent**，我希望 `send_message` 给的对端真的能收到（bench 不在可达列表里）
- 作为 **用户**，我希望成员列表一眼是当前在岗的活跃队伍，下岗的不混杂进来
- 作为 **用户**，我希望能看到下岗成员并手动恢复（deploy），不必去翻 leader session 打 `team deploy`
- 作为 **leader**，我希望保留管理全视角——`team list` 仍能看到谁被 bench 了，能恢复

---

## 2. 关键设计决策（用户已确认）

| 决策 | 选择 | 理由 |
|------|------|------|
| 过滤发生层 | **消费点过滤**（数据层 `MemberStore.listMembers` 不动） | spec design §9.2 明确：「UI 隐藏即可，数据层不动」；保留全量数据让 leader tool / 查看全部仍可取 |
| 过滤判据 | `member.state === 'deployed'`（benched = 下岗） | 对齐状态机 `[P1]squad_tools.md §2` |
| 默认视图语义 | **所有非管理场景默认只看在岗** | 认知/协作层 + UI 默认 + mention 同步 |
| leader `team` tool | **零改**（返全量 + state 字段） | 管理工具看全队（含下岗可恢复）vs 认知/协作层看活跃队伍，有意区分 |
| UI 视图筛选 + 恢复（复用） | **roster 头视图筛选 toggle（在岗/全部，默认在岗）+ 复用现有菜单 deploy 项（零新增按钮）** | 默认清爽、需要时切全部可查；恢复功能菜单已具备，与 v0.0.240 task「活跃/含归档」开关同构 |
| 真 bug 修法 | reachable_agents 过滤 bench（不再列为可达对端） | bench 无心跳不运行，`send_message` 必须不可达 |

---

## 3. 功能需求

### 3.1 默认在岗视图：认知/协作层过滤 bench [v0.0.244]

**描述**：在 agent 的认知与协作通道（system prompt roster + system reminder reachable_agents + mention search），过滤掉 bench 成员——agent 的「当前队伍」= 活跃成员，`send_message` 对端必活跃。**纯消费点过滤，数据层 `MemberStore.listMembers` 仍返全量**。

过滤判据统一：`member.state === 'deployed'`。

#### 3.1.1 team_roster 只渲染 deployed 成员
- **现状**：`team_roster.ts renderRoster` 读 `studioContext.members` 全量，渲染 `{name, role, sessionId, intro}` 花名册
- **变更**：渲染前按 `state === 'deployed'` 过滤；bench 成员不出现在 system prompt 的 Team Roster 段
- **对齐 spec**：`[P1]prompt_sections.md §3.2`（team_roster stable mapper 数据源 + 渲染格式不变，仅加过滤）

#### 3.1.2 reachable_agents 只列 deployed（**修真 bug**）
- **现状**：`reachable_agents.ts` 把 bench 成员列为「可 `send_message` 对端」——但 bench 无心跳、不运行，`send_message` 过去是死的
- **变更**：派生对端列表前按 `state === 'deployed'` 过滤；bench 不在可达列表
- **对齐 spec**：`[P1]prompt_sections.md §5` 派生表（sessionType 决定对端组合的语义不变，仅各分支 mates/peers 收缩到 deployed）
- **用户感知**：agent 不再尝试给下岗成员发消息（消除失败调用 + 认知混乱）

#### 3.1.3 mention search 过滤 bench
- **现状**：`GET /mention/search?provider=member` 返 member 列表（待架构期核实现状是否含 bench）
- **变更**：@ 列表不含 bench（用户原话「不在可对话列表里」）
- **过滤落点**：handler 层 or service 层——**架构期定**（PRD 只描述用户感知「@ 列表不含 bench」）
- **对齐 spec**：`specs/api/mention/GET-search.md`（provider=member 契约不变，仅结果集过滤）

#### 3.1.4 squad_team_status reminder（核对，预期零改）
- 该 reminder 天然只列 running session（`[P1]prompt_sections.md §4`）→ bench 成员不 running → 已天然排除
- **本版本预期零改**，架构期核对确认即可

**优先级**：P0 · **用户故事**：作为 agent，我的「当前队伍」认知 + 通信对象都只含活跃成员。

#### E2E Use Cases（默认在岗视图）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-V1 | leader session 触发一轮 → 看 system prompt 的 Team Roster 段 | 仅 deployed 成员列出（bench 不在 roster） |
| UC-V2 | mate session 触发一轮 → 看 reminder reachable_agents 段 | 仅 deployed peer 列为可达对端（bench 不在） |
| UC-V3 | 队伍含 1 deployed + 1 bench → mate 调 `send_message` 给 bench 对端 | 工具层因 bench 不在 reachable_agents 而不可达（不再出现「给死人发消息」） |
| UC-V4 | UI @ 框输入 `@` → 看 member 列表 | 仅 deployed 成员候选（bench 不在 @ 列表） |

### 3.2 UI 成员列表：默认在岗视图 + 视图筛选 + 恢复（复用） [v0.0.244]

**UI 需求 brief（交互意图，非像素设计——用户有专业设计师）**。

**对齐 UI spec**：改造 `component-seats-body.tsx`（roster 头加视图筛选 toggle + mates 行列表过滤）+ `use-seats-data.ts`（派生过滤）；菜单 deploy 项已存在于 `component-seat-card-menu.md`（`hasDeploy = state==='benched' && onDeploy`，恢复零新增按钮）。本版本新增的是**视图筛选 toggle + 派生过滤**。

#### 3.2.1 默认只展示 deployed 成员
- roster 主体（mates 行列表）默认仅渲染 deployed mate；bench mate 不混入列表
- roster 头计数文案口径不变（「成员·N」，N=总人数−队长），但**当存在 bench 成员时**，N 的口径与展示需明确（见 §3.2.4 开放点）
- **对齐 spec**：`component-seats-body.md`（roster 头计数 + mates 行列表契约）

#### 3.2.2 视图筛选开关（在岗视图 / 全部视图）——本版本唯一 UI 新增
- **目的**：默认只看在岗（deployed）mate；需要时切到「全部」看下岗成员 + 用现有菜单 deploy 恢复
- **形态**：roster 头部一个视图筛选 toggle（「在岗」/「全部」两态，默认「在岗」）——与 v0.0.240 task tab「活跃/含归档」开关同构
- **roster 头计数跟随视图**：N = 当前视图显示的 mate 行数（在岗视图=N 在岗；全部视图=N 全队）——「显示几个就是几个」，计数与列表一一对应（用户裁决：数据收集全统计个数即可，二者对应）
- **列表渲染**：在岗视图只渲染 deployed mate 行；全部视图渲染全部 mate 行（deployed + benched）。纯列表过滤，不跳路由、不切页面
- **空态**：在岗视图 deployed mate=0 显空态；全部视图全队 mate=0 显空态
- **对齐 spec**：`component-seats-body.md`（roster 头计数 `mateRows.length` + mate 行列表契约）

#### 3.2.3 下岗成员恢复（复用现有菜单 deploy，零新增按钮）
- **现状已具备**：`component-seat-card-menu.tsx deriveMenuAvail` 硬规则 `hasDeploy = member.state === 'benched' && !!onDeploy`——benched 成员的「更多」菜单**已有 deploy 项**；`onDeploy` 已从 `SeatsBody` 接通到每行（`component-seat-row.tsx`）。**恢复功能无需新增任何按钮**
- **本版本做的**：仅在「全部」视图下让 benched 行可见（在岗视图隐藏）→ 用户点该行「更多」菜单 → deploy 项恢复
- **下岗行视觉**：现状已 `opacity-75`（offline 语义）+ who 列显 `role · state`（benched 显 `mate · benched`）——视觉区分已足够，**无需额外设计**
- **恢复后效果**：deploy 成功 → SSE 推送成员 state 变更 → 该成员回到 deployed；在岗视图即见
- **对齐 spec**：`component-seat-row.md`（offline opacity-75 + state 显示）+ `component-seat-card-menu.md`（deploy 菜单项硬规则）

#### 3.2.4 统计格（不涉及）
- SeatStats 2×2 统计格 v0.0.240 已从首页主体移除（`component-seats-body.tsx` 现用 TokenWidget）——**本版本 UI 无统计格改动**；唯一计数 = roster 头「成员·N」，口径见 §3.2.2（跟随视图 = 显示行数）

**优先级**：P0 · **用户故事**：作为用户，我一眼看到的是当前活跃队伍，需要时可查下岗 + 一键恢复。

#### E2E Use Cases（UI 在岗视图 + 视图筛选 + 恢复）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-U1 | 进 squad 首页 seats → 看 roster 列表 | 默认在岗视图：仅 deployed mate 行 + roster 头计数=在岗数（benched 不在列表） |
| UC-U2 | 队伍含 benched 成员 → 点视图筛选切「全部」 | 列表显含 benched 行（opacity-75 + `mate · benched`）+ roster 头计数=全队数 |
| UC-U3 | 全部视图下点 benched 行「更多」菜单 → deploy 项 | 调 deploy；成功后该成员 state→deployed；切回在岗视图即见；SSE 推送 |
| UC-U4 | 在岗视图下 deployed mate=0 | 显空态（seats-empty） |

### 3.3 leader `team` tool 保留全量（零改） [v0.0.244]

**描述**：leader 的管理工具 `team list/query` 继续返全量成员（含 bench），并带 `state` 字段——让 leader 在自己 session 里能看出谁 benched + 用 `team deploy {roleId}` 恢复。

- **本版本 team tool 零改**：现状已返全量 + `state` 字段（`team-tool.ts runList`）
- **spec 漂移另案**：`[P1]squad_tools.md §2` 写 `list` 有 `filter?: {state?, type?}` 入参，但 impl 无（spec-only 特性从未落地）——**非本版本目标**，记 doc-sync（§7）

**优先级**：P0（零改=确认保留）· **用户故事**：作为 leader，我保留管理全视角，能恢复下岗成员。

#### E2E Use Cases（leader 管理视角）
| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-L1 | leader session 调 `team list` | 返全量成员（含 bench）+ 各成员 `state` 字段 |
| UC-L2 | leader 看到某 member state=benched → 调 `team deploy {roleId}` | 该 member state → deployed；后续轮次 roster/reachable_agents 重新包含该成员 |

---

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

> 用户路径 = 测试最低覆盖（每条至少一个 AT/UT 或 ET case）。版本验证 = 冒烟集回归 + UT（用户铁律：普通 feature 不新增持久 AT/ET，仅 LLM 不确定/新板块入选）。

| # | 路径 | 覆盖建议 |
|---|------|---------|
| **P1** | 默认看成员列表 → 在岗视图只见 deployed → benched 不在列表 + 计数=在岗数 | ET（首页 seats 板块冒烟，对齐 `00-app-guide.md` seats 章节）+ UT（use-seats-data 视图过滤派生） |
| **P2** | 点视图筛选切「全部」→ 见 benched 成员 → 点该行「更多」菜单 deploy → 成员回在岗 | ET（同 P1 case 内连续操作）+ UT（deploy 调用 + SSE 状态变更） |
| **P3** | leader 在自己 session → 看当前队伍（system prompt roster 不含下岗）→ 想恢复下岗成员 → `team list`（看全量+state）→ `team deploy {name}` → 恢复 | UT（team list 返全量+state、deploy 状态机）+ AT 候选评估（leader 工具调用链跨层，但无新 LLM 不确定场景，倾向 UT） |
| **P4** | @ 某成员 → mention 列表不含下岗成员 | UT（mention search member 过滤） |

**ET 候选评估**：本版本改动用户可感知界面（成员列表默认在岗视图 + 视图筛选 toggle），需 ET blocking=0 才能合并。建议 1 条 ET（首页 seats：进 seats → 确认在岗视图只见 deployed → 切「全部」→ 见 benched 行 → 点菜单 deploy → 成员回在岗），不新增 AT（无新 LLM 不确定场景——过滤是确定性逻辑、team tool 链路 AT 已覆盖）。

**mention search 现状**：架构期核实现状（是否已过滤 bench）+ 定过滤落点；UT 覆盖（确定性 HTTP 契约过滤，不进 AT）。

---

## 5. 范围边界（IN / OUT）

### IN SCOPE（v0.0.244）
- 认知/协作层过滤 bench：team_roster（system prompt）+ reachable_agents（system reminder，**修真 bug**）+ mention search
- squad_team_status reminder 核对（预期零改）
- UI 成员列表默认在岗视图 + 视图筛选 toggle（在岗/全部）+ 恢复（复用现有菜单 deploy）
- 统计格语义明确（待用户确认开放点 §3.2.4）

### OUT OF SCOPE（显式不做）

| 排除项 | 理由 |
|--------|------|
| 改 `MemberStore.listMembers` / member 状态机 | spec design §9.2 明确「数据层不动」；过滤在消费点 |
| leader `team` tool 加 `filter.state` 入参实现 | spec-only 特性从未落地（§7 doc-sync）；非本版本目标，leader 现状能看全量+state 已够用 |
| 引入 fire/终态 | U5 决策：长期 bench = 离队，bench 兜底（不引入新终态） |
| 页面设计稿 / 像素级 UI 规范 | 用户有专业设计师；PRD 只出需求 brief（交互意图 + 用户感知） |
| bench/deploy 状态机本身的语义/迁移 | 已完备（design §9.2 + squad_tools §2），本版本只补「隐藏」这层 |

---

## 6. 验收口径

**功能**：
- 默认在岗视图：team_roster / reachable_agents / mention search / UI 成员列表 默认均不含 bench（仅 deployed）
- reachable_agents 真 bug 修复：bench 不再被列为可达 `send_message` 对端
- 视图筛选 + 恢复：UI 视图筛选 toggle 可看下岗成员 + 复用「更多」菜单 deploy 项拉回在岗
- leader `team list` 仍返全量 + state 字段（零改 = 不退化）
- squad_team_status reminder 天然只列 running（核对未退化）

**视觉**：无设计稿（用户有专业设计师，PRD 只出需求 brief）→ 视觉保真 compare 跳过；验收以「功能正确 + 下岗视觉弱化区分明显（用户可一眼辨别）」为准

**API**：mention search member 结果集过滤（待架构期定落点 + UT 覆盖）；team tool 零改（现有端点契约不变）

**known-issue**：暂无（待验证发现）

---

## 7. 开放点（已与用户确认收口）

初稿提的 2 个开放点，经用户裁决 + orchestrator 核实产品现状后**全部消解**：

### 7.1 统计格/计数口径（已消解）
- **事实**：SeatStats 2×2 统计格 v0.0.240 已从首页主体移除（`component-seats-body.tsx` 用 TokenWidget）——不存在「在线/总数」统计格矛盾。唯一计数 = roster 头「成员·N」= `mateRows.length`
- **用户裁决**：计数 = 当前视图显示的行数（「下面有几个就是几个」「它俩是对应的」「按情况来」）——跟随视图筛选，无需单独定口径。已落 §3.2.2

### 7.2 交互形态（已消解）
- **用户裁决 + 产品现状核实**：恢复功能**已存在**——`component-seat-card-menu.tsx deriveMenuAvail` 硬规则 `hasDeploy = member.state === 'benched'`，benched 成员「更多」菜单已有 deploy 项且 `onDeploy` 已接通。本版本**不新增恢复按钮**
- **本版本唯一 UI 新增** = roster 头一个视图筛选 toggle（在岗/全部，默认在岗）；下岗行视觉（opacity-75 + `mate · benched`）现状已足够。已落 §3.2.2/§3.2.3

**结论**：初稿里「恢复按钮复用 ops 列改 primary」「下岗卡片单独视觉设计」「统计格 A/B/C 方案」均为过度设计（没把产品研究明白），已按用户裁决全部删除/修正。本版本 UI 改动收敛为：**仅新增一个视图筛选 toggle + 派生过滤**。

---

## 8. spec doc-sync 待办（架构期 / doc-modifier 阶段 5 处理）

> 读 spec 发现以下漂移/过时项（PRD 描述按本版本正确概念，doc-modifier 阶段 5 统一修 spec 对齐）：

| spec 文件 | 过时/漂移内容 | 正确概念 |
|-----------|--------------|---------|
| `[P1]squad_tools.md §2` | `team list` 写有 `filter?: {state?, type?}` 入参 | impl 无（`team-tool.ts runList` 直接 listMembers 全量），spec-only 特性从未落地；本版本 team tool 零改=保留全量，filter.state 入参另案（非本版本目标） |
| `[P1]prompt_sections.md §5` | 标题写「reachable_agents（system_reminder，不变）」+ 派生表用 `[leader, ...all mates]` 全量口径 | v0.0.244 起各分支 mates/peers 收缩到 `state==='deployed'`（修 bench 当可达对端的真 bug）；spec 需补「deployed-only 过滤」约束 |
| `[P1]prompt_sections.md §3.2` | team_roster 数据源写「`studioContext.members` 全量渲染」 | v0.0.244 起渲染前按 `state==='deployed'` 过滤；spec 需补过滤约束 |
| `component-seat-stats.md` | onlineCount=deployed，totalCount=全量 | v0.0.244 默认在岗视图下语义待用户确认（§7.1）；若口径改 spec 需同步 |

**概念边界**：本版本不引入新概念（bench/deploy 状态机 + 消费点过滤 + team tool 全量 + 菜单 deploy 项均 spec 已完备），只补「隐藏」这层的消费点实现 + 一个视图筛选 toggle。新 UI 交互（视图筛选 toggle 字段）由架构期 / coder 阶段补 `specs/ui/components/component-seats-body.md` 组件 spec 字段，PRD 不擅自填像素规范。
