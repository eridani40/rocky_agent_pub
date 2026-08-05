# v0.0.244 变更计划书 — squad 成员列表默认隐藏 bench（在岗视图 + 视图筛选 + 复用菜单 deploy）

> **method 级 review 合同**。架构期冻结：planner/coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 背景：member 状态机 `deployed ⇌ bench` 早已完备，spec `design.md §9.2` 写明「UI 隐藏 benched 成员即可（数据层不动）」但从未落地。本版本在**消费点**过滤 bench：认知/协作层（team_roster / reachable_agents，修真 bug）+ UI 默认在岗视图（新增视图筛选 toggle）；mention search / squad_team_status / team tool / 数据层**零改**（核实结论见下）。PRD：`specs/prd/version_logs/v0.0.244.member_bench_filter/prd.md`。

## 架构期核实结论（grep/读代码实证，非凭概念）

| 核实项 | 结论 |
|--------|------|
| mention search 过滤落点 | **零改**——`app/server/src/mention/providers/member-provider.ts:50-53` `search()` 已 `m.state === 'deployed'` 过滤（与 spec `mention/provider-interface.md §8`「不含 bench 状态」一致），handler/service 纯透传无需动 |
| squad_team_status reminder | **零改**——`reminder/squad_team_status.ts` `provide()` 只列 `isSessionRunning(sessionId)` 成员；bench 停心跳不 running → 天然排除 |
| leader team tool | **零改**——`team-tool.ts runList` 返全量 + `state` 字段（管理全视角保留） |
| 数据层 | **不动**——`MemberStore.listMembers` 返全量；bootstrap 注入 `studioContext.members` 为完整 `MemberRecord[]`（`MemberSchema.state` required，enum `[deployed,benched]`），plugin duck-type 可直接读 state，注入点零改 |
| 恢复/下岗视觉 | **零改**——`component-seat-card-menu.tsx:80` `hasDeploy = member.state==='benched' && !!onDeploy` 已具备；seat-row `opacity-75` + `mate · benched` 已具备 |

## 关键设计决策（architect 裁定）

1. **过滤判据实现分层**：生产数据 `state` required（enum 闭合 deployed|benched），与 PRD「只留 deployed」等价。plugin 侧 duck-typed（untyped JSON）用 **`state !== 'benched'`**（显式 benched 才隐藏；state 缺失的旧 fixture/旧注入按 deployed 对待不隐藏，防全灭 + 既有测试不破）；web 侧 `Member.state` 类型必填用严格 `=== 'deployed'`。
2. **过滤单点**：team_roster 在 `readRoster()` 返回前过滤（renderRoster/map 零改）；reachable_agents 在 `readMembers()` 过滤（derive/deriveSquadScoped 派生表结构与「user 永不在」不变量零改，mates/peers 自动收缩）。
3. **UI 过滤落点 = SeatsPanel**：view state 归 panel（`SeatsBody` 保持「纯展示 + 回调」spec 边界不持状态）；`mateRows = seats.filter(!isLeader)` 再经 `deriveViewRows(rows, view)`；计数 `memberCount = mateRows.length` 口径不变、自动=当前视图行数（PRD §3.2.2「显示几个就是几个」）。leaderRow 不受过滤影响（leader 恒 deployed）。
4. **toggle = 新受控组件 `SeatsViewSwitch`**：视觉/交互同构 `ArchiveSwitch`（v0.0.240「活跃/含归档」），但**不泛化 ArchiveSwitch**（其 i18n key/actionKey 是 panorama 专属，泛化需改 panorama-view 消费方，blast radius 大）。恒渲染（不条件于存在 benched）——稳定锚点。
5. **页头 onlineBadge / TokenWidget / SeatStats 零改**（不属 roster 头计数口径；PRD §3.2.4）。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad_prompt | app/plugins/builtins/rocky_context/prompt/team_roster.ts | MemberRef | 修改 | 加可选字段 `state?: string`（过滤判据载体） | MUST 保持其余字段与渲染格式不变 | prompt_sections §3.2；PRD §3.1.1 | +2 |
| squad_prompt | app/plugins/builtins/rocky_context/prompt/team_roster.ts | readMemberRef() | 修改 | duck-type 读 `state`（string 才取，缺省 undefined） | MUST NOT 因 state 缺失丢整条（现有 name/sessionId 判空逻辑不变） | 本计划决策 1 | +3 |
| squad_prompt | app/plugins/builtins/rocky_context/prompt/team_roster.ts | readRoster() | 修改 | refs 返回前过滤 `state !== 'benched'`（批量分支 + 兜底单条同一判据） | MUST 单点过滤（map/renderRoster 零改）；MUST NOT 改 Option A 分流（subagent 不可见） | prompt_sections §3.2；PRD §3.1.1 | +4 |
| squad_prompt | app/plugins/builtins/rocky_context/prompt/reachable_agents.ts | MemberRef | 修改 | 加可选字段 `state?: string` | 同 team_roster | prompt_sections §5；PRD §3.1.2 | +2 |
| squad_prompt | app/plugins/builtins/rocky_context/prompt/reachable_agents.ts | readMemberRef() | 修改 | duck-type 读 `state`（string 才取） | 同 team_roster | 本计划决策 1 | +3 |
| squad_prompt | app/plugins/builtins/rocky_context/prompt/reachable_agents.ts | readMembers() | 修改 | 返回前过滤 `state !== 'benched'`（单点；squad/leader/mate 三分支 mates/peers 自动收缩到 deployed） | MUST 单点过滤；MUST NOT 改 derive/deriveSquadScoped 派生表结构 +「user 永不在」不变量；MUST NOT 动 subagent 分支（[parent] 拓扑硬约束） | prompt_sections §5；a2a_protocol §3；PRD §3.1.2（修真 bug） | +2 |
| squad_prompt_test | app/plugins/builtins/rocky_context/__tests__/prompt-studio.test.ts | roster/reachable bench 过滤 case | 修改 | 新增：含 benched 成员时 team_roster 不渲染之；reachable 各 sessionType 分支不含 benched 对端；全 deployed 不回归；state 缺失按 deployed 可见 | MUST 沿用现有 mkCtx fixture 模式（fixture 补 state 字段） | PRD §3.1 UC-V1/V2/V3 | +45 |
| ui-seats | app/web/src/components/studio-page/use-seats-data.ts | SeatsView | 新增 | `export type SeatsView = 'active' | 'all'`（active=在岗视图） | MUST export（panel/body/UT 共用） | PRD §3.2.2 | +2 |
| ui-seats | app/web/src/components/studio-page/use-seats-data.ts | deriveViewRows() | 新增 | export 纯函数 `(rows: SeatRow[], view: SeatsView): SeatRow[]`；active → filter `member.state === 'deployed'`；all → 原样返回 | MUST 纯函数返回新数组不改输入；MUST NOT 动 derivePresence/onlineCount/inProgressCount 既有口径 | PRD §3.2.2；本计划决策 1/3 | +9 |
| ui-seats | app/web/src/components/studio-page/component-seats-view-switch.tsx | SeatsViewSwitch | 新增 | 受控 segmented 开关（在岗/全部）；props `{ view: SeatsView; onChange: (v: SeatsView) => void }`；视觉同构 ArchiveSwitch（segment + `/` 分隔） | MUST 受控不持状态；MUST data-action-key `studio.seats.view-active`/`studio.seats.view-all`；MUST 文案走 t() | PRD §3.2.2；本计划决策 4；_conventions.md | +55 |
| ui-seats | app/web/src/components/studio-page/component-seats-body.tsx | SeatsBodyProps | 修改 | 加 `view: SeatsView` + `onViewChange: (v: SeatsView) => void` 两必填 props | MUST 保持纯展示+回调边界（不持 view state） | component-seats-body.md；PRD §3.2.2 | +4 |
| ui-seats | app/web/src/components/studio-page/component-seats-body.tsx | SeatsBody() | 修改 | roster 头（计数右侧、「＋新增成员」左侧）渲染 SeatsViewSwitch；列表/计数继续用传入 mateRows（自身不过滤） | MUST NOT 在 body 重复过滤（过滤单点=panel）；`memberCount = mateRows.length` 口径不变（自动=当前视图行数）；空态判断不变 | component-seats-body.md；PRD §3.2.2 | +8 |
| ui-seats | app/web/src/components/studio-page/component-seats-panel.tsx | SeatsPanel() | 修改 | `useState<SeatsView>('active')`；mateRows 派生改 `seats.filter(!isLeader)` → `deriveViewRows(rows, view)`；传 view/onViewChange 给 SeatsBody | MUST 过滤单点在 panel；leaderRow 不受过滤影响；页头 onlineBadge/TokenWidget 零改 | component-seats-panel.md；PRD §3.2.1/3.2.2 | +8/-1 |
| ui-seats | app/web/src/i18n/locales/zh-CN/studio.json | seats.viewSwitch.* | 修改 | 加 `seats.viewSwitch.active`=「在岗」+ `seats.viewSwitch.all`=「全部」 | MUST 双语全加（en 同步）+ 渲染走 t()（defaultValue 被 parseMissingKeyHandler 覆盖失效） | memory i18n-key-add-checklist | +2 |
| ui-seats | app/web/src/i18n/locales/en/studio.json | seats.viewSwitch.* | 修改 | 同上（Active / All） | 同上 | 同上 | +2 |
| ui-seats_test | app/web/src/components/studio-page/__tests__/use-seats-data.test.ts | deriveViewRows case | 修改 | 新增：active 过滤 benched / all 原样 / 返回新数组不改输入 | MUST 沿用 mkMember fixture | PRD §3.2.2 | +20 |
| ui-seats_test | app/web/src/components/studio-page/__tests__/component-seats-panel.test.tsx | 视图筛选 case | 修改 | 新增：默认在岗只见 deployed + 计数=在岗数；切全部见 benched 行 + 计数=全队；既有「成员·N」计数 case 对齐新口径（计数=当前视图行数） | MUST 既有 case 语义跟随更新不硬删 | PRD §3.2 UC-U1/U2/U4 | +35 |
| ui-spec | specs/ui/components/studio-page/component-seats-view-switch.md | 新组件 spec | 新增 | **coder 编码前置产出**：props/view 两态/视觉基线（同构 ArchiveSwitch）/action-key/i18n key | MUST 先 spec 后实现（_conventions 硬规） | _conventions.md；PRD §3.2.2 | +40 |
| ui-spec | specs/ui/components/studio-page/component-seats-body.md | 视图筛选契约 | 修改 | coder 前置补：roster 头视图筛选 toggle 槽位 + view/onViewChange props + 计数跟随视图口径 | MUST 与实现同步 | PRD §3.2.2 | +12 |
| ui-spec | specs/ui/components/studio-page/component-seats-panel.md | view state 归属 | 修改 | coder 前置补：view state 在 panel + mateRows 过滤派生点（deriveViewRows） | MUST 与实现同步 | PRD §3.2.1 | +8 |

## 零改确认（reviewer 核对 diff 为空）

- `app/server/src/mention/providers/member-provider.ts`（已过滤 deployed）+ `handlers/mention.ts` + `mention/search-service.ts`
- `app/plugins/builtins/rocky_context/reminder/squad_team_status.ts`（只列 running）
- `app/server/src/agent/tools/team-tool.ts`（runList 返全量+state，管理全视角）
- `app/server/src/stores/squad-store.ts`（listMembers 数据层不动）+ `handlers/session-config.ts`（bootstrap 注入不动，members 已带 state）
- `component-seat-card-menu.tsx`（hasDeploy 已具备）+ `component-seat-row.tsx`（opacity-75 + `mate · benched` 已具备）

## 影响面评估

- **跨模块**：后端 rocky_context plugin（prompt 2 文件）+ 前端 studio-page（5 文件 + i18n 2 文件 + spec 3 文件）+ 双侧 UT。无破坏性变更；无依赖顺序（后端∥前端可并行）。
- **风险点**：低。唯一行为风险 = 全 deployed 场景下 roster/reachable 输出与现状逐字节一致（决策 1 的 `!== 'benched'` 判据保证）；UI 默认视图变化是 PRD 目标行为。
- **doc-sync 待办**（doc-modifier 阶段 5，PRD §8 已列）：`[P1]squad_tools.md §2` filter.state 入参 spec-only 漂移；`[P1]prompt_sections.md §3.2/§5` 补 deployed-only 过滤约束；`component-seat-stats.md` 口径确认。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
