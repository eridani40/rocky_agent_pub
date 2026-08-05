/**
 * chrome 进程 launcher（mode ①② 共用：spawn chrome 进程 + 等 CDP 就绪 + connectOverCDP）
 * 参考: specs/research/v0.0.23-browser-use.md §2.3
 *       specs/tech/agent/tools/[P1]browser_tool.md §3
 *
 * 流程：ensureProfileFree → mkdir userDataDir → spawn chrome(buildChromeLaunchArgs)
 *      → waitForCdpReady → chromium.connectOverCDP → 返回 { browser, kill }
 * 关闭由调用方在 session.close() 时 kill chrome 进程。
 *
 * 进程与连接治理：
 *   - spawn detached:true 建进程组，killChild 用 process.kill(-pgid,'SIGKILL') 清进程树
 *     （renderer/GPU/network-service 子进程一并清，避免僵尸 chrome 占端口）
 *   - connectOverCDP 缩短 timeout + 一次 kill+relaunch 重试（连僵尸死 WS 时自愈）
 *   - spawn stdio:'pipe' 捕获 chrome stderr，失败时拼进 errorDetail 利排障
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { discoverChromeExecutable, type DiscoverDeps } from './chrome-discover';
import { buildChromeLaunchArgs } from './launch-args';
import { waitForCdpReady, cdpEndpointUrl } from './cdp-ready';
import { ensureProfileFree } from './singleton-lock';
import { isHeadlessForcedByLinuxEnv } from './launch-args';
import { BrowserError } from './types';

/** launcher 入参 */
export interface ChromeLaunchInput {
  /** chrome 可执行文件路径（覆盖自动发现） */
  executablePath?: string;
  /** 持久 profile userDataDir（mode ②）；mode ① 用临时目录 */
  userDataDir: string;
  /** CDP 端口 */
  cdpPort: number;
  /** 请求级 headless 覆盖 */
  headless?: boolean;
  /** 是否持久 profile（决定是否做 SingletonLock 检测） */
  persistent: boolean;
}

/** launcher 产出 */
export interface ChromeLaunchResult {
  /** playwright Browser 实例（已 connectOverCDP） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  browser: any;
  /** 杀掉 chrome 子进程（session.close 用） */
  kill: () => Promise<void>;
}

/** connectOverCDP 单次尝试超时（ms）。默认 15s（BUG-001：原 30s 太长，缩短 + 重试） */
export const CONNECT_CDP_TIMEOUT_MS = 15_000;

/** 可注入依赖（测试 mock spawn/playwright/discover） */
export interface LaunchDeps extends DiscoverDeps {
  spawn?: (cmd: string, args: string[]) => ChildProcess;
  connectCDP?: (endpoint: string, timeoutMs?: number) => Promise<unknown>;
  waitForCdp?: (port: number) => Promise<void>;
}

/**
 * 启动 chrome 进程并 connectOverCDP（mode ①②）。
 * connectOverCDP 失败一次自动 kill+relaunch 重试（BUG-001：僵尸 chrome 占端口自愈）。
 * @returns { browser, kill }；browser 是 playwright Browser
 */
export async function launchChromeAndConnect(
  input: ChromeLaunchInput,
  deps: LaunchDeps = {},
): Promise<ChromeLaunchResult> {
  // 1. 发现 chrome 可执行文件
  const executable = discoverChromeExecutable(input.executablePath, deps);

  // 首次尝试；失败（非 spawn 错，即 chrome 起来但 CDP/WS 异常）→ kill 后重试一次
  try {
    return await tryLaunch(input, executable, deps);
  } catch (e) {
    // spawn 失败（chrome_not_found / launch_failed spawn 抛错）不重试（重试也是同样错）
    if (e instanceof BrowserError && e.kind === 'launch_failed' && !isConnectFailure(e)) {
      throw e;
    }
    // CDP/WS 失败：kill 残留 chrome，重试一次（换更干净状态）
    const firstMsg = e instanceof Error ? e.message : String(e);
    try {
      return await tryLaunch(input, executable, deps);
    } catch (e2) {
      const secondMsg = e2 instanceof Error ? e2.message : String(e2);
      throw new BrowserError(
        'launch_failed',
        `connectOverCDP 重试仍失败（首次: ${firstMsg}; 二次: ${secondMsg}）`,
      );
    }
  }
}

/** 判断错误是否来自 connect/CDP 阶段（可重试），而非 spawn 阶段 */
function isConnectFailure(e: BrowserError): boolean {
  // connectOverCDP 失败 / cdp_timeout 属于 chrome 起来后阶段，可重试
  return e.message.includes('connectOverCDP') || e.kind === 'cdp_timeout';
}

/** 单次 launch 尝试：spawn → waitForCdp → connectOverCDP */
async function tryLaunch(
  input: ChromeLaunchInput,
  executable: string,
  deps: LaunchDeps,
): Promise<ChromeLaunchResult> {
  // 持久 profile：先确保不被占用（清僵尸锁 + 活锁报错）
  if (input.persistent) {
    ensureProfileFree(input.userDataDir);
  }
  mkdirSync(input.userDataDir, { recursive: true });

  // 构造启动参数
  const args = buildChromeLaunchArgs({
    cdpPort: input.cdpPort,
    userDataDir: input.userDataDir,
    headlessOverride: input.headless,
    linuxNoDisplay: isHeadlessForcedByLinuxEnv(),
  });

  // spawn chrome（detached 建进程组；stdio pipe 捕 stderr 利排障）
  const spawnFn =
    deps.spawn ?? ((cmd: string, a: string[]) => spawnChromeProcess(cmd, a));
  let child: ChildProcess;
  try {
    child = spawnFn(executable, args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new BrowserError('launch_failed', `chrome 启动失败: ${withChromiumHint(msg)}`);
  }

  // 收集 chrome stderr（失败时拼进 errorDetail；正常退出时丢弃）
  const stderrBuf = collectStderr(child);

  // 等 CDP 就绪
  const waitForCdp = deps.waitForCdp ?? ((port: number) => waitForCdpReady(port));
  try {
    await waitForCdp(input.cdpPort);
  } catch (e) {
    killProcessGroup(child);
    const tail = readStderrTail(stderrBuf);
    const baseMsg = e instanceof Error ? e.message : String(e);
    throw new BrowserError(
      'cdp_timeout',
      tail ? `${baseMsg}（chrome stderr 尾: ${tail}）` : baseMsg,
    );
  }

  // connectOverCDP（playwright chromium）
  const connectCDP = deps.connectCDP ?? defaultConnectCDP;
  let browser: unknown;
  try {
    browser = await connectCDP(cdpEndpointUrl(input.cdpPort), CONNECT_CDP_TIMEOUT_MS);
  } catch (e) {
    killProcessGroup(child);
    const msg = e instanceof Error ? e.message : String(e);
    throw new BrowserError('launch_failed', `connectOverCDP 失败: ${withChromiumHint(msg)}`);
  }

  return {
    browser,
    kill: async () => {
      killProcessGroup(child);
    },
  };
}

/** 默认 spawn：detached 进程组 + stdio pipe（捕 stderr） */
function spawnChromeProcess(cmd: string, a: string[]): ChildProcess {
  return spawn(cmd, a, {
    detached: true, // 新进程组（pgid = child.pid），便于 kill 进程树
    stdio: ['ignore', 'ignore', 'pipe'], // 捕获 stderr 利排障
  });
}

/**
 * 杀进程组（BUG-001 修复核心）：用 process.kill(-pgid, 'SIGKILL') 清整个进程树。
 * chrome 父进程被 SIGTERM 后 renderer/GPU/network-service 子进程可能不被波及，
 * 改 SIGKILL 进程组确保全部清掉，避免僵尸 chrome 占端口/profile。
 * 兼容 chrome 已退出（ESRCH catch）。
 */
export function killProcessGroup(child: ChildProcess): void {
  try {
    if (child.pid && !child.killed) {
      // 负 pid = 进程组（detached spawn 时 pgid = child.pid）
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // 进程组 kill 失败（可能子进程已脱离组），fallback 杀父进程
        child.kill('SIGKILL');
      }
    }
  } catch {
    /* ignore — 进程已退出 */
  }
}

/** 兼容旧名（killChild → killProcessGroup） */
export const killChild = killProcessGroup;

/** 收集 chrome stderr（最多 8KB，避免溢出） */
function collectStderr(child: ChildProcess): string[] {
  const buf: string[] = [];
  const MAX = 8 * 1024;
  try {
    const stderr = (child as { stderr?: NodeJS.ReadableStream | null }).stderr;
    if (!stderr) return buf;
    let total = 0;
    stderr.on('data', (chunk: Buffer | string) => {
      if (total >= MAX) return;
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      total += s.length;
      buf.push(s);
    });
  } catch {
    /* ignore */
  }
  return buf;
}

/** 取 stderr 缓存尾（最后 500 字符，去换行）用于错误诊断 */
function readStderrTail(buf: string[]): string {
  if (buf.length === 0) return '';
  const joined = buf.join('');
  return joined.slice(-500).replace(/\n+/g, ' ').trim();
}

/** 默认 connectOverCDP：playwright chromium，带 timeout（BUG-001：缩短 + 重试） */
const defaultConnectCDP = async (endpoint: string, timeoutMs?: number): Promise<unknown> => {
  // 延迟 require playwright（避免 typecheck/无 chrome 环境失败）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { chromium } = require('playwright') as typeof import('playwright');
  // playwright connectOverCDP 不直接支持 timeout 入参，用 Promise.race 实现
  const task = chromium.connectOverCDP(endpoint);
  if (!timeoutMs) return task;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`connectOverCDP: Timeout ${timeoutMs}ms exceeded.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * chromium 缺失特征匹配（playwright 抛 "Executable doesn't exist" /
 * "browserType.launch" / chromium not found 时）。
 * 命中则追加安装引导，否则原样返回。
 */
export function withChromiumHint(msg: string): string {
  const CHROMIUM_MISSING_PATTERNS = [
    "Executable doesn't exist",
    'browserType.launch',
    'chromium' + ' not found',
    'chromium-',
  ];
  const hit = CHROMIUM_MISSING_PATTERNS.some((p) => msg.includes(p));
  if (!hit) return msg;
  return `${msg}\nchromium 未安装，请运行 \`bunx playwright install chromium\`（首次 bun install 会自动拉取，离线/受限环境可手动执行）`;
}
