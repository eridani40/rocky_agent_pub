# v0.0.136 变更计划书 — history_search 索引异步化（async consumer loop，根治同步 drain 阻塞 event loop）

> method 级 review 合同。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/const 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

---

## 设计方案

### 背景（根因已由 Explore 查清）

`HistoryIndexer._drain()` 在**同一个 event loop tick 里同步排空整个队列**：while 循环 + 同步 `_flushBatch()`（bun:sqlite 同步写 BEGIN/stmt.run×32/COMMIT），**批次间无 await 让出** → 积压时 drain 独占 event loop，整个 server 卡死。spec §3.3/§4 设计意图本就是「不阻塞 ingest、进程内单 worker」——**代码违背了 spec**。本次 = 让单 worker 成真正 async loop，回归 spec 意图，强化兑现 §3.3「index() 不阻塞 ingest」invariant。

### Async consumer loop 结构（伪代码）

```typescript
// 模块级 helper（unref 不阻塞进程退出，与 channel-send-queue.ts L28-31 同模式）
const sleep = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); t.unref?.(); });

const BATCH_SIZE = 32;             // spec §4 invariant 2（保留）
const BATCH_INTERVAL_MS = 1000;    // 批间 sleep（用户原话「处理完就 sleep 1 秒」）
const IDLE_WAIT_MS = 50;           // 队列空时轮询间隔
const MAX_QUEUE_SIZE = 5000;       // 背压上限（防御性，正常用例永不触发）
const FLUSH_POLL_MS = 20;          // flush() 轮询步长
const FLUSH_DEADLINE_MS = 30_000;  // flush() 安全 deadline

class HistoryIndexer {
  private queue: IndexPayload[] = [];
  private loopStarted = false;     // 替代旧 `flushing` 锁（语义不同：loop 是否已启动）

  index(payload: IndexPayload | IndexPayload[]): void {
    const arr = Array.isArray(payload) ? payload : [payload];
    if (arr.length === 0) return;
    // 背压：队列超上限 drop new（store_sink 已先落 jsonl，reconcile 兜底）
    if (this.queue.length + arr.length > MAX_QUEUE_SIZE) {
      console.warn('[history_indexer] queue overflow (%d+%d > %d), dropping new (reconcile will catch up)',
        this.queue.length, arr.length, MAX_QUEUE_SIZE);
      return;
    }
    for (const p of arr) this.queue.push(p);
    // [保留临时验证 log]
    // 启动 loop（首次；flag 守卫 = 重入保护）
    if (!this.loopStarted) {
      this.loopStarted = true;
      void this._consumerLoop().catch(() => { /* 异常吞：reconcile 兜底 */ });
    }
  }

  private async _consumerLoop(): Promise<void> {
    while (true) {                          // 永久循环（进程 lifetime）
      if (this.queue.length === 0) {
        await sleep(IDLE_WAIT_MS);          // idle 轮询（unref timer）
        continue;
      }
      const batch = this.queue.splice(0, BATCH_SIZE);
      try {
        this._flushBatch(batch);            // 保留：同步 BEGIN/run×32/COMMIT + last_ulid
      } catch {
        // 单批失败吞（reconcile 兜底）；继续下一批不堆积死锁
      }
      await sleep(BATCH_INTERVAL_MS);       // 核心：批间 yield + 节流（用户原话）
    }
  }

  async flush(): Promise<void> {            // UT gate
    const deadline = Date.now() + FLUSH_DEADLINE_MS;
    while (this.queue.length > 0 && Date.now() < deadline) {
      await sleep(FLUSH_POLL_MS);
    }
  }
}
```

### 5 个开放点结论

**1. 批次间 yield 粒度**：**每 cycle 处理 1 batch → `await sleep(1000ms)` → 下一 cycle**（用户原话「处理完就 sleep 1 秒」最忠实解读）。Steady state throughput = 32 msg/s。
- 理由：(a) 用户明确口径；(b) 真实 ingest 频率（几条/轮）远低于 32/s，正常用例零积压；(c) 削峰填谷天然限流，防 SQLite 写锁被 indexer 独占；(d) burst 场景（bulk import / 历史回填）积压由下次启动 reconcile 补扫，索引延迟可接受。
- **核心约束（不可破）**：无论 sleep 时长，**每批之间必须有 await 让出 event loop**——这是本次修复的本质。MUST NOT 退回同步 while 排空（这是 bug 根因）。

**2. 队列背压**：**加 `MAX_QUEUE_SIZE = 5000`**，满时 drop new payload + warn log。
- 理由：(a) 防御性兜底（正常用例永不触发：32/s 消费 × 几条/轮 ingest = 队列几乎恒空）；(b) drop new 不 drop old（保 FIFO 序，与 `SendQueue` 同策略，见 channel-send-queue.ts L57）；(c) 被丢的 payload 已在 jsonl（store_sink=4 先于 search_indexing=5），下次启动 reconcile 扫 `id > last_ulid` 自动补；(d) 不做合并（复杂度高、与单 message 粒度不匹配）。

**3. 优雅停机**：**不做 flush-on-shutdown，依赖 reconcile 下次启动补扫。**
- 理由：(a) 队列残留 = 刚 ingest 的消息；store_sink 已先落 jsonl，reconcile 必能补；(b) 加 SIGTERM/beforeExit hook 需处理超时/SIGKILL race，复杂度不值；(c) 现有 bootstrap.ts L954 / L981 已有 `process.on('beforeExit')` 模式可参考，但本次不引入；(d) UX 代价 = 「quit 到下次启动」窗口内消息不可搜索，通常可接受（用户重启 app 即补全）。

**4. Consumer loop 生命周期**：
- **启动**：lazy on first `index()`（`loopStarted` flag 守卫，替代旧 `flushing` 锁）。MUST NOT 在 constructor 启动（UT 可能构造 indexer 不 index，构造即启会泄漏 pending promise 跨 case）。
- **运行**：永久（进程 lifetime）。queue 空 → idle wait 50ms；queue 非空 → 1 batch + 1s sleep。
- **停止**：进程退出即死；所有 `setTimeout` 用 `.unref?.()` 不阻塞进程退出（与 SendQueue L29 同模式）。
- **重入保护**：`loopStarted` flag 一次设置即永久 true，再次 `index()` 只入队不启 loop。**替代 `flushing` 锁的并发保护语义**——单 loop 实例本身就是「单 worker」保证（spec §4 invariant 1）。

**5. reconcile 路径**：**本次范围不含 reconcile。**
- 理由：(a) 用户明确「只改这个 index」；(b) reconcile 在启动期跑一次（bootstrap.ts L908 fire-and-forget），非 ingest 运行时路径，此时 server 未监听请求，阻塞代价远低于运行时；(c) reconcile 同步阻塞是**同源问题**（同步文件 readdirSync + readFileSync + 同步 SQLite 写循环，见 history-indexer.ts L209-228），修法相同（批间 `await sleep(0)` + session 间 yield），但属独立路径。
- **后续 follow-up**：建议下一版本统一异步化 reconcile（同样 async loop 模式）。本次标注为已知问题，不在 v0.0.136 修。

### 文件体量考量（给 coder 的提示）

`history-indexer.ts` 当前 338 行（已超 300 软限）。本次净增约 +20 行（consumer loop +25 / 删 `_drain` -16 / 背压 +5 / 注释 +6）→ 约 358 行。
- 单一职责（HistoryIndexer 类）整体连贯，**不为凑行数硬拆**。
- coder 可酌情：若 review 强制 ≤300，把 `_scanSessionTranscripts` + `reconcile` 提取到 `history-indexer-reconcile.ts`（独立决策，不阻断本版本主体）。

### UT 速度考量（给 coder 的提示）

`BATCH_INTERVAL_MS = 1000ms` 会让多批 UT 慢：70 条 payload = 3 batch × 1s = 3s/test，多 case 累计 >30s 触 CI 上限。
- **推荐**：UT 用 `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(1500)` 跑快进，保持生产代码零 test-hook。
- 备选：export 一个 internal-only `__setBatchIntervalForTest(ms)`（不推荐，污染生产模块）。

---

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| persistence | app/server/src/persistence/history-indexer.ts | `sleep` (module-level helper) | 新增 | `(ms) => new Promise<void>(r => { const t = setTimeout(r, ms); t.unref?.(); })`，供 consumer loop 复用 | MUST `t.unref?.()`（不阻塞进程退出）；MUST NOT 用同步 busy-wait | channel-send-queue.ts L28-31（同模式）；设计方案§4 | +3 |
| persistence | app/server/src/persistence/history-indexer.ts | `BATCH_INTERVAL_MS` | 新增 | `const = 1000`（ms），批间 sleep 时长 | MUST = 1000（用户原话「处理完就 sleep 1 秒」）；MUST NOT 改小绕过节流 | 设计方案§1；spec §3.3 | +1 |
| persistence | app/server/src/persistence/history-indexer.ts | `IDLE_WAIT_MS` | 新增 | `const = 50`（ms），queue 空时 loop 轮询间隔 | MUST > 0；MUST 用 unref sleep | 设计方案§4 | +1 |
| persistence | app/server/src/persistence/history-indexer.ts | `MAX_QUEUE_SIZE` | 新增 | `const = 5000`，背压上限 | MUST drop new 不 drop old（保 FIFO）；MUST log warn 含 queueLen | 设计方案§2；SendQueue L57 | +1 |
| persistence | app/server/src/persistence/history-indexer.ts | `FLUSH_POLL_MS` / `FLUSH_DEADLINE_MS` | 新增 | `20` / `30_000`，flush() 轮询步长与 deadline | MUST deadline 防 UT hang；deadline ≤ 30s | 设计方案§4 | +2 |
| persistence | app/server/src/persistence/history-indexer.ts | `HistoryIndexer.flushing` | 删除 | 旧同步重入锁；由 `loopStarted` 替代 | MUST 完全删除（不留 @deprecated 僵尸） | memory delete-old-code-fully；设计方案§4 | -1 |
| persistence | app/server/src/persistence/history-indexer.ts | `HistoryIndexer.loopStarted` | 新增 | `private boolean = false`，consumer loop 启动标记；首次 `index()` 时置 true 启动 loop，替代 `flushing` 重入保护 | MUST 仅启动一次（flag 守卫）；MUST NOT 在 constructor 启动 loop | 设计方案§4 | +1 |
| persistence | app/server/src/persistence/history-indexer.ts | `HistoryIndexer.index` | 修改 | (1) 入队前加 `MAX_QUEUE_SIZE` 背压检查（满 drop new + warn log + return）；(2) 入队后用 `loopStarted` flag 守卫启动 `_consumerLoop`（首次启动）；(3) 删除 `void this._drain()` 调用；(4) 保留 fire-and-forget 语义 + 临时验证 log | MUST fire-and-forget（不 await loop）；MUST NOT 同步调 `_flushBatch`；MUST NOT 抛错到 ingest handler；MUST 保留 `[history_search] indexer.index` log | spec §3.3（不阻塞 invariant）；§4 invariant 1；设计方案§1+§2 | +12/-4 |
| persistence | app/server/src/persistence/history-indexer.ts | `HistoryIndexer._drain` | 删除 | 旧同步 while-loop 排空（bug 根因）；由 `_consumerLoop` 完全替代 | MUST 完全删除（不留 @deprecated 僵尸）；MUST NOT 残留任何同步排空路径 | memory delete-old-code-fully；设计方案§背景 | -16 |
| persistence | app/server/src/persistence/history-indexer.ts | `HistoryIndexer._consumerLoop` | 新增 | 单 worker async loop：(1) queue 空 → `await sleep(IDLE_WAIT_MS)` 轮询；(2) queue 非空 → `splice(0, BATCH_SIZE)` + `_flushBatch(batch)` + `await sleep(BATCH_INTERVAL_MS)`；(3) 单批失败 try/catch 吞（继续下批）；(4) `while(true)` 永久运行（进程 lifetime） | MUST 单 loop 实例（保 spec §4 invariant 1 单 worker）；MUST 每批后 `await sleep(BATCH_INTERVAL_MS)`（核心修复）；MUST NOT 同步 while 排空；MUST NOT 在 loop 外被调用；MUST NOT 调用 `_flushBatch` 外的同步慢 IO；MUST 所有 setTimeout 走 unref sleep helper | spec §4 invariant 1+2；设计方案§1+§4；memory serial-pipeline-io-needs-timeout-decouple | +25 |
| persistence | app/server/src/persistence/history-indexer.ts | `HistoryIndexer.flush` | 修改 | bounded-poll queue 空：`while queue.length>0 && Date.now()<deadline: await sleep(FLUSH_POLL_MS)`；替代旧「等 flushing=false 再 drain」语义 | MUST 30s deadline 防 UT 永久 hang；MUST NOT 直接调 `_flushBatch`（绕过 loop 破单 worker invariant）；MUST queue 空立即 return（避免 idle test 误 hang） | 设计方案§4；spec §4 invariant 1 | +6/-4 |
| persistence | app/server/src/persistence/history-indexer.ts | `HistoryIndexer._flushBatch` | 修改（注释/调用契约收紧） | 实现保留（BATCH_SIZE 条 chunks + triggers 单事务 BEGIN/stmt.run×N/COMMIT + last_ulid 推进）；**仅强化文档注释**：明确「仅 `_consumerLoop` 调用，禁止其他路径触发（保单 worker invariant 1）」 | MUST NOT 改 BATCH_SIZE=32（spec §4 invariant 2）；MUST NOT 改 BEGIN/COMMIT 单事务；MUST NOT 被本类其他方法调用（仅 `_consumerLoop`；`reconcile` 例外属独立路径）；MUST 保留 ROLLBACK 回滚 + last_ulid 更新 | spec §4 invariant 2+4；设计方案§1 | +3/-0 |
| ingest_handler | app/plugins/builtins/rocky_context/ingest/search_indexing.ts | `SearchIndexingHandler.handle` | 修改（注释） | 代码逻辑零变化；仅更新文件头注释 + 行内注释：明确 indexer 内部已是 async consumer loop（fire-and-forget 更不该 await） | MUST 保持 `idx.index(payloads)` 不 await；MUST NOT 加 await（会阻塞 ingest）；MUST NOT 改 handle 签名/返回 | spec §3.3；设计方案§背景 | +2/-1 |
| persistence_test | app/server/src/persistence/__tests__/history-indexer.test.ts | `'fire-and-forget：index() 不 await 也能触发后台 drain'` case | 修改 | 现 case `await new Promise(r => setTimeout(r, 10))` 等 microtask 10ms → 改 `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(1500)` 让 consumer loop 跑过一次 batch interval；或改 `await indexer.flush()`（语义更清晰） | MUST 用 flush 或 fake timer（10ms 在 async loop 下不够）；MUST NOT 用真 wall clock >1s 等待（CI 慢） | 设计方案「UT 速度考量」 | +5/-2 |
| persistence_test | app/server/src/persistence/__tests__/history-indexer.test.ts | 既存 `'串行保序'/'batch 32'/'异常吞'/'last_ulid'` 等 case | 修改 | (1) 在 `beforeEach` 启 `vi.useFakeTimers()`、`afterEach` restore；(2) `indexer.index(...)` 后用 `await vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS * (Math.ceil(n/32)+1))` 推进足够批次时间；(3) 保留 `await indexer.flush()` 兜底 | MUST 全绿；MUST 总等待时间 <5s（fake timers 跳过 sleep）；MUST NOT 用 real clock 跑 1s/batch | 设计方案「UT 速度考量」；memory vitest-must-run-under-bun | +15/-5 |
| persistence_test | app/server/src/persistence/__tests__/history-indexer.test.ts | 新增 `describe('HistoryIndexer consumer loop async')` | 新增 | 3 case：(1) **批间 yield**：注入慢 driver（`exec` 模拟 50ms 写），`index()` 后 100ms 内 query 主存无阻塞（验证 index 立即返回）；(2) **consumer loop 单 worker**：连调 `index()` 两次入队 70 条，flush 后全部按 FIFO 序落库（验证 loop 消费 + 保序）；(3) **背压 drop new**：mock queue 直接塞 5000 条后调 `index(1条)` → log warn + 该条未入队（验证 MAX_QUEUE_SIZE 保护） | MUST 覆盖 3 个核心新行为；MUST 用 flush 或 fake timer，MUST NOT real clock 敏感断言；case (1) 可用 performance.now() 测 `index()` 同步耗时 <50ms | 设计方案§1+§2+§4；spec §4 invariant 1 | +60 |

---

## 影响面评估

**跨模块**：
- `app/server/src/persistence/history-indexer.ts`（核心改造）
- `app/plugins/builtins/rocky_context/ingest/search_indexing.ts`（仅注释，逻辑零变化）
- `app/server/src/persistence/__tests__/history-indexer.test.ts`（UT 适配 fake timer + 新增 3 case）

**依赖顺序**：底层（const/helper/字段）→ `index` → `_consumerLoop`/删 `_drain` → `flush` → `_flushBatch` 注释 → handler 注释 → UT。

**破坏性变更**：
- `HistoryIndexer.flushing` 字段删除（私有，无外部依赖，grep 仅本文件）。
- `_drain` 方法删除（私有，仅 `index` 调用，无外部依赖）。
- 公共 API（`index` / `flush` / `reconcile` / `deleteBySession` / `stats` / `rebuild`）签名零变化。
- 行为变化：`index()` 后不再立即触发同步 drain；落库延迟 ≥ BATCH_INTERVAL_MS（1s）。**这是预期行为**（spec §3.3 invariant 强化）。

**风险点**：
1. UT 速度：若不用 fake timer，UT 会跑几十秒。**强制要求** coder 用 `vi.useFakeTimers()`。
2.UT 隔离：consumer loop 永久运行，但 timer `.unref()` 不阻塞 vitest 退出；多 case 间旧 loop 空转检查 queue（空）→ sleep，CPU 占用可忽略。
3. spec ↔ code 偏离：spec §4 文字「进程内单 worker（保序，无并发竞争 SQLite 写锁）」+ §3.3「不阻塞 ingest」当前 code 部分违背（`_drain` 同步排空）。本次回归 spec 意图。**doc-modifier 阶段 5 应在 spec §4 加一条显式 invariant**：「consumer loop 批间必须 await 让出 event loop」（避免回归）。

**不变（保留）**：
- §4 invariant 1（单 worker）：consumer loop 单实例保证。
- §4 invariant 2（batch 32 单事务）：`_flushBatch` 实现零变化。
- §4 invariant 3（失败吞 + reconcile 兜底）：`_consumerLoop` catch + drop new + reconcile 补。
- §4 invariant 4（last_ulid 水位）：`_flushBatch` 保留 `_setMeta` 推进。
- §3.3（index 不 await 不阻塞 ingest）：本次**强化兑现**（之前 `_drain` 同步排空是隐性违背）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现 spec ↔ code 偏离（如 reconcile 实际行为与 spec §5 描述不符）→ 汇报 orchestrator，记入 task-board doc-sync 待办，doc-modifier 阶段 5 统一修
