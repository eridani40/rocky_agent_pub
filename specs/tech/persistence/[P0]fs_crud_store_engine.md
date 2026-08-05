---
type: spec
title: File-System CRUD Store Engine（文件系统存储引擎）
priority: P0
status: active
updated: 2026-08-05
since: v0.0.2
---

# File-System CRUD Store Engine（文件系统存储引擎）

## 1. 概述

**管什么**：CrudStore 契约在文件系统上的实现（目录布局、文件格式、原子写、查询、并发）。
**不管什么**：CrudStore 契约本身（→ `[P0]crud_store_interface.md`）、SchemaDef（→ `[P0]schema_interface.md`）、SQLite 实现（→ `[P0]sqlite_crud_store_engine.md`）。
边界归属规则见 [docs_guide.md](../docs_guide.md) §4。

`FsCrudStore` 把每个 entity 落成一个目录、每条记录落成一个 JSON 文件（或 jsonl 段文件）。**主打可读、可手改、零依赖、便于排查**，适合量小、需要人眼可读的场景（如会话、本地配置）；transcript 这类按 session 聚集的大量记录走分片 + jsonl 段文件。它完整实现 CrudStore 契约，但查询与并发能力受文件系统天然限制（见 §5）。

## 2. 目录与文件布局

**root 与 dirTemplate 的拼接规则（重要）**：
- **root 是基目录**（如 `./data`），engine 所有路径都从它起拼接。
- **dirTemplate 是相对 root 的分片路径模板**（如 `sessions/{shardKey}/`），仅在 `fs.sharding` 存在时消费。
- 分片时 engine 按 dirTemplate 把 `{shardKey}` 替换为字段值，**redirect 到该分片路径**；engine **老实拼接 root + dirTemplate（已替换）+ entity + 文件**，**不自作主张加前缀**——配置什么就是什么，dirTemplate 不写 `sessions/` 段就不出现 `sessions/` 目录，root 也不重复 dirTemplate 已含的段。
- 不分片（无 sharding）时：路径直接是 `{root}/{entity}/<file>`，dirTemplate 不参与。

```
<root>/                               ← root = "./data"（基目录，不自加前缀）
├── sessions/                          ← 来自 dirTemplate="sessions/{shardKey}/" 的 shard 根
│   ├── 01J...sessA.../                ← 一个 shard（shardKey = sessionId 值）
│   │   ├── transcript/                ← entity 名追加在 shard 目录下（同 session 数据聚集）
│   │   │   ├── 01KVCA58....jsonl      ← jsonl 段文件：名=段首条 ULID，段内行按 id 有序
│   │   │   └── 01KVCB00....jsonl
│   │   └── summary/                   ← 同 shardKey 的 summary 聚在同 shard 目录
│   │       └── 01KVC9A2....json       ← json 格式：一记录一文件
│   └── 01J...sessB.../
│       ├── transcript/
│       └── summary/
└── app_config/                        ← 不分片 entity：扁平目录（原行为）
    └── 01KVC....json
```

布局规则：

- **不分片**（无 `fs.sharding`）：`{root}/{entity}/<id>.json`（原行为）。
- **分片**：`{root}/{dirTemplate 中 {shardKey} 替换为字段值}/{entity}/<段或文件>`；同 shardKey 的多个 entity 落在同一 shard 目录下不同子目录（「一个 session 的东西在一起」）。engine 严格按此拼接，不在 root 上额外补 dirTemplate 模板里已有的段。
- **format json**：每记录一个 `{id}.json`（分片时位于 shard 目录下）。
- **format jsonl**：段文件名 = 该段首条记录 ULID（全局字典序可排，= id 范围索引）；段内每行一条记录、按 id 有序；段达 `jsonlMaxCount` 封顶后新开一段。

一条 message 文件内容示例（json 单记录）：

```json
{
  "id": "01KVCA58G80Y54TTF2S8ZPFR5M",
  "sessionId": "01KVCB00ABCDEFGH",
  "role": "user",
  "content": [{ "type": "text", "text": "hello" }],
  "createdAt": "2026-06-19T03:10:00.000Z",
  "updatedAt": "2026-06-19T03:10:00.000Z",
  "version": 1
}
```

jsonl 段文件每行即一条上述记录（同行序按 id 升序）。

## 3. 设计决策

### 3.1 分片路由 + 同 shard 聚集

**结论**：dirTemplate 是相对 root 的分片路径模板（如 `"sessions/{shardKey}/"`），entity 名追加其后；同 shardKey 的多个 entity 聚在同一 shard 目录下不同子目录。
**理由**：transcript 的真实访问路径在 session 内，按 sessionId 分片后同 session 数据物理聚集（含 summary 等兄弟 entity），磁盘局部性好、人工排查时「一个 session 的所有文件在一处」。
**反例**：若 entity 各自独立分片目录（如 `transcript/<sessionId>/` 与 `summary/<sessionId>/`），则同一 session 的数据散在树的不同位置，磁盘与人工都不聚集。

### 3.2 jsonl 段名 = 段首条 ULID

**结论**：段文件名取该段首条（最小 id）记录的 ULID；段名集合按字典序即等于 id 范围有序。
**理由**：ULID 字典序与时间序一致（见 convention.md §3）；定位「id 属于哪段」= 对段名集合二分，O(log 段数)，不读段内容、不依赖 manifest。
**反例**：若段名为自增序号（0001/0002），需要单独维护「段名→id 范围」manifest，引入一致性负担；若按时间窗口切，跨窗口的乱序数据归属模糊。

### 3.3 段内行按 id 有序

**结论**：jsonl 段文件内部每行按 id 升序排列。
**理由**：支持「最近 N 从最大序号段尾部往回读」与「按 id 段内二分定位」两种典型访问，无需额外索引。
**反例**：若段内无序，append-only 写入最快但「最近 N」必须读全段排序，与 transcript 的读多写少特性不符。

### 3.4 insert 两条路径：append 尾段 / 重写插入

**结论**：新 id > 当前 shard 最大 id → append 尾段（尾段达 `jsonlMaxCount` 则新开一段）；新 id < 最大 id（乱序/回填）→ 二分定位段 + 重写段、插到正确行位置。**乱序回填后若插入位置在段首（新首条 id < 原段名），段名需更新为新首条 ULID**（删旧段文件、写新段名文件），保证 §3.2「段名=段首条」不变式（实现 `fs-jsonl.ts:jsonlPut` 插入分支 137-144 行；delete 同样在删首行后更新段名，见 `jsonlDelete` 197-205 行）。
**理由**：transcript 的主路径是顺序 append（id 单调递增），append 尾段 O(1)；乱序回填是低频场景，重写段可接受。段名更新是维护「段名集合字典序 = id 范围序」的必要副作用——否则后续二分定位会落到错误段，导致 get/query 漏数据。
**反例**：若全部走「append + 全局重排」，主路径被拖累；若禁止乱序写入，则回填历史数据无法支持；若回填后不更新段名，则段名不再等于段首条，二分定位语义破坏。

### 3.5 delete/update → 重写段，无 tombstone/compaction

**结论**：delete 删行、update 换行，都重写整个段文件（tmp→rename）；不引入 tombstone、不做 compaction。
**理由**：transcript 的编辑/删除低频，重写段成本可接受；tombstone+compaction 是为高频删改场景准备的优化，YAGNI。
**反例**：若上 tombstone+compaction，需维护墓碑生命周期、后台 compaction 调度，复杂度远超当前需求；若将来高频删改，再上不迟。

### 3.6 原子写不变（tmp → fsync → rename）

**结论**：单记录 json 与 jsonl 段重写都走「写 `<tmp> → fsync → 原子 rename」。
**理由**：rename 在同一文件系统上是原子的，保证崩溃时要么旧版本完整、要么新版本完整，不会出现半截文件。
**反例**：若直接覆写目标文件，进程在写到一半崩溃会留下截断的内容，下次读取解析失败丟记录。

### 3.7 query 不带 shardKey = scatter

**结论**：分片 entity 的 `query` 缺省 `shardKey` → readdir shard 根遍历各 shard 目录，性能差，明确为边界。
**理由**：分片的本质是分区，跨分区扫描失去分区优化的意义；调用方应总是带 shardKey（见 crud_store_interface §3.6）。
**反例**：若 engine 默认 scatter 还声称高效，会误导调用方滥用，掩盖分区设计意图。

## 4. 操作映射

| CrudStore 方法 | FsCrudStore 实现 |
|---|---|
| `put` | 校验 schema → 算信封（首次设 createdAt、每次更新 updatedAt、version 自增）→ 若分片，从 `record[shardKeyField]` 取 shardKey 路由到 shard 目录 → 检查 `ifVersion` → json：原子写 `{id}.json`；jsonl：id>shardMax → append 尾段（满则新段），id<shardMax → 二分定位段 + 重写段插到正确行位置 |
| `get` | shardKey 路由到 shard 目录 → json：读 `{id}.json`；jsonl：二分段名定位段 + 段内取行；不存在返回 undefined |
| `delete` | 路由 → json：`unlink {id}.json`；jsonl：重写段删行；返回是否实际删了 |
| `query` | shardKey 给定 → 限定该 shard 目录；缺省 → scatter 遍历各 shard；其内按 `ids`/时间过滤 + 排序 + `limit`；jsonl 段内按行序，「最近 N」从最大序号段尾部往回读。入口经 `queryWithSlowLog('fs', ...)` 计时包装（慢查询埋点 → crud_store_interface §2.5），`nowMs` 构造注入缺省 `Date.now` |

写入模式与契约一致（crud_store_interface §2.3）：`insert` 检查文件不存在、`replace` 覆盖、`upsert` 二者皆可；`ifVersion` 先读现有 version 比对，不匹配抛 `VersionConflictError`。

## 5. 并发与限制（明确边界）

- **记录级原子**：单条 put/delete 原子（rename 保证）；**跨记录不原子**（无事务），jsonl 段重写也只保证该段原子。
- **并发写同一记录**：靠 `ifVersion` 乐观锁串行化；不用则 last-writer-wins。
- **进程内并发**：**已实现（v0.0.38）**——`putAsync`/`deleteAsync` async 扩展方法 + 锁原语 `file-lock.ts`，按路径 key 串行化同 record 的写。详见 [`[P1]file_write_lock.md`]([P1]file_write_lock.md)。sync `put` 保留（事件循环原子，非并发路径仍可用）；**禁止同 path 混用 sync+async**（sync 不走锁会绕过串行）。
- **多进程共享**：v1 不保证多进程并发写安全（锁原语纯进程内）；如需，上层自行协调或改用 SQLite engine。
- **scatter 成本**：分片 entity 的 query 不带 shardKey 需遍历所有 shard 目录，shard 数多时性能差；应总是带 shardKey。
- **jsonl 重写成本**：乱序 insert / delete / update 触发段重写（O(maxCount)）；transcript 这些操作低频，可接受。
- **量级边界**：单 shard 内 jsonl 段已缓解文件数膨胀，跨 shard scatter 仍是瓶颈；量大场景应切到 SQLite engine 或 search engine。

## 6. 示例

构造与使用（不分片 json entity）：

```typescript
const store = new FsCrudStore({ root: "./data" });

store.put(MessageSchema, msg);                       // → ./data/messages/<id>.json
const got = store.get(MessageSchema, msg.id);        // ← 读回含信封
store.query(MessageSchema, {                         // 扫描 messages/ 目录
  createdAfter: "2026-06-19T00:00:00.000Z",
  order: "createdAtAsc",
  limit: 100,
});
```

分片 + jsonl（transcript，dirTemplate="sessions/{shardKey}/"，root="./data"，必须带 shardKey）：

```typescript
store.put(TranscriptSchema, msg);                                       // → ./data/sessions/<sessionId>/transcript/<段>.jsonl（append 尾段；路径=root+dirTemplate(已替换)+entity）
const got = store.get(TranscriptSchema, msg.id, msg.sessionId);         // 二分段名 + 段内取行
const recent = store.query(TranscriptSchema, {                          // 限定该 shard，最近 50 条
  shardKey: msg.sessionId,
  order: "createdAtDesc",
  limit: 50,
});
```

## 7. 边界

| 零件 | 归属 |
|------|------|
| 目录/文件布局、原子写、query 扫描实现、并发限制 | 本文件 ✅ |
| CrudStore 契约、信封字段语义、PutOptions、QueryFilter | `[P0]crud_store_interface.md` |
| SchemaDef / 字段校验 | `[P0]schema_interface.md` |
| SQLite 实现、事务、字段级索引升级路径 | `[P0]sqlite_crud_store_engine.md` |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
