/**
 * BUG-001 修复单测（白盒）：PlaywrightDriver per-profile CDP 端口分配
 * 参考: states/v0.0.23.1/bugs/BUG-001-browser-connectovercdp-timeout-[open].md
 *
 * 覆盖：
 *   1. PlaywrightDriverOptions 无 defaultCdpPort（不再固定端口）
 *   2. resolveCdpPort：段内首个空闲 = 18800
 *   3. 同 profile 二次调用复用缓存（稳定映射）
 *   4. 不同 profile 分配不同端口
 *   5. 缓存端口被占（僵尸残留）→ 重新分配下个空闲
 */
import { describe, it, expect } from 'vitest';
import { PlaywrightDriver } from '../playwright-driver';

/** 取 driver 的 private resolveCdpPort */
function resolver(driver: PlaywrightDriver) {
  return (
    driver as unknown as { resolveCdpPort: (n: string) => Promise<number> }
  ).resolveCdpPort.bind(driver);
}

describe('BUG-001 PlaywrightDriver per-profile 端口分配', () => {
  it('PlaywrightDriverOptions 无 defaultCdpPort（不再固定端口）', () => {
    const driver = new PlaywrightDriver({
      dataDir: '/tmp/drv-internals',
      portBusy: async () => false,
    });
    const internals = driver as unknown as Record<string, unknown>;
    expect(internals.defaultCdpPort).toBeUndefined();
    expect(internals.portBusy).toBeTypeOf('function');
    expect(internals.portCache).toBeInstanceOf(Map);
    expect(internals.usedPorts).toBeInstanceOf(Set);
  });

  it('resolveCdpPort：段内首个空闲 = 18800', async () => {
    const driver = new PlaywrightDriver({
      dataDir: '/tmp/drv-first',
      portBusy: async () => false,
    });
    const port = await resolver(driver)('profileA');
    expect(port).toBe(18800);
  });

  it('resolveCdpPort：同 profile 二次调用复用缓存', async () => {
    const driver = new PlaywrightDriver({
      dataDir: '/tmp/drv-cache',
      portBusy: async () => false,
    });
    const resolve = resolver(driver);
    const p1 = await resolve('profileA');
    const p2 = await resolve('profileA');
    expect(p1).toBe(p2);
    expect(p1).toBe(18800);
  });

  it('resolveCdpPort：不同 profile 分配不同端口', async () => {
    const driver = new PlaywrightDriver({
      dataDir: '/tmp/drv-multi',
      portBusy: async () => false,
    });
    const resolve = resolver(driver);
    const pA = await resolve('profileA');
    const pB = await resolve('profileB');
    expect(pA).not.toBe(pB);
    expect(pA).toBe(18800);
    expect(pB).toBe(18801);
  });

  it('resolveCdpPort：缓存端口被占（僵尸残留）→ 重新分配', async () => {
    const busyPorts = new Set<number>();
    const driver = new PlaywrightDriver({
      dataDir: '/tmp/drv-zombie',
      portBusy: (p) => Promise.resolve(busyPorts.has(p)),
    });
    const resolve = resolver(driver);
    const p1 = await resolve('profileA');
    expect(p1).toBe(18800);
    // 僵尸 chrome 占住 18800
    busyPorts.add(18800);
    const p2 = await resolve('profileA');
    expect(p2).not.toBe(18800);
    expect(p2).toBe(18801);
  });
});
