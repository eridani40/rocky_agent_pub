---
type: spec
title: Search Engine（检索引擎）— History Search（一期 BM25）
priority: P1
status: active
updated: 2026-07-14
since: v0.0.126
---

# Search Engine — History Search（一期 BM25，FTS5 单表 trigram）

> v0.0.126 起 P1 占位转正式。一期 = **派生索引（ingest handler 旁路）+ SQLite FTS5 单表 trigram BM25 + recency 后置重排**。
> 二期（RAG：sqlite-vec + embedding + RRF）预留接口不实现。
>
> 上游：PRD `specs/prd/overall/11-history-search.md` · 设计方案 `reqs/[working] v0.0.126.history_search/proposal_history_search.md`。
> 关联：`[P0]crud_store_interface.md`（CrudStore 边界）· `[P0]sqlite_crud_store_engine.md`（SqliteCrudStore 驱动模式）· `../agent/context/[P0]context_ingest_detail.md`（handler chain）· `../agent/context/[P0]extension point and implementations.md`（search_indexing impl）· `../agent/session/[P0]session_store.md`（transcript + getMessages）。

## 1. 概述

**管什么**：
- SearchEngine 抽象契约（`search(query, opts) → hits[]`，召回 + 打分 + snippet + recency 重排）
- 独立 `search.sqlite` schema（`chunks` + `fts`(external-content) + `idx_meta`）
- SqlDriver 抽象层（dev=`bun:sqlite` / packaged=`node:sqlite` 优先 + `better-sqlite3` fallback）
- HistoryIndexer 串行队列（写入路径，从 ingest handler 接 payload）
- 兜底机制：reconcile / delete cascade / rebuild

**不管什么**：
- 主存写入（→ CrudStore + `store_sink`，SearchEngine **不接管写入路径**）
- transcript 详情取回（→ `SessionStore.getMessages`，SearchEngine 只回 recordId）
- 触发编排（→ ingest handler `search_indexing`，本引擎只暴露 `index()` 入口给 handler 调）
- 工具/endpoint 契约（→ `../agent/tools/history_search_tool.md` 等）

## 2. 边界（与 CrudStore 的关系 — 派生索引）

```
ingest(config, messages)              ← context_ingest_detail.md §1
   │ ordered handler chain
   ├─ store_sink (order 4)            ← 写 transcript 主存（权威）
   └─ search_indexing (order 5) ★NEW  ← 调 HistoryIndexer.index(payloads)
                                       payload 自带 text → 零回读
                                       ↓
                          HistoryIndexer 串行队列
                                       ↓
                          search.sqlite (chunks + fts)

检索路径：
   history_search / GET /history/search
       │ sanitize(query) → MATCH → bm25 → recency 重排 → snippet
       ↓
   hits[{ messageId, sessionId, role, ts, snippet, score }]
       ↓ （取详情/上下文窗）
   SessionStore.getMessages(sessionId, around=messageId, window)   ← 回主存
```

**派生 vs 锚点边界**（不变量）：
- `text` / `role` / `ts` = **派生副本**（可丢可重建，rebuild 从 jsonl 重派生）
- `message_id` = **锚点**（必须对齐 transcript record id）
- 「不依赖原文」仅指：召回/打分/snippet 阶段用副本不回读；indexer worker 吃 payload 不回读。**建索引（提取自原文）和取详情（回 transcript）都依赖原文**。

## 3. 核心设计原则

### 3.1 SqlDriver 抽象（跨 Bun/Node，复用 SqliteCrudStore 调用模式）

```typescript
/** 引擎无关的最小 SQLite 访问契约（search_engine 专用，不接管 CrudStore 的实现）。
 *  dev: bun:sqlite  / packaged: node:sqlite 或 better-sqlite3。 */
interface SqlDriver {
  prepare<T = unknown>(sql: string): SqlStatement<T>;   // 预编译语句（T = 行形状泛型，调用方 prepare<Row>(sql)）
  exec(sql: string): void;                               // 执行多条 SQL（建表、事务包裹等）
  close(): void;
}
interface SqlStatement<T = unknown> {
  /** 参数化查询：params 按 SQL `?` 占位符顺序绑定。U = 行形状泛型（默认 = T，可调用时覆盖） */
  all<U = T>(...params: unknown[]): U[];
  /** 写操作：params 同上；返回 changes + lastInsertRowid */
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}
```

**签名说明**：`SqlStatement` **无独立 `bind()` 方法**——`all(...params)` / `run(...params)` 直接接可变参数做参数化（对齐 `bun:sqlite` / `node:sqlite` / `better-sqlite3` 的共同 API 子集 + `sqlite-store.ts` 既有调用模式）。`prepare<T>(sql)` 是泛型入口，调用方 `prepare<Row>(sql)` 声明行形状后 `.all(...)` 返回 `Row[]`；也可在 `.all<U>(...)` 处临时覆盖形状。

**实现选型**（MUST 按环境二选一）：

| 环境 | 实现 | 来源 |
|---|---|---|
| dev (Bun runtime) | `BunSqlDriver` 包装 `bun:sqlite` | 已有（`app/server/src/persistence/sqlite-store.ts` 同源调用模式） |
| packaged (Electron/Node) | `NodeSqlDriver` 包装 `node:sqlite`（Node 22+ 内置） | **首选**；FTS5 是否编译进去须 spike 实测 |
| packaged fallback | `BetterSqlite3Driver` 包装 `better-sqlite3`（native prebuilt） | 仅当 node:sqlite 缺 FTS5 |

**[PACKAGED-SPIKE]** packaged FTS5 选型是 **v0.0.126 packaged 验证阶段的 spike**，非编码硬阻断（UT 跑 dev `bun:sqlite` FTS5 已确定可用）。spike 输出 go/no-go：node:sqlite 有 FTS5 → 直接用；无 → 启用 better-sqlite3（吃打包护栏，见 §6）。

### 3.2 Schema（独立 search.sqlite）

```sql
CREATE TABLE chunks (
  message_id  TEXT PRIMARY KEY,    -- = transcript record id（ULID），全链路锚点
  session_id  TEXT NOT NULL,       -- 冗余：按 session 删/过滤
  role        TEXT NOT NULL,       -- 'user' | 'assistant'
  ts          TEXT NOT NULL,       -- = message_id（ULID 字典序=时间序，recency 排序）
  text        TEXT NOT NULL        -- content 提取的纯文本副本（供 FTS + snippet）
);
CREATE VIRTUAL TABLE fts USING fts5(
  text,
  content='chunks', content_rowid='rowid',
  tokenize='trigram'
);
CREATE INDEX idx_chunks_session ON chunks(session_id);
CREATE TABLE idx_meta (k TEXT PRIMARY KEY, v TEXT);   -- last_ulid / count / schema_ver / driver
```

**单表 trigram**（一期不分中英文）：中英文统一切 3-gram，都能子串召回（中文「打包」、英文「electron」命中「lect」）。代价：BM25 词义略弱于 unicode61、索引体积略大——本地量级（万~十万 message）无所谓。**取消** hermes 双表路由。

**一条 message = 一 row**（一期不切超长）；二期 assistant 长输出噪声大再按 ~1.5k chars 切，`chunk_id = message_id:idx`，顶层锚点仍 `message_id`（二期范围）。

### 3.3 触发模型（ingest handler 旁路，order 5）

详见 `../agent/context/[P0]extension point and implementations.md §3.1`（`search_indexing` impl 行）。

- handler order=**5**，紧随 `store_sink`(4)
- **失败一致性**（不变量）：`store_sink` 抛错 → chain 中断 → `search_indexing` 不执行 → **永不出现「索引有、主存没有」的孤儿记录**
- handler 协议 `handle(messages, ctx) → messages`（透传，不 transform）：从 `messages[*].id` 直接取 `messageId`（业务生成 ULID，进入 ingest 之前就在对象上）；store **不返回 ID**
- handler 投递 `HistoryIndexer.index(payload[])` **不 await**（不阻塞 ingest），异常吞掉（不影响主存写入）；最终一致由 reconcile 兜底。indexer 内部是 async consumer loop（见 §4），`index()` 仅入队 O(1) 即返回

### 3.4 message_id 全链路锚点（业务生成，无需 store 返回）

`Message.id`（ULID，`agent/schema_defs/message.ts:43`）贯穿「生成 → 落库 → 索引 → 检索回原文」全链路：
- `store_sink` 写库主键 = `m.id`
- `search_indexing` 用同一 `m.id` 作 `chunks.message_id`
- 检索回命中后用 `messageId` 回 `SessionStore.getMessages` 取详情

### 3.5 召回 + 打分 + snippet（索引库内，用 text 副本）

**SearchEngine 构造 + 检索签名**（代码实际）：

```typescript
type SessionTitleResolver = (sessionId: string) => Promise<string | null> | string | null;

interface SearchOptions {
  keywords?: string[];                              // OR boost 关键词（并入 MATCH 表达式）
  scope?: 'all' | 'exclude_current';                // scope=exclude_current 时需配 currentSession
  currentSession?: string;                          // exclude_current 时排除的 session
  after?: string;                                   // 时间下界（ISO 或 ULID，字典序比较）
  before?: string;                                  // 时间上限（ISO 或 ULID，字典序比较）
  topK?: number;                                    // 返回 top_k，默认 10
}

interface HistorySearchHit {
  sessionId: string;
  sessionTitle: string | null;                      // titleResolver 返回 null 时为 null
  messageId: string;                                // 全链路锚点（= transcript record id）
  role: 'user' | 'assistant';
  timestamp: string;                                // 从 messageId ULID 解码的 ISO；非 ULID 时 fallback 到 ts
  snippet: string;                                  // fts snippet(text, '«', '»', ' … ', 12)
  score: number;                                    // 综合分 = abs(bm25) × recency_decay
  debug?: { bm25_score: number; matched_terms: string[]; fts_route: 'bm25' };  // searchWithDebug 附带
}

class SearchEngine {
  // 构造即 ensureSchema（建 chunks + fts + idx_chunks_session + idx_meta，不含 triggers）
  constructor(driver: SqlDriver, titleResolver: SessionTitleResolver = () => null);
  search(query: string, opts: SearchOptions = {}): HistorySearchHit[];
  searchWithDebug(query: string, opts: SearchOptions = {}): HistorySearchHit[];   // 每 hit 附 debug
}
```

**签名要点**（与早期 spec 草稿的偏离，对齐 T1 实现）：
- **`search(query, opts)` 双参**（非单参数对象）：query 是 `string`，opts 是 `SearchOptions`；handler / tool / HTTP 都按双参调
- **构造第二参 = `titleResolver`**（非 SessionStore）：最小回调契约 `(sid) => string | null | Promise<...>`，解耦 SearchEngine 与 SessionStore（bootstrap 注入 `(sid) => sessionStore.getSession(sid)?.title ?? null`）；**一期 titleResolver 默认返 null**（title 解析留二期；UT 可传任意回调）
- **同步 search**：SqlDriver.all 同步返回；`titleResolver` 若返 Promise（异步）则忽略返 null（保 search 同步语义）
- SearchEngine 持 `stmtCache: Map<sql, SqlStatement>`（轻量缓存，driver 是否缓存由实现决定）

**检索 SQL**（external-content 模式 JOIN chunks + 动态拼 WHERE）：

```sql
SELECT c.message_id, c.session_id, c.role, c.ts,
       snippet(fts, 0, '«', '»', ' … ', 12) AS snippet,
       bm25(fts) AS bm25_score
FROM fts JOIN chunks c ON c.rowid = fts.rowid
WHERE fts MATCH ?
  [AND c.session_id != ?]              -- scope=exclude_current 时
  [AND c.ts > ?] [AND c.ts < ?]        -- after / before
ORDER BY bm25(fts) LIMIT ?;
```

- query 经 `_sanitize`（剥 FTS5 控制字符防注入：`"`/`*`/`:`/`(`/`^`）→ trigram 分词 → 拼 `"token1" OR "token2"` 表达式 → MATCH 召回
- `keywords` 同样经 sanitize + trigram 后并入 OR 表达式作 boost
- 排序：`bm25(fts)` 拉 `k_pre`（默认 `top_k * 3`，上限 50）→ recency 半衰期后置重排取 `top_k`
- recency：从 `message_id` ULID 解码时间戳（`decodeUlidTime`，前 10 字符 Crockford base32 → ms）；非 ULID 视为最新（decay=1，不打折）；半衰期默认 30 天（`decay = 0.5 ^ (age_days / 30)`）

### 3.6 Schema 耦合（SearchEngine vs HistoryIndexer，已知设计债）

**两份 schema DDL 共存**（生产路径靠 bootstrap 顺序 + IF NOT EXISTS 幂等双保险）：

| 函数 | 文件 | 建 | 不建 |
|---|---|---|---|
| `SearchEngine.ensureSchema()` | `search-engine.ts:104` | `chunks` + `fts`(external-content, trigram) + `idx_chunks_session` + `idx_meta` | **triggers** |
| `ensureHistorySchema(driver)` | `history-indexer.ts:57` | `chunks` + `idx_chunks_session` + `fts` + **3 triggers**（`chunks_ai`/`_ad`/`_au` AFTER INSERT/DELETE/UPDATE on chunks → 自动同步 fts） + `idx_meta` | — |

**为何分两份**（已知设计债，非 bug）：
- SearchEngine 是只读消费方（search 不写 chunks），但需要 schema 存在才能 SELECT
- HistoryIndexer 是写入方，依赖 triggers 让「INSERT INTO chunks」自动级联插 fts（external-content 模式必需）
- 两方各自建表（4 表 ×2 重复）= 双方独立实例化即可工作（UT 隔离 SearchEngine 测试不必启 indexer）

**生产路径不变量**：
- **bootstrap 顺序**：先 `new SearchEngine(driver, titleResolver)`（建表不含 triggers）→ 再 `new HistoryIndexer(driver, dataRoot)`（ensureHistorySchema 补 triggers）
- 双方 DDL 全 `IF NOT EXISTS` → 重叠的 4 表幂等不冲突；HistoryIndexer 后建 triggers 不影响 SearchEngine 已建的表
- 行为正确性：trigger 存在 → `INSERT INTO chunks` 自动同步 fts → search 能查到；trigger 不存在（如仅启 SearchEngine 未启 indexer）→ 写入不进 fts（但生产不会发生，bootstrap 保证两者都启）

**未来重构方向**（一期不做）：合并为单一 `ensureSearchSchema(driver)` 函数，triggers 归属写入方。一期保留双份因 bootstrap 顺序 + IF NOT EXISTS 已保证正确，且 UT 隔离受益（独立测试 SearchEngine 不需 triggers）。

### 3.7 search_indexing handler 的 indexer 注入（delegate holder）

`search_indexing` ingest handler 需持 `HistoryIndexer` 引用投递索引，但 plugin_manager 经 `new ImplClass(implId, cfg)` 实例化 EP impl（**按需 new，无缓存**），构造器签名只接 `(implId, cfg)` 无法直接注入 HistoryIndexer；且 bootstrap 阶段拿不到按需实例化的 handler 实例。

**delegate holder 模式**（与 `session-store-ep-delegate.ts` 同模式，server → server 注入）：

```typescript
// app/server/src/persistence/search-indexer-ep-delegate.ts
let delegate: HistoryIndexer | null = null;
export function setSearchIndexerEpDelegate(indexer: HistoryIndexer): void { delegate = indexer; }
export function getSearchIndexerEpDelegate(): HistoryIndexer | null { return delegate; }
```

- **holder 放 server 侧**（非 plugin 侧）：plugin → server 是允许的依赖方向（plugin 已 import server 类型）；server → plugin 违反 rootDir + 语义。SearchIndexingHandler 从此 import `getSearchIndexerEpDelegate`；bootstrap 装配 HistoryIndexer 后调 `setSearchIndexerEpDelegate(idx)` 完成注入（server → server）
- **兼容两注入路径**：handler 同时支持 `setIndexer(idx)`（UT 显式注入）+ delegate holder（生产路径）；handle 时优先 setIndexer 注入的，未注入则回退 holder（null 时 no-op）
- **UT 隔离**：`__resetSearchIndexerEpDelegateForTest()` afterEach 重置防跨 case 泄漏

### 3.8 取详情（回 transcript，用 messageId 锚点）

副本只存纯文本，原文的结构化内容（image block / tool_use / tool_result）副本没有 → 取详情、看上下文、跳转 **必须** 用 `message_id` 回 transcript。详见 `../agent/tools/history_get_context_tool.md`。

这正是本文档 §2 边界：「SearchEngine 召回 recordId → 回 CrudStore/SessionStore.get 取详情」。

## 4. 写入路径：HistoryIndexer

```typescript
interface HistoryIndexer {
  /** handler 投递入口：push 内部队列 + lazy 启动 consumer loop（首次）。不 await（fire-and-forget），异常吞。背压满 drop new + warn。 */
  index(payload: IndexPayload | IndexPayload[]): void;
  /** 等待队列排空（UT/维护用，bounded poll；生产路径不调）。MUST NOT 直接调 _flushBatch（破单 worker）。 */
  flush(): Promise<void>;
  /** 启动兜底：委托 history-indexer-reconcile.ts，扫 jsonl 补索 id > last_ulid 的 record。签名 async 但内部同步阻塞（启动期跑一次）。 */
  reconcile(): Promise<{ scanned: number; indexed: number }>;
  /** 清库 + 全扫重建（schema 升级 / 首次启用历史回填）。进度写 idx_meta。 */
  rebuild(): Promise<{ total: number; indexed: number }>;
  /** session 级联删（session.destroyed 事件触发）。 */
  deleteBySession(sessionId: string): Promise<number>;
  /** 维护/调试：返回 chunk 数 / last_ulid / 库大小 / driver。 */
  stats(): { count: number; last_ulid: string | null; driver: string; sizeBytes: number };
}

interface IndexPayload {
  messageId: string;   // ULID，全链路锚点
  sessionId: string;
  role: 'user' | 'assistant';
  ts: string;          // = messageId
  text: string;        // extractPlainText(content ContentBlock[])
}
```

**async consumer loop**（不变量）：
- **单 worker 保序**：进程内单一 `_consumerLoop()` 实例（`loopStarted` flag lazy 启动于首次 `index()`；保序、无并发竞争 SQLite 写锁）
- **批间 MUST `await` 让出 event loop**（防回归闸）：每处理 1 batch → `await sleep(BATCH_INTERVAL_MS=1000)`；queue 空 → `await sleep(IDLE_WAIT_MS=50)` 轮询。**MUST NOT** 退回同步 while 排空整队列——会独占 event loop 阻塞整个 server（v0.0.136 修此 bug）
- **batch 32 单事务**：`_flushBatch` splice BATCH_SIZE=32 条 → 单事务 `BEGIN / INSERT INTO chunks ×N / COMMIT`（fts 由 `chunks_ai` trigger 自动同步，非手动 INSERT fts）；失败 ROLLBACK + try/catch 吞 → 继续下一批不堆积死锁 → reconcile 兜底
- **背压**：`MAX_QUEUE_SIZE=5000`，满时 drop new + warn（保 FIFO 序；被丢的 payload 已在 store_sink 落 jsonl，下次启动 reconcile 补）
- **last_ulid 水位**：每批 `max(ts)` UPSERT `idx_meta.last_ulid`（reconcile 增量扫的起点）

## 5. 兜底机制（reconcile / delete / rebuild）

| 机制 | 触发 | 文本来源 | 行为 |
|---|---|---|---|
| **启动 reconcile** | 后端启动（bootstrap fire-and-forget） | 落盘 jsonl | 委托 `history-indexer-reconcile.ts:reconcileTranscripts()`（`HistoryIndexer.reconcile()` 是 thin wrapper）：读 `idx_meta.last_ulid` → 顺序扫所有 `sessions/*/transcript/*.jsonl` 里 `id > last_ulid` 的 record 补索。**同步阻塞**（readdirSync/readFileSync/sync SQLite 写），启动期跑一次——同源问题，未走 async loop |
| **deleteSession 级联** | `session.destroyed` 事件 | — | `DELETE FROM chunks WHERE session_id=?`（FTS external-content 自动级联删 fts 索引行） |
| **rebuild 命令** | 手动 / schema 升级 / 首次启用历史回填 | 落盘 jsonl | 清库 → 全扫 jsonl 重建；进度写 `idx_meta` |

**文本来源时序**（不变量）：
- 增量（ingest 时）：内存 messages（handler 提取）
- reconcile / rebuild：落盘 jsonl（无 ingest 流，只能读文件）

## 6. 打包护栏（CLAUDE.md 持续可打包）

**[PACKAGED-GUARD-1 依赖归属]** 若 spike 结果启用 `better-sqlite3`：**必须**声明进 `app/server/package.json`（workspace 级 deps，非根 `package.json`）+ build-dmg `asarUnpack` + ABI rebuild for Electron 42。仅当 node:sqlite 缺 FTS5 时启用。

**[PACKAGED-GUARD-2 路径展开]** `search.sqlite` 路径走 `resolveDataDir`（`app/server/src/config.ts:50`）单一展开权威：`join(resolveDataDir(), 'search.sqlite')`。**禁止**字面 `~` 拼接 / 相对路径（packaged cwd=`/`，相对路径崩 EACCES）。

**[PACKAGED-GUARD-3 runtime-config]** 一期无新增必需运行时 env 键（reconcile 半衰期/批量大小走代码默认值）。二期若加 `HISTORY_SEARCH_*` 调参键再进 `app/electron/src/runtime-config.ts` 白名单。

**[PACKAGED-VERIFY]** spike + 实测：解包 asar → 起 `@app/server/dist` 后端 → 建索引 → 真查询（`GET /history/search?q=...`）→ 返回非空 hits。dev AT 豁免（用户裁决 UT-now），packaged 必须人工验一次。

## 7. 与 CrudStore 关系（边界声明）

- SearchEngine **只读消费**已落盘的 transcript（派生副本建在独立 search.sqlite，主存读路径完全不变）
- 写入路径**不双写 SchemaDef**（不改 `MessageSchema` 加 search engine 声明、不动 `CompositeStore`）
- 召回 recordId 列表后回 `SessionStore.getMessages(sessionId, around=messageId, window)` 取详情
- 寻址用 `entity=transcript + message_id`，**不重新发明**实体标识
- schema 字段集（`text`/`role`/`ts`）是 search 专属派生字段，不复用 SchemaDef 也**不另立 SearchIndexDef**（一期）

## 8. 二期（OUT，预留接口不实现）

- sqlite-vec 向量索引（loadable ext，asarUnpack）
- embedding 通道（llm_caller 新增 `/embeddings` provider → transformers.js + multilingual-e5-small 本地保底）
- RRF(k=60) 混合融合 + recency 后置重排（两路：BM25 + 向量）
- session 摘要第二路召回（两级检索）
- 长输出分块（~1.5k chars，`chunk_id = message_id:idx`，顶层锚点仍 `message_id`）
- 索引存 embedding model 指纹（换模型全量重嵌）

一期接口（`search(query,opts)`、`IndexPayload`、handler 契约、endpoint）**预留二期扩展点**，但二期实现不在 v0.0.126 范围。

## 9. 版本

> 变更历史见 [`log.md`](log.md) + `specs/tech/version_logs/v0.0.126/change_log.md`。
