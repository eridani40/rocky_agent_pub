/**
 * chrome-version —— 本机 Chrome 版本探测（只读，best-effort 不抛）
 * 参考: specs/tech/version_logs/v0.0.334/change_plan.md A14
 *       chrome-discover.ts（发现 chrome 可执行文件三级 fallback）
 *
 * attach 失败时探测本机 Chrome 版本做差异化引导（chrome-mcp-driver connect 错误消息）：
 *   - 版本存在且 <144 → 「请升级 Chrome」（chrome://inspect 远调模式是 144+ 能力）；
 *   - ≥144 或探测失败 → 现有引导（开启/批准 remote debugging）。
 * 只读探测不启动 chrome（execFileSync --version，不带 --remote-debugging-port）；
 * 超时/异常/未找到/非 chrome 输出 → undefined，不阻断 attach 主流程。
 */
import { execFileSync } from 'node:child_process';
import { discoverChromeExecutable } from './chrome-discover';

/** 可注入依赖（UT mock；生产默认真实 node API，对齐 chrome-discover DiscoverDeps 模式） */
export interface ChromeVersionDeps {
  /** execFileSync 注入（UT 不真跑 chrome --version） */
  execFileSync?: (cmd: string, args: string[], opts?: { timeout?: number }) => string | Buffer;
  /** chrome 二进制发现注入（UT mock 抛/返回） */
  discover?: () => string;
}

const defaultDeps = (): ChromeVersionDeps => ({
  execFileSync: execFileSync as unknown as ChromeVersionDeps['execFileSync'],
  discover: () => discoverChromeExecutable(),
});

/**
 * 探测本机 Chrome 主版本号（best-effort）。
 * @param executablePath 显式 chrome 可执行文件路径（缺省 → chrome-discover 自动发现）
 * @param deps 可注入依赖（UT mock execFileSync/discover）
 * @returns 主版本号（如 144）；探测失败/未找到/非 chrome → undefined（不抛）
 */
export async function detectChromeVersion(
  executablePath?: string,
  deps: ChromeVersionDeps = {},
): Promise<number | undefined> {
  const d = { ...defaultDeps(), ...deps };
  try {
    let chromePath: string | undefined = executablePath;
    if (!chromePath) {
      try {
        chromePath = d.discover!();
      } catch {
        return undefined; // 未发现 chrome 二进制（chrome-discover 抛 chrome_not_found）
      }
    }
    if (!chromePath) return undefined; // 防御：discover 返回空（类型收窄守卫）
    // `Chrome --version` 输出形如 "Google Chrome 144.0.6783.2"；解析首段主版本号
    const out = d.execFileSync!(chromePath, ['--version'], { timeout: 4000 }).toString();
    const m = /Chrome\s+(\d+)\./.exec(out);
    if (!m) return undefined; // 非 chrome 输出（Chromium/Edge 等不含 "Chrome" 字样 → 视为不可判）
    const major = m[1];
    return major !== undefined ? Number.parseInt(major, 10) : undefined;
  } catch {
    return undefined; // 超时/异常 → best-effort 不阻断 attach 主流程
  }
}
