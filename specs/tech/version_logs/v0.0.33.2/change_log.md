# v0.0.33.2 技术变更日志 — 4 scope 对话打通（拆 403 / 共用 builder / `<EOS>` / a2a squad）

> 范围红线：studio 4 scope（squad/leader/mate/subagent）共用现有 `AgentLoop`（本体零改）+ `SystemPromptBuilder`（mapper/reducer 链）；差异只在 **prompt build（mapper 内分流）** + **工具集（schema 层裁剪 + scope 派生）** + **HTTP 入口（拆 studio 403）** + **a2a 校验（squad clique）** + **EOS 双保险**。
> 权威输入：PRD `specs/prd/version_logs/v0.0.33.2/change_log.md`（D1-D10 已锁）+ 调研 `specs/research/v0.0.33.2-dialogue-architecture.md`（§7 文件清单 + file:line）。命名：一律 **mate**（非 member）。
> 父版本：v0.0.33.1（CRUD/Studio/占位 403）；地基：v0.0.28（spawn/send_message/subagent）+ v0.0.31（a2a enrich + deliverTo 去 config）+ v0.0.22（SystemPromptBuilder 链）。

---

## 1. 核心设计：4 scope 共用单一 AgentLoop（loop 本体零改）

studio session 拆 403 后自然走 v0.0.31 已铺的 `deliverTo(sessionId) → AgentManager.activate → resolveConfigBySid → buildSessionConfigFromDeps → AgentLoop`。差异通过 4 个注入点消化（不破 loop 本体）：

| 注入点 | 文件 | 差异来源 |
|---|---|---|
| **config 字段** | `context-types.ts:70` SessionConfig 加 `sessionType/bizType/squadId/memberId/studioContext` | mapper 内分流读 |
| **prompt build** | `rocky_context/prompt/*.ts` 4 新 mapper + identity D9 修 | mapper 内 `if(sessionType!==X) return []` |
| **toolDefinitions** | `agent-loop-stage-llm.ts` 调 baseCallLLM 前过滤 | 按 sessionType 让 LLM 看不到无关工具 |
| **allowedTools** | `scope-allowed-tools.ts:38` 扩 sessionType 维度 | 执行层门控复用 engine.ts:46-73 |
| **EOS 双保险** | `stage-llm` 注入 `params.stop=['<EOS>']`（if squad）+ ingest 前 strip `<EOS>` | D8 落 LLM caller 层 + 入 transcript 前 |
| **a2a 校验** | `send-message-tool.ts:144` 加 squad clique 分支 | 拓扑校验按 selfType ∈ {squad,leader,mate} |

**三条不变量**（MUST NOT violate）：
1. **loop 本体零改**（`agent-loop.ts:133-230` 不动；stopReason='no_tool_call' → markIdle 不变，不新增 StopReason）。
2. **mapper 内分流（Option A）**——每新 section mapper 内部 `if(config.sessionType!==X) return []`；不碰 EP scope 激活表。
3. **deliverTo 不碰 config**（v0.0.31 不变量保留）。

---

## 2. PRD §2 11 条逐条实现设计

### 2.A 拆 403 + studio 接 loop（PRD A）

**改动**：`handlers/session-messages.ts:190-192` 删整段 `if (got.bizType === 'studio') return 403`。**保留** `:198-200` subagent 403（只读语义不变量）。拆后自然走 `:258 deliverTo(id, userMsg)`——零新增代码。bizType 隔离三处（字段 + GET 过滤 + UI 路由）独立保留，UC-12 AT 回归确认不污染 playground。

### 2.B SessionConfig 加字段 + studio 分支（PRD B + G + §9.5）

**改动 1（类型）**：`context-types.ts:70-153 SessionConfig` 加 5 字段：`sessionType?: 'squad'|'leader'|'mate'|'subagent'`、`bizType?`、`squadId?`、`memberId?`、`studioContext?: { squad?: Squad; member?: Member }`（前 4 字段从 session record 镜像；studioContext 由 bootstrap 注入）。**落新概念 spec**：`specs/tech/squad/[P1]session_config_studio.md` 或并入 `data_model.md §1.5`。

**改动 2（构造）**：`session-config.ts:60-167 buildSessionConfigFromDeps` 加 studio 分支（与既有 subAgentConfig 分支并列），新增参数 `studioContext?: { sessionType, squadId, memberId?, member?, squad? }`。消费规则：

| 字段 | 来源 | 取法 |
|---|---|---|
| `systemPrompt` | member.systemPrompt（leader/mate） | 直接透传；squad 用硬编码路由器 prompt（`agent_squad_chat §2`） |
| `tools` | member.tools | `defaultTools(workdir).filter(t => member.tools.includes(t.name))`（白名单交集） |
| `skills` | member.skills ∩ catalog | `catalog.filter(e => e.enabled && member.skills.includes(e.id))`（D4 黑白名单） |
| `modelId` | member.model ?? squad.modelDefault | **D5**：回退链 `bodyOverride.modelId ?? member.model ?? squad.modelDefault ?? app_config 默认` |
| `workdir` | `squads/{squadId}/workspaces/{memberId}/` | leader/mate 用 member workspace；squad 用 `squads/{squadId}/` |

**改动 3（接线）**：`bootstrap.ts:300-319 setResolveConfig` 闭包：studio session（`bizType==='studio' && type!=='subagent'`）取 member/squad entity（`memberStore`/`squadStore` .1 已落，本版补 wire 到 bootstrap 结果集）注入 studioContext。

### 2.C 工具 schema 层裁剪 + scope 扩 case（PRD C）

**改动 1（schema 层）**：`agent-loop-stage-llm.ts:78-98` 调 baseCallLLM 前过滤 toolDefinitions（新工具函数 `filterToolDefinitionsBySessionType(sessionType, allToolDefs)`）：squad→`['send_message']`；leader→`['send_message','team']`；mate→`['send_message','agent','team',...member.tools]`；subagent→全集\{agent}（沿用 scope 既有）。让 LLM 看不到无关工具，与 `config.tools`（实例白名单，`session-config.ts:137-140` 既有）正交双层。

**改动 2（执行层）**：`scope-allowed-tools.ts:38-47 deriveAllowedTools` 签名加 `sessionType` 维度，新增 case：squad→`['send_message']`；leader→`['send_message','team']`；mate→全集（业务白名单由 config.tools 拦）；subagent→`scope==='subagent'` 拦 agent（既有）。

> **双重过滤一致性**（PRD §8）：subagent 双过滤不破坏；studio session 三重过滤（schema 裁剪 + allowedTools 类型裁剪 + config.tools 白名单）叠加。

### 2.D 统一 prompt builder 接 4 scope（PRD D + §9.4）

**改动 1（identity D9 修 bug）**：`rocky_context/prompt/identity.ts:26-36 IdentityMapper.map` 不再硬编码 Rocky identity：
```typescript
map(ctx) {
  const isStandalone = !ctx.config.sessionType;  // bizType=playground + type 空
  const content = isStandalone ? new IdentityHandler().build({}).content : ctx.config.systemPrompt;
  return [{ id:'identity', tier:'stable', content, priority:1000 }];
}
```
subAgentConfig.systemPrompt 已在 `session-config.ts:145` 落 config.systemPrompt → explorer 人设直接生效。backward compat：v0.0.28 全 case 回归 PASS（identity fix 修隐性 bug，explorer 本就该生效）。

**改动 2（4 新 section mapper）** — `rocky_context/prompt/` 新增 4 文件：

| 文件 | section id | 分流（Option A） | tier | 内容来源 |
|---|---|---|---|---|
| `charter.ts` | `charter` | `sessionType!=='leader' → []`（leader only，D6） | stable | `studioContext.squad.charter` 4 字段 |
| `team_roster.ts` | `team_roster` | `sessionType==='subagent' → []` | stable | `squad.memberIds` → name+role+sessionId |
| `parent_task.ts` | `parent_task` | `sessionType!=='subagent' → []` | stable | spawn 入参 task（subAgentConfig 扩字段持久化） |
| `tasks.ts` | `tasks` | `sessionType!=='mate' → []` | working | **占位**（v3 接 workitems），返提示文本 |

> **新概念 spec**：`specs/tech/squad/[P1]prompt_sections.md`（落 4 section 字段契约 + 分流规则 + tier + 数据源）。

**改动 3（reachable_agents 走 system_reminder，D7）**：`rocky_context/prompt/reachable_agents.ts` 新文件——**system_reminder_mapper**（非 system_prompt_mapper），volatile tier。按 a2a §3 表派生：squad→`[leader,...mates]`；leader→`[squad,...mates]`；mate→`[squad,leader,...peers]`；subagent→`[parent]`。**user 永不在列表**。复用 `agent/context/[P0]system_reminder.md` 体系（v0.0.22 已落 EP）。

**改动 4（数据来源）**：`studioContext`（§2.B）含 squad entity（charter）+ squadId（team_roster 反查 memberIds → memberStore 批量取）。

### 2.E SquadChat 哑路由 + `<EOS>` 双保险（PRD E + §9.6）

**实现层决策**（D8 落位置）：
- **stop seq 在 LLM caller 层**：`agent-loop-stage-llm.ts` 调 baseCallLLM 时 **if `config.sessionType==='squad'`** 注入 `params.stop=['<EOS>']`。
- **strip 在 final text 入 transcript 前**：`stage-llm.ts:99-108` baseCallLLM 返回后、`ingestAndAssembleFn` 调用前，对 `assistantMsg.content` text block 做 `replace(/<EOS>$/,'')`。

**协议侧**：`llm/protocol.ts:48-54 RequestParams` 加 `stop?: string[]`；`llm/protocol-encode.ts:57` 映射 wire `stop_sequences`（Anthropic）；其余 provider impl（GPT/DeepSeek `stop`、Gemini `stopSequences`）各自映射。

**不变量**：`agent-loop.ts:172-180 stopReason='no_tool_call'→break→markIdle` 完全不动；session 持久（下条消息 re-activate 走 multi_agent §3.2 情况 2）。

### 2.F a2a squad clique 校验 + reachable_agents 派生（PRD F）

**改动 1（send-message-tool 校验）**：`tools/send-message-tool.ts:144-159 checkReachable` 在既有 `parentScope==='subagent'` 拦截之外，session scope 分支扩：
```typescript
if (rtc.selfType==='squad'||rtc.selfType==='leader'||rtc.selfType==='mate') {
  return checkSquadClique(rtc, targetSid);
}
return null;  // 顶层 standalone 不变
// checkSquadClique：取 caller.selfSquadId + target session.squadId
//   squadId 不一致 → 'cross-squad a2a not allowed'
//   target.type ∉ {squad,leader,mate} → 'target not in squad clique'
//   OK → null
```

**改动 2（runtime-context 扩）**：`tools/runtime-context.ts:50-84 AgentToolRuntimeContext` 加 `selfSquadId?` / `parentSquadId?` / `squadStore` / `memberStore`；`bootstrap.ts:325-358 setBuildAgentToolContext` 闭包补 `selfSquadId: session?.squadId` + store 句柄。

**改动 3（别名解析扩）**：`runtime-context.ts:144-160 resolveAgentRef` 扩 a2a §2.2 优先级 3/4/5：`'squadchat'`→caller squad.squadChatSessionId；`'leader'`→caller squad 的 leader member.sessionId；角色 name 字串→caller squad 内 member 唯一查找。

### 2.G skill 黑白名单 + model default/override（PRD G）

已合入 §2.B studio 分支消费规则（skills 交集 + modelId 回退链）。无独立改动点。

### 2.H team 工具只读子集（PRD H）

**新增**：`tools/team-tool.ts`（v2 收敛工具，PRD §4.2 / `squad_tools §2`）：actions=`['list','query','get_charter']`（v2 只读；hire/deploy/bench/edit/update_charter 留 v3）。run 时按 `rtc.selfType` 校验：squad→reject；leader/mate→只读三 action 允许。注册到 `tools/registry.ts defaultTools`。schema 层裁剪（§2.C）保证 squad session 看不到 team。

### 2.I 前端群聊 UI + 单聊 chat（PRD I）

tech 层后端契约（组件 spec 由 coder 编码前置产出）：
- **群聊 UI 直读 SquadChat inbox**：a2a 消息（`sender.agent.ref.type∈{leader,mate}`）落 transcript 后 SquadChat agent `<EOS>` 收尾不处理，但 UI GET `/session/{squadChatSid}/messages` 直接读 → 渲染 `ref.name: <content>` 前缀。
- **角色名前缀**：UI 据 `message.sender.agent.ref.name+type` 渲染（leader/mate 显示 member.name；user 显示「你」）。
- **单聊 leader/mate**：直接 GET 自身 transcript，沿用 playground chat 视觉（无前缀）。
- **subagent 树**：沿用 v0.0.28 既有展示（无改动）。
- **API 透明**：messages GET 响应 + SSE agent_event 透传 `sender.agent.ref`（v0.0.31 enrich 已落，本版 zero 改）。

### 2.J 记忆管理实跑（PRD J）

复用 v0.0.18 summary 机制（`context_compact_detail.md`）：面板调 `POST /session/:id/compact`（既有）+ `GET /session/:id/summary`（既有）。member session summary = 角色长期记忆；触发 compact → forked agent 跑 summary task → CAS summaryUpTo。**零新后端代码**；前端组件 spec 由 coder 补。

### 2.K subagent 迁统一框架 + identity fix（PRD K）

见 §2.D 改动 1（identity D9 修）+ 改动 2 `parent_task` mapper。explorer 人设路径：`subAgentConfig.systemPrompt`（spawn 时落）→ `session-config.ts:145 config.systemPrompt` → identity mapper（D9 修后读 config.systemPrompt）→ LLM。AT 用真 LLM 验 subagent 自报身份（UC-8 v0.0.28 全 case 回归 PASS）。

---

## 3. 群聊路由消息流（UC-1 + UC-4）

```
① user 群聊打字 → POST /session/{squadChatSid}/messages → deliverTo(sid, userMsg{source:'user'})
② SquadChat activate → resolveConfigBySid → studio 分支 sessionType='squad' (硬编码路由器 prompt, tools=[send_message])
   drain → userMsg → assemble（identity 路由器 + team_roster + reachable_agents reminder）
   toolDefinitions=[send_message] → LLM → tool_call send_message(target=leader, needReply=true)
③ send_message run（squad clique 校验过）→ deliverTo(leaderSid, a2aMsg{ref.type='squad', needReply=true})
④ SquadChat loop 续：LLM 无 tool_call → stopReason='no_tool_call' → '<完成><EOS>' → strip → markIdle
⑤ leader activate → studio 分支 sessionType='leader' (member.systemPrompt + charter section, tools=[send_message,team])
   drain → a2aMsg{ref.type='squad'} → prompt 渲染 '[Message from SquadChat (squad, needReply=true)]'
   LLM → final text '已经收到…'（UC-4 协作：先 send_message(to=mate) → mate 回 → leader 综合）
   → send_message(to=squad, needReply=false)（leader 想答 user，user 在群聊）
⑥ send_message(to=squad) 落 squadChatSid inbox → 群聊 UI GET /messages 直读 → 渲染 'alice(leader): …'
⑦ 新消息触发 squad re-activate（multi_agent §3.2 情况 2）→ 回 ②
```

---

## 4. 文件级变更清单（MANDATORY）

### 4.1 后端（19 文件）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/handlers/session-messages.ts` | 修改 | 删 :190-192 studio 403 段（subagent 403 :198-200 保留） |
| `app/server/src/handlers/session-config.ts` | 修改 | `buildSessionConfigFromDeps` 加 `studioContext?` 参数 + studio 分支（member.tools/skills/model/workdir 取法见 §2.B） |
| `app/server/src/agent/context-types.ts` | 修改 | `SessionConfig` 加 `sessionType?/bizType?/squadId?/memberId?/studioContext?` |
| `app/server/src/agent/scope-allowed-tools.ts` | 修改 | `deriveAllowedTools` 签名加 `sessionType`；新增 squad/leader case（mate 沿用全集） |
| `app/server/src/agent/agent-loop-stage-llm.ts` | 修改 | baseCallLLM 前过滤 toolDefinitions；sessionType='squad' 注入 `params.stop=['<EOS>']`；ingest 前 strip `<EOS>` |
| `app/server/src/llm/protocol.ts` | 修改 | `RequestParams` 加 `stop?: string[]` |
| `app/server/src/llm/protocol-encode.ts` | 修改 | encode `params.stop` → wire `stop_sequences`（Anthropic） |
| `app/server/src/llm/protocols/*.ts` | 修改 | 其他 provider stop 字段映射（GPT/DeepSeek `stop`，Gemini `stopSequences`） |
| `app/server/src/agent/tools/send-message-tool.ts` | 修改 | `checkReachable` 加 squad clique 分支（selfType∈{squad,leader,mate} → checkSquadClique） |
| `app/server/src/agent/tools/runtime-context.ts` | 修改 | `AgentToolRuntimeContext` 加 `selfSquadId/parentSquadId/squadStore/memberStore`；`resolveAgentRef` 扩 'squadchat'/'leader'/name 别名 |
| `app/server/src/agent/tools/team-tool.ts` | 新增 | `team` 工具 v2 只读子集（list/query/get_charter）+ selfType 权限校验 |
| `app/server/src/tools/registry.ts` | 修改 | `defaultTools` 加 teamTool 导出 |
| `app/server/bootstrap.ts` | 修改 | setResolveConfig 闭包扩 member/squad entity 注入 studioContext；setBuildAgentToolContext 闭包补 selfSquadId + store 句柄 |
| `app/plugins/builtins/rocky_context/prompt/identity.ts` | 修改 | IdentityMapper.map 读 config.systemPrompt（D9 修，standalone fallback Rocky） |
| `app/plugins/builtins/rocky_context/prompt/charter.ts` | 新增 | charter section mapper（leader only，tier=stable） |
| `app/plugins/builtins/rocky_context/prompt/team_roster.ts` | 新增 | team_roster section mapper（subagent 不可见，tier=stable） |
| `app/plugins/builtins/rocky_context/prompt/parent_task.ts` | 新增 | parent_task section mapper（subagent only，tier=stable） |
| `app/plugins/builtins/rocky_context/prompt/tasks.ts` | 新增 | tasks section mapper（mate only，tier=working，占位） |
| `app/plugins/builtins/rocky_context/prompt/reachable_agents.ts` | 新增 | reachable_agents system_reminder mapper（a2a §3 表派生，user 不在列表） |
| `app/plugins/builtins/rocky_context/plugin.json`（注册入口） | 修改 | 注册 6 新 mapper（4 走 system_prompt_mapper；reachable_agents 走 system_reminder_mapper） |

### 4.2 spec 新增 / 修改（架构阶段产出）

| 文件 | 操作 | 变更 |
|---|---|---|
| `specs/tech/version_logs/v0.0.33.2/change_log.md` | 新增 | 本文件 |
| `specs/api/version_logs/v0.0.33.2/change_log.md` | 新增 | API 契约变更 |
| `specs/tech/squad/[P1]prompt_sections.md` | 新增 | 4 新 section 字段契约 + 分流规则（PRD §9.4 落 spec） |
| `specs/tech/squad/[P1]session_config_studio.md` 或并入 `data_model §1.5` | 新增/修改 | SessionConfig studio 字段消费契约（PRD §9.5 落 spec） |
| `specs/tech/multi_agent/[P1]a2a_protocol.md` | 修改 | §6 squad clique 校验从「留 squad 层」→「v0.0.33.2 已落」+ §2.2 别名解析 3/4/5 实现状态 |
| `specs/tech/squad/overall.md` | 修改 | §5 加 v0.0.33.2 落地状态（4 scope 对话打通） |
| `specs/tech/multi_agent/overall.md` | 修改 | §3 加 v0.0.33.2 subagent identity fix + a2a squad clique |
| `specs/tech/agent/context/[P0]system_reminder.md` | 修改 | reachable_agents 作为 system_reminder 贡献者（D7 落） |

### 4.3 前端组件 spec 清单（coder 编码前置产出）

无设计稿，按 `06-studio.md` + `chat-page` 既有视觉对齐。组件 spec 总纲：`specs/tech/app/frontend/[P0]component_architecture.md`（已有则增量）；规范：`specs/ui/components/_conventions.md`（已存在则增量）。

| 组件 spec | 新/改 | 归属 |
|---|---|---|
| `studio-page/squad-chat-page.*` | 新建 | 群聊页（sender.agent.ref.name 前缀 + a2a 透传） |
| `studio-page/member-chat-page.*` | 新建 | 单聊页 leader/mate（复用 playground chat 视觉） |
| `studio-page/member-panel-memory.*` | 新建 | 角色面板记忆 tab（接 v0.0.18 summary） |
| 现有 squad 管理组件 | 修改 | 入口接群聊/单聊 |

---

## 5. PRD §9 六项待落项解决结论

| # | 待落项 | 解决结论 | 落点 |
|---|---|---|---|
| 1 | agents_comparison.md 残留 member | spec 卫生（doc-modifier 阶段 5） | §6 |
| 2 | squad_workspace.md 残留 .rocky_squad 文件名 | spec 卫生 | §6 |
| 3 | squad_tools.md 残留 members.yaml/charter.md | spec 卫生（加注释「概念名，实际走 store {id}.json」） | §6 |
| 4 | 新 section 名 parent_task / team_roster 待落 | **本架构落新概念 spec** `[P1]prompt_sections.md` | §2.D + §4.2 |
| 5 | SessionConfig 加 type/bizType/squadId/memberId | **本架构落字段契约** + `data_model §1.5` 或独立 spec | §2.B + §4.2 |
| 6 | `<EOS>` 实现 layer | **stop seq 在 LLM caller 层（stage-llm params.stop）**；**strip 在 final text 入 transcript 前（baseCallLLM 返回后 ingest 前）** | §2.E |

---

## 6. spec 卫生清单（doc-modifier 阶段 5 执行，本架构不擅改 spec）

| 文件 | 改法 |
|---|---|
| `specs/tech/squad/agents_comparison.md` | `session.type=member` → `mate`；标题 `Member` → 执行者 mate |
| `specs/tech/squad/squad_workspace.md` | `.rocky_squad/charter.md` / `members.yaml` 可读文件名 → 加注「概念文件名，实际走 store `{id}.json`」或直接删（保留 `squads/{squadId}/workspaces/{memberId}/` 目录结构） |
| `specs/tech/squad/squad_tools.md §2` | "注册到 `.rocky_squad/members.yaml`" → "持久化到 member store（`{memberId}.json`）"；§2.1 "写 `.rocky_squad/charter.md`" → "PUT charter → embedded in squad record + append charter_history" |
| `specs/tech/squad/agent_member.md` 标题 | `Member Agent` → `Mate Agent（执行者）`（内容已对齐 mate） |

---

## 7. 新风险 / 与 PRD 不一致处

1. **provider stop seq 兼容**（PRD §8 已提）：扩 `RequestParams.stop` 需 4 provider 各自映射 wire 字段；不支持的 provider 依赖 strip 兜底。**AT 用真 LLM 至少 Anthropic + 1 个其他 provider 跑 UC-7**。
2. **member.tools 白名单语义**：studio 分支把 member.tools 同时用于 (a) config.tools 白名单 (b) schema 层 toolDefinitions 过滤——若 member.tools 漏填 `send_message`，mate 无法 a2a。**API 层 edit member 校验 send_message 必填**（建议 squad_tools §2 加注）。
3. **AgentToolRuntimeContext 字段膨胀**：v0.0.28 parent/self 两套 + 本版加 selfSquadId/parentSquadId/squadStore/memberStore（runtime-context.ts 现 160 行，扩后 < 300）。后续 squad 工具族增多时拆 `squad-runtime-context.ts` 子类型。
4. **subAgentConfig.systemPrompt 与 studio session.systemPrompt 共用 config.systemPrompt**（D9 修法依赖）：subAgentConfig 分支 `session-config.ts:145` 已把 systemPrompt 落 config.systemPrompt；studio 分支同样。identity mapper 不需区分（只要 `sessionType` 不是 standalone 就用 config.systemPrompt）。forked agent 走 NO_TOOLS 不涉 identity（已有隔离）。**无风险**，仅记录。
5. **与 PRD 一致性**：PRD §3 D6「charter=stable system_prompt section」与 §2.D charter.ts tier='stable' 一致；PRD §9.5 未明说 `studioContext` 字段——本架构补此设计（charter/team_roster mapper 数据源），与 PRD D6 一致非推翻。

---

## 8. 版本

version: 1.0 `[v0.0.33.2]`（4 scope 对话打通首版架构：①§1 4 scope 共用 AgentLoop 核心设计 + 三不变量 + 6 注入点表；②§2 PRD §2 11 条逐条实现设计（拆 403 / SessionConfig studio 分支 / schema 裁剪 / 4 新 section mapper + identity D9 修 / `<EOS>` 双保险 / squad clique / skill+model / team 只读 / 群聊 UI / 记忆管理 / subagent backward compat）每条含 file:line 锚 + 改动 + 数据流；③§3 UC-1+UC-4 群聊路由消息流；④§4 文件级变更清单（19 后端 + 8 spec + 4 前端组件）；⑤§5 PRD §9 六项待落项解决结论（4/5/6 本架构落，1/2/3 spec 卫生）；⑥§6 spec 卫生清单；⑦§7 新风险 5 条 + 与 PRD 一致性核对。基于 PRD v1.0 + research §3 D1-D10 + 权威 spec（squad/multi_agent/agent）。）
