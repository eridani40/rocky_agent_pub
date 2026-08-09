# v0.0.273 PRD — mate run 退出通知 leader hook + team-status 全员 status

> 版本主题：让 leader 对 mate 状态有感知——① mate run 在统一退出口退出时主动发 send_message 通知 leader（全 stopReason，per_run）；② team-status reminder 从「只列 running」改为「列全员 + 真实状态 + presence」。
> 产出：`specs/prd/version_logs/v0.0.273.mate_exit_notify/prd.md`

## 1. 背景与问题

### 1.1 痛点（老板 2026-08-07 提出）
squad mate agent 的 run 退出时，leader 无感知：
- mate **正常做完**退出（no_tool_call）→ leader 不知道做完了（实证：v0.0.271 architect 正常退出，leader 以为它还在做 271）
- mate **出错**（error / doom_loop / max_iterations）→ leader 不知道挂了
- mate **等待审批**（tool_pending HITL 悬挂）→ leader 不知道在等回填

### 1.2 现状（代码核实）
- **run 统一退出口**：`run-react-loop.ts` L266-291 退出分流——interrupted 分支 → `lifecycle.onInterrupted(state)`；正常分支 → `lifecycle.onRunEnd(state)` + emitRunEnd。`RunLifecyclePort`（`run-lifecycle-port.ts`）实现两 hook：onRunEnd = persistRun + 五态机 CAS（error/tool_pending/idle）+ replySettle 兜底；onInterrupted = 仅 replySettle subagent 旁路（其余 noop）。
- **mate 识别**：`SessionConfig.kind.role === 'mate'`（Role 值域含 mate）+ `SessionConfig.sessionContext.squadId/memberId`；子 agent derivation='subagent'（role 继承 parent）需排除。
- **leader sessionId 来源**：`squadStore.getSquad(squadId).leaderSessionId`（squad-service.ts L69 字段）。
- **send_message 系统级投递**：`send-message-tool.ts` 用 `manager.deliverTo(targetSid, msg)` + sender.source='agent' 承载 a2a 信封；`RunLifecyclePort` 已有 `deliverTo` 注入模式（replySettle 用）可仿照。
- **team-status**：`squad_team_status.ts` L66 `if (!running) continue` 跳过非 running 成员 → 做完的 mate 从块里消失。

## 2. 核心产品决策

| ID | 决策 | 理由 |
|----|------|------|
| D1 | **块1 触发 = 只 mate 顶级 run**：`kind.role==='mate'` && `derivation==='parent'` | leader 自己 / 子 agent / 非 squad session 不触发（req 边界）。子 agent 的 role 继承 parent 但 derivation='subagent'，必须排除 |
| D2 | **通知 = 全部 stopReason，per_run 每次退出都发** | 老板拍板：正常退出 leader 也需知道（否则误以为还在工作）；全但不漏，降噪后续再调 |
| D3 | **通知载体 = send_message 系统级投递（deliverTo）** | 消息天然带发送者 = 该 mate（a2a 信封 sender.source='agent'），agent 名由链路保证，正文不重复标 |
| D4 | **内容 = markdown：stopReason + 最后 message 的 content block 序列 + 耗时 + pendingToolCalls（tool_pending 时）** | 老板拍板要素；minimal（不带 runId/迭代轮数）；block 类型 ∈ text/tool_call/tool_result/tool_reply/image，**不含 reasoning（thinking）/ usage** |
| D5 | **每 block 截断 = 前后各 500 字符，中间省略** | 老板拍板（500 word/字），防止超长消息淹没 leader |
| D6 | **hook 挂 run 统一退出口**：RunLifecyclePort 的 onRunEnd + onInterrupted 两处都触发（或 run-react-loop 退出分流统一调，架构期定） | 各种退出（正常/出错/等审批/interrupted）全覆盖不漏 |
| D7 | **块2 = 统一全员状态块 `[squad:agents]`**：把 reachable agents（可达性）和 team-status（运行状态）**两个 provider 合并成一个**——「agent 列表 + 每个的 run 状态 + presence」，三合一（可达性 + running/idle + currentWork） | 老板 08-07 二次拍板「统一设计」：两个块都列成员 = 信息冗余且都不完整（reachable 无状态、team-status 缺非 running）；统一块消除冗余 + 全员可见 + 不符合预期立刻发现 |
| D8 | **统一块方向 = 方向 C（新建统一 provider 取代两个）**：基于 squadContext（listMembers + isSessionRunning + getSquad 拿 squadChatSessionId/enableGroupChat）+ subagent 分支读 agentToolContext.parent；删 reachable_agents + squad_team_status 两个旧 provider | 三方向评估：A（reachable 加状态列）= isSessionRunning 不在 studioContext（async 注入改造大）+ 块名仍是可达性语义不满足「统一」；B（team_status 吸收可达性）= leader-only 而 mate 仍需 reachable 对端 → 两 provider 并存不完全统一；C 最符合老板意图（一个块一个 provider，leader/mate/squad 视角统一，subagent 保持 [parent]） |

## 3. 功能需求

### 3.1 块1：mate run 退出通知 leader hook

#### 3.1.1 触发条件（D1）
- `kind.role === 'mate'` 且 `derivation === 'parent'`（顶级 mate session）。
- 触发时机 = run 在**统一退出口**退出，**全部 stopReason**：`no_tool_call / no_new_messages / max_iterations / doom_loop / error / tool_pending / interrupted`。
- 频率：**每次 run 退出都发**（per_run，不按任务收敛）。

#### 3.1.2 通知动作（D3）
- 走 send_message 链路给 squad leader 发一条通知（系统级 deliverTo，非让 mate 调工具）。
- 消息天然带发送者 = 该 mate（a2a 信封 sender.source='agent' + sender.ref = mate AgentRef）；leader inbox 收到「来自该 mate 的通知」。
- needReply=false（fyi 通知，不要求 leader 回复）。

#### 3.1.3 通知内容（D4/D5，markdown）
```
【mate 退出通知】{mate名}（{role}）run 已退出
- 退出原因：{stopReason}
- 耗时：{X}s（{run 开始→结束}）
- 最后一条消息（content block 序列）：
  - [{block 类型 1}] {原文 / 前后各 500 截断}
  - [{block 类型 2}] {原文 / 前后各 500 截断}
  ...
- 待审批工具调用：{pendingToolCalls 摘要，仅 tool_pending 时有}
```
- block 类型范围：text（answer）/ tool_call / tool_result / tool_reply / image；**不含 reasoning（thinking）/ usage**。
- 每个 block：类型 + 原文 / 前后各 500 字符截断（中间 `...（省略 N 字符）...`）。
- 耗时 = run 开始时间戳 → 退出时间戳（run-lifecycle 构造时记开始，退出时算 diff；架构期确认时间戳来源）。
- pendingToolCalls：tool_pending 退出时从 session store 读 `session.pendingToolCalls`（PendingToolCall[] 摘要：工具名 + 参数要点）。

#### 3.1.4 边界（D1）
- **只 mate 触发**：leader 自己 run 退出不通知、子 agent（subagent）run 退出不通知、非 squad session（playground rocky / academy）不通知。
- 旁路 run（summary/consolidate，persistsRun=false）不触发（不是「mate run 退出」语义，是内部整理 run）。

### 3.2 块2：统一全员状态块 `[squad:agents]`（取代 reachable_agents + squad_team_status）

#### 3.2.1 现状问题（老板 08-07 二次拍板）
- **reachable agents 块**（`reachable_agents.ts`，186 行）：列全部可达对端（leader 视图 = SquadChat + 全部 mate），格式 `- {name} ({type}, sessionId: {sid})`——**有可达性无状态**。
- **team-status 块**（`squad_team_status.ts`，95 行）：leader-only，L66 `if (!running) continue` 只列 running 成员——**有状态缺非 running**。
- **两个块割裂**：都列成员（信息冗余）+ 都不完整（reachable 无状态、team-status 缺非 running 成员）。

#### 3.2.2 目标：统一成一个块（D7/D8）
```
[squad:agents] 团队成员：
- SquadChat (squad, sessionId) · 群聊
- prd (mate, sessionId) · running · presence: 273 PRD 设计
- coder2 (mate, sessionId) · running · presence: 272 set-e 修复
- coder (mate, sessionId) · idle · (无 presence)
- architect (mate, sessionId) · idle · (无 presence)  ← 一眼看出空闲/疑似卡住
- ...
```
- **三合一**：可达性（name + sessionId，send_message 对端）+ run 状态（running/idle）+ presence 标记（currentWork）。
- **全员列出**（不按 running 过滤）：做完空闲、出错、卡住全部可见。
- **符合预期立刻发现**：有 presence 但没 running = 疑似卡住；running 但没 presence = 在跑没标记。

#### 3.2.3 方向评估（架构选型，PRD 推荐 C）
| 方向 | 做法 | 评估 |
|------|------|------|
| A | 改 reachable_agents.ts 加状态列 | isSessionRunning 不在 studioContext（config 注入无动态状态，需改 async + 注入改造大）；块名仍是 [Reachable agents] 可达性语义，不满足「统一成一个块」意图 |
| B | 改 squad_team_status.ts 吸收可达性 | team_status 是 leader-only，mate 的 send_message 对端仍需 reachable → 两个 provider 并存，leader 看统一块 + mate 看旧 reachable，不完全统一 |
| C（**推荐**） | **新建统一 provider 取代两个**（如 `squad_agents_status`） | 一个块一个 provider，leader/mate/squad 视角统一；subagent 保持 [parent]；完全符合老板「统一成一个块」 |

#### 3.2.4 统一 provider 设计（方向 C）
- **数据源**（全在 squadContext，复用现有）：
  - `squadContext.listMembers(squadId)` → MemberEntity[]（含 name/role/sessionId/currentWork）。
  - `squadContext.isSessionRunning(sessionId)` → session.state==='running'（bootstrap 注入口径不变）。
  - `squadContext.getSquad(squadId)` → squad 实体（squadChatSessionId + enableGroupChat 门控，v0.0.270 语义保留）。
  - subagent 分支：`config.agentToolContext.parent`（AgentRef，reachable_agents.ts deriveSubagent 逻辑迁移）。
- **产出规则（按 sessionType 分派）**：
  - **leader** → SquadChat（enableGroupChat 门控）+ 全部 mate（不含 leader 自己），每个带 running/idle + presence。
  - **mate** → SquadChat（门控）+ leader + peers（不含自己），同样带状态——mate 也能看队友在干嘛（避免重复干活）。
  - **squad**（群聊路由器）→ leader + 全部 mate（不含 SquadChat，自身即群聊）。
  - **subagent** → [parent]（拓扑硬约束，保持 reachable 语义）。
  - **standalone** → []（无 a2a 对端）。
- **状态两态**：`running`（session.state==='running'）/ `idle`（其余）。
- **presence 标记**：member.currentWork.text（有则 `presence: {text}`，无则 `(无 presence)`）。
- **benched 成员**：保持 reachable 语义不列（不可达、无 run、presence 无意义）；如老板要列可标 `(benched)`——边界项留架构/老板裁决。
- **空 squad / 无成员** → 降级文案（「当前无成员」）。
- **卡住可见性**：mate 有 currentWork 但非 running → 显示 `idle · presence: {text}`——leader 一眼看出「标了活但没在跑」= 疑似卡住；不自动判定。

## 4. 关键用户路径

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | mate 正常做完（no_tool_call）→ leader 查 inbox | leader 收到该 mate 的通知：退出原因 no_tool_call + 最后消息 block 摘要（text/tool_call 等，不含 thinking）+ 耗时 |
| UC-2 | mate 出错（error）→ leader 查 inbox | leader 收到通知：退出原因 error + 最后消息摘要（含出错前最后动作） |
| UC-3 | mate 等审批（tool_pending HITL 悬挂）→ leader 查 inbox | leader 收到通知：退出原因 tool_pending + 待审批工具摘要（什么工具/参数/在干什么）——知道「卡在等审批」 |
| UC-4 | mate 被中断（interrupted）→ leader 查 inbox | leader 收到通知：退出原因 interrupted |
| UC-5 | leader 自己 run 退出 | 无通知（边界：leader 不触发） |
| UC-6 | 子 agent（subagent）run 退出 | 无通知（边界：subagent 不触发，derivation 排除） |
| UC-7 | 非 squad session（playground rocky / academy）run 退出 | 无通知（边界：非 mate 不触发） |
| UC-8 | leader 看 system_reminder | 收到**统一块 `[squad:agents]`**：SquadChat（门控）+ 全部 mate 带 running/idle + presence（不再有两个割裂块，不再有成员消失） |
| UC-9 | mate 做完空闲（presence 已 clear）→ leader 看统一块 | 该 mate 显示 `idle · (无 presence)`（不再从块里消失） |
| UC-10 | mate 工作中（presence set + session running）→ leader 看统一块 | 该 mate 显示 `running · presence: {text}` |
| UC-11 | mate 标了 presence 但没在跑（疑似卡住）→ leader 看统一块 | 该 mate 显示 `idle · presence: {text}`——leader 一眼看出「标了活但没在跑」 |
| UC-12 | mate 自己看 system_reminder | mate 也收到统一块（SquadChat + leader + peers 带状态），可看队友在干嘛、知道 send_message 对端 |
| UC-13 | subagent 看 system_reminder | 保持 `[Reachable agents]` 语义收缩为 [parent]（拓扑硬约束） |

## 5. 概念对齐

- **RunLifecyclePort**（`app/server/src/agent/run-lifecycle-port.ts`，133 行）：profile 驱动三 hook（onRunEnd/onUsage/onInterrupted）——**块1 hook 挂点**（onRunEnd + onInterrupted 都触发，或 run-react-loop 退出分流统一调，架构期定）。
- **run-react-loop.ts**（340 行）：runReActLoop 统一退出分流（L266-291，interrupted/正常两分支）——「run 统一退出口」概念权威。
- **StopReason**（`agent-event-types.ts` L43）：7 枚举 `no_tool_call / no_new_messages / max_iterations / doom_loop / error / tool_pending / interrupted`——通知覆盖全部。
- **SessionKind / SessionContext**（`shared/src/types/session-kind.ts`）：`kind.role`（mate 识别）+ `kind.derivation`（subagent 排除）+ `sessionContext.squadId`。
- **send_message 工具**（`agent/tools/send-message-tool.ts`）：a2a 投递语义（deliverTo + sender.source='agent'）——块1 系统级投递仿照。
- **squad_team_status provider**（`app/plugins/builtins/rocky_context/reminder/squad_team_status.ts`，95 行）：leader-only team-status 段——**块2 合并对象之一**（L66 running 过滤逻辑随统一 provider 迁移）。
- **reachable_agents provider**（`app/plugins/builtins/rocky_context/prompt/reachable_agents.ts`，186 行）：按 sessionType 派生可达对端（leader 视图 = SquadChat + mates；subagent → [parent]）——**块2 合并对象之二**（derive 分派 + 270 enableGroupChat 门控 + benched 过滤逻辑随统一 provider 迁移；formatReachable L183-186 格式更新）。
- **presence 工具**（`agent/tools/presence-tool.ts`，89 行）：member.currentWork 写入口——块2 presence 标记来源。
- **MemberEntity**（`schema_defs/squad/member.ts`）：name/role/currentWork 字段（listMembers 返回，team-status 数据源）。
- **spec 权威源**：`specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md` §3.2（LifecyclePort）+ `specs/tech/squad/[P1]squad_reminder_providers.md` §4.6（squad_team_status provider）+ `specs/tech/squad/[P1]data_model.md` §1.2b（currentWork 形状）。

## 6. 边界 / 不做

- **不做** leader 代判审批 / 转达老板（v0.0.27X 后续版本；273 只做「通知」）。
- **不做** 通知降噪 / 收敛（per_run 每次发，老板拍板，降噪观察后再调）。
- **不做** 「卡住」自动判定（只展示 idle + presence，判定交 leader 判断）。
- **不做** team-status 状态细化（只 running/idle 两态，不展示 error/suspended 细分——如需细分后续版本）。
- **不做** 通知内容带 runId/迭代轮数/完整原文（minimal，老板拍板）。
- **不碰** 旁路 run（summary/consolidate）通知（内部整理 run 不是 mate run 退出）。
- **不碰** SquadChat 群聊通知（只私聊 leader，与 send_message 目标一致）。
- **不做** benched 成员列入统一块（保持 reachable 语义不列；如需列出标 benched，边界项留架构/老板裁决）。
- **不做** 统一块状态细分（error/suspended 不单列，只 running/idle；细分后续版本）。

## 7. 验收口径

1. **能力不变量**：
   - mate run 任意 stopReason 退出 → leader 收到该 mate 的 send_message 通知（含 stopReason + 最后消息 block 摘要 + 耗时 + tool_pending 时 pendingToolCalls）（UC-1~4）。
   - 统一块 `[squad:agents]` 列出全部 member（running/idle + presence），无成员从块里消失；reachable_agents + squad_team_status 两个旧块不再独立产出（UC-8~13）。
2. **边界不变量**：
   - leader 自己 / 子 agent / 非 squad session run 退出 → 零通知（UC-5~7）。
   - 通知不含 thinking（reasoning）/ usage block。
3. **回归不变量**：
   - run 正常生命周期（persistRun / CAS / emitRunEnd / replySettle）零变更——块1 hook 是追加，不改现有退出链。
   - 统一块的 running 成员展示与旧 team-status 一致（仅新增非 running 成员行 + 可达性字段）。
   - 270 enableGroupChat 门控保留（统一块 SquadChat 行随门控显隐）。
   - subagent 可达性语义保持（[parent] 收缩）。
   - send_message / presence 工具功能不变。
4. **UT 必须**：
   - 块1：mate 识别过滤（mate+parent 触发 / leader / subagent / rocky 不触发）；通知内容构造（block 类型过滤不含 reasoning/usage + 500 截断）；stopReason 全覆盖。
   - 块2：统一 provider 产出（leader/mate/squad 分派 + subagent [parent] + benched 过滤 + enableGroupChat 门控）；全员列出（running + idle + presence 有无）；旧 provider 删除后无残留引用。
5. **AT/ET**：本版本是 agent run 生命周期 + reminder 注入改动，涉及 send_message 链路——按测试标准跑相关已有 case（send_message AT / reminder provider 相关）；是否新增 case 由 orchestrator 按「核心冒烟集」纪律裁决（本版本不引入新 LLM 不确定性场景，倾向回归为主）。

## 8. spec 对齐备忘

- `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md`：§3.2 LifecyclePort → 补「mate run 退出通知 leader hook」旁路（onRunEnd/onInterrupted 追加，不改现有链）。
- `specs/tech/squad/[P1]squad_reminder_providers.md`：§4.6 squad_team_status + reachable_agents → **合并为统一全员状态块 `[squad:agents]`**（新 provider 取代两个；derive 分派 + enableGroupChat 门控 + benched 过滤迁移）。
- `specs/tech/squad/[P1]data_model.md`：§1.2b currentWork 形状不变（presence 已有）。
- `specs/tech/multi_agent/[P1]a2a_protocol.md`：§2/§3 reachable_agents 派生表 → 统一块仍承载可达性（name + sessionId），语义不变但块名/格式更新。
- 设计点（架构期定）：run 统一出口的确切钩子位置（RunLifecyclePort vs run-react-loop 分流）、content block 截断实现（工具函数）、send_message 从 run 上下文发起的方式（deliverTo 注入复用 replySettle 模式）、耗时时间戳来源、统一 provider 的 squadContext 注入（isSessionRunning async）+ 非 running 状态来源（session.state 读取）。

## 9. 版本总结

- **问题**：mate run 退出（正常/出错/等审批）leader 无感知；reachable agents（有可达性无状态）和 team-status（只列 running）两个块割裂——信息冗余且都不完整。
- **方案**：块1 = mate run 统一退出口挂 hook，全部 stopReason 每次退出都走 send_message 私聊通知 leader（stopReason + 最后消息 block 摘要前后 500 截断 + 耗时 + pendingToolCalls）；块2 = **统一全员状态块 `[squad:agents]`**（新建 provider 取代 reachable_agents + squad_team_status）：agent 列表 + running/idle + presence 三合一，leader/mate/squad 视角统一，subagent 保持 [parent]。
- **关键用户路径**：mate 正常做完 / 出错 / 等审批 / 被中断 → leader 收到通知；leader 自己 / 子 agent / 非 squad 不通知；统一块全员可见（running + idle + presence，卡住可见），可达性与状态不再割裂。
