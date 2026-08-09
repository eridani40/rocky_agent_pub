# v0.0.273 tech change log — mate 退出通知 hook + 统一全员状态块

> 对应需求：`reqs/[working] v0.0.273/req.md`（老板 2026-08-07 讨论记录：mate run 退出通知 leader hook + 统一状态块设计）。
> 权威契约：`specs/tech/version_logs/v0.0.273/change_plan.md`（8 架构裁决 R1-R8，frozen）。

## 变更摘要

### 需求与动机

**块1（mate 退出通知）**：squad mate 的 run 退出时 leader 无感知——正常做完（no_tool_call）、出错（error/doom_loop/max_iterations）、等审批（tool_pending HITL 悬挂）leader 都不知道（实证：v0.0.271 architect 正常退出，leader 以为它还在做）。需求：mate run 退出时给 squad leader 发一条来自该 agent 的私聊通知（stopReason + 最后消息摘要 + 耗时 + 等审批上下文）。

**块2（统一状态块）**：老板 2026-08-07 拍板「统一设计」——旧 `reachable_agents`（只有可达性无状态）+ `squad_team_status`（只列 running，leader-only）两个 provider 合并为一个统一全员状态块 `[squad:agents]`：agent 列表（可达性）+ running/idle 状态 + presence 标记三合一，全员可见；**全员列出（idle 不消失）**——presence 有但 run 不在跑 = 疑似卡住可见（老板核心诉求）。

### 方案（8 架构裁决，详见 change_plan「架构期裁决」）

1. **R1 块1 hook 挂载点 = RunLifecyclePort**：`onRunEnd`（6 种正常 stopReason：no_tool_call/no_new_messages/max_iterations/doom_loop/error/tool_pending）+ `onInterrupted`（固定 `interrupted`）双触发，通知在主链（persistRun/CAS/replySettle）之后。
2. **R2 触发过滤 = build-run-deps 装配条件**：`isMain && kind.role==='mate' && kind.derivation==='parent' && opts.deliverToFn && opts.config.sessionContext?.squadId` → 注入 `mateExitNotify: { squadId }`；leader（role≠mate）/ subagent（derivation≠parent）/ 非 squad（无 squadId）/ 旁路 run（非 isMain）全部不装配 → 零通知。
3. **R3 leader sessionId 两跳解析**：`squadStore.getSquad(squadId).leaderId` → `memberStore.getMember(squadId, leaderId).sessionId`（squad entity 无 leaderSessionId 字段；仿 resolveSquadAlias 'leader'）。
4. **R4 通知内容**：`state.lastAssistantContent` block 摘要（type ∈ {text, tool_call, tool_result, tool_reply, image}，排除 reasoning/usage；每块前后各 500 截断）+ 耗时（RunLifecyclePort 构造记 startedAt → 退出 diff）+ tool_pending 时读 `Session.pendingToolCalls` 摘要。
5. **R5 投递形态**：Message 仿 send-message-tool 信封（`sender.source='agent'` + `selfAgentRef` + `needReply:false`）→ `deliverTo(leaderSid, msg)`；失败双层 try/catch 仅 warn 不阻断主链。
6. **R6 块2 形态 = 新建 `squad_agents_status` provider** 取代 `reachable_agents` + `squad_team_status`（plugin.json 删二加一 + 删旧文件/测试）。
7. **R7 产出规则（readSessionType 分派）**：squad → leader+全部 mate（不含 SquadChat 自身）；leader → SquadChat（270 门控）+ 全部 mate（不含自己）；mate → SquadChat（门控）+ leader + peers（不含自己）；subagent → [parent]；standalone → []。
8. **R8 格式**：成员行 `- {name} ({role}, sessionId: {sid}) · {running|idle} · presence: {text|(无 presence)}`；SquadChat 行 `- SquadChat (squad, sessionId) · 群聊`；空 squad → 「当前无成员」；块名 `[squad:agents]`。

### T1 — mate 退出通知 hook（commit 0a12c0eb0）

- **`mate-exit-notify.ts` NEW（171 行）**：`truncateText`（前后各 500 截断 + 省略标记）+ `NOTIFY_BLOCK_TYPES`（text/tool_call/tool_result/tool_reply/image 5 类，不含 reasoning/usage）+ `formatMateExitNotify`（markdown：stopReason + 耗时 + block 过滤 + tool_pending pendingToolCalls 摘要）+ `notifyMateExit`（两跳解析 leader → Message `sender.source='agent'` + `selfAgentRef` + `needReply:false` → deliverTo；双层 try/catch 仅 warn 不阻断主链）。
- **`run-lifecycle-port.ts`**（+46 行）：deps 加 `mateExitNotify?: { squadId }`（缺省 noop）+ `startedAt`（L47 构造即记）；`onRunEnd` L100-103 触发（6 种正常 stopReason）+ `onInterrupted` L127-130 触发（固定 interrupted）——7 种 stopReason 全覆盖，均在主链之后。
- **`build-run-deps.ts`** L171-174：装配条件 `isMain && kind.role==='mate' && kind.derivation==='parent' && opts.deliverToFn && opts.config.sessionContext?.squadId` → 注入 `{ squadId }`；否则 undefined。
- **测试**：`mate-exit-notify.test.ts`（240 行）+ `run-lifecycle-port.test.ts`（+90 行）——装配条件 5 用例（1 正 4 负：leader/subagent/非 squad/旁路零通知）。

### T2 — 统一全员状态块（commit f0bb33b2f）

- **`squad_agents_status.ts` NEW（223 行）**：`SquadAgentsStatusReminderProvider`（extends ContextImplBase，id='squad_agents_status' tier='info'）。readSessionType 5 种分派（R7）；**全员列出（核心修复）**：L111-116 逐 member 查 running 但不过滤（旧 `squad_team_status` L66 `if (!running) continue` 已删，running+idle 都保留）；benched 过滤（L151 `state !== 'benched'`）；270 门控（L93-94 `enableGroupChat !== false` → SquadChat 行随门控显隐）；空 squad 降级（连 SquadChat 行也不发 → 「当前无成员」）；formatMember L211-218 成员行格式（R8）。
- **删除 3 文件**：`prompt/reachable_agents.ts`（186 行）/ `reminder/squad_team_status.ts`（95 行）/ `__tests__/squad-team-status-provider.test.ts`（203 行）。
- **plugin.json 删二加一**：`system_reminder` EP 8 个（env/time/workspace/tool_error/todo/squad_agents_status/squad_workspace/squad_task）；旧 `reachable_agents` + `squad_team_status` 条目删除。
- **scope yaml ×5 impls 替换**（偏离①）：`reachable_agents` → `squad_agents_status`（academy-coach / academy-head_teacher / default / playground-rocky parent+subagent）。
- **i18n 键替换**（偏离②）：删 2 加 1（reachable_agents + squad_team_status 描述 → squad_agents_status），zh/en 对齐。
- **inventory 断言 9→8**（偏离③）：删 2 加 1 后 reminder impl 总数 9→8（41→40 / 29→28），assemble-pipeline + plugin-chain 断言同步。
- **scope-extends-chain Q3 例外**（偏离④）：`id.startsWith('squad_') && id !== 'squad_agents_status'`——squad_agents_status 是 reachable_agents 继承者（a2a 通用对端 provider），playground subagent 需 [parent] 可达性。
- **数据源迁移**：旧 `reachable_agents` 的 `config.studioContext`（静态注入）→ `ctx.squadContext`（动态查询，bootstrap `setSquadReminderDeps` 注入 leader/mate/squad；subagent 不注入走 `agentToolContext.parent`）。
- **测试**：`squad-agents-status-provider.test.ts` NEW（384 行，19 用例全真实：分派 7 + 全员列出/状态/presence 4 + benched/门控/降级 8）。

### 代码↔spec 核实（doc-modifier 阶段 5，MANDATORY 4 项）

| 契约点 | 代码 | 结果 |
|---|---|---|
| 双 hook 7 stopReason 全覆盖（onRunEnd 6 + onInterrupted 1） | run-lifecycle-port.ts onRunEnd L100-103 + onInterrupted L127-130 | ✅ |
| 装配条件 leader/subagent/非 squad/旁路零通知 | build-run-deps.ts L171-174（isMain+mate+parent+deliverToFn+squadId） | ✅ |
| 统一块全员列出（旧 squad_team_status L66 if(!running)continue 已删，idle 不消失） | squad_agents_status.ts L111-116（逐 member 查 running 不过滤） | ✅ |
| spec 旧 provider（reachable_agents/squad_team_status）描述清理无残留 | 全 specs 当前态 grep：仅「取代/曾名/历史注记」语境保留 | ✅ |

### 设计决策

- **块1 通知所有 stopReason（含正常收尾）**：正常退出 leader 也需知道（否则误以为还在工作）——老板拍板。
- **tool_pending 必须通知**：算「需关注」状态，mate 卡这等审批时 leader 要知道；通知带审批上下文（pendingToolCalls 摘要）。**leader 代判审批 / 转达老板是后续需求（v0.0.27X），273 只做通知**。
- **通知不阻断主链**：双层 try/catch 仅 warn——mate 退出通知失败绝不影响 run 主链（persistRun/CAS/emit）。
- **块2 全员列出而非 running-only**：presence 有但 run 不在跑 = 疑似卡住可见（老板核心诉求）；做完的 mate 不消失。
- **三合一取代双 provider**：可达性（name+sessionId）+ running/idle + presence 一个块搞定，少一个 provider 少一份注入噪声。
- **270 门控保留**：`enableGroupChat !== false`（undefined=旧 record=开）→ SquadChat 行随门控显隐；`resolveSquadAlias 'squadchat'` 关态返 null 语义不变。
- **数据源迁移 squadContext**：动态查询（listMembers + isSessionRunning + getSquad），比静态注入 studioContext 更实时（presence/running 变化即时可见）。

### 偏离记录

- **T2 偏离 ①-⑤（全必要合理，code-review PASSED）**：
  - ① scope yaml ×5 impls 替换：plugin.json 删旧 implId 后 scope yaml 仍引用旧 id → ScopeConfigValidator 报错，reachable_agents→squad_agents_status 是必然接线。
  - ② i18n 键替换：删 2 加 1（描述键），zh/en 对齐。
  - ③ inventory 断言 9→8：删 2 加 1 后 reminder impl 总数变化，断言同步是预期行为变更。
  - ④ scope-extends-chain Q3 例外：squad_agents_status 是 reachable_agents 继承者（a2a 通用对端 provider，非 squad 专有），playground subagent 需 [parent] 可达性 → 例外 `id.startsWith('squad_') && id !== 'squad_agents_status'`。
  - ⑤ 空 squad 降级：无可见成员时连 SquadChat 行也不发（显式「当前无成员」），比旧实现更优。
- **T1 C1（commit 边界重切）**：首版 commit a40f245af 误删 3 个 T2 coversFiles（reachable_agents.ts / squad_team_status.ts / squad-team-status-provider.test.ts）且未改 plugin.json → 单独 checkout 构建挂。修复：删除动作归 T2 commit，T1 commit 0a12c0eb0 只含 5 coversFiles + states（越界删除撤出）。
- **T1 C2（mock bun 兼容修复）**：新测试「相对路径 + async factory + importOriginal」vi.mock 在 bun --bun（团队标准命令）下 11 failed（mock 不生效，`mockClear is not a function`）；node runtime 下全绿。修复：改 `require('path').resolve(__dirname, ...)` 绝对路径 + 同步 factory（bun --bun 下相对路径字面量不生效）→ 标准命令全绿。

## 文档同步

- **tech OKF KB**：`specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md` §3.2（RunLifecyclePort 双 hook + mateExitNotify 装配段 + §4 中断/正常退出）+ `specs/tech/squad/[P1]squad_reminder_providers.md`（§3 squad_team_status → squad_agents_status 统一块 + §0/§1/§4/§5/§6/§8）+ `specs/tech/squad/[P1]prompt_sections.md`（§1/§4/§5/§6/§9/§10）+ `specs/tech/multi_agent/[P1]a2a_protocol.md`（§3 派生表 + 板块格式 + §2.3/§6/§7/§8 引用）。
- **关联当前态 spec 修正（旧 provider 名清理）**：`specs/ui/components/studio-page/component-group-chat-toggle.md` / `specs/ui/overall/06-studio.md` / `specs/tech/multi_agent/[P1]subagent_derivation.md` / `specs/tech/multi_agent/index.md` / `specs/tech/squad/index.md` / `specs/tech/squad/[P1]agent_leader.md` / `agent_member.md` / `agent_squad_chat.md` / `data_model.md` / `panorama_builtin.md` / `session_config_studio.md` / `squad_tools.md` / `specs/tech/agent/context/[P0]system_reminder.md` / `[P0]extension point and implementations.md` / `specs/tech/agent/context/index.md` + squad/multi_agent/agent/context 四个 KB 的 log.md（本条目）。
- **research/ 与 version_logs/ 历史文档不更新**（历史快照，保留当时现状描述）。
