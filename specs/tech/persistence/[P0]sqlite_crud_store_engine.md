---
type: spec
title: SQLite CRUD Store Engine（SQLite 存储引擎）
priority: P0
status: active
updated: 2026-08-05
since: v0.0.2
---

# SQLite CRUD Store Engine（SQLite 存储引擎）

## 1. 概述

**管什么**：CrudStore 契约在 SQLite 上的实现（表结构、blob 存储、SQL 映射、事务、索引策略）。
**不管什么**：CrudStore 契约本身（→ `[P0]crud_store_interface.md`）、SchemaDef（→ `[P0]schema_interface.md`）、FS 实现（→ `[P0]fs_crud_store_engine.md`）。
边界归属规则见 [docs_guide.md](../docs_guide.md) §4。

`SqliteCrudStore` 把每个 entity 落成一张表，整条记录以 JSON blob 存于 `data` 列，外加少量**信封列**用于查询、排序与主键约束。**主打量级更大、需要 SQL 查询与事务、单机嵌入式零运维**，适合配置、用量统计等结构化查询场景。v1 采用 **blob 优先**策略，字段级索引留给迭代升级。

> **实现底座是 `bun:sqlite`**（项目运行时 bun 的内置模块，零依赖、同步 API）：建库/建表/预编译语句/事务全部走 `bun:sqlite` 的 `Database`。不引 ORM，SQL 由本 engine 自行拼写（见 §3.6「为何不引 Prisma」）。

## 2. 表结构（一个 entity 一张表）

```sql
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,        -- 主键 ULID，直读 data.id（id 为保留主键名）
  data        TEXT NOT NULL,           -- 整条实体 JSON blob（不含信封）
  created_at  TEXT NOT NULL,           -- isoDate，store 注入
  updated_at  TEXT NOT NULL,           -- isoDate，store 更新
  version     INTEGER NOT NULL         -- 乐观锁版本号
);

-- 信封索引（v1 仅这些，对应 SchemaDef IndexDef 的信封字段）
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);
```

- **entity → 表**：表名 = `schema.entity`，首次写入时惰性建表。
- **信封列**：`id` / `created_at` / `updated_at` / `version` 为真实列，可查询、可排序、可索引。
- **data 列**：实体完整 JSON（**不含信封字段**），blob 存储，v1 不拆字段。
- **id 与 data 的关系**：`id` 列值 = `data.id`（id 为保留主键名，业务生成；去规范化便于 SQL 直查主键），写入时 engine 保证二者一致。

`data` 列内容示例（message，不含信封）：

```json
{
  "id": "01KVCA58G80Y54TTF2S8ZPFR5M",
  "sessionId": "01KVCB00ABCDEFGH",
  "role": "user",
  "content": [{ "type": "text", "text": "hello" }]
}
```

## 3. 设计决策

### 3.1 blob 优先：整条记录存 JSON blob + 信封列

**结论**：v1 实体存一个 `data` JSON 列，只为信封（id/时间/version）开真实列；SchemaDef 业务字段不拆列。
**理由**：方便迭代——加字段不必迁移表结构；信封列足以支撑 v1 查询契约（主键 + 时间范围 + 排序）；SQLite 的 JSON1 函数可在需要时按需读字段。
**反例**：若 v1 就把每个 SchemaDef 字段拆成真实列，则每次改 schema 都要 `ALTER TABLE` 迁移，且 enum/json 类型映射复杂、与「方便迭代」相悖。

### 3.2 信封开真实列，业务字段留 blob

**结论**：`id`/`created_at`/`updated_at`/`version` 必须是真实列，业务字段一律进 `data` blob。
**理由**：契约保证的查询维度（crud_store_interface §2.3）必须能高效走索引，故信封开列；业务字段不进契约保证，不必为它们付建列/迁移成本。
**反例**：若信封也塞进 blob，则按时间排序/范围过滤要全表 `json_extract` 扫描，量大时不可用。

### 3.3 字段级索引走「生成列」升级（v1 不上）

**结论**：v1 不为业务字段建索引；未来需要时用 SQLite **生成列**（generated column）从 `data` 派生列再建索引，不改写入路径。
**理由**：生成列让字段索引成为「读路径优化」，写入仍只管 blob，迁移可按 entity 增量进行，契合 blob-first 的迭代友好性。
**反例**：若 v1 用「业务字段拆真实列」做索引，则 schema 变更要迁移所有现存数据；若维护单独的倒排表，则写入要双写、一致性复杂。

### 3.4 复用 SQLite 事务，补 FS engine 缺失的跨记录原子性

**结论**：engine 暴露事务能力（多条 put/delete 可在同一事务内提交或回滚），作为 SQLite engine 相对 FS engine 的明确优势。
**理由**：SQLite 原生支持 ACID 事务，是选它的核心理由之一；契约的 `put`/`delete` 单条即隐式事务，多条可通过显式事务打包。
**反例**：FS engine 无事务（fs_crud_store_engine §5）；若 SQLite engine 也不用事务，则相对 FS 的关键优势丧失，选型无意义。

### 3.5 并发模型：WAL + 预编译语句 + 乐观锁

**结论**：建库时 `PRAGMA journal_mode = WAL`；每条 SQL 用 `db.prepare()` 预编译并复用；跨记录竞态靠 `ifVersion` 乐观锁，不靠悲观锁。
**理由**：`bun:sqlite` 同步 API + 预编译语句已足够快且无连接池开销；WAL 让读不阻塞写、适合单机多读少写；乐观锁避免长事务持锁，崩溃回退简单。SQLite 本身是单写者模型，engine 内对写串行即可，无需额外锁层。
**反例**：若用默认 rollback journal，则读阻塞写、并发差；若靠应用层悲观表锁，则与 SQLite 单写者模型叠加、徒增死锁面；若引 ORM 自带的连接池/查询编译，在嵌入式单进程场景是纯开销。

### 3.6 为何不引 Prisma（决策记录）

**结论**：不引入 Prisma，自研 SchemaDef + CrudStore + 两 engine；SQLite engine 用 `bun:sqlite`。借鉴 Prisma「schema 单一源头 + schema 驱动建表 + schema 派生类型」的思想，但不接它的工具链。
**理由**：Prisma 的卖点多与本需求错配——它的强项（多模型强类型 client、关系/连接、迁移、多库可移植）正是我们「通用门面、blob-first、单 embedded SQLite、极简查询」用不上或刻意不要的部分；其唯一真金白银的迁移能力又因 blob-first（表结构恒定）而失效。引入它要多付 `prisma generate` 构建步骤、SchemaDef↔schema.prisma 生成器、类型双源 policing、版本周期耦合等成本，收益不成比例。`bun:sqlite` 已是运行时内置，SQL 侧手写量极小。
**反例**：若未来长出一堆强类型关系模型 + 频繁改表 + 多库需求，则 Prisma 的迁移与关系层才值得重新评估；当前 YAGNI。

## 4. 操作映射

| CrudStore 方法 | SqliteCrudStore 实现 |
|---|------|
| `put` | 校验 schema → 算信封 → 按 `mode`/`ifVersion` 发 `INSERT`/`REPLACE`/`UPDATE`（version 自增）→ 返回合并信封的记录 |
| `get` | `SELECT data, created_at, updated_at, version FROM <entity> WHERE id = ?` → 合并 data + 信封返回 |
| `delete` | `DELETE FROM <entity> WHERE id = ?` → `changes()` 判断是否实际删除（实现亦可「先 select 存在性再 delete」，两种等价；见 §4 注） |
| `query` | 按 `ids`/`createdAfter`/`createdBefore` 拼 WHERE、按 `order` 拼 ORDER BY、`limit` 拼 LIMIT，全走信封列。入口经 `queryWithSlowLog('sqlite', ...)` 计时包装（慢查询埋点 → crud_store_interface §2.5），`nowMs` 构造注入缺省 `Date.now` |

`insert` 模式用 `INSERT`（主键冲突抛 `RecordExistsError`）；`replace` 用 `UPDATE`（不存在抛 `RecordNotFoundError`）；`upsert` 的等价实现有两种——**实现选用「首次 INSERT / 已存在 UPDATE」两步**（因 engine 在算信封前已 `readMeta` 拿到 existing，分支已知 insert/update，无需 ON CONFLICT 兜底；见 `sqlite-store.ts:put` + `sqlite-rows.ts:execUpsert`），或 `INSERT ... ON CONFLICT(id) DO UPDATE`（spec 备选写法，语义等价）；`ifVersion` 在 `WHERE version = ?` 里带上，affected rows = 0 即 `VersionConflictError`。

> **delete 返回值实现注**（v1.2）：spec 写 `changes()` 判断实际删除；实现用「先 `selectRow` 查存在性再 `DELETE`」（`sqlite-store.ts:delete`），二者返回值语义一致（实际删了一行才 `true`）。两种实现均可，spec 不强制其一。

**engine 专有扩展（非契约保证）**：业务字段过滤可用 `WHERE json_extract(data, '$.role') = ?`，但不跨 engine 可移植，调用方自负。

## 5. 事务接口（engine 专有，超出 CrudStore 契约）

事务直接映射 `bun:sqlite` 的 `db.transaction()`（同步），把多个操作打包成一个 ACID 事务：

```typescript
interface SqliteCrudStore /* extends CrudStore */ {
  /** 多个操作打包成一个事务，全部成功才提交；任一异常自动回滚 */
  transaction<T>(fn: (tx: CrudStore) => T): T;
}
```

事务内的 `put`/`delete` 作用于同一连接的临时事务上下文，与契约方法签名一致（CrudStore 方法本就是同步）。事务能力是选择 SQLite engine 的明确理由，FS engine 不提供（见 `[P0]fs_crud_store_engine.md` §5）。

> **DDL 也在事务内回滚**（v1.2）：bun:sqlite 的 `db.transaction()` 实测会把事务内的 DDL（如 `CREATE TABLE`）也纳入回滚范围——事务内任一异常，连惰性建表也会一并撤销（已有集成测试覆盖：事务内 `put` 触发建表 + 抛错后表不存在）。SQLite 原生对此有警告（部分 DDL 不可逆），但建表/索引这类可幂等 DDL 在 bun:sqlite 的 transaction 包装下行为符合直觉，engine 无需额外规避。

## 6. 示例

构造与使用（底层 `bun:sqlite`，engine 内部自行 `db.prepare` 预编译）：

```typescript
import { SqliteCrudStore } from "...";

const store = new SqliteCrudStore({ path: "./data/app.db" });
// engine 初始化时：new Database(path) + PRAGMA journal_mode=WAL + 惰性建表

store.put(AppConfigSchema, cfg);                      // → INSERT/UPSERT into app_config
const got = store.get(AppConfigSchema, cfg.id);       // → data blob + 信封列合并
store.query(AppConfigSchema, {                        // → 走 created_at 索引
  createdAfter: "2026-06-19T00:00:00.000Z",
  order: "createdAtDesc",
  limit: 50,
});

// 跨记录原子（engine 专有，同步）
store.transaction((tx) => {
  tx.put(AppConfigSchema, cfgA);
  tx.put(AppConfigSchema, cfgB);   // 任一异常则两者都不生效
});
```

## 7. 边界

| 零件 | 归属 |
|------|------|
| 表结构、blob 存储与信封列、SQL 映射、`bun:sqlite` 用法、事务、WAL/预编译语句、生成列升级路径 | 本文件 ✅ |
| CrudStore 契约、信封字段语义、PutOptions、QueryFilter | `[P0]crud_store_interface.md` |
| SchemaDef / 字段校验 | `[P0]schema_interface.md` |
| FS 实现、目录布局 | `[P0]fs_crud_store_engine.md` |
| 业务字段全文/语义检索 | `[P1]search_engine.md` |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
