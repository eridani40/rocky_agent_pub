/**
 * 启动参数构造 单元测试（白盒）
 * 覆盖：
 *   - headless=true → --headless=new + --disable-gpu
 *   - headless=false → 不含 headless
 *   - linux 无 $DISPLAY → 自动 headless
 *   - linux → --disable-dev-shm-usage
 *   - 核心参数含 --remote-debugging-port / --user-data-dir / --password-store=basic 等
 */
import { describe, it, expect } from 'vitest';
import {
  buildChromeLaunchArgs,
  resolveHeadless,
  isHeadlessForcedByLinuxEnv,
  BASE_FLAGS_COUNT,
} from '../launch-args';

const ORIG_PLATFORM = process.platform;

describe('启动参数：核心字段', () => {
  it('含 --remote-debugging-port 与 --user-data-dir', () => {
    const args = buildChromeLaunchArgs({
      cdpPort: 18800,
      userDataDir: '/tmp/x',
      headlessOverride: false,
    });
    expect(args).toContain('--remote-debugging-port=18800');
    expect(args).toContain('--user-data-dir=/tmp/x');
    expect(args).toContain('--password-store=basic');
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--disable-sync');
    expect(args).toContain('--no-proxy-server');
  });
});

describe('启动参数：headless 分支', () => {
  it('headless=true → --headless=new + --disable-gpu', () => {
    const args = buildChromeLaunchArgs({
      cdpPort: 1,
      userDataDir: '/x',
      headlessOverride: true,
    });
    expect(args).toContain('--headless=new');
    expect(args).toContain('--disable-gpu');
  });

  it('headless=false → 不含 headless', () => {
    const args = buildChromeLaunchArgs({
      cdpPort: 1,
      userDataDir: '/x',
      headlessOverride: false,
    });
    expect(args.some((a) => a.startsWith('--headless'))).toBe(false);
  });

  it('BASE_FLAGS 数量稳定（防误删）', () => {
    expect(BASE_FLAGS_COUNT).toBe(10);
  });
});

describe('启动参数：Linux 专属', () => {
  it('Linux → 含 --disable-dev-shm-usage', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const args = buildChromeLaunchArgs({
      cdpPort: 1,
      userDataDir: '/x',
      headlessOverride: false,
    });
    expect(args).toContain('--disable-dev-shm-usage');
    Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true });
  });

  it('非 Linux → 不含 --disable-dev-shm-usage', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const args = buildChromeLaunchArgs({
      cdpPort: 1,
      userDataDir: '/x',
      headlessOverride: false,
    });
    expect(args).not.toContain('--disable-dev-shm-usage');
    Object.defineProperty(process, 'platform', { value: ORIG_PLATFORM, configurable: true });
  });
});

describe('resolveHeadless 优先级链', () => {
  it('显式 override 优先', () => {
    expect(resolveHeadless({ headlessOverride: true, env: { ROCKY_BROWSER_HEADLESS: 'false' } })).toBe(true);
  });

  it('env ROCKY_BROWSER_HEADLESS=1 → true', () => {
    expect(resolveHeadless({ env: { ROCKY_BROWSER_HEADLESS: '1' } })).toBe(true);
  });

  it('Linux 无显示 → true', () => {
    expect(resolveHeadless({ linuxNoDisplay: true, env: {} })).toBe(true);
  });

  it('默认 → false', () => {
    expect(resolveHeadless({ env: {} })).toBe(false);
  });
});

describe('isHeadlessForcedByLinuxEnv', () => {
  it('Linux 无 DISPLAY 无 WAYLAND → true', () => {
    expect(isHeadlessForcedByLinuxEnv({}, 'linux')).toBe(true);
  });
  it('Linux 有 DISPLAY → false', () => {
    expect(isHeadlessForcedByLinuxEnv({ DISPLAY: ':0' }, 'linux')).toBe(false);
  });
  it('macOS → false（不看 env）', () => {
    expect(isHeadlessForcedByLinuxEnv({}, 'darwin')).toBe(false);
  });
});
