/**
 * persistent-worker —— 常驻 worker 组装（child + requestId 路由 + launch 确认帧 + exit reject）
 * 参考: specs/tech/agent/tools/[P1]browser_instance_manager.md §3.2/§6.1
 *
 * worker 协议：stdin 每行 {requestId, action, params}；stdout 每行 {requestId, ok, text?, error?}；
 * launch 确认帧无 requestId（{ok:true, text:'launched'}）。单 worker 单任务串行（pending 一次一个）。
 * worker exit → reject 全部 pending；action 超时（30s）→ resolve cdp_timeout。
 */
import type { ChildProcess } from 'node:child_process';
import type { BrowserActionParams, BrowserExecuteResult, PersistentWorker } from './types';
import { spawnWorker } from './node-worker-driver';

/** per-action 超时（对齐 WORKER_TIMEOUT_MS=30s） */
const ACTION_TIMEOUT_MS = 30_000;

/**
 * spawn 持久 worker 并组装协议层（keepStdinOpen：首行 launch 帧后不 end stdin）。
 * launch 用：拿到 child/worker/launchReady 后等确认帧。
 */
export function spawnPersistentWorker(
  spawnFn: NonNullable<import('./node-worker-driver').WorkerSpawnDeps['spawn']>,
  task: Record<string, unknown>,
): { child: ChildProcess; worker: PersistentWorker; launchReady: Promise<BrowserExecuteResult> } {
  const { child } = spawnWorker(spawnFn, task, { keepStdinOpen: true });
  const { worker, launchReady } = createPersistentWorker(child);
  return { child, worker, launchReady };
}

/**
 * 组装 PersistentWorker。
 * @returns { worker, launchReady }——launchReady 由首个无 requestId 帧 resolve（ok/text/error）
 */
export function createPersistentWorker(child: ChildProcess): {
  worker: PersistentWorker;
  launchReady: Promise<BrowserExecuteResult>;
} {
  const pending = new Map<
    number,
    { resolve: (r: BrowserExecuteResult) => void; reject: (e: Error) => void }
  >();
  let nextReqId = 1;
  let buf = '';
  let launchResolve: ((r: BrowserExecuteResult) => void) | undefined;
  let launchSettled = false;

  const launchReady = new Promise<BrowserExecuteResult>((resolve) => {
    launchResolve = resolve;
  });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let parsed: {
        requestId?: number;
        ok: boolean;
        text?: string;
        chromePid?: number;
        error?: BrowserExecuteResult['error'];
      };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // 坏行跳过（防御性）
      }
      if (typeof parsed.requestId === 'number') {
        const p = pending.get(parsed.requestId);
        if (p) {
          pending.delete(parsed.requestId);
          p.resolve({ ok: parsed.ok, text: parsed.text, error: parsed.error });
        }
      } else if (launchResolve && !launchSettled) {
        launchSettled = true;
        launchResolve({ ok: parsed.ok, text: parsed.text, error: parsed.error, chromePid: parsed.chromePid });
      }
    }
  });
  child.on('exit', (code) => {
    if (launchResolve && !launchSettled) {
      launchSettled = true;
      launchResolve({
        ok: false,
        error: { kind: 'worker_crashed', message: `worker 启动即退出 code=${code ?? ''}` },
      });
    }
    for (const [id, p] of [...pending]) {
      pending.delete(id);
      p.reject(new Error(`worker 退出 code=${code ?? ''}`));
    }
  });

  const worker: PersistentWorker = {
    child,
    nextReqId,
    pending,
    send(action, params) {
      const reqId = worker.nextReqId++;
      return new Promise<BrowserExecuteResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.pending.delete(reqId);
          resolve({
            ok: false,
            error: { kind: 'cdp_timeout', message: `worker action 执行超时（${ACTION_TIMEOUT_MS}ms）` },
          });
        }, ACTION_TIMEOUT_MS);
        worker.pending.set(reqId, {
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        try {
          child.stdin?.write(JSON.stringify({ requestId: reqId, action, params }) + '\n');
        } catch (e) {
          worker.pending.delete(reqId);
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
  };

  return { worker, launchReady };
}

/** 等 child exit（超时 resolve false，调用方 killProcessGroup 兜底） */
export function waitExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    const onExit = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

/** launch 确认帧等待（launchReady 与超时竞速；超时返回 cdp_timeout 错误结果） */
export function launchConfirm(
  launchReady: Promise<BrowserExecuteResult>,
  timeoutMs: number,
): Promise<BrowserExecuteResult> {
  return Promise.race([
    launchReady,
    new Promise<BrowserExecuteResult>((resolve) => {
      setTimeout(
        () => resolve({ ok: false, error: { kind: 'cdp_timeout', message: `launch 确认超时（${timeoutMs}ms）` } }),
        timeoutMs,
      );
    }),
  ]);
}

/**
 * action 执行与 AbortSignal 竞速（对齐 executeOnce abort 语义）：
 * - 无 signal → 直接透传 sendPromise（零开销）
 * - signal abort → onAbort()（调用方 kill instance 防 hang）+ resolve 取消错误
 * - sendPromise 挂 noop catch：abort kill 后 worker exit → pending reject 被 race 吞掉，防 unhandled
 */
export function withAbort(
  signal: AbortSignal | undefined,
  sendPromise: Promise<BrowserExecuteResult>,
  onAbort: () => void,
): Promise<BrowserExecuteResult> {
  if (!signal) return sendPromise;
  sendPromise.catch(() => {
    /* abort kill 后 worker exit reject —— race 已 settle，忽略 */
  });
  return Promise.race([
    sendPromise,
    new Promise<BrowserExecuteResult>((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          onAbort();
          resolve({ ok: false, error: { message: 'browser: 请求已取消（abort）' } });
        },
        { once: true },
      );
    }),
  ]);
}