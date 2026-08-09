/**
 * BrowserInstanceManager 单元测试（白盒，全 mock spawn，绝不真启 Chrome）
 * 参考: specs/tech/agent/tools/[P1]browser_instance_manager.md §3/§4/§7
 *       specs/tech/version_logs/v0.0.264/change_plan.md 行 1-2/17-22
 *
 * 覆盖（change_plan 11 类）：
 *   ① launch 幂等（同 key 二次复用不重复 spawn）+ persistInstance 写记录
 *   ② execute 前置校验（无 instance → no_browser_instance）
 *   ③ owner 隔离（其他 session 同 profile → 不可复用）
 *   ④ close 幂等 + 发 close 帧 + headless rmSync + usedPorts.delete + unpersistInstance
 *   ⑤ releaseSession kill 全部 + 幂等 + 三要素清理
 *   ⑥ idle timeout（注入 now → 超时自动 close）
 *   ⑦ worker exit → pending reject + worker_crashed
 *   ⑧ launch 失败透传 profile_in_use + 失败路径端口/目录清理
 *   ⑨ releaseAll 清空全部 + 三要素
 *   ⑩ 开机自检：预置记录 → alive pid killProcessGroup / dead pid 跳过 + headless 目录删除 + 记录清空
 *   ⑪ shutdown hook 注册幂等（标记位）
 *
 * 说明：instance-record 走真实实现（临时 dataDir），persist/unpersist 断言读文件内容
 * （比 mock 更贴近 integration）；node:fs 仅覆写 mkdtempSync（固定 headless 路径）+ rmSync
 * （包装真实实现记录调用）。spawn 注入 FakeWorker（不真启 Chrome）。
 *
 * FakeWorker 模拟 Bun 精简 ChildProcess（不定义 close；stdout/stderr EventEmitter 驱动；
 * 收到 close 帧自动 exit(0)——真实 worker 协议）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { BrowserLaunchOptions, BrowserSession, BrowserConnectOptions, PersistedInstanceRecord } from '../types';
import type { ChromeMcpDriver } from '../chrome-mcp-driver';
import type { ChromeProcInfo, ChromeScanResult } from '../orphan-scan';

// mock node:fs：mkdtempSync 对 headless 前缀返回固定路径（不真建目录）；其余（测试 dataDir）走真实。
// rmSync 包装真实实现（记录调用 + 真删）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    mkdtempSync: vi.fn((prefix: string) => {
      if (prefix.includes('rocky-browser-instance-')) return '/tmp/rocky-browser-instance-ut';
      return actual.mkdtempSync(prefix);
    }),
    rmSync: vi.fn(actual.rmSync),
  };
});

import { BrowserInstanceManager } from '../instance-manager';
import { instanceRecordPath } from '../instance-record';
import { InMemoryModeImplRegistry } from '../mode-impl';
import { WorkerModeImpl } from '../worker-mode-impl';
import { AttachModeImpl } from '../attach-mode-impl';

const rmSyncMock = vi.mocked(rmSync);

/** 进程 kill spy（beforeEach 创建；防真杀当前进程组 + 断言 killProcessGroupByPid） */
let killSpy: MockInstance<(pid: number, signal?: string | number) => boolean> = undefined as never;

/** FakeWorker 控制句柄 */
interface FakeWorkerControl {
  emitStdout: (s: string) => void;
  emitStderr: (s: string) => void;
  emitExit: (code: number | null, sig: string | null) => void;
  writtenTask: () => string;
  process: ChildProcess;
}

/** FakeWorker 进程形状（可写 exitCode/signalCode；返回时 cast ChildProcess） */
interface FakeProc {
  pid: number;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  stdin: { write: (s: string) => boolean; end: () => void };
  stdout: unknown;
  stderr: unknown;
  on: (ev: string, fn: (...a: unknown[]) => void) => unknown;
  once: (ev: string, fn: (...a: unknown[]) => void) => unknown;
  removeListener: (ev: string, fn: (...a: unknown[]) => void) => unknown;
  kill: (sig: string) => boolean;
}

/** 构造 FakeWorker（默认 stdin 可写、stdout/stderr 是 EventEmitter；exitCode 初始 null） */
function makeFakeWorker(): FakeWorkerControl {
  const stdoutEE = new EventEmitter();
  const stderrEE = new EventEmitter();
  const ee = new EventEmitter();
  let written = '';

  const stdin = {
    write: (s: string) => {
      written += s;
      // 真实协议：worker 收到 close 帧 → kill chrome → exit(0)
      if (s.includes('"action":"close"')) {
        setImmediate(() => {
          proc.exitCode = 0;
          ee.emit('exit', 0, null);
        });
      }
      return true;
    },
    end: () => {
      /* noop（keepStdinOpen 模式下不 end） */
    },
  };
  const stdout = Object.assign(stdoutEE, { setEncoding: () => undefined });
  const stderr = Object.assign(stderrEE, { setEncoding: () => undefined });

  const proc: FakeProc = {
    pid: 23456,
    killed: false,
    exitCode: null,
    signalCode: null,
    stdin,
    stdout,
    stderr,
    on: (ev, fn) => ee.on(ev, fn),
    once: (ev, fn) => ee.once(ev, fn),
    removeListener: (ev, fn) => ee.removeListener(ev, fn),
    kill: (_sig) => true,
  };

  return {
    emitStdout: (s) => stdoutEE.emit('data', s),
    emitStderr: (s) => stderrEE.emit('data', s),
    emitExit: (code, sig) => {
      proc.exitCode = code;
      proc.signalCode = sig;
      ee.emit('exit', code, sig);
    },
    writtenTask: () => written,
    process: proc as unknown as ChildProcess,
  };
}

/** 测试临时 dataDir（每个用例独立；instance-record 真实写文件） */
let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'im-ut-'));
  rmSyncMock.mockClear();
  // 防真杀当前进程组（-pid 负组 kill）
  killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
  // 清 shutdown hook（防污染其他用例：移除全局 handler + 重置标记位）
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('beforeExit');
  delete (globalThis as { __browserInstanceManagerShutdownHookRegistered?: boolean })
    .__browserInstanceManagerShutdownHookRegistered;
});

/** 构造 manager（注入 FakeWorker spawn + 空闲端口 + 可控时钟；registry = WorkerModeImpl 两键） */
function makeManager(opts: {
  spawn?: (cmd: string, args: string[]) => ChildProcess;
  now?: () => number;
  idleTimeoutMs?: number;
  reconcileIntervalMs?: number;
  scanProcesses?: () => Promise<ChromeScanResult>;
} = {}) {
  const holder: { fake: FakeWorkerControl | undefined } = { fake: undefined };
  const workerImpl = new WorkerModeImpl({
    spawn:
      opts.spawn ??
      (() => {
        const f = makeFakeWorker();
        holder.fake = f;
        return f.process;
      }),
  });
  const registry = new InMemoryModeImplRegistry([
    ['headless', workerImpl],
    ['managed-profile', workerImpl],
  ]);
  const manager = new BrowserInstanceManager({
    dataDir,
    registry,
    portBusy: async () => false,
    now: opts.now,
    idleTimeoutMs: opts.idleTimeoutMs,
    // 缺省 no-op 扫描（防构造时 fire-and-forget 对账真跑 ps 误回收测试环境其他 chrome）
    scanProcesses: opts.scanProcesses ?? (async () => ({ all: [], candidates: [] })),
    reconcileIntervalMs: opts.reconcileIntervalMs,
  });
  return { manager, holder };
}

/** 等 spawn 发生 */
async function waitForSpawn(holder: { fake: FakeWorkerControl | undefined }): Promise<FakeWorkerControl> {
  await new Promise((r) => setTimeout(r, 10));
  if (!holder.fake) throw new Error('spawn 未发生');
  return holder.fake;
}

/** launch 成功：spawn → launch 确认帧 → ready */
async function launchOk(
  manager: BrowserInstanceManager,
  holder: { fake: FakeWorkerControl | undefined },
  sessionId = 's1',
  opts: BrowserLaunchOptions = { mode: 'headless' },
) {
  const p = manager.launch(sessionId, opts);
  const fake = await waitForSpawn(holder);
  fake.emitStdout(JSON.stringify({ ok: true, text: 'launched' }) + '\n');
  const r = await p;
  return { fake, r };
}

/** 读实例记录文件（断言 persist/unpersist） */
function readRecords(): PersistedInstanceRecord[] {
  const file = instanceRecordPath(dataDir);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')) as PersistedInstanceRecord[];
}

describe('launch 幂等 + persistInstance', () => {
  it('launch 成功 → 写 launch 帧（loop:true 常驻 + keepStdinOpen 不 end）+ ready + 记录落盘', async () => {
    const { manager, holder } = makeManager();
    const { fake, r } = await launchOk(manager, holder);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('launched');
    // launch 帧：loop:true（常驻循环标记）；persistent=false（headless 连接模式）
    const task = JSON.parse(fake.writtenTask().trim().split('\n')[0]!);
    expect(task.loop).toBe(true);
    expect(task.persistent).toBe(false);
    expect(task.headless).toBe(true);
    expect(task.cdpPort).toBe(18800);
    // keepStdinOpen：写 launch 帧后 stdin 未 end（后续 action 行仍可写）
    expect(fake.writtenTask().trim().split('\n').length).toBe(1);
    // persistInstance 已写记录（key = sessionId:mode；workerPid = 锚点）
    const records = readRecords();
    expect(records.length).toBe(1);
    expect(records[0]!.key).toBe('s1:headless');
    expect(records[0]!.workerPid).toBe(23456);
  });

  it('同 key 二次 launch → 复用（不重复 spawn）+ 记录不重复写', async () => {
    const { manager, holder } = makeManager();
    await launchOk(manager, holder);
    const spawnCount = holder.fake ? 1 : 0;
    const r2 = await manager.launch('s1', { mode: 'headless' });
    expect(r2.ok).toBe(true);
    expect(r2.text).toContain('reuse');
    expect(readRecords().length).toBe(1); // 未重复写记录
    expect(holder.fake ? 1 : 0).toBe(spawnCount); // spawn 未再次发生
  });

  it('launch managed-profile → loop:true 常驻 + persistent:true 连接模式（ensureProfileFree）', async () => {
    const { manager, holder } = makeManager();
    const p = manager.launch('s1', { mode: 'managed-profile', profileName: 'p1' });
    const fake = await waitForSpawn(holder);
    fake.emitStdout(JSON.stringify({ ok: true, text: 'launched' }) + '\n');
    const r = await p;
    expect(r.ok).toBe(true);
    const task = JSON.parse(fake.writtenTask().trim().split('\n')[0]!);
    expect(task.loop).toBe(true); // 常驻循环
    expect(task.persistent).toBe(true); // managed-profile → ensureProfileFree
    expect(task.headless).toBeUndefined(); // managed-profile 非 headless
  });
});

describe('execute 前置校验 + owner 隔离', () => {
  it('无 instance 调 execute → no_browser_instance + 提示先 launch', async () => {
    const { manager } = makeManager();
    const r = await manager.execute('s1', { mode: 'headless' }, 'navigate', { url: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('no_browser_instance');
    expect(r.error?.message).toContain('请先调用 browser(action="launch")');
  });

  it('owner 隔离：其他 session 同 profile → 不可复用（no_browser_instance）', async () => {
    const { manager, holder } = makeManager();
    await launchOk(manager, holder, 's1', { mode: 'managed-profile', profileName: 'p1' });
    const r = await manager.execute(
      's2',
      { mode: 'managed-profile', profileName: 'p1' },
      'navigate',
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('no_browser_instance');
  });
});

describe('execute 正常路径（requestId 路由）', () => {
  it('execute → worker.send 写 {requestId,action,params} → stdout 响应路由回对应 pending', async () => {
    const { manager, holder } = makeManager();
    await launchOk(manager, holder);
    const fake = holder.fake!;
    const p = manager.execute('s1', { mode: 'headless' }, 'navigate', { url: 'https://a.com' });
    await new Promise((r) => setTimeout(r, 10));
    const lines = fake.writtenTask().trim().split('\n');
    const reqLine = JSON.parse(lines[lines.length - 1]!);
    expect(reqLine.action).toBe('navigate');
    expect(reqLine.params.url).toBe('https://a.com');
    expect(typeof reqLine.requestId).toBe('number');
    fake.emitStdout(JSON.stringify({ requestId: reqLine.requestId, ok: true, text: 'navigated' }) + '\n');
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.text).toBe('navigated');
  });
});

describe('execute abort 语义（signal 参数）', () => {
  it('signal.aborted 前置 → 立即返回取消错误，不启动 action 不 kill', async () => {
    const { manager, holder } = makeManager();
    await launchOk(manager, holder);
    const fake = holder.fake!;
    const writtenBefore = fake.writtenTask().trim().split('\n').length;
    const ac = new AbortController();
    ac.abort(); // 已取消
    const r = await manager.execute('s1', { mode: 'headless' }, 'navigate', { url: 'x' }, { signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('abort');
    expect(fake.writtenTask().trim().split('\n').length).toBe(writtenBefore); // 未发 action 帧
    expect(manager.size).toBe(1); // 实例未被 kill
  });

  it('execute 中 abort 事件 → kill instance（防 hang）+ 返回取消错误 + 泄漏防护清理', async () => {
    const { manager, holder } = makeManager();
    await launchOk(manager, holder);
    const fake = holder.fake!;
    const ac = new AbortController();
    const p = manager.execute(
      's1',
      { mode: 'headless' },
      'navigate',
      { url: 'https://a.com' },
      { signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 10));
    // 已发 action 帧（worker 未响应 → pending 挂着）
    const lines = fake.writtenTask().trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]!).action).toBe('navigate');
    // abort → 立即返回取消错误（不等 30s cdp_timeout）+ kill instance 防 hang
    ac.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('abort');
    // 泄漏防护四要素：kill 进程组（负 pid）+ headless 目录 + 记录删除 + 实例删除
    await new Promise((r2) => setTimeout(r2, 20)); // 等 closeInstance 异步清理
    expect(killSpy).toHaveBeenCalledWith(-23456, 'SIGKILL');
    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/rocky-browser-instance-ut', {
      recursive: true,
      force: true,
    });
    expect(readRecords().length).toBe(0);
    expect(manager.size).toBe(0);
  });
});

describe('close 幂等 + 三要素清理', () => {
  it('close → 发 close 帧 + 等 exit + headless rmSync + 记录删除 + 删条目', async () => {
    const { manager, holder } = makeManager();
    await launchOk(manager, holder);
    const fake = holder.fake!;
    const p = manager.close('s1', { mode: 'headless' });
    // 等 close 帧写入 + worker 自动 exit（FakeWorker 协议）
    await new Promise((r) => setTimeout(r, 20));
    const lines = fake.writtenTask().trim().split('\n');
    const closeLine = JSON.parse(lines[lines.length - 1]!);
    expect(closeLine.action).toBe('close');
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.text).toBe('closed');
    // 三要素：headless 目录删除 + 记录删除
    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/rocky-browser-instance-ut', {
      recursive: true,
      force: true,
    });
    expect(readRecords().length).toBe(0);
    expect(manager.size).toBe(0);
  });

  it('close 幂等：无 instance → no instance（不报错）', async () => {
    const { manager } = makeManager();
    const r = await manager.close('s1', { mode: 'headless' });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('no instance');
  });

  it('close 释放端口：再次 launch 复用同端口（usedPorts.delete 生效）', async () => {
    const { manager, holder } = makeManager();
    await launchOk(manager, holder);
    await manager.close('s1', { mode: 'headless' });

    // 二次 launch → 端口复用 18800（usedPorts 已 delete）
    const p2 = manager.launch('s1', { mode: 'headless' });
    await new Promise((r) => setTimeout(r, 10));
    const fake2 = holder.fake!;
    fake2.emitStdout(JSON.stringify({ ok: true, text: 'launched' }) + '\n');
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    const task2 = JSON.parse(fake2.writtenTask().trim().split('\n')[0]!);
    expect(task2.cdpPort).toBe(18800);
  });
});

describe('releaseSession / releaseAll', () => {
  it('releaseSession kill 该 session 全部 instance（key 前缀匹配）+ 幂等', async () => {
    const { manager, holder } = makeManager();
    await launchOk(manager, holder, 's1', { mode: 'headless' });
    await launchOk(manager, holder, 's1', { mode: 'managed-profile', profileName: 'p1' });
    // 其他 session 实例不受影响
    await launchOk(manager, holder, 's2', { mode: 'headless' });
    expect(manager.size).toBe(3);

    await manager.releaseSession('s1');
    expect(manager.size).toBe(1); // 只剩 s2
    const records = readRecords();
    expect(records.map((r) => r.key).sort()).toEqual(['s2:headless']);

    // 幂等：再 releaseSession 无副作用
    await manager.releaseSession('s1');
    expect(manager.size).toBe(1);
  });

  it('releaseAll 清空全部 + 三要素清理', async () => {
    const { manager, holder } = makeManager();
    await launchOk(manager, holder, 's1', { mode: 'headless' });
    await launchOk(manager, holder, 's2', { mode: 'headless' });
    expect(manager.size).toBe(2);

    await manager.releaseAll();
    expect(manager.size).toBe(0);
    expect(readRecords().length).toBe(0);
    // headless 目录全删（每个 close 一次 rmSync）
    expect(rmSyncMock).toHaveBeenCalledTimes(2);
  });
});

describe('idle timeout（lazy check）', () => {
  it('execute 时 now-lastUsedAt > idleTimeoutMs → 自动 close + idle_timeout + 提示重新 launch', async () => {
    let now = 1_000;
    const { manager, holder } = makeManager({ now: () => now, idleTimeoutMs: 15_000 });
    await launchOk(manager, holder);
    // 正常 execute（未超时）→ emit 响应
    const fake = holder.fake!;
    const p1 = manager.execute('s1', { mode: 'headless' }, 'navigate', { url: 'x' });
    await new Promise((r) => setTimeout(r, 10));
    const lines = fake.writtenTask().trim().split('\n');
    const reqLine = JSON.parse(lines[lines.length - 1]!);
    fake.emitStdout(JSON.stringify({ requestId: reqLine.requestId, ok: true, text: 'ok' }) + '\n');
    expect((await p1).ok).toBe(true);

    // 时钟推进超 idle → execute → 自动 close + idle_timeout
    now = 1_000 + 15_001;
    const r2 = await manager.execute('s1', { mode: 'headless' }, 'navigate', { url: 'x' });
    expect(r2.ok).toBe(false);
    expect(r2.error?.kind).toBe('idle_timeout');
    expect(r2.error?.message).toContain('请重新 launch');
    // 已自动 close（实例删除 + 记录删除）
    expect(manager.size).toBe(0);
    expect(readRecords().length).toBe(0);
  });
});

describe('worker 崩溃 / launch 失败', () => {
  it('worker exit（崩溃）→ pending reject → worker_crashed + close 清理', async () => {
    const { manager, holder } = makeManager();
    await launchOk(manager, holder);
    const fake = holder.fake!;
    const p = manager.execute('s1', { mode: 'headless' }, 'navigate', { url: 'x' });
    await new Promise((r) => setTimeout(r, 10));
    fake.emitExit(1, null);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('worker_crashed');
    expect(r.error?.message).toContain('请重新 launch');
    expect(manager.size).toBe(0);
  });

  it('launch 失败（launch 帧 ok:false）→ 原样透传 kind（profile_in_use）+ 失败路径端口/目录清理', async () => {
    const { manager, holder } = makeManager();
    const p = manager.launch('s1', { mode: 'headless' });
    const fake = await waitForSpawn(holder);
    fake.emitStdout(
      JSON.stringify({ ok: false, error: { kind: 'profile_in_use', message: 'profile x 被占用' } }) + '\n',
    );
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('profile_in_use');
    expect(r.error?.message).toContain('profile x 被占用');
    // 失败路径：headless 目录清理 + 记录不落 + 端口释放
    expect(rmSyncMock).toHaveBeenCalled();
    expect(readRecords().length).toBe(0);
    expect(manager.size).toBe(0);
    // 端口释放：再次 launch 复用 18800
    const p2 = manager.launch('s1', { mode: 'headless' });
    await new Promise((r) => setTimeout(r, 10));
    const fake2 = holder.fake!;
    fake2.emitStdout(JSON.stringify({ ok: true, text: 'launched' }) + '\n');
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    const task2 = JSON.parse(fake2.writtenTask().trim().split('\n')[0]!);
    expect(task2.cdpPort).toBe(18800);
  });
});

describe('开机自检（残留清理）', () => {
  /** 预置记录文件 */
  function seedRecords(recs: PersistedInstanceRecord[]): void {
    writeFileSync(instanceRecordPath(dataDir), JSON.stringify(recs, null, 2), 'utf8');
  }

  it('构造时：alive pid → killProcessGroup + headless 目录删除 + 记录清空', async () => {
    seedRecords([
      {
        key: 's1:headless',
        mode: 'headless',
        userDataDir: '/tmp/orphan-ut',
        cdpPort: 18801,
        workerPid: process.pid, // 当前进程 = alive
        createdAt: 0,
      },
    ]);
    makeManager();
    // alive → killProcessGroup（负 pid 进程组 SIGKILL）
    const groupKill = killSpy.mock.calls.find(([p, s]) => p === -process.pid && s === 'SIGKILL');
    expect(groupKill).toBeTruthy();
    // headless 目录删除 + 记录清空
    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/orphan-ut', { recursive: true, force: true });
    expect(readRecords().length).toBe(0);
  });

  it('构造时：dead pid → 不 kill（仅删 headless 目录 + 记录）', () => {
    seedRecords([
      {
        key: 's1:headless',
        mode: 'headless',
        userDataDir: '/tmp/orphan-ut',
        cdpPort: 18801,
        workerPid: 99999, // 不存在 → ESRCH → dead
        createdAt: 0,
      },
    ]);
    // isPidAlive 真实实现调 process.kill(pid,0)：对 99999 模拟 ESRCH（进程不存在）
    killSpy.mockImplementation((pid: number) => {
      if (pid === 99999) {
        const e = new Error('ESRCH') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        throw e;
      }
      return true;
    });
    makeManager();
    const groupKill = killSpy.mock.calls.find(([p, s]) => p === -99999);
    expect(groupKill).toBeUndefined(); // dead 不 kill
    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/orphan-ut', { recursive: true, force: true });
    expect(readRecords().length).toBe(0);
  });

  it('managed-profile 记录 → 不删用户数据目录（仅 kill + 删记录）', () => {
    seedRecords([
      {
        key: 's1:managed-profile:p1',
        mode: 'managed-profile',
        profileName: 'p1',
        userDataDir: `${dataDir}/browser/p1/user-data`,
        cdpPort: 18802,
        workerPid: process.pid,
        createdAt: 0,
      },
    ]);
    makeManager();
    expect(rmSyncMock).not.toHaveBeenCalled(); // 不删用户数据
    expect(readRecords().length).toBe(0);
  });
});

describe('shutdown hook 注册幂等', () => {
  it('构造注册 beforeExit + SIGTERM + SIGINT；二次构造不重复挂载（模块级标记位）', () => {
    const countSigterm = () => process.listenerCount('SIGTERM');
    const countSigint = () => process.listenerCount('SIGINT');
    const countBeforeExit = () => process.listenerCount('beforeExit');

    const before0 = { sigterm: countSigterm(), sigint: countSigint(), beforeExit: countBeforeExit() };
    makeManager();
    const after1 = { sigterm: countSigterm(), sigint: countSigint(), beforeExit: countBeforeExit() };
    expect(after1.sigterm).toBe(before0.sigterm + 1);
    expect(after1.sigint).toBe(before0.sigint + 1);
    expect(after1.beforeExit).toBe(before0.beforeExit + 1);

    // 二次构造（标记位已设）→ listener 不再增加
    makeManager();
    const after2 = { sigterm: countSigterm(), sigint: countSigint(), beforeExit: countBeforeExit() };
    expect(after2.sigterm).toBe(after1.sigterm);
    expect(after2.sigint).toBe(after1.sigint);
    expect(after2.beforeExit).toBe(after1.beforeExit);
  });
});

describe('reconcile 对账（孤儿 chrome 回收 + 不误杀）', () => {
  /** 构造 rocky chrome 进程描述（ppid=1 默认真孤儿形态） */
  function mkChrome(pid: number, ppid: number, userDataDir?: string): ChromeProcInfo {
    return {
      pid,
      ppid,
      cmdline: `--user-data-dir=${userDataDir ?? '/tmp/rocky-browser-instance-x'} --remote-debugging-port=18801`,
      userDataDir: userDataDir ?? '/tmp/rocky-browser-instance-x',
    };
  }
  /** worker-entry node 进程（launch 中 worker 形态；cmdline 无 rocky marker） */
  function mkWorkerEntry(pid: number): ChromeProcInfo {
    return { pid, ppid: 1, cmdline: `node .../worker-entry.js (pid ${pid})`, userDataDir: null };
  }
  /**
   * 构造真实形态 scan 结果（模拟生产 scanRockyChromeProcesses 双段）：
   * all = 全量进程表（candidates + extraAll 如 worker-entry node 进程）；
   * candidates = 仅 marker chrome（worker-entry 不在候选——生产同形态，禁止手动塞进候选）。
   */
  function mkScan(candidates: ChromeProcInfo[], extraAll: ChromeProcInfo[] = []): ChromeScanResult {
    return { all: [...candidates, ...extraAll], candidates };
  }

  it('① launch 确认帧带 chromePid → handle 存储 + 记录持久化；活跃 chromePid 不回收（不误杀）', async () => {
    let launched = false;
    const { manager, holder } = makeManager({
      reconcileIntervalMs: 20,
      // launch 前扫描空（构造时 reconcile 不误判）；launch 后报活跃 chrome 555
      scanProcesses: async () => (launched ? mkScan([mkChrome(555, 1)]) : mkScan([])),
    });
    const p = manager.launch('s1', { mode: 'headless' });
    const fake = await waitForSpawn(holder);
    fake.emitStdout(JSON.stringify({ ok: true, text: 'launched', chromePid: 555 }) + '\n');
    expect((await p).ok).toBe(true);
    launched = true;
    // chromePid 上报链路：handle.chromePid + 记录持久化
    expect(readRecords()[0]!.chromePid).toBe(555);

    // 等周期 interval 触发 reconcile：555 活跃（chromePidSet 命中）→ 不回收
    await new Promise((r) => setTimeout(r, 60));
    const orphanKill = killSpy.mock.calls.find(([pid]) => pid === -555);
    expect(orphanKill).toBeUndefined(); // 不误杀活跃实例
    expect(manager.size).toBe(1);
    expect(rmSyncMock).not.toHaveBeenCalled();
    manager.stopReconcileInterval();
  });

  it('周期 interval：短间隔触发 reconcile；活跃 chrome 不回收；孤儿 chrome 被回收', async () => {
    let calls = 0;
    let scanResult: ChromeScanResult = mkScan([]);
    const { manager, holder } = makeManager({
      reconcileIntervalMs: 20,
      scanProcesses: async () => {
        calls += 1;
        return scanResult;
      },
    });
    // launch 活跃实例（chromePid=555）
    const p = manager.launch('s1', { mode: 'headless' });
    const fake = await waitForSpawn(holder);
    fake.emitStdout(JSON.stringify({ ok: true, text: 'launched', chromePid: 555 }) + '\n');
    expect((await p).ok).toBe(true);

    // 扫描结果 = 活跃 chrome 555 → 不回收
    scanResult = mkScan([mkChrome(555, 1)]);
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toBeGreaterThan(0);
    expect(manager.size).toBe(1); // 555 活跃未回收

    // 扫描结果变为孤儿 chrome 888（ppid=1 无 worker-entry）→ 周期对账回收
    scanResult = mkScan([mkChrome(888, 1, '/tmp/rocky-browser-instance-orphan')]);
    await new Promise((r) => setTimeout(r, 60));
    const orphanKill = killSpy.mock.calls.find(([pid]) => pid === -888);
    expect(orphanKill).toBeTruthy(); // kill 孤儿 chrome 进程组
    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/rocky-browser-instance-orphan', {
      recursive: true,
      force: true,
    });
    manager.stopReconcileInterval();
  });

  it('② ppid ∈ 活跃 workerPidSet（旧 worker 无 chromePid 兼容）→ 不回收（不误杀）', async () => {
    let launched = false;
    const { manager, holder } = makeManager({
      reconcileIntervalMs: 20,
      // launch 后报 chrome 666（ppid=23456 = 真实 workerPid）
      scanProcesses: async () => (launched ? mkScan([mkChrome(666, 23456)]) : mkScan([])),
    });
    const p = manager.launch('s1', { mode: 'headless' });
    const fake = await waitForSpawn(holder);
    fake.emitStdout(JSON.stringify({ ok: true, text: 'launched' }) + '\n'); // 无 chromePid（旧兼容）
    expect((await p).ok).toBe(true);
    launched = true;
    expect(readRecords()[0]!.chromePid).toBeUndefined(); // 旧记录无 chromePid

    await new Promise((r) => setTimeout(r, 60));
    const orphanKill = killSpy.mock.calls.find(([pid]) => pid === -666);
    expect(orphanKill).toBeUndefined(); // ppid∈workerPidSet → 活跃不误杀
    expect(manager.size).toBe(1);
    manager.stopReconcileInterval();
  });

  it('③ ppid cmdline 含 worker-entry（launch 中保护）→ 不回收（不误杀）', async () => {
    // 真实形态：candidates 只含 marker chrome 888（ppid=777 worker-entry）；
    // worker-entry node 进程 777 在 all（procByPid 反查数据源）但不在 candidates（不被回收）
    const { manager } = makeManager({
      scanProcesses: async () => mkScan([mkChrome(888, 777, '/tmp/rocky-browser-instance-launching')], [mkWorkerEntry(777)]),
    });
    await new Promise((r) => setTimeout(r, 20));
    const orphanKill = killSpy.mock.calls.find(([pid]) => pid === -888);
    expect(orphanKill).toBeUndefined(); // launch 中 worker 的子 chrome 不误杀
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it('④ 真孤儿（ppid=1 无 worker-entry / 无记录）→ 回收 kill + 删目录', async () => {
    const { manager } = makeManager({
      scanProcesses: async () => mkScan([mkChrome(999, 1, '/tmp/rocky-browser-instance-orphan2')]),
    });
    await new Promise((r) => setTimeout(r, 20));
    const orphanKill = killSpy.mock.calls.find(([pid]) => pid === -999);
    expect(orphanKill).toBeTruthy();
    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/rocky-browser-instance-orphan2', {
      recursive: true,
      force: true,
    });
  });

  it('孤儿回收 + 记录同步：孤儿 chrome 目录匹配记录 → unpersist', async () => {
    writeFileSync(
      instanceRecordPath(dataDir),
      JSON.stringify([
        {
          key: 's1:headless',
          mode: 'headless',
          userDataDir: '/tmp/rocky-browser-instance-orphan3',
          cdpPort: 18805,
          workerPid: 12345,
          createdAt: 0,
        },
      ]),
    );
    const { manager } = makeManager({
      scanProcesses: async () => mkScan([mkChrome(999, 1, '/tmp/rocky-browser-instance-orphan3')]),
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(killSpy.mock.calls.find(([pid]) => pid === -999)).toBeTruthy();
    expect(readRecords().length).toBe(0); // 记录已同步清除
  });

  it('worker-entry 进程本身（ppid=1 无 marker）不在 candidates → 不被回收', async () => {
    // 生产形态：worker-entry node 进程在 all（供反查）但不在 candidates（cmdline 无 marker）
    // → 即使 ppid=1 也不会被 kill（回收循环只遍历 candidates）
    const { manager } = makeManager({
      scanProcesses: async () => mkScan([], [mkWorkerEntry(777)]),
    });
    await new Promise((r) => setTimeout(r, 20));
    const workerKill = killSpy.mock.calls.find(([pid]) => pid === -777);
    expect(workerKill).toBeUndefined(); // worker-entry 不被回收
  });

  it('reconcileIntervalMs=0 → 不启动周期 timer（stopReconcileInterval 幂等）', async () => {
    const { manager } = makeManager({ reconcileIntervalMs: 0, scanProcesses: async () => mkScan([]) });
    manager.stopReconcileInterval(); // 幂等 no-op
    expect(manager.size).toBe(0);
  });

  it('扫描抛错 → 仅 warn 不抛（best-effort）', async () => {
    const { manager } = makeManager({
      scanProcesses: async () => { throw new Error('ps 失败'); },
      reconcileIntervalMs: 20,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(manager.size).toBe(0); // 不炸
    manager.stopReconcileInterval();
  });
});

describe('attach 生命周期（v0.0.266 T3：registry 分发，execute 正确路由 AttachModeImpl）', () => {
  /** mock ChromeMcpDriver（attachDriver）：connect/disconnect/session 方法记录调用 */
  function makeAttachDriver(connectResult: 'success' | 'fail' = 'success') {
    const fakeSession: BrowserSession = {
      listPages: vi.fn(async () => []),
      selectPage: vi.fn(async () => {}),
      navigate: vi.fn(async () => {}),
      snapshot: vi.fn(async () => ({ snapshot: '', refs: {} })),
      click: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      evaluate: vi.fn(async () => undefined),
      close: vi.fn(async () => {}),
    };
    return {
      connect: vi.fn(async (opts?: BrowserConnectOptions): Promise<BrowserSession> => {
        if (connectResult === 'fail') throw new Error('ECONNREFUSED 9222');
        return fakeSession;
      }),
      disconnect: vi.fn(async (_opts?: BrowserConnectOptions): Promise<void> => {}),
      fakeSession,
    };
  }

  /** 构造带 attachDriver + isAttachEnabled 的 manager（registry = AttachModeImpl 键） */
  function makeAttachManager(opts: {
    connectResult?: 'success' | 'fail';
    enabled?: boolean;
  } = {}) {
    const driver = makeAttachDriver(opts.connectResult ?? 'success');
    const registry = new InMemoryModeImplRegistry([['attach', new AttachModeImpl()]]);
    const manager = new BrowserInstanceManager({
      dataDir,
      registry,
      portBusy: async () => false,
      attachDriver: driver as unknown as ChromeMcpDriver,
      isAttachEnabled: () => opts.enabled ?? true,
      scanProcesses: async () => ({ all: [], candidates: [] }), // 测试环境 no-op（防真 ps EPERM 噪音）
    });
    return { manager, driver };
  }

  it('launch attach → driver.connect 调 1 次 + ready（经 execute 可达 session）；不持久化', async () => {
    const { manager, driver } = makeAttachManager();
    const r = await manager.launch('sA', { mode: 'attach' });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('launched');
    expect(driver.connect).toHaveBeenCalledTimes(1);
    expect(readRecords().length).toBe(0); // attach 不持久化
    const er = await manager.execute('sA', { mode: 'attach' }, 'listPages', {}, {});
    expect(er.ok).toBe(true);
    expect(driver.fakeSession.listPages).toHaveBeenCalledTimes(1);
  });

  it('launch attach 幂等：ready 复用，driver.connect 不再调', async () => {
    const { manager, driver } = makeAttachManager();
    await manager.launch('sA', { mode: 'attach' });
    const r2 = await manager.launch('sA', { mode: 'attach' });
    expect(r2.ok).toBe(true);
    expect(r2.text).toContain('reuse');
    expect(driver.connect).toHaveBeenCalledTimes(1);
  });

  it('launch attach switch=off → not_enabled；driver.connect 未调', async () => {
    const { manager, driver } = makeAttachManager({ enabled: false });
    const r = await manager.launch('sA', { mode: 'attach' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('not_enabled');
      expect(r.error?.message).toContain('未启用');
    }
    expect(driver.connect).not.toHaveBeenCalled();
    expect(manager.size).toBe(0);
  });

  it('launch attach attachDriver 缺省 → attach_failed（fail-closed）', async () => {
    const registry = new InMemoryModeImplRegistry([['attach', new AttachModeImpl()]]);
    const manager = new BrowserInstanceManager({
      dataDir,
      registry,
      portBusy: async () => false,
      // 不注入 attachDriver
      scanProcesses: async () => ({ all: [], candidates: [] }), // 测试环境 no-op（防真 ps EPERM 噪音）
    });
    const r = await manager.launch('sA', { mode: 'attach' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_failed');
    }
  });

  it('launch attach connect 失败 → attach_failed + 不落 map（size=0）', async () => {
    const { manager, driver } = makeAttachManager({ connectResult: 'fail' });
    const r = await manager.launch('sA', { mode: 'attach' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_failed');
      expect(r.error?.message).toContain('ECONNREFUSED');
    }
    expect(manager.size).toBe(0);
  });

  it('execute attach → 经 registry 正确路由 AttachModeImpl（M1 防御分支下线）', async () => {
    const { manager, driver } = makeAttachManager();
    await manager.launch('sA', { mode: 'attach' });
    const r = await manager.execute('sA', { mode: 'attach' }, 'navigate', { url: 'https://x' }, {});
    expect(r.ok).toBe(true);
    expect(r.text).toContain('navigated');
    expect(driver.fakeSession.navigate).toHaveBeenCalledWith('https://x');
    expect(manager.size).toBe(1); // 正常路径不误伤实例
    expect(driver.disconnect).not.toHaveBeenCalled();
  });

  it('execute attach 失活 → attach_lost + manager 删表（失活自愈下沉 impl）', async () => {
    const { manager, driver } = makeAttachManager();
    await manager.launch('sA', { mode: 'attach' });
    driver.fakeSession.listPages = vi.fn(async () => {
      throw new Error('connection closed');
    });
    const r = await manager.execute('sA', { mode: 'attach' }, 'listPages', {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_lost');
      expect(r.error?.message).toContain('连接已断开');
    }
    expect(driver.disconnect).toHaveBeenCalledTimes(1); // manager 收尾 close（disconnect 语义）
    expect(manager.size).toBe(0);
  });

  it('close attach → driver.disconnect 调 + 删条目；不杀 chrome/不删目录/不释放端口/不持久化', async () => {
    const { manager, driver } = makeAttachManager();
    await manager.launch('sA', { mode: 'attach' });
    const r = await manager.close('sA', { mode: 'attach' });
    expect(r.ok).toBe(true);
    expect(driver.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.size).toBe(0);
    expect(readRecords().length).toBe(0); // 无记录可清
  });

  it('close attach 幂等：重复 close → no instance，disconnect 不再调', async () => {
    const { manager, driver } = makeAttachManager();
    await manager.launch('sA', { mode: 'attach' });
    await manager.close('sA', { mode: 'attach' });
    const r2 = await manager.close('sA', { mode: 'attach' });
    expect(r2.ok).toBe(true);
    expect(r2.text).toContain('no instance');
    expect(driver.disconnect).toHaveBeenCalledTimes(1);
  });

  it('releaseSession 释放 attach（session 删除兜底）', async () => {
    const { manager, driver } = makeAttachManager();
    await manager.launch('sA', { mode: 'attach' });
    await manager.releaseSession('sA');
    expect(driver.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.size).toBe(0);
  });
});