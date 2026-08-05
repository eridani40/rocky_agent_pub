---
type: interface
title: memory 纯读工具（read / search）
priority: P0
status: active
updated: 2026-07-26
since: v0.0.112
---

# memory 纯读工具（read / search）

> 主文档：`index.md`（① 是什么）。写侧工具见 `[P0]memory_manage_tool.md`。注入见 `[P0]memory_injection.md`。对齐样板：`../skills/[P0]skill_tool.md`（skill 纯读工具）。

> **实现落点**：`app/server/src/tools/memory.ts`（`memoryTool` 单例，registry defaultTools 注册）+ 共享读取逻辑 `app/server/src/memory/query.ts`（`readMemoryEntry` / `searchMemory`，被本工具 + `memory_manage.read` 复用）。

## 1. 概述

`memory` 是暴露给 agent 的**纯读工具**——与写侧 `memory_manage` 分离（对称 `skill` 与 `skill_manage`）。用于对话中按需加载记忆正文（progressive disclosure **L1**）：注入侧只带 `name + intro`（L0，见 `memory_injection.md`），需要正文时调 `memory.read`，需要按关键词定位时调 `memory.search`。

**与 `memory_manage` 的边界**：

| 工具 | 用途 | 返回正文？ |
|------|------|-----------|
| `memory`（本工具） | 对话中按需加载（L1）：read 取单条正文 / search 按关键词定位 | read=是；search=否 |
| `memory_manage` | 管理用（write/archive/list） | read（保留，共享本工具实现） |

## 2. 接口定义

```typescript
interface MemoryTool {
  /** 读单条完整正文（L1 按需读，等价 skill.read） */
  read(input: { scope?: MemoryScope; name: string }): MemoryEntry;
  /** 关键词定位：匹配所有字段，返回命中条目 name+intro（不含正文）。intro 由 description 改名 */
  search(input: { keyword: string; scope?: MemoryScope }): MemoryEntryMeta[];
}

/** scope 全链统一（见 memory_manage_tool §2；底层存储/query/mapper 同值直通，无映射层） */
type MemoryScope = "global" | "group" | "session";
```

| action | 入参 | 返回 | 说明 |
|--------|------|------|------|
| `read` | `{scope?, name}` | 单条 **MemoryEntry** 全文（body + why + howToApply） | scope 省略 → 先 session 后 global 命中即返（**跨 scope 严格不含 group**：group 必须显式指定，防跨组读污染） |
| `search` | `{keyword, scope?}` | **MemoryEntryMeta[]**（name + intro + scope + type，**不含 body**） | scope 省略 → 合并 session + global 两源（**group 同 read，不进跨 scope 兜底**） |

- **read vs search 边界**：只有 `read` 返回正文；`search` 只回 name+intro（定位后再 read），**避免 search 把正文倒进上下文**。
- **scope 取值**：`global | group | session`，可选。不传则跨 session + global 两源；**group 必须显式**（跨 scope 严格不含 group，防跨组数据污染，隔离 invariant 见 `memory_definition.md §2`）。
- **group ws 寻址自动完成 + 无 group 会话拒绝**：显式 `scope='group'` 时 groupWs 从 `ctx.config.squadId` / `ctx.config.sessionContext?.classroomId` 经 `resolveGroupWsDir` 自动取；缺失 → `[invalid_input] not_in_group`（与 `memory_manage` 同款文案）。
- **read 语义与 `memory_manage.read` 共享实现**：二者都调 `query.readMemoryEntry`（复用不新造，index ④ 原则 3 封装一致）。

> **实现形态注记（工具单例 + action 分派）**：上表 `read`/`search` 是**概念动作**；运行时 `memoryTool` 是**单个 Tool**，`inputSchema` 用 `action` 字段区分（`action: 'read' | 'search'` + 可选 `scope` + `name`(read) / `keyword`(search)），非两个独立方法。输出为 `textResult(JSON)`：read → `{action:'read', scope, entry}`；search → `{action:'search', keyword, count, entries}`（`tools/memory.ts run()`）。
>
> **返回类型 = query 层 scope-widened 变体**：底层 `query.readMemoryEntry` / `searchMemory` 返回 `MemoryQueryEntry` / `MemoryQueryMeta`（`memory/query.ts`）——比 store 层 `MemoryEntry`/`MemoryEntryMeta` 多带 `scope` 字段，供跨 scope 读/搜时标注命中来源（scope 全链同值直通，无映射）。正文上表的 `MemoryEntry`/`MemoryEntryMeta` 是概念表达，实际结构以 query 层变体为准。

## 3. search 匹配规则

- **全字段包含匹配**（决策 D，先简单）：keyword 对每条 entry 的 `name / intro / type / body / why / howToApply` 做**大小写不敏感子串匹配**；任一字段命中即入选。archived entry 不入选（active only）。
- **返回轻量索引**：命中条目只回 `name / intro / scope / type`（**不含 body**）。无排序 / 无相关度打分（P1 留后续）。
- **匹配正文但不返正文**：keyword 可命中 body（L0 里只有 intro），但结果不含 body——agent 定位后再 `read` 取正文。

## 4. 为什么 memory 有 L0 却仍加 search（与 skill 的差异，非矛盾）

`skill_tool.md §1` 解释 skill「不做 list」因 L0 catalog（name+intro）常驻 prompt。memory 本版本也把 L0 注入 prompt（见 `memory_injection.md §3`），却仍加 `search`，理由：

1. **session_memory 是 context tier**（`memory_injection.md §5`）——超预算时被 `budget_truncate` 裁尾，**被裁条目不在当前 L0**；`search` 兜底定位被裁记忆。
2. **search 匹配正文**：L0 只有 `intro`；用户给的关键词可能只出现在 body/why/howToApply 里，L0 索引不到，需 search 全字段匹配。

> 因此「memory 有 L0 又有 search」是刻意设计，非「与 skill 不一致」。下游勿删 search 以求对齐 skill。

## 5. 错误

| 错误 | 触发 | errorResult 前缀 |
|------|------|------------------|
| name 缺失（read） | 无 name | `[invalid_input] name is required` |
| entry 不存在（read） | scope（或跨 scope）无此 name | `[not_found] memory entry not found: <name>` |
| keyword 缺失（search） | 无 keyword | `[invalid_input] keyword is required` |
| session scope 缺 workdir | 显式 `scope='session'` 但 `ctx.config.workdir` 未注入 | `[runtime_error] session memory requires ctx.config.workdir ...` |
| group scope 缺 group | 显式 `scope='group'` 但调用方不在任何 squad/classroom | `[invalid_input] not_in_group` |

> 错误码对齐 `app/server/src/tools/types.ts ToolErrorCode`（`invalid_input` / `not_found` / `runtime_error`）。读操作不涉及治理字段（不校验 evolvable、不校验字符硬限——那是写侧约束）。

## 6. scope 上下文来源（边界解析）

scope 全链同值直通（无映射层），三源寻址：
- **`global`** → `<dataDir>/memory/`（`globalMemoryDir(dataDir)`；dataDir 经 `resolveToolDataDir(ctx)` 取）。
- **`session`** → `<ctx.config.workdir>/.rocky/memory/`（`wsMemoryDir(workdir)`；workdir = 调用方 session 自己的工作目录，input schema 不暴露，见 `memory_manage_tool.md §6`）。
- **`group`** → `<groupWs>/.rocky/memory/`，groupWs 经 `resolveGroupWsDir(dataDir, {squadId: ctx.config.squadId, classroomId: ctx.config.sessionContext?.classroomId})` 解析；缺失 → `[invalid_input] not_in_group`。

## 7. 注册范围

`memory` 读工具注册给**所有带 memory 注入的角色**（对齐 `skill` 读工具的 4 角色 bound）：`playground-rocky` / `studio-leader` / `studio-mate` / `subagent`。理由：注入翻转后 L0 只带 name+intro，任何被注入 memory L0 的 agent 都需 `memory` 工具读正文（L1）。`studio-squad` 不绑（哑路由）。→ `../tools/[P0]tool_policy.md` `TOOL_POLICY`。

## 8. 设计决策

- **独立纯读工具（决策 A）**：与 skill 对称（纯读 vs 管理分离），注入侧只暴露纯读工具给日常对话，语义清晰。
- **read 共享 memory_manage.read 实现**：单点读取逻辑（`query.readMemoryEntry`），避免两处读源漂移。
- **search 全字段包含匹配**：先简单（决策 D），排序/相关度/向量召回留 P1。
- **返回轻量索引**：search 不倒正文进上下文，守住「按需加载不撑爆」的核心价值。

> 变更历史见 `log.md` + `specs/tech/version_logs/v0.0.112.memory/change_log.md`。
