# v0.0.136 · history_search 索引异步化（async consumer loop）

> 跨版本发布说明（版本轴）。位置轴变更见各 KB 的 `log.md`：
> - `specs/tech/persistence/log.md`（HistoryIndexer async consumer loop + reconcile 拆分）

## 概要

history_search 索引从**同步 `_drain()` 排空整队列**（阻塞 event loop）改为 **async `_consumerLoop()`**（1 batch/cycle + `await sleep(BATCH_INTERVAL_MS=1000)` 批间让出 + `MAX_QUEUE_SIZE=5000` 背压）。根治积压时整个 server 卡死。

spec §3.3/§4 设计意图本就是「不阻塞 ingest、进程内单 worker」——旧 `_drain` 同步排空是隐性违背 spec。本次代码回归 spec 意图 + spec §4 显式加防回归 invariant（批间 MUST await 让出）。

## change_plan 偏离（code-review 阶段）

| 项 | change_plan 原计划 | 实际实现 | 理由 |
|---|---|---|---|
| reconcile 文件归属 | `history-indexer.ts` 内（change_plan「文件体量考量」标「非阻断，coder 可酌情拆」） | reviewer 拆到独立文件 `history-indexer-reconcile.ts`（`reconcileTranscripts()` 函数 + 依赖注入 dataRoot/lastUlid/flushBatch 回调；`HistoryIndexer.reconcile()` 成 thin wrapper） | change_plan「文件体量考量」授权的第 4 个文件；history-indexer.ts 从 388 行降回 298 行（≤300 软限），职责更清晰（运行时 consumer loop vs 启动期 reconcile 解耦）。**公共 API（reconcile）签名零变化** |

## 不变（保留）

- §4 invariant 1（单 worker）：consumer loop 单实例（`loopStarted` flag 守卫，lazy 启动于首次 `index()`）
- §4 invariant 2（batch 32 单事务）：`_flushBatch` 实现零变化（BEGIN / INSERT INTO chunks ×32 / COMMIT + last_ulid 推进）
- §4 invariant 3（失败吞 + reconcile 兜底）：`_consumerLoop` try/catch + drop new + reconcile 补
- §4 invariant 4（last_ulid 水位）：`_flushBatch` 保留 `_setMeta(META_LAST_ULID, maxTs)` 推进
- §3.3（index 不 await 不阻塞 ingest）：本次**强化兑现**
- HistoryIndexer 公共 API（index / flush / reconcile / deleteBySession / stats / rebuild）签名零变化
- SearchEngine / SqlDriver / search.sqlite schema：零改动（纯写入路径内部重构）

## spec↔code drift 修（doc-modifier 阶段 5，原则 13）

| 项 | spec 原文 | 代码实际 | spec 修正位置 |
|---|---|---|---|
| §4 batch INSERT 描述 | `INSERT INTO chunks(...) ; INSERT INTO fts(rowid, text) VALUES(last_rowid, ?)`（手动插 fts） | 仅 `INSERT INTO chunks`；fts 由 `chunks_ai` trigger 自动同步（external-content 模式） | `[P1]search_engine.md §4` |
| §4 失败处理 | 「失败重试 3 次（指数退避），最终吞异常」 | try/catch 吞（无重试）+ reconcile 兜底 | `[P1]search_engine.md §4` |
| §4 接口缺 flush | 无 `flush()` | `flush(): Promise<void>`（bounded poll，UT 用） | `[P1]search_engine.md §4` |
| §5 reconcile 并行 | 「session 维度并行（每 session 一 transcript 目录，天然分片）」 | 顺序同步遍历（for...of sessionIds） | `[P1]search_engine.md §5` |
| §3.6 行号 | `history-indexer.ts:41` | `history-indexer.ts:57`（reconcile 拆出 + 新增常量块上移） | `[P1]search_engine.md §3.6` |

## 已知问题（本次未修，同源后续）

**reconcile 同步阻塞**：`reconcileTranscripts()` 仍用 `readdirSync` / `readFileSync` / 同步 SQLite 写循环（同 `_drain` 旧 bug 根因）。启动期 fire-and-forget 跑一次（bootstrap），此时 server 未监听请求，阻塞代价低于运行时——本次范围不含。建议下一版本统一异步化（同样 async loop 模式 + 批间 yield）。

## 验证范围

- **UT**：history-indexer.test.ts（23/23 绿，含新增 3 case：批间 yield / consumer loop 单 worker 保序 / 背压 drop new）；persistence 全模块 207/207 绿
- **AT**：冒烟集回归全绿（read 路径契约零变化）
- **ET**：无（纯后端内部重构，无 UI 改动）
