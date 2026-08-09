/**
 * WorkerModeImpl 单元测试（白盒，全 mock spawn/env，绝不真启 Chrome）
 * 参考: specs/tech/version_logs/v0.0.266/change_plan.md Delta（registry 重构：worker 用例迁移）
 *       specs/tech/agent/tools/[P1]browser_instance_manager.md §3/§4（worker-based 生命周期）
 *
 * 覆盖（从 instance-manager.test.ts 迁移，保持覆盖度）：
 *   ① launch headless：mkdtemp + spawn task（headless flag/loop/persistent=false）+ confirm + persist
 *   ② launch managed-profile：resolveUserDataDir + persistent=true + profileName
 *   ③ launch 失败：launch 帧 ok:false（profile_in_use）透传 + 失败路径清理（headless rm + 端口释放）
 *   ④ execute：worker.send 写 {requestId,action,params} + stdout 响应路由回对应 pending
 *   ⑤ execute cdp_timeout → 置 dead
 *   ⑥ execute abort（signal 前置 + 中 abort 置 dead）
 *   ⑦ execute worker 崩溃（exit → reject）→ worker_crashed + 置 dead
 *   ⑧ execute screenshot → decode base64 + ctx.snapshot.save + 路径文本
 *   ⑨ close：close 帧 + killProcessGroup + headless rmSync + releasePort + unpersist + 幂等
 *   ⑩ cleanupOrphan：alive pid kill + headless 删目录 + 删记录
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { BrowserLaunchOptions, PersistedInstanceRecord } from '../types';
import type { ModeImplEnv } from '../mode-impl';
import { WorkerModeImpl, type WorkerHandle } from '../worker-mode-impl';
import { instanceRecordPath } from '../instance-record';

// mock node:fs：mkdtempSync 对 headless 前缀返回固定路径（不真建目录）；其余（测试 dataDir）走真实。
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

const rmSyncMock = vi.mocked(rmSync);

/** FakeWorker 控制句柄 */
interface FakeWorkerControl {
  emitStdout: (s: string) => void;
  emitExit: (code: number | null, sig: string | null) => void;
  writtenTask: () => string;
  process: ChildProcess;
}

/** FakeWorker 进程形状（可写 exitCode/signalCode；返回时 cast ChildProcess） */
interface FakeProc {
  pid: number;
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
    emitExit: (code, sig) => {
      proc.exitCode = code;
      proc.signalCode = sig;
      ee.emit('exit', code, sig);
    },
    writtenTask: () => written,
    process: proc as unknown as ChildProcess,
  };
}

/** 测试临时 dataDir（instance-record 真实写文件） */
let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'worker-impl-ut-'));
  rmSyncMock.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

/** mock env（allocatePort 固定 18800；releasePort 记录调用） */
function makeEnv(over: Partial<ModeImplEnv> = {}): ModeImplEnv & { releasePort: ReturnType<typeof vi.fn> } {
  const releasePort = vi.fn();
  return {
    dataDir,
    now: () => 1_000,
    allocatePort: async () => 18_800,
    releasePort,
    ...over,
  } as ModeImplEnv & { releasePort: ReturnType<typeof vi.fn> };
}

/** 构造 impl（注入 FakeWorker spawn） */
function makeImpl() {
  const holder: { fake: FakeWorkerControl | undefined } = { fake: undefined };
  const impl = new WorkerModeImpl({
    spawn: () => {
      const f = makeFakeWorker();
      holder.fake = f;
      return f.process;
    },
  });
  return { impl, holder };
}

/** launch 成功 helper：等 spawn → emit launch 确认帧 → 返回 handle */
async function launchOk(
  impl: WorkerModeImpl,
  holder: { fake: FakeWorkerControl | undefined },
  env: ModeImplEnv,
  opts: BrowserLaunchOptions = { mode: 'headless' },
  key = 's1:headless',
) {
  const p = impl.launch(key, opts, env);
  const fake = await new Promise<FakeWorkerControl>((resolve) => {
    setTimeout(() => resolve(holder.fake!), 10);
  });
  fake.emitStdout(JSON.stringify({ ok: true, text: 'launched' }) + '\n');
  const r = await p;
  return { fake, r };
}

/** 读实例记录文件 */
function readRecords(): PersistedInstanceRecord[] {
  const file = instanceRecordPath(dataDir);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')) as PersistedInstanceRecord[];
}

describe('WorkerModeImpl launch', () => {
  it('headless：mkdtemp + task（headless flag/loop/persistent=false）+ confirm + persist + handle 字段', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const { fake, r } = await launchOk(impl, holder, env);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('launched');
    const task = JSON.parse(fake.writtenTask().trim().split('\n')[0]!);
    expect(task.loop).toBe(true);
    expect(task.persistent).toBe(false);
    expect(task.headless).toBe(true);
    expect(task.cdpPort).toBe(18800);
    const wh = r.handle as WorkerHandle;
    expect(wh.key).toBe('s1:headless');
    expect(wh.state).toBe('ready');
    expect(wh.userDataDir).toBe('/tmp/rocky-browser-instance-ut');
    expect(wh.cdpPort).toBe(18800);
    expect(wh.workerPid).toBe(23456);
    expect(wh.persisted).toBe(true);
    const records = readRecords();
    expect(records.length).toBe(1);
    expect(records[0]!.key).toBe('s1:headless');
    expect(records[0]!.workerPid).toBe(23456);
  });

  it('managed-profile：resolveUserDataDir + persistent=true + profileName', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const p = impl.launch('s1:managed-profile:p1', { mode: 'managed-profile', profileName: 'p1' }, env);
    const fake = await new Promise<FakeWorkerControl>((resolve) => {
      setTimeout(() => resolve(holder.fake!), 10);
    });
    fake.emitStdout(JSON.stringify({ ok: true, text: 'launched' }) + '\n');
    const r = await p;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const task = JSON.parse(fake.writtenTask().trim().split('\n')[0]!);
    expect(task.loop).toBe(true);
    expect(task.persistent).toBe(true); // managed-profile → ensureProfileFree
    expect(task.headless).toBeUndefined();
    const wh = r.handle as WorkerHandle;
    expect(wh.profileName).toBe('p1');
  });

  it('launch 帧 ok:false（profile_in_use）→ 原样透传 kind + 失败路径清理（headless rm + 端口释放）', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const p = impl.launch('s1:headless', { mode: 'headless' }, env);
    const fake = await new Promise<FakeWorkerControl>((resolve) => {
      setTimeout(() => resolve(holder.fake!), 10);
    });
    fake.emitStdout(
      JSON.stringify({ ok: false, error: { kind: 'profile_in_use', message: 'profile x 被占用' } }) + '\n',
    );
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('profile_in_use');
      expect(r.error?.message).toContain('profile x 被占用');
    }
    // 失败路径：headless 目录清理 + 记录不落 + 端口释放
    expect(rmSyncMock).toHaveBeenCalled();
    expect(readRecords().length).toBe(0);
    expect(env.releasePort).toHaveBeenCalledWith(18800);
  });
});

describe('WorkerModeImpl execute', () => {
  it('execute → worker.send 写 {requestId,action,params} → stdout 响应路由回对应 pending', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const { fake, r: lr } = await launchOk(impl, holder, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const p = impl.execute(lr.handle, 'navigate', { url: 'https://a.com' }, {});
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

  it('execute cdp_timeout → 置 dead（manager 收尾 close）', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const { fake, r: lr } = await launchOk(impl, holder, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const p = impl.execute(lr.handle, 'navigate', { url: 'x' }, {});
    await new Promise((r) => setTimeout(r, 10));
    const lines = fake.writtenTask().trim().split('\n');
    const reqLine = JSON.parse(lines[lines.length - 1]!);
    fake.emitStdout(
      JSON.stringify({ requestId: reqLine.requestId, ok: false, error: { kind: 'cdp_timeout', message: 'timeout' } }) + '\n',
    );
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('cdp_timeout');
    expect(lr.handle.state).toBe('dead');
  });

  it('signal.aborted 前置 → 立即返回取消错误，不启动 action 不置 dead', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const { fake, r: lr } = await launchOk(impl, holder, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const writtenBefore = fake.writtenTask().trim().split('\n').length;
    const ac = new AbortController();
    ac.abort();
    const r = await impl.execute(lr.handle, 'navigate', { url: 'x' }, { signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('abort');
    expect(fake.writtenTask().trim().split('\n').length).toBe(writtenBefore); // 未发 action 帧
    expect(lr.handle.state).toBe('ready'); // 前置 abort 不置 dead
  });

  it('execute 中 abort 事件 → 置 dead（manager 收尾 close）', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const { fake, r: lr } = await launchOk(impl, holder, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const ac = new AbortController();
    const p = impl.execute(lr.handle, 'navigate', { url: 'x' }, { signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    const lines = fake.writtenTask().trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]!).action).toBe('navigate');
    ac.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('abort');
    expect(lr.handle.state).toBe('dead');
  });

  it('worker 崩溃（exit）→ pending reject → worker_crashed + 置 dead', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const { fake, r: lr } = await launchOk(impl, holder, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const p = impl.execute(lr.handle, 'navigate', { url: 'x' }, {});
    await new Promise((r) => setTimeout(r, 10));
    fake.emitExit(1, null);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('worker_crashed');
    expect(r.error?.message).toContain('请重新 launch');
    expect(lr.handle.state).toBe('dead');
  });

  it('execute screenshot → decode base64 + ctx.snapshot.save + 路径文本', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const { fake, r: lr } = await launchOk(impl, holder, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const save = vi.fn(async (_data: Buffer | string, _mediaType: string) => ({ relPath: 'snapshots/call_1.png' }));
    const p = impl.execute(lr.handle, 'screenshot', {}, { snapshot: { save } });
    await new Promise((r) => setTimeout(r, 10));
    const lines = fake.writtenTask().trim().split('\n');
    const reqLine = JSON.parse(lines[lines.length - 1]!);
    fake.emitStdout(
      JSON.stringify({ requestId: reqLine.requestId, ok: true, text: JSON.stringify({ mime: 'image/png', data: pngBytes.toString('base64') }) }) + '\n',
    );
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.text).toContain('snapshots/call_1.png');
    expect(r.text).toContain('see_image');
    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0]![0] as Buffer).equals(pngBytes)).toBe(true);
    expect(save.mock.calls[0]![1]).toBe('image/png');
  });
});

describe('WorkerModeImpl close', () => {
  it('close → 发 close 帧 + killProcessGroup + headless rmSync + releasePort + unpersist + 删记录', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const { fake, r: lr } = await launchOk(impl, holder, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await impl.close(lr.handle, env);
    // close 帧已写（FakeWorker 协议收到 close → exit(0)）
    const lines = fake.writtenTask().trim().split('\n');
    const closeLine = JSON.parse(lines[lines.length - 1]!);
    expect(closeLine.action).toBe('close');
    // 三要素：headless 目录删除 + 记录删除 + 端口释放
    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/rocky-browser-instance-ut', {
      recursive: true,
      force: true,
    });
    expect(readRecords().length).toBe(0);
    expect(env.releasePort).toHaveBeenCalledWith(18800);
    expect(killSpy).toHaveBeenCalledWith(-23456, 'SIGKILL'); // killProcessGroup 兜底
    expect(lr.handle.state).toBe('dead');
  });

  it('close 幂等：二次 close no-op（不重复 kill/rm/释放端口）', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const { r: lr } = await launchOk(impl, holder, env);
    expect(lr.ok).toBe(true);
    if (!lr.ok) return;
    await impl.close(lr.handle, env);
    const rmCount = rmSyncMock.mock.calls.length;
    const releaseCount = env.releasePort.mock.calls.length;
    await impl.close(lr.handle, env);
    expect(rmSyncMock.mock.calls.length).toBe(rmCount); // 不重复删目录
    expect(env.releasePort.mock.calls.length).toBe(releaseCount); // 不重复释放端口
    expect(readRecords().length).toBe(0);
  });
});

describe('WorkerModeImpl cleanupOrphan', () => {
  it('alive pid → killProcessGroup + headless 删目录 + 删记录', () => {
    const { impl } = makeImpl();
    const env = makeEnv();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    writeFileSync(
      instanceRecordPath(dataDir),
      JSON.stringify(
        [
          {
            key: 's1:headless',
            mode: 'headless',
            userDataDir: '/tmp/orphan-ut',
            cdpPort: 18801,
            workerPid: process.pid,
            createdAt: 0,
          },
        ],
        null,
        2,
      ),
    );
    impl.cleanupOrphan?.(
      {
        key: 's1:headless',
        mode: 'headless',
        userDataDir: '/tmp/orphan-ut',
        cdpPort: 18801,
        workerPid: process.pid,
        createdAt: 0,
      },
      env,
    );
    const groupKill = killSpy.mock.calls.find(([p, s]) => p === -process.pid && s === 'SIGKILL');
    expect(groupKill).toBeTruthy();
    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/orphan-ut', { recursive: true, force: true });
    expect(readRecords().length).toBe(0);
  });

  it('managed-profile 记录 → 不删用户数据目录（仅 kill + 删记录）', () => {
    const { impl } = makeImpl();
    const env = makeEnv();
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    impl.cleanupOrphan?.(
      {
        key: 's1:managed-profile:p1',
        mode: 'managed-profile',
        profileName: 'p1',
        userDataDir: `${dataDir}/browser/p1/user-data`,
        cdpPort: 18802,
        workerPid: process.pid,
        createdAt: 0,
      },
      env,
    );
    expect(rmSyncMock).not.toHaveBeenCalled(); // 不删用户数据
    expect(readRecords().length).toBe(0);
  });
});

describe('WorkerModeImpl chromePid（v0.0.272 孤儿对账锚点）', () => {
  it('launch 确认帧带 chromePid → handle.chromePid 存储 + 记录持久化', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const p = impl.launch('s1:headless', { mode: 'headless' }, env);
    const fake = await new Promise<FakeWorkerControl>((resolve) => {
      setTimeout(() => resolve(holder.fake!), 10);
    });
    fake.emitStdout(JSON.stringify({ ok: true, text: 'launched', chromePid: 555 }) + '\n');
    const r = await p;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wh = r.handle as WorkerHandle;
    expect(wh.chromePid).toBe(555);
    expect(readRecords()[0]!.chromePid).toBe(555); // 记录持久化 chromePid
  });

  it('launch 确认帧无 chromePid（旧 worker 兼容）→ handle.chromePid undefined + 记录不写字段', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const p = impl.launch('s1:headless', { mode: 'headless' }, env);
    const fake = await new Promise<FakeWorkerControl>((resolve) => {
      setTimeout(() => resolve(holder.fake!), 10);
    });
    fake.emitStdout(JSON.stringify({ ok: true, text: 'launched' }) + '\n');
    const r = await p;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const wh = r.handle as WorkerHandle;
    expect(wh.chromePid).toBeUndefined();
    expect(readRecords()[0]!.chromePid).toBeUndefined();
  });

  it('close：chromePid 仍存活 → 末尾兜底 killProcessGroupByPid(chromePid)（detached 组杀全家）', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const p = impl.launch('s1:headless', { mode: 'headless' }, env);
    const fake = await new Promise<FakeWorkerControl>((resolve) => {
      setTimeout(() => resolve(holder.fake!), 10);
    });
    fake.emitStdout(JSON.stringify({ ok: true, text: 'launched', chromePid: 555 }) + '\n');
    const r = await p;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // process.kill mock：isPidAlive(555) → true（chrome 仍存活）→ close 末尾补 kill chromePid
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    await impl.close(r.handle, env);
    const chromeGroupKill = killSpy.mock.calls.find(([pid, s]) => pid === -555 && s === 'SIGKILL');
    expect(chromeGroupKill).toBeTruthy(); // 兜底杀 detached chrome 进程组
  });

  it('close：chromePid 已死（worker 正常退出已清 chrome）→ 不补 kill（幂等无副作用）', async () => {
    const { impl, holder } = makeImpl();
    const env = makeEnv();
    const p = impl.launch('s1:headless', { mode: 'headless' }, env);
    const fake = await new Promise<FakeWorkerControl>((resolve) => {
      setTimeout(() => resolve(holder.fake!), 10);
    });
    fake.emitStdout(JSON.stringify({ ok: true, text: 'launched', chromePid: 555 }) + '\n');
    const r = await p;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // isPidAlive(555) → false（ESRCH 进程不存在）→ 不补 kill
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid === 555) {
        const e = new Error('ESRCH') as NodeJS.ErrnoException;
        e.code = 'ESRCH';
        throw e;
      }
      return true;
    });
    await impl.close(r.handle, env);
    const chromeGroupKill = killSpy.mock.calls.find(([pid, s]) => pid === -555 && s === 'SIGKILL');
    expect(chromeGroupKill).toBeUndefined(); // chrome 已死不补 kill
  });

  it('cleanupOrphan：记录带 chromePid → 精确杀 chrome 组（不依赖 workerPid）', () => {
    const { impl } = makeImpl();
    const env = makeEnv();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    impl.cleanupOrphan?.(
      {
        key: 's1:headless',
        mode: 'headless',
        userDataDir: '/tmp/orphan-chrome-ut',
        cdpPort: 18801,
        workerPid: 111,
        chromePid: 555,
        createdAt: 0,
      },
      env,
    );
    const chromeGroupKill = killSpy.mock.calls.find(([pid, s]) => pid === -555 && s === 'SIGKILL');
    expect(chromeGroupKill).toBeTruthy(); // chromePid 精确杀组
    expect(killSpy.mock.calls.find(([pid]) => pid === -111)).toBeUndefined(); // 不重复杀 workerPid
    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/orphan-chrome-ut', { recursive: true, force: true });
    expect(readRecords().length).toBe(0);
  });

  it('cleanupOrphan：旧记录无 chromePid → 退回杀 workerPid 组（兼容）', () => {
    const { impl } = makeImpl();
    const env = makeEnv();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    impl.cleanupOrphan?.(
      {
        key: 's1:headless',
        mode: 'headless',
        userDataDir: '/tmp/orphan-legacy-ut',
        cdpPort: 18801,
        workerPid: 111,
        createdAt: 0,
      },
      env,
    );
    const workerGroupKill = killSpy.mock.calls.find(([pid, s]) => pid === -111 && s === 'SIGKILL');
    expect(workerGroupKill).toBeTruthy(); // 旧记录退回杀 workerPid 组
    expect(readRecords().length).toBe(0);
  });
});
