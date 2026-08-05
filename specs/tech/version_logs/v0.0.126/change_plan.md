# v0.0.126 变更计划书 — history_search（一期 BM25 FTS5 派生索引）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 上游 PRD：`specs/prd/overall/11-history-search.md` · 设计方案：`reqs/[working] v0.0.126.history_search/proposal_history_search.md`。
> 产出 specs：`specs/tech/persistence/[P1]search_engine.md`（占位→正式）+ `specs/tech/agent/tools/[P1]history_search_tool.md` + `[P1]history_get_context_tool.md` + `specs/tech/agent/context/[P0]extension point and implementations.md`（登记 search_indexing）+ `specs/api/overall/19-history-search.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（search_engine / context_ingest / tools / router / bootstrap） |
| 文件路径 | 完整相对路径（相对 worktree 根） |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

---

## 变更清单

### 模块 1: search_engine — SqlDriver 抽象 + schema + 检索

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| search_engine | app/server/src/persistence/search-sql-driver.ts | `SqlDriver` (interface) | 新增 | 引擎无关最小 SQLite 访问契约：`prepare(sql)` / `exec(sql)` / `close()` | MUST 不接管 CrudStore 的 SqliteStore 实现；MUST 仅 search.sqlite 专用 | search_engine.md §3.1 | +15 |
| search_engine | app/server/src/persistence/search-sql-driver.ts | `SqlStatement` (interface) | 新增 | 预编译语句契约：`bind` / `all` / `run` | 对齐 bun:sqlite 与 node:sqlite/better-sqlite3 的共同 API 子集 | search_engine.md §3.1 | +8 |
| search_engine | app/server/src/persistence/search-sql-driver.ts | `BunSqlDriver` (class) | 新增 | dev 实现：包装 `bun:sqlite` 的 `Database`（`import { Database } from 'bun:sqlite'`）；构造 `new Database(path)`；prepare 委托 `db.prepare(sql)` | MUST 仅 dev/runtime 用；packaged 走 NodeSqlDriver/BetterSqlite3Driver | sqlite-store.ts:19（同源 bun:sqlite 调用模式） | +25 |
| search_engine | app/server/src/persistence/search-sql-driver.ts | `NodeSqlDriver` (class) | 新增 | packaged 首选：包装 `node:sqlite` 的 `DatabaseSync`（Node 22+ 内置） | MUST 仅当 packaged spike 验证 node:sqlite 含 FTS5 才启用；MUST NOT 引入 better-sqlite3 时同时启用 | search_engine.md §3.1 + §6 [PACKAGED-SPIKE] | +25 |
| search_engine | app/server/src/persistence/search-sql-driver.ts | `BetterSqlite3Driver` (class) | 新增 | packaged fallback：包装 `better-sqlite3`（native prebuilt）；仅 node:sqlite 缺 FTS5 时启用 | MUST 声明进 `app/server/package.json` deps；MUST asarUnpack + Electron ABI rebuild | search_engine.md §6 [PACKAGED-GUARD-1]；CLAUDE.md 持续可打包护栏 | +25 |
| search_engine | app/server/src/persistence/search-sql-driver.ts | `createSqlDriver(path)` | 新增 | 工厂：按 runtime（`process.versions.bun` 存在 → BunSqlDriver；否则按 spike flag 选 Node/BetterSqlite3） | MUST 路径走 `resolveDataDir()`（绝对路径，禁字面 `~`） | config.ts:50 resolveDataDir；search_engine.md §6 [PACKAGED-GUARD-2] | +15 |
| search_engine | app/server/src/persistence/search-engine.ts | `SearchEngine` (class) | 新增 | 检索引擎主类：持 `SqlDriver` + `SessionStore` ref（取 sessionTitle）；`search()` / `searchWithDebug()` | MUST 召回阶段不读 transcript（只用副本）；取详情回 SessionStore.getMessages | search_engine.md §3.5 + §3.6 | +30 骨架 |
| search_engine | app/server/src/persistence/search-engine.ts | `SearchEngine.search(query, opts)` | 新增 | 入口：sanitize(query) → trigram 分词 → MATCH + OR keywords → bm25 拉 k_pre → recency 半衰期重排取 top_k → snippet | MUST sanitize 剥 FTS5 控制字符防注入（`"`/`*`/`:`/`(`）；MUST recency 用 `ts=message_id` ULID 字典序；MUST NOT 召回阶段回读 transcript | search_engine.md §3.5 | +60 |
| search_engine | app/server/src/persistence/search-engine.ts | `SearchEngine.ensureSchema()` | 新增 | 启动时建表：`chunks` + `fts`(external-content,trigram) + `idx_chunks_session` + `idx_meta`；IF NOT EXISTS 幂等 | MUST tokenize='trigram'；MUST external-content content='chunks'；schema 见 search_engine.md §3.2 | search_engine.md §3.2 | +35 |
| search_engine | app/server/src/persistence/search-engine.ts | `_sanitize(query)` | 新增 | 私有：剥 FTS5 控制字符（`"`/`*`/`:`/`(` /`)`/`^`），split 成 trigram tokens，拼 OR 表达式 | MUST 防 FTS5 注入；空查询返空表达式（search 返空 hits） | search_engine.md §3.5 | +20 |
| search_engine | app/server/src/persistence/search-engine.ts | `_applyRecency(hits)` | 新增 | 私有：bm25 拉 k_pre 后，按 `ts` ULID 算 age_days，`decay = 0.5^(age_days/30)`，重排取 top_k | MUST 半衰期 30 天代码默认；MUST NOT 改 chunks 表 | search_engine.md §3.5 | +20 |
| search_engine | app/server/src/persistence/search-engine.ts | `extractPlainText(content)` | 新增 | 私有 util：ContentBlock[] → 仅 `type=text` part 的 text 拼接（剥 image/tool_use/tool_result 等） | MUST 只取 type=text；其他 block 不进副本 | proposal §3.1；PRD §11.2.3 | +15 |
| search_engine | app/server/src/persistence/search-engine.ts | `HistorySearchHit` (interface) | 新增 | 返回结构 type：`{sessionId, sessionTitle, messageId, role, timestamp, snippet, score, debug?}` | 字段对齐 PRD §11.2.1 + endpoint 19-history-search.md §1 | search_engine.md §3.5 | +12 |

### 模块 2: search_engine — HistoryIndexer（写入队列 + 兜底）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| search_engine | app/server/src/persistence/history-indexer.ts | `HistoryIndexer` (class) | 新增 | 串行队列 worker：持 `SqlDriver`，`index(payload)` / `reconcile()` / `rebuild()` / `deleteBySession()` / `stats()` | MUST 单 worker 串行（无并发写锁竞争）；MUST batch 32/事务；MUST 异常吞 + reconcile 兜底 | search_engine.md §4 | +45 骨架 |
| search_engine | app/server/src/persistence/history-indexer.ts | `IndexPayload` (interface) | 新增 | `{messageId, sessionId, role, ts, text}` — handler → indexer 的 payload type | MUST ts = messageId（ULID）；MUST role ∈ {user,assistant} | search_engine.md §4 | +8 |
| search_engine | app/server/src/persistence/history-indexer.ts | `HistoryIndexer.index(payload)` | 新增 | handler 投递入口：吃 payload（自带 text），push 内部队列，**不 await**（fire-and-forget），异常吞 | MUST NOT 阻塞 ingest；MUST NOT 回读 jsonl；失败重试 3 次 + reconcile 兜底 | search_engine.md §4 + §3.3 | +25 |
| search_engine | app/server/src/persistence/history-indexer.ts | `HistoryIndexer._flushBatch()` | 新增 | 私有 worker 循环：批量 32 条 INSERT chunks + INSERT fts(rowid, text)，单事务；更新 `idx_meta.last_ulid` | MUST 单事务保证原子；MUST last_ulid 用本批最大 ts | search_engine.md §4 | +35 |
| search_engine | app/server/src/persistence/history-indexer.ts | `HistoryIndexer.reconcile()` | 新增 | 启动兜底：读 `idx_meta.last_ulid`，扫所有 `sessions/*/transcript/*.jsonl` 里 `id > last_ulid` 的 record 补索；session 维度并行 | MUST 文本来源 = 落盘 jsonl（不是内存 messages）；MUST session 维度分片并行 | search_engine.md §5；PRD §11.2.5 | +50 |
| search_engine | app/server/src/persistence/history-indexer.ts | `HistoryIndexer.rebuild()` | 新增 | 清库 + 全扫 jsonl 重建；进度写 `idx_meta`；用于 schema 升级 / 首次启用历史回填 | MUST 清库前不破坏主存（search.sqlite 独立）；MUST 全扫后 idx_meta.count 与 chunks 行数一致 | search_engine.md §5 | +30 |
| search_engine | app/server/src/persistence/history-indexer.ts | `HistoryIndexer.deleteBySession(sessionId)` | 新增 | session 级联删：`DELETE FROM chunks WHERE session_id=?`（FTS external-content 自动级联删 fts 行） | MUST external-content schema 保证级联；MUST idempotent | search_engine.md §5；session-store.ts:81 onSessionDestroyed | +15 |
| search_engine | app/server/src/persistence/history-indexer.ts | `HistoryIndexer.stats()` | 新增 | 维护/调试：返 `{count, last_ulid, driver, sizeBytes}` | MUST 不抛错（库未初始化返 count=0） | search_engine.md §4 | +12 |

### 模块 3: context_ingest — search_indexing handler

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|
| context_ingest | app/plugins/builtins/rocky_context/ingest/search_indexing.ts | `SearchIndexingHandler` (class) | 新增 | ext impl：`handle(messages, ctx) → messages`（透传）；遍历 messages，role∈{user,assistant} 提取 text → `indexer.index(payload[])`（不 await） | MUST order=5（紧随 store_sink(4)）；MUST 透传 messages 不 transform；MUST NOT await indexer；MUST NOT 抛异常（吞掉不影响 ingest） | extension_point_and_implementations.md §3.1；context_ingest_detail.md §3；search_engine.md §3.3 | +35 |
| context_ingest | app/plugins/builtins/rocky_context/ingest/search_indexing.ts | impl 导出 | 新增 | 默认导出 `SearchIndexingHandler` 实例（manifest impl 路径 `./ingest/search_indexing.ts`） | MUST 文件路径对齐 manifest 声明 | extension_point_and_implementations.md §5 manifest | +3 |
| context_ingest | app/plugins/builtins/rocky_context/plugin.json | `extImpls[]` | 修改 | manifest 加 `{implId:"search_indexing", point:"context_ingest_handler", impl:"./ingest/search_indexing.ts", description:"..."}`（在 store_sink 之后） | MUST 登记序在 store_sink 后（补位 order=5）；MUST NOT 加 priority 字段（已废） | extension_point_and_implementations.md §5 | +2 |
| context_ingest | app/plugins/builtins/rocky_context/plugin.json | manifest 计数注释 | 修改 | extImpls 总数注释从 43 → 44（context_ingest_handler 4→5） | MUST 数与实际 extImpls[] 行数一致 | extension_point_and_implementations.md §3 末尾 | +1/-1 |
| context_ingest | app/server/src/bootstrap.ts | `bootstrapScopePolicy()` 或等价 forked 配置 | 修改 | forked scope 加 `disableImplInForked('context_ingest_handler', 'search_indexing')`（forked 不进历史索引） | MUST forked disable；MUST default 仍 active；MUST 幂等（重跑不报错） | extension_point_and_implementations.md §5 v0.0.66 scope 配置 + v0.0.126 新增 | +5 |

### 模块 4: tools — history_search + history_get_context

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tools | app/server/src/tools/history-search-tool.ts | `historySearchTool` (const) | 新增 | Tool 对象：`definition.name='history_search'`，inputSchema(query/keywords/scope/time_range/top_k)，`policy.kind='auto'`（免审批），`run()` 调 `searchEngine.search()` | MUST read-only；MUST policy=auto；MUST query/keywords 至少一个（run 内校验，非 schema required） | history_search_tool.md §2 | +60 |
| tools | app/server/src/tools/history-search-tool.ts | `formatHits(hits)` | 新增 | 私有：把 HistorySearchHit[] 格式化成 LLM 可读纯文本 | MUST 含 messageId/sessionId 锚点（让 LLM 能调 history_get_context） | history_search_tool.md §3 | +15 |
| tools | app/server/src/tools/history-get-context-tool.ts | `historyGetContextTool` (const) | 新增 | Tool 对象：`definition.name='history_get_context'`，inputSchema(sessionId/messageId/before/after)，`policy.kind='auto'`，`run()` 调 `sessionStore.getMessages()` | MUST read-only；MUST policy=auto；sessionId/messageId required | history_get_context_tool.md §2 | +55 |
| tools | app/server/src/tools/history-get-context-tool.ts | `formatContextWindow(messages, anchorId)` | 新增 | 私有：Message[] 格式化 LLM 可读文本；超长截断 + offload 标记；image block → `[image: omitted]` | MUST 单 message 超 ~8k chars 截断；MUST tool_result 超 ~25k 截断 | history_get_context_tool.md §4 | +30 |
| tools | app/server/src/tools/registry.ts 或等价注册处 | tool 注册入口 | 修改 | 注册 `historySearchTool` + `historyGetContextTool` 进 builtin tools（按现有 tool 注册惯例） | MUST 注册路径对齐现有（web_fetch/web_search 等的注册方式） | tools/engine.ts:274 toolName 体系 | +5 |

### 模块 5: router — GET /history/search endpoint

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| router | app/server/src/router.ts | `GET /history/search` 分支 | 修改 | 新增 path/method 分发：`if (method==='GET' && path==='/history/search') return handleHistorySearch(req, searchEngine)` | MUST 在现有 if-else 链中插入（对齐 /provider /session 等同级）；MUST NOT 加 gate（一期公开） | router.ts:507 /provider 分支 pattern；19-history-search.md §3 | +5 |
| router | app/server/src/handlers/history-search.ts | `handleHistorySearch(req, searchEngine)` | 新增 | handler：解析 query params（q/keywords/scope/current_session/after/before/top_k/debug）→ 委托 `searchEngine.search()` / `searchWithDebug()` → 序列化响应 | MUST q/keywords 二选一校验（缺 → 400 BAD_REQUEST）；MUST scope=exclude_current 时 current_session 必填校验 | 19-history-search.md §1 | +60 |
| router | app/server/src/handlers/history-search.ts | `_parseKeywords(csv)` | 新增 | 私有：CSV → string[]，过滤空/重复 | MUST 不抛错（空字符串 → 空数组） | 19-history-search.md §2 | +8 |
| router | app/server/src/handlers/history-search.ts | `_parseTimeRange(after, before)` | 新增 | 私有：接受 ISO 或 ULID；ISO 转 ULID 字典序比较（或保留 ISO 由 SQL 过滤，coder 决策） | MUST ISO 和 ULID 都接受 | 19-history-search.md §1 | +12 |

### 模块 6: bootstrap — 装配 SearchEngine + HistoryIndexer

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bootstrap | app/server/src/bootstrap.ts | SearchEngine + HistoryIndexer 装配 | 修改 | bootstrap 流程加：`const driver = createSqlDriver(join(resolveDataDir(), 'search.sqlite'))` → `const indexer = new HistoryIndexer(driver)` → `const searchEngine = new SearchEngine(driver, sessionStore)` → 注入 router + handler `search_indexing` 的 deps | MUST search.sqlite 路径走 resolveDataDir（绝对路径）；MUST 注入 SessionStore ref（取 sessionTitle）；MUST 启动调 `indexer.reconcile()`（防丢事件/崩溃恢复） | config.ts:50；search_engine.md §5；PRD §11.2.5 | +25 |
| bootstrap | app/server/src/bootstrap.ts | `onSessionDestroyed` 链 | 修改 | SessionStore 构造时注入 `onSessionDestroyed` 回调：调 `indexer.deleteBySession(sid)`（级联删索引） | MUST idempotent；MUST 与现有 cron onSessionDestroyed 链共存（不互斥） | session-store.ts:81 onSessionDestroyed 字段；search_engine.md §5 | +8 |
| bootstrap | app/server/src/bootstrap.ts | `search_indexing` handler 的 indexer 注入 | 修改 | plugin 装载后给 SearchIndexingHandler 注入 indexer 引用（plugin → server import，类似 persistent_session_store 的 delegate holder 模式） | MUST 通过 setIndexer 或构造注入（不用全局单例）；MUST forked scope 不调（已 disable） | extension_point_and_implementations.md §3.9 persistent_session_store pattern | +10 |

---

## 影响面评估

**跨模块**：search_engine（新） / context_ingest（plugin + bootstrap scope 配置） / tools（新 2 个） / router（新 endpoint） / bootstrap（装配）。

**依赖顺序**（底层先于上层）：
1. `search-sql-driver.ts`（SqlDriver 抽象 + 3 实现）— 无依赖
2. `search-engine.ts`（依赖 SqlDriver + SessionStore ref）+ `history-indexer.ts`（依赖 SqlDriver）
3. `search_indexing.ts`（依赖 HistoryIndexer）+ plugin.json manifest 登记
4. `history-search-tool.ts` + `history-get-context-tool.ts`（依赖 SearchEngine + SessionStore）
5. `router.ts` + `handlers/history-search.ts`（依赖 SearchEngine）
6. `bootstrap.ts`（装配 1-5）

**破坏性变更**：无（全是新增 + 少量 manifest/bootstrap 修改）。`MessageSchema` 不动、`CompositeStore` 不动、`store_sink` 行为不动。

**风险点**：
- [PACKAGED-SPIKE] node:sqlite 是否含 FTS5（go/no-go）；UT 跑 dev bun:sqlite 已确定可用，packaged 验证 spike 非编码硬阻断
- `MessageRange` 当前无 `around` 字段（只有 fromId/beforeId）—— `history_get_context` coder 可组合两次调用实现 around 窗口语义（属实现选择，非契约约束）
- onSessionDestroyed 已有 cron 注入链，新增 indexer.deleteBySession 共存（不互斥）

**打包护栏自检（CLAUDE.md 持续可打包）**：
- [GUARD-1 依赖归属] 若 spike 启用 better-sqlite3：进 `app/server/package.json` deps + asarUnpack + Electron 42 ABI rebuild（非根 package.json）
- [GUARD-2 路径展开] search.sqlite 路径 `join(resolveDataDir(), 'search.sqlite')`，禁字面 `~` / 相对路径
- [GUARD-3 runtime-config] 一期无新增必需运行时 env 键（半衰期/批量大小走代码默认）
- [GUARD-VERIFY] packaged 解包 asar → 起真后端 → curl `/history/search?q=...` → 返回非空 hits（dev AT 豁免，packaged 必须人工验一次）

## UT 关键覆盖点（test-plan 锚点，用户裁决 UT-now / AT-later / ET n/a）

- SqlDriver 3 实现 prepare/exec/close 行为一致（用 in-memory :memory: 跑）
- search_engine: sanitize 防注入 / MATCH + bm25 / recency 半衰期重排 / snippet 截取 / 空 query 返空
- history_indexer: index 串行保序 / batch INSERT 原子 / reconcile 扫 last_ulid 之后 / deleteBySession 级联（fts 行也删）/ rebuild 清库重建
- search_indexing handler: role 过滤（tool/system skip）/ text 提取（type=text only）/ 投递 queue / 透传 messages / 异常吞不影响 ingest / scope disable（forked 不调）
- message_id 锚点: handler 投递 id = chunks.message_id = transcript record id
- tools: history_search query/keywords 二选一校验 / formatHits 含锚点 / history_get_context sessionId/messageId required + 空 result 友好提示
- router: GET /history/search 路径分发 / 400 BAD_REQUEST (缺参) / debug=1 打分明细

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- spec↔code 偏差（如 `MessageRange.around` 不存在、scope 配置 API 名漂移）→ coder 按代码实际调整 + 汇报偏离 → orchestrator 记 doc-sync 待办 → doc-modifier 阶段 5 统一修 spec
