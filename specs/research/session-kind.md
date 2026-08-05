# Session 类型统一调研 — SessionKind

> v0.0.56.session_type 调研文档。两轮 Explore 调研结论整合。
> 决策已与用户对齐，权威记在 `reqs/[working] v0.0.56.session_type/req.md`。
> 所有 file:line 为调研时快照，编码时以实际为准。

## 0. 目标
把 session 散落的类型维度（bizType / type-role / scope / subagent 标志）**统一成单一 `SessionKind` 对象**：session 构建时一次产出（`getSessionKind(sid)`），后续所有判别（tool 列表、scope、model/prompt、UI 等）统一读它，不再各处零散 if/switch。**完全删除原始 type 定义**，靠 TS 编译错误强制全量迁移。

## 1. 现状：维度定义（散落 + 命名不一致）

| 维度 | 类型/字段名 | 定义位置 | 不一致点 |
|---|---|---|---|
| biz | `BizType` / `bizType` | `app/shared/src/types/session-types.ts:17` | 已抽 shared；但"空=playground"懒默认散落 4+ 处各自 `?? 'playground'` |
| type(role) | `SessionType` / `Session.type` | `session-types.ts:27` | **被重载**：含 `'subagent'`（派生语义混进 role 枚举）；`SessionConfig` 改名 `sessionType` |
| scope | 内联字面量 / `scope` | 无 shared 定义 | `'session'\|'subagent'` 在 4+ 文件内联；从未抽 alias |
| subagent 标志 | **无独立字段** | — | 由 `type==='subagent'` + `scope==='subagent'` 双字段表达，不变量靠 spawn 站点手工维护 |
| parentRole | `subAgentConfig.parentRole` | `session-store-types.ts:146` | **派生结果被持久化**（spawn 时从父算出落库），可重算却存了，带一致性负担 |
| ToolPolicyRole | 运行时局部 | `tool-policy.ts:20` | `'playground-rocky'\|'studio-squad'\|'studio-leader'\|'studio-mate'\|'subagent'`，`resolveRole()` 在 5+ 处从 `{bizType,type}` 重复派生 |

**drifted 内联 union**（同概念多套枚举，需统一）：
- `schema_defs/session.ts:114`、`tool-policy.ts:106`、`message/types.ts:200`（AgentRef.type：有 `'session'` 无 `'rocky'`）、`tools/types.ts:138`、`tools/runtime-context.ts:163,185`

## 2. 现状：消费点（约 45 处，分 4 类）

**Tool 列表决策（集中）**
- `tool-policy.ts:122-134` `resolveRole` / `:208-251` `resolveTools`（policy 单源）
- `handlers/session-config.ts:221-233`（config 层入口，调 resolveRole+resolveTools）
- `tools/parent-role.ts:37-44` `resolveParentRole`（spawn 时算 parentRole）
- `scope-allowed-tools.ts:63,120`（@deprecated wrapper，v0.0.48 后 thin re-export）

**Scope/权限（tool 运行时门控）**
- `agent-scope-router.ts:86-100`（**已拆 Role×Derivation 4 维**，是 SessionKind 的雏形）
- `tools/send-message-tool.ts:146,153`、`team-tool.ts:102,112`、`goal-tool.ts:95,173`、`requirement-tool.ts:85,116`、`task-tool.ts:84,87,212,240`、`squad-workitem-shared.ts:107,109`、`runtime-context.ts:250`
- 注：这些读的 `selfType`/`parentScope` 是 `AgentToolRuntimeContext` 已派生字段（bootstrap 从 session.type/scope 注入）——重构时这是天然收口点

**Model/Prompt（最分散，11 个在 rocky_context mappers）**
- `session-config.ts:142-158`（studio modelId 回退）、`:244-250`（systemPrompt 三分：squad 路由 / subagent explorer / DEFAULT）
- `rocky_context/prompt/`：`identity.ts:44`、`squad_role.ts:43`、`rules.ts:33`、`parent_task.ts:34`、`team_roster.ts:42`、`reachable_agents.ts:55,72,115,119`、`squad_charter.ts:65,72`、`squad_tasks.ts:61`、`squad_board.ts:72`、`squad_reminder_shared.ts:55`
  - **关键**：这 11 个 mapper 全走 duck-typed `readSessionType(ctx)` 一个 helper → 改一处影响 11 处
- `agent-loop-stage-llm.ts:110`、`build-deps.ts:191-193`（squad EOS stop seq）、`squad-reminder-deps.ts:153`

**UI/路由**
- `web/src/components/chat-page/section-chat-detail.tsx:135`（subagent→readOnly）
- `web/src/store/chat-slice.ts:129`（bizType==='studio' 拒纳，防泄漏）
- `web/src/components/studio-page/section-{member,squad}-chat.tsx:142,144`（编译期常量）

**其他门控/过滤/数据流（~13 处）**
- `bootstrap.ts:388` + `session-debug.ts:60`（**同一 studio 判定硬编码重复**：`bizType==='studio' && type && type!=='subagent' && type!=='rocky'`）
- `handlers/session.ts:69`、`session-store.ts:180,183`（listSessions 按 bizType 分区）
- `auto-naming-service.ts:80-82`（playground-only AI 起名 gate）
- `mention/search-service.ts:93-94,117`、`inbox-enrich.ts:43,61`、`agent-tool.ts:320,331`（spawn 透传 bizType + 持久化 parentRole）、`session-meta-broadcaster.ts:90`、`session-store-converters.ts:86`、`services/{squad,member}-service.ts:163,178,186`

## 3. 现状：持久化
- **后端**：`FsCrudStore` 文件 JSON（非 SQLite），路径 `{dataDir}/session/<id>.json`；dev 样本 `~/.rocky_agent_dev/session/*.json`（18 条）
- **schema**：`app/server/src/agent/schema_defs/session.ts:20-174`
- **类型字段全部落盘**：bizType/type/scope/squadId/memberId/parentSessionId/subAgentConfig(含 parentRole)
- **冗余持久化**：`scope`（⇔ type='subagent'）、`parentRole`（可从父重算）、`usage.parentSessionId`（顶层镜像）
- **懒默认**：bizType 空=playground（14 条样本无字段）、type 空=standalone、scope 空=session
- **converter**：`session-store-converters.ts:46-95` 单向 `toSession`（无反向）；类型字段 round-trip 对称
- **sessionId 能否重建统一对象**：
  - 身份维度（biz/role/derivation/三件套/parentRole）→ ✅ 自包含
  - 派生 config（systemPrompt/tools/skills/model）→ ⚠️ studio session 必须 fan-out 查 squad/member store
  - → SessionKind 构造分两层：`getSessionKind(sid)`（身份，自包含）+ `resolveSessionConfig(sid)`（fan-out，仅 agent loop 需要）

## 4. 关键发现

### 4.1 subagent 的 role（用户问的核心）
- **现状**：subagent 自己的 ToolPolicyRole = `'subagent'`（独立角色，工具集比 main 少 `'agent'` 工具=不能再 spawn）；**不**继承 parent role。额外带 `parentRole`（仅 studio-leader/studio-mate 派生时有）做工具集再封顶（capByParent，"不超父"）。
- **playground 也能 spawn subagent**：child = `{bizType:playground(跟父), type:'subagent', parentSessionId}`，此时无 parentRole（parentRole 只覆盖 studio-leader/studio-mate）。
- **定稿（方案 B，与用户直觉一致）**：`role` 字段存 bloodline role（subagent 存 parent 的 role），`derivation` 正交表达 main/subagent。这样：① 消灭独立 parentRole 字段（role 已带父 role，∩ 父 bound 自动算封顶）② playground-subagent 自然落 `role='rocky'`，无特殊处理 ③ 与 `agent-scope-router.ts` 已有的 Role×Derivation 模型对齐。

### 4.2 scope 干嘛的（用户问）
- v0.0.28 的"工具可见集"标签：`'subagent'` 比 `'session'` 少 `'agent'` 工具。
- **v0.0.48 tool-policy 单源化后已被取代、实质冗余**：`scope-allowed-tools.ts` 整文件 `@deprecated`；`AgentScopeRouter.mapLookup` 恒返 'default' 不查 scope。
- 与 `type='subagent'` **1:1 强耦合、无反例** → **删**，读侧从 derivation 派生。

### 4.3 "mode" key 考古（用户回忆）
- sessionMode/chatMode/agentMode 在 git 全历史 + 所有 spec/reqs **零命中**。
- 找到 `modeKey`：字面就是"mode key"，但指 **run 级 current/forked 分区**（compact/memory 旁路），与 session 类型无关。用户大概率记混。**不纳入本次统一**。

## 5. 定稿设计：SessionKind

```ts
// 持久化的身份维度（独立存储，不互相派生；耦合→校验规则）
SessionKind {
  biz: 'playground' | 'studio'
  role: 'rocky' | 'leader' | 'mate' | 'squad'   // subagent 存 parent.role
  derivation: 'main' | 'subagent'
  squadId?: string; memberId?: string; parentSessionId?: string
}
// 派生 getter（不持久化，消灭 5+ 处 resolveRole 重算）
get isStudio(): boolean        // biz === 'studio'
get isSubagent(): boolean      // derivation === 'subagent'
get toolPolicyRole(): ...      // 替代散落 resolveRole
allowedTools(parent?): ...     // 替代 resolveTools
```

**构造**：`getSessionKind(sid)` 读 session 记录 → 建 SessionKind（身份层，自包含）。studio 完整 config 由 `resolveSessionConfig(sid)` fan-out squad/member。

## 6. 迁移方案（用户定）
**直接迁 dev/test 数据，无脚本、无读兼容。**
- coder 实现时一次性就地转换 `~/.rocky_agent_dev/session/*.json` + `~/.rocky_agent_test/session/*.json` 到新 shape
- 不产出可复用脚本（inline 一次性）
- `getSessionKind` 不处理旧 shape（无读兼容层）
- 理由：dev/test 可弃、无生产

## 7. 删除清单 + 校验规则

**完全删除（用户强制要求，靠 TS 编译错误审计遗留引用）：**
- `SessionType` alias（含 `'subagent'` 值）→ 改为 `Role = 'rocky'|'leader'|'mate'|'squad'`
- `Session.type` / `Session.scope` / `subAgentConfig.parentRole` 字段
- 所有 drifted 内联 union（schema_defs/session.ts:114、tool-policy.ts:106、message/types.ts:200 等）→ 统一引用 SessionKind/Role
- `scope-allowed-tools.ts`（@deprecated）
- `resolveRole()` 散落副本 → SessionKind.toolPolicyRole getter

**校验规则（写入时 validate，字段仍独立存储）：**
- `role ∈ {leader,mate,squad}` ⇒ `biz='studio'`
- `derivation='subagent'` ⇒ `parentSessionId` 必填
- `biz='studio'` ⇒ `squadId` 必填
- `role ∈ {leader,mate}` ⇒ `memberId` 必填

## 8. 关键文件索引（编码时逐一改造）
- 类型定义源：`app/shared/src/types/session-types.ts`、`app/server/src/agent/session-store-types.ts`、`context-types.ts`
- 持久化：`schema_defs/session.ts`、`session-store.ts`、`session-store-converters.ts`
- 派生：`tool-policy.ts`、`tools/parent-role.ts`、`agent-scope-router.ts`
- 构造入口：`handlers/session-config.ts`、`bootstrap.ts`
- spawn 写入：`agent-tool.ts:300-333`、`spawn-action.ts`
- 消费点：见 §2（4 类约 45 处）
