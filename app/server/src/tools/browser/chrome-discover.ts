/**
 * chrome 二进制发现（三级 fallback）
 * 参考: specs/research/v0.0.23-browser-use.md §2.1（复刻 openclaw chrome.executables.ts）
 *       specs/tech/agent/tools/[P1]browser_tool.md §3
 *
 * 三级 fallback：
 *   1. 用户配置 executablePath（最高优先级）
 *   2. 系统默认浏览器探测（macOS LaunchServices plist + osascript / Linux xdg-settings）
 *   3. 硬编码候选路径（+ Playwright 缓存）
 *
 * 本文件只做 macOS + Linux（开发机），Windows 留 stub（TODO）。
 * 可注入 fs/osascript/which 等依赖以便单元测试（mock）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BrowserError } from './types';

/** chrome 系 bundle id 白名单（macOS LaunchServices 解析后白名单匹配） */
const CHROMIUM_BUNDLE_IDS = new Set([
  'com.google.chrome',
  'com.google.chrome.canary',
  'org.chromium.chromium',
  'com.microsoft.edgemac',
  'com.brave.browser',
  'com.vivaldi.vivaldi',
  'com.operasoftware.opera',
  'company.thebrowser.browser', // Arc
  'ru.yandex.desktop.yandex-browser',
]);

/** 硬编码候选路径（fallback 层）—— 平台无关声明，平台函数按需取用 */
const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];
const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  '/snap/bin/chromium',
];

/**
 * 可注入依赖（单元测试 mock 用）。生产路径用真实 node API。
 */
export interface DiscoverDeps {
  exists?: (p: string) => boolean;
  /** 列目录（readdirSync 注入；用于列 ms-playwright/chromium-* 目录） */
  readdir?: (p: string) => string[];
  execFileSync?: (cmd: string, args: string[], opts?: { timeout?: number }) => string;
  homedir?: () => string;
}

const defaultDeps = (): DiscoverDeps => ({
  exists: existsSync,
  readdir: readdirSync,
  execFileSync: execFileSync as unknown as DiscoverDeps['execFileSync'],
  homedir,
});

/**
 * 发现 chrome 可执行文件路径（三级 fallback）。
 * @param userPath 用户显式配置（最高优先级，可选）
 * @param deps 注入依赖（测试用）
 * @returns 绝对路径
 * @throws BrowserError(chrome_not_found) 三级都未找到
 */
export function discoverChromeExecutable(userPath?: string, deps: DiscoverDeps = {}): string {
  const d = { ...defaultDeps(), ...deps };

  // 1. 用户配置（最高优先级）
  if (userPath) {
    if (d.exists!(userPath)) return userPath;
    throw new BrowserError('chrome_not_found', `用户配置 executablePath="${userPath}" 不存在`);
  }

  // 2. 系统默认浏览器探测
  const sys = detectDefaultBrowser(d);
  if (sys) return sys;

  // 3. 硬编码候选 + Playwright 缓存
  const hardcoded = findHardcodedCandidate(d);
  if (hardcoded) return hardcoded;

  throw new BrowserError(
    'chrome_not_found',
    'chrome 未找到：请安装 chrome 或在 config 配置 browser.executablePath',
  );
}

/**
 * 探测系统默认浏览器指向的 chromium 系可执行文件。
 * macOS: LaunchServices plist 解析 http handler bundleId → osascript 定位 executable。
 * Linux: xdg-settings get default-web-browser → .desktop Exec → which。
 * Windows: TODO（reg query）。
 */
function detectDefaultBrowser(d: DiscoverDeps): string | undefined {
  const platform = process.platform;
  if (platform === 'darwin') return detectMacDefault(d);
  if (platform === 'linux') return detectLinuxDefault(d);
  // win32: TODO（reg query ...UrlAssociations）
  return undefined;
}

/** macOS 默认浏览器探测（LaunchServices secure plist + osascript） */
function detectMacDefault(d: DiscoverDeps): string | undefined {
  try {
    const plistPath = join(
      d.homedir!(),
      'Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist',
    );
    if (!d.exists!(plistPath)) return undefined;
    // plist 是 bplist，exec plutil 转 json 解析（避免引 bplist-parser 依赖）
    const json = d.execFileSync!('plutil', ['-convert', 'json', '-o', '-', plistPath], {
      timeout: 4000,
    });
    const parsed = JSON.parse(json) as { LSHandlers?: Array<{ LSHandlerURLScheme?: string; LSHandlerRoleAll?: string }> };
    const handlers = parsed.LSHandlers ?? [];
    const bundleId =
      handlers.find((h) => h.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll ??
      handlers.find((h) => h.LSHandlerURLScheme === 'http')?.LSHandlerRoleAll;
    if (!bundleId || !CHROMIUM_BUNDLE_IDS.has(bundleId)) return undefined;
    // osascript 拿 .app 路径
    const appPath = d
      .execFileSync!('osascript', ['-e', `tell application "Finder" to application file id "${bundleId}" as text`], {
        timeout: 4000,
      })
      .trim()
      .replace(/:$/, '/');
    if (!appPath) return undefined;
    // .app 目录 → 可执行文件（CFBundleExecutable，默认与 bundle name 同）
    const execName = readBundleExecutable(bundleId, appPath, d);
    const execPath = join(posixAppPath(appPath), 'Contents', 'MacOS', execName);
    return d.exists!(execPath) ? execPath : undefined;
  } catch {
    return undefined;
  }
}

/** 从 Info.plist 读 CFBundleExecutable（失败回退 bundleId 末段） */
function readBundleExecutable(bundleId: string, appPath: string, d: DiscoverDeps): string {
  try {
    const infoPlist = join(posixAppPath(appPath), 'Contents', 'Info.plist');
    const json = d.execFileSync!('plutil', ['-convert', 'json', '-o', '-', infoPlist], { timeout: 4000 });
    const info = JSON.parse(json) as { CFBundleExecutable?: string };
    if (info.CFBundleExecutable) return info.CFBundleExecutable;
  } catch {
    /* ignore */
  }
  return bundleId.split('.').pop() ?? 'chrome';
}

/** "Macintosh HD:Users:...:Google Chrome.app:" → "/Users/.../Google Chrome.app" */
function posixAppPath(appPath: string): string {
  let p = appPath.replace(/:$/, '');
  if (p.startsWith('Macintosh HD')) p = p.slice('Macintosh HD'.length);
  return p.replace(/:/g, '/');
}

/** Linux 默认浏览器探测（xdg-settings → .desktop → which） */
function detectLinuxDefault(d: DiscoverDeps): string | undefined {
  try {
    const desktop = d.execFileSync!('xdg-settings', ['get', 'default-web-browser'], { timeout: 4000 }).trim();
    if (!desktop) return undefined;
    // 在标准 applications 目录找 .desktop
    const dirs = [
      join(d.homedir!(), '.local/share/applications', desktop),
      `/usr/share/applications/${desktop}`,
    ];
    const file = dirs.find((p) => d.exists!(p));
    if (!file) return undefined;
    const content = readFileSync(file, 'utf8');
    // 解析首个非 TryExec 的 Exec= 行
    const execLine = content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('Exec=') && !l.startsWith('TryExec='))[0];
    if (!execLine) return undefined;
    const cmd = execLine.slice('Exec='.length).split(/\s+/)[0];
    if (!cmd) return undefined;
    // which 解析（绝对路径直接验存在）
    if (cmd.startsWith('/')) return d.exists!(cmd) ? cmd : undefined;
    const resolved = d.execFileSync!('which', [cmd], { timeout: 4000 }).trim().split('\n')[0];
    return resolved && d.exists!(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

/** 硬编码候选 + Playwright 缓存 fallback */
function findHardcodedCandidate(d: DiscoverDeps): string | undefined {
  const platform = process.platform;
  const candidates: string[] = [];
  if (platform === 'darwin') {
    candidates.push(...MAC_CANDIDATES);
    // 系统候选优先，playwright postinstall 装的 chromium 兜底
    candidates.push(...playwrightChromiumCandidatesMac(d));
  }
  if (platform === 'linux') {
    candidates.push(...LINUX_CANDIDATES);
    candidates.push(...playwrightChromiumCandidatesLinux(d));
  }
  return candidates.find((p) => d.exists!(p));
}

/**
 * 列出 ms-playwright 缓存目录下的 chromium-* 子目录名。
 * 用 readdirSync 替代 execFileSync('ls',[glob])——execFileSync 不经 shell，
 * ls 收到的是字面 glob 不展开（v0.0.225 修复）。目录不存在/读取失败返 []。
 * 不验证 chrome 二进制存在，由调用方 existsSync 验证（findHardcodedCandidate 的 find）。
 */
function listChromiumDirs(d: DiscoverDeps, base: string): string[] {
  try {
    return d.readdir!(base).filter((name) => name.startsWith('chromium-'));
  } catch {
    return [];
  }
}

/** Playwright 缓存的 chromium（Linux: ~/.cache/ms-playwright/chromium-VERSION/chrome-linux/chrome） */
function playwrightChromiumCandidatesLinux(d: DiscoverDeps): string[] {
  const base = join(d.homedir!(), '.cache', 'ms-playwright');
  return listChromiumDirs(d, base).map((dir) => join(base, dir, 'chrome-linux', 'chrome'));
}

// Playwright postinstall 装的 chromium：macOS 兜底。
// 实际形态：~/Library/Caches/ms-playwright/chromium-<ver>/chrome-mac-arm64|chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
// 新版 playwright 用 "Google Chrome for Testing" 而非 Chromium；arm64/intel 两种 arch 都列举，由调用方 existsSync 验证。
function playwrightChromiumCandidatesMac(d: DiscoverDeps): string[] {
  const base = join(d.homedir!(), 'Library', 'Caches', 'ms-playwright');
  const execRel = join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  const dirs = listChromiumDirs(d, base);
  const out: string[] = [];
  for (const dir of dirs) {
    out.push(join(base, dir, 'chrome-mac-arm64', execRel));
    out.push(join(base, dir, 'chrome-mac', execRel));
  }
  return out;
}
