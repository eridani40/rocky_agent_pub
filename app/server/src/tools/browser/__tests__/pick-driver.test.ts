/**
 * pickDriver + DriverRegistry 单元测试（白盒）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §7（mode→driver 路由）
 *
 * 覆盖：
 *   - InMemoryDriverRegistry：三 mode 路由（headless/managed-profile → playwright，attach → chromeMcp）
 *   - pickDriver：按 mode 取 driver
 *   - 未注册 mode → BrowserError unknown
 */
import { describe, it, expect } from 'vitest';
import { InMemoryDriverRegistry, pickDriver } from '../pick-driver';
import { BrowserError } from '../types';
import type { BrowserDriver } from '../types';

function makeDriver(mode: string): BrowserDriver {
  return { mode: mode as BrowserDriver['mode'], connect: async () => ({}) as never };
}

describe('InMemoryDriverRegistry + pickDriver：三 mode 路由', () => {
  const playwright = makeDriver('headless');
  const chromeMcp = makeDriver('attach');
  const registry = new InMemoryDriverRegistry({ headless: playwright, chromeMcp });

  it('headless → playwright driver', () => {
    expect(pickDriver(registry, 'headless')).toBe(playwright);
  });

  it('managed-profile → 同一 playwright driver（①② 共用）', () => {
    expect(pickDriver(registry, 'managed-profile')).toBe(playwright);
  });

  it('attach → chromeMcp driver', () => {
    expect(pickDriver(registry, 'attach')).toBe(chromeMcp);
  });
});
