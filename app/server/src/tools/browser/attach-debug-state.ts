/**
 * attach-debug-state —— attach close 后 Chrome 调试态残留检测（只读，不 kill/不写/不重启）
 * 参考: specs/tech/version_logs/v0.0.330/change_plan.md §11-§16（Delta 3，D3-C）
 *       chrome-devtools-mcp browser.js L62（DevToolsActivePort 机制）
 *
 * 能力边界（change_plan §12 实证）：对用户已开 Chrome 的调试态（9222 监听 + DevToolsActivePort
 * + 提示条）**无编程关闭 API**（chrome-devtools-mcp 无 browser-management 工具；CDP 无关闭调试
 * 端口命令；Browser.close 杀整浏览器违反 attach 语义）。因此 attach close 只能：
 *   1. 回收我们开的资源（MCP 进程/连接/session 缓存）—— attach-mode-impl.close 负责
 *   2. 检测残留 + 返回引导提示（用户 chrome://inspect 取消勾选 / 重启 Chrome）—— 本文件负责
 *
 * 检测判据（保守，不误报）：
 *   - autoConnect-only（v0.0.334 删 cdpUrl）：恒读用户 Chrome user data dir 的 DevToolsActivePort
 *     拿端口 → TCP 探测端口可连 = 残留；探测失败/文件缺失 = 无残留（不误报）
 *   - 只读检测：不 kill 进程、不写文件、不重启 Chrome、不探测用户 Chrome 之外进程
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { netPortBusy, type PortBusyFn } from './cdp-port';

/** 检测结果（residual=true → attach close 返回引导提示） */
export interface DebugResidualResult {
  residual: boolean;
  /** 残留详情（端口/DevToolsActivePort 路径），供提示文本拼接；无残留为空串 */
  detail: string;
}

/** DevToolsActivePort 读取（返回文件第一行=端口；不存在/读失败 → undefined） */
export type ActivePortReader = (filePath: string) => Promise<string | undefined>;

/** 默认实现：同步 fs 读第一行（Chrome 写 DevToolsActivePort 为「端口\nws路径\n」） */
export const readDevToolsActivePort: ActivePortReader = async (filePath: string) => {
  try {
    if (!existsSync(filePath)) return undefined;
    const line = readFileSync(filePath, 'utf8').split('\n')[0]?.trim();
    return line || undefined;
  } catch {
    return undefined; // 读失败（权限/竞态）→ 视为无文件，不阻断
  }
};

/** 各平台默认 Chrome user data dir 下 DevToolsActivePort 候选路径 */
export function devToolsActivePortCandidates(
  home: string,
  platform: string = process.platform,
): string[] {
  if (platform === 'darwin') {
    return [join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort')];
  }
  if (platform === 'linux') {
    return [
      join(home, '.config/google-chrome/DevToolsActivePort'),
      join(home, '.config/chromium/DevToolsActivePort'),
    ];
  }
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData/Local');
    return [join(local, 'Google/Chrome/User Data/DevToolsActivePort')];
  }
  return [];
}

/**
 * 各平台默认 Chrome **user data dir** 候选路径（v0.0.334 fix：attach 补 --userDataDir）。
 * 单一数据源：内部复用 devToolsActivePortCandidates，取 dirname 去掉末尾 /DevToolsActivePort。
 * 返回数组顺序 = 候选优先级（darwin→`~/Library/Application Support/Google/Chrome`；
 * linux→`~/.config/google-chrome`、`~/.config/chromium`；win32→`%LOCALAPPDATA%/Google/Chrome/User Data`）。
 */
export function defaultChromeUserDataDirCandidates(
  home: string,
  platform: string = process.platform,
): string[] {
  return devToolsActivePortCandidates(home, platform).map((p) => dirname(p));
}

/** 探测依赖（测试可注入；生产默认 netPortBusy + readDevToolsActivePort + 真实 home/platform） */
export interface DetectDeps {
  probePort?: PortBusyFn;
  readActivePort?: ActivePortReader;
  home?: string;
  platform?: string;
}

/**
 * 检测 attach close 后 Chrome 调试态是否残留（只读，autoConnect-only 恒检测）。
 * @param env ModeImplEnv（dataDir 保留对齐 change_plan 签名；实际读用户 Chrome user data dir）
 * @param _ah attach handle（v0.0.334 删 cdpUrl 后仅保留占位，恒按默认 user data dir 检测）
 * @param deps 可注入探测依赖（UT mock TCP/文件）
 * @returns residual=true 时 detail 含端口 + DevToolsActivePort 路径
 */
export async function detectChromeDebugResidual(
  env: { dataDir: string },
  _ah: object,
  deps: DetectDeps = {},
): Promise<DebugResidualResult> {
  void env;
  void _ah;

  const probePort = deps.probePort ?? netPortBusy;
  const readActivePort = deps.readActivePort ?? readDevToolsActivePort;
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;

  for (const file of devToolsActivePortCandidates(home, platform)) {
    const portText = await readActivePort(file);
    if (!portText) continue; // 该目录无 DevToolsActivePort（未开调试态 / 非默认目录）
    const port = Number.parseInt(portText, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;

    let listening = false;
    try {
      listening = await probePort(port);
    } catch {
      listening = false; // 探测异常 → 保守视为无残留（不误报）
    }
    if (listening) {
      return {
        residual: true,
        detail: `端口 ${port} 仍在监听（${file}）`,
      };
    }
    return { residual: false, detail: '' }; // 文件在但端口不可连 → 无残留
  }
  // 读不到 DevToolsActivePort（未开调试态 / 非默认 user data dir）→ 无法探测，无残留
  return { residual: false, detail: '' };
}
