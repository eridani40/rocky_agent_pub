# v0.0.126 · history_search（一期 FTS5 BM25）

> 跨版本发布说明（版本轴）。位置轴变更见各 KB 的 `log.md`：
> - `specs/tech/persistence/log.md`（SearchEngine + HistoryIndexer + SqlDriver 主变更）
> - `specs/tech/agent/context/log.md`（search_indexing ingest handler 新增）
> - `specs/tech/agent/tools/log.md`（history_search + history_get_context 两 LLM tool）

## 概要

一期 = **派生索引（ingest handler 旁路）+ SQLite FTS5 单表 trigram BM25 + recency 后置重排**。二期（RAG：sqlite-vec + embedding + RRF）预留接口不实现。

- **新增子系统**：SearchEngine（检索引擎）+ HistoryIndexer（写入队列 + 兜底）+ SqlDriver 抽象（dev/packaged 引擎无关）+ search.sqlite 独立 schema
- **新增 ingest handler**：`search_indexing`（order 5 紧随 store_sink，派生索引旁路 sink）
- **新增 2 个 LLM tool**：`history_search`（FTS5 BM25 召回）+ `history_get_context`（按 messageId 回 transcript 取上下文窗）
- **新增 HTTP 端点**：`GET /history/search`（一期调试/verifier 用）

## 新增文件

| 模块 | 文件 |
|---|---|
| persistence | `app/server/src/persistence/search-engine.ts`（SearchEngine 主类 + sanitize/trigram/recency） |
| persistence | `app/server/src/persistence/search-sql-driver.ts`（SqlDriver 抽象 + 3 实现 + 工厂） |
| persistence | `app/server/src/persistence/history-indexer.ts`（写入队列 + reconcile/rebuild/deleteBySession） |
| persistence | `app/server/src/persistence/search-text-util.ts`（extractPlainText 共享实现） |
| persistence | `app/server/src/persistence/search-indexer-ep-delegate.ts`（delegate holder，server → server 注入） |
| plugin/ingest | `app/plugins/builtins/rocky_context/ingest/search_indexing.ts`（EP impl） |
| tools | `app/server/src/tools/history-search-tool.ts`（history_search LLM tool） |
| tools | `app/server/src/tools/history-get-context-tool.ts`（history_get_context LLM tool） |
| handlers | `app/server/src/handlers/history-search.ts`（HTTP GET /history/search handler） |

## spec↔code drift 修（doc-modifier 阶段 5）

| 项 | spec 原文（早期草稿） | 代码实际 | spec 修正位置 |
|---|---|---|---|
| SqlStatement 接口 | `bind(...params): SqlStatement` + `all<T>(): T[]` | 无 `bind()`，`all(...params)` / `run(...params)` 直接参数化 | `[P1]search_engine.md §3.1` |
| SearchEngine.search 签名 | 单参数对象 `search({query, keywords, scope, timeRange, top_k})` | 双参 `search(query, opts: SearchOptions)`，opts 字段 `currentSession`/`topK`/`after`/`before`（camelCase） | `[P1]search_engine.md §3.5` |
| SearchEngine 构造签名 | `(driver, sessionStore)` | `(driver, titleResolver: SessionTitleResolver)`；titleResolver 最小回调 `(sid)=>string\|null`，一期返 null | `[P1]search_engine.md §3.5` |
| indexer 注入 | 无（spec 未写） | delegate holder（`search-indexer-ep-delegate.ts`，server → server 注入，与 session-store-ep-delegate 同模式） | `[P1]search_engine.md §3.7` |
| search_indexing scope disable 机制 | `disableImplInForked(...)` API | **声明式 yaml**（`app/plugins/scopes/forked.yaml` 的 `{implId, enabled: false}` + ScopeConfigLoader），**非 API** | `extension point and implementations.md §3.9` 后 scope 配置行 |
| extImpls 计数 | 43（spec §1 + §3 标题） | 46（manifest 实际登记） | `[P0]extension point and implementations.md` §1 + §3 标题 + §3 末尾合计 |
| SearchEngine.search 调用（tool） | 单参对象 + `excludeSessions` 数组 + `timeRange` 嵌套 | 双参 + `scope`/`currentSession` 字段 + `after`/`before` 平铺 + `topK` camelCase | `[P1]history_search_tool.md §2` |
| history_get_context around | `getMessages({around, before, after})`（假设 SessionStore 支持 around） | SessionStore 的 MessageRange **无 around 字段**；用 `Promise.all([beforeId=messageId+limit=before, fromId=messageId+limit=after+1])` 组合 + 去重 + 升序 | `[P1]history_get_context_tool.md §2/§3` |
| GET /history/search 错误表 | 仅 500 | 加 **503 SERVICE_UNAVAILABLE**（SearchEngine 未装配）；500 留给 search 执行抛错 | `specs/api/overall/19-history-search.md §1 错误表` |

## 已知设计债（不重构，spec 明文记录）

**SearchEngine vs HistoryIndexer schema 耦合**（`[P1]search_engine.md §3.6`）：
- `SearchEngine.ensureSchema()` 建 chunks + fts + idx_chunks_session + idx_meta（**不含 triggers**）
- `ensureHistorySchema(driver)` 建 triggers（AFTER INSERT/DELETE/UPDATE on chunks → 自动同步 fts）
- schema DDL 在两文件各一份（4 表 ×2 重复）—— 行为正确（bootstrap 顺序 SearchEngine 先、HistoryIndexer 后 + 双方 IF NOT EXISTS 幂等双保险）；未来可合并 `ensureSearchSchema` 单函数（一期不做，因 UT 隔离受益）

## 验证范围

- **UT**：search-engine / search-sql-driver / history-indexer / history-search-tool / history-get-context-tool / history-search handler / history-search-bootstrap（7 文件）
- **AT**：一期豁免（用户裁决 UT-now / AT-later），端点契约冻结见 `specs/api/overall/19-history-search.md`
- **ET**：无（一期无 UI 改动）
- **packaged spike**：未跑（一期 dev `bun:sqlite` FTS5 已确定可用；packaged node:sqlite vs better-sqlite3 FTS5 spike 待 packaged 验证阶段，非编码硬阻断）
