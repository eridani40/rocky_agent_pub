/**
 * NodeWorkerDriver 单测（白盒，全 mock，绝不 spawn 真 chrome）
 * 参考: states/v0.0.23.1/bugs/BUG-001-browser-connectovercdp-timeout-[reopen].md
 *
 * 覆盖 executeOnce 核心路径：
 *   1. 正常路径：spawn worker → 写 stdin 任务 → 读 stdout JSON → cleanup → {ok,text}
 *   2. worker stdout 非 JSON → {ok:false,error}
 *   3. worker stdout 第一行后的额外输出不影响（只取第一行）
 *   4. worker 异常 exit（非 0）未输出结果 → {ok:false}
 *   5. 超时（30s）→ kill worker + {ok:false,error:kind=cdp_timeout}
 *   6. AbortSignal 已 aborted → 立即 {ok:false} + cleanup
 *   7. AbortSignal 中途 abort → kill worker + {ok:false}
 *   8. stdin 写失败 → {ok:false}
 *   9. worker spawn error → {ok:false}
 *   10. stderr 收集并拼进失败 message
 *   11. cleanup 调 killProcessGroup（进程组 SIGKILL）
 *   12. connect 不支持（应走 executeOnce）
 *
 * FakeWorker 模拟 Bun 精简 ChildProcess（不定义 close，见 memory: bun-playwright-connectovercdp-bug）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// mock node:fs 的 existsSync（resolveWorkerPath 双路径探测用），其余 fs API 保持真实
// vi.hoisted：vi.mock factory 提升到文件顶部执行，真实 existsSync 引用须走 hoisted 容器（防 TDZ）
const hoisted = vi.hoisted(() => ({
  realExistsSync: undefined as unknown as typeof import('node:fs').existsSync,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  hoisted.realExistsSync = actual.existsSync;
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

// mock node:child_process 的 spawn（defaultSpawn 内调用），其余 API 保持真实。
// 既有用例走 spawnDeps.spawn 注入 FakeWorker，不触达 defaultSpawn，故全局 mock spawn 对其无影响。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { existsSync } from 'node:fs';
import { spawn as childProcessSpawn } from 'node:child_process';
import { NodeWorkerDriver, WORKER_TIMEOUT_MS, defaultSpawn } from '../node-worker-driver';
import type { BrowserExecuteResult } from '../types';
import type { ChildProcess } from 'node:child_process';

const existsSyncMock = existsSync as unknown as ReturnType<typeof vi.fn>;
const spawnMock = vi.mocked(childProcessSpawn);

beforeEach(() => {
  // 默认恢复真实 existsSync（不影响文件内其他测试的 fs 行为）；
  // resolveWorkerPath 用例各自显式 mockReturnValue 控制探测结果
  existsSyncMock.mockReset();
  const real = hoisted.realExistsSync;
  existsSyncMock.mockImplementation((...args: Parameters<typeof real>) => real(...args));
});

/**
 * 假 worker 子进程（EventEmitter 风格，模拟 stdin/stdout/stderr/exit）。
 * 测试通过 emitStdout/emitStderr/emitExit 触发事件驱动 executeOnce 完成。
 */
interface FakeWorkerControl {
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  emitExit: (code: number | null, sig: string | null) => void;
  emitError: (e: Error) => void;
  writtenTask: () => string;
  process: ChildProcess;
}

/** 构造 FakeWorker（默认 stdin 可写、stdout/stderr 是 EventEmitter） */
function makeFakeWorker(): FakeWorkerControl {
  const stdoutEE = new EventEmitter();
  const stderrEE = new EventEmitter();
  const ee = new EventEmitter();
  let written = '';

  const stdin = {
    write: (s: string) => {
      written += s;
      return true;
    },
    end: () => {
      /* noop */
    },
  };
  const stdout = Object.assign(stdoutEE, { setEncoding: () => undefined });
  const stderr = Object.assign(stderrEE, { setEncoding: () => undefined });

  // 真 ChildProcess 的最小形态（kill/stdin/stdout/stderr/on + pid）。
  // 不定义 close（模拟 Bun 精简 API，见 memory）。
  const proc = {
    pid: 23456,
    killed: false,
    stdin,
    stdout,
    stderr,
    on: (ev: string, fn: (...a: unknown[]) => void) => ee.on(ev, fn),
    kill: (_sig: string) => true,
  } as unknown as ChildProcess;

  return {
    emitStdout: (s) => stdoutEE.emit('data', s),
    emitStderr: (s) => stderrEE.emit('data', s),
    emitExit: (code, sig) => ee.emit('exit', code, sig),
    emitError: (e) => ee.emit('error', e),
    writtenTask: () => written,
    process: proc,
  };
}

/** driver + holder（holder.fake 在 spawn 发生后填充） */
interface DriverBundle {
  driver: NodeWorkerDriver;
  holder: { fake: FakeWorkerControl | undefined };
}

/** 构造 driver（注入 FakeWorker spawn，端口探测总返空闲） */
function makeDriver(fakeFactory: () => FakeWorkerControl): DriverBundle {
  const holder: { fake: FakeWorkerControl | undefined } = { fake: undefined };
  const driver = new NodeWorkerDriver({
    dataDir: '/tmp/nwd-ut',
    portBusy: async () => false,
    spawnDeps: {
      spawn: () => {
        const f = fakeFactory();
        holder.fake = f;
        return f.process;
      },
    },
  });
  return { driver, holder };
}

/** 等 spawn 发生（executeOnce 内部同步 spawn，下一微任务/定时器即可见） */
async function waitForSpawn(b: DriverBundle): Promise<FakeWorkerControl> {
  await new Promise((r) => setTimeout(r, 10));
  if (!b.holder.fake) throw new Error('spawn 未发生');
  return b.holder.fake;
}

describe('NodeWorkerDriver executeOnce 正常路径', () => {
  it('写任务 JSON 到 stdin，读 stdout 第一行 → {ok,text}，cleanup', async () => {
    const b = makeDriver(makeFakeWorker);
    const promise = b.driver.executeOnce(
      { headless: true },
      'navigate',
      { url: 'https://example.com' },
    );
    const fake = await waitForSpawn(b);
    const task = JSON.parse(fake.writtenTask());
    expect(task.action).toBe('navigate');
    expect(task.params.url).toBe('https://example.com');
    expect(task.persistent).toBe(false);
    expect(typeof task.cdpPort).toBe('number');

    fake.emitStdout(JSON.stringify({ ok: true, text: 'navigated to https://example.com' }) + '\n');
    const r = await promise;
    expect(r.ok).toBe(true);
    expect(r.text).toBe('navigated to https://example.com');
  });

  it('stdout 第一行后的额外输出不影响（只取第一行）', async () => {
    const b = makeDriver(makeFakeWorker);
    const promise = b.driver.executeOnce({ headless: true }, 'snapshot', {});
    const fake = await waitForSpawn(b);
    fake.emitStdout(JSON.stringify({ ok: true, text: 'first' }) + '\n');
    fake.emitStdout('extra line should be ignored\n');
    const r = await promise;
    expect(r.ok).toBe(true);
    expect(r.text).toBe('first');
  });

  it('managed-profile（profileName 给定）→ persistent=true', async () => {
    const b = makeDriver(makeFakeWorker);
    const promise = b.driver.executeOnce({ profileName: 'test-prof' }, 'navigate', {
      url: 'https://a.com',
    });
    const fake = await waitForSpawn(b);
    const task = JSON.parse(fake.writtenTask());
    expect(task.persistent).toBe(true);
    expect(task.userDataDir).toContain('test-prof');
    fake.emitStdout(JSON.stringify({ ok: true, text: 'ok' }) + '\n');
    const r = await promise;
    expect(r.ok).toBe(true);
  });
});

describe('NodeWorkerDriver executeOnce 错误处理', () => {
  it('worker stdout 非 JSON → {ok:false,error}', async () => {
    const b = makeDriver(makeFakeWorker);
    const promise = b.driver.executeOnce({ headless: true }, 'snapshot', {});
    const fake = await waitForSpawn(b);
    fake.emitStdout('not a json line\n');
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('非 JSON');
  });

  it('worker ok:false 结果 → 透传 error', async () => {
    const b = makeDriver(makeFakeWorker);
    const promise = b.driver.executeOnce({ headless: true }, 'click', { ref: 'x' });
    const fake = await waitForSpawn(b);
    fake.emitStdout(
      JSON.stringify({ ok: false, error: { kind: 'unknown', message: 'ref 未找到' } }) + '\n',
    );
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('unknown');
    expect(r.error?.message).toBe('ref 未找到');
  });

  it('worker 异常 exit（未输出结果）→ {ok:false}', async () => {
    const b = makeDriver(makeFakeWorker);
    const promise = b.driver.executeOnce({ headless: true }, 'snapshot', {});
    const fake = await waitForSpawn(b);
    fake.emitExit(1, null);
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('异常退出');
  });

  it('worker spawn error → {ok:false}', async () => {
    const b = makeDriver(makeFakeWorker);
    const promise = b.driver.executeOnce({ headless: true }, 'snapshot', {});
    const fake = await waitForSpawn(b);
    fake.emitError(new Error('ENOENT node'));
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('spawn error');
  });

  it('stderr 收集并拼进失败 message', async () => {
    const b = makeDriver(makeFakeWorker);
    const promise = b.driver.executeOnce({ headless: true }, 'snapshot', {});
    const fake = await waitForSpawn(b);
    fake.emitStderr('chrome crash log line\n');
    fake.emitStderr('another diagnostic\n');
    fake.emitExit(1, null);
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('worker stderr');
    expect(r.error?.message).toContain('another diagnostic');
  });
});

describe('NodeWorkerDriver executeOnce 超时与取消', () => {
  it('AbortSignal 已 aborted → 立即 {ok:false}（取消）', async () => {
    const b = makeDriver(makeFakeWorker);
    const ac = new AbortController();
    ac.abort();
    const r = await b.driver.executeOnce({ headless: true }, 'snapshot', {}, ac.signal);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('取消');
  });

  it('AbortSignal 中途 abort → kill worker 进程组 + {ok:false}', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const b = makeDriver(makeFakeWorker);
      const ac = new AbortController();
      const promise = b.driver.executeOnce({ headless: true }, 'snapshot', {}, ac.signal);
      await waitForSpawn(b);
      ac.abort();
      const r = await promise;
      expect(r.ok).toBe(false);
      // cleanup 调了 killProcessGroup（process.kill(-pid)）
      const groupKill = killSpy.mock.calls.find(([p, s]) => p === -23456 && s === 'SIGKILL');
      expect(groupKill).toBeTruthy();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('超时（WORKER_TIMEOUT_MS）→ kill 进程组 + {ok:false,error.kind=cdp_timeout}', async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const b = makeDriver(makeFakeWorker);
      const promise = b.driver.executeOnce({ headless: true }, 'snapshot', {});
      // fakeTimers 下 setTimeout(10) 不会自动跑，手动推进让 spawn 发生
      await vi.advanceTimersByTimeAsync(20);
      await vi.advanceTimersByTimeAsync(WORKER_TIMEOUT_MS + 100);
      const r = await promise;
      expect(r.ok).toBe(false);
      expect(r.error?.kind).toBe('cdp_timeout');
      expect(r.error?.message).toContain('超时');
      const groupKill = killSpy.mock.calls.find(([p, s]) => p === -23456 && s === 'SIGKILL');
      expect(groupKill).toBeTruthy();
    } finally {
      killSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('NodeWorkerDriver connect 不支持 / stdin 失败', () => {
  it('connect 抛 BrowserError（应走 executeOnce）', async () => {
    const b = makeDriver(makeFakeWorker);
    await expect(b.driver.connect()).rejects.toThrowError(/不支持长 session/);
  });

  it('executeOnce 写 stdin 失败 → {ok:false}（mock stdin write throw）+ cleanup', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const b = makeDriver(() => {
        const ctrl = makeFakeWorker();
        ((ctrl.process.stdin as unknown as { write: () => boolean }).write) = () => {
          throw new Error('EPIPE');
        };
        return ctrl;
      });
      const r = await b.driver.executeOnce({ headless: true }, 'snapshot', {});
      expect(r.ok).toBe(false);
      expect(r.error?.message).toContain('stdin 写失败');
      const groupKill = killSpy.mock.calls.find(([p, s]) => p === -23456 && s === 'SIGKILL');
      expect(groupKill).toBeTruthy();
    } finally {
      killSpy.mockRestore();
    }
  });
});

// [bug C 锁死] resolveWorkerPath 双路径探测：packaged（dist）命中 worker-entry.js（tsc 产物），
// dev（src）退回 browser-worker.cjs（bundle）。此前恒 browser-worker.cjs → packaged spawn ENOENT。
describe('resolveWorkerPath 双路径（bug C）', () => {
  /** 构造 driver，spawn 捕获 workerPath 实参 */
  function makePathCapturingDriver(): DriverBundle & { workerPath: () => string } {
    const holder: { fake: FakeWorkerControl | undefined; path: string } = {
      fake: undefined,
      path: '',
    };
    const driver = new NodeWorkerDriver({
      dataDir: '/tmp/nwd-ut',
      portBusy: async () => false,
      spawnDeps: {
        spawn: (_cmd: string, args: string[]) => {
          holder.path = args[0] ?? '';
          const f = makeFakeWorker();
          holder.fake = f;
          return f.process;
        },
      },
    });
    return { driver, holder, workerPath: () => holder.path };
  }

  it('worker-entry.js 存在（packaged dist 形态）→ spawn 用 worker-entry.js', async () => {
    existsSyncMock.mockReturnValue(true);
    const b = makePathCapturingDriver();
    const promise = b.driver.executeOnce({ headless: true }, 'render', {
      url: 'https://example.com',
    });
    const fake = await waitForSpawn(b);
    expect(b.workerPath()).toMatch(/worker-entry\.js$/);
    expect(b.workerPath()).not.toMatch(/browser-worker\.cjs$/);
    fake.emitStdout(JSON.stringify({ ok: true, text: '<html/>' }) + '\n');
    const r = await promise;
    expect(r.ok).toBe(true);
  });

  it('worker-entry.js 不存在（dev src 形态）→ spawn 退回 browser-worker.cjs', async () => {
    existsSyncMock.mockReturnValue(false);
    const b = makePathCapturingDriver();
    const promise = b.driver.executeOnce({ headless: true }, 'navigate', {
      url: 'https://example.com',
    });
    const fake = await waitForSpawn(b);
    expect(b.workerPath()).toMatch(/browser-worker\.cjs$/);
    fake.emitStdout(JSON.stringify({ ok: true, text: 'ok' }) + '\n');
    const r = await promise;
    expect(r.ok).toBe(true);
  });
});

// defaultSpawn packaged/dev 分支：packaged Electron（server 进程内跑）下用 process.execPath +
// ELECTRON_RUN_AS_NODE=1（纯 node 语义），dev 走原 'node' 不回归（packaged env 无 PATH）。
describe('defaultSpawn packaged/dev 分支选择（packaged ENOENT 修复）', () => {
  /** 假 ChildProcess 占位（defaultSpawn 返回值；不真 spawn） */
  function makeFakeChild(): ChildProcess {
    return { pid: 99001 } as unknown as ChildProcess;
  }

  // 保存 process.versions.electron 原值，afterEach 还原（防污染同文件其他 12 用例）
  // dev（vitest/bun）下默认 undefined；packaged 真机由用户验收（dev 测不到）。
  let savedElectron: string | undefined;
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue(makeFakeChild());
    savedElectron = process.versions.electron;
  });
  afterEach(() => {
    const versions = process.versions as { electron?: string };
    if (savedElectron === undefined) delete versions.electron;
    else versions.electron = savedElectron;
  });

  it('packaged（process.versions.electron 有值）→ spawn(process.execPath, args, { detached:true, env 含 ELECTRON_RUN_AS_NODE=1 })，args 与调用方 env 透传', () => {
    (process.versions as { electron?: string }).electron = '99.0.0';
    const fakeChild = makeFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const workerPath = '/abs/worker-entry.js';
    const opts: Parameters<typeof defaultSpawn>[2] = {
      cwd: '/proj',
      env: { FOO: 'bar' },
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    const r = defaultSpawn('node', [workerPath], opts);

    // 返回值透传（spawn mock 返回的 ChildProcess）
    expect(r).toBe(fakeChild);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, callOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { detached?: boolean; env: NodeJS.ProcessEnv; stdio: unknown },
    ];
    // packaged 替换：cmd = Electron binary 路径，非字面 'node'
    expect(cmd).toBe(process.execPath);
    expect(cmd).not.toBe('node');
    // args 透传不变（仍 [workerPath]）
    expect(args).toEqual([workerPath]);
    // packaged 追加 ELECTRON_RUN_AS_NODE=1，且保留调用方 env（spread 后追加，不覆盖）
    expect(callOpts.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(callOpts.env.FOO).toBe('bar');
    // detached 保留 + stdio 透传
    expect(callOpts.detached).toBe(true);
    expect(callOpts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('dev（process.versions.electron undefined）→ spawn(cmd, args, { detached:true }) 不含 ELECTRON_RUN_AS_NODE（不回归）', () => {
    delete (process.versions as { electron?: string }).electron;
    const fakeChild = makeFakeChild();
    spawnMock.mockReturnValue(fakeChild);

    const workerPath = '/abs/browser-worker.cjs';
    const opts: Parameters<typeof defaultSpawn>[2] = {
      cwd: '/proj',
      env: { BAZ: 'qux' },
      stdio: ['pipe', 'pipe', 'pipe'],
    };
    const r = defaultSpawn('node', [workerPath], opts);

    expect(r).toBe(fakeChild);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, callOpts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { detached?: boolean; env: NodeJS.ProcessEnv; stdio: unknown },
    ];
    // dev 不替换：cmd = 调用方传入的 'node'（PATH 有 node）
    expect(cmd).toBe('node');
    // args 透传不变
    expect(args).toEqual([workerPath]);
    // dev 不追加 ELECTRON_RUN_AS_NODE
    expect(callOpts.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(callOpts.env.BAZ).toBe('qux');
    expect(callOpts.detached).toBe(true);
    expect(callOpts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });
});
