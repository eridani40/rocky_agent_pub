# v0.0.138 变更计划书 — 后端日志/langfuse 有界队列化（500MB drop-new）+ api.log 加 RT

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

### 背景（根因已查清，见 context.md）

squad leader 会话慢的根因**在后端日志 I/O，非前端**：(1) `log-writer.ts:70` 每条 `void appendFile({flag:'a'})` 逐行异步追加（无批、无界、每条 = open/write/close syscall + 同步 `JSON.stringify`）；(2) `router.ts:286-288` HTTP 中间件**每请求落盘完整 responseBody**（squad leader 巨型状态同步消息）；(3) langfuse SDK 攒 2.6MB batch。三者叠加 → 后端疯狂序列化+写盘 → API 慢 → 前端等数据。**前端对话内容已无缓存**（context.md Explore 11:10），本版本前端零改。

### 改造#1 LogWriter → 生产者消费者 + 500MB 有界 buffer + 超限丢新

```typescript
// 新文件 app/server/src/dev-logs/log-queue.ts
const MAX_BUFFER_BYTES = 500 * 1024 * 1024;  // 500MB（用户硬上限）
const BATCH_MAX_COUNT  = 64;                 // 每批最多 64 条
const BATCH_MAX_BYTES  = 1 * 1024 * 1024;    // 或 1MB（先到先止）
const BATCH_INTERVAL_MS = 250;               // 批间 sleep（4Hz 消费）
const IDLE_WAIT_MS      = 50;                // queue 空 → 50ms 轮询
const WARN_THROTTLE_MS  = 10_000;            // drop warn 节流窗口

const sleep = (ms: number) => new Promise<void>(r => { const t = setTimeout(r, ms); t.unref?.(); });

interface LogEntry { type: LogType; line: string; size: number; }  // line 是 stringify 后的（含 ts）

export class LogQueue {
  private q: LogEntry[] = [];
  private bufferedBytes = 0;
  private loopStarted = false;
  private lastDropWarn = 0;
  private droppedSinceWarn = 0;

  constructor(private readonly dataDir: string) {}

  /** 生产者：入队一条已 stringify 的日志行。超 500MB → drop new + 节流 warn。 */
  enqueue(type: LogType, line: string): void {
    const size = Buffer.byteLength(line, 'utf8') + 1;  // +1 for '\n'
    if (this.bufferedBytes + size > MAX_BUFFER_BYTES) {
      this.droppedSinceWarn++;
      const now = Date.now();
      if (now - this.lastDropWarn > WARN_THROTTLE_MS) {
        console.warn('[log-writer] buffer overflow (%d bytes), dropped %d entries in last %dms (drop-new FIFO-old)',
          this.bufferedBytes, this.droppedSinceWarn, now - this.lastDropWarn);
        this.lastDropWarn = now; this.droppedSinceWarn = 0;
      }
      return;  // drop new（保 FIFO 老）
    }
    this.q.push({ type, line, size });
    this.bufferedBytes += size;
    if (!this.loopStarted) {
      this.loopStarted = true;
      void this._consumerLoop().catch(() => { /* 静默：dev 日志是旁观者 */ });
    }
  }

  private async _consumerLoop(): Promise<void> {
    while (true) {
      if (this.q.length === 0) { await sleep(IDLE_WAIT_MS); continue; }
      // 按 type 分桶，每 type 一批（≤ BATCH_MAX_COUNT 且 ≤ BATCH_MAX_BYTES）
      const buckets = new Map<LogType, { lines: string[]; bytes: number }>();
      let taken = 0;
      while (this.q.length > 0 && taken < BATCH_MAX_COUNT) {
        const e = this.q[0];
        const b = buckets.get(e.type) ?? { lines: [], bytes: 0 };
        if (b.bytes + e.size > BATCH_MAX_BYTES && b.lines.length > 0) break;
        b.lines.push(e.line); b.bytes += e.size; buckets.set(e.type, b);
        this.q.shift(); this.bufferedBytes -= e.size; taken++;
      }
      // 每 type 单次 appendFile（flag:'a' 追加，失败静默）
      for (const [type, b] of buckets) {
        try {
          await appendFile(join(this.dataDir, 'logs', `${type}.log`), b.lines.join('\n') + '\n', { flag: 'a' });
        } catch { /* spec §2.3 失败静默 */ }
      }
      await sleep(BATCH_INTERVAL_MS);  // 核心：批间 yield 让出 event loop（memory async-marked-fn-sync-io-blocks-eventloop）
    }
  }

  /** （仅 UT 用）等队列消费到空或 deadline。生产 shutdown 不调（dev 日志可丢）。 */
  async flush(deadlineMs = 5_000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (this.q.length > 0 && Date.now() < deadline) await sleep(20);
  }
}
```

**`LogWriter.write()` 改造**（仍同步返 void，**fire-and-forget**）：保留零开销门禁（开关 false 早 return，不构造 record）；开关 true 时**补 ts + JSON.stringify（在 write 内同步做）→ `queue.enqueue(type, line)`**。

> 关键决策：**stringify 留在生产者侧**（不在消费者）。原因：(1) `queue.enqueue` 只算 `Buffer.byteLength`（O(n) 一次扫描，比 stringify 便宜得多），生产者成本低；(2) 入队后 record 即可被 GC（不留引用、不等多批聚合），内存峰值低；(3) 消费者只做 `appendFile`（最纯 IO），批聚合零序列化成本。**与原 task 描述的「stringify 挪到消费者」不同 —— architect 经评估后修订为生产者 stringify + 消费者纯 IO**（理由见上；如有偏好反向请 architect 再议）。

### 改造#2 LangfuseAdapter → 生产者消费者 + 500MB 有界 buffer + 超限丢新

```typescript
// 新文件 app/server/src/observability/langfuse-event-queue.ts
//
// 关键模型：langfuse 是「start 返 handle + end update」语义。
// 方案 B（全队列）：start* 入队「create op」，end*/setLevel 入队「update op」，
// handle.id 在 start* 同步生成（caller 立即可用），consumer FIFO 处理时
// parent op 必先于 child op 处理（保 resolveParent 命中）。

type Op =
  | { kind: 'create-trace'; id: string; args: Record<string, unknown> }
  | { kind: 'create-span'; id: string; parentId: string; args: Record<string, unknown> }
  | { kind: 'create-gen'; id: string; parentId: string; args: Record<string, unknown>; genKind: 'logical'|'physical' }
  | { kind: 'update'; id: string; args: Record<string, unknown> };

export class LangfuseEventQueue {
  private q: Op[] = [];
  private bufferedBytes = 0;
  private loopStarted = false;
  private lastDropWarn = 0;
  // SDK obs 查找表（consumer 维护；create op 处理时填）
  private traces = new Map<string, LangfuseTrace>();
  private obs = new Map<string, LangfuseTrace | LangfuseObservation>();

  constructor(private readonly client: Langfuse) {}

  enqueue(op: Op): void {
    const size = this._estimateSize(op);
    if (this.bufferedBytes + size > MAX_BUFFER_BYTES) {
      // drop new + 节流 warn（同 LogQueue 模式）
      ...
      return;
    }
    this.q.push(op); this.bufferedBytes += size;
    if (!this.loopStarted) { this.loopStarted = true; void this._consumerLoop().catch(...); }
  }

  private async _consumerLoop(): Promise<void> {
    while (true) {
      if (this.q.length === 0) { await sleep(IDLE_WAIT_MS); continue; }
      const batch = this.q.splice(0, BATCH_MAX_COUNT);
      this.bufferedBytes -= batch.reduce((s, op) => s + this._estimateSize(op), 0);
      for (const op of batch) {
        try { this._apply(op); } catch (e) { /* 核心红线：静默 */ }
      }
      await sleep(BATCH_INTERVAL_MS);
    }
  }

  private _apply(op: Op): void {
    // create-trace → client.trace(args) + obs.set(id, t) + traces.set(id, t)
    // create-span → resolveParent(parentId).span(args) + obs.set(id, span)
    // create-gen  → resolveParent(parentId).generation(args) + obs.set(id, g)
    // update      → obs.get(id)?.update(args)
    // resolveParent 找不到 → throw（被 _apply try/catch 吞；等价现状「parent 未找到」）
  }

  /** shutdown 前先 drain（保 SDK shutdownAsync 不丢未处理事件），再 client.shutdownAsync()。 */
  async drainAndShutdown(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (this.q.length > 0 && Date.now() < deadline) await sleep(20);
    try { await this.client.shutdownAsync(); } catch { /* 静默 */ }
  }
}
```

**LangfuseAdapter 改造**：所有 `startXxx/endXxx/setLevel` 主体改为 `this.queue.enqueue(op)` + 同步生成 handle 返回；`resolveParent/warn/client/traces/obs/genKind` 移入 `LangfuseEventQueue`；`shutdown()` 改为 `await this.queue.drainAndShutdown()`。`LangfuseAdapter` 本身瘦身到 ~200 行（API 表面 + handle 生成 + op 构造），文件 < 300 行回归合规。

### 5 个结论

| 开放点 | 结论 | 理由 |
|--------|------|------|
| **1. 单队列 vs 多队列** | **单队列**（log-writer 一条共享队列；langfuse 一条共享队列） | 简化 + 单消费者 = 总量 500MB 上限语义清晰；按 type 分桶仅发生在批聚合时（log-writer consumer 内）。多队列 = 每队列独立 500MB 上限？用户说「总量」 → 单队列。 |
| **2. buffer 计量** | **byte 计量**（`Buffer.byteLength`，非条数） | 用户原话「500MB 上限」=字节语义；条数因单条 size 跨度大（200B~2MB）失真。`enqueue` 时加、consumer 写出/apply 后减。 |
| **3. drop 策略** | **drop new**（保 FIFO 老）+ 节流 warn（10s 窗口聚合 N 条计数） | 同 v0.0.136 / SendQueue 既有策略；dev 日志/observability 都是旁观者，丢新不影响业务正确性；老条目对排障价值高。 |
| **4. 优雅停机** | **log-writer 不 flush**（dev 日志可丢）；**langfuse 必须 drain**（核心红线：`shutdown()` 已 await flush，本次保语义） | dev 日志 = 用户排障用，丢一秒可接受；langfuse 是跨进程聚合，shutdown 前 drain 是既有契约（adapter.ts §shutdown）。 |
| **5. 批间 yield** | **每 batch 后 `await sleep(BATCH_INTERVAL_MS=250)` + idle `await sleep(IDLE_WAIT_MS=50)`**；所有 setTimeout `.unref?.()` | memory `async-marked-fn-sync-io-blocks-eventloop`：async 标记不等于真异步，必须有真 await 让出 event loop；与 v0.0.136 consumer loop 同模式。MUST NOT 退回同步 while 排空（这是 bug 根因）。 |

### 改造#3 router HTTP 中间件加 RT（durationMs）

`handleRequest`（router.ts:250）：dispatch 前 `const start = Date.now()`，write 时 record 加 `durationMs: Date.now() - start`。**2 行级改动，零行为变化**（log 字段加一个）。

### 改造#4 前端（探查结论：默认不改）

context.md Explore 11:10 已确认：**会话对话内容已无缓存**（useLifecycle deps effect + StudioChatRouter key={sessionId} remount → 每次打开 session 无条件重 GET messages/run/usage/model；HTTP 层裸 fetch 无 query-cache 库）。**用户「session 每次打开重新获取」对对话内容已满足，本版本前端零改**。

可选 follow-up（**默认不做，待用户明示**）：A=openSession 加 listSessions（`app/web/src/components/chat-page/page-chat.tsx:126-139`）/ B=去 subagent `fetchedRef` 去重（`use-subagent-children.ts:33` + `use-page-chat-mount.ts:67-72`）/ C=onOpenChat bump detailCache（`section-studio-sidebar.tsx:101`）。代价 = sidebar 闪烁，非性能元凶。

### 改造#5 日志文件轮转（size-based rotation，per-type，max 10，FIFO）— 用户追加

**动机**：v0.0.138 改造#1 给了**内存** buffer 500MB 上限，但**磁盘**文件仍无界增长（现状 api.log 180M/llm.log 1G）。补磁盘轮转：每文件 ≤50MB，每类型最多 10 文件 = **每类型磁盘 ≤500MB**（6 类型 ≤3GB），FIFO 删最老。

**规格（用户确认）**：
- **按类型**：每个 log type（llm/tool/api/event/error/agent）独立轮转。
- **触发**：consumer 每次写（每批 appendFile 前）检查当前活跃文件 size ≥ `ROTATION_MAX_FILE_BYTES=50MB` → 轮转。
- **命名（Option A）**：活跃文件恒为 `<type>.log`（保 `tail -f` 约定）；轮转时 rename `<type>.log` → `<type>-<YYYYMMDD-HHMMSS>.log`（创建时间，filename-safe），新建空 `<type>.log`。
- **FIFO 上限**：轮转后统计该类型 `<type>-*.log` 文件数；≥ `ROTATION_MAX_FILES=10` → 按 timestamp 删最老直到剩 9，再建新活跃（→10）。
- **size 跟踪**：consumer 内 `fileSizeByType: Map<LogType, number>`（单线程 consumer，无并发）；首次写某 type 前 `stat` 既有 `<type>.log` 初始化（接续旧文件 size）。
- **隔离**：**不做线程/进程隔离**——async consumer 的 appendFile/stat/rename/delete 全 async（await 让出 event loop，后台线程池），响应路径零 IO；dev 日志 fail-silent 旁观者，worker/子进程 IPC 复杂度不值。500MB 内存 buffer + 轮转已封顶。

**实现位置**：`log-queue.ts` 的 `_consumerLoop`（每 type 单次 appendFile 前，插 rotation 检查）。新增 const `ROTATION_MAX_FILE_BYTES`/`ROTATION_MAX_FILES` + helper `_rotateIfNeeded(type, addBytes)`（stat-init + ≥50MB rename + FIFO delete）。**只影响 dev-logs（langfuse 走 HTTP 不落本地，不轮转）**。

### 文件体量（给 coder 的提示）

- `log-writer.ts` 现 102 行，改造后净 +0~-10（write 简化：删 `appendFile`/`join` import + 直接 enqueue）→ 约 90 行。**新文件 `log-queue.ts` ~110 行**。两者均 < 300。
- `langfuse-adapter.ts` 现 315 行（**已超 300**），改造后 `client/traces/obs/genKind/resolveParent/warn` 移出 → 约 200 行（API 表面）。**新文件 `langfuse-event-queue.ts` ~160 行**（含 `_apply` switch + 5 个 op 类型）。两者均 < 300。
- `router.ts` 651 行：仅 +2（不改体量；该文件历史超限，本版本不拆，单独 follow-up）。

### UT 速度（给 coder 的提示）

`BATCH_INTERVAL_MS = 250ms` 让多批 UT 慢。**推荐**：UT 用 `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync(BATCH_INTERVAL_MS * (batchCount + 1))`，或调 `queue.flush()` 等真消费完。MUST NOT 用 real wall clock >1s/批。

---

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| dev_logs | app/server/src/dev-logs/log-queue.ts | 文件本身 | 新增 | 新建模块：有界 LogQueue 类（500MB byte 计量 + drop new + 单 consumer async loop + 按 type 批聚合 appendFile） | MUST 单文件 ≤300 行；MUST NOT 在此文件做业务逻辑（仅 queue 基建） | 设计方案§改造#1 | +110 |
| dev_logs | app/server/src/dev-logs/log-queue.ts | `MAX_BUFFER_BYTES` / `BATCH_MAX_COUNT` / `BATCH_MAX_BYTES` / `BATCH_INTERVAL_MS` / `IDLE_WAIT_MS` / `WARN_THROTTLE_MS` | 新增 | 模块级 const：500MB 上限、批大小/字节阈值、批间 250ms、idle 50ms、warn 节流 10s | MUST `MAX_BUFFER_BYTES = 500*1024*1024`（用户硬上限）；MUST NOT 改小绕过节流；MUST 所有 timer 用 unref sleep helper | 设计方案§5 个结论#5；设计方案§改造#1 | +6 |
| dev_logs | app/server/src/dev-logs/log-queue.ts | `sleep` (module-level helper) | 新增 | `(ms) => new Promise<void>(r => { const t = setTimeout(r, ms); t.unref?.(); })` | MUST `t.unref?.()`（不阻塞进程退出）；MUST NOT 同步 busy-wait | v0.0.136 同模式（设计方案§改造#1）；memory async-marked-fn-sync-io-blocks-eventloop | +1 |
| dev_logs | app/server/src/dev-logs/log-queue.ts | `LogEntry` interface | 新增 | `{ type: LogType; line: string; size: number }`，消费单元 | — | 设计方案§改造#1 | +1 |
| dev_logs | app/server/src/dev-logs/log-queue.ts | `LogQueue` class | 新增 | 有界队列：`q: LogEntry[]` + `bufferedBytes` + `loopStarted` + `lastDropWarn` + `droppedSinceWarn`；构造接 `dataDir` | MUST 单实例（每 LogWriter 一份）；MUST NOT 多实例（多 consumer 并发 appendFile 无序） | 设计方案§改造#1 | +1 |
| dev_logs | app/server/src/dev-logs/log-queue.ts | `LogQueue.enqueue(type, line)` | 新增 | 生产者：(1) `Buffer.byteLength(line)+1` 算 size；(2) `bufferedBytes+size > MAX` → drop new + 节流 warn（10s 窗口聚合 N 条计数）+ return；(3) 入队 + `bufferedBytes+=size`；(4) `loopStarted` flag 守卫首次启 `_consumerLoop` | MUST O(1) 入队（不含 stringify，line 由 caller 传入）；MUST drop new 保 FIFO 老；MUST NOT 抛错（fire-and-forget）；MUST loopStarted 仅置一次 | 设计方案§5 个结论#2+#3；spec dev-logs §2.3 fire-and-forget | +18 |
| dev_logs | app/server/src/dev-logs/log-queue.ts | `LogQueue._consumerLoop` | 新增 | 单 consumer async loop：(1) queue 空 → `await sleep(IDLE_WAIT_MS)` 轮询；(2) queue 非空 → 按 type 分桶取 batch（每 type ≤ BATCH_MAX_COUNT 且 ≤ BATCH_MAX_BYTES）；(3) 每 type 单次 `appendFile({flag:'a'})` 写盘 + 失败静默；(4) 每条出队时 `bufferedBytes-=size`；(5) `await sleep(BATCH_INTERVAL_MS)` 批间 yield | MUST 每批后 `await sleep(BATCH_INTERVAL_MS)`（核心修复，不可破）；MUST NOT 同步 while 排空；MUST 失败 try/catch 吞（spec §2.3）；MUST 所有 setTimeout 用 unref sleep helper；MUST NOT 调用 stringify（消费者纯 IO） | spec dev-logs §2.3；设计方案§5 个结论#5；memory async-marked-fn-sync-io-blocks-eventloop | +25 |
| dev_logs | app/server/src/dev-logs/log-queue.ts | `LogQueue.flush` | 新增 | `(deadlineMs = 5000) => Promise<void>`：`while q.length>0 && Date.now()<deadline: await sleep(20)`，供 UT 等队列消费完 | MUST 5s deadline 防 UT hang；MUST queue 空立即 return；MUST NOT 生产 shutdown 调（dev 日志可丢） | v0.0.136 flush 同模式；设计方案§5 个结论#4 | +5 |
| dev_logs | app/server/src/dev-logs/log-writer.ts | `appendFile` import / `join` 使用 | 删除 | 不再直接调 `appendFile`；`join` 仅 constructor 用一次（ensure 目录）保留 | MUST 完全删（不留 @deprecated 僵尸）；MUST NOT 在 write 路径再调 appendFile | memory delete-old-code-fully-when-replacing；设计方案§改造#1 | -3 |
| dev_logs | app/server/src/dev-logs/log-writer.ts | `LogWriter.queue: LogQueue` | 新增 | 私有字段：持一个 LogQueue 实例（constructor 创建） | MUST 每 LogWriter 实例一份；MUST NOT 模块级共享（UT 隔离） | 设计方案§改造#1 | +1 |
| dev_logs | app/server/src/dev-logs/log-writer.ts | `LogWriter` constructor | 修改 | 末尾加 `this.queue = new LogQueue(dataDir)`（mkdir ensure 保留） | MUST 保 mkdirSync ensure 目录（spec §2.2）；MUST 在 constructor 创建 queue（write 调用前必就绪） | spec dev-logs §2.2 | +2 |
| dev_logs | app/server/src/dev-logs/log-writer.ts | `LogWriter.write` | 修改 | (1) 零开销门禁保留（开关 false 早 return）；(2) 开关 true → `JSON.stringify({ts,...record})`（生产者侧 stringify）；(3) `this.queue.enqueue(type, line)`；(4) 删旧 `void appendFile(...).catch()` | MUST 同步返 void（fire-and-forget）；MUST NOT 在 write 内做 IO（IO 全在 consumer）；MUST NOT 移除零开销门禁（spec §2.4 核心契约）；MUST NOT await enqueue | spec dev-logs §2.3+§2.4；设计方案§改造#1（生产者 stringify 决策） | +3/-6 |
| dev_logs | app/server/src/dev-logs/__tests__/log-writer.test.ts | 既存 case | 修改 | (1) `await flushAppendFile()` helper 改 `await logWriter['queue'].flush()`；(2) 既存「写正确文件 / JSONL / 开关 false 不写 / append 累加 / 失败静默」case 全绿；(3) batch 消费延迟 → flush 后再断言 | MUST 全绿；MUST 总等待 <5s（用 flush 不用 wall clock） | 设计方案「UT 速度」 | +12/-6 |
| dev_logs | app/server/src/dev-logs/__tests__/log-writer.test.ts | 新增 `describe('LogQueue bounded consumer')` | 新增 | 4 case：(1) **批聚合**：write 100 条 → flush 后文件 100 行（验证 consumer 排空）；(2) **批间 yield**：write 后立即返（同步）+ consumer 异步落盘（`index()` 同步耗时 <5ms）；(3) **drop new**：mock bufferBytes 强制近 500MB 后 write 1 条 → 该条未落盘 + console.warn 被调（用 `vi.spyOn(console,'warn')`）；(4) **500MB 字节计量**：直接 enqueue 一条 size=600MB record → drop（验证 byte 上限而非条数） | MUST 覆盖 4 个核心新行为；MUST 用 flush 等队列；MUST NOT real clock >1s | 设计方案§改造#1+§5 个结论#2+#3 | +70 |
| observability | app/server/src/observability/langfuse-event-queue.ts | 文件本身 | 新增 | 新建模块：有界 LangfuseEventQueue 类（500MB + 全 op 队列 + 单 consumer async loop + SDK 调用） | MUST 单文件 ≤300 行；MUST NOT 在此文件做 API 表面（仅队列基建 + SDK 包装） | 设计方案§改造#2 | +160 |
| observability | app/server/src/observability/langfuse-event-queue.ts | `Op` type union | 新增 | `create-trace / create-span / create-gen / update` 4 种 op（带 id/parentId/args/genKind） | — | 设计方案§改造#2 | +5 |
| observability | app/server/src/observability/langfuse-event-queue.ts | `LangfuseEventQueue` class | 新增 | 持 `client: Langfuse` + `traces/obs/genKind` Map（从 LangfuseAdapter 迁入） + queue/bufferedBytes/loopStarted/lastDropWarn | MUST 单实例（每 LangfuseAdapter 一份）；MUST `obs` Map 语义不变（handle.id→observation） | 设计方案§改造#2；langfuse-adapter.ts L67-76 | +1 |
| observability | app/server/src/observability/langfuse-event-queue.ts | `LangfuseEventQueue.enqueue(op)` | 新增 | 生产者：估算 op size（按 JSON.stringify(args) 长度）→ `bufferedBytes+size > MAX` → drop new + 节流 warn + return → 入队 + 启 loop（flag 守卫） | MUST O(args.byteLength) 估算（不调 SDK）；MUST drop new；MUST NOT 抛错（核心红线：observability 失败绝不影响主流程） | 设计方案§改造#2；spec observability §核心红线 | +15 |
| observability | app/server/src/observability/langfuse-event-queue.ts | `LangfuseEventQueue._consumerLoop` | 新增 | 单 consumer：取 batch（≤BATCH_MAX_COUNT）→ 每 op `_apply(op)`（try/catch 静默）→ 批间 `await sleep(250)` | MUST 每批后 await sleep yield；MUST NOT 同步排空；MUST _apply 失败吞（核心红线）；MUST timer 用 unref sleep | spec observability §核心红线；设计方案§5 个结论#5 | +15 |
| observability | app/server/src/observability/langfuse-event-queue.ts | `LangfuseEventQueue._apply(op)` | 新增 | op 分发：create-trace→`client.trace(args)`+obs.set；create-span→`resolveParent(parentId).span(args)`+obs.set；create-gen→`resolveParent(parentId).generation(args)`+obs.set+genKind.set；update→`obs.get(id)?.update(args)` | MUST 保留 SDK 调用语义（与 LangfuseAdapter 现状逐一等价）；MUST resolveParent 失败 throw（被 try/catch 吞，等价现状「parent 未找到」）；MUST NOT 改 input/metadata/output/usage 字段映射（§6 mapUsageDetails 不动） | langfuse-adapter.ts L88-294（逐一迁移）；spec observability §4-§6 | +35 |
| observability | app/server/src/observability/langfuse-event-queue.ts | `LangfuseEventQueue.resolveParent` | 新增（迁移） | 从 LangfuseAdapter 迁入：`obs.get(parent.id) ?? throw`（找不到兜底 throw 让 _apply try/catch 吞） | MUST 行为等价 LangfuseAdapter.resolveParent（不改回退策略） | langfuse-adapter.ts L298-307 | +10 |
| observability | app/server/src/observability/langfuse-event-queue.ts | `LangfuseEventQueue.drainAndShutdown` | 新增 | `while q.length>0 && Date.now()<deadline: await sleep(20)` → `await client.shutdownAsync()`（核心红线：shutdown 前 drain 防丢事件） | MUST drain 优先于 shutdownAsync（保既有契约）；MUST 5s deadline；MUST client.shutdownAsync 失败静默 | 设计方案§5 个结论#4；langfuse-adapter.ts L257-264 | +8 |
| observability | app/server/src/observability/langfuse-adapter.ts | `client` / `traces` / `obs` / `genKind` 字段 + `resolveParent` / `warn` 方法 | 删除（迁移到 queue） | 移入 LangfuseEventQueue；LangfuseAdapter 只保留 API 表面 + handle 生成 + op 构造 + queue 字段 | MUST 完全删（不留 @deprecated）；MUST NOT 残留任何 SDK 直调路径（全走 queue） | memory delete-old-code-fully-when-replacing；设计方案§改造#2 | -85 |
| observability | app/server/src/observability/langfuse-adapter.ts | `LangfuseAdapter.queue: LangfuseEventQueue` | 新增 | 私有字段：constructor 创建 `new LangfuseEventQueue(new Langfuse(opts))`（SDK 构造挪到 queue 内） | MUST 每 LangfuseAdapter 一份；MUST NOT 模块级共享 | 设计方案§改造#2 | +1 |
| observability | app/server/src/observability/langfuse-adapter.ts | `LangfuseAdapter` constructor | 修改 | 不再 `this.client = new Langfuse(opts)`；改为 `this.queue = new LangfuseEventQueue(new Langfuse(opts))`（SDK 实例移入 queue）；SDK 构造期抛错行为保留（由 factory 吞） | MUST 保留「SDK 构造抛错在激活前」语义（langfuse-adapter.ts L78-86 注释）；MUST NOT 在 constructor 启 consumer loop（lazy on first enqueue） | langfuse-adapter.ts L78-86；设计方案§改造#2 | +1/-3 |
| observability | app/server/src/observability/langfuse-adapter.ts | `LangfuseAdapter.startTrace` | 修改 | try/catch 保留（保核心红线）；body 改为 `this.queue.enqueue({kind:'create-trace', id:p.id, args:{...}})`；返回 `{kind:'trace', id:p.id}` 不变 | MUST 同步返 TraceHandle（loop 不 await）；MUST NOT 直接调 `client.trace`；MUST handle.id 在 start 同步生成（caller 立即可用） | spec observability §核心红线；设计方案§改造#2 | +3/-12 |
| observability | app/server/src/observability/langfuse-adapter.ts | `LangfuseAdapter.endTrace` | 修改 | try/catch 保留；body 改为 `this.queue.enqueue({kind:'update', id:h.id, args:upd})`（upd 组装逻辑保留） | MUST 同步返 void；MUST NOT 直接调 `obs.update` | 同上 | +2/-8 |
| observability | app/server/src/observability/langfuse-adapter.ts | `LangfuseAdapter.startSpan` | 修改 | try/catch 保留；生成 `id=ulid()` + handle 同步返；body 改为 `this.queue.enqueue({kind:'create-span', id, parentId:p.parent.id, args:spanArgs})`（isTool/isStep 分支 + spanArgs 组装保留） | MUST handle.id 同步生成；MUST NOT 直接调 `parentObs.span` | 同上 | +3/-15 |
| observability | app/server/src/observability/langfuse-adapter.ts | `LangfuseAdapter.endSpan` | 修改 | try/catch 保留；body 改为 `this.queue.enqueue({kind:'update', id:h.id, args:upd})`（upd 组装含 endTime/output/level/metadata 保留） | MUST 同步返 void | 同上 | +2/-10 |
| observability | app/server/src/observability/langfuse-adapter.ts | `LangfuseAdapter.startGeneration` | 修改 | try/catch 保留；生成 `id=ulid()` + handle 同步返；body 改为 `this.queue.enqueue({kind:'create-gen', id, parentId:p.parent.id, args:genArgs, genKind})`（genKind 分支 + genArgs 组装保留） | MUST handle.id 同步生成；MUST NOT 直接调 `parentObs.generation` | 同上 | +3/-18 |
| observability | app/server/src/observability/langfuse-adapter.ts | `LangfuseAdapter.endGeneration` | 修改 | try/catch 保留；body 改为 `this.queue.enqueue({kind:'update', id:e.gen.id, args:upd})`（含 mapUsageDetails/mapGenMetadata 调用保留 + physical 分支保留） | MUST 保留 mapUsageDetails/mapGenMetadata 调用（§6 互斥拆分）；MUST NOT 直接调 `o.update` | spec observability §6；同上 | +3/-15 |
| observability | app/server/src/observability/langfuse-adapter.ts | `LangfuseAdapter.setLevel` | 修改 | try/catch 保留；body 改为 `this.queue.enqueue({kind:'update', id:h.id, args: h.kind==='trace' ? {metadata:{errorLevel:level}} : {level}})`（trace 等价机制保留） | MUST 保留 trace 走 metadata.errorLevel 等价表达（spec R7）；MUST NOT 直接调 `o.update` | spec observability R7；langfuse-adapter.ts L266-294 | +2/-12 |
| observability | app/server/src/observability/langfuse-adapter.ts | `LangfuseAdapter.shutdown` | 修改 | body 改为 `await this.queue.drainAndShutdown()`（drain + client.shutdownAsync 全在 queue 内） | MUST drain 先于 shutdownAsync（核心红线）；MUST 失败静默；MUST 保留 async 签名 | langfuse-adapter.ts L257-264；设计方案§5 个结论#4 | +1/-5 |
| observability | app/server/src/observability/__tests__/observability-langfuse-adapter.test.ts | 既存 case | 修改 | 既存「startTrace/endTrace/startSpan/endSpan/startGeneration/endGeneration/setLevel」case 全绿（API 表面不变，内部走 queue）；改用 `await adapter['queue'].flush()` 或 fake timer 等消费完 | MUST 全绿；MUST 总等待 <5s（用 flush/fake timer 不用 wall clock） | 设计方案「UT 速度」 | +10/-4 |
| observability | app/server/src/observability/__tests__/observability-langfuse-adapter.test.ts | 新增 `describe('LangfuseEventQueue bounded consumer')` | 新增 | 4 case：(1) **start-end 时序**：startTrace + startSpan + startGeneration（嵌套）+ 各 endXxx → flush 后 SDK 被依次调（trace→span→gen→3 个 update，顺序保 FIFO）；(2) **drop new**：mock bufferBytes 近 500MB 后 enqueue update → 该 update 未到达 SDK；(3) **FIFO 保 parent 命中**：startSpan(parent) + endSpan + flush → consumer 处理时 resolveParent 命中（不丢 parent）；(4) **shutdown drain**：enqueue 3 ops → shutdown → 全部到达 SDK + shutdownAsync 被调 | MUST 覆盖 4 个核心新行为；MUST NOT real clock >1s | 设计方案§改造#2+§5 个结论 | +75 |
| router | app/server/src/router.ts | `handleRequest` | 修改 | dispatch 前 `const start = Date.now()`（在 try 块内 `getBootstrap` 后、dispatch 前）；write 时 record 加 `durationMs: Date.now() - start` | MUST 仅 2 行级改动（不动其他逻辑）；MUST start 在 `dispatchRequestInternal` 之前取（保证 RT 含 dispatch 全程）；MUST NOT 影响 dispatch 或 try/catch 结构 | 设计方案§改造#3；context.md finding 11:05 | +2 |
| front_end | app/web/src/components/chat-page/* | — | 不变（标注） | 对话内容已无缓存（context.md Explore 11:10），用户「session 每次打开重新获取」对对话内容已满足。本版本前端零改。可选 follow-up A/B/C（列表级强制刷新）默认不做，待用户明示。 | MUST NOT 顺手改前端（违反范围纪律）；MUST 在 task.json 备注「前端 follow-up A/B/C = optional 未做」 | context.md finding 11:10；用户原话「前端不缓存」；原则 only-do-queried-work | +0 |

---

## 影响面评估

**新增文件（2 个 A 类，合并时重点核对）**：
- `app/server/src/dev-logs/log-queue.ts`（~110 行）
- `app/server/src/observability/langfuse-event-queue.ts`（~160 行）

**修改文件（5 个）**：
- `app/server/src/dev-logs/log-writer.ts`（102 → ~90 行；write 简化）
- `app/server/src/observability/langfuse-adapter.ts`（315 → ~200 行；瘦身回归 300 软限合规）
- `app/server/src/router.ts`（+2 行；仅 handleRequest 加 RT）
- `app/server/src/dev-logs/__tests__/log-writer.test.ts`（UT 适配 + 新增 4 case）
- `app/server/src/observability/__tests__/observability-langfuse-adapter.test.ts`（UT 适配 + 新增 4 case）

**依赖顺序**：新文件（const/helper → 类 → enqueue → consumerLoop → flush/_apply/drainAndShutdown） → 旧文件（log-writer write 改 / langfuse-adapter start*/end*/setLevel/shutdown 改 / router 加 RT） → UT 适配 → 新增 UT。

**破坏性变更**：
- LogWriter 内部：`appendFile` 直调路径删除（私有，无外部依赖，grep 仅 log-writer.ts + 测试 mock）。
- LangfuseAdapter 内部：`client/traces/obs/genKind/resolveParent/warn` 迁入 queue（私有，无外部依赖；observability-manager.ts 只用公共 API `new LangfuseAdapter(opts)` + `startXxx/endXxx/setLevel/shutdown`，零变化）。
- 公共 API（`LogWriter.write` / `LangfuseAdapter.start*/end*/setLevel/shutdown`）签名零变化。
- 行为变化：(1) 日志落盘延迟 ≥ BATCH_INTERVAL_MS=250ms（dev 日志可接受）；(2) 队列满（500MB）drop new（dev/observability 都是旁观者，drop 不影响业务）；(3) api.log 多 `durationMs` 字段（追加，向后兼容）。

**风险点**：
1. **langfuse start/end 时序**：consumer FIFO 保证 parent op 先于 child op 处理 → `resolveParent` 必命中。但若 consumer 异常重启（不会，loop 永久运行 + 单批 try/catch 吞），obs Map 状态丢失 → 后续 update 全部 drop。**缓解**：单批失败仅丢该批，不重置 Map；Map 是 consumer 内部的，跨批持续累积。
2. **500MB buffer 实际触发**：稳态下 queue 几乎恒空（250ms 消费 64 条/批 = 256 条/s，远超 ingest 率）。drop new 只在 burst（langfuse 服务端慢/不可达 + 高频 squad 活动）触发。**dev 日志可丢；langfuse drop = observability 缺一段 trace，不影响业务**。
3. **UT 速度**：BATCH_INTERVAL_MS=250ms 让多批 UT 慢。**强制** coder 用 `vi.useFakeTimers()` 或 `queue.flush()`。
4. **router.ts 体量**：651 行（已超 300），本版本仅 +2 行不恶化，不拆分（独立 follow-up）。
5. **spec ↔ code 偏离**：spec dev-logs §2.3「异步、不阻塞 / fire-and-forget / 失败静默」当前 code 直调 appendFile 字面兑现但违背「不阻塞」精神（同步 stringify + 海量 syscall 反而阻塞）。本次回归 spec **意图**。**doc-modifier 阶段 5 应在 spec §2.3 加一条显式 invariant**：「LogWriter 内部必须走 async consumer loop，批间 await 让出 event loop，MUST NOT 同步直调 appendFile 每条」（避免回归）。同理 spec observability §核心红线 + §shutdown 加 invariant「adapter 内部走 LangfuseEventQueue，500MB drop-new」。

**不变（保留）**：
- spec dev-logs §2.4 零开销门禁（开关 false 早 return，write 第一行不变）。
- spec dev-logs §2.3 fire-and-forget + 失败静默（consumer try/catch 兜底）。
- spec observability §核心红线：observability 失败绝不影响主流程（_apply try/catch + enqueue 不 await）。
- spec observability §shutdown：shutdown await flush（drainAndShutdown 兑现）。
- spec observability §6 mapUsageDetails/mapGenMetadata（usage 映射零变化，仅在 endGeneration 内组装 args 时调）。
- LangfuseAdapter 公共 API + handle.id→obs 语义（obs Map 迁入 queue 但 key/value 不变）。
- v0.0.136 HistoryIndexer async loop（不动）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现 spec ↔ code 偏离（如 spec dev-logs §2.3 文字与现状不符）→ 汇报 orchestrator，记入 task-board doc-sync 待办，doc-modifier 阶段 5 统一修
- 设计方案「生产者 stringify」vs 原任务描述「stringify 挪到消费者」的差异：architect 已评估并选择生产者 stringify（理由见设计方案§改造#1），coder 按本表实现；如需复议提 orchestrator
