# v0.0.56 PRD Change Log — SessionKind 统一 session 类型维度（重构·行为保持）

> version: 1.0 · 2026-07-03
> 一句话定位：把 session 散落的类型维度（bizType / type-role / scope / subagent / parentRole）**统一成单一 `SessionKind` 对象**——session 构建时一次产出（`getSessionKind(sid)`），后续约 45 处消费点统一读它；**用户侧行为不变**，价值是可维护性 + 正确性。
> 概念权威源：`specs/research/session-kind.md`（调研 + 定稿设计）+ `specs/tech/agent/session/`（`[P0]session_store.md §2` 字段定义 + `[P0]session_biztype.md` biz 规则）+ `specs/tech/agent/tools/[P0]tool_policy.md`（resolveRole/resolveTools 单源）+ `specs/tech/multi_agent/[P1]subagent_derivation.md §2`（type/scope 字段语义）+ `specs/tech/squad/`（三角色 session）。
> 设计稿：**无**（`reqs/[working] v0.0.56.session_type/` 仅 req.md）→ 视觉保真度门禁**跳过**；**本版本不做 E2E**（用户明确），验证靠 UT（白盒）+ AT（黑盒契约）。

---

## 1. 背景与目标

### 1.1 背景

Session 当前用**多个散落字段**表达「这是个什么 session」：

| 维度 | 字段 | 问题 |
|---|---|---|
| biz | `bizType: 'playground' \| 'studio'` | "空=playground" 懒默认散落 4+ 处各自 `?? 'playground'` |
| role | `type: 'squad' \| 'leader' \| 'mate' \| 'subagent'` | **被重载**：`'subagent'` 是派生语义混进 role 枚举 |
| scope | `scope: 'session' \| 'subagent'`（内联）| v0.0.48 tool-policy 单源化后**实质废弃**，与 `type='subagent'` 1:1 强耦合 |
| subagent 标志 | **无独立字段** | 由 `type==='subagent'` + `scope==='subagent'` **双字段不变量**表达 |
| parentRole | `subAgentConfig.parentRole` | **派生结果被持久化**（spawn 时算出落库），一致性负担 |
| ToolPolicyRole | 运行时局部 | 5+ 处 `resolveRole()` 各自从 `{bizType, type}` 重复派生 |

**问题域**：
1. **散落判别**：约 45 处消费点各自 `if (bizType==='studio' && type && type!=='subagent'...)`，逻辑碎片化、易漏改（`bootstrap.ts:388` + `session-debug.ts:60` 已有同判定**两份硬编码副本**）。
2. **双字段不变量**：`type='subagent'` ⇔ `scope='subagent'` 靠 spawn 站点手工维护，无 schema 强制。
3. **派生字段持久化**：`parentRole` 可从 parent 重算却存进 child session record，徒增一致性负担（v0.0.48 已迁到 `tool-policy.ts/parent-role.ts` 派生，但 child record 仍持久化）。
4. **drifted 内联 union**：`'session' | 'subagent'` 在 4+ 文件各自定义，无 shared alias。

### 1.2 目标

1. **统一对象 `SessionKind`**——session 构建时一次产出（`getSessionKind(sid)`），身份维度（biz/role/derivation/三件套）**独立存储、不互相派生**；耦合关系从「派生规则」降级为「校验规则」（存入时 validate）。
2. **消灭散落判别**——后续所有判别（tool 列表 / scope 权限 / model/prompt / UI 路由 / 数据流门控）统一读 SessionKind 派生 getter（`isStudio` / `isSubagent` / `toolPolicyRole` / `allowedTools(parent?)`）。
3. **正交化维度**——`derivation: 'main' | 'subagent'` 独立字段表达 main/subagent；`role` 字段回归纯 role 语义（subagent 存 parent.role）。
4. **彻底删除原始 type 定义**——靠 TS 编译错误审计全量迁移，不留读兼容层、不留 deprecated 死代码。
5. **用户侧行为完全不变**——5 条关键路径（§5）回归守护。

**价值（用户不可见）**：可维护性（消费点 45 → 1）+ 正确性（消灭双字段不变量 bug）+ 可演进性（加维度只动一处）。

---

## 2. 三个已确认决策（用户对话定稿，PRD 直接落地）

| # | 决策 | 理由 |
|---|------|------|
| **D1** | **`role` 字段存 bloodline role**（subagent 存 parent.role）+ **`derivation` 正交表达 main/subagent** | 与用户直觉一致；与 `agent-scope-router.ts` 已有的 Role×Derivation 4 维模型对齐；消灭独立 `parentRole` 字段（role 已带父 role，`∩ 父 bound` 自动算封顶）；playground-subagent 自然落 `role='rocky'`，无特殊处理 |
| **D2** | **完全删除原始 type 定义**（`SessionType` enum / `Session.type` / `Session.scope` / `subAgentConfig.parentRole`），靠 TS 编译错误审计全量迁移 | 用户强制要求；保留 deprecated 字段会留下死代码 + spec 永远背两套定义；删除 = 一次性痛苦换长期可维护 |
| **D3** | **直接迁移 dev/test 数据，无脚本、无读兼容** | dev/test 可弃、无生产数据；`getSessionKind` 不处理旧 shape；迁移 inline 即可（不产出可复用脚本） |

---

## 3. Scope

### 3.1 IN-SCOPE

| 编号 | 项 | 摘要 |
|---|---|---|
| **S1** | **定义 `SessionKind` 类型 + 构造入口** | `app/shared/src/types/session-kind.ts`（新）：`Role = 'rocky'\|'leader'\|'mate'\|'squad'` + `SessionKind` interface（biz/role/derivation/三件套，独立存储字段）+ 派生 getter（isStudio/isSubagent/toolPolicyRole/allowedTools）；`getSessionKind(sid)` 构造入口（读 session record → 建 SessionKind 身份层，自包含） |
| **S2** | **删除散落字段 + 派生统一** | `SessionType` alias 删（含 `'subagent'` 值）；`Session.type` 字段删（改读 SessionKind.role）；`Session.scope` 字段删（v0.0.48 后已实质废弃，工具可见性走 `derivation`）；`subAgentConfig.parentRole` 字段删（role 已带）；drifted 内联 union（schema_defs/session.ts:114、tool-policy.ts:106、message/types.ts:200 等）统一引用 `SessionKind`/`Role`；`scope-allowed-tools.ts` 整文件删（v0.0.48 已 `@deprecated`） |
| **S3** | **45 处消费点迁移到读 SessionKind** | 4 类消费点：(a) Tool 列表决策（resolveRole/resolveTools/parent-role）；(b) Scope/权限门控（agent-scope-router + tools/* 内 selfType/parentScope 检查 → 改读 kind.isSubagent / kind.toolPolicyRole）；(c) Model/Prompt（11 个 rocky_context mapper 共用 `readSessionType(ctx)` helper → 改一处影响 11 处）；(d) UI/路由（chat-page / chat-slice / studio-page / listSessions / auto-naming / mention / inbox-enrich / broadcaster / converters / squad-member-service）。详见 research doc §2 |
| **S4** | **校验规则落 schema 写入路径** | 在 session create/spawn 写入路径 validate（不互相派生，只校验）：`role∈{leader,mate,squad}⇒biz=studio` / `derivation=subagent⇒parentSessionId 必填` / `biz=studio⇒squadId 必填` / `role∈{leader,mate}⇒memberId 必填` |
| **S5** | **dev/test 数据一次性迁移** | coder 实现时 inline 一次性转换 `~/.rocky_agent_dev/session/*.json`（18 条）+ `~/.rocky_agent_test/session/*.json` 到新 shape：`biz`/`role`/`derivation` 三字段从旧 `{bizType,type,scope,parentRole}` 算出 + 删旧字段（type/scope/subAgentConfig.parentRole） |
| **S6** | **Spec 同步更新（阶段 5 doc-modifier 统一）** | tech/agent/session/[P0]session_store.md §2（字段定义）+ [P0]session_biztype.md §4（bizType↔type 表 → biz↔role 校验规则）+ tech/agent/tools/[P0]tool_policy.md §2.3（resolveRole → SessionKind.toolPolicyRole）+ tech/multi_agent/[P1]subagent_derivation.md §2（type/scope 字段语义）+ tech/squad/* 角色文档；prd/api/ui overall 增量。详见 §8 |

### 3.2 OUT-OF-SCOPE（Non-goals，明确排除）

- **改 AgentLoop 本体**——loop 仍是 v0.0.40 unified skeleton，本版只换它读的类型字段源。
- **改 5 角色 tool bound**（policy matrix）——`TOOL_POLICY` 不变，仅 `resolveRole` 输入从 `{bizType,type}` 改读 SessionKind。
- **新增 SessionKind 维度**（forked 派生 / run 级 mode / 新角色）——本版只统一现有 4 维度；`modeKey`（用户记忆中的「mode」）调研确认是 run 级 current/forked 分区，**不纳入**。
- **API 用户可见字段变化**——HTTP API 仍返 `bizType`/`type`（前端契约稳定）；变化在 session record 内部 shape（详见 §7）。
- **E2E 测试**——用户明确不做，验证靠 UT + AT。

---

## 4. 功能需求

### 4.1 S1 — 定义 `SessionKind` 类型 + 构造入口 `[v0.0.56]`

**描述**：新建 `app/shared/src/types/session-kind.ts`，定义 `Role` / `Derivation` / `SessionKind` interface + 派生 getter；`getSessionKind(sid)` 构造入口读 session record 算出身份层（自包含，不 fan-out）。

**优先级**：P0

**用户故事**：作为框架，我希望有一个**单一对象**承载 session 的全部身份维度，后续所有判别统一读它，不再各处零散 if/switch。

**期望行为（系统可见）**：

```typescript
// app/shared/src/types/session-kind.ts（新）
export type Role = 'rocky' | 'leader' | 'mate' | 'squad';
export type Derivation = 'main' | 'subagent';

export interface SessionKind {
  // 身份维度（独立存储、不互相派生；耦合→校验规则 §4.4）
  biz: 'playground' | 'studio';
  role: Role;                       // subagent 存 parent.role（bloodline）
  derivation: Derivation;           // main | subagent（独立正交）
  squadId?: string; memberId?: string; parentSessionId?: string;
  // 派生 getter（不持久化）
  readonly isStudio: boolean;              // biz === 'studio'
  readonly isSubagent: boolean;            // derivation === 'subagent'
  readonly toolPolicyRole: ToolPolicyRole; // 替代散落 resolveRole（5 值映射见 §4.1.2）
  allowedTools(parentKind?: SessionKind): string[];  // 替代 resolveTools 单 case
}
```

**4.1.1 构造入口**：`getSessionKind(sid): SessionKind` 读 session record 的 biz/role/derivation/三件套字段，建 SessionKind 身份层对象。**不 fan-out** squad/member store（身份维度自包含）。studio 完整 config（systemPrompt/tools/model）的 fan-out 由现有 `resolveSessionConfig(sid)` 负责（不在本版范围）。

**4.1.2 ToolPolicyRole 映射**（替代 tool-policy.md §2.3 resolveRole）：

| biz | role | derivation | ToolPolicyRole |
|---|---|---|---|
| playground | rocky | main | `'playground-rocky'` |
| playground | rocky | subagent | `'subagent'` |
| studio | squad | main | `'studio-squad'` |
| studio | leader | main | `'studio-leader'` |
| studio | mate | main | `'studio-mate'` |
| studio | (leader\|mate) | subagent | `'subagent'`（capByParent 时再 ∩ 父 bound） |

> playground-subagent：parent.role='rocky'，非 studio 角色 → capByParent 不生效（仅 studio-subagent ∩ 父 bound）。

**4.1.3 校验规则（S4 落 schema 写入路径）**：

| 规则 | 触发 | 行为 |
|---|---|---|
| `role ∈ {leader, mate, squad}` ⇒ `biz='studio'` | create/spawn | 400 / throw |
| `derivation='subagent'` ⇒ `parentSessionId` 必填 | spawn | throw |
| `biz='studio'` ⇒ `squadId` 必填 | create | throw |
| `role ∈ {leader, mate}` ⇒ `memberId` 必填 | create | throw |

**Use Cases**（系统级行为校验，归 UT；用户路径 AT 见 §5 P1-P5）

| ID | 校验对象 | 预期 |
|----|---------|---------|
| UC-4.1.1 | `getSessionKind(sid)` playground standalone | `{biz:'playground', role:'rocky', derivation:'main', toolPolicyRole:'playground-rocky'}` |
| UC-4.1.2 | studio-mate 派生 subagent | `{biz:'studio', role:'mate', derivation:'subagent', parentSessionId, toolPolicyRole:'subagent', isSubagent:true}` |

---

### 4.2 S2 — 删除散落字段 + 派生统一 `[v0.0.56]`

**描述**：删除 `SessionType` alias（含 `'subagent'` 值）/ `Session.type` / `Session.scope` / `subAgentConfig.parentRole` 字段；drifted 内联 union（5+ 处）统一引用 SessionKind / Role；`scope-allowed-tools.ts` 整文件删。

**优先级**：P0

**用户故事**：作为框架维护者，我希望删除「派生字段被持久化」和「双字段不变量」的负担——派生就该用的时候算，不该存。

**期望行为（系统可见 = 编译期强制）**：

- **完全删除**（TS 编译错误审计全量迁移，无读兼容层）：
  - `SessionType` alias（`app/shared/src/types/session-types.ts:27`）→ 改名 `Role`（不含 `'subagent'`）
  - `Session.type: SessionType` 字段 → 删（消费方改读 `SessionKind.role`）
  - `Session.scope` 字段 → 删（v0.0.48 后工具可见性走 `derivation` + policy；scope 与 type='subagent' 1:1 强耦合无反例）
  - `subAgentConfig.parentRole` 字段 → 删（role 已带 parent role）
  - `scope-allowed-tools.ts` 整文件 → 删（v0.0.48 已 `@deprecated` thin re-export）
  - drifted 内联 union（`schema_defs/session.ts:114`、`tool-policy.ts:106`、`message/types.ts:200` AgentRef.type、`tools/types.ts:138`、`tools/runtime-context.ts:163,185`）→ 统一引用 `SessionKind` / `Role`

- **`AgentToolRuntimeContext` 收口点**（research doc §2 注）：现有 runtime context 透传的 `selfType` / `parentScope` 已派生字段，是天然收口点——bootstrap 注入时直接读 SessionKind，下游 tool 一律改读 `ctx.kind.isSubagent` / `ctx.kind.toolPolicyRole`。

**关键机制（待 architect 落 tech spec）**：

- `app/shared/src/types/session-types.ts`：`SessionType` → `Role`（删 `'subagent'` 值）；保留 optional 语义（顶层 standalone 不填 role 即视为 `'rocky'` lazy 默认）。
- `app/server/src/agent/session-store-types.ts`：`Session` interface 删 `type` / `scope`；`subAgentConfig` 删 `parentRole`；新增 `role: Role` / `derivation: Derivation`（必填，createSession 写入）。
- `app/server/src/agent/schema_defs/session.ts`：schema 字段同步（删 type/scope/parentRole，加 role/derivation）。
- 内联 union 5+ 处：替换为 `import type { Role, SessionKind } from '...'`。
- `scope-allowed-tools.ts` 删除；下游所有 import 改向 `tool-policy.ts`。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-4.2.1 | `bun run typecheck` | 编译通过（任何遗漏的旧字段引用 = 编译错误，强制全量迁移） |
| UC-4.2.2 | grep `SessionType\|session\.scope\|subAgentConfig\.parentRole` in app/ | 零命中（除注释/历史 log） |

---

### 4.3 S3 — 45 处消费点迁移到读 SessionKind `[v0.0.56]`

**描述**：4 类约 45 处消费点全部迁移到读 `getSessionKind(sid)` 派生 getter（不再各自 `if (bizType==='studio' && type...)`）。详细 file:line 见 research doc §2，PRD 不重复。

**优先级**：P0

**用户故事**：作为框架，所有需要判别 session 类型的代码统一走一处，加新维度或改判定只动 SessionKind 一处。

**期望行为（系统可见，用户不可见 = 行为零变化）**：

- **(a) Tool 列表决策（集中，4 处）**：`tool-policy.ts.resolveRole` 删除（改读 `kind.toolPolicyRole` getter）；`resolveTools` 内部 `role` 入参从 caller 传 `kind.toolPolicyRole`；`parent-role.ts.resolveParentRole` 删除（直接读 `parent.kind.role`，仅 studio 角色再 ∩）；`scope-allowed-tools.ts` 删（已 deprecated）。
- **(b) Scope/权限门控（约 15 处）**：`agent-scope-router.ts`（已是 Role×Derivation 雏形，对齐 SessionKind 即可）；`tools/send-message/team/goal/requirement/task/squad-workitem-shared.ts` 等读 `ctx.kind.isSubagent` / `ctx.kind.role`（不再读 ctx.selfType/parentScope 已派生字段）。
- **(c) Model/Prompt（11 个 rocky_context mapper）**：共用 helper `readSessionType(ctx)` → 改名 `readSessionKind(ctx)` 返 SessionKind；改一处影响 11 个 mapper（identity/squad_role/rules/parent_task/team_roster/reachable_agents/squad_charter/squad_tasks/squad_board/squad_reminder_shared）。`session-config.ts`（studio modelId 回退 + systemPrompt 三分）改读 kind。
- **(d) UI/路由 + 数据流（约 15 处）**：`bootstrap.ts:388` + `session-debug.ts:60` 同判定硬编码副本 → 统一 `kind.isStudio && kind.role !== 'rocky'`；`chat-page/section-chat-detail.tsx`（subagent→readOnly）改读 `kind.isSubagent`；`chat-slice.ts`（bizType==='studio' 拒纳）改读 `kind.isStudio`；`studio-page/section-{member,squad}-chat.tsx`（编译期常量不变）；`listSessions` 按 `biz` 分区；`auto-naming-service.ts`（playground-only AI 起名）改读 `!kind.isStudio`；`mention/inbox-enrich/agent-tool/broadcaster/converters/{squad,member}-service` 等改读 kind。

**E2E Use Cases**（无 E2E；§5 AT 覆盖 5 条关键路径回归）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-4.3.1 | grep `bizType\s*===\|session\.type\s*[!=]==\|selfType\|parentScope` in app/ | 仅遗留注释/历史 log；生产路径零命中（全迁移到 kind.*） |

---

### 4.4 S4 + S5 — 校验规则 + dev/test 数据迁移 `[v0.0.56]`

**描述**：(a) session create/spawn 写入路径加 4 条校验规则（§4.1.3）；(b) dev/test 现有 18+ session JSON 一次性 inline 转换到新 shape（无脚本、无读兼容）。

**优先级**：P0

**期望行为**：

- **校验**：违反 4 条规则的 create/spawn 调用 throw（API 路径返 400）。校验在 schema 写入层（createSession 入口），保证持久化数据天然合法。
- **数据迁移**：coder 实现时一次性 inline 转换：
  - `biz`：从 `bizType ?? 'playground'`
  - `role`：从 `type`（'subagent' → parent.role；空 → 'rocky'）
  - `derivation`：从 `type === 'subagent' ? 'subagent' : 'main'`
  - `squadId/memberId/parentSessionId`：保留
  - **删**：`type` / `scope` / `subAgentConfig.parentRole`
- **无读兼容层**：`getSessionKind` 不处理旧 shape；任何遗漏迁移的 JSON 读时 fail（明显错误，不会被静默吞）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-4.4.1 | 启动 dev app → list sessions（playground/studio） | 现有 18+ session 全可见，分到正确 biz 列表 |
| UC-4.4.2 | 升级前用旧 session chat 正常 → 升级后继续该 session | 行为零回归 |
| UC-4.4.3 | spawn `derivation=subagent` 但缺 parentSessionId | throw（校验规则拒绝） |

---

## 5. 关键用户路径（MANDATORY — 测试最低覆盖）

> **重构·行为保持**：每条路径 = 回归守护，必须 ≥ 1 个 AT case。**无 E2E**（用户明确）；视觉保真 compare 跳过（无设计稿）。

| ID | 路径 | 涉及功能 | 测试类型 |
|----|------|---------|---------|
| **P1** | **playground 创建 → 发消息 → 收回复**：用户在 Playground tab 新建 session → POST messages → agent loop run → 收纯文本回复。验证顶层 implicit `role=rocky` + `derivation=main` 工具集（含 agent/send_message）+ DEFAULT systemPrompt 链路完整 | S1 + S3(a/c) | AT（真 LLM：POST messages → SSE listener / GET messages 收尾轮 reply 校验） |
| **P2** | **playground spawn subagent → 工具集 → 返回结果**：playground session 调 agent 工具 spawn subagent → subagent session 创建（`derivation=subagent` + `role=rocky`）→ subagent 工具集**无 `agent` 工具**（不可再 spawn）+ 有 send_message → subagent 跑完返 result → parent 收 | S1 + S2 + S3(a/b) | AT（真 LLM：spawn → subagent 跑 read/bash → final answer → parent agent.query 取回） |
| **P3** | **studio 建队 → 三角色 session 配置正确**：建 squad → 同时建 squad(SquadChat) / leader / mate 三 session → 各自 `role`/`biz=studio`/`squadId`/`memberId` 正确 → 各自 tool 列表（leader 管理工具 / mate 任务工具+agent / squad 仅 send_message）+ systemPrompt（squad 路由器 / leader 管理 / mate 执行）正确 | S1 + S3(a/c) + S4 | AT（真 LLM：建队 → 三 session GET 校验 kind 字段 + 各自 POST messages 触发对应 prompt+tools 行为） |
| **P4** | **studio mate spawn subagent → capByParent**：mate session spawn subagent → subagent session（`role=mate`+`derivation=subagent`+`parentSessionId`）→ subagent 工具集 = `subagent.bound ∩ mate.bound`（不超父 mate）→ 跑完返 result | S1 + S3(a) + S4 | AT（真 LLM：mate spawn → subagent tool 列表 GET 校验 = ∩ 父 + subagent 不能再 spawn） |
| **P5** | **list sessions 按 biz 分区**：GET /session（缺省 biz=playground）→ 不见 studio session；GET /session?bizType=studio → 不见 playground session；subagent 不出现在顶层列表（仅经 parent agent.query 可见） | S1 + S3(d) | AT（curl：先建 playground + studio session → GET 两次校验隔离） |

> AT case 落 `tests/api/session_kind/{P1..P5}_tc1/`（新增到持久化 case 库）；UT 由 coder 白盒补关键路径（getSessionKind 派生 / 校验规则 / 数据迁移 converter）。

---

## 6. 验收口径

- **功能**：S1-S5 全实现；P1-P5 关键路径 AT case 全 pass；UT 覆盖 getSessionKind 派生 + 4 条校验规则 + 数据迁移 converter。
- **API 测试**：通过率 ≥ 90%（无 5xx / schema 不合规 / 契约 hard Fail）；P1-P5 任一 fail = 阻塞合并（关键路径豁免）。
- **E2E 测试**：**不做**（用户明确）。
- **回归**：现有 dev session（18 条）升级后 list/chat/spawn 行为零变化；subagent spawn + capByParent 行为零变化；studio 三角色 prompt+tools 链路零变化。
- **数据迁移**：dev/test 启动后 `getSessionKind(sid)` 对所有 session 返合法 SessionKind；旧字段（type/scope/parentRole）在 session JSON 中零残留。
- **代码质量**：`bun run typecheck` 通过；grep `SessionType\|session\.scope\|subAgentConfig\.parentRole\|bizType\s*===` in app/ 仅遗留注释/历史 log（生产路径零命中）。

---

## 7. 与现有 ui / tech spec 的对齐（PRD 不发明概念，仅枚举改造点）

本版**不引入新 UI 概念**——UI 改动仅为「读 SessionKind 而非旧字段」（如 `chat-slice` 把 `bizType==='studio'` 改成 `kind.isStudio`），组件 spec 无新增 testid。

| spec 文件 | 章节 | 对齐改造 |
|---|---|---|
| `specs/tech/agent/session/[P0]session_store.md` | §2 Session interface | 删 `type` / `scope` / `subAgentConfig.parentRole`；加 `role: Role` + `derivation: Derivation`（必填）；§2 注释更新（lazy 默认从 type=standalone → role=rocky） |
| `specs/tech/agent/session/[P0]session_biztype.md` | §4 bizType ↔ type 关系表 | 升级为 `biz ↔ role` 校验规则（写入时 validate，字段仍独立存）；§3 传递规则不变（subagent 跟 parent biz） |
| `specs/tech/agent/tools/[P0]tool_policy.md` | §2.3 resolveRole 派生 | `resolveRole({bizType,type})` 删除 → 改读 `kind.toolPolicyRole` getter；§4.5 parentRole 流改读 `parent.kind.role` |
| `specs/tech/agent/tools/[P1]agent_tools.md` | §2 scope=EP | scope 字段删除，工具可见性走 `derivation` + policy；保留历史背景说明 |
| `specs/tech/multi_agent/[P1]subagent_derivation.md` | §2 type/scope 字段语义 | `SessionType` 含 `'subagent'` 删除 → derivation 字段；spawn 写入路径改 derivation + parent.role |
| `specs/tech/multi_agent/[P1]a2a_protocol.md` | AgentRef.type union | drift union 统一引用 `Role`（`'session'` 是否保留由 architect 定） |
| `specs/tech/squad/[P1]session_config_studio.md` | 4 scope 取法表 | 改读 SessionKind 派生；4 scope 名（standalone/leader/mate/squad）保留为语义标签 |
| `specs/tech/squad/[P1]data_model.md` + 角色文档 | leader/mate/squad session 字段 | 改用 `role`/`derivation`/`biz` 字段表达 |
| `specs/api/overall/02-llm-chat.md` 等 | Session 类型字段 | **用户契约稳定**：API 字段名保持 `bizType`/`type`（向后兼容前端）；响应 `type` 值从 enum 改为 role 字串—— 由 architect 决策 |
| `specs/ui/components/*` | UI 改读 kind.* | 无新增 testid；UI spec 仅注释更新（"bizType==='studio'" → "kind.isStudio"） |

---

## 8. overall PRD 建议改动清单（阶段 5 doc-modifier 同步，本 PRD 不直接改）

| overall 文件 | 章节 | 建议改动 |
|---|---|---|
| `specs/prd/overall/02-product-framework.md` | session 类型描述（若有） | 增量加 `[v0.0.56 modified]` 标注 SessionKind 概念；不删除原 bizType/type 描述（保留历史） |
| `specs/prd/overall/03-llm-chat.md` | subagent/session scope 相关章节 | `[v0.0.56 modified]` 标注 subagent 派生描述（type='subagent' → derivation='subagent'） |
| `specs/prd/overall/08-squad-studio.md` | 三角色 session 描述 | `[v0.0.56 modified]` 标注 leader/mate/squad session 字段（type → role+derivation） |

其他 overall 不受影响（重构·用户不可见）。

## 9. 待 architect 落 tech spec 的概念清单（PRD 不发明，仅枚举）

PRD 只描述行为，**具体字段/位置/命名由 architect 落 tech spec**：

1. **`SessionKind` interface 位置** — `app/shared/src/types/session-kind.ts` 新文件 vs 复用 `session-types.ts`。
2. **`getSessionKind(sid)` 实现位置** — session-store helper vs agent-tool-runtime-context bootstrap 注入。
3. **派生 getter 形式** — TS `get isStudio()` vs 纯函数 `isStudio(kind)`。
4. **`AgentToolRuntimeContext` 字段** — `selfType/parentScope` 收口为 `kind: SessionKind` 单字段 vs 保留多派生字段。
5. **`AgentRef.type` union 收敛**（a2a）— 5 值 vs 收敛到 `Role`。
6. **API schema 字段映射** — 响应 `type` 值如何映射（'standalone' → 'rocky' or 空？保留 'standalone' 兼容前端？）。
7. **校验规则实现位置** — schema 写入单点 vs 各 create/spawn 入口分别校验。
8. **数据迁移 inline 位置** — bootstrap 启动扫描 vs coder 跑一次性脚本。

---

## 10. 与现有 overall PRD 的关系

本版是**纯重构·用户行为保持**：§3 功能需求不受影响；仅 `02`/`03`/`08` 三篇 overall 阶段 5 加 `[v0.0.56 modified]` 标注（清单见 §8）。不新增 §3 章节文件（按 prd-spec-rules「增量更新规则 2」纯内部重构免新增）。`specs/tech/version_logs/v0.0.56-session_type/change_log.md`（architect）+ `specs/api/version_logs/v0.0.56/change_log.md`（coder，仅在有 API schema 字段映射变化时）由对应阶段产出。
