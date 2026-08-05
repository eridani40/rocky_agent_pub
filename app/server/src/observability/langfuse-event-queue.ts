/**
 * LangfuseEventQueue — LangfuseAdapter 的有界事件消费者队列。
 * 参考: specs/tech/agent/observability/[P0]langfuse_adapter.md §核心红线 / §shutdown / §6
 *       specs/tech/version_logs/v0.0.138/change_plan.md §改造#2（设计契约）
 *
 * 设计要点（与 dev-logs/log-queue.ts 同构）：
 *   - **全 op 队列**（方案 B）：start 方法入队 create-op、end 和 setLevel 入队 update-op；
 *     handle.id 在 start 方法同步生成（caller 立即可用），consumer FIFO 保证 parent op 先处理
 *     → resolveParent 必命中（parent create 先于 child create 入队 + 同批内顺序处理）
 *   - **500MB 字节计量**（用户硬上限）：bufferedBytes + size > MAX → drop new + 节流 warn（保 FIFO 老）
 *   - **单 consumer async loop**：批间 await sleep(250ms) 让出 event loop（MUST NOT 同步排空）
 *   - **核心红线**：observability 失败绝不影响主流程 — enqueue 同步不 await + _apply try/catch 静默
 *   - **drainAndShutdown**：shutdown 前 drain（保 SDK shutdownAsync 不丢未处理事件），drain 用 writing flag 修 race
 *
 * genKind 时序：create-gen op 入队时同步 set genKind（adapter.endGeneration 组装 update args 时
 * 同步查），避免「consumer 异步 set genKind 但 endGeneration 先读」的 race（physical gen 被误按 logical 处理）。
 */
import type { Langfuse } from 'langfuse';

// ── 模块级常量（与 log-queue.ts 同值） ──
const MAX_BUFFER_BYTES = 500 * 1024 * 1024; // 500MB（用户硬上限，不可改小绕过节流）
const BATCH_MAX_COUNT = 64; // 每批最多 64 个 op
const BATCH_INTERVAL_MS = 250; // 批间 sleep（4Hz 消费）
const IDLE_WAIT_MS = 50; // queue 空 → 50ms 轮询
const WARN_THROTTLE_MS = 10_000; // drop warn 节流窗口（10s 聚合 N 条计数）

/** 可 unref 的 sleep helper（不阻塞进程退出；Bun/Node 用 ?.() 探测兜底） */
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

/** langfuse observation 最小形状（duck-typed，避免耦合 SDK 内部类型） */
interface LangfuseObservation {
  update(p: Record<string, unknown>): unknown;
  span(p: Record<string, unknown>): LangfuseObservation;
  generation(p: Record<string, unknown>): LangfuseObservation;
}

/** langfuse trace 最小形状 */
interface LangfuseTrace {
  update(p: Record<string, unknown>): unknown;
  span(p: Record<string, unknown>): LangfuseObservation;
  generation(p: Record<string, unknown>): LangfuseObservation;
}

/** 队列事件（4 种 op，逐一等价 LangfuseAdapter 现状 SDK 调用） */
export type Op =
  | { kind: 'create-trace'; id: string; args: Record<string, unknown> }
  | { kind: 'create-span'; id: string; parentId: string; args: Record<string, unknown> }
  | {
      kind: 'create-gen';
      id: string;
      parentId: string;
      args: Record<string, unknown>;
      genKind: 'logical' | 'physical';
    }
  | { kind: 'update'; id: string; args: Record<string, unknown> };

/**
 * LangfuseEventQueue — 单 LangfuseAdapter 持一份的有界事件队列。
 *
 * 生产者 enqueue（同步 O(1)，不 await）→ consumer loop 后台按批 _apply 调 SDK。
 * SDK 状态（traces/obs/genKind Map）从 LangfuseAdapter 迁入，语义不变（consumer 维护）。
 * 队列满（500MB）drop new（保 FIFO 老）+ 节流 warn。
 */
export class LangfuseEventQueue {
  private q: Op[] = [];
  private bufferedBytes = 0;
  private loopStarted = false;
  private lastDropWarn = 0;
  private droppedSinceWarn = 0;
  /** consumer 当前是否在 _apply 段（drain/flush 须等 apply 完成而不只 q 空，抄 log-queue.ts flush race 修复） */
  private writing = false;

  /** SDK 状态（从 LangfuseAdapter 迁入，key/value 语义不变） */
  private readonly traces = new Map<string, LangfuseTrace>();
  private readonly obs = new Map<string, LangfuseTrace | LangfuseObservation>();
  private readonly genKind = new Map<string, 'logical' | 'physical'>();

  constructor(private readonly client: Langfuse) {}

  /**
   * 生产者：入队一个 op。超 500MB → drop new + 节流 warn。
   * 对 create-gen 同步 set genKind（endGeneration 组装 update args 时同步查，无 race）。
   * MUST NOT 抛错（核心红线：observability 失败绝不影响主流程）。
   */
  enqueue(op: Op): void {
    // create-gen 同步记 genKind（adapter.endGeneration 需同步查以组装 physical/logical 分支 args）
    if (op.kind === 'create-gen') this.genKind.set(op.id, op.genKind);
    const size = this._estimateSize(op);
    // 500MB drop new（保 FIFO 老）
    if (this.bufferedBytes + size > MAX_BUFFER_BYTES) {
      this.droppedSinceWarn++;
      const now = Date.now();
      if (now - this.lastDropWarn > WARN_THROTTLE_MS) {
        console.warn(
          '[observability:langfuse] event queue overflow (%d bytes), dropped %d events in last %dms (drop-new FIFO-old)',
          this.bufferedBytes,
          this.droppedSinceWarn,
          now - this.lastDropWarn,
        );
        this.lastDropWarn = now;
        this.droppedSinceWarn = 0;
      }
      return; // drop new
    }
    this.q.push(op);
    this.bufferedBytes += size;
    // lazy 启 consumer loop（flag 守卫仅一次）
    if (!this.loopStarted) {
      this.loopStarted = true;
      void this._consumerLoop().catch(() => {
        /* 静默：observability consumer 永久 loop 不应 throw */
      });
    }
  }

  /** 查询 gen id 的 kind（adapter.endGeneration 组装 update args 时用；默认 logical） */
  getGenKind(id: string): 'logical' | 'physical' {
    return this.genKind.get(id) ?? 'logical';
  }

  /** 估算 op 字节大小（按 args JSON 长度 + 固定 overhead） */
  private _estimateSize(op: Op): number {
    return Buffer.byteLength(JSON.stringify(op.args ?? {}), 'utf8') + 64;
  }

  /**
   * 单 consumer async loop：空 → 50ms 轮询；非空 → 取 batch（≤64）→ 每 op _apply（try/catch 静默）
   * → 批间 await sleep(250ms) 让出 event loop（核心修复，MUST NOT 同步排空）。
   */
  private async _consumerLoop(): Promise<void> {
    while (true) {
      if (this.q.length === 0) {
        await sleep(IDLE_WAIT_MS);
        continue;
      }
      const batch = this.q.splice(0, BATCH_MAX_COUNT);
      this.bufferedBytes -= batch.reduce((s, op) => s + this._estimateSize(op), 0);
      this.writing = true;
      try {
        for (const op of batch) {
          try {
            this._apply(op);
          } catch (e) {
            // 核心红线：静默（console.warn debug 级，不向 loop 抛）
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(`[observability:langfuse] consumer ${op.kind} failed (suppressed): ${msg}`);
          }
        }
      } finally {
        this.writing = false;
      }
      // 核心：批间 yield 让出 event loop（不可破）
      await sleep(BATCH_INTERVAL_MS);
    }
  }

  /** op 分发 → SDK 调用（与 LangfuseAdapter 现状逐一等价） */
  private _apply(op: Op): void {
    // [v0.0.207 debug] 关掉刷屏噪音日志，reproduce 后还原
    // console.log(`[observability:queue] _apply ${op.kind} id=${op.id}`);
    switch (op.kind) {
      case 'create-trace': {
        const t = this.client.trace(op.args) as LangfuseTrace;
        this.traces.set(op.id, t);
        this.obs.set(op.id, t);
        break;
      }
      case 'create-span': {
        const span = this.resolveParent(op.parentId).span(op.args);
        this.obs.set(op.id, span);
        break;
      }
      case 'create-gen': {
        const g = this.resolveParent(op.parentId).generation(op.args);
        this.obs.set(op.id, g);
        break;
      }
      case 'update': {
        this.obs.get(op.id)?.update(op.args);
        break;
      }
    }
  }

  /** 解析 parent id → 父 observation（找不到 → throw 让 _apply try/catch 吞，等价现状「parent 未找到」） */
  private resolveParent(parentId: string): LangfuseTrace | LangfuseObservation {
    const o = this.obs.get(parentId);
    if (o) return o;
    throw new Error(`observability: parent observation not found for id=${parentId}`);
  }

  /**
   * shutdown 前先 drain（保 SDK shutdownAsync 不丢未处理事件），再 client.shutdownAsync()。
   * drain 用 writing flag 修 race（抄 log-queue.ts）：consumer _apply 段置 writing=true / finally false，
   * drain 条件 `q.length>0 || writing`。
   * @param deadlineMs 最长等待毫秒（默认 5s，防 hang）
   */
  async drainAndShutdown(deadlineMs = 5_000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while ((this.q.length > 0 || this.writing) && Date.now() < deadline) {
      await sleep(20);
    }
    try {
      await this.client.shutdownAsync();
    } catch {
      /* 静默：shutdown 失败不影响已上报数据 */
    }
  }

  /** （仅 UT 用）等队列消费到空且当前批 _apply 完成或 deadline。 */
  async flush(deadlineMs = 5_000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while ((this.q.length > 0 || this.writing) && Date.now() < deadline) {
      await sleep(20);
    }
  }
}
