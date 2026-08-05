---
type: interface
title: Panorama agent 工具（action-based，对齐 squad_tools §0）
priority: P1
status: active
updated: 2026-08-05
since: v0.0.189.dsl_board
related: [[P1]squad_tools.md §0, [P1]panorama_dsl.md, [P1]panorama_validation.md, [P1]panorama_store.md]
---

# Panorama agent 工具 — `panorama(action, ...)` action 表

> 定位：panorama 是**单工具占 1 tool slot**，action-based 收敛风格（对齐 `[P1]squad_tools.md`）。工具 = DSL 驱动的数据读写器 + 强约束兜底（校验引擎）。
> 权威对齐基准：`[P1]squad_tools.md §0`（通用约定）。

## 0. 通用约定（对齐 squad_tools §0）

- **inputSchema.properties = LLM 参数契约**：`protocol-encode.ts:encodeTools()` 把 `inputSchema` 原样透传给 LLM（无 strict / 无 `additionalProperties:false`）。`properties` 里声明的字段 = LLM 会发的参数。**handler 读啥 flat 字段，schema 就声明啥 flat 顶层 property**（否则 LLM 不发 → write action 崩）。
- 仅 `action` 是 required；action 专属参数均 optional（具体必填由 handler 按 action 运行时校验）。
- **写操作记 lastWriteMessageId**（= 当前 message，从执行上下文自动取；caller 不直传）→ 驱动事件流 + SSE。
- **权限按 caller 角色校验**（leader / mate / user），越权 → `forbidden`。caller 上下文来自 `SessionConfig.{sessionType, squadId, memberId}`。
- 错误码 `panorama_*` 前缀（对齐 squad 的 `squad_*` / `task_*` 前缀风格）。
- **四面对齐**（`index.md ④#16` invariant）：action 参数 / DSL 字段 / HTTP 端点 payload / UI 交互一致。工具 query 读面覆盖 UI 可见字段；action 写面覆盖 UI 可编辑字段 + agent 写入需求。

## 1. 工具定义

```typescript
// 单工具定义（占 1 tool slot）
{
  name: "panorama",
  description: "业务全景看板读写：定义/读取 schema、新建/更新/跃迁/删除/查询实体实例、读事件流。破坏性 schema 变更：无存量直接过；有存量被 data_safety 拦 → 按 suggestion 重提 approved:true（引擎自动迁移）或附 migration 显式控制（narrow_enum 需 mapping）",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["define","get_schema","create","update","transition","delete","query","events"] },
      dsl: { type: "string", description: "DSL 全文（YAML），action=define 时必填" },
      dryRun: { type: "boolean", description: "action=define 时，true=只校验不落盘" },
      migration: { type: "object", description: "迁移方案（破坏性变更时）" },
      approved: { type: "boolean", description: "重大变更用户确认标记" },
      entity: { type: "string", description: "实体名" },
      id: { type: "string", description: "实例 id" },
      fields: { type: "object", description: "实例字段值（create/update 用）" },
      patch: { type: "object", description: "字段补丁（update 用）" },
      to: { type: "string", description: "目标状态（transition 用）" },
      filter: { type: "object", description: "查询过滤条件" },
      sort: { type: "object", description: "排序条件" },
      limit: { type: "number", description: "返回上限" },
      since: { type: "number", description: "事件流起始 seq" },
    },
    required: ["action"],
  },
}
```

> 全部 action 专属参数声明为 flat 顶层 property（LLM 参数契约 §0）。handler 按 action 分支读对应字段。

## 2. action 表

| action | 入参 | 谁可调 | 说明 |
|---|---|---|---|
| `define` | `dsl`(全文) + `dryRun?` + `migration?` + `approved?` | leader / user | 定义/更新 schema+views；先 dryRun 四层校验全过才落盘，失败返 `{code, path, suggestion}`。破坏性变更建议带 migration（缺省时引擎自动生成默认 plan）；重大须 approved |
| `get_schema` | — | 全员 | 读当前 DSL（改前必读） |
| `create` | `entity` + `fields{}` | 全员 | 新建实例，过校验引擎（类型/枚举/ref 闭合） |
| `update` | `entity` + `id` + `patch{}` | 全员 | 改字段过校验 |
| `transition` | `entity` + `id` + `to` | 全员 | 状态跃迁过状态机（非法 → `panorama_illegal_transition`） |
| `delete` | `entity` + `id` | 全员 | 实例物理删除 + 记 `entity.deleted` 审计事件 |
| `query` | `entity` + `filter?` + `sort?` + `limit?` | 全员 | 读实例列表 |
| `events` | `since?` + `limit?` | 全员 | 读事件流（感知用户操作 + agent 自身操作） |

### 2.1 define（schema 面，权限最高）

```
panorama({ action: "define", dsl: "<yaml>", dryRun: true })
→ { ok: true } | { ok: false, errors: [{layer, code, path, message, suggestion}] }

panorama({ action: "define", dsl: "<yaml>", dryRun: false })
→ 落盘 + { ok: true } | 不落盘 + { ok: false, errors: [...] }

panorama({ action: "define", dsl: "<yaml>", migration: {...}, approved: true })
→ 破坏性变更执行 + 落盘 + 审计
```

- **权限**：仅 leader / user 可调（mate 不可定义 schema）。schema 面是看板的结构权威，mate 不碰结构。
- **dryRun**：true = Layer 1-4 校验不落盘；false = 全过则落盘。
- **migration**：破坏性变更时提交（见 `panorama_migration.md`）；缺省时引擎对每个破坏性变更自动生成默认 operation（`planMigration`），提交的 plan 须覆盖实际变更分析（否则 `panorama_migration_mismatch`）。
- **approved**：重大变更必填 true（否则返 `panorama_breaking_change_requires_approval`）。
- **data_safety 闭环（L4 让位 migration 引擎）**：带 `migration` 或 `approved:true` = 声明迁移意图 → 跳过 Layer 4（`deferDataSafety`），破坏性变更交 migration 引擎裁决；**无迁移意图的裸提交**才由 L4 拦截。无存量数据时 L4 无可判 → 破坏性变更直接过。被 L4 拦 → 按 error 的 suggestion 重提：`approved:true` 让引擎自动生成默认 plan 迁移（archive 删除数据 / clip 越界值 / 状态值归位），或附显式 `migration` 全控（narrow_enum 必须带 mapping）。原流程 L4 硬门槛使 applyMigration 永远不可达（v0.0.189 生产实证）。
- **迁移后校验**：migration 执行后受影响实体逐实例过实例校验，不过 → 全量回滚 + `panorama_migration_postcheck`（带 violations 明细，见 `panorama_migration.md §6.4`）。
- **system entity inject 时序**（v0.0.243，反直觉但关键）：validate pass 后、applyMigration 之前调 `injectSystemEntities(parsed.schema)`。**顺序 = `validate → inject → applyMigration`**：(a) validate 先跑让 `checkSystemEntityImmutable` 看到 leader 原始提交（parser 后无 system）→ 拒字段漂移；(b) inject 在 applyMigration 前一刻跑，让 newSchema 含 canonical task → oldSchema/newSchema diff 两边都含 task → 不误判 `entity_deleted:task` 触发破坏性迁移。dryRun 路径不注入（不落盘）。详见 `[P1]panorama_builtin.md §4`。
- 写成功记 lastWriteMessageId + append `board.defined` 事件。

### 2.2 get_schema（读，全员）

```
panorama({ action: "get_schema" })
→ { dsl: "<yaml>" }
```

返回当前 board.yaml 全文（v0.0.243 起恒含 task entity + task_kanban view）。读路径走 `readSquadSchema(rtc, dataDir)` = `ensureSystemEntities(store)`：lazy migration chokepoint 保证 task entity 恒在（首次访问 squad 时建表），空 squad 也返 task-only schema（**永不返 `{ dsl: null }`**——v0.0.240 的认知割裂 agent 看不到 task 从源头修）。agent 调此 action 直接看到 task entity 定义。

### 2.3 create（数据面，全员）

```
panorama({ action: "create", entity: "pipeline_run", fields: { id: "pr-001", branch: "main", status: "queued" } })
→ { ok: true, id: "pr-001", created: true } | { ok: true, id: "pr-001", created: false } | { ok: false, errors: [...] }
```

- **skip-if-exists 幂等**：id 已存在 → 直接返 `created:false`（短路在 coerce+validate 之前，不写库 / 不 emit / 不触发 afterTaskWrite）；未命中走建路径返 `created:true`。与项目数据安全口径一致：不静默覆盖已有数据，要改用 update。
- 过校验引擎 §6（实例写校验）；写库前先经 `coerceRecord` 按声明类型无损 coerce（number↔string / boolean←"true","false"；详见 `[P1]panorama_validation.md §6.1`）。
- 状态字段缺省用 `states.initial`。
- 写成功记 lastWriteMessageId + append `entity.created` 事件 + SSE 推送。

### 2.4 update（数据面，全员）

```
panorama({ action: "update", entity: "pipeline_run", id: "pr-001", patch: { duration_sec: 180 } })
→ { ok: true } | { ok: false, errors: [...] }
```

- patch 是字段补丁，只改传入字段。
- 过校验引擎 §6（实例写校验）。
- **状态机守护**：patch 触碰 `states.field` 且值变化 → 走 §7 transition 校验（合法跃迁放行、非法拒绝返 `{code, reason, suggestion}`、同值幂等放行）——update 不能绕过状态机直改状态（对齐拖拽 / transition 路径）。
- 写成功记 lastWriteMessageId + append `entity.updated` 事件 + SSE 推送。

### 2.5 transition（数据面，全员）

```
panorama({ action: "transition", entity: "pipeline_run", id: "pr-001", to: "running" })
→ { ok: true, from: "queued", to: "running" } | { ok: false, code: "panorama_illegal_transition", reason: "..." }
```

- 过校验引擎 §7（transition 校验）：transitions 表 + terminal 锁 + guard。
- 非法跃迁拒绝 + 返回可读 reason（用于 toast / agent 自修复）。
- 写成功记 lastWriteMessageId + append `entity.transition` 事件 + SSE 推送。

### 2.6 query（读，全员）

```
panorama({ action: "query", entity: "pipeline_run", filter: { status: "running" }, sort: { field: "started_at", order: "desc" }, limit: 20 })
→ { instances: [{...}, ...] }
```

- 返回实例数组（含全部字段值）。
- filter = 字段值精确匹配（v1 不支持复杂查询表达式）。
- sort = `{ field, order: "asc"|"desc" }`。
- limit 默认 50。

### 2.7 events（读，全员）

```
panorama({ action: "events", since: 10, limit: 20 })
→ { events: [{ seq, ts, type, entity, summary, payload }, ...] }
```

- 返回事件流（`events.jsonl` 的投影）。
- since = 起始 seq（不含）；缺省 0 = 从头。
- limit 默认 50。
- 读法为 tail 语义：返回 seq > since 的事件中**最新的 limit 条**（since 翻页间隔超 limit 条时中间事件跳过）。
- 用途：agent 感知用户操作（拖拽/新建）+ 自身历史操作回顾。

### 2.8 delete（数据面，全员）

```
panorama({ action: "delete", entity: "pipeline_run", id: "pr-001" })
→ { ok: true, id: "pr-001" } | { ok: false, code: "panorama_instance_not_found" }
```

- 实例**物理删除**（removeInstance）。
- 写成功记 lastWriteMessageId + append `entity.deleted` 审计事件 + SSE 推送（action=`deleted`）。
- HTTP 侧无 DELETE 端点——实例删除仅工具入口（数据面 HTTP 仅 CRUD+transition）。

## 3. 权限矩阵

| action | leader | mate | user (HTTP) |
|--------|--------|------|-------------|
| `define` | ✅ | ❌ `forbidden` | ✅ |
| `get_schema` | ✅ | ✅ | ✅ |
| `create` | ✅ | ✅ | ✅ |
| `update` | ✅ | ✅ | ✅ |
| `transition` | ✅ | ✅ | ✅ |
| `delete` | ✅ | ✅ | ✅ |
| `query` | ✅ | ✅ | ✅ |
| `events` | ✅ | ✅ | ✅ |

schema 面（define）仅 leader/user；数据面（create/update/transition/delete/query/events）全员。

## 4. 错误码

| 错误码 | 触发 | HTTP status |
|--------|------|-------------|
| `panorama_*`（校验类） | 见 `panorama_validation.md §9` | 400 |
| `panorama_system_entity_immutable` | leader define 改系统固定 entity（task）字段与 canonical 不一致 | 400 |
| `panorama_breaking_change_requires_approval` | 重大变更未 approved | 409 |
| `panorama_migration_mismatch` | migration 方案与实际变更分析不匹配 | 400 |
| `panorama_migration_postcheck` | 迁移后实例校验不过（已回滚），响应带 violations 明细 | 400 |
| `panorama_schema_not_defined` | 数据面操作但 board 未定义 | 409 |
| `forbidden` | mate 调 define | 403 |
| `panorama_entity_not_found` | entity 名不存在 | 404 |
| `panorama_instance_not_found` | id 不存在 | 404 |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
