---
type: interface
title: Panorama 存储布局 + 泛化实体 store
priority: P1
status: active
updated: 2026-08-05
since: v0.0.189.dsl_board
related: [[P1]panorama_overview.md, [P1]panorama_dsl.md, [P1]panorama_validation.md, [P1]data_model.md §3]
---

# Panorama 存储布局 + 泛化实体 store（不建 SchemaDef + CrudStore FS engine 复用）

> 定位：panorama 数据如何在文件系统上落地——`board.yaml`（DSL 主面）+ `entities/{entity}/{id}.json`（每项一文件）+ `events.jsonl`（append-only）+ `.archive/`（迁移备份）。
> 存储引擎权威：`specs/tech/persistence/[P0]fs_crud_store_engine.md`（CrudStore FS engine + sharding + 原子写 + 锁）。

## 1. 目录布局

```
data_dir/squads/{squadId}/panorama/
├── board.yaml                    # DSL 主面（含 meta/version/entities/views，引擎读写）
├── entities/                     # 实例数据（每项一文件）
│   └── {entity}/                 # entity name → bucket 目录
│       └── {id}.json             # 单实例文件（原子写：tmp→fsync→rename）
├── events.jsonl                  # append-only 事件流（双侧操作共享）
├── .state/                       # 计数器状态（引擎内部）
│   ├── counters.json             # per-entity ID 自增计数器
│   └── event-seq.json            # events.jsonl seq 计数器
└── .archive/                     # 迁移备份（破坏性变更前自动备份）
    └── pre-migration-{seq}/      # 每次破坏性迁移一个备份目录
        ├── board.yaml.bak        # 旧 DSL 备份
        └── entities/...           # 受影响实例备份
```

- **建 squad 时初始化**：`createSquadService` step7 建 `panorama/` 目录骨架（`entities/` + `events.jsonl` 空文件 + `.archive/`）。`board.yaml` 首次 `define` 时创建。
- **数据隔离**（决策 7）：panorama 在独立 `panorama/` 子目录，与 squad 工作目录其他产出（outputs/reports/交付/temp）物理隔离。
- **无 OKF md 轨**（决策 8）：`board.yaml` 即主面，实例是纯数据 json——panorama 实例无 agent 手写 markdown 需求。

## 2. 不建 SchemaDef（关键架构决策）

panorama 的实体是 **agent 运行时通过 DSL 定义的**——SchemaDef 是静态 schema（编译期固定 `schema_defs/squad/*.ts`），无法预建动态实体。

| | squad board | panorama |
|---|---|---|
| schema 来源 | SchemaDef（编译期静态） | DSL 注册表（运行时动态） |
| 校验 | SchemaDef.validateRecord | 校验引擎从 DSL 派生（`panorama_validation.md`） |
| store | CrudStore + SchemaDef | **泛化 KV** + DSL 注册表 |

**泛化 KV store 设计**：
- 不为每个 entity 注册 SchemaDef。store 操作以 `(entityName, id)` 为 key，读写原始 JSON object。
- 实例合法性靠**校验引擎**（从 DSL 派生规则）在写入前校验，而非 SchemaDef 的 `validateRecord`。
- store 只负责文件读写 + 信封（createdAt/updatedAt/version），不做 schema 校验。

```typescript
// 泛化实例 store 接口（不依赖 SchemaDef；实现 PanoramaEntityStore）
interface PanoramaEntityStoreLike {
  listInstances(entity: string): Record<string, unknown>[];   // 扫描 entities/{entity}/*.json
  getInstance(entity: string, id: string): Record<string, unknown> | undefined;
  hasId(entity: string, id: string): boolean;                  // create 唯一性校验用
  putInstance(entity: string, id: string, record: Record<string, unknown>,
    options?: { messageId?: string | null }): Record<string, unknown>;  // 原子写 + 信封
  deleteInstance(entity: string, id: string): boolean;
  // 便捷写入（写实例 + append 事件流一步完成）：
  //   createInstance / updateInstance / transitionInstance / removeInstance
  // board.yaml 读写：readBoard(): PanoramaSchema | null / writeBoard(schema)
  // ID 生成：nextId(entity)（异步，withFileLock 串行）
}
```

> **未实现 / 后续版本**（v0.0.189 m3 遗留）：便捷写入方法目前**不返回事件 seq**，tool/http 层 emit SSE 时靠 `readEvents(0, 1)` 取 tail seq（依赖 EventStore.read 的 `slice(-limit)` tail 语义）。「store 写入方法直接返回 seq」的接口优化留后续版本。

**CrudStore FS engine 复用**：虽然不建 SchemaDef，但仍用 `FsCrudStore` 的底层能力——目录扫描、原子写（tmp→fsync→rename）、进程内并发锁（`file-lock.ts`，同 path 串行化）。实现上走 CrudStore 的泛化 entity 接口或直接封装 FS 操作（复用原子写 + 锁原语），避免重造轮子。

## 3. 实例文件格式

```json
{
  "id": "pr-001",
  "status": "running",
  "branch": "main",
  "commit": "abc1234",
  "duration_sec": 120,
  "started_at": "2026-07-22T10:00:00Z",
  "_envelope": {
    "createdAt": "2026-07-22T10:00:00.000Z",
    "updatedAt": "2026-07-22T10:05:00.000Z",
    "version": 2
  },
  "lastWriteMessageId": "01J..."   // 可选：写操作来源 message id（见 §5）
}
```

- 实例 = DSL `fields` 声明的字段值 + `_envelope`（引擎自动维护的信封）。
- `_envelope` 由 putInstance 自动维护：create 时 `{createdAt, updatedAt, version:1}`，update 时保留 createdAt、刷 updatedAt、version+1。
- `lastWriteMessageId` 在实例文件**顶层**（非 _envelope 内），仅当写操作带 messageId 时写入。
- 新增字段（增量迁移）时，存量实例该字段补 `null`（惰性：文件不动，读取时用 DSL 补默认值，`panorama_migration.md §2.1`）。
- `id` 由 `id_field` 指定（通常是 `id` 字段）。ID 生成规则见 §4。

## 4. ID 生成规则

- 实例 ID 由调用方提供（agent 工具 `create` 传入）或引擎自动生成。
- 自动生成格式：`{entity}-{seq}`（4 位 padded，如 `pipeline_run-0001`），seq = squad 内 per-entity 自增计数器（存 `.state/counters.json`，withFileLock 串行 read-modify-write）。
- ID 在 entity 内唯一：create 时**不再由校验引擎判 duplicate**——调用方（`runCreate` / `handleCreateEntity`）在 coerce+validate 之前用 `store.hasId(entity, id)` 短路：命中 → 返 `created:false`（skip-if-exists 幂等，不报错）；未命中走建路径。`panorama_duplicate_id` 已从校验码集合移除（v0.0.259）。

## 5. lastWriteMessageId 语义

每个写操作（create / update / transition / define）自动记录当前 message id 到事件流 entry（`events.jsonl` 每行的**顶层 `messageId` 字段**；define 的审计 entry 另在 payload 内带 `lastWriteMessageId`），语义：

- **caller 不直传** `lastWriteMessageId`——工具/HTTP 从执行上下文自动取当前 message id。
- agent 工具写入时填当前 message id；HTTP 直接调用时填 `null`（非 agent 来源）。
- 用途：区分操作来源（agent vs user），事件流面板展示。

## 6. board.yaml（DSL 主面）

```yaml
meta: { version: "1.0", author: "...", created_at: "...", updated_at: "..." }
version: { id: "...", name: "...", board_name: "..." }
entities: { ... }
views: [ ... ]
```

- 引擎**唯一写入方**（agent 经工具 `define` → 校验引擎 → 引擎写盘）。
- 原子写：写 `board.yaml.tmp` → fsync → rename（对齐 FsCrudStore §3.6）。
- 读时全文 parse（YAML → JS object），缓存在内存（per-request 或 per-squad，失效策略见实现）。

## 7. events.jsonl（append-only 事件流）

```jsonl
{"seq":1,"ts":"...","type":"board.defined","entity":"*","summary":"DSL 更新（3 changes）","payload":{"changes":[...],"breaking":false,"instancesAffected":0,"lastWriteMessageId":"01J..."},"source":"agent","messageId":"01J..."}
{"seq":2,"ts":"...","type":"entity.created","entity":"pipeline_run","id":"pr-001","summary":"新增 pipeline_run pr-001","payload":{"id":"pr-001","record":{...}},"source":"agent","messageId":"01J..."}
{"seq":3,"ts":"...","type":"entity.transition","entity":"pipeline_run","id":"pr-001","summary":"pr-001: queued → running","payload":{"id":"pr-001","from":"queued","to":"running","field":"status"},"source":"drag","messageId":null}
```

- append-only（只追加，不修改已有行）。seq 单调递增。
- 每行 = 一个事件：`{seq, ts, type, entity, id?, summary?, payload, source?, messageId?}`（`id` / `source` / `messageId` 为**顶层字段**，不在 payload 内）。
- type = `board.defined` / `entity.created` / `entity.updated` / `entity.transition` / `entity.deleted` / `migration.executed`。
- `source` = `agent` / `drag` / `api` / `user` / `system`（区分操作来源；便捷写入默认 create/update/remove=`api`、transition=`drag`）。
- SSE 推送：每次 append 一行即触发 SSE 事件推送（`panorama_http.md`）。
- 读取：`events(since=seq, limit)` 读 seq > since 的事件中**最新的 limit 条**（tail 语义 `slice(-limit)`；since 翻页若间隔超 limit 条，中间事件会跳过）。seq 计数器存 `.state/event-seq.json`。

## 8. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| 目录布局 + 泛化 KV store 设计 + 不建 SchemaDef 决策 + ID 生成 + lastWriteMessageId + events.jsonl 格式 | 本文 ✅ |
| DSL 字段级 schema（实体/字段/视图/状态机/card 模板） | `[P1]panorama_dsl.md` |
| 四层校验引擎（实例写入前校验，替代 SchemaDef.validateRecord） | `[P1]panorama_validation.md` |
| 迁移引擎（增量/破坏性 + .archive 备份 + 存量实例处理） | `[P1]panorama_migration.md` |
| CrudStore FS engine（原子写 / 锁 / sharding 本体） | `persistence/[P0]fs_crud_store_engine.md` |
| HTTP API（读写 board.yaml / 实例 CRUD / events） | `panorama_http.md` + `specs/api/overall/14-panorama-endpoints.md` |
| agent 工具写入（create/update/transition 记 lastWriteMessageId） | `[P1]panorama_tools.md` |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
