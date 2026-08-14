/**
 * chrome-version 单元测试（白盒，DI 注入 mock，不真跑 chrome）
 * 参考: specs/tech/version_logs/v0.0.334/change_plan.md A14（detectChromeVersion 3 形态）
 *
 * 覆盖：
 *   ① 正常解析：`Chrome <major>.<minor>...` → 主版本号 number
 *   ② 非 chrome 输出（无 "Chrome" 字样 / Chromium / Edge）→ undefined
 *   ③ 失败（execFileSync 抛错 / chrome 未发现 / 超时）→ undefined 不抛
 *   ④ 显式 executablePath 优先（不调 discover）
 */
import { describe, it, expect, vi } from 'vitest';
import { detectChromeVersion, type ChromeVersionDeps } from '../chrome-version';

/** DI 注入 mock deps（不真跑 chrome --version / 不真扫系统浏览器） */
function makeDeps(over: Partial<ChromeVersionDeps> = {}): ChromeVersionDeps {
  return {
    execFileSync: vi.fn(() => 'Google Chrome 144.0.6783.2\n'),
    discover: vi.fn(() => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ...over,
  };
}

describe('detectChromeVersion（v0.0.334 A14）', () => {
  it('正常解析：`Google Chrome 144.0.6783.2` → 144', async () => {
    const deps = makeDeps();
    const v = await detectChromeVersion(undefined, deps);
    expect(v).toBe(144);
    // 未显式给路径 → 经 discover 发现
    expect(deps.discover).toHaveBeenCalledTimes(1);
    expect(deps.execFileSync).toHaveBeenCalledWith(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ['--version'],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
  });

  it('显式 executablePath 优先（不调 discover）', async () => {
    const deps = makeDeps({ execFileSync: vi.fn(() => 'Google Chrome 150.0.0.0\n') });
    const v = await detectChromeVersion('/custom/chrome', deps);
    expect(v).toBe(150);
    expect(deps.discover).not.toHaveBeenCalled();
    expect(deps.execFileSync).toHaveBeenCalledWith('/custom/chrome', ['--version'], expect.anything());
  });

  it('非 chrome 输出（Chromium，无 "Chrome" 字样）→ undefined 不抛', async () => {
    const deps = makeDeps({ execFileSync: vi.fn(() => 'Chromium 130.0.0.0\n') });
    const v = await detectChromeVersion('/custom/chromium', deps);
    expect(v).toBeUndefined();
  });

  it('输出无版本号 → undefined 不抛', async () => {
    const deps = makeDeps({ execFileSync: vi.fn(() => 'unknown binary output\n') });
    const v = await detectChromeVersion('/custom/chrome', deps);
    expect(v).toBeUndefined();
  });

  it('execFileSync 抛错（超时/异常）→ undefined 不抛', async () => {
    const deps = makeDeps({
      execFileSync: vi.fn(() => {
        throw new Error('spawn chrome ENOENT');
      }),
    });
    const v = await detectChromeVersion('/custom/chrome', deps);
    expect(v).toBeUndefined();
  });

  it('chrome 未发现（discover 抛 chrome_not_found）→ undefined 不抛', async () => {
    const deps = makeDeps({
      discover: vi.fn(() => {
        throw new Error('chrome 未找到');
      }),
    });
    const v = await detectChromeVersion(undefined, deps);
    expect(v).toBeUndefined();
    expect(deps.execFileSync).not.toHaveBeenCalled();
  });
});
