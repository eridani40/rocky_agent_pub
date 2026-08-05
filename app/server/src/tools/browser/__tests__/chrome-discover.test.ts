/**
 * chrome 发现 单元测试（白盒）
 * 覆盖：
 *   - 用户 executablePath 优先（存在 / 不存在抛 chrome_not_found）
 *   - 系统默认浏览器探测（mac/linux，mock plutil/osascript/xdg-settings/which）
 *   - 硬编码候选 fallback
 *   - 三级 fallback 顺序：用户 > 系统 > 硬编码
 */
import { describe, it, expect } from 'vitest';
import { discoverChromeExecutable } from '../chrome-discover';
import { BrowserError } from '../types';

describe('chrome 发现：用户配置路径', () => {
  it('用户配置存在 → 直接返回', () => {
    const r = discoverChromeExecutable('/opt/chrome', {
      exists: (p) => p === '/opt/chrome',
    });
    expect(r).toBe('/opt/chrome');
  });

  it('用户配置不存在 → BrowserError chrome_not_found', () => {
    expect(() =>
      discoverChromeExecutable('/nope/chrome', { exists: () => false }),
    ).toThrowError(BrowserError);
    try {
      discoverChromeExecutable('/nope/chrome', { exists: () => false });
    } catch (e) {
      expect((e as BrowserError).kind).toBe('chrome_not_found');
    }
  });
});

describe('chrome 发现：macOS 系统默认（mock plutil/osascript）', () => {
  const origPlatform = process.platform;
  function stubPlatform(p: string) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }
  it('macOS LaunchServices 解析到 chrome bundle → osascript 拿到可执行', () => {
    stubPlatform('darwin');
    const home = '/Users/x';
    const appPath = '/Applications/Google Chrome.app';
    const execPath = `${appPath}/Contents/MacOS/Google Chrome`;
    const calls: string[] = [];
    const r = discoverChromeExecutable(undefined, {
      exists: (p) => p === execPath || p === `${home}/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist`,
      homedir: () => home,
      execFileSync: (cmd: string, args: string[]) => {
        calls.push(`${cmd} ${args.join(' ')}`);
        if (cmd === 'plutil' && args[0] === '-convert') {
          // plist handler 返 chrome bundle
          return JSON.stringify({
            LSHandlers: [
              { LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.google.chrome' },
            ],
          });
        }
        if (cmd === 'osascript') {
          // 返 HFS-style 路径
          return 'Macintosh HD:Applications:Google Chrome.app:';
        }
        // Info.plist CFBundleExecutable
        if (cmd === 'plutil') {
          return JSON.stringify({ CFBundleExecutable: 'Google Chrome' });
        }
        return '';
      },
    });
    expect(r).toBe(execPath);
    stubPlatform(origPlatform);
  });

  it('macOS 非 chromium bundle（如 safari）→ 跳过默认探测走 fallback', () => {
    stubPlatform('darwin');
    const home = '/Users/x';
    const r = discoverChromeExecutable(undefined, {
      exists: (p) => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      homedir: () => home,
      execFileSync: (cmd, args) => {
        if (cmd === 'plutil' && args[0] === '-convert') {
          return JSON.stringify({
            LSHandlers: [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: 'com.apple.safari' }],
          });
        }
        return '';
      },
    });
    expect(r).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    stubPlatform(origPlatform);
  });
});

describe('chrome 发现：Linux 系统默认（mock xdg-settings/which）', () => {
  const origPlatform = process.platform;
  it('xdg-settings → .desktop → which 解析成功', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const home = '/home/x';
    const desktopFile = `/usr/share/applications/google-chrome.desktop`;
    const r = discoverChromeExecutable(undefined, {
      exists: (p) => p === desktopFile || p === '/usr/bin/google-chrome',
      homedir: () => home,
      execFileSync: (cmd, args) => {
        if (cmd === 'xdg-settings') return 'google-chrome.desktop\n';
        if (cmd === 'which' && args[0] === 'google-chrome') return '/usr/bin/google-chrome\n';
        return '';
      },
    });
    expect(r).toBe('/usr/bin/google-chrome');
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  });
});

describe('chrome 发现：硬编码 fallback', () => {
  it('系统探测失败 → 硬编码首个存在的候选', () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const r = discoverChromeExecutable(undefined, {
      exists: (p) => p === '/opt/google/chrome/chrome',
      homedir: () => '/home/x',
      execFileSync: () => {
        throw new Error('not found');
      },
    });
    expect(r).toBe('/opt/google/chrome/chrome');
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
  });

  it('三级全空 → chrome_not_found', () => {
    expect(() =>
      discoverChromeExecutable(undefined, {
        exists: () => false,
        homedir: () => '/x',
        execFileSync: () => {
          throw new Error('x');
        },
      }),
    ).toThrowError(BrowserError);
  });
});

describe('chrome 发现：playwright chromium 兜底（readdirSync 列目录）', () => {
  const origPlatform = process.platform;
  function stubPlatform(p: string) {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  it('macOS: MAC_CANDIDATES + 系统默认都失败 → playwright chromium (arm64) 兜底', () => {
    stubPlatform('darwin');
    const home = '/Users/x';
    const playwrightPath =
      '/Users/x/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    const r = discoverChromeExecutable(undefined, {
      // 仅 playwright chromium 路径存在；所有 MAC_CANDIDATES / 系统默认探测均失败
      exists: (p) => p === playwrightPath,
      // readdirSync 列出 ms-playwright 下的 chromium-* 目录
      readdir: (p) => (p === `${home}/Library/Caches/ms-playwright` ? ['chromium-1228'] : []),
      homedir: () => home,
      execFileSync: () => {
        throw new Error('no plist / no default');
      },
    });
    expect(r).toBe(playwrightPath);
    stubPlatform(origPlatform);
  });

  it('macOS: playwright chromium (chrome-mac/x64) 命中', () => {
    stubPlatform('darwin');
    const home = '/Users/x';
    const playwrightPath =
      '/Users/x/Library/Caches/ms-playwright/chromium-1228/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    const r = discoverChromeExecutable(undefined, {
      exists: (p) => p === playwrightPath,
      readdir: (p) => (p === `${home}/Library/Caches/ms-playwright` ? ['chromium-1228'] : []),
      homedir: () => home,
      execFileSync: () => {
        throw new Error('x');
      },
    });
    expect(r).toBe(playwrightPath);
    stubPlatform(origPlatform);
  });

  it('Linux: ~/.cache/ms-playwright/chromium-1228/chrome-linux/chrome 命中', () => {
    stubPlatform('linux');
    const home = '/home/x';
    const expected = `${home}/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`;
    const r = discoverChromeExecutable(undefined, {
      exists: (p) => p === expected,
      readdir: (p) => (p === `${home}/.cache/ms-playwright` ? ['chromium-1228'] : []),
      homedir: () => home,
      execFileSync: () => {
        throw new Error('x');
      },
    });
    expect(r).toBe(expected);
    stubPlatform(origPlatform);
  });

  it('ms-playwright 目录无 chromium-* → readdir 返 [] → 三级全空 chrome_not_found', () => {
    stubPlatform('linux');
    expect(() =>
      discoverChromeExecutable(undefined, {
        exists: () => false,
        readdir: () => ['firefox-1234', 'webkit-5678'], // 无 chromium-* 前缀 → 过滤为空
        homedir: () => '/home/x',
        execFileSync: () => {
          throw new Error('x');
        },
      }),
    ).toThrowError(BrowserError);
    stubPlatform(origPlatform);
  });

  it('系统 MAC_CANDIDATES 存在 → 优先返回系统 chrome（不抢占 playwright 兜底）', () => {
    stubPlatform('darwin');
    const home = '/Users/x';
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const r = discoverChromeExecutable(undefined, {
      exists: (p) => p === systemChrome,
      readdir: (p) => (p === `${home}/Library/Caches/ms-playwright` ? ['chromium-1228'] : []),
      homedir: () => home,
      execFileSync: () => {
        throw new Error('x');
      },
    });
    expect(r).toBe(systemChrome);
    stubPlatform(origPlatform);
  });
});
