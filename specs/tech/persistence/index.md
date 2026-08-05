---
type: index
title: Persistence 子系统总起
priority: P0
updated: 2026-08-05
---

# Persistence 子系统总起

## ① 是什么

Persistence 是 Agent 框架的**数据落地基座**：把任意业务实体（消息、会话、配置、插件状态、squad record……）按统一契约存到某种后端，并能在**不同 engine 之间无感切换**。解决「一个接口多种后端」：同一套 `CrudStore` 契约，既能在文件系统里跑，也能在 SQLite 里跑，业务按 entity 各自选。persistence 是**纯泛型 store、最底层、不走 plugin**，不认识任何具体业务实体。

| 核心概念 | 一句话 |
|---|---|
| **SchemaDef** | 一个 entity 的描述符（字段/主键/索引/engine/可选 fs 分片），TS 类型从它派生 |
| **CrudStore** | 引擎无关的 CRUD 契约（put/get/query/delete）+ 信封注入 |
| **Engine** | CrudStore 的具体实现：FsCrudStore（目录+JSON/jsonl）/ SqliteCrudStore（bun:sqlite + blob-first） |
| **CompositeStore** | 按 `schema.entity` 寻址到已挂载 engine 实例的路由层（mount 表） |
| **StoredRecord** | 统一信封：`id` + `createdAt`/`updatedAt`/`version`（乐观锁），store 注入管理 |
| **sharding** | FS engine 高基数 entity 的分片：`fs.dirTemplate`（如 `sessions/{shardKey}/`），point 访问必带 shardKey |
| **SlowQuerySink** | 慢查询观测注册点（`slow-query.ts`）：底座只定义回调接口 + 模块级注册点，bootstrap 注入 dev-logs LogWriter 适配；两 engine query 入口计时，超 `SLOW_QUERY_MS=200` 上报 `performance.log` |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| SchemaDef 声明 + 记录信封 + CRUD 契约 + CompositeStore 寻址 | 实体业务语义（消息→`../agent/message/`、config→`../config/`、squad→`../squad/`） |
| FS engine（目录布局/原子写/jsonl 段文件/分片）+ SQLite engine（表结构/SQL/事务） | 检索/排序/向量检索（→ `[P1]search_engine.md`，P1 占位） |
| engine 由 `schema.engine` 字段决定 + bootstrap 内置安全 | 业务字段含义（归各业务 SchemaDef 作者） |
| 慢查询埋点注册点（SlowQuerySink + queryWithSlowLog 计时包装） | 日志落盘/开关门禁（→ `../dev-logs/`；sink 装配 → bootstrap） |

## ③ 与系统的关系

```
   config / agent.session / squad / plugin_policy …（各业务 SchemaDef，自带 engine 字段）
                              │ put/get/query/delete(schema, record)
                              ▼
                    CompositeStore（路由层，mounts: entity→engine）
                              │ 按 schema.entity 寻址（不读 engine 字段）
                ┌─────────────┴──────────────┐
                ▼                            ▼
        FsCrudStore(root 来自 ENV)    SqliteCrudStore(db 路径来自 ENV)
        {root}/{entity}/<id>.json     table: entity (blob-first + 信封列)
        {root}/{dirTemplate}/{entity}/<seg>.jsonl（分片）
```

**对外协作点**：engine 启动参数（FS root / SQLite db path）从 **ENV** 读，**不读 config**（否则 config→engine→config 循环）；业务 schema 落各业务模块目录（`agent/schema_defs/`、`config/schema_defs/`、`agent/schema_defs/squad/`、`plugin/schema_defs/`），CompositeStore mount 时一站式 import。

## ④ 核心设计原则（跨文件不变量）

1. **通用 entity store，非实体专用**——新增实体只加 SchemaDef，store 不动。→ `[P0]crud_store_interface.md §3.1`
2. **SchemaDef 唯一源头，TS 类型派生**——`InferRecord<S>` 编译期派生，杜绝 interface/schema 双源漂移。→ `[P0]schema_interface.md §3.1`
3. **`id` 是保留主键名，值业务生成**——字段名 `id` 恒主键（ULID），store 不分配只校验。→ `[P0]schema_interface.md §3.2`
4. **engine 是 SchemaDef 字段，寻址纯 schema 驱动**——CompositeStore 只看 `schema.entity` 路由到 mount 时按 `schema.engine` 登记的实例。→ `[P0]crud_store_interface.md §3.4`
5. **FS root/dirTemplate 老实拼接**——配什么就是什么，不自加前缀；分片 point 访问必带 shardKey。→ `[P0]fs_crud_store_engine.md §2`
6. **静态基座（非 plugin）+ SQLite blob 优先**——未来加 engine = 加内置实现，不引插件引导循环；v1 整条记录 JSON blob + 信封列，字段级索引留迭代。→ `[P0]sqlite_crud_store_engine.md §3.1`。SQLite engine v0.0.194 扶正为生产/packaged 可用（SqlDriver 注入 + better-sqlite3 packaged），详见 `[P0]sqlite_engine_packaged_promotion.md`
7. **底座不反向依赖上层（sink 注册点模式）**——persistence 是最底层，观测/上报不 import 上层模块（dev-logs 等）：只定义回调接口 + 模块级注册点（`setSlowQuerySink`），由 bootstrap 组合根注入适配。与 `setSessionStoreEpDelegate` / `setTokenUsageSubscriberDeps` 同范式。→ `[P0]crud_store_interface.md §3.8`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 优先级 | 链接 |
|---|---|---|---|
| `schema_interface.md` | SchemaDef + FieldDef + IndexDef + `InferRecord<S>` + 校验语义 | P0 | [link]([P0]schema_interface.md) |
| `crud_store_interface.md` | CrudStore 接口 + StoredRecord 信封 + PutOptions + QueryFilter + 错误 + CompositeStore 寻址 | P0 | [link]([P0]crud_store_interface.md) |
| `fs_crud_store_engine.md` | FS engine：目录布局、原子写、查询、分片、jsonl 段文件、并发 | P0 | [link]([P0]fs_crud_store_engine.md) |
| `sqlite_crud_store_engine.md` | SQLite engine（原 bun:sqlite）：表结构 blob-first、SQL 映射、事务、索引 | P0 | [link]([P0]sqlite_crud_store_engine.md) |
| `sqlite_engine_packaged_promotion.md` | SQLite engine 扶正（实验态 → 生产/packaged 可用）：CrudStore 重写复用 SqlDriver 抽象 + better-sqlite3 packaged 接入 + 验证 | P0 | [link]([P0]sqlite_engine_packaged_promotion.md) |
| `search_engine.md` | History Search 引擎（一期 BM25 + FTS5 trigram + recency 重排；SearchEngine + HistoryIndexer + SqlDriver 抽象 + search.sqlite schema） | P1 | [link]([P1]search_engine.md) |
| `token_usage_stat.md` | squad token 用量时序表（SchemaDef + sqlite engine + direct-call subscriber + raw SQL GROUP BY 聚合 + distinct model） | P1 | [link]([P1]token_usage_stat.md) |
| `file_write_lock.md` | 进程内文件写加锁（锁原语 + FsCrudStore async 扩展 + 工具/board store 包装） | P1 | [link]([P1]file_write_lock.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
