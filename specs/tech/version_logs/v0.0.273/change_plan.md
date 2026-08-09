# v0.0.273 变更计划书 — mate run 退出通知 leader hook + 统一全员状态块 [squad:agents]

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **背景**：① mate run 退出（正常/出错/等审批/interrupted）leader 无感知 → 块1 = mate 顶级 run 统一退出口挂 hook，全 stopReason 每次退出走 send_message 系统级投递私聊 leader（stopReason + 最后消息 block 摘要前后 500 截断 + 耗时 + pendingToolCalls）；② reachable_agents（有可达性无状态）与 squad_team_status（只列 running）割裂 → 块2 = 统一全员状态块 `[squad:agents]`（agent 列表 + running/idle + presence 三合一）取代两个旧 provider。

## 架构裁决（PRD D1-D8 落实）

| # | 裁决点 | 结论 | 理由 |
|---|--------|------|------|
| R1 | **块1 hook 挂载点** | **RunLifecyclePort（onRunEnd + onInterrupted 两处都触发）**，装配仿 replySettle 在 build-run-deps 注入 | run-react-loop 退出分流 L266-301 已是「interrupted → onInterrupted / 正常 → onRunEnd」两分支，天然全覆盖 7 种 stopReason（onRunEnd 覆盖 no_tool_call/no_new_messages/max_iterations/doom_loop/error/tool_pending；onInterrupted 覆盖 interrupted）；RunLifecyclePort 是 profile 驱动业务旁路层（已有 replySettle 先例），run-react-loop 统一骨架**零改动**；装配点条件过滤（mate+parent+isMain）天然满足 D1 边界（leader/subagent/rocky 不注入不触发）+ 旁路 run（isMain=false）不装配不触发 |
| R2 | **触发过滤** | build-run-deps 装配条件 = `isMain && kind.role==='mate' && kind.derivation==='parent' && opts.deliverToFn && config.sessionContext?.squadId` → 注入 `mateExitNotify: { squadId }` 标记；RunLifecyclePort 内检查标记存在才触发 | 装配点决定「谁触发」，RunLifecyclePort 只做「标记存在就通知」——leader 自己（role≠mate）/ subagent（derivation≠parent）/ 非 squad（无 squadId）/ 旁路 run（非 isMain）全部不装配 → 零通知（UC-5/6/7） |
| R3 | **leaderSessionId 来源（修正 PRD 引用）** | squad entity **无 leaderSessionId 字段**（squad-service.ts L69 是 createSquadService 出参，非 getSquad 返回）→ 两跳：`squadStore.getSquad(squadId).leaderId`（leader member id）→ `memberStore.getMember(squadId, leaderId).sessionId`；句柄从 config.agentToolContext 读 rtc（bootstrap 已注入） | 仿 resolveSquadAlias 'leader' 解析（runtime-context.ts L313-315 既有模式）；rtc.squadStore/memberStore 在 mate 顶级 run 的 config.agentToolContext 恒有（bootstrap buildAgentToolContext 注入） |
| R4 | **通知内容来源** | 最后消息 = `state.lastAssistantContent`（LoopState 字段，最后 assistant 消息 content blocks）；block 过滤 `type ∈ {text, tool_call, tool_result, tool_reply, image}`（排除 reasoning/usage）；耗时 = RunLifecyclePort 构造记 `startedAt`（buildRunDeps 构造点）→ 退出时 `(Date.now()-startedAt)/1000` 秒；pendingToolCalls = tool_pending 时从 `store.getSession(sid).pendingToolCalls`（Session 字段，session-store-types L90） | PRD D4/D5 要素落位；lastAssistantContent 已含 tool_call（tool_pending 悬挂）与 error 前最后动作；不新增 API 读取 |
| R5 | **投递形态** | 构造 Message（仿 send-message-tool）：`sender.source='agent'` + `sender.agent.ref=selfAgentRef(rtc)`（self 身份 mate）+ `needReply:false` → `deliverTo(leaderSid, msg)`；try/catch 吞失败（warn 日志，不阻断主链） | a2a 信封 sender 天然带发送者=该 mate（enrichForInbox 反查正确）；needReply=false 是 fyi 通知不要求回复；通知失败不阻断 persistRun/CAS/abort 主链（仿 replySettle settle 的 try/catch 模式） |
| R6 | **块2 形态** | **新建 `squad_agents_status` provider（方向 C）取代 reachable_agents + squad_team_status**：plugin.json 删两个旧条目 + 加一个新条目；旧文件 + 旧测试删除/迁移；数据源 = squadContext（listMembers + isSessionRunning + getSquad），subagent 分支读 agentToolContext.parent（deriveSubagent 迁移） | PRD D7/D8 方向 C 拍板；squadContext 是 squad_team_status 已在用的动态数据源（含 isSessionRunning async），reachable 的 studioContext 静态花名册不满足「统一 + 动态状态」 |
| R7 | **块2 产出规则** | readSessionType 分派：leader → SquadChat（enableGroupChat 门控）+ 全部 mate（含状态）；mate → SquadChat（门控）+ leader + peers（不含自己）；squad → leader + 全部 mate（不含 SquadChat 自身即群聊）；subagent → [parent]（reachable 语义保持）；standalone → [] | 迁移 reachable_agents deriveSquadScoped 分派表 + 270 门控语义 + benched 过滤（state !== 'benched'）；mate 也能看队友状态（UC-12），卡住可见（idle + presence 不自动判定） |
| R8 | **格式** | 成员行 `- {name} ({role}, sessionId: {sid}) · {running\|idle} · presence: {text\|(无 presence)}`；SquadChat 行 `- SquadChat (squad, sessionId) · 群聊`；空 squad → 「当前无成员」 | 三合一（可达性 + 状态 + presence）一行呈现；块名 `[squad:agents]` 取代两个旧块名 |

## 变更清单

<!-- 每行一个函数/符号；相关方法的行放在一起（同模块/同文件相邻） -->

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| mate-exit-notify(块1) | app/server/src/agent/mate-exit-notify.ts | truncateText() | 新增 | 纯函数：文本前后各 500 字符截断，中间 `...（省略 N 字符）...`；长度 ≤ 1000 原样返回 | MUST 纯函数零副作用可 UT；MUST 返回含省略标记与省略字符数 | PRD D5 | +20 |
| mate-exit-notify(块1) | app/server/src/agent/mate-exit-notify.ts | formatMateExitNotify() | 新增 | 纯函数：构造 markdown（`【mate 退出通知】{name}（{role}）run 已退出` + 退出原因 + 耗时 + 最后消息 block 序列 + tool_pending 时 pendingToolCalls 摘要）；block 过滤 type ∈ {text, tool_call, tool_result, tool_reply, image}（**不含 reasoning/usage**），每块 truncateText | MUST 纯函数可 UT；MUST 过滤 reasoning/usage block；MUST block 类型范围封闭（7 类中取 5 类）；MUST 输出 minimal（不带 runId/迭代轮数） | PRD D4/D5；`message/types.ts` ContentBlock 联合 | +60 |
| mate-exit-notify(块1) | app/server/src/agent/mate-exit-notify.ts | notifyMateExit() | 新增 | 执行通知：readRuntimeContext(config) → 两跳解析 leaderSessionId（getSquad.leaderId → getMember.sessionId）→ 构造 Message（sender.source='agent' + selfAgentRef + needReply:false，content=[{type:'text',text:markdown}]）→ deliverTo(leaderSid, msg)；解析/投递失败 try/catch warn 不抛 | MUST 走 deliverTo 系统级投递（非让 mate 调工具）；MUST needReply=false；MUST 失败仅 warn 不阻断主链；MUST NOT 对 leader 自己/无 squadId 投递 | PRD D3；`send-message-tool.ts` 信封构造；`runtime-context.ts` selfAgentRef | +50 |
| mate-exit-notify(块1) | app/server/src/agent/run-lifecycle-port.ts | RunLifecyclePort 构造 | 修改 | deps 加 `mateExitNotify?: { squadId: string }`（buildRunDeps 装配）；构造时记 `startedAt = Date.now()` | MUST 缺省 undefined 全链路 noop（旧行为零变化）；MUST startedAt 构造即记（run 起点） | PRD D6；本 change_plan R1/R4 | +4 |
| mate-exit-notify(块1) | app/server/src/agent/run-lifecycle-port.ts | onRunEnd() | 修改 | persistRun/CAS/replySettle 之后追加：`if (mateExitNotify) await notifyMateExit(state, ...)`（stopReason=state.stopReason；tool_pending 时读 pendingToolCalls 摘要） | MUST 通知在 persistRun/CAS 之后（主链先行）；MUST 通知失败不阻断（try/catch）；MUST 旁路 run 不触发（mateExitNotify 不装配） | PRD D6；本 change_plan R1 | +8 |
| mate-exit-notify(块1) | app/server/src/agent/run-lifecycle-port.ts | onInterrupted() | 修改 | settle 之后追加：`if (mateExitNotify) await notifyMateExit(state, 'interrupted')`（stopReason 固定 interrupted） | MUST interrupted 也通知（UC-4）；MUST abort api 4 步收尾不受影响（通知在 settle 之后、主链已完成） | PRD D6；本 change_plan R1 | +5 |
| mate-exit-notify(块1) | app/server/src/agent/build-run-deps.ts | mateExitNotify 装配 | 修改 | 仿 replySettle：`isMain && kind.role==='mate' && kind.derivation==='parent' && opts.deliverToFn && opts.config.sessionContext?.squadId` → 注入 `{ squadId }`；否则 undefined | MUST 条件含 isMain（旁路不触发）+ role/deliverToFn/squadId；MUST 注入进 RunLifecyclePort deps | PRD D1；本 change_plan R2 | +8 |
| squad-agents-status(块2) | app/plugins/builtins/rocky_context/reminder/squad_agents_status.ts | SquadAgentsStatusReminderProvider | 新增 | 统一全员状态 provider：readSessionType 分派（leader/mate/squad/subagent/standalone）→ squadContext.listMembers + isSessionRunning + getSquad（enableGroupChat 门控）+ subagent 读 agentToolContext.parent → 产出 `[squad:agents]` 块（成员行 name/role/sessionId + running/idle + presence）；benched 过滤；空 squad 降级 | MUST 全员列出（不按 running 过滤）；MUST benched 过滤（state !== 'benched'）；MUST 270 enableGroupChat 门控保留（SquadChat 行随门控显隐）；MUST subagent → [parent]；MUST provide 为 async（isSessionRunning await）；MUST id='squad_agents_status' tier='info' | PRD D7/D8；`squad_team_status.ts` 数据源；`reachable_agents.ts` 分派表 | +120 |
| squad-agents-status(块2) | app/plugins/builtins/rocky_context/plugin.json | extImpls 条目 | 修改 | 删 `reachable_agents` + `squad_team_status` 两个 system_reminder 条目；加 `squad_agents_status` 条目（impl ./reminder/squad_agents_status.ts） | MUST 一次变更完成（删二加一）；MUST NOT 影响其他 provider 条目 | PRD D8；plugin.json 现状 | +4/-4 |
| squad-agents-status(块2) | app/plugins/builtins/rocky_context/prompt/reachable_agents.ts | （删除） | 删除 | 旧 provider 文件删除（deriveSubagent/deriveSquadScoped/formatReachable 逻辑随统一 provider 迁移） | MUST 删除前确认无残留引用（plugin.json 条目已删 + 测试迁移） | PRD D8 | -186 |
| squad-agents-status(块2) | app/plugins/builtins/rocky_context/reminder/squad_team_status.ts | （删除） | 删除 | 旧 provider 文件删除（L66 running 过滤逻辑随统一 provider 迁移为「全员列出」） | MUST 删除前确认无残留引用 | PRD D8 | -95 |
| test(块1) | app/server/src/agent/__tests__/mate-exit-notify.test.ts | truncateText/formatMateExitNotify 单测 | 新增 | 用例：truncateText（短文本原样/长文本前后 500+省略标记）；formatMateExitNotify（block 类型过滤不含 reasoning/usage；text/tool_call/tool_result/tool_reply/image 各类型渲染；7 种 stopReason 全覆盖；tool_pending 带 pending 摘要；不带 runId） | MUST 纯函数直测零 mock | PRD §7.4 | +90 |
| test(块1) | app/server/src/agent/__tests__/run-lifecycle-port.test.ts | mateExitNotify 单测 | 修改 | 用例：mate+parent 装配 → onRunEnd 触发 notify（stopReason 传递）；onInterrupted 触发 notify（interrupted）；mateExitNotify undefined → 零通知；leader/subagent/rocky 不装配（buildRunDeps 条件）；tool_pending 读 pendingToolCalls | MUST mock notifyMateExit 或 deliverTo；MUST 覆盖「mateExitNotify 缺省 noop」回归 | PRD §7.4 | +60 |
| test(块2) | app/plugins/builtins/rocky_context/reminder/__tests__/squad-agents-status-provider.test.ts | 统一 provider 单测 | 新增 | 用例：leader/mate/squad 分派（SquadChat 门控显隐 + 不含自己）；subagent → [parent]；standalone → []；全员列出（running + idle + presence 有无）；benched 过滤；空 squad 降级 | MUST mock squadContext（listMembers/isSessionRunning/getSquad）；MUST 覆盖 270 门控两种值 | PRD §7.4 | +110 |
| test(块2) | app/plugins/builtins/rocky_context/reminder/__tests__/squad-team-status-provider.test.ts + __tests__/prompt-studio.test.ts | 旧测试迁移 | 修改 | 旧 squad_team_status 测试删除（provider 已删）；prompt-studio 测试中 reachable_agents 引用改 squad_agents_status（或删除对应断言） | MUST 旧 provider 删除后无残留引用（grep 确认） | PRD §7.4 | -70/+20 |
| spec-sync(T3) | specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md | §3.2 LifecyclePort | 修改 | 补「mate run 退出通知 leader hook」旁路（onRunEnd/onInterrupted 追加，不改现有链） | MUST 与 change_plan 一致；MUST 说明旁路 run/leader/subagent 不触发 | 本 change_plan | +15 |
| spec-sync(T3) | specs/tech/squad/[P1]squad_reminder_providers.md + [P1]prompt_sections.md | §3 squad_team_status + reachable_agents 段 | 修改 | 合并为统一全员状态块 `[squad:agents]`（新 provider 取代两个；derive 分派 + enableGroupChat 门控 + benched 过滤迁移） | MUST 与统一 provider 实现一致；MUST 验证代码实现 == spec 契约 | PRD §8；本 change_plan | +25/-30 |
| spec-sync(T3) | specs/tech/multi_agent/[P1]a2a_protocol.md | §2/§3 reachable 派生表 | 修改 | 统一块仍承载可达性（name + sessionId），块名/格式更新 | MUST 可达性语义不变（a2a 对端信息不丢） | PRD §8 | +10/-5 |

## 影响面评估

- **跨模块**：server agent 层（mate-exit-notify + run-lifecycle-port + build-run-deps）+ rocky_context 插件层（squad_agents_status 新 provider + plugin.json + 删两个旧 provider）+ spec 文档（agent_loop_unified / squad_reminder_providers / prompt_sections / a2a_protocol）
- **破坏性变更**：**块2 有**——reachable_agents + squad_team_status 两个 reminder provider 被统一 provider 取代（reminder 块名/格式变化，影响 leader/mate 每轮 system_reminder 注入内容）；**块1 无破坏**（纯追加旁路，RunLifecyclePort 缺省 noop 零行为变化）
- **依赖顺序**：T1（块1）∥ T2（块2）可并行（server agent 层 vs 插件层，无共享文件）；T3（spec 同步）依赖两者
- **风险点**：
  1. **块1 通知漏发**（7 种 stopReason 覆盖）→ onRunEnd + onInterrupted 两处都触发 + build-run-deps 装配条件严格（isMain+mate+parent+deliverToFn+squadId）；UT 覆盖 7 种 stopReason
  2. **块1 通知阻断主链** → try/catch 吞失败（warn 日志）；通知在 persistRun/CAS 之后
  3. **块1 leader 解析失败**（getSquad 无 squadId / leaderId 无对应 member）→ notifyMateExit try/catch 降级 warn，不阻断 run 退出
  4. **块2 mate 对端可达性信息丢失** → 统一块仍输出 name + sessionId（a2a 对端信息不丢）；subagent [parent] 拓扑保持
  5. **块2 旧 provider 删除残留引用** → 删除前 grep 确认（plugin.json 条目 + 测试迁移）；旧测试文件同步删/改
  6. **块2 性能**（每轮 listMembers + 逐 member isSessionRunning async）→ 与旧 squad_team_status 同量级（member 数 = 团队规模，个位数）；dedup reducer 收敛（瞬时值型同旧）
  7. **块1 通知频率**（per_run 每次退出都发）→ 老板拍板（全但不漏，降噪后续再调）；通知消息极小（minimal + 500 截断）

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
