/**
 * chrome 启动参数构造（mode ①② PlaywrightDriver launch）
 * 参考: specs/research/v0.0.23-browser-use.md §2.3（buildOpenClawChromeLaunchArgs）
 *       specs/tech/agent/tools/[P1]browser_tool.md §3
 *
 * 参数集：
 *   --remote-debugging-port --user-data-dir（核心）
 *   --no-first-run --no-default-browser-check --disable-sync --disable-background-networking
 *   --disable-component-update --disable-features=Translate,MediaRouter --disable-session-crashed-bubble
 *   --hide-crash-restore-bubble --password-store=basic --no-proxy-server
 *   --headless=new --disable-gpu（headless 时，Chrome 109+ 新无头）
 *   --no-sandbox（按需） --disable-dev-shm-usage（linux）
 *
 * headless 解析优先级：request override > env OPENCLAW_BROWSER_HEADLESS > profile config
 *   > Linux 无 $DISPLAY/$WAYLAND_DISPLAY 自动 fallback headless > default
 */

/** 启动参数构造入参 */
export interface LaunchArgsInput {
  /** CDP 端口（--remote-debugging-port） */
  cdpPort: number;
  /** userDataDir（--user-data-dir） */
  userDataDir: string;
  /** 请求级 headless 覆盖（来自 connect opts） */
  headlessOverride?: boolean;
  /** Linux 无显示时强制 headless（探测后传入，避免本文件耦合 env） */
  linuxNoDisplay?: boolean;
  /** 是否启用 --no-sandbox（如 root 容器场景） */
  noSandbox?: boolean;
}

/**
 * 推断是否在无 GUI 环境（Linux 无 $DISPLAY/$WAYLAND_DISPLAY）。
 * 单独导出便于测试 mock env。
 */
export function isHeadlessForcedByLinuxEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  if (platform !== 'linux') return false;
  return !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

/**
 * 解析最终 headless 开关（优先级链）。
 *   1. 请求级 override（显式 true/false）
 *   2. env ROCKY_BROWSER_HEADLESS
 *   3. Linux 无显示自动 headless
 *   4. 默认 false（有头）
 */
export function resolveHeadless(input: {
  headlessOverride?: boolean;
  linuxNoDisplay?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (typeof input.headlessOverride === 'boolean') return input.headlessOverride;
  const env = input.env ?? process.env;
  const envVal = env.ROCKY_BROWSER_HEADLESS;
  if (envVal === '1' || envVal === 'true') return true;
  if (envVal === '0' || envVal === 'false') return false;
  if (input.linuxNoDisplay) return true;
  return false;
}

/** 默认参数集（除 headless/sandbox 外的固定项） */
const BASE_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-features=Translate,MediaRouter',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble',
  '--password-store=basic',
  '--no-proxy-server',
];

/**
 * 构造 chrome 启动参数数组（mode ①② launch）。
 * @returns 参数数组（不含可执行文件路径，由调用方拼接）
 */
export function buildChromeLaunchArgs(input: LaunchArgsInput): string[] {
  const headless = resolveHeadless({
    headlessOverride: input.headlessOverride,
    linuxNoDisplay: input.linuxNoDisplay,
  });

  const args: string[] = [
    `--remote-debugging-port=${input.cdpPort}`,
    `--user-data-dir=${input.userDataDir}`,
    ...BASE_FLAGS,
  ];

  if (headless) {
    args.push('--headless=new');
    args.push('--disable-gpu');
  }
  if (input.noSandbox) {
    args.push('--no-sandbox');
  }
  if (process.platform === 'linux') {
    args.push('--disable-dev-shm-usage');
  }
  return args;
}

/** 给单测用：默认 base flags 数量（断言稳定） */
export const BASE_FLAGS_COUNT = BASE_FLAGS.length;
