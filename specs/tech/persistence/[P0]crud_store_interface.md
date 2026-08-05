---
type: spec
title: CRUD Store Interface（存储引擎契约）
priority: P0
status: active
updated: 2026-08-05
since: v0.0.2
---

# CRUD Store Interface（存储引擎契约）

## 1. 概述

**管什么**：引擎无关的 CRUD 契约（put/get/query/delete）、记录信封、写入模式、查询过滤、错误类型、按 entity 路由。
**不管什么**：字段/类型描述（→ `[P0]schema_interface.md`）、具体后端落盘方式（→ 各 engine 文件）。
边界归属规则见 [docs_guide.md](../docs_guide.md) §4。

`CrudStore` 是 Persistence 的**中央契约**：业务面向它编程，不感知后端是文件还是 SQLite。FS engine 与 SQLite engine 都是它的实现。一个应用可同时挂多个 engine 实例，**CompositeStore 按 entity 寻址到已挂载 engine 实例**（如 `transcript→fs`、`app_config→sqlite`）。

store 只认两样东西：一份 SchemaDef（描述 entity）和一条记录（自带 ULID 主键）。id 由业务生成，store **不分配 id**，只注入并管理信封元数据。

## 2. 接口定义

### 2.1 StoredRecord（记录 + 信封）

```typescript
import type { SchemaDef, InferRecord } from "./[P0]schema_interface";

/** store 管理的信封元数据（保留字段，实体不得自带） */
interface RecordMeta {
  createdAt: string;   // isoDate，首次写入注入
  updatedAt: string;   // isoDate，每次写入更新
  version: number;     // 乐观锁版本号，首次为 1，每次写入自增
}

/** get/query 返回的形态：实体字段 + 信封 */
type StoredRecord<S extends SchemaDef> = InferRecord<S> & RecordMeta;
```

### 2.2 CrudStore

```typescript
interface CrudStore {
  /** 写入（insert / replace / upsert）。分片 entity 的 shardKey 从 record[shardKeyField] 提取。返回落盘后的完整记录（含新信封） */
  put<S extends SchemaDef>(
    schema: S,
    record: InferRecord<S>,
    opts?: PutOptions,
  ): StoredRecord<S>;

  /** 按主键读取。分片 entity（schema.fs.sharding 存在）必须传 shardKey 路由；不分片省略。不存在返回 undefined */
  get<S extends SchemaDef>(schema: S, id: string, shardKey?: string): StoredRecord<S> | undefined;

  /** 按主键删除。分片 entity 必须传 shardKey。返回是否实际删除了一条 */
  delete<S extends SchemaDef>(schema: S, id: string, shardKey?: string): boolean;

  /** 按过滤条件批量查（v1 只支持信封维度 + shardKey 范围，见 §2.3） */
  query<S extends SchemaDef>(schema: S, filter: QueryFilter): StoredRecord<S>[];
}
```

### 2.3 PutOptions 与 QueryFilter

```typescript
interface PutOptions {
  /** 写入模式，缺省 "upsert" */
  mode?: "insert"      // 仅当主键不存在；已存在则抛 RecordExistsError
           | "replace" // 整条覆盖（包括重置信封时间，version 自增）
           | "upsert"; // 存在则更新，不存在则插入
  /** 乐观锁：仅当当前 version 等于 ifVersion 才写入，否则抛 VersionConflictError */
  ifVersion?: number;
  /** upsert 更新时保留 existing.updatedAt（version 仍 +1，createdAt 照常保留）。
   *  用于「纯标记字段」写入不刷新实体活跃时间（如 session pinned 置顶——置顶是
   *  纯标记操作，不算对话活动）。缺省 false = 现状推进，存量调用方零影响。
   *  仅影响 upsert 更新分支；insert/replace 分支语义不变（replace 恒重置时间）。
   *  实现见 envelope.ts computeEnvelope upsert 分支（fs/sqlite 双引擎共用此纯函数）。 */
  preserveUpdatedAt?: boolean;
}

interface QueryFilter {
  /** 分片 entity：限定在某 shard 内查询；缺省 = scatter（遍历所有 shard 目录，性能差，慎用） */
  shardKey?: string;
  ids?: string[];                              // 主键集合
  createdAfter?: string;                       // isoDate 下界（含）
  createdBefore?: string;                      // isoDate 上界（不含）
  limit?: number;                              // 缺省无上限
  order?: "createdAtAsc" | "createdAtDesc";    // 缺省 createdAtDesc
}
```

**v1 查询边界**：`QueryFilter` 只保证信封维度（主键集合、时间范围、排序、limit）。`shardKey` 限定查询范围（FS engine：路由到单 shard 目录；缺省则 scatter）。**业务字段过滤不在契约保证范围内**——SQLite engine 可用 `json_extract` 提供 engine 专有扩展，但跨 engine 不可移植；通用业务字段检索归 `[P1]search_engine.md`。

### 2.4 错误类型

```typescript
class SchemaValidationError extends Error { field: string; }   // 校验不过（schema_interface §2.4，含 id 非合法 ULID）
class PrimaryKeyMissingError extends Error {}                  // record 缺 id 字段（无主键，无法寻址）
class RecordExistsError extends Error { id: string; }          // mode:"insert" 但主键已存在（v1.2 补 id 利于定位）
class RecordNotFoundError extends Error { id: string; }        // mode 要求存在但未找到（v1.2 补 id 利于定位）
class VersionConflictError extends Error { expected: number; actual: number; id: string; }  // v1.2 补 id：engine 内部经 computeEnvelope 已知 existing，把冲突 id 一起带出，便于 engine/上层定位记录（实现见 errors.ts:72-95）
class EntityNotMountedError extends Error { entity: string; }  // v1.2 新增：CompositeStore 收到 schema.entity 未 mount 的 entity 时抛（实现见 composite.ts:route() + errors.ts:106-118）；携带 entity 名便于排查漏 mount
```

### 2.5 慢查询观测（SlowQuerySink + queryWithSlowLog — `slow-query.ts`）

`query` 是性能敏感面（FS 全扫 / SQLite SQL），persistence 内置**慢查询埋点**：两 engine 的 `query` 入口统一经 `queryWithSlowLog` 计时包装，耗时严格大于 `SLOW_QUERY_MS = 200`（恰好等于不算慢）时经模块级 sink 上报一条 `SlowQueryInfo`。

```typescript
/** 慢查询阈值（毫秒）；先固定常量（后续版本可接 app_config） */
const SLOW_QUERY_MS = 200;

/** 一条慢查询记录（ts 由上层日志模块补） */
type SlowQueryInfo = {
  engine: 'fs' | 'sqlite';   // engine 标识
  entity: string;            // schema.entity——定位「哪个实体卡」的核心字段
  shardKey: string | null;   // filter.shardKey（不分片/scatter 为 null）
  ms: number;                // 查询耗时（取整）
  count: number;             // 返回记录数（过滤+limit 后，反映扫描工作量）
  filter: QueryFilter;       // 原始 filter（排查复现用）
};

/** 上报通道（上层注入；void = fire-and-forget，绝不阻塞查询主路径） */
type SlowQuerySink = (info: SlowQueryInfo) => void;

/** 注册/注销 sink（bootstrap 组合根装配一次；传 null 注销，UT 隔离用）。
 *  未注册 = 完全不产出慢日志。 */
function setSlowQuerySink(sink: SlowQuerySink | null): void;

/** 包一层 query 计时：执行 fn → 超阈值上报 sink；返回值原样透传零行为变更。
 *  sink 未注册时短路（仅一次 nowMs() 开销，不构造任何对象）。 */
function queryWithSlowLog<R extends unknown[]>(
  engine: 'fs' | 'sqlite', schema: SchemaDef, filter: QueryFilter,
  fn: () => R, nowMs: () => number,
): R;
```

**装配与门禁**：`bootstrap.ts` 在 LogWriter 创建后 `setSlowQuerySink(info => logWriter.write('performance', info))`——落 `<DATA_DIR>/logs/performance.log`（JSONL），开关 `logs.enablePerformanceLog`（默认 false，`LogWriter.write` 门禁早 return 零开销）；500MB drop-new + 失败静默由 dev-logs LogQueue 内建（日志机制全貌 → `../dev-logs/[P0]overall.md §3.7`）。`nowMs` 时钟由 engine 构造注入（`FsCrudStore` / `SqliteCrudStore` opts，缺省 `Date.now`），UT 可控。

## 3. 设计决策

### 3.1 通用 entity store，非实体专用 store

**结论**：一个泛型 `CrudStore`，实体类型由 SchemaDef 参数化；不为 Message/Session/Config 各写一套 store 接口。
**理由**：不同实体的存取动作本质相同（按 id 存取），差异只在 schema；泛型化后新增实体零改 store，两种 engine 只实现一次，未来 search 也只挂一层。
**反例**：若为每实体写 `MessageStore`/`SessionStore`，则每加一种实体要定义接口 + FS 实现 + SQLite 实现 + search 适配，样板翻倍且各 engine 容易行为分叉。

### 3.2 `id` 是保留主键名，值由业务生成，store 不分配

**结论**：字段名 `id` 恒为主键（ULID），不用 `primaryKey` 指针；值由业务生成并放进实体，store 只校验合法性、不内置 id 分配（详见 `[P0]schema_interface.md` §3.2）。
**理由**：CRUD 全程依赖主键寻址，名字固定为 `id` 后 store 统一认 `id`；业务层（message 首次分配、agent loop 入队 enqueueId）有自己的 id 生成时机，store 接管会与之耦合；ULID 去中心化、可业务侧直接构造（见 convention.md §3）。
**反例**：若 store 自增分配，则「业务先有 id 才能引用、稍后落盘」的场景（如消息在 loop 中先被 event 引用再持久化）无法实现；若用 primaryKey 指针允许任意字段当主键，则 store 每次 CRUD 要读指针定位，徒增间接，而我们的实体从不使用非 `id` 名做主键。

### 3.3 统一信封，保留 createdAt/updatedAt/version

**结论**：每条记录带三个保留信封字段，由 store 注入管理；SchemaDef 不得声明这三个名字。
**理由**：时间戳与版本是存储层的横切关注（审计、增量同步、乐观锁），不应让每种实体各自重复定义；集中到 store 统一可靠。
**反例**：若信封字段下放各实体自定义，则 engine 无法用统一列/文件结构支撑按时间排序与版本冲突检测，每个 SchemaDef 都要重抄一遍元字段。

### 3.4 统一契约 + 多 engine + 按 entity 寻址到已挂载 engine 实例

**结论**：同一 CrudStore 接口，应用可挂多个 engine 实例并存；**CompositeStore 按 entity 寻址到已挂载 engine 实例**，挂载关系（哪个 entity 用哪个 engine）由 `schema.engine` 决定——调用方 `mount(entity, engine)` 时声明该 entity 走此 engine，CompositeStore 收到 `put/get/...` 时用 `schema.entity` 找到对应 engine 实例并转发。
**理由**：不同实体对后端诉求不同（会话量大要 SQL 查询、配置量小要可读文件），强行统一到一个后端会牺牲某一侧；按 entity 寻址让各 entity 选最合适的后端，业务调用形态不变。「按 entity 寻址」与「engine 由 schema.engine 决定」是同一件事的两个面：entity 是寻址 key，schema.engine 是其挂载依据，二者一致，无歧义。
**反例**：若全局只允许一个 engine，则「sessions 想用 SQLite、app_config 想用文件」必须二选一；若每实体独立 store 接口，则丧失 §3.1 的通用性；若按 engine 路由（即调用方要在每个 put 上指定 engine），则把挂载决策泄漏到调用点，与「业务无感」相悖。

**未挂载错误**（v1.2 明确）：CompositeStore 收到 `schema.entity` 未 mount 的 entity 时抛 `EntityNotMountedError { entity }`（§2.4）。理由：mount 漏配是启动期典型错误，独立错误类型 + 携带 entity 名比泛用 RecordNotFoundError 更易定位漏 mount。

### 3.5 查询契约只保证信封维度

**结论**：v1 的 `QueryFilter` 只承诺主键集合 + 时间范围 + 排序 + limit，业务字段过滤不进契约。
**理由**：契约只保证两个 engine 都能高效实现的维度（信封有列/文件名可直查）；业务字段在 blob 里，跨 engine 高效过滤做不到，强进契约会逼 FS engine 上反向索引。
**反例**：若契约承诺业务字段过滤，FS engine 为达标必须自建倒排，违背「文件 engine 简单可读」；该需求本属 search engine。

### 3.6 分片 entity = 分库分表：point 访问必须带 shardKey

**结论**：声明了 `fs.sharding` 的 entity，数据按 shardKey 物理分区（FS engine：shard 目录；类比分库分表）。`get`/`delete` 必须提供 shardKey 才能路由到正确分区；`put` 从 `record[shardKeyField]` 提取；`query` 不带 shardKey = scatter（遍历所有 shard 目录），性能差，仅在必要时使用。
**理由**：分区存储下 id 不携带 shardKey 信息，单凭 id 无法定位分区（与分库分表的 shard key 约束一致）；transcript 的真实访问路径天然带 sessionId（context engine 在 session 内操作），故强制 shardKey 对它是免费约束。
**反例**：若允许仅凭 id 跨分区查找，则每次 get 都要 scatter 全部分区，分区优化失效；不如把「必须带 shardKey」做成契约硬约束。
**SQLite 例外**：SQLite engine 对 id 全局索引，`get(id)` 无需 shardKey 即 O(1)；shardKey 仅作普通索引列。即此约束是 FS engine 的代价，非通用。

### 3.7 信封 updatedAt 默认推进，`preserveUpdatedAt` 作显式 escape hatch

**结论**：upsert 更新默认推进 `updatedAt`（现状）；`PutOptions.preserveUpdatedAt: true` 时保留 `existing.updatedAt`（version 仍 +1）。缺省 false，存量调用方零影响。
**理由**：`updatedAt` 是「实体活跃时间」语义——绝大多数写入都代表实体真的变了，默认推进是对的；但存在「纯标记字段」写入（如 session pinned 置顶：只改一个展示层分组标记，不算对话活动），若照样推进 updatedAt 会污染按活跃时间排序的消费方（会话列表归位）。把豁免做成显式 opt-in 而非字段级自动判定：store 层不感知业务字段语义，哪个字段算「纯标记」只有调用方知道。
**反例**：若让 store 按字段名白名单自动保 updatedAt，则 store 耦合业务字段语义，且新标记字段要改 store；若默认不推进，则所有普通写入丢失活跃时间语义，消费方（排序/审计）全错。

### 3.8 慢查询观测走 sink 注册点，底座不反向依赖上层

**结论**：慢查询埋点（§2.5）不 import dev-logs——persistence 只定义 `SlowQuerySink` 回调接口 + `setSlowQuerySink` 模块级注册点，由 bootstrap（组合根）注入 LogWriter 适配；依赖方向保持 上层 → 底座。与 `setSessionStoreEpDelegate` / `setTokenUsageSubscriberDeps` 同范式。
**理由**：persistence 是最底层基座，dev-logs（LogWriter）在上层；底座 import 上层会反转分层（上层又经 ENV/config 依赖底座，易成环）。注册点模式下底座零感知日志机制：sink 未注册时 query 仅多一次 `nowMs()` 调用；开关门禁、队列有界、失败静默全部复用 dev-logs 既有机制，persistence 不重复实现。上报 void fire-and-forget，查询主路径零磁盘 IO。
**反例**：若 persistence 直接 `new LogWriter(...)` 或 import dev-logs 模块，则底座与日志实现硬耦合——换日志后端要改底座，且 dev-logs 依赖 appConfig 会把 config 依赖链引进最底层；若把埋点放调用方（业务层各自计时），则两 engine × N 调用点散落重复，阈值/字段口径必漂移。

## 4. 示例

写入并读回一条消息（id 业务侧生成）：

```typescript
const msg: Message = {
  id: "01KVCA58G80Y54TTF2S8ZPFR5M",   // 业务生成的 ULID
  sessionId: "01KVCB00ABCDEFGH...",
  role: "user",
  content: [{ type: "text", text: "hello" }],
};

const stored = store.put(MessageSchema, msg);
// stored.createdAt / updatedAt / version 由 store 注入：
// { ...msg, createdAt: "2026-06-19T03:10:00.000Z", updatedAt: "...", version: 1 }

const got = store.get(MessageSchema, "01KVCA58G80Y54TTF2S8ZPFR5M");
```

乐观锁更新（并发安全）：

```typescript
const cur = store.get(MessageSchema, id)!;
store.put(MessageSchema, { ...cur, content: newContent }, { ifVersion: cur.version });
// 期间若他人已改过 → 抛 VersionConflictError { expected: 1, actual: 2 }
```

按 entity 寻址到已挂载 engine（transcript 走 fs 分片，app_config 走 sqlite）：

```typescript
// FsCrudStore 的 root 是基目录；dirTemplate（见 fs_crud_store_engine §2）是相对 root 的
// 分片路径模板，engine 老实拼接「不自加前缀」。这里 root 统一为 ./data，
// transcript 的 shard 路径完全由其 schema.fs.sharding.dirTemplate（如 "sessions/{shardKey}/"）决定。
const store = new CompositeStore()
  .mount("transcript", new FsCrudStore({ root: "./data" }))
  .mount("app_config", new SqliteCrudStore({ db: "./data/app.db" }));

// 调用方无感，CompositeStore 用 schema.entity 寻址到已挂载的 engine 实例
store.put(TranscriptSchema, msg);       // → FsCrudStore（按 schema.entity="transcript" 寻址）
store.put(AppConfigSchema, cfg);        // → SqliteCrudStore（按 schema.entity="app_config" 寻址）
```

transcript（分片）读写：必须带 shardKey（=sessionId）：

```typescript
store.put(TranscriptSchema, msg);                                    // shardKey 从 msg.sessionId 提取
const got = store.get(TranscriptSchema, msg.id, msg.sessionId);      // 显式传 shardKey
store.query(TranscriptSchema, { shardKey: sessionId, order: "createdAtDesc", limit: 50 });  // 该 session 最近 50 条
```

## 5. 边界

| 零件 | 归属 |
|------|------|
| CrudStore 接口、StoredRecord 信封、PutOptions、QueryFilter、错误类型、CompositeStore 寻址 | 本文件 ✅ |
| 慢查询埋点（SlowQuerySink 注册点 + queryWithSlowLog 计时包装，§2.5/§3.8） | 本文件 ✅（sink 装配/日志落盘/开关门禁 → `../dev-logs/`） |
| SchemaDef / InferRecord / 字段校验规则 | `[P0]schema_interface.md` |
| FS 落盘（目录/文件/原子写） | `[P0]fs_crud_store_engine.md` |
| SQLite 落盘（表/blob/SQL/事务） | `[P0]sqlite_crud_store_engine.md` |
| 业务字段全文/语义检索 | `[P1]search_engine.md` |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
