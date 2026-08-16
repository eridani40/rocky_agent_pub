---
type: log
title: Persistence KB 变更记录
updated: 2026-08-15
---

# Persistence KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-08-15 · v0.0.359（model 归属改记实际命中 physical model）

- **`[P1]token_usage_stat.md`**：§4 写入路径流程图第 3 步 + 关键不变量，model 归属从「三级配置侧 fallback」升级为优先级链「success-target-registry 命中（运行时真实命中，最高优先）→ session 显式 → squad.modelDefault → `__unknown__`」；registry miss（进程重启后/旧 session 补记/测试注入）三级 fallback 原样兜底，零回归。registry 本体契约 → `../agent/llm_caller/[P0]success_target_registry.md`（新）。
- 详情：`specs/tech/version_logs/v0.0.359/change_log.md`

## 2026-08-13 · v0.0.345（atomicWriteAsync 新增 + 工具层 fs.promises 真异步）

- **`[P1]file_write_lock.md`**：§5 write/edit 工具改动点伪码从 sync 版（writeFileSync/readFileSync/atomicWriteSync）改 async 版（`await readFile` + `await atomicWriteAsync`，整段仍在 withFileLock 闭包内）；§6.3 callsite 表 fileWriteTool.run / fileEditTool.run 行更新为 `atomicWriteAsync` + 现行号（file-write.ts:93 / file-edit.ts:100）。背景：v0.0.345 撤 worker pool，工具层 fs 操作一律 fs.promises 真异步（老板 13:37 拍板）；persistence 层存量 sync 路径（fs-yield 兜底 + atomicWriteSync 54 处调用方）本版本不动、不迁移。
- 详情：`specs/tech/version_logs/v0.0.345/change_log.md`（撤 worker pool + 五工具 fs.promises + fs-io.ts 新增 atomicWriteAsync + 标准沉淀 + 实现偏差）

## 2026-08-13 · v0.0.302（jsonlPut 热路径 tailCache 零读 append）

- **`[P0]fs_crud_store_engine.md §3.4`**：补「热路径优化（v0.0.302）：模块级 tailCache 零读 append」段——`fs-jsonl.ts` 模块级 `tailCache: Map<dir, {segName, count, maxId}>`（纯进程内存、无持久化）；命中条件（`cache.has(dir)` 且 `id > cached.maxId`）→ 尾段未满纯 append / 满则新开段；冷填充（cache miss 或乱序回填走读文件路径，顺序 append 读一次填缓存）；失效时机（乱序回填/段重写/delete/update 等段结构变化即 `tailCache.delete(dir)`）。
- 详情：`specs/tech/version_logs/v0.0.302/change_plan.md`（v0.0.302 编码期实现，此前 spec 同步缺失，本次补记）。

## 2026-08-05 · v0.0.257（慢查询性能日志埋点 — SlowQuerySink 注册点 + queryWithSlowLog 计时包装）

- **新模块 `persistence/slow-query.ts`**：`SlowQueryInfo`/`SlowQuerySink` 类型 + `setSlowQuerySink` 模块级注册点 + `queryWithSlowLog(engine, schema, filter, fn, nowMs)` 计时包装 + `SLOW_QUERY_MS=200`（严格大于，恰好等于不算慢）。
- **`[P0]crud_store_interface.md §2.5 + §3.8`**：慢查询观测接口（sink 注册点契约）+ 设计决策「底座不反向依赖上层」——persistence 只定义回调接口，bootstrap 组合根注入 `info => logWriter.write('performance', info)`（dev-logs LogWriter 适配），与 setSessionStoreEpDelegate / setTokenUsageSubscriberDeps 同范式；日志落盘/开关门禁归 dev-logs KB。
- **两 engine query 入口埋点**：`fs-store.ts:FsCrudStore.query()` + `sqlite-store.ts:SqliteCrudStore.query()` 经 queryWithSlowLog 包原查询，超阈值上报 `{engine, entity, shardKey, ms, count, filter}`；`nowMs` 时钟构造注入（缺省 Date.now，UT 可控）；sink 未注册零开销短路（仅一次 nowMs 调用），开关 false 由 LogWriter 门禁早 return——主路径异步不阻塞、零磁盘 IO。
- **index.md**：概念表加 SlowQuerySink 行 + 边界加「慢查询埋点注册点」行 + ④ 原则 7「底座不反向依赖上层（sink 注册点模式）」。
- 用途：定位 prod 卡顿真凶（哪个 entity / 什么 filter 慢）；后续优化（迁 sqlite/索引/缓存）另立版本。
- 详情：`specs/tech/version_logs/v0.0.257/change_log.md`

## 2026-08-01 · v0.0.231（PutOptions 加 preserveUpdatedAt — 纯标记写入不刷 updatedAt）

- **`[P0]crud_store_interface.md §2.3`**：`PutOptions` 加 `preserveUpdatedAt?: boolean`（缺省 false，存量调用方零影响）——upsert 更新时保留 `existing.updatedAt`（version 仍 +1，createdAt 照常保留）；仅影响 upsert 更新分支，insert/replace 语义不变。**§3.7 设计决策**：信封 updatedAt 默认推进，preserveUpdatedAt 作显式 escape hatch（store 不感知业务字段语义，「纯标记」由调用方判定）。
- **实现**：`envelope.ts computeEnvelope()` upsert 分支 `updatedAt: opts?.preserveUpdatedAt === true ? existing!.updatedAt : now`——fs-store + sqlite-store 双引擎共用此纯函数，改一处两引擎生效。首个消费方 = session pinned 置顶（`sessionStoreUpdateSession` 对 pinned-only patch 传 flag，详见 session KB log 同日条目）。
- 详情：`specs/tech/version_logs/v0.0.231/change_plan.md` + `change_log.md`

## 2026-07-23 · v0.0.194 收尾修复（用户验收 3 项）

- **hour 粒度补零**：`TokenUsageAggregator.query` granularity=hour 且 from/to 有界 → zeroFillHours 补全范围内每天 0~23 点 24 点位（单日视图固定 24 点位契约；无数据点位全 0）
- **availableModels label 改写**：handler 层用 app_config providers.label 把 `${providerId}/${modelId}` 改写为 `${providerName} / ${modelId}`（含 disabled provider；_deleted 跳过；未命中 fallback）
- **范围/模型下拉无反应修复（前端）**：CustomDropdown outside-close 误判列表项（btnRef→wrapRef），详见 specs/ui/components/studio-page/component-token-stats.md

## 2026-07-23 · v0.0.194.token_stats（SQLite engine 扶正 + squad token 用量时序表）

### T0 SQLite engine 扶正（已 dev verified）
- **实现偏离原架构提案（2 项,doc-sync 阶段 5 同步到 `[P0]sqlite_engine_packaged_promotion.md`）**:
  - **§2.6 shim 精简保留(非整文件删除)**:`bun-sqlite-shim.d.ts` 删 dead `transaction<T>(fn)` 高阶类型,留 ambient `declare module 'bun:sqlite'` + 最小 `Database`/`Statement`/`DatabaseInstance` 声明 —— search-sql-driver.ts 的 `await import('bun:sqlite')` 在 dev typecheck 需 ambient module 声明;`declare module` 在已 module 的 .ts 文件被 TS 当 augmentation 报错,故 ambient .d.ts 必须保留。删则 TS2307 `Cannot find module 'bun:sqlite'`
  - **§3.4 install 期不加 skip-native 脚本覆盖**:better-sqlite3 v11.10 用 `prebuild-install`(macOS arm64 clean install 4.89s 零编译),不像 computer-native install 期裸 node-gyp;packaged Electron ABI 由 build-dmg.sh ②c 显式 `@electron/rebuild -f -w better-sqlite3` 处理(非 install 期)。memory `native-addon-workspace-skip-install-nodegyp` 针对的场景 better-sqlite3 v11 已规避
- **核心方案(6 决策)**:①复用 search-sql-driver.ts 的 SqlDriver 抽象(BunSqlDriver/NodeSqlDriver/BetterSqlite3Driver + createSqlDriver 工厂);②SqlStatement 契约扩展加 `get()`;③transaction 走手动 BEGIN/COMMIT/ROLLBACK(跨 driver 共识);④stmtCache 保留 sqlite-store 层;⑤SqliteCrudStore 构造注入 SqlDriver + 新增 `createCrudSqlDriver(path)` 双产物 `{store, driver}`;⑥shim 精简保留(非删)。
- **packaged 接入**:better-sqlite3 `^11.10.0` 进 `@app/server/package.json` deps(BUG-002);electron-builder.yml `asarUnpack: ['**/*.node']` 已覆盖;`files` 加 `node_modules/better-sqlite3/**/*`;`npmRebuild: false`;build-dmg.sh ②c `@electron/rebuild`;runtime-config 不需注入(路径走 `join(resolveDataDir(), 'crud.sqlite')` 绝对路径)。
- **packaged 验证 MANDATORY**(合并前一次性 build dmg 门禁):dev UT 全绿 + 解 asar 起后端 curl GET /squad/:id/token-stats 200 + curl history-search 不 regress + clean install 不崩。**回退预案**:better-sqlite3 ABI 失败 → 降级 NodeSqlDriver → 终极 FsCrudStore(schema.engine='file',业务零改动)。

### T1 token_usage_stat 细粒度时序表（已 dev verified）
- **实现偏离原架构提案（3 项,doc-sync 阶段 5 同步到 `[P1]token_usage_stat.md`）**:
  - **§4 subscriber 投递机制 = direct call(非 bus 订阅)**:`session-store-usage-impl.ts:147` 在 notifyUsageChanged 内 `notifyTokenUsageSubscriber(...).catch(()=>{})` fire-and-forget,不订阅 `session_panel` topic —— 避免 change_plan row3+row4 bus 订阅 + direct call 同用 double-count;direct call 更简洁(无 bus 生命周期 + 无订阅时序竞态)。spec §4 的「subscribe to bus」是概念数据流描述,direct call 是等价投递机制
  - **§4 写入走 sync CrudStore.put(非 putAsync)**:sqlite engine 同步语义,`CompositeStore.putAsync` 对 sqlite engine 退化为 `Promise.resolve(sync put)`(SqliteCrudStore 无 putAsync 方法);sqlite ACID 由事务 + WAL 保证,不需应用层串行化(fs_crud_store_engine §5.3 的 putAsync 串行化是 FS engine 专属)
  - **§5 aggregator SQL 所有业务字段走 `json_extract(data,'$.field')`**:SqliteCrudStore 是 blob-first(整 record 序列化为 data JSON blob 列,信封字段 id/createdAt/updatedAt/version 另列),bare column 引用必失败;bucket 表达式 = `substr(json_extract(data,'$.hour'),1,10)`(day) / `json_extract(data,'$.hour')`(hour),SUM 字段全 `SUM(json_extract(data,'$.X'))`,WHERE 全 `json_extract(data,'$.X') = ?`
- **distinct model 列表（§5 补全,T2 review 阶段 orchestrator 裁决补全）**:`queryDistinctModels(squadId, range?)` raw SQL `SELECT DISTINCT IFNULL(json_extract(data,'$.providerId'),'__unknown__'), IFNULL(json_extract(data,'$.modelId'),'__unknown__') WHERE squadId [AND hour range] ORDER BY`;合并进 `TokenUsageQueryResult.availableModels?` optional;从 token_usage_stat 数据派生(非 squad.modelDefault 配置);前端 controls 下拉数据源
- **SchemaDef 7 决策**:①engine='sqlite'(扶正前置);②粒度=(sessionId,hour,providerId,modelId) 细粒度累加(解决 v2 hour 数据源问题);③字段对齐 Usage 细分 snake_case;④冗余存 squadId/memberId(免 join session);⑤id (sessionId,hour,providerId,modelId) 唯一约定(query-then-put 复用);⑥读写分离(sync put + raw SQL GROUP BY);⑦SQLite 不分片。
- **session→member 映射**(subscriber 前提):`SessionSchema.squadId/memberId`(session.ts:161/167)+ `MemberSchema.sessionId`(member.ts:55)全在;subagent session 无 memberId → subscriber 跳过(usage 已通过 accumulateUsage 递归 'sub' 上报 parent)。
- **migration 不做**(用户核实无精确数据源):run.usage 实际没落(调用没传 runUsage);usage 流式 emit 但 message/transcript 不持久化;session.usage 只有累计总量无 per-call 时间分布 → token_usage_stat 从空表开始,subscriber 从上线后统计新数据(首见记 0)。
- **index.md 导航**:补 sqlite_engine_packaged(P0) + token_usage_stat(P1) 两行。

详情:`specs/tech/version_logs/v0.0.194/change_plan.md`(含 SQLite 扶正代价评估段 + packaged 验证范围 + 回退预案)


## 2026-07-14 · v0.0.136.index-async（history_search 索引异步化 + reconcile 文件拆分）

- **`[P1]search_engine.md §4` HistoryIndexer async consumer loop**：同步 `_drain()` 排空整队列（阻塞 event loop）→ async `_consumerLoop()`（1 batch/cycle + `await sleep(BATCH_INTERVAL_MS=1000)` 批间让出 + `IDLE_WAIT_MS=50` 空队列轮询 + `MAX_QUEUE_SIZE=5000` 背压 drop new + `loopStarted` lazy 启动单 worker 守卫）。根治积压时 server 卡死。
- **§4 新增防回归 invariant**：「consumer loop 批间 MUST `await` 让出 event loop，MUST NOT 退回同步 while 排空」——旧 `_drain` 同步排空是隐性违背 spec 意图，本次代码回归 + spec 显式化。
- **§4 接口补 `flush()`**：bounded poll 等 queue 空（UT/维护用），MUST NOT 直接调 `_flushBatch`（破单 worker）。
- **§4 修 spec↔code drift**（原则 13）：(1) 原「batch INSERT chunks + INSERT fts」→ 实际仅 INSERT chunks，fts 由 `chunks_ai` trigger 自动同步；(2) 原「失败重试 3 次指数退避」→ 实际 try/catch 吞 + reconcile 兜底（无重试）。
- **reconcile 文件拆分**：`reconcile()` + `scanSessionTranscripts()` 提取到 `history-indexer-reconcile.ts`（`reconcileTranscripts()` 函数 + 依赖注入 dataRoot/lastUlid/flushBatch 回调），`HistoryIndexer.reconcile()` 成 thin wrapper。公共 API 零变化。reconcile 本身仍同步阻塞（同源问题，未走 async loop，启动期跑一次）。
- **§3.3 强化**：补「indexer 内部 async consumer loop，`index()` 仅入队 O(1) 即返回」。
- **§5 修 drift**：reconcile「session 维度并行」→ 实际顺序遍历（同步循环）。
- UT：history-indexer.test.ts 23/23 绿（含新增 3 case：批间 yield / consumer loop 单 worker 保序 / 背压 drop new）；persistence 全模块 207/207 绿。AT 冒烟回归全绿。

详情：`specs/tech/version_logs/v0.0.136/change_log.md`

## 2026-07-12 · v0.0.126.history_search（SearchEngine + HistoryIndexer + SqlDriver 抽象落地）

- **`[P1]search_engine.md` P1 占位转正式**：一期 = 派生索引（ingest handler `search_indexing` 旁路）+ SQLite FTS5 单表 trigram BM25 + recency 后置重排；二期（RAG：sqlite-vec + embedding + RRF）预留接口不实现。
- **新增 5 源文件**：`search-engine.ts`（SearchEngine 主类 + sanitize/trigram/recency）+ `search-sql-driver.ts`（SqlDriver 抽象 + BunSqlDriver/NodeSqlDriver/BetterSqlite3Driver 三实现 + createSqlDriver 工厂）+ `history-indexer.ts`（写入队列 + reconcile/rebuild/deleteBySession 兜底 + ensureHistorySchema）+ `search-text-util.ts`（extractPlainText 共享实现）+ `search-indexer-ep-delegate.ts`（server 侧 holder，plugin → server 注入 indexer，与 session-store-ep-delegate 同模式）。
- **§3.1 SqlDriver 契约**：`SqlStatement` 无 `bind()` 方法，`all(...params)`/`run(...params)` 直接参数化（对齐 bun:sqlite / node:sqlite / better-sqlite3 共同 API 子集 + sqlite-store.ts 既有模式）。`prepare<T>(sql)` 泛型入口 + `all<U>(...)` 方法级泛型覆盖。
- **§3.5 SearchEngine.search 双参签名**：`search(query: string, opts: SearchOptions)`（非单参数对象）；SearchOptions 字段 `currentSession`/`topK`/`after`/`before`（camelCase；非 spec 早期草稿的 `scope.excludeSessions`/`top_k`/`timeRange`）。构造签名 `(driver, titleResolver: SessionTitleResolver)`（非 `(driver, sessionStore)`）；titleResolver 是最小回调 `(sid)=>string|null`，一期默认返 null（title 解析留二期）。search 同步返回（SqlDriver.all 同步）。
- **§3.6 Schema 耦合（已知设计债）**：`SearchEngine.ensureSchema()` 建 chunks+fts+idx_meta（**不含 triggers**）；`ensureHistorySchema(driver)` 建 triggers（AFTER INSERT/DELETE/UPDATE on chunks → 自动同步 fts）；4 表 ×2 重复 DDL——生产路径靠 bootstrap 顺序（SearchEngine 先，HistoryIndexer 后）+ 双方 IF NOT EXISTS 幂等双保险。未来可合并 `ensureSearchSchema` 单函数（一期不做）。
- **§3.7 indexer delegate holder**：search_indexing handler 按需 new 无缓存，bootstrap 用 `setSearchIndexerEpDelegate(idx)` holder 注入 indexer（server → server），handler `getSearchIndexerEpDelegate()` 取；兼容 `setIndexer`（UT 显式注入）+ holder（生产路径）两路径。
- **§3.5 recency 半衰期**：30 天代码默认；从 messageId ULID 解码时间戳（decodeUlidTime，前 10 字符 Crockford base32 → ms），非 ULID 视为最新（decay=1 不打折）。
- UT：search-engine.test.ts / search-sql-driver.test.ts / history-indexer.test.ts（覆盖 sanitize/trigram/bm25/recency/batch insert/reconcile/deleteBySession）。一期 AT 豁免（用户裁决 UT-now / AT-later）。

详情：`specs/tech/version_logs/v0.0.126/change_log.md`

## 2026-07-01 · v0.0.38

- 新增 KB `[P1]file_write_lock.md`：进程内文件写加锁设计。锁原语 `app/server/src/persistence/file-lock.ts`（按 normalize 后绝对路径 key 的 async mutex，无第三方依赖；两模式 `withFileLock` 同步等待 + `enqueueFileWrite` fire-and-forget；**非重入**（spec §3.3：全部 callsite 核查无同 path 嵌套，YAGNI 不引 AsyncLocalStorage/depth）；`getLockSize()` test-only 验 entry GC）。
- FsCrudStore 增 engine 专有 async 扩展 `putAsync`/`deleteAsync`（**不动 CrudStore 同步契约 / 不动 SqliteCrudStore**）；targetPath：json 锁单文件、jsonl 锁段目录。CompositeStore 增同名 forwarder（engine 有则委托、无则 `Promise.resolve(sync put)`）。
- write/file-edit 工具：`writeFileSync` → `atomicWriteSync`（补崩溃原子）+ `withFileLock` 包装；edit 的 occurrences 判定移入锁内重判。
- board 子 store（goal/requirement/task-store）+ idGen counters.json：直写 fs-io 的路径用 `withFileLock` 包 `atomicWriteSync`。
- callsite 迁移归类：sync-wait（结果依赖：HTTP create/update、状态机、append message/run、工具）vs fire-and-forget（best-effort 副作用：SessionUnreadOps 用 `void crud.putAsync().catch()`）。
- `[P0]fs_crud_store_engine.md §5.3` 进程内并发从「建议」改为「已实现（v0.0.38）」并指向新 KB。
- 范围：仅文件写加锁；watcher / 目录预建 / 可观测 metric / 多进程共享明确 out of scope。

详情：`specs/tech/version_logs/v0.0.38/change_log.md`

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`；`[P0]overview.md` 内容按类拆流并入 index 后归档到 `soft_deleted/`。
- 全部 5 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理 `> version:` blockquote + 尾部 `## 版本` 段，迁移到 frontmatter `since` 或本 log。
- 修正 spec 过时：`overview §7`（现 index ③）+ `schema_defs/index.ts` 注重的 `transcript.ts` 早已 task-7 删除、业务 schema 迁 `agent/schema_defs/`（仅 `model_config.ts` 仍是实验 fixture）。

## 2026-06-19 · v0.0.2（persistence P0 落地）

- 新增 5 份 P0 spec：`schema_interface` / `crud_store_interface` / `fs_crud_store_engine` / `sqlite_crud_store_engine` / `overview`；`[P1]search_engine` 占位。
- 实现 SchemaDef 声明层 + CrudStore 契约层 + CompositeStore 按 entity 寻址 + FS engine（含分片/jsonl 段文件/原子写）+ SQLite engine（bun:sqlite、blob-first）。
- 决策：通用 entity store（非实体专用）；SchemaDef 唯一源头 + `InferRecord<S>` 派生；`id` 保留主键名 + 业务生成；统一信封（createdAt/updatedAt/version 乐观锁）；engine 是 SchemaDef 字段；SQLite 用 `bun:sqlite` 不引 ORM（详 `overview §5.1` 不引 Prisma 决策）。
- `schema_defs/` 实验 fixture：`transcript.ts`（file + sessionId 分片 + jsonl）+ `model_config.ts`（fs vs sqlite 双 engine 验证）。
- v0.0.2 doc 同步：`VersionConflictError/RecordExists/RecordNotFound` 补 id 字段；新增 `EntityNotMountedError`；`collection→entity` 措辞统一；FS root/dirTemplate 拼接规则明确化；§3.4 jsonl 乱序回填/删首行段名更新。

详情：`specs/tech/version_logs/v0.0.2/change_log.md`

## 2026-06-XX · v0.0.8（业务 schema 迁出）

- `persistence/schema_defs/transcript.ts`（v0.0.2 实验夹具）由 task-7 删除，业务 transcript schema 由 `agent/schema_defs/message.ts` 接管（业务模块目录）。
- v0.0.8 业务 schema（session/message/summary/run）定义在 `agent/schema_defs/`，`persistence/schema_defs/index.ts` 仅作便捷 re-export。

详情：`specs/tech/version_logs/v0.0.8/change_log.md`
