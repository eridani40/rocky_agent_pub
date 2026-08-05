---
type: spec
title: Schema Interface（实体 Schema 契约）
priority: P0
status: active
updated: 2026-06-30
since: v0.0.2
---

# Schema Interface（实体 Schema 契约）

## 1. 概述

**管什么**：一个 entity 的字段/主键/索引描述符（SchemaDef），以及 TS 类型如何从它派生。
**不管什么**：存取行为（→ `[P0]crud_store_interface.md`）、具体实体业务字段（归各业务模块）。
边界归属规则见 [docs_guide.md](../docs_guide.md) §4。

SchemaDef 是 Persistence 的**唯一源头**：业务为每种实体写一份 SchemaDef，运行时用它做写入校验、驱动 SQLite 建表与 FS 目录布局；编译期用 `InferRecord<S>` 从同一份 SchemaDef 反推出 TS 类型。**不手写第二份 interface**，避免双份漂移。

一份 SchemaDef 描述「这个 entity 长什么样」（实体/schema 标识），不描述「怎么存」（存法归各 engine）。

> **术语厘清**：本文「entity」指**实体/schema 标识**——即 `SchemaDef.entity` 字段值（如 `"transcript"`），同时等于该实体在底层存储中的集合名（FS 目录名 / SQLite 表名）。**一条记录**（record）是该 entity 的一个实例。不要把 entity（标识）与 record（实例）混淆。

## 2. 接口定义

### 2.1 SchemaDef

```typescript
/** 字段类型枚举（字符串字面量，见 convention.md §2） */
type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "ulid"        // ULID 字符串（见 convention.md §3）
  | "isoDate"     // ISO 8601 UTC 字符串（见 convention.md §4）
  | "enum"        // 取值受限的字符串
  | "json";       // 不透明的任意嵌套值

interface FieldDef {
  type: FieldType;
  required?: boolean;        // 缺省 false
  enumValues?: string[];     // 仅 type: "enum" 时生效
}

interface IndexDef {
  /** v1 仅支持信封字段： "id" | "createdAt" | "updatedAt" | "version" */
  fields: string[];
  unique?: boolean;          // 缺省 false
}

/** FS engine 存储策略（仅 engine:"file" 时消费；SQLite engine 忽略） */
interface FsStorageConfig {
  /** 分片配置；缺省 = 不分片（扁平 entity 目录） */
  sharding?: {
    /** 用作 shard key 的字段名（须在 fields 中声明），如 "sessionId" */
    shardKeyField: string;
    /** 相对 root 的分片路径模板，如 "sessions/{shardKey}/"；{shardKey} 替换为字段值；engine 据此把分片 redirect 到该路径（root 与此拼接，不自加前缀，见 fs_crud_store_engine §2）；entity 名追加其后，使同 shardKey 的多 entity 聚在同一 shard 目录 */
    dirTemplate: string;
  };
  /** 文件格式，缺省 "json" */
  format?: "json" | "jsonl";
  /** format:"jsonl" 时单段文件最大记录数（封顶单文件读取/扫描成本） */
  jsonlMaxCount?: number;
}

interface SchemaDef {
  entity: string;                      // 实体/schema 标识，如 "transcript"，全局唯一；同时是底层集合名（FS 目录名 / SQLite 表名）
  fields: Record<string, FieldDef>;    // 字段定义，key 为字段名；必须含保留名 id（见 §2.2）
  indexes?: IndexDef[];                // 缺省空
  /** 存储引擎；各 entity 自选（决定 CompositeStore 把该 entity 路由到哪个 engine 实例，见 crud §3.4）；FS engine 的路由/格式见 fs 字段 */
  engine: "file" | "sqlite";
  /** FS 存储策略（仅 engine:"file" 时消费） */
  fs?: FsStorageConfig;
}
```

> **主键恒为 `id`**：没有 `primaryKey` 指针——字段名 `id` 即主键（约定固定，见 §2.2、§3.2）。SchemaDef 必须声明 `id: { type: "ulid", required: true }`。

### 2.2 保留字段（两个独立维度）

**「字段名是否保留」与「值由谁管理」是两个正交维度**，不要混为一谈。Persistence 有四个保留名，分属两个组合：

| 保留名 | 名字保留？（SchemaDef 受此名约束） | 值由谁管理 | SchemaDef 是否声明 |
|---|---|---|---|
| `id` | ✅ 是（恒为主键，约定固定） | **业务**（生成 ULID） | ✅ **必须**声明 `id: { type: "ulid", required: true }` |
| `createdAt` | ✅ 是（被 store 占用） | **store**（首次写入注入） | ❌ 禁止声明 |
| `updatedAt` | ✅ 是（被 store 占用） | **store**（每次写入更新） | ❌ 禁止声明 |
| `version` | ✅ 是（被 store 占用） | **store**（自增，乐观锁） | ❌ 禁止声明 |

判定规则一句话：**保留名里，值由业务提供的（`id`）必须声明；值由 store 提供的（`createdAt`/`updatedAt`/`version`）禁止声明。** 详见 `[P0]crud_store_interface.md` §3.3 与本文 §3.2。

### 2.3 类型派生：InferRecord

TS 类型直接从 SchemaDef 反推，业务侧不需要手写 entity interface：

```typescript
/** 把 FieldDef 映射到 TS 类型 */
type TsOf<F extends FieldDef> =
  F["type"] extends "string" | "ulid" | "isoDate" ? string :
  F["type"] extends "number" ? number :
  F["type"] extends "boolean" ? boolean :
  F["type"] extends "enum" ? (F["enumValues"] extends (infer V)[] ? V : string) :
  unknown;  // "json" → 不透明

/** 必填字段进主体，可选字段加 "?" */
type InferRecord<S extends SchemaDef> = {
  [K in keyof S["fields"] & string
     as S["fields"][K] extends { required: true } ? K : never]: TsOf<S["fields"][K]>
} & {
  [K in keyof S["fields"] & string
     as S["fields"][K] extends { required: true } ? never : K]?: TsOf<S["fields"][K]>
};
```

> 这是「静态契约」（类型映射），非运行时实现，表达 SchemaDef 如何决定业务侧拿到的类型。

### 2.4 校验语义

`put` 时 store 按 SchemaDef 做如下校验，不通过按下列错误归类抛出：

| 校验项 | 规则 | 失败错误 |
|---|---|---|
| 主键缺失 | record 无 `id` 字段 | `PrimaryKeyMissingError` |
| 主键格式 | `record.id` 存在但非合法 ULID（业务生成，store 不分配） | `SchemaValidationError` |
| 必填字段 | `required: true` 的字段不得为 `undefined` | `SchemaValidationError` |
| 类型匹配 | 值类型与 `type` 一致（`ulid`/`isoDate` 校验格式） | `SchemaValidationError` |
| enum 取值 | `type: "enum"` 时值必须 ∈ `enumValues` | `SchemaValidationError` |
| 保留字段 | 实体不得自带 `createdAt`/`updatedAt`/`version`（store 注入）；`id` 必须有且仅由业务提供 | `SchemaValidationError` |

> 「缺 id」与「id 格式非法」是两类问题：前者记录根本无主键（无法寻址），后者是值不合规。两类分开报错，便于调用方区分「业务漏传 id」与「业务传了非法 id」。与 crud_store_interface §2.4 错误类型表一致。

## 3. 设计决策

### 3.1 SchemaDef 单一源头，TS 类型派生而非手写

**结论**：SchemaDef 是唯一源头；entity 类型用 `InferRecord<S>` 从它反推，不另写一份 interface。
**理由**：运行时描述符（建表/布局/校验）和编译期类型本质描述同一件事，两份手写必然漂移；派生保证永远一致，也满足「能自动生成最好」的诉求。
**反例**：若 interface 与 SchemaDef 双份手写，加字段时只改一份会出现「类型说有、运行时校验报没有」或反之；若用装饰器从 interface 反向生成 schema，则引入编译期依赖与魔法，超出 spec 层面。

### 3.2 `id` 是保留主键名，值由业务生成，不用 primaryKey 指针

**结论**：字段名 `id` 即主键（约定固定，恒为 ULID），SchemaDef 必须声明它；不设 `primaryKey` 指针。id 的值由业务生成，store 不分配、只校验合法性。
**理由**：CRUD 全程依赖主键寻址，名字固定为 `id` 后 store 可统一认 `id`（SQLite `id` 列直读 `data.id`、FS 文件名恒为 `<id>.json`），无需每个 entity 读指针；且 convention.md §3 规定所有 id 都是 ULID、现有实体（Message/Session）主键都字面叫 `id`，名字可配置的灵活性是 YAGNI。值归业务生成，因业务层（message 首次分配、agent loop 入队）有自己的 id 时机，store 接管会和业务时序耦合。
**反例**：若像 Prisma 那样用 `primaryKey`/`@id` 指针允许任意字段当主键，则 store 每次 CRUD 要先读指针定位字段、SQLite 列与 `data` 间多一层映射，徒增间接；而我们的实体从不使用非 `id` 名做主键，指针的灵活性无人消费。

### 3.3 字段类型用封闭枚举，复杂结构走 "json"

**结论**：`FieldType` 是封闭小集合；嵌套/变长/复杂结构统一用 `type: "json"` 存不透明值。
**理由**：v1 不在 DB 层对业务字段建类型化列（blob 优先，见 SQLite engine §3.1），细粒度类型无收益；封闭枚举让校验与未来按需升级（生成列）可控。
**反例**：若支持任意嵌套字段类型，SchemaDef 会退化为半个类型系统，与 TS 类型重复且复杂；校验/索引升级路径模糊。

### 3.4 v1 索引只覆盖信封字段

**结论**：`IndexDef.fields` v1 仅允许信封字段（id / createdAt / updatedAt / version），业务字段索引留待迭代。
**理由**：v1 查询契约只保证按主键集合与时间范围（见 crud_store_interface §2.3），信封索引足以支撑；业务字段检索是 search engine 的职责。
**反例**：若 v1 开放业务字段索引，则 SQLite engine 要立刻上生成列/表达式索引、FS engine 要维护反向索引，与「blob 优先、方便迭代」冲突。

### 3.5 存储策略是 schema 级 hint，各 engine 各自解释

**结论**：SchemaDef 声明 `engine`（file/sqlite）与 `fs` 存储策略（分片 + 格式）；FS engine 据此路由 shard 目录与选格式，SQLite engine 把 `fs.sharding.shardKeyField` 当普通索引列（不分片、不路由目录）。
**理由**：存储布局是 per-entity 策略，归属 schema（单一源头）；同一份声明两种 engine 各取所需，避免双份配置漂移。
**反例**：若存储配置散在 engine mount 处，则 schema 与布局分离，新增 entity 要两处改、易不一致。

## 4. 示例

> 下面的 SchemaDef **仅为示例**，演示 SchemaDef 结构与分片配置写法；transcript 等业务实体的正式 schema 由各业务模块（如 `agent/session/`）定义，persistence 不替它们定。

分片 entity 示例（file engine + sharding + jsonl，演示写法）：

```typescript
const TranscriptSchema: SchemaDef = {
  entity: "transcript",
  engine: "file",
  fs: {
    sharding: { shardKeyField: "sessionId", dirTemplate: "sessions/{shardKey}/" },
    format: "jsonl",
    jsonlMaxCount: 1000,
  },
  fields: {
    id:        { type: "ulid", required: true },   // 保留名，恒为主键，业务生成
    sessionId: { type: "ulid", required: true },
    role:      { type: "enum", required: true, enumValues: ["user", "assistant", "tool"] },
    content:   { type: "json", required: true },   // ContentBlock[]，归 agent/message
  },
};

// 业务侧拿到的类型，无需手写：
type Message = InferRecord<typeof TranscriptSchema>;
// 等价于 { id: string; sessionId: string; role: "user"|"assistant"|"tool"; content: unknown }
// （演示）落盘到 sessions/<sessionId>/transcript/<段文件>；实际路径由 session 的 schema 决定
```

不分片 entity 示例（sqlite engine，无 sharding）：

```typescript
const AppConfigSchema: SchemaDef = {
  entity: "app_config",
  engine: "sqlite",
  fields: {
    id:     { type: "ulid", required: true },
    key:    { type: "string", required: true },
    value:  { type: "json", required: true },
  },
};
```

## 5. 边界

| 零件 | 归属 |
|------|------|
| SchemaDef 结构、字段类型、`InferRecord`、校验语义 | 本文件 ✅ |
| 存取行为（put/get/query/delete）、信封注入 | `[P0]crud_store_interface.md` |
| FS 目录布局 / SQLite 表结构 | 各 engine 文件 |
| Message / Session 等实体的业务字段含义 | `agent/message/`、`agent/session/` |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
