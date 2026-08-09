# v0.0.270 tech change log — 群聊开关 enableGroupChat

> 对应需求：`reqs/[working] v0.0.270/req.md`（用户可感知的行为改动 → 走完整 PRD）。
> PRD：`specs/prd/version_logs/v0.0.270.group_chat_switch/prd.md`。
> 权威契约：`specs/tech/version_logs/v0.0.270/change_plan.md`（method 级 18 行表，frozen）。

## 变更摘要

### 需求与动机

squad 群聊（SquadChat）对**所有 squad 恒开**：agents 恒注入 SquadChat、UI 入口恒可见。需求：给 squad 一个「群聊可见性」开关（enableGroupChat）——关掉后 agents 不再注入 SquadChat + UI 群聊入口隐藏 + `send_message('squadchat')` 报错（成员仅私聊）；**squad 实体/session 恒存在，仅控可见性**，重开即时恢复。

### 方案（5 架构裁决，详见 change_plan「架构期裁决」）

1. **schema `required:false` + 读取 `?? true` 兜底**（决策①）：存量 squad 无字段 = 开；建队显式写 `true`；无 migration。
2. **注入门控单点 = reachable_agents `deriveSquadScoped()`**（决策②）：`squadChatRef = squadChatSid && squad.enableGroupChat !== false ? {...} : null`（用 `!== false` 而非 `=== true`——undefined 视为开）；同一 provider 供 system prompt + system_reminder 两头。
3. **协作规则（群聊）段无条件删除**（决策③）：leader.md/mate.md 直接删「## 协作规则（在群聊里讲话）」段 + 清理「群聊 @」广播指引改 send_message 直连口径；**squad_role.ts map() 逻辑不动**（handlers 纯 readContent() 文件读取）；保留 user 沟通类表述。
4. **send_message 门控 = resolveSquadAlias 'squadchat' 分支**（决策④）：`=== false` 返 null（不静默投递）；'leader'/member name 私聊不受影响。
5. **T1（server 注入）/ T2（web UI）文件级零重叠可并行**（决策⑤）；T3 spec 同步依赖两者。

### T1 — server 注入门控（commit def4a76d5 + 集成修复 9cae6941e）

- **schema `squad.ts:82`**：`enableGroupChat: { type: 'boolean', required: false }`。
- **建队 `squad-service.ts:214`**：`enableGroupChat: true`（显式默认开，与相邻 `enableHeartBeat: false` 方向相反）。
- **handlers/squad.ts**：PatchSquadBody `enableGroupChat?: boolean`（L111）+ SquadSummary `: boolean`（L128）+ SquadDetail `: boolean`（L148）；toSummary `?? true`（L168）+ toDetail `?? true`（L263）；PATCH `if (body.enableGroupChat !== undefined) patch.enableGroupChat = body.enableGroupChat`（L411）。
- **reachable_agents.ts:93-106**：duck-type + `squadChatRef = squadChatSid && squad.enableGroupChat !== false ? {...} : null`（一处管 system prompt + system_reminder 两头）。
- **runtime-context.ts:275-286**：resolveSquadAlias 'squadchat' 分支 `=== false` 返 null；**resolveAgentRefWithSquad fallback 拦截**（coder3 偏离 ①）：squad 分支 resolveSquadAlias 返 null 且 ref==='squadchat' 时直接返 null（不 fallback 直传 'squadchat' 字串 → 否则 send_message 报「session not found」而非契约「cannot resolve target」）；'leader'/member name 保持原 fallback。
- **prompts 协作规则段删除**：leader.md/mate.md 直接删段 + 群聊广播指引改 send_message 直连（保留 user 沟通类 L7/L11/L49）。

### T2 — web UI 群聊开关 + 入口隐藏（commit 382f413ad）

- **`component-group-chat-toggle.tsx` NEW（88 行）**：props `{ squadId, enableGroupChat, onPatch }`；无本地态切换（PATCH 成功后父级 refresh 回灌）；pending 防 in-flight 双击；失败 error banner（toggle 视觉保持原态）；`data-action-key="studio.squad.toggle-group-chat"` + `role="switch"` + `aria-checked={on}` + disabled={pending}。
- **`component-autowork-tab.tsx` L12/L35**：GroupChatToggle 挂载（SquadAutonomyToggle 后独立块）。
- **`seats-body.tsx:74-81`**：`detail.enableGroupChat !== false` 才传 `onOpenGroupChat` / `onGroupChatContextMenu`（关时不传 → SeatCard 缺省隐藏群聊按钮 + 右键菜单，`component-seat-card.tsx:143` 已支持，零新增渲染分支）。
- **i18n**：`groupChat.*`（label/hint/on/off/toggleFail/errorPrefix）en + zh 同步。

### 代码↔spec 核实（doc-modifier 阶段 5）

| 契约点 | 代码 | 结果 |
|---|---|---|
| schema required:false | squad.ts:82 | ✅ |
| 建队默认 true | squad-service.ts:214 | ✅ |
| PatchSquadBody ?: boolean | handlers/squad.ts L111 | ✅ |
| SquadSummary/SquadDetail : boolean | handlers/squad.ts L128/L148 | ✅ |
| toSummary/toDetail ?? true | handlers/squad.ts L168/L263 | ✅ |
| PATCH !== undefined | handlers/squad.ts L411 | ✅ |
| reachable squadChatRef !== false | reachable_agents.ts L106 | ✅ |
| resolveSquadAlias === false 返 null | runtime-context.ts L275-286 | ✅ |
| fallback 拦截 'squadchat' | resolveAgentRefWithSquad | ✅（coder3 偏离 ① 合理） |
| 协作规则段删除 | leader.md/mate.md | ✅ |
| 保留 user 沟通类 | L7/L11/L49 | ✅ |
| web 三类型加字段 | squad-types.ts L106/L129/L158 | ✅ |
| seats-body 条件传参 | seats-body.tsx L74-81 | ✅ |
| toggle 组件 | component-group-chat-toggle.tsx | ✅ |

## 设计决策

- **`!== false` 而非 `=== true`**：undefined/缺省视为开——存量 squad 无字段不锁死；「显式关」是唯一关态。五处默认开语义一致防撕裂：toSummary/toDetail `?? true` / reachable `!== false` / runtime `=== false` 返 null / 建队 true / seats-body `!== false`。
- **注入门控单点**：只在 reachable_agents 构造处加条件（一处管 system prompt + system_reminder 两头），不在 prompt builder 双点改——避免遗漏。
- **协作规则段无条件删除而非两态切换**：老板最终裁决——开/关态都不注入协作规则段（纪律留团队 AGENTS.md），非「关才删、开保留」；squad_role.ts map() 逻辑不动（handlers 纯 readContent() 文件读取，删文件段即生效）。
- **runtime fallback 拦截（coder3 关键实现发现）**：resolveSquadAlias 关态返 null 后，resolveAgentRefWithSquad 的 fallback 会把 'squadchat' 字串直传 → send_message 报「session not found」而非契约「cannot resolve target」；补最小改动：squad 分支返 null 且 ref==='squadchat' 时直接返 null（不 fallback）；'leader'/member name 保持原 fallback。
- **UI 入口隐藏零分支**：SeatCard 已支持 prop 缺省隐藏（onOpenGroupChat?: () => void）——SeatsBody 条件传参即可；onGroupChatContextMenu 同步不传（右键复制 sessionId 入口一并隐藏）。
- **GroupChatToggle 无本地态**：仿 SquadAutonomyToggle 模式（data-action-key + role=switch + pending 防双击 + error banner）；无本地态切换（PATCH 成功后父级 refresh 回灌）——避免本地态与后端失步。

## 偏离记录

- **coder3 偏离 ①（runtime fallback 拦截）**：change_plan 只写「resolveSquadAlias 'squadchat' `=== false` 返 null」；coder3 发现 resolveAgentRefWithSquad 的 fallback 会把 null 后的 'squadchat' 字串直传（报「session not found」而非契约「cannot resolve target」），补最小改动直接返 null。已 code-review CONDITIONAL PASS + 集成 verify PASSED（6/6）+ ET 冒烟 pass。合理偏离，记录不修。

## 文档同步

- **tech OKF KB**：`specs/tech/squad/[P1]data_model.md §1.1`（Squad interface enableGroupChat + schema/兜底/门控语义）+ `specs/tech/squad/[P1]prompt_sections.md §3.1`（协作规则段无条件删除裁决）+ `specs/tech/multi_agent/[P1]a2a_protocol.md §3`（reachable_agents 门控 + 板块格式补开关语义）+ squad/multi_agent 两个 KB 的 index.md（概念行）+ log.md（本条目）。
- **api overall**：`specs/api/overall/11a-squad-endpoints.md` v1.11（SquadDetail + PatchSquadBody enableGroupChat + 回显 ?? true / PATCH !== undefined）。
- **ui overall**：`specs/ui/components/studio-page/component-group-chat-toggle.md`（新组件 spec）+ `component-autowork-tab.md`（五块 + group-chat-toggle 挂载）+ `component-seat-card.md`（群聊按钮缺省隐藏）+ `component-seats-body.md`（条件传参）+ `specs/ui/overall/06-studio.md` §3.3（五块 + 群聊开关块 + 组件清单）+ `specs/ui/overall/00-app-guide.md`（群聊开关入口）。
