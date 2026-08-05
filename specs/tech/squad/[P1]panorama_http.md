---
type: interface
title: Panorama HTTP + SSE 端点契约
priority: P1
status: active
updated: 2026-08-05
since: v0.0.189.dsl_board
related: [[P1]panorama_tools.md, [P1]panorama_validation.md, specs/api/overall/14-panorama-endpoints.md]
---

# Panorama HTTP + SSE 端点契约（schema 读写 + 实体 CRUD + transition + events + SSE 推送）

> 定位：panorama HTTP 端点的**框架性技术契约**（路由 / SSE 协议 / 行为）。端点级 payload/响应/错误码权威 = `specs/api/overall/14-panorama-endpoints.md`（AT 唯一依据）。
> 风格对齐 `11a-squad-endpoints.md`（端点表 + payload + 响应 + 行为 + 错误码）。

## 1. 路由前缀

所有 panorama 端点挂在 `/squad/:squadId/panorama/*` 下（squad 作用域内）。

| 方法 | 路径 | 语义 |
|------|------|------|
| `GET` | `/squad/:squadId/panorama/schema` | 读当前 DSL |
| `PUT` | `/squad/:squadId/panorama/schema` | 定义/更新 DSL（含 dryRun/migration/approved） |
| `POST` | `/squad/:squadId/panorama/schema/validate` | dry-run 校验（不落盘） |
| `GET` | `/squad/:squadId/panorama/entities/:entity` | 查询实例列表 |
| `POST` | `/squad/:squadId/panorama/entities/:entity` | 新建实例 |
| `GET` | `/squad/:squadId/panorama/entities/:entity/:id` | 读单个实例 |
| `PATCH` | `/squad/:squadId/panorama/entities/:entity/:id` | 更新实例 |
| `POST` | `/squad/:squadId/panorama/entities/:entity/:id/transition` | 状态跃迁（拖拽/工具共用） |
| `GET` | `/squad/:squadId/panorama/events` | 读事件流 |

> **path 段 decode**：`router.ts` 用 `url.pathname`（percent-encoded 不解码），panorama 路由在分发边界对正则捕获的 entity/id 段过容错 `decodeSeg`（`decodeURIComponent`，非法 `%` 序列返回原值不抛）再下放 handler——非 ASCII id（如中文）正常匹配 store。squadId 段为 ULID（ASCII）不经此 decode。对齐 cron BUG-001 / skill / plugin-scope handler 既定口径（各路由组各自在边界 decode）。

## 2. schema 读写

### 2.1 GET schema

```
GET /squad/:squadId/panorama/schema
→ 200 { dsl: "yaml..." } | 200 { dsl: null }
```

空 board（未 define）返 `{ dsl: null }`——前端据此渲 idle 空态。

### 2.2 PUT schema（define）

```
PUT /squad/:squadId/panorama/schema
Body: { dsl: "yaml...", dryRun?: boolean, migration?: {...}, approved?: boolean }
→ 200 { ok: true } | 400 { ok: false, errors: [...] } | 409 { code: "panorama_breaking_change_requires_approval", ... }
```

- 行为同 agent 工具 `define`（§panorama_tools 2.1）。
- **L4 让位 migration 引擎**：请求带 `migration` 或 `approved:true` = 声明迁移意图 → 跳过 Layer 4（`deferDataSafety`），破坏性变更交 migration 引擎裁决；无迁移意图的裸提交才由 L4 拦截（POST validate 恒跑 L4，见 §2.3）。
- 迁移后实例校验不过 → 已全量回滚，返 400 `panorama_migration_postcheck` + violations 明细（`panorama_migration.md §6.4`）。
- 校验失败 = 400 + errors 数组（不落盘）。
- 重大变更未 approved = 409。
- 落盘成功后 append `board.defined` 事件 + SSE 推送。

### 2.3 POST schema/validate（dry-run 校验端点）

```
POST /squad/:squadId/panorama/schema/validate
Body: { dsl: "yaml...", migration?: {...} }
→ 200 { ok: true, warnings: [...] } | 200 { ok: false, errors: [...], warnings: [...] }
```

纯校验不落盘。返回四层校验结果（`ok` / `errors` / `warnings`）——破坏性判定以 Layer 4 error（`panorama_dropping_*` / `panorama_enum_narrowed` 等）呈现在 errors 中，不单独返回变更分析对象。前端可用于「预检」按钮。**本端点恒跑 Layer 4 预警**（预检入口不接受 deferDataSafety——即使 body 带 migration，也只预警不裁决）。

## 3. 实体 CRUD

### 3.1 GET entities/:entity（query）

```
GET /squad/:squadId/panorama/entities/:entity?filter=status:running&sort=started_at:desc&limit=20
→ 200 { instances: [{...}, ...] }
```

query string 过滤/排序/limit（简化语法，非复杂查询表达式）。

### 3.2 POST entities/:entity（create）

```
POST /squad/:squadId/panorama/entities/:entity
Body: { fields: { id: "pr-001", branch: "main" } }
→ 201 { ok: true, id: "pr-001", created: true }   // 本次新建
  201 { ok: true, id: "pr-001", created: false }  // 幂等命中已存在（skip-if-exists，不写库）
  400 { ok: false, errors: [...] }                // 校验失败
```

**skip-if-exists 幂等**：id 已存在直接返 `created:false`（短路在 coerce+validate 之前，不写库 / 不 emit / 不触发 afterTaskWrite）。HTTP 201 = idempotent success 语义（请求成功达成目标状态，与是否本次新建无关）。详见 `14-panorama-endpoints.md §2.2`。

### 3.3 GET / PATCH / transition

```
GET /squad/:squadId/panorama/entities/:entity/:id → 200 { ...fields } | 404
PATCH /squad/:squadId/panorama/entities/:entity/:id Body: { patch: {...} } → 200 { ok: true } | 400
POST /squad/:squadId/panorama/entities/:entity/:id/transition Body: { to: "running" } → 200 { ok: true, from, to } | 400 { code: "panorama_illegal_transition", reason: "..." }
```

transition 端点 = 拖拽（UI）+ 工具共用（决策 6）。非法跃迁 = 400 + 可读 reason（前端 toast）。

**PATCH 状态机守护**：patch 含 `states.field` 且值变化 → 走 transition 校验（合法跃迁放行、非法 400 + `{code, reason, suggestion}`、同值幂等放行）——PATCH 不能绕过状态机直改状态（对齐工具 update / 拖拽路径）。实例删除无 HTTP 端点（仅工具 `delete` action）。

### 3.4 GET events

```
GET /squad/:squadId/panorama/events?since=10&limit=20
→ 200 { events: [{ seq, ts, type, entity, summary, payload }, ...] }
```

## 4. SSE 推送协议（复用现有 SSE 基建）

### 4.1 topic 设计

```
topic = "panorama"                              （hub.registerTopic 静态注册类别 + 前端 subscribe 白名单项，单源 = bootstrap-bus-phase.ts PANORAMA_TOPIC）
group = "panorama:squad:{squadId}:entity"       （per-squad 路由键；bus 按此分区，避免 squad 间事件泄漏）
```

**为什么不是 per-squad topic**：hub 的 topic 是静态注册类别（白名单校验），不支持按 squad 动态注册；per-squad 隔离走 group 路由键（对齐 session_panel 用 `group=session_id:<sid>` 的 per-session 路由模式）。

**复用现有全局单 SSE 通道**（`GET /sse` + `POST /sse/subscribe { topic, group }`，`04-agent-session.md §4`）——不另起通道，不新增连接。前端进 panorama 页时 `POST /sse/subscribe { topic: "panorama", group: "panorama:squad:{squadId}:entity" }` 订阅，离开时 unsubscribe。bus 为 non-replayable（`ReplayableEventBus({ replayable: false })`）。

### 4.2 事件 shape

```json
{
  "type": "panorama_entity_update",
  "squadId": "...",
  "entity": "pipeline_run",
  "action": "created" | "updated" | "transitioned",
  "id": "pr-001",
  "record": { ...fields },
  "transition": { "from": "queued", "to": "running" },
  "source": "agent" | "drag" | "api",
  "seq": 42
}
```

- 每次 create/update/transition 成功后，引擎 append `events.jsonl` + emit 此 SSE 事件。
- 前端收到后：乐观更新已有数据（卡片移动/新增/字段刷新）+ 事件流面板追加条目。
- `source` 区分 agent vs 用户操作（双向工作面，PRD 路径 P7）。
- define（schema 变更）走单独事件：`type: "panorama_schema_update"`，前端收到后重新拉 schema + 重建视图。

### 4.3 schema 变更 SSE

```json
{
  "type": "panorama_schema_update",
  "squadId": "...",
  "seq": 42
}
```

前端收到后 `GET /squad/:squadId/panorama/schema` 拉最新 DSL + 重建视图（tab/列/卡片模板可能变了）。

## 5. 错误码汇总

| 错误码 | HTTP status | 说明 |
|--------|-------------|------|
| `panorama_*`（校验类） | 400 | 见 `panorama_validation.md §9` |
| `panorama_breaking_change_requires_approval` | 409 | 重大变更未 approved |
| `panorama_migration_mismatch` | 400 | migration 方案与实际变更分析不匹配 |
| `panorama_migration_postcheck` | 400 | 迁移后实例校验不过（已回滚），响应带 violations 明细 |
| `panorama_schema_not_defined` | 409 | 数据面操作但 board 未定义 |
| `panorama_entity_not_found` | 404 | entity 名不存在 |
| `panorama_instance_not_found` | 404 | 实例 id 不存在 |
| `forbidden` | 403 | 权限不足（mate 调 schema 面） |
| `squad_not_found` | 404 | squad 不存在 |

## 6. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| 路由前缀 + SSE topic 设计 + 事件 shape + schema 变更 SSE | 本文 ✅ |
| 端点级 payload/响应/行为权威（AT 唯一依据） | `specs/api/overall/14-panorama-endpoints.md` |
| 校验逻辑（每个端点写入前跑的校验引擎） | `[P1]panorama_validation.md` |
| agent 工具（与 HTTP 同规则、同校验器） | `[P1]panorama_tools.md` |
| SSE 通道基建（GET /sse + subscribe/unsubscribe） | `specs/tech/app/frontend/[P0]sse_channel.md` + `04-agent-session.md §4` |
| 存储（board.yaml / entities / events.jsonl 读写） | `[P1]panorama_store.md` |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
