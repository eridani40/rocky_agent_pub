/**
 * LogQueue —— LogWriter 的有界消费者队列（500MB drop-new + 单 consumer async loop）
 * 参考: specs/tech/dev-logs/[P0]overall.md §2.3（fire-and-forget / 失败静默）
 *       specs/tech/version_logs/v0.0.138/change_plan.md §改造#1（设计契约）
 *
 * 设计要点：
 *   - **500MB 字节计量**（用户硬上限）：`bufferedBytes + size > MAX` 时 drop new + 节流 warn（保 FIFO 老）
 *   - **单 consumer async loop**：批间 `await sleep(BATCH_INTERVAL_MS=250ms)` 让出 event loop（核心修复，
 *     memory async-marked-fn-sync-io-blocks-eventloop），MUST NOT 同步排空
 *   - **批聚合**：按 type 分桶取 batch（每 type ≤64 条且 ≤1MB），每 type 单次 appendFile `{flag:'a'}`
 *   - **失败静默**（spec §2.3）：appendFile catch 吞，绝不影响业务
 *   - **生产者只入队已 stringify 的 line**：caller 侧 stringify（architect 决策，理由见 change_plan §改造#1）
 *   - **lazy loop**：首次 enqueue 才启 loop，loopStarted flag 守卫仅启动一次
 *
 * 与 v0.0.136 HistoryIndexer async loop 同模式（unref sleep + batch yield + lazy start）。
 */
import { appendFile, stat, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogType } from './log-writer';

// ── 模块级常量（change_plan §改造#1） ──
const MAX_BUFFER_BYTES = 500 * 1024 * 1024; // 500MB（用户硬上限，不可改小绕过节流）
const BATCH_MAX_COUNT = 64; // 每批最多 64 条
const BATCH_MAX_BYTES = 1 * 1024 * 1024; // 或 1MB（先到先止）
const BATCH_INTERVAL_MS = 250; // 批间 sleep（4Hz 消费）
const IDLE_WAIT_MS = 50; // queue 空 → 50ms 轮询
const WARN_THROTTLE_MS = 10_000; // drop warn 节流窗口（10s 聚合 N 条计数）

// ── 日志文件轮转（change_plan §改造#5） ──
const ROTATION_MAX_FILE_BYTES = 50 * 1024 * 1024; // 每活跃文件上限 50MB
const ROTATION_MAX_FILES = 10; // 每类型最多保留文件数（含活跃）

/**
 * 可 unref 的 sleep helper（不阻塞进程退出；memory async-marked-fn-sync-io-blocks-eventloop）。
 * Bun/Node 都有 `Timeout.unref()`，用 `?.()` 探测兜底。
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

/** 入队单元：type + 已 stringify 的 line + 字节大小（含 '\n'） */
interface LogEntry {
  type: LogType;
  line: string;
  size: number;
}

/**
 * LogQueue —— 单 LogWriter 持一份的有界消费者队列。
 *
 * 生产者 enqueue（O(1)，不含 IO/stringify）→ consumer loop 后台按批 appendFile。
 * 队列满（500MB）drop new（保 FIFO 老）+ 节流 warn。
 */
export class LogQueue {
  private q: LogEntry[] = [];
  private bufferedBytes = 0;
  private loopStarted = false;
  private lastDropWarn = 0;
  private droppedSinceWarn = 0;
  /** consumer 当前是否在 appendFile（flush 须等 IO 完成而不只 q 空） */
  private writing = false;
  /** 每类型当前活跃文件字节数（单线程 consumer 无并发；首次写前 stat 初始化） */
  private fileSizeByType = new Map<LogType, number>();
  /** 每文件最大字节数（轮转触发阈值；UT 注入小值，生产用 ROTATION_MAX_FILE_BYTES） */
  private readonly maxFileBytes: number;
  /** 每类型最多保留文件数（含活跃；轮转后 FIFO 删最老） */
  private readonly maxFiles: number;

  constructor(
    private readonly dataDir: string,
    opts?: { maxFileBytes?: number; maxFiles?: number },
  ) {
    this.maxFileBytes = opts?.maxFileBytes ?? ROTATION_MAX_FILE_BYTES;
    this.maxFiles = opts?.maxFiles ?? ROTATION_MAX_FILES;
  }

  /**
   * 生产者：入队一条已 stringify 的日志行。
   *
   * @param type 日志类型（决定落盘文件名 `<type>.log`）
   * @param line 已 stringify 的 JSON 行（caller 侧已加 ts）
   */
  enqueue(type: LogType, line: string): void {
    const size = Buffer.byteLength(line, 'utf8') + 1; // +1 for '\n'
    // 500MB drop new（保 FIFO 老）
    if (this.bufferedBytes + size > MAX_BUFFER_BYTES) {
      this.droppedSinceWarn++;
      const now = Date.now();
      if (now - this.lastDropWarn > WARN_THROTTLE_MS) {
        console.warn(
          '[log-writer] buffer overflow (%d bytes), dropped %d entries in last %dms (drop-new FIFO-old)',
          this.bufferedBytes,
          this.droppedSinceWarn,
          now - this.lastDropWarn,
        );
        this.lastDropWarn = now;
        this.droppedSinceWarn = 0;
      }
      return; // drop new
    }
    this.q.push({ type, line, size });
    this.bufferedBytes += size;
    // lazy 启 consumer loop（flag 守卫仅一次）
    if (!this.loopStarted) {
      this.loopStarted = true;
      void this._consumerLoop().catch(() => {
        /* 静默：dev 日志是旁观者，consumer 永久 loop 不应 throw */
      });
    }
  }

  /**
   * 单 consumer async loop：空 → 50ms 轮询；非空 → 按 type 分桶取 batch → 每 type 单次 appendFile；
   * 批间 `await sleep(BATCH_INTERVAL_MS)` 让出 event loop（核心修复，MUST NOT 同步排空）。
   */
  private async _consumerLoop(): Promise<void> {
    while (true) {
      if (this.q.length === 0) {
        await sleep(IDLE_WAIT_MS);
        continue;
      }
      // 按 type 分桶取 batch（每 type ≤COUNT 且 ≤BYTES）
      const buckets = new Map<LogType, { lines: string[]; bytes: number }>();
      let taken = 0;
      while (this.q.length > 0 && taken < BATCH_MAX_COUNT) {
        const e = this.q[0]!;
        const b = buckets.get(e.type) ?? { lines: [], bytes: 0 };
        // 当前 type 桶超 BYTES 且已有内容 → 停止（保本批该 type 不爆；下批再取）
        if (b.bytes + e.size > BATCH_MAX_BYTES && b.lines.length > 0) break;
        b.lines.push(e.line);
        b.bytes += e.size;
        buckets.set(e.type, b);
        this.q.shift();
        this.bufferedBytes -= e.size;
        taken++;
      }
      // 每 type 单次 appendFile（flag:'a' 追加，失败静默 spec §2.3）
      // 改造#5：写前检查 size 轮转，写后累加 fileSizeByType
      this.writing = true;
      try {
        for (const [type, b] of buckets) {
          const content = b.lines.join('\n') + '\n';
          const batchBytes = Buffer.byteLength(content, 'utf8');
          try {
            await this._rotateIfNeeded(type);
            await appendFile(join(this.dataDir, 'logs', `${type}.log`), content, {
              flag: 'a',
            });
            this.fileSizeByType.set(type, (this.fileSizeByType.get(type) ?? 0) + batchBytes);
          } catch {
            /* 静默：权限/磁盘满等，dev 日志是旁观者 */
          }
        }
      } finally {
        this.writing = false;
      }
      // 核心：批间 yield 让出 event loop（不可破）
      await sleep(BATCH_INTERVAL_MS);
    }
  }

  /**
   * 改造#5：按 type 检查并执行轮转（size-based，per-type，FIFO 上限）。
   *
   * 流程：
   *   1. 首次写该 type → `stat` 既有 `<type>.log` 初始化 fileSize（接续旧文件 size，避免重启后失同步）
   *   2. `fileSize >= maxFileBytes` → `rename <type>.log → <type>-YYYYMMDD-HHMMSS-mmm.log`
   *   3. FIFO：`readdir` 筛 `<type>-*.log`，> maxFiles-1 → 按名（=时间戳）`unlink` 最老
   *   4. 重置 fileSize=0
   *
   * 全 async（consumer 内 await）；失败静默（spec §2.3）。单线程 consumer 无并发。
   */
  private async _rotateIfNeeded(type: LogType): Promise<void> {
    // 首次写该 type → stat 既有 <type>.log 初始化 fileSize（接续旧文件 size）
    if (!this.fileSizeByType.has(type)) {
      try {
        const st = await stat(join(this.dataDir, 'logs', `${type}.log`));
        this.fileSizeByType.set(type, st.size);
      } catch {
        // 文件不存在 → size 0
        this.fileSizeByType.set(type, 0);
      }
    }
    const cur = this.fileSizeByType.get(type) ?? 0;
    if (cur < this.maxFileBytes) return; // 未达阈值 → 不轮转

    const logsDir = join(this.dataDir, 'logs');
    const activePath = join(logsDir, `${type}.log`);
    const ts = this._formatTimestamp(new Date());

    // 同毫秒碰撞兜底：找不冲突的轮转文件名（默认 <type>-<ts>.log，碰撞则 +序号后缀）
    let rotatedName = `${type}-${ts}.log`;
    for (let seq = 1; seq < 1000; seq++) {
      try {
        await stat(join(logsDir, rotatedName));
        // 文件已存在 → 切下一个候选名
        rotatedName = `${type}-${ts}-${seq}.log`;
      } catch {
        break; // 不存在 → 用当前 rotatedName
      }
    }

    // rename <type>.log → 轮转文件（失败静默；不重置 fileSize → 下次再试）
    try {
      await rename(activePath, join(logsDir, rotatedName));
    } catch {
      /* 静默：spec §2.3 */
      return;
    }

    // FIFO：统计 <type>-*.log，> maxFiles-1 → 按名（=时间戳字典序）删最老
    try {
      const files = await readdir(logsDir);
      const rotatedFiles = files
        .filter((f) => f.startsWith(`${type}-`) && f.endsWith('.log'))
        .sort(); // 时间戳字典序 = 创建时间序（老→新）
      const keepCount = this.maxFiles - 1; // 轮转文件保留上限（活跃文件是第 maxFiles 个）
      const excess = rotatedFiles.length - keepCount;
      for (let i = 0; i < excess; i++) {
        try {
          await unlink(join(logsDir, rotatedFiles[i]!));
        } catch {
          /* 静默：单个删除失败不影响整体 */
        }
      }
    } catch {
      /* 静默 */
    }

    this.fileSizeByType.set(type, 0);
  }

  /**
   * 格式化轮转文件名时间戳：`YYYYMMDD-HHMMSS-mmm`（filename-safe，带毫秒防同秒碰撞）。
   */
  private _formatTimestamp(d: Date): string {
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return (
      `${pad(d.getFullYear(), 4)}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
      `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(
        d.getMilliseconds(),
        3,
      )}`
    );
  }

  /**
   * （仅 UT 用）等队列消费到空且当前批 appendFile 完成或 deadline。
   *
   * **生产 shutdown 不调**（dev 日志可丢，change_plan §5 个结论#4 决策「不 flush」）。
   * 注意：consumer 在调用 appendFile 前已把条目从 q 取走，故 flush 须同时等 q 空 AND writing=false，
   * 否则会读到尚未落盘的旧文件内容（race：consumer 在 appendFile pending 时 flush 误判完成）。
   * @param deadlineMs 最长等待毫秒（默认 5s，防 UT hang）
   */
  async flush(deadlineMs = 5_000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while ((this.q.length > 0 || this.writing) && Date.now() < deadline) {
      await sleep(20);
    }
  }
}
