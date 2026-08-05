---
type: change_log
version: v0.0.56
title: SessionKind 统一 session 身份维度（含 hotfix 彻底迁移）
updated: 2026-07-03
---

# v0.0.56 · SessionKind 统一 session 身份维度

> 把 session 散落的类型维度（bizType / type-role / scope / subagent / parentRole）统一成**单一 `SessionKind` 对象**——session 构建时一次产出，后续约 45 处消费点统一读它；用户侧行为不变。
> 权威需求：`reqs/[done] v0.0.56.session_type/req.md` + `specs/research/session-kind.md`（调研 + 定稿设计）

## 背景：半迁移问题

v0.0.56 初版有半迁移问题——`resolveTools` 入参仍是 `role + parentRole`（需 caller 算好传入），`SessionKind` 仅有 `toolPolicyRole` getter，capByParent 还要 `parentRole` 字段持久化 + `parent-role.ts` 函数派生。这造成 SessionKind 没有真正成为消费点的唯一入口，调用方仍需自行派生 role / parentRole。

hotfix 做了 7 步彻底改造，让 SessionKind 成为**真正的单一入口**。

## hotfix 7 步变化

### 1. SessionKind class（`specs/tech/agent/session/[P0]session_kind.md`）

- **删** `ResolveToolsFn` 类型 + `SessionKind.allowedTools(parentKind?)` 方法（死代码——所有调用方都直接调 `resolveTools({kind, ...})`，没人走 `kind.allowedTools()`）。
- **加** `parentToolPolicyRole` getter：`derivation='subagent'` 时返回 `${biz}-${role}`（studio-leader/studio-mate/playground-rocky），否则 undefined。
- **改** capByParent 描述：从 kind 纯派生（用 `kind.parentToolPolicyRole`），**不读 parent session、不需 parentRole 字段、不需 parentKind 入参**。
- 强调：`kind` 在所有消费点**必传**（非可选），无 fallback。
- SessionKind 从 `interface` 改为 `class`（构造函数 + readonly 字段）。

### 2. tool_policy（`specs/tech/agent/tools/[P0]tool_policy.md`）

- **删** `resolveRole()` 函数 + `ResolveRoleInput` 类型（旧 `{bizType,type}` 派生已删）。
- **删** `resolveParentRole(parent)` 函数 + `parent-role.ts` 文件（capByParent 不再独立派生 parent role）。
- **改** `resolveTools` 签名：接 `kind: SessionKind`（替代 `role` + `parentRole` 入参）；内部 `kind.toolPolicyRole` 派生 role，`kind.parentToolPolicyRole` 派生 parentRole。
- capByParent 分支：用 `kind.parentToolPolicyRole`，删 parentRole 入参描述。
- 标注 `ToolPolicyRole` 类型在 @app/shared（概念权威，本文件仅 re-export）。

### 3. session_store（`specs/tech/agent/session/[P0]session_store.md`）

- Session 接口：**删** `type?`/`scope?`/`bizType?` 字段描述；**删** `subAgentConfig.parentRole`（v0.0.56 初版已加 [v0.0.56] 注释，hotfix 确认彻底删除）。
- 确认只有 `biz`/`role`/`derivation`（必填）+ squadId/memberId/parentSessionId。

### 4. session_config_studio（`specs/tech/squad/[P1]session_config_studio.md`）

- `buildSessionConfigFromDeps`：`kind` 必传，删所有 fallback 描述。
- §3.1 tools 取法：`resolveTools(role='studio-leader'|'studio-mate')` → `resolveTools(kind)`（role 由 kind.toolPolicyRole 派生）。
- SessionConfig 删 `sessionType` 字段（若有残留描述）。

### 5. session_biztype（`specs/tech/agent/session/[P0]session_biztype.md`）

- 确认 4 条校验规则描述准确（role∈{leader,mate,squad}⇒biz=studio 等）。
- §2 bizType?:（optional 空=playground）→ biz:（必填，无 lazy 默认）；概念类型名 `BizType` 不变。

### 6. data_model（`specs/tech/squad/[P1]data_model.md`）

- session 字段：type/bizType/parentRole → role+derivation+biz（narrative 订正：§1.4 命名体系、§2.2/§2.3 双向关联、§4/§5 建队/hire 流程）。
- §2.3 lazy 默认 bizType=playground → biz 必填（数据迁移消除）。

### 7. 其他

- `specs/tech/agent/tools/[P1]agent_tools.md`：scope 字段已删（v0.0.56 初版已声明，hotfix 确认）。
- `specs/tech/multi_agent/[P1]subagent_derivation.md`：spawn 不算 parentRole；capByParent 用 `kind.parentToolPolicyRole`；§2 type 与 subAgentTemplateType 正交→derivation 与 subAgentTemplateType 正交。
- `specs/tech/multi_agent/[P1]a2a_protocol.md`：AgentRef.type 来自 `session.role + session.derivation`（确认 Role|'subagent'）；§6 工具层校验 `caller.scope` → `caller.kind.isSubagent`（scope 字段已删）。

## 关键设计原则（hotfix 后）

1. **SessionKind 是 class，不是 interface**——构造函数接收 `SessionKindInput`，7 字段直赋。
2. **kind 在所有消费点必传**——`resolveTools({kind, ...})`，无 fallback。调用方有责任构造 kind 传入。
3. **capByParent 从 kind 纯派生**——`kind.parentToolPolicyRole`（subagent → `${biz}-${role}` bloodline），不读 parent session record、不需 parentRole 字段持久化、不需 parentKind 入参。
4. **ToolPolicyRole 类型在 @app/shared**（session-kind.ts），tool-policy.ts 仅 re-export。SessionKind 是此类型的产出者（toolPolicyRole / parentToolPolicyRole 两个 getter）。
5. **SessionKind 不依赖 tool-policy.ts**——纯数据 + 派生 getter，不持有 resolveTools 函数引用（旧 `ResolveToolsFn` 依赖注入已删）。

## 影响范围

- 4 个 KB 的 spec 文件更新（agent/session, agent/tools, squad, multi_agent）。
- 4 个 KB 的 log.md 追加 hotfix 条目。
- 跨版本 change_log（本文件）记录 hotfix 全貌。
- 不改 app/ 代码（代码已 commit 完成，spec 落后对齐）。
