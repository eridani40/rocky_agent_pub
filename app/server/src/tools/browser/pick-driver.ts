/**
 * pickDriver —— 按 mode 选 BrowserDriver（browser Tool 路由）
 * 参考: specs/tech/agent/tools/[P1]browser_tool.md §7（mode→driver 路由）
 *
 * 路由表：
 *   headless / managed-profile → NodeWorkerDriver（node worker 子进程绕开 Bun playwright bug）
 *   attach                     → ChromeMcpDriver（chrome-devtools-mcp MCP）
 *
 * driver 实例经 DriverRegistry 注入（app 构造期装配），避免 Tool 直接 import 具体实现 +
 * 便于 ConnectorManager 持有 ChromeMcpDriver 单例（attach session 长存复用）。
 */
import type { BrowserDriver, BrowserMode } from './types';
import { BrowserError } from './types';

/**
 * 驱动注册表——按 mode 取 driver 实例。
 * app 构造期注入（NodeWorkerDriver + ChromeMcpDriver 各一）。
 */
export interface DriverRegistry {
  get(mode: BrowserMode): BrowserDriver;
}

/**
 * 默认 DriverRegistry：内存 Map 持有各 mode 的 driver。
 * headless/managed-profile 共用 NodeWorkerDriver（mode 在 executeOnce 时按 opts 推断）。
 * attach → ChromeMcpDriver（可选；v0.0.266 起由 bootstrap 共享 attachDriver 单例注入
 *   InstanceManager，attach 走 launch 时 connect，不查 registry，故 chromeMcp 可缺省）。
 *
 * headless/managed-profile 用 NodeWorkerDriver（PlaywrightDriver 的 connect 路径在 Bun 下永久 hang）。
 */
export class InMemoryDriverRegistry implements DriverRegistry {
  private readonly map: Map<BrowserMode, BrowserDriver>;
  constructor(drivers: {
    /** headless/managed-profile driver（生产用 NodeWorkerDriver）。 */
    headless: BrowserDriver;
    /** attach driver（可选；缺省 → get('attach') 抛「无 driver 注册」） */
    chromeMcp?: BrowserDriver;
  }) {
    const entries: Array<[BrowserMode, BrowserDriver]> = [
      ['headless', drivers.headless],
      ['managed-profile', drivers.headless],
    ];
    if (drivers.chromeMcp) entries.push(['attach', drivers.chromeMcp]);
    this.map = new Map<BrowserMode, BrowserDriver>(entries);
  }
  get(mode: BrowserMode): BrowserDriver {
    const d = this.map.get(mode);
    if (!d) throw new BrowserError('unknown', `无 ${mode} driver 注册`);
    return d;
  }
}

/**
 * 按 mode 取 driver（browser Tool run 用）。
 * @param registry 驱动注册表（注入）
 * @param mode browser tool input.mode
 */
export function pickDriver(registry: DriverRegistry, mode: BrowserMode): BrowserDriver {
  return registry.get(mode);
}
