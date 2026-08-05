---
type: concept
title: SessionKind（统一身份维度：biz/role/derivation + runKind）+ SessionContext
priority: P0
status: active
updated: 2026-07-24
since: v0.0.56
---

# SessionKind + SessionContext — 统一身份维度

> 定位：session/run 的**唯一身份键**。v0.0.204 瘦身：SessionKind 只留纯身份（biz/role/derivation + run 级 runKind），实例上下文 ID 拆为 SessionContext 结伴传递；ToolPolicyRole 投影删除（职责归 SessionTypePolicy，见 `[P0]session_type_profile.md`）。
> 历史：v0.0.56 新建（biz/role/derivation 三维 + 实例 ID 混装）；v0.0.204 终版概念：forked 退役 + runKind 扁平枚举 + snapshot 可选输入。（注：v0.0.183 曾扩 academy 身份维度，academy 已于 v0.0.208 整体删除。）

## 1. 枚举（落 `app/shared/src/types/session-kind.ts`）

```typescript
export type BizType = 'playground' | 'studio';
export type Role = 'rocky' | 'leader' | 'mate' | 'squad';
export type Derivation = 'parent' | 'subagent';
//  parent = 非派生顶级 session；subagent = 由 spawn 派生的 session（v0.0.204：main→parent 改名）
export type RunKind = 'main' | 'summary' | 'consolidate';
//  run 级扁平枚举 3 值（不落盘）。v0.0.204：原 modeKey 字段并入 runKind 退役消失。
//  main=主对话 run；summary=会话压缩 run；consolidate=记忆整理 run（原 memory_extract）
```

- **runKind 三值语义**：`main`（原 modeKey='current'）/ `summary`（原 'summary'）/ `consolidate`（原 'memory_extract'）。原 modeKey 自由 string + 原 forked 概念彻底退役（类型系统无 forked、代码零 `if forked`、无 isForked / forkedRun / buildForkedDeps / ForkedContextPort / ForkedLifecyclePort / MUTED_BUS）。

## 2. SessionKind（纯身份；runKind 不落盘）

```typescript
export class SessionKind {
  readonly biz: BizType;
  readonly role: Role;
  readonly derivation: Derivation;
  readonly runKind: RunKind;   // run 级；session 落盘无此字段（由 run 入口赋予）

  /** canonical id 纯拼接（零逻辑）：4 段。
   *  playground-rocky:parent:main；studio-leader:parent:main；
   *  studio-mate:subagent:main；studio-squad:parent:consolidate
   *  同时即 scopeId（scopeIdOf = canonicalId，见 session_type_profile.md §2） */
  canonicalId(): string;

  get isStudio(): boolean;     // biz==='studio'
  get isSubagent(): boolean;   // derivation==='subagent'
  get isMainRun(): boolean;    // runKind==='main'（替原 isForked 反向）
}
```

- **落盘不变（零迁移）**：session record 仍只有 biz/role/derivation 三个必填字段；runKind 由 run 装配入口赋予（activate→main；旁路 run→summary 或 consolidate）。
- **ToolPolicyRole + toolPolicyRole getter 删除**：工具上限改由 `SessionTypePolicy.resolveToolSet` 从 profile.toolBound 读（`[P0]session_type_profile.md §6`）。
- bloodline 规则：subagent 的 role 缺省 = parent.role；spawn 可**显式指定**（来自 spawn 蓝图 `SubAgentTemplate.derivation + role`）。

## 3. SessionContext（实例上下文 ID，与 kind 结伴但分离）

```typescript
export interface SessionContext {
  squadId?: string;
  memberId?: string;
  parentSessionId?: string;   // 仅 subagent
}
```

- 来源：session record 同名字段投影（与 kind 同一构造点产出）。
- 载体：`SessionConfig.kind: SessionKind` + `SessionConfig.sessionContext: SessionContext` 两字段分离；`AgentToolRuntimeContext` 同步拆两字段（替代 v0.0.56 的 selfType/parentScope 值源）。

## 4. 构造入口

`SessionStore.getSessionKind(sid)` 与 `getSessionContext(sid)`（或合并返 `{ kind, context }`）：读 session record → 构造。run 级 runKind**不在此赋值**（record 无），由 run 装配点补：activate/buildRunDeps 置 `runKind='main'`；旁路 run 置 `runKind='summary' | 'consolidate'`（由调用入口决定）。

## 5. 校验（两层拆分，写入路径单点）

**第一层 `validateSessionKind(kind)`——形状规则（role⇒biz/derivation/runKind 边界）**：

| 规则 | 内容 |
|---|---|
| K1 | role ∈ {leader, mate, squad} ⇒ biz='studio' |
| K2 | role='rocky' ⇒ biz='playground' |
| K3 | runKind ∈ {main, summary, consolidate}（闭合枚举校验） |

**第二层 `validateSessionContext(kind, context)`——上下文存在性规则**：

| 规则 | 内容 |
|---|---|
| C1 | derivation='subagent' ⇒ parentSessionId 必填 |
| C2 | biz='studio' && derivation='parent' ⇒ squadId 必填 |
| C3 | role ∈ {leader, mate} && derivation='parent' ⇒ memberId 必填 |

调用点：`createSession` + `spawn` 写入路径。createSession 另加 **enabled 门**（`session_type_profile.md §8`）：profile 文件存在且 `enabled !== false`，否则 fail fast。

## 6. 消费链（v0.0.204 后）

1. createSession/spawn → 落盘 biz/role/derivation（不变）+ 两层校验 + enabled 门
2. `getSessionKind/getSessionContext` → bootstrap/resolveConfig 构造 `{kind, context}`
3. `SessionTypePolicy.profile(kind)` / `resolveToolSet(kind, override)` → 全部行为分岔（`session_type_profile.md §7`）
4. `kind.canonicalId()` → scopeId（纯拼接）+ trace 命名 + observability sessionKind
5. prompt mapper → 读 `ctx.config.sessionContext`（按需，如 squadId）
6. UI → kind.isSubagent/isStudio（不变）

## 7. 边界

| 零件 | 归属 |
|---|---|
| 行为契约配置层 / SessionTypePolicy / 继承 / enabled | `[P0]session_type_profile.md` ✅ |
| Session record schema（biz/role/derivation 落盘字段） | `[P0]session_store.md` + `schema_defs/session.ts` |
| 工具三层一致（resolveToolSet 消费） | `agent/tools/[P0]tool_policy.md` |
| spawn 链 / template.role / template.derivation | `multi_agent/[P1]subagent_derivation.md` + `[P1]subagent_templates.md` |
| summary/consolidate 的 snapshot 可选输入（context engine 双路径） | `[P0]context_engine.md §3.6`（待 doc-modifier 同步） |

## 8. 版本

> v0.0.56 新建；v0.0.204 终版概念（forked 退役 / runKind 扁平 3 值 / modeKey 并入 runKind / derivation main→parent 改名 / ToolPolicyRole 删除 / 实例 ID 拆 SessionContext）；v0.0.208 删 academy 板块（biz/role enum 收窄、SessionContext 去 classroomId/coachId/studentId）。变更历史见 `log.md`。
