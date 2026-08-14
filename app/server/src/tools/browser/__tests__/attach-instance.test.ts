/**
 * attach-instance 单元测试（白盒，全 mock driver，不真连 Chrome）
 * 参考: specs/tech/version_logs/v0.0.334/change_plan.md A11（删 cdpUrl 参数，autoConnect-only）
 *       specs/tech/agent/tools/[P1]browser_tool.md §4（ChromeMcpDriver connect/close 语义）
 *
 * 覆盖（v0.0.334：attach 仅 autoConnect，删 cdpUrl 参数）：
 *   ① connectAttachSession → driver.connect({})（无端点参数，driver 恒 --autoConnect）
 *   ② disconnectAttachSession → driver.disconnect({})（对称，cacheKey 二元组一致）
 *   ③ connect 失败 → attach_failed + message 透传
 *   ④ driver undefined → disconnect no-op（不抛）
 */
import { describe, it, expect, vi } from 'vitest';
import type { ChromeMcpDriver } from '../chrome-mcp-driver';
import { buildChromeMcpArgs } from '../chrome-mcp-driver';
import type { BrowserSession, BrowserConnectOptions, SnapshotResult } from '../types';
import { connectAttachSession, disconnectAttachSession } from '../attach-instance';
import { defaultChromeUserDataDirCandidates } from '../attach-debug-state';
import { join } from 'node:path';

/** mock ChromeMcpDriver：connect/disconnect 记录入参 + getLastMcpPid（B8：MCP 子进程 pid 透传）+ getLastSpawnPid（H5：失败 spawn pid 透传） */
function makeDriver(mcpPid?: number, spawnPid?: number) {
  const fakeSession: BrowserSession = {
    listPages: vi.fn(async () => [{ id: 'p1', url: 'https://x', selected: true }]),
    selectPage: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
    snapshot: vi.fn(async (): Promise<SnapshotResult> => ({ snapshot: '- button "Go"', refs: {} })),
    click: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    evaluate: vi.fn(async () => 42),
    close: vi.fn(async () => {}),
  };
  return {
    connect: vi.fn(async (opts?: BrowserConnectOptions): Promise<BrowserSession> => fakeSession),
    disconnect: vi.fn(async (_opts?: BrowserConnectOptions): Promise<void> => {}),
    getLastMcpPid: vi.fn((): number | undefined => mcpPid),
    getLastSpawnPid: vi.fn((): number | undefined => spawnPid),
    fakeSession,
  };
}

describe('connectAttachSession（v0.0.334 autoConnect-only，无 cdpUrl 参数）', () => {
  it('connectAttachSession(driver) → driver.connect({userDataDir})（F2 注入默认 dir；deps 可注入 mock）', async () => {
    const driver = makeDriver();
    const r = await connectAttachSession(driver as unknown as ChromeMcpDriver, {
      existsSync: () => true, // 强制首个候选存在
      homedir: () => '/Users/ut',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(driver.connect).toHaveBeenCalledTimes(1);
    // autoConnect-only：无端点参数；F2 注入默认 userDataDir（darwin 首个候选）；H4：signal 缺省 undefined 透传
    expect(driver.connect).toHaveBeenCalledWith(
      {
        userDataDir: join('/Users/ut', 'Library/Application Support/Google/Chrome'),
      },
      undefined,
    );
    const args = buildChromeMcpArgs({ profileName: 'p1' });
    expect(args).toContain('--autoConnect');
    expect(args).not.toContain('--browserUrl');
    expect(args).not.toContain('--wsEndpoint');
  });

  it('[v0.0.334 B8] connect 成功且 driver 有 getLastMcpPid → 返回 mcpPid（attach 台账锚点）', async () => {
    const driver = makeDriver(4242);
    const r = await connectAttachSession(driver as unknown as ChromeMcpDriver);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mcpPid).toBe(4242);
    expect(driver.getLastMcpPid).toHaveBeenCalledTimes(1);
  });

  it('[v0.0.334 B8] connect 成功但 driver 无 getLastMcpPid → mcpPid undefined（缺省不阻塞 launch）', async () => {
    const driver = makeDriver();
    const r = await connectAttachSession(driver as unknown as ChromeMcpDriver);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mcpPid).toBeUndefined();
  });

  it('connect 失败 → attach_failed + message 透传', async () => {
    const driver = makeDriver();
    driver.connect.mockRejectedValueOnce(new Error('ECONNREFUSED 9222'));
    const r = await connectAttachSession(driver as unknown as ChromeMcpDriver);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_failed');
      expect(r.error?.message).toContain('ECONNREFUSED');
    }
  });

  // ---- v0.0.337 H4：signal 透传 + 失败透传 spawnPid ----
  it('[v0.0.337 H4] signal 透传：connectAttachSession(driver, deps, signal) → driver.connect({userDataDir}, signal)', async () => {
    const driver = makeDriver();
    const ac = new AbortController();
    const r = await connectAttachSession(
      driver as unknown as ChromeMcpDriver,
      { existsSync: () => false, homedir: () => '/Users/ut' }, // 强制 userDataDir undefined（隔离真实环境）
      ac.signal,
    );
    expect(r.ok).toBe(true);
    expect(driver.connect).toHaveBeenCalledTimes(1);
    expect(driver.connect).toHaveBeenCalledWith({ userDataDir: undefined }, ac.signal);
  });

  it('[v0.0.337 H4] connect 失败且 driver 有 getLastSpawnPid → 返回 spawnPid（失败入台账兜底锚点）', async () => {
    const driver = makeDriver(undefined, 4242);
    driver.connect.mockRejectedValueOnce(new Error('ECONNREFUSED 9222'));
    const r = await connectAttachSession(driver as unknown as ChromeMcpDriver);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_failed');
      expect(r.spawnPid).toBe(4242);
      expect(driver.getLastSpawnPid).toHaveBeenCalledTimes(1);
    }
  });

  it('[v0.0.337 H4] connect 失败但 driver 无 getLastSpawnPid → spawnPid undefined（缺省不阻塞）', async () => {
    const driver = makeDriver();
    driver.connect.mockRejectedValueOnce(new Error('ECONNREFUSED 9222'));
    const r = await connectAttachSession(driver as unknown as ChromeMcpDriver);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error?.kind).toBe('attach_failed');
      expect(r.spawnPid).toBeUndefined();
    }
  });
});

describe('disconnectAttachSession（v0.0.336 G1：cache key 对称）', () => {
  it('disconnectAttachSession(driver) → driver.disconnect({userDataDir})（与 connect 同一解析，cacheKey 对称）', async () => {
    const driver = makeDriver();
    await disconnectAttachSession(driver as unknown as ChromeMcpDriver, {
      existsSync: () => true,
      homedir: () => '/Users/ut',
    });
    expect(driver.disconnect).toHaveBeenCalledTimes(1);
    expect(driver.disconnect).toHaveBeenCalledWith({
      userDataDir: join('/Users/ut', 'Library/Application Support/Google/Chrome'),
    });
  });

  it('connect/disconnect 用同一 deps → cacheKey 对称（同 userDataDir，driver cache 正常清）', async () => {
    const driver = makeDriver();
    const deps = { existsSync: () => true, homedir: () => '/Users/ut' };
    await connectAttachSession(driver as unknown as ChromeMcpDriver, deps);
    await disconnectAttachSession(driver as unknown as ChromeMcpDriver, deps);
    // connect/disconnect 收到同一 userDataDir → cacheKey 对称（v0.0.336 P1 修复核心）；H4：signal 缺省 undefined
    expect(driver.connect).toHaveBeenCalledWith(
      {
        userDataDir: join('/Users/ut', 'Library/Application Support/Google/Chrome'),
      },
      undefined,
    );
    expect(driver.disconnect).toHaveBeenCalledWith({
      userDataDir: join('/Users/ut', 'Library/Application Support/Google/Chrome'),
    });
  });

  it('driver undefined → no-op（不调不抛）', async () => {
    await expect(disconnectAttachSession(undefined)).resolves.toBeUndefined();
  });
});

describe('defaultChromeUserDataDirCandidates（v0.0.334 fix Bug1：attach 补 --userDataDir）', () => {
  it('darwin → ~/Library/Application Support/Google/Chrome（dirname 派生，去末尾 /DevToolsActivePort）', () => {
    const dirs = defaultChromeUserDataDirCandidates('/Users/ut', 'darwin');
    expect(dirs).toEqual([join('/Users/ut', 'Library/Application Support/Google/Chrome')]);
  });

  it('linux → ~/.config/google-chrome、~/.config/chromium（两候选，顺序=优先级）', () => {
    const dirs = defaultChromeUserDataDirCandidates('/home/ut', 'linux');
    expect(dirs).toEqual([
      join('/home/ut', '.config/google-chrome'),
      join('/home/ut', '.config/chromium'),
    ]);
  });

  it('win32 → %LOCALAPPDATA%/Google/Chrome/User Data', () => {
    const prev = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = 'C:\\Users\\ut\\AppData\\Local';
    try {
      const dirs = defaultChromeUserDataDirCandidates('C:\\Users\\ut', 'win32');
      expect(dirs).toEqual([join('C:\\Users\\ut\\AppData\\Local', 'Google/Chrome/User Data')]);
    } finally {
      if (prev === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prev;
    }
  });

  it('未知平台 → 空数组（对齐 devToolsActivePortCandidates 单一数据源）', () => {
    expect(defaultChromeUserDataDirCandidates('/x', 'freebsd')).toEqual([]);
  });
});

describe('connectAttachSession 注入 userDataDir（v0.0.334 fix Bug1）', () => {
  it('首个候选 dir 存在 → driver.connect 收到 { userDataDir: <首个候选 dir> }', async () => {
    const driver = makeDriver();
    const r = await connectAttachSession(driver as unknown as ChromeMcpDriver, {
      existsSync: (p) => p === join('/Users/ut', 'Library/Application Support/Google/Chrome'),
      homedir: () => '/Users/ut',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(driver.connect).toHaveBeenCalledTimes(1);
    expect(driver.connect).toHaveBeenCalledWith(
      {
        userDataDir: join('/Users/ut', 'Library/Application Support/Google/Chrome'),
      },
      undefined,
    );
  });

  it('linux 第二候选存在（第一不存在）→ 注入第二候选（顺序=优先级）', async () => {
    const driver = makeDriver();
    const r = await connectAttachSession(driver as unknown as ChromeMcpDriver, {
      existsSync: (p) => p === join('/home/ut', '.config/chromium'), // 仅 chromium 存在
      homedir: () => '/home/ut',
      platform: 'linux',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(driver.connect).toHaveBeenCalledWith(
      {
        userDataDir: join('/home/ut', '.config/chromium'),
      },
      undefined,
    );
  });

  it('候选 dir 全不存在 → driver.connect 收到 { userDataDir: undefined }（不发明目录，走旧 else 分支兜底）', async () => {
    const driver = makeDriver();
    const r = await connectAttachSession(driver as unknown as ChromeMcpDriver, {
      existsSync: () => false, // 强制全不存在
      homedir: () => '/Users/ut',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(driver.connect).toHaveBeenCalledTimes(1);
    expect(driver.connect).toHaveBeenCalledWith({ userDataDir: undefined }, undefined);
  });
});
