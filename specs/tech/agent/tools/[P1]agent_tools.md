---
type: spec
title: Agent Tools（multi-agent 派生/管理 — agent 工具）
priority: P1
status: active
updated: 2026-07-30
since: v0.0.28
---

# Agent Tools（multi-agent 派生/管理 — `agent` 工具）

定位：multi-agent 层的 **agent 派生与管理工具**——让一个 agent 编排 sub-agent（独立 session，usage 以 sub 上报 parent）。**权威定义在本文**；squad 层（`specs/tech/squad/[P1]squad_tools.md §6`）将来复用本文 `agent` 工具，不重复定义。
范围：**只 multi_agent（parent↔subagent 派生）**。不含 squad/角色/团队层工具（team/task/goal/requirement 等，见 squad_tools）。
参考：`specs/tech/multi_agent/[P1]subagent_derivation.md`（§4 spawn 契约 / §7 管理）+ `[P1]subagent_templates.md`（模板）+ `[P1]a2a_protocol.md`（寻址）；scope 实现 `specs/tech/config/[P0]ext_impl_scope.md`。
设计对照：Claude Code `Task` 工具（同步派生 + 隔离上下文）。

---

## 1. 概述：一个工具，三个 action

agent 派生/管理功能**收敛为单工具 `agent`**，3 个 action：`spawn` / `query` / `abort`。少占 LLM tool slot（tool definition 是稀缺资源），action 名贴近真实派生/管理动词。

| 工具 | action | 入参 | 返回 | 语义 |
|---|---|---|---|---|
| `agent` | `spawn` | `SpawnAgentInput`（derivation §4） | `SpawnAgentResult`（sync/async 联合） | 创建 sub-agent + 首任务 + sync/async（原 spawn_agent） |
| `agent` | `query` | `{ ref? }` 或 `{ filter: {status?, templateType?, limit?} }` | 单详情 或 列表 | **list + query 合并**：带 ref → 单 child 详情（usage/lastUpdatedAt）；不带 → 列表（按 lastUpdatedAt 倒序，limit 默认 20） |
| `agent` | `abort` | `{ ref }` | ack | 主动中断自己派的 child（原 abort_agent） |

- **`agent.spawn` 契约**：`SpawnAgentInput` / `SpawnAgentResult` / 执行流程 / sync·async 结果送达 → 权威见 `[P1]subagent_derivation.md §4`（本文不重复）。
- **`agent.query` + `agent.abort` 契约**：list_children 筛选/限量 + query_agent 单查 + abort_agent → 权威见 `[P1]subagent_derivation.md §7`（本文不重复）。
- **可达性**：sub-agent 只对 parent 可达（拓扑硬约束，a2a_protocol §3）；`agent.query/abort` 仅作用于自己派的 child（不跨 parent）。

---

## 2. 工具可见性 = profile.toolBound 单源（v0.0.204 起）

> **工具是 extension point**；可见集由 `SessionTypePolicy.resolveToolSet(kind)` 从 `app/plugins/session-types/*.yaml` 的 `toolBound` 字段产出（profile 单源）。subagent 类型 profile 的 toolBound **不含 `agent` 工具** → subagent 结构上**不可再创建 subagent**（满足需求「subagent 不再可以创建 subagent」）。
> v0.0.204 前：scope 字段（v0.0.56 删）+ TOOL_POLICY TS 常量 + filterToolDefinitionsBySessionType/deriveAllowedTools 双层门控——全被 profile.toolBound + resolveToolSet 替代（详见 `[P0]tool_policy.md`）。

### 2.1 概念模型

```
工具 = extension point（每个 tool 是一个 EP impl）
可见集 = SessionTypePolicy.profile(kind).toolBound（per-SessionKind 组合一份 yaml）

parent/main 类型 profile：toolBound 含 `agent` 工具 → 可派生 subagent
subagent 类型 profile ：toolBound 不含 `agent` 工具 → 结构上无法再派生
```

- **parent/main 类型**（playground-rocky:parent:main / studio-squad:parent:main 等）：toolBound 含 `agent` → 可派生 sub-agent。
- **subagent 类型**（*.subagent.main）：toolBound **不含 `agent`** → **结构上无法再派生**（不是靠 prompt 劝说，是工具层硬约束）。

### 2.2 实现路径（resolveToolSet 三层一致，profile 单源）

> **v0.0.204 起**：工具可见性 = `SessionTypePolicy.resolveToolSet(kind, instanceOverride)` 单方法产出三件套（tools / toolDefinitions / allowedTools，保注册序 + 剔幽灵名）。三层一致（config 层 `buildSessionConfigFromDeps` 算 config.tools / schema 层 spec.toolDefinitions 给 LLM / exec 层 spec.allowedTools 门控）同源产出，无独立裁剪。详见 `[P0]tool_policy.md §3`。

- **schema 层**：assemble 进 `snapshot.tools` 给 LLM 看的 toolDefinitions = resolveToolSet 产出的 toolDefinitions（subagent 类型不含 `agent` 工具定义 → LLM 根本看不到）。
- **exec 层门控**：buildRunDeps 派生 spec.allowedTools = resolveToolSet 产出的 allowedTools；engine.execute 对不在 allowedTools 的 toolCall → 拒绝 result（统一 code `tool_not_allowed`，见 `tool_execution_engine.md §3.1`）。
- **subagent 实例 override**（`tools` 三态）：spawn 时 `subAgentConfig.tools`（= eff.tools = input.tools ?? template?.tools）作为 instanceOverride 传入 resolveToolSet，最终 = `instanceOverride.tools !== undefined ? (instanceOverride.tools ∩ bound) : new Set(bound)`——**undefined**（spawn 不传 tools 且模板无 tools）= 继承 subagent profile toolBound 全集（默认）/ **[]** = 显式空（交集空集）/ **非空** = 与 bound 取交集。优先级：spawn input > template > profile bound（前两者均不传时落到 profile bound 全集，而非空集）。

> **两层叠加不重叠职责**：schema 层让 LLM 看不到（减少误调 + 省 tool slot），执行层 allowedTools 兜底（防 LLM 强行构造 toolCall）。两层都排除 `agent` 工具，但走不同 chokepoint。

### 2.3 scope 工具可见性表（v0.0.204 后）

| kind | `agent` 工具（执行层） | `agent` 工具（schema 层） | 其他工具（read/web_search/...） | send_message |
|---|---|---|---|---|
| parent/main | ✅ 允许执行（可派生） | ✅ 可见 | ✅ | ✅（可达 parent/squad） |
| subagent | ❌ 执行层拒（tool_not_allowed） | ❌ schema 层裁剪（LLM 看不到） | ✅（按 instanceOverride ∩ bound） | ✅（仅可达 parent，拓扑硬约束） |

> 「可见性」分两层：**schema 层**（LLM 看到的 toolDefinitions）+ **执行层**（allowedTools 白名单）。两层都不含 `agent` 工具——subagent 既看不到也调不出（不可派生）。

---

## 3. 边界

| 零件 | 归属 |
|---|---|
| `agent` 工具定义（spawn/query/abort action 表 + 收敛原则） | 本文 §1 ✅ |
| 工具可见性 = profile.toolBound 单源 + subagent 不可再派生 | 本文 §2 + `[P0]tool_policy.md` ✅ |
| `agent.spawn` 契约（SpawnAgentInput/Result/流程） | `[P1]subagent_derivation.md §4` |
| `agent.query/abort` 契约（list_children 筛选/单查/中断） | `[P1]subagent_derivation.md §7` |
| spawn 时 model 解析（模板带 modelId / 自定义 inherit） | `[P1]subagent_templates.md` + derivation §4 |
| scope 体系（PluginScopeStore/ScopeActivationStore/双重载/CRUD） | `[P0]ext_impl_scope.md` |
| 子 agent 的 usage 归属（current/sub/forked 桶） | `../session/[P0]session_usage.md §6.2` |
| 旁路 run（summary/consolidate 内部机制，不入 LLM 工具集） | `../agent_interface_and_loop/[P0]agent_loop_side_run.md` |
| 工具调度执行 | `tool_execution_engine.md` |
| squad 层 agent 工具复用 | `specs/tech/squad/[P1]squad_tools.md §6`（引用本文） |

---

## 4. 待定（非阻断）

- `agent` 工具的 LLM-facing schema 细化（action enum + 各 action input schema）→ coder 实现时按 derivation §4/§7 契约落地。

---

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
