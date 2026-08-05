---
type: interface
title: SessionConfig studio 字段消费契约
priority: P1
status: active
updated: 2026-08-02
since: v0.0.33.2
---

# SessionConfig studio 字段消费契约（4 scope 接 AgentLoop）

> 定位：定义 SessionConfig 的 5 个 studio 新字段**消费契约** + `buildSessionConfigFromDeps` studio 分支对 `systemPrompt/tools/skills/modelId/workdir` 5 字段**取法表**。
> 参考：`specs/tech/version_logs/v0.0.33.2/change_log.md §2.B`（权威源）；`[P1]data_model.md §1.1/§1.2`（Squad/Member entity）；`[P1]prompt_sections.md`（studioContext 被 team_roster/reachable_agents/squad_role mapper 消费）；`[P1]squad_workspace.md §1`（workdir 目录结构）；`[P1]agent_squad_chat.md §2`（硬编码路由器 prompt）；`../agent/context/[P0]system_prompt.md`（config.systemPrompt 透传给 mapper）。
> 命名：role / session.type 一律 **mate**（非 member）；Member entity 字段名（member.systemPrompt/tools/skillConfig）保留——那是 entity 字段非 role。**v0.0.155：member.model 已硬删**（member 退管理概念，不持运行配置；model/effort/approval 全跟 session）。

---

## 1. 概述

v0.0.33.2 把 studio 4 scope（squad/leader/mate/subagent）接进 v0.0.31 已铺的 `deliverTo(sessionId) → AgentManager.activate → resolveConfigBySid → buildSessionConfigFromDeps → AgentLoop` 链路。差异通过 **SessionConfig 加 5 字段**（mapper 内分流读）+ **buildSessionConfigFromDeps 加 studio 分支**（与既有 subAgentConfig 分支并列）消化。

**零新增 EP / 零破 loop 本体**（架构 §1 三不变量）。

---

## 2. SessionConfig 5 新字段契约

`SessionConfig`（`app/server/src/agent/context-types.ts`）加 5 字段：

| 字段 | 类型 | 来源 | 消费者 |
|---|---|---|---|
| `kind` | `SessionKind` | **[v0.0.56]** `store.getSessionKind(sid)` 产出（替代旧 `sessionType`/`bizType` 镜像） | 所有 mapper（`kind.role`/`kind.isStudio`/`kind.isSubagent`）+ systemPrompt 分流 + tools resolve |
| `squadId` | `string \| undefined` | session record 镜像 | T5 send_message squad clique 校验 + reachable_agents 派生 |
| `memberId` | `string \| undefined` | session record 镜像（仅 leader/mate 有） | workdir 取法 + studioContext.member 取法 |
| `studioContext` | `{ squad?: Squad; member?: Member } \| undefined` | **bootstrap 注入**（非镜像） | team_roster/reachable_agents/squad_role mapper 数据源（见 `[P1]prompt_sections.md §3/§4/§5`） |

**前 4 字段从 session record 镜像**：session store 已落这些字段（v0.0.33.1 增量），buildSessionConfigFromDeps 直接透传。

**studioContext 由 bootstrap 注入**：`bootstrap.ts:300-319 setResolveConfig` 闭包判 studio session（`bizType==='studio' && type!=='subagent'`）→ 取 member/squad entity（memberStore/squadStore）→ 注入 studioContext。

> subagent 不走 studio 分支（走既有 subAgentConfig 分支）；subagent 的 sessionType 由 subAgentConfig 分支落（`session-config.ts:145` 把 subAgentConfig.systemPrompt 落 config.systemPrompt，T3 identity D9 修后 mapper 读 config.systemPrompt → explorer 人设生效）。

---

## 3. studio 分支取法表（核心契约）

`buildSessionConfigFromDeps`（`app/server/src/handlers/session-config.ts:60-167`）加 studio 分支（与 subAgentConfig 分支并列），新增参数 `studioContext?: { sessionType, squadId, memberId?, member?, squad? }`。studio 分支 5 字段取法：

| SessionConfig 字段 | 来源 | 取法 |
|---|---|---|
| `systemPrompt` | `member.systemPrompt`（leader/mate） | 直接透传；**squad 用硬编码路由器 prompt**（`[P1]agent_squad_chat.md §2`） |
| `tools` | `member.tools` | `defaultTools(workdir).filter(t => member.tools.includes(t.name))`（白名单交集） |
| `skills` | catalog **overlay** member.skillConfig | **[v0.0.113] overlay**（替代 D4 交集，见 §3.2）：workspace 层恒生效；builtin/app 层 inherit→全局 enabled、custom→全局叠加 `overrides` |
| `modelId` | `resolveModel({...})` | **[v0.0.155] session 中心化**：studio chain = `bodyOverride → sessionModelId → resolveDefaultModel → squad.modelDefault → throw`（**member.model 已硬删，不再参与链**；session 是 model/effort/approval 的唯一运行配置读源，与 effort/approvalMode 同款）。**MUST NOT 读 app_config.default_models**（INV-A5）。详见 `../agent/providers_and_models/[P0]model_resolve.md §3/§4` |
| `workdir` | `squads/{squadId}/workspaces/{memberId}/` | leader/mate 用 member workspace；**squad 用 `squads/{squadId}/`** |

### 3.1 取法表逐字段说明

- **systemPrompt**：
  - leader/mate → `member.systemPrompt`（Member entity 字段，`[P1]data_model.md §1.2`）。
  - squad → 硬编码路由器 prompt（SquadChat 是哑路由分拣器，无 member entity，见 `[P1]agent_squad_chat.md`）。
  - 透传到 `config.systemPrompt` → identity mapper（T3 D9 修后读 config.systemPrompt）。
- **tools**（白名单交集）：~~`defaultTools(workdir)`（registry 全集）与 `member.tools`（Member.tools 字段，声明此角色可用工具）取交集 → 实例白名单。**注意**：member.tools 漏填 `send_message` → mate 无法 a2a（架构 §7 风险2）；API 层 edit member 校验 send_message 必填（建议 `[P1]squad_tools.md §2` 加注）。~~ **[v0.0.48] tools 取法整段重写为 static-by-type**；**[v0.0.56 hotfix] resolveTools 入参从 role 改为 kind**：
  - **不再读 `member.tools`**（v0.0.48 标 dead，详见 `[P1]data_model.md §1.2`）。
  - **改查 `TOOL_POLICY`**（`tool-policy.ts`）：`buildSessionConfigFromDeps` 调 `resolveTools(kind)` 算 `tools = allTools ∩ TOOL_POLICY[kind.toolPolicyRole].bound`（leader=15 / mate=15，详见 `../agent/tools/[P0]tool_policy.md §2.2`）。`kind` 必传（顶层/subagent 路径），role 由 `kind.toolPolicyRole` 派生。
  - **三层一致**：config/schema/exec 三层都查同一份 policy（修 v0.0.33.3 残留 schema 层 + exec 层不对齐缝，B1/B2 自然解决）。
  - **mate send_message 保底**：policy.roles.studio-mate.bound 含 send_message → 无需 API 校验（policy 即权威）。
- **skills**（**[v0.0.113] overlay，替代 D4 交集**）：见 §3.2。旧 D4「catalog ∩ member.skills 白名单」已废弃（占位死数据 + 面板保存即清空的缺陷，PRD `2-member-skills-mechanism.md §1`）。
- **modelId**（**[v0.0.155] session 中心化 + resolveDefaultModel 单点出口；[v0.0.158] chat/compact 同链 + 唯一入口**）：`buildSessionConfigFromDeps` 调 `resolveModel({sessionType,role,sessionModelId,sessionProviderId,squad})`（**无 member 入参**，INV-A2；**v0.0.158 无 `task` / `bodyOverride*` 入参**）走 §3 fallback 链。studio 单链 = `session.{modelId,providerId?} → resolveDefaultModel() → squad.modelDefault → throw`（chat/手动 compact/自动 compact/T1 记忆整理都走此链）。**studio 完全不读 `app_config.default_models`**（INV-A5：default 来源由 resolveDefaultModel 单点决策）。`squad.modelDefault` schema `required` 非空、建队时 seed 全局默认——故「团队继承全局」= 建队一次性 seed，运行期恒具体值，resolve 恒命中。**入口收敛**：所有 forked run（compact / T1 记忆整理）走 `agentManager.resolveConfigBySid(sid)` 唯一入口（bootstrap `setSideRunner` / `setConsolidationRunner` 闭包内自 resolve），不消费 caller 传入的 config。权威：`../agent/providers_and_models/[P0]model_resolve.md §3/§4/§5.1`。
  > **v0.0.155 变更**：① member.model 硬删（INV-A1/A4）——member 退管理概念，不再参与 resolve 链；存量 member.model 值忽略（resolver 不读，无 migration 需要）；hire/PATCH member API body.model 旧 client 传 → warn+ignore 非 400。② ModelRef 复合（INV-B1）——session/squad 新增配对 providerId 字段（optional back-compat），resolver 候选 `{modelId, providerIdHint?}` 精确匹配。前端 picker（studio member 单聊）从 `patchMember` 改走 `updateSession` 复合 body（INV-D1）。
- **workdir**：leader/mate 用 member workspace（`squads/{squadId}/workspaces/{memberId}/`，见 `[P1]squad_workspace.md §1`）；squad 用 squad 根目录（`squads/{squadId}/`，无个人 workspace——路由器不干活）。

### 3.2 skills overlay resolve（[v0.0.113] 替代 D4 交集）

studio 分支 skills = `catalog.entries.filter(keep)`（`catalog` = `SkillResolver.resolve` 三层扫产出，含 `enabled`）。`keep(e)` 按 `SkillEntry.scope` + `member.skillConfig` 分层判定：

```
keep(e):
  if e.scope === 'workspace'        → true                 // R2：workspace 层恒生效（团队约定，不受 switch/快照影响）
  // builtin + app 层（"全局 skill"）走 overlay：
  if skillConfig.mode === 'custom'  → overrides[e.name] !== undefined ? overrides[e.name] : e.enabled  // R1/R3：快照有记录用快照，无记录跟全局
  else /* inherit */                → e.enabled            // R1：纯继承全局 enabled
```

**不变量**：
- **R2 workspace 恒生效**：`scope==='workspace'` 无条件保留（即便该 skill 全局 disabled）——team 级 skill 是约定。
- **R3 新增 skill 跟全局**：custom 下 `overrides` 无该 name（如全局后续新增）→ 用 `e.enabled`（全局配置），不因快照旧而漏。
- **builtin 与 app 同治**：builtin 层（okf-skill）与 app 层同受 overlay——off 时全给（全局 enabled），角色区分由 `squad_role` mapper + tool-policy 保证（`index.md` 原则 #3/#6），不再靠 skill 白名单。
- **subagent 跟随 parent**：member session skills 决定其 subagent 可见 skill（subagent 走 subAgentConfig 分支但 catalog 同源）。
- **squad 哑路由器无 skills（守卫）**：SquadChat 路由器 session `studioContext.member === undefined`（无 member entity，只 route 不干活）→ studio 分支直接产 **空 skills**（`entries: []`），不跑 `keep()`。与旧 D4 行为一致（路由器仅持 send_message，无需 skill）。故 overlay resolve 仅对 leader/mate（有 member）生效。

代码位置：`handlers/session-config.ts:buildSessionConfigFromDeps`（studio skills 块）。`isStudio && studioContext.member ? catalog.entries.filter(keepStudioSkill(e, member.skillConfig)) : []`——读 `studioContext.member.skillConfig`（不再 `.skills`）；member 缺失（squad 路由器）走空。产品行为权威：PRD `2-member-skills-mechanism.md §3`（R1-R6）。**R5 保存补齐 / R6 off 清空**是前端保存时的 overrides 快照职责（详见 `specs/ui/components/studio-page/member-panel.md`）。

---

## 4. studioContext 注入（bootstrap）— [v0.0.56] 改读 SessionKind

> **[v0.0.56]** 旧 `session.bizType/session.type` 判 studio 改为读 `SessionKind`：`kind = await store.getSessionKind(sid)` → `isStudioMainSession(kind)`（`kind.isStudio && kind.derivation === 'main' && kind.role !== 'rocky'`）。统一 helper 见 `[P0]session_kind.md §7.4`。

`bootstrap.ts setResolveConfig` 闭包逻辑（伪代码）：

```typescript
const kind = await store.getSessionKind(sid);
if (isStudioMainSession(kind)) {
  const member = session.memberId ? await memberStore.get(session.memberId) : undefined;
  const squad  = await squadStore.get(session.squadId);
  studioContext = { squad, member };
}
// buildSessionConfigFromDeps({ ..., studioContext, subAgentConfig?, kind })
```

- **leader/mate**：member + squad 都取（team_roster/tools/skills/model/workdir 全要用）。`studioContext.member` 注入的是**完整 MemberRecord**（`memberStore.get` 整记录），故 member 新增 schema 字段（如 **[v0.0.142] `workStyle`**）**自动流转**进 studioContext——无需改 bootstrap 注入逻辑。`workStyle` 由 `squad_role` mapper 的 leader/mate 分支消费（当前 session 自己的 member = 个人 session，`[P1]prompt_sections.md §3.1`）；因 `studioContext.member` 恒指自己（非全队 `members[]`），天然满足「仅个人 session 注入」。
- **squad**：只取 squad（无 member entity；systemPrompt 用硬编码路由器）。`studioContext.member===undefined` → workStyle 注入分支不触发。
- **subagent**：不走 studio 分支，走既有 subAgentConfig 分支（保留 v0.0.28 行为，D9 修只动 identity mapper）。

---

## 5. 与 subAgentConfig 分支的关系

`buildSessionConfigFromDeps` 既有 subAgentConfig 分支（v0.0.28）保留，studio 分支与之**并列**：

| 分支 | 触发条件 | systemPrompt 来源 | sessionType |
|---|---|---|---|
| subAgentConfig | subagent session（顶层 spawn 出来的） | `subAgentConfig.systemPrompt`（spawn 入参） | `'subagent'` |
| studio | studio session（`bizType==='studio' && type!=='subagent'`） | `member.systemPrompt` 或硬编码路由器 | `'squad' \| 'leader' \| 'mate'` |

两分支都把 systemPrompt 落 `config.systemPrompt` → identity mapper（D9 修后）统一读 config.systemPrompt，不需区分来源。

---

## 6. UC-12 bizType 隔离（回归门禁）

bizType 隔离三处独立保留（拆 403 后仍生效）：
1. **字段**：session.bizType 区分 playground / studio（session record 字段）。
2. **GET 过滤**：`GET /sessions` 等列表接口按 bizType 过滤（playground 不见 studio session）。
3. **UI 路由**：playground 与 studio UI 路由隔离。

拆 403 只删「POST studio messages 返 403」一段（T2），bizType 隔离不动 → UC-12 AT 回归确认 playground 不污染。

---

## 7. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| SessionConfig 5 新字段契约 + studio 分支取法表 | 本文 ✅ |
| 4 section mapper 消费 sessionType/studioContext | `[P1]prompt_sections.md` |
| Squad/Member entity（modelDefault/tools/skills/systemPrompt/model） | `[P1]data_model.md §1.1/§1.2` |
| workdir 目录结构（workspaces/{memberId}/） | `[P1]squad_workspace.md §1` |
| SquadChat 硬编码路由器 prompt | `[P1]agent_squad_chat.md §2` |
| skill catalog 过滤 | skill 层 spec |
| subAgentConfig 分支（v0.0.28） | session-config 既有 |

---

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
