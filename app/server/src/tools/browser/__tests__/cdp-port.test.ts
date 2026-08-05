/**
 * CDP 端口分配 单元测试（白盒）
 * 覆盖：
 *   - 段内首个未占用（18800 起）
 *   - 避开预留端口（18789 等，虽不在段内但校验 isValidCdpPort）
 *   - 避开 usedPorts
 *   - 避开真实占用（isBusy 返回 true）
 *   - 全部占用 → port_exhausted
 *   - isValidCdpPort 边界
 */
import { describe, it, expect } from 'vitest';
import {
  allocateCdpPort,
  isValidCdpPort,
  CDP_PORT_RANGE_START,
  CDP_PORT_RANGE_END,
  RESERVED_PORTS,
} from '../cdp-port';
import { BrowserError } from '../types';

describe('allocateCdpPort：基础', () => {
  it('段内首个空闲端口 = 18800', async () => {
    const port = await allocateCdpPort(new Set(), async () => false);
    expect(port).toBe(18800);
  });

  it('避开 usedPorts → 取下一个', async () => {
    const used = new Set([18800, 18801, 18802]);
    const port = await allocateCdpPort(used, async () => false);
    expect(port).toBe(18803);
  });

  it('避开 isBusy=true 的端口', async () => {
    const busyPorts = new Set([18800, 18801]);
    const isBusy = (p: number) => Promise.resolve(busyPorts.has(p));
    const port = await allocateCdpPort(new Set(), isBusy);
    expect(port).toBe(18802);
  });
});

describe('allocateCdpPort：段边界/耗尽', () => {
  it('段内全占用 → port_exhausted', async () => {
    // 标记段内所有非预留端口为 busy
    const isBusy = (p: number) => Promise.resolve(true);
    await expect(allocateCdpPort(new Set(), isBusy)).rejects.toThrowError(BrowserError);
    try {
      await allocateCdpPort(new Set(), isBusy);
    } catch (e) {
      expect((e as BrowserError).kind).toBe('port_exhausted');
    }
  });
});

describe('isValidCdpPort', () => {
  it('段内合法端口 true', () => {
    expect(isValidCdpPort(18800)).toBe(true);
    expect(isValidCdpPort(18899)).toBe(true);
  });

  it('段外 false', () => {
    expect(isValidCdpPort(18799)).toBe(false);
    expect(isValidCdpPort(18900)).toBe(false);
  });

  it('预留端口 false（即使预留端口 18789 不在段内，仍验证函数正确）', () => {
    // RESERVED_PORTS 全在段外，仍测函数返回 false 给已知预留值
    for (const p of RESERVED_PORTS) expect(isValidCdpPort(p)).toBe(false);
  });

  it('段起止 = 锁定决策 18800/18899', () => {
    expect(CDP_PORT_RANGE_START).toBe(18800);
    expect(CDP_PORT_RANGE_END).toBe(18899);
  });
});
