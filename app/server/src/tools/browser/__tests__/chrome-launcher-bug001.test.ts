/**
 * BUG-001 修复单测（白盒）：进程树 SIGKILL + connectOverCDP 重试
 * 参考: states/v0.0.23.1/bugs/BUG-001-browser-connectovercdp-timeout-[open].md
 *
 * 覆盖：
 *   1. killProcessGroup：调 process.kill(-pid, 'SIGKILL')（进程组而非单进程）
 *   2. 进程组 kill 失败 → fallback child.kill('SIGKILL')
 *   3. connectOverCDP 首次失败 → kill+relaunch 重试 → 二次成功（自愈僵尸 chrome）
 *   4. connectOverCDP 全失败 → launch_failed（含两次错误信息）
 *   5. spawn 失败不重试（重试无意义）
 *   6. FakeChild 无 close/stderr:null（模拟 Bun 精简 API，见 memory）
 */
import { describe, it, expect, vi } from 'vitest';
import {
  launchChromeAndConnect,
  killProcessGroup,
  killChild,
} from '../chrome-launcher';
import { BrowserError } from '../types';
import type { ChildProcess } from 'node:child_process';

/** 假 ChildProcess（stderr:null 模拟 Bun 精简环境，无 close 方法） */
function fakeChild(pid = 12345): ChildProcess {
  return {
    killed: false,
    pid,
    kill: () => true,
    stderr: null,
  } as unknown as ChildProcess;
}

describe('BUG-001 killProcessGroup：进程组 SIGKILL', () => {
  it('调 process.kill(-pid, SIGKILL) 杀进程组（负 pid=组）', () => {
    const child = fakeChild(99999);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      killProcessGroup(child);
      const groupCall = killSpy.mock.calls.find(
        ([p, s]) => p === -99999 && s === 'SIGKILL',
      );
      expect(groupCall).toBeTruthy();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('进程组 kill 失败 → fallback 杀父进程 SIGKILL', () => {
    const child = fakeChild(88888);
    let childKillCalled = false;
    (child as { kill: (s: string) => boolean }).kill = (sig: string) => {
      if (sig === 'SIGKILL') childKillCalled = true;
      return true;
    };
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    try {
      expect(() => killProcessGroup(child)).not.toThrow();
      expect(childKillCalled).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('killChild 是 killProcessGroup 的别名（向后兼容）', () => {
    expect(killChild).toBe(killProcessGroup);
  });

  it('chrome 已退出（killed=true）→ 不调 kill 不抛错', () => {
    const child = fakeChild(77777);
    (child as { killed: boolean }).killed = true;
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      expect(() => killProcessGroup(child)).not.toThrow();
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('BUG-001 connectOverCDP 重试：自愈僵尸 chrome', () => {
  it('首次 connectOverCDP 失败 → kill+relaunch → 二次成功', async () => {
    let spawnCalls = 0;
    let connectCalls = 0;
    const result = await launchChromeAndConnect(
      {
        userDataDir: '/tmp/xyz-retry-ok',
        cdpPort: 18800,
        persistent: false,
        executablePath: '/opt/chrome',
      },
      {
        exists: (p) => p === '/opt/chrome',
        spawn: () => {
          spawnCalls++;
          return fakeChild(10000 + spawnCalls);
        },
        waitForCdp: async () => undefined,
        connectCDP: async () => {
          connectCalls++;
          if (connectCalls === 1) {
            throw new Error('connectOverCDP: Timeout 30000ms exceeded.');
          }
          return { __mock: 'browser' };
        },
      },
    );
    expect(spawnCalls).toBe(2);
    expect(connectCalls).toBe(2);
    expect(result.browser).toEqual({ __mock: 'browser' });
    expect(typeof result.kill).toBe('function');
  });

  it('两次 connectOverCDP 都失败 → launch_failed 含两次错误信息', async () => {
    let err: BrowserError | undefined;
    try {
      await launchChromeAndConnect(
        {
          userDataDir: '/tmp/xyz-retry-fail',
          cdpPort: 18800,
          persistent: false,
          executablePath: '/opt/chrome',
        },
        {
          exists: (p) => p === '/opt/chrome',
          spawn: () => fakeChild(20000),
          waitForCdp: async () => undefined,
          connectCDP: async () => {
            throw new Error('connectOverCDP: Timeout 30000ms exceeded.');
          },
        },
      );
    } catch (e) {
      err = e as BrowserError;
    }
    expect(err).toBeInstanceOf(BrowserError);
    expect(err!.kind).toBe('launch_failed');
    expect(err!.message).toContain('重试仍失败');
    expect(err!.message).toContain('首次');
    expect(err!.message).toContain('二次');
  });

  it('spawn 失败（chrome 可执行缺失）不重试', async () => {
    let spawnCalls = 0;
    await expect(
      launchChromeAndConnect(
        {
          userDataDir: '/tmp/xyz-spawn-fail',
          cdpPort: 18800,
          persistent: false,
          executablePath: '/opt/chrome',
        },
        {
          exists: (p) => p === '/opt/chrome',
          spawn: () => {
            spawnCalls++;
            throw new Error('ENOENT spawn ENOENT');
          },
        },
      ),
    ).rejects.toThrowError(BrowserError);
    expect(spawnCalls).toBe(1);
  });
});
