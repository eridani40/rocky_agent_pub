# Panorama 端点契约（业务全景 — schema 读写 + 实体 CRUD + transition + events）

> version: 1.5 · 引入版本 v0.0.189.dsl_board · 2026-08-05（v1.5：v0.0.259 — POST entities 改 skip-if-exists 幂等 + response 加 `created:boolean` 字段；实例写前 `coerceRecord` 按声明类型无损转换 number↔string / boolean←"true","false"；语义层 view.entity / ref.entity 可直接引用 system entity（task）无需 entities 声明；`panorama_duplicate_id` 从 create 路径消失）。v1.4：v0.0.243 — task 改普通 entity + system 标记：`GET schema` 返含 task entity 的 DSL（v0.0.240 返纯 leader DSL 不含 builtin，v0.0.243 返含 task，task 落盘进 board.yaml）；空 board 也返 task-only schema（永不 null）；PUT schema 落盘含 task；validate / PUT 加 `panorama_system_entity_immutable` 错误码——leader 改 task schema 字段拒；前端镜像 builtin task 常量废除）。v1.3：v0.0.240 — builtin schema 通道 + view.filter + 归档字段 + task 自动依赖 hook。v1.2：PUT schema 带 migration/approved 意图跳 L4；PATCH 状态机守护；补 `panorama_migration_postcheck`；实例删除仅工具 `delete` action 无 HTTP 端点。v1.1：SSE 订阅改 topic=`panorama` + per-squad group 路由键。
> 管什么：panorama 全部 HTTP 端点的**端点级契约**（payload / 响应 / 行为 / 错误码）。
> 不管什么：DSL 字段级 schema（→ `specs/tech/squad/[P1]panorama_dsl.md`）；校验四层规则（→ `[P1]panorama_validation.md`）；system entity 注入/lazy migration 机制（→ `[P1]panorama_builtin.md`）；SSE topic 协议（→ `[P1]panorama_http.md §4`）。
> **本文件是 AT（API Test）panorama 端点的唯一依据**：api-verifier 黑盒 HTTP，不读代码。
>
> **权威概念源**：`specs/tech/squad/[P1]panorama_http.md`（框架）+ `[P1]panorama_dsl.md`（DSL schema）+ `[P1]panorama_validation.md`（校验）+ `[P1]panorama_migration.md`（迁移）+ `[P1]panorama_builtin.md`（task 普通 entity + system 标记 + lazy migration）。
> 风格对齐 `11a-squad-endpoints.md`（端点表 + TypeScript payload + 行为 + 错误码）。

---

## 1. Schema 读写

### 1.1 `GET /squad/:squadId/panorama/schema` — 读 DSL

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/squad/:squadId/panorama/schema` | 读当前 DSL 全文 | 无 | `200` + `{ dsl: string }` |

- v0.0.243 起响应 `dsl` **恒含 task entity + task_kanban view**（task 落盘进 board.yaml，和 book 平级）。后端走 `readSquadSchema(ctx)` = `ensureSystemEntities(store)`：lazy migration chokepoint 保证 task entity 恒在（首次访问 squad 时建表）。
- 空 board（leader 未 define）→ `200 { dsl: <task-only DSL> }`（建 `{meta, entities:{task}, views:[task_kanban]}` 落盘返）。**永不返 `{ dsl: null }`**（v0.0.240 的认知割裂——agent 看不到 task——从源头修）。
- **task entity 标记 `system: true`**：前端据此 + 校验层 `checkSystemEntityImmutable` 共同保护 task schema 不被 leader 改（详见 `[P1]panorama_builtin.md §4`）。

**错误**：`404` squad 不存在。

### 1.2 `PUT /squad/:squadId/panorama/schema` — 定义/更新 DSL

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `PUT` | `/squad/:squadId/panorama/schema` | 定义/更新 schema+views（四层校验 + 迁移） | `PutSchemaBody` | `200` + `{ ok: true }` |

```typescript
interface PutSchemaBody {
  dsl: string;                       // DSL 全文（YAML）
  dryRun?: boolean;                  // true = 只校验不落盘
  migration?: {                      // 破坏性变更时提交（缺省引擎自动生成默认 plan）
    operations: MigrationOperation[];
  };
  approved?: boolean;                // 重大变更须 true
}
```

**行为**：
1. 跑四层校验（Layer 1 短路 → 2-3 收集 → 4 数据安全，见 `panorama_validation.md §1.1`）。**带 `migration` 或 `approved:true` = 迁移意图 → 跳过 Layer 4**（deferDataSafety），破坏性变更交 migration 引擎裁决；无迁移意图的裸提交才由 L4 拦截。Layer 2.5 `checkSystemEntityImmutable`：leader 提交的 task entity 字段（parser 后无 system）与 canonical 不一致 → 400 `panorama_system_entity_immutable`（path=`entities.task`）。
2. dryRun=true → 返回校验结果，不落盘。
3. dryRun=false → validate pass 后、applyMigration 之前调 `injectSystemEntities`（强制 newSchema 含 canonical task，让 diff 两边都含 task 不误判 `entity_deleted:task`）→ 全过则落盘 board.yaml（task 带 system:true）+ append `board.defined` 事件 + SSE 推送 `panorama_schema_update`。
4. 破坏性变更未提交 migration → 400（Layer 4 error）。
5. 重大变更未 approved → 409 `panorama_breaking_change_requires_approval`。
6. migration 执行后受影响实体逐实例过实例校验，不过 → 全量回滚 + 400 `panorama_migration_postcheck`（带 violations 明细）。

**错误**：
- `400` 校验失败（`{ ok: false, errors: [{layer, code, path, message, suggestion}] }`）。
- `400` leader 改系统固定 entity 字段（`{ code: "panorama_system_entity_immutable", path: "entities.task", ... }`）。
- `400` migration 方案与实际变更分析不匹配（`{ code: "panorama_migration_mismatch", message }`）。
- `400` 迁移后实例校验不过已回滚（`{ code: "panorama_migration_postcheck", message, violations }`）。
- `409` 重大变更未 approved（`{ code: "panorama_breaking_change_requires_approval" }`）。
- `403` 非 leader/user 调用（mate 不可定义 schema）。
- `404` squad 不存在。

### 1.3 `POST /squad/:squadId/panorama/schema/validate` — dry-run 校验

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/squad/:squadId/panorama/schema/validate` | 纯校验不落盘（预检） | `{ dsl: string, migration?: {...} }` | `200` + `ValidationResult` |

```typescript
interface ValidationResult {
  ok: boolean;
  errors: ValidationError[];
  warnings?: ValidationWarning[];
}
```

**本端点恒跑 Layer 4 预警**（预检入口，不接受 deferDataSafety——body 带 migration 也只预警不裁决、不执行迁移）。Layer 2.5 `checkSystemEntityImmutable` 同样生效（leader 提交 task 字段与 canonical 不一致 → `panorama_system_entity_immutable`）。

---

## 2. 实体 CRUD

> **path 参数 URL-decode**：`:entity` / `:id` 由服务端在路由边界容错 `decodeURIComponent` 解码——非 ASCII id（如中文）正常工作（web 侧 `encodeURIComponent` 编码，服务端解码；非法 `%` 序列原样透传不抛）。squadId 路径段为 ULID（ASCII），不经此 decode。

### 2.1 `GET /squad/:squadId/panorama/entities/:entity` — 查询实例

| 方法 | 路径 | 语义 | Query 参数 | 成功响应 |
|------|------|------|-----------|---------|
| `GET` | `/squad/:squadId/panorama/entities/:entity` | 查询实体实例列表 | `filter?` `sort?` `limit?` | `200` + `{ instances: Record<string,unknown>[] }` |

- `filter` = `field:value`（精确匹配，可多个用逗号）。
- `sort` = `field:asc|desc`。
- `limit` = number（默认 50）。
- **view.filter 透传（v0.0.240）**：前端 fetch 时若 view 声明了 `filter`（`panorama_dsl.md §5.0`），序列化为 `?filter=k:v,k2:v2` 透传。例：task view `{ filter: { archived: false } }` → `GET entities/task?filter=archived:false`。用户切「含归档」开关 → 前端不传 filter（看全部）。
- **task entity（v0.0.243）**：task 是**普通 entity**（落盘进 board.yaml，system:true 标记），`entity=task` 永远可查——`readSquadSchema` 的 `ensureSystemEntities` 兜底（lazy migration chokepoint），即便 leader 未 define 任何 entity，task 仍在 schema 内。

**错误**：`404` entity 不存在 / squad 不存在；`409` schema 未定义（`panorama_schema_not_defined`，**task entity 例外**——system ensure 兜底永远 defined）。

### 2.2 `POST /squad/:squadId/panorama/entities/:entity` — 新建实例

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/squad/:squadId/panorama/entities/:entity` | 新建实例（幂等 skip-if-exists） | `{ fields: Record<string,unknown> }` | `201` + `{ ok: true, id: string, created: boolean }` |

**行为**：
1. **幂等短路（skip-if-exists）**：id 已存在 → 直接返 `201 { ok:true, id, created:false }`，**不写库 / 不 emit entity.created / 不触发 afterTaskWrite**（idempotent success 语义——请求成功达成目标状态，即便未实际新建；与项目数据安全口径一致：不静默覆盖已有数据，要改用 PATCH）。短路在 coerce+validate 之前（幂等命中不触发校验）。
2. 未命中走建路径：`applyFieldDefaults`（states.initial 缺省 + boolean 字段默认 false）→ `coerceRecord`（按声明类型无损 coerce：number↔string / boolean←"true","false"；有损/不合法值保留原值交下游 check）→ 实例写校验（类型/枚举/ref/required）→ 落盘 + `entity.created` 事件 + SSE 推送 → 返 `201 { ok:true, id, created:true }`。
3. id 字段缺失（`fields[id_field]` 为空）→ `400 panorama_missing_required`（短路前判定）。

**错误**：`400` 校验失败；`409` schema 未定义；`404` entity 不存在。

> **`panorama_duplicate_id` 不从本端点产出**（v0.0.259 起 create 改 skip-if-exists，id 冲突走幂等短路而非报错；该码仅作 update 路径历史保留，实例写校验表已无此码）。

### 2.3 `GET /squad/:squadId/panorama/entities/:entity/:id` — 读单实例

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/squad/:squadId/panorama/entities/:entity/:id` | 读单个实例 | `200` + `Record<string,unknown>` |

**错误**：`404` 实例/entity/squad 不存在。

### 2.4 `PATCH /squad/:squadId/panorama/entities/:entity/:id` — 更新实例

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `PATCH` | `/squad/:squadId/panorama/entities/:entity/:id` | 字段补丁更新 | `{ patch: Record<string,unknown> }` | `200` + `{ ok: true }` |

**行为**：只改 patch 传入字段（与 existing merge）→ `coerceRecord`（按声明类型无损 coerce merged record，覆盖 update 路径：如 PATCH `{count:"1928"}` 与库里 number merge 后再 coerce 写回一致类型）→ 过实例写校验引擎。**状态机守护**：patch 含 `states.field` 且值变化 → 走 transition 校验（合法跃迁放行、非法 400 + `{code, reason, suggestion}`、同值幂等放行）——PATCH 不能绕过状态机直改状态。写成功 append `entity.updated` + SSE 推送。

- **归档（v0.0.240）**：PATCH `archived:true` 即归档（普通 boolean 字段更新，无新端点）。task entity 的 `archived` 字段是系统固定 entity schema 的一部分（`TASK_ENTITY_DEF.fields.archived`，`[P1]panorama_builtin.md §2.1`，task 落盘进 board.yaml）；leader DSL entity 想要归档能力需自行声明 `archived: { type: boolean }` 字段。归档后 view 默认过滤隐藏（view.filter `{ archived:false }`），切「含归档」可见。
- **task 自动依赖 transition（v0.0.240）**：PATCH 触碰 task 的 `dependencies` 字段后，后置 hook `afterTaskWrite` 重算受影响 task 的 waiting/todo 状态（依赖未满足→waiting / 全 done→todo），用 `source=system` 写 `entity.transition` 事件 + SSE 推送（`[P1]panorama_builtin.md §6`）。前端收到 SSE `source=system` 的 transition 事件时正常乐观更新。

**错误**：`400` 校验失败；`404` 实例不存在。

> 实例**删除**无 HTTP 端点——仅 agent 工具 `panorama(action="delete", entity, id)`（物理删除 + `entity.deleted` 审计事件 + SSE `action=deleted`）。

### 2.5 `POST /squad/:squadId/panorama/entities/:entity/:id/transition` — 状态跃迁

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/squad/:squadId/panorama/entities/:entity/:id/transition` | 状态跃迁（拖拽/工具共用） | `{ to: string }` | `200` + `{ ok: true, from: string, to: string }` |

**行为**：过 transition 校验（transitions 表 + terminal 锁 + guard）。非法跃迁 = 400 + 可读 reason。写成功 append `entity.transition` + SSE 推送。

**错误**：`400 { code: "panorama_illegal_transition", reason: "..." }`；`400 { code: "panorama_terminal_locked" }`；`400 { code: "panorama_guard_failed", ... }`；`404` 实例不存在。

---

## 3. 事件流

### 3.1 `GET /squad/:squadId/panorama/events` — 读事件流

| 方法 | 路径 | 语义 | Query 参数 | 成功响应 |
|------|------|------|-----------|---------|
| `GET` | `/squad/:squadId/panorama/events` | 读 append-only 事件流 | `since?` `limit?` | `200` + `{ events: PanoramaEvent[] }` |

```typescript
interface PanoramaEvent {
  seq: number;
  ts: string;            // ISO 8601
  type: string;          // board.defined / entity.created / entity.updated / entity.transition / entity.deleted / migration.executed
  entity: string;
  id?: string;           // 实例 id（entity.* 事件）
  summary?: string;
  payload: Record<string, unknown>;
  source?: string;       // agent / drag / api / user / system
  messageId?: string | null;
}
```

- `since` = 起始 seq（不含）；缺省从头。
- `limit` = number（默认 50）。tail 语义：返回 seq > since 的最新 limit 条。

**错误**：`404` squad 不存在。

---

## 4. SSE 推送

详见 `specs/tech/squad/[P1]panorama_http.md §4`。前端进 panorama 页时 `POST /sse/subscribe { topic: "panorama", group: "panorama:squad:{squadId}:entity" }`（topic = 静态注册类别；per-squad 隔离走 group 路由键），收到 `panorama_entity_update` / `panorama_schema_update` 事件后乐观更新。

---

## 5. PRD 路径 → API 映射

### 5.1 v0.0.189.dsl_board（首发）

| PRD 路径 | 覆盖端点 |
|----------|---------|
| P2 leader 定义 DSL + 修复回路 | PUT schema + POST schema/validate |
| P4 拖拽合法跃迁 | POST transition |
| P5 非法跃迁拒绝 | POST transition（400 error） |
| P6 弹层新建/编辑 | POST entities + PATCH entities |
| P7 agent 写入触发 SSE | POST entities/transition + SSE 推送 |
| P8 增量变更 | PUT schema（无 migration） |
| P9 破坏性变更 + 迁移 | PUT schema（migration + approved） |

### 5.2 v0.0.240 squad_task

| PRD 路径 | 覆盖端点 |
|----------|---------|
| P1.T1 agent create task（含 dependencies 自动 waiting） | POST entities/task + hook 自动 transition（SSE `source=system`） |
| P1.T2 依赖 task done → 被依赖 task 自动 todo | POST transition（done）+ hook 自动 transition |
| P1.A1 卡片归档按钮 | PATCH entities/task `{patch:{archived:true}}` |
| P1.A2 切「含归档」开关 | GET entities/task（filter override：`?filter=` 留空 vs `archived:false`） |
| P1.E1 leader DSL 写带 filter 的 table view | PUT schema（view 加 filter 字段，无破坏性）+ GET entities（前端透传 filter） |
| P1.E2 task 表头中文 | GET schema（task display.status_labels 配死中文，v0.0.243 起后端返含 task 的 DSL） |

> task 走通用 panorama 端点（POST entities/task / PATCH / transition），**不新增端点**（方案 A+：不造专用工具/端点）。归档 = PATCH 普通字段；自动依赖 = 后置 hook；filter = view 声明 + 前端透传。
