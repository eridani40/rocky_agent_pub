/**
 * chrome-launcher 单元测试（白盒）
 * 覆盖：
 *   - launch_failed 错误信息含 chromium 缺失特征 → 引导 `bunx playwright install chromium`
 *   - launch_failed 错误信息无该特征 → 原样不追加引导（不污染其他错误）
 *   - connectOverCDP 失败也走 withChromiumHint（playwright connect 抛 chromium 缺失时同样引导）
 */
import { describe, it, expect } from 'vitest';
import { launchChromeAndConnect, withChromiumHint } from '../chrome-launcher';
import { BrowserError } from '../types';
import type { ChildProcess } from 'node:child_process';

/** 构造假 ChildProcess（kill 可调用；stderr:null 模拟 Bun 精简环境 + 无 stderr 流） */
function fakeChild(pid = 12345): ChildProcess {
  return {
    killed: false,
    pid,
    kill: () => true,
    stderr: null,
  } as unknown as ChildProcess;
}

describe('withChromiumHint：chromium 缺失特征检测', () => {
  it('"Executable doesn\'t exist" 命中 → 追加引导', () => {
    const r = withChromiumHint("browserType.launch: Executable doesn't exist at /xxx/chromium-1228/...");
    expect(r).toContain('bunx playwright install chromium');
    expect(r).toContain("Executable doesn't exist");
  });

  it('"browserType.launch" 命中 → 追加引导', () => {
    const r = withChromiumHint('browserType.launch failed');
    expect(r).toContain('bunx playwright install chromium');
  });

  it('无特征错误 → 原样返回不追加', () => {
    const r = withChromiumHint('EACCES permission denied');
    expect(r).toBe('EACCES permission denied');
    expect(r).not.toContain('playwright install');
  });
});

describe('launchChromeAndConnect：launch_failed 引导', () => {
  it('spawn 抛 "Executable doesn\'t exist" → errorDetail 含引导', async () => {
    // 系统 chrome 探测走 hardcoded 候选（mock 都不存在）+ 用户未配 → 抛 chrome_not_found
    // 这里走 userPath 让 discover 通过，再让 spawn 抛 chromium 缺失特征
    await expect(
      launchChromeAndConnect(
        { userDataDir: '/tmp/xyz', cdpPort: 0, persistent: false, executablePath: '/opt/chrome' },
        {
          exists: (p) => p === '/opt/chrome',
          spawn: () => {
            throw new Error("browserType.launch: Executable doesn't exist at /chromium-1228");
          },
        },
      ),
    ).rejects.toThrowError(BrowserError);

    try {
      await launchChromeAndConnect(
        { userDataDir: '/tmp/xyz', cdpPort: 0, persistent: false, executablePath: '/opt/chrome' },
        {
          exists: (p) => p === '/opt/chrome',
          spawn: () => {
            throw new Error("browserType.launch: Executable doesn't exist at /chromium-1228");
          },
        },
      );
    } catch (e) {
      const err = e as BrowserError;
      expect(err.kind).toBe('launch_failed');
      expect(err.message).toContain('chrome 启动失败');
      expect(err.message).toContain('bunx playwright install chromium');
    }
  });

  it('connectOverCDP 抛 chromium 缺失 → errorDetail 含引导', async () => {
    let childRef: ChildProcess | undefined;
    await expect(
      launchChromeAndConnect(
        { userDataDir: '/tmp/xyz', cdpPort: 0, persistent: false, executablePath: '/opt/chrome' },
        {
          exists: (p) => p === '/opt/chrome',
          spawn: () => {
            childRef = fakeChild();
            return childRef;
          },
          waitForCdp: async () => undefined,
          connectCDP: async () => {
            throw new Error('browserType.launch: chromium not found in cache');
          },
        },
      ),
    ).rejects.toThrowError(BrowserError);

    try {
      await launchChromeAndConnect(
        { userDataDir: '/tmp/xyz2', cdpPort: 0, persistent: false, executablePath: '/opt/chrome' },
        {
          exists: (p) => p === '/opt/chrome',
          spawn: () => fakeChild(),
          waitForCdp: async () => undefined,
          connectCDP: async () => {
            throw new Error('browserType.launch: chromium not found in cache');
          },
        },
      );
    } catch (e) {
      const err = e as BrowserError;
      expect(err.kind).toBe('launch_failed');
      expect(err.message).toContain('connectOverCDP 失败');
      expect(err.message).toContain('bunx playwright install chromium');
    }
  });
});
