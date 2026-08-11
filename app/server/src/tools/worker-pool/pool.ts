/**
 * ToolWorkerPool —— 常驻 worker 线程池
 * 参考: specs/tech/version_logs/v0.0.307/change_plan.md A 组
 *       app/server/src/tools/browser/node-worker-driver.ts resolveWorkerPath（双路径探测参考）
 *
 * Worker 加载（三路径探测，全部文件模式——无运行时编译依赖）：
 *   - worker-entry.js（tsc 编译产物，packaged dist/）→ `new Worker(path)`
 *   - worker-bundle.cjs（esbuild 预构建 bundle，dev/test 用）→ `new Worker(path)`
 *   - worker-entry.ts（bun 源码，bun runtime 下 bun 原生加载 TS）→ `new Worker(path)`
 *
 * 为什么需要 worker-bundle.cjs：
 *   Node 原生 Worker 线程是独立 V8 isolate，不走 vitest/bun 的 TS transform 管线，
 *   无法直接加载 .ts 文件。dev/test 环境（npx vitest / node）用预构建的 .cjs bundle 绕过。
 *   bun runtime 原生支持 TS，直接加载 .ts。
 *
 * 设计：
 *   - 常驻池：首次 submit 时按 maxWorkers 创建，空闲 worker 复用（不每次新建）
 *   - 单 worker 串行：一次只跑一个任务，新任务排队等空闲信号
 *   - 崩溃重建：worker exit/error → 在途任务 reject WorkerCrashedError + 自动新建替代
 */
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { WorkerPoolTask, WorkerPoolResult, ToolWorkerResponse } from './types';

/**
 * worker 崩溃时在途任务 reject 用的错误类型。
 * 与工具自身的 isError（tool.run 返回）区分——这是 worker 线程层故障。
 */
export class WorkerCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerCrashedError';
  }
}

/** 单个 worker 的内部包装 */
interface PoolWorker {
  /** Worker 线程实例 */
  worker: Worker;
  /** 是否正在执行任务（true=忙，不可分配新任务） */
  busy: boolean;
}

/** 排队等待的任务 */
interface QueuedTask {
  task: WorkerPoolTask;
  resolve: (r: WorkerPoolResult) => void;
  reject: (e: WorkerCrashedError) => void;
}

/** Pool 构造选项 */
export interface ToolWorkerPoolOptions {
  /** 最大 worker 数（默认 min(4, max(1, cpus-1))） */
  maxWorkers?: number;
  /** worker 入口脚本绝对路径（默认 resolveWorkerPath 自动探测） */
  workerPath?: string;
}

/**
 * 常驻 worker 线程池。
 *
 * 生命周期：首次 submit 时懒创建 worker → 复用 → 崩溃重建 → close() 全部终止。
 * submit(task) 返回 Promise，resolve 时带工具结果，reject 时带 WorkerCrashedError。
 */
export class ToolWorkerPool {
  private readonly maxWorkers: number;
  private readonly workerPath: string;
  /** 活跃 worker 列表 */
  private readonly workers: PoolWorker[] = [];
  /** 空闲 worker 下标队列（FIFO 复用） */
  private readonly idleQueue: number[] = [];
  /** 排队等待的任务队列 */
  private readonly pendingQueue: QueuedTask[] = [];
  /** 在途任务映射：worker → { task, resolve, reject } */
  private readonly inflight = new Map<PoolWorker, QueuedTask>();
  /** 任务 id 自增计数器 */
  private idCounter = 0;
  /** 是否已关闭 */
  private closed = false;

  constructor(opts: ToolWorkerPoolOptions = {}) {
    const cpuCount = cpus().length;
    this.maxWorkers = opts.maxWorkers ?? Math.min(4, Math.max(1, cpuCount - 1));
    this.workerPath = opts.workerPath ?? resolveWorkerPath();
  }

  /**
   * 提交一个工具执行任务到 worker 池。
   * 空闲 worker 立即执行；否则排队等空闲信号。
   * @returns worker 执行结果（resolve=正常返回，reject=worker 崩溃）
   */
  submit(task: WorkerPoolTask): Promise<WorkerPoolResult> {
    if (this.closed) {
      return Promise.reject(new WorkerCrashedError('worker pool is closed'));
    }

    return new Promise<WorkerPoolResult>((resolve, reject) => {
      const queued: QueuedTask = { task, resolve, reject };

      // 尝试取空闲 worker
      const idleIdx = this.idleQueue.shift();
      if (idleIdx !== undefined) {
        // 有空闲 worker → 立即分配
        this.dispatchToWorker(idleIdx, queued);
      } else if (this.workers.length < this.maxWorkers) {
        // 未达上限 → 新建 worker
        const newIdx = this.workers.length;
        this.createWorker();
        this.dispatchToWorker(newIdx, queued);
      } else {
        // 全忙且达上限 → 排队
        this.pendingQueue.push(queued);
      }
    });
  }

  /**
   * 优雅关闭所有 worker 线程。
   * 关闭后 submit 将 reject。已关闭时重复调用安全（no-op）。
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    // reject 排队中的任务
    for (const q of this.pendingQueue) {
      q.reject(new WorkerCrashedError('worker pool closed'));
    }
    this.pendingQueue.length = 0;
    // terminate 所有 worker
    for (const pw of this.workers) {
      pw.worker.terminate().catch(() => {});
    }
    this.workers.length = 0;
    this.idleQueue.length = 0;
    this.inflight.clear();
  }

  /** 生成唯一任务 id（主线程 submit 前可调，也可外部传入） */
  nextId(): string {
    return `wp-${++this.idCounter}`;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 创建一个新的 Worker 线程并注册到池中。
   * 全部走文件模式 `new Worker(path)`——workerPath 由 resolveWorkerPath 三路径探测决定
   *（.js 编译产物 / .cjs 预构建 bundle / .ts bun 源码）。
   */
  private createWorker(): void {
    const worker = new Worker(this.workerPath);
    const pw: PoolWorker = { worker, busy: false };
    this.workers.push(pw);

    worker.on('message', (resp: ToolWorkerResponse) => {
      this.handleWorkerMessage(pw, resp);
    });
    worker.on('error', (e: Error) => {
      this.handleWorkerCrash(pw, `worker error: ${e.message}`);
    });
    worker.on('exit', (code) => {
      if (!this.closed && code !== 0) {
        this.handleWorkerCrash(pw, `worker exited with code ${code}`);
      }
    });
  }

  /** 分配任务到指定 worker */
  private dispatchToWorker(idx: number, queued: QueuedTask): void {
    const pw = this.workers[idx];
    if (!pw) return; // 防御性：idx 越界（重建过程中可能短暂不一致）
    pw.busy = true;
    this.inflight.set(pw, queued);
    pw.worker.postMessage(queued.task);
  }

  /** 处理 worker 返回的执行结果 */
  private handleWorkerMessage(pw: PoolWorker, resp: ToolWorkerResponse): void {
    const queued = this.inflight.get(pw);
    if (!queued) return; // 无在途任务（可能是重复消息）

    // 清除在途状态
    this.inflight.delete(pw);
    pw.busy = false;

    // resolve 任务
    const result: WorkerPoolResult = {
      id: resp.id,
      ok: resp.ok,
      content: (resp.content as WorkerPoolResult['content']) ?? [],
      isError: resp.isError,
      readSetAdditions: resp.readSetAdditions ?? [],
      error: resp.error,
    };
    queued.resolve(result);

    // 检查排队任务
    this.dispatchNext(pw);
  }

  /**
   * 处理 worker 崩溃：在途任务 reject + 重建 worker + 继续排队。
   */
  private handleWorkerCrash(pw: PoolWorker, reason: string): void {
    // reject 在途任务
    const queued = this.inflight.get(pw);
    if (queued) {
      this.inflight.delete(pw);
      queued.reject(new WorkerCrashedError(reason));
    }

    // 从池中移除崩溃 worker（不复活同一线程）
    const idx = this.workers.indexOf(pw);
    if (idx >= 0) {
      this.workers.splice(idx, 1);
      // 修正 idleQueue 中大于 idx 的下标
      for (let i = this.idleQueue.length - 1; i >= 0; i--) {
        const val = this.idleQueue[i]!;
        if (val === idx) {
          this.idleQueue.splice(i, 1);
        } else if (val > idx) {
          this.idleQueue[i] = val - 1;
        }
      }
    }

    // 重建替代 worker（保持池容量）
    if (!this.closed && this.workers.length < this.maxWorkers) {
      this.createWorker();
      const newIdx = this.workers.length - 1;
      // 新 worker 空闲，尝试消费排队任务
      this.idleQueue.push(newIdx);
      const next = this.pendingQueue.shift();
      if (next) {
        this.idleQueue.pop(); // 取走刚加的空闲位
        this.dispatchToWorker(newIdx, next);
      }
    }
  }

  /** worker 空闲后检查排队队列，有任务则分配 */
  private dispatchNext(pw: PoolWorker): void {
    const next = this.pendingQueue.shift();
    if (next) {
      const idx = this.workers.indexOf(pw);
      if (idx >= 0) {
        this.dispatchToWorker(idx, next);
      }
    } else {
      // 无排队任务 → worker 回到空闲池
      const idx = this.workers.indexOf(pw);
      if (idx >= 0) {
        this.idleQueue.push(idx);
      }
    }
  }
}

/**
 * 解析 worker 入口脚本绝对路径，三路径探测：
 *   1. worker-entry.js（tsc 编译产物，packaged dist/ 命中）
 *   2. worker-bundle.cjs（esbuild 预构建 bundle，dev/test 用——Node Worker 线程无法加载 .ts）
 *   3. worker-entry.ts（bun runtime 源码——bun 原生支持 TS Worker）
 *
 * 仿 browser/node-worker-driver.ts resolveWorkerPath 同构模式。
 */
export function resolveWorkerPath(): string {
  const dir = dirname(__filename);
  const compiled = join(dir, 'worker-entry.js');
  if (existsSync(compiled)) return compiled;
  const bundle = join(dir, 'worker-bundle.cjs');
  if (existsSync(bundle)) return bundle;
  return join(dir, 'worker-entry.ts');
}
