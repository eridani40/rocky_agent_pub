/**
 * 后端启动桥 — Electron 主进程在 packaged 模式下用 node:http 起 @app/server
 * 参考: specs/tech/app/package/[P0]package_structure.md §4.3
 *       本 task 指令（packaged 用 node:http 在主进程跑后端；dev 不起）
 *
 * 设计：
 *   - shouldStartBackend(env)：纯函数，判断是否需要主进程起后端。
 *       dev（VITE_DEV_SERVER_URL 非空）→ false（外部 bun 进程跑后端）。
 *       packaged（无 VITE_DEV_SERVER_URL）→ true（主进程 node:http 起）。
 *   - resolveServerOpts(env, resolveDataDir?)：从 env 派生 apiPort/dataDir。
 *       dataDir 复用 @app/server config.resolveDataDir（展开前导 ~ + 未设时回退派生同一权威），
 *       满足 StartServerOptions.dataDir「绝对路径」契约（BUG-004 根因即此处未展开 ~，机制见下方内联注释）。
 *   - startBackend(env, starter?, resolveDataDir?)：调 resolveServerOpts 派生参数后启动注入的 startServer。
 *       starter / resolveDataDir 默认从 @app/server 动态 require（避免 dev 单测时强依赖 server dist）。
 *
 * 抽离自 main.ts 的原因：让后端启动决策与参数派生可单测（无需 Electron runtime）。
 */

/** 注入的 startServer 签名（与 @app/server 的 startServer 一致，便于 mock） */
export interface ServerStarter {
  (opts: { apiPort: number; dataDir: string }): Promise<{ port: number; close: () => void }>;
}

/**
 * dataDir 解析器签名（与 @app/server config.resolveDataDir 一致，便于注入/mock）。
 * 入参 env，返回展开前导 ~ 后的绝对 dataDir。
 */
export type DataDirResolver = (env: NodeJS.ProcessEnv) => string;

/**
 * 默认 dataDir 解析器：动态 require @app/server config 的 resolveDataDir。
 * 复用 server 端唯一权威（展开前导 ~ + 未设时回退派生 ~/.{APP_NAME}_{APP_ENV} 并展开），
 * 使 packaged 与 dev/CLI 走同一展开逻辑，满足 StartServerOptions.dataDir「绝对路径」契约。
 * 动态 require（非顶层 import）：让 electron 单测无需 server dist 构建即可跑（测试注入替身）。
 */
function defaultResolveDataDir(env: NodeJS.ProcessEnv): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('@app/server/dist/config').resolveDataDir as DataDirResolver)(env);
}

/**
 * 解析 server 启动参数（apiPort/dataDir）。
 * @param env 进程环境（main.ts 传 process.env；测试可注入）
 * @param resolveDataDir dataDir 解析器（默认复用 @app/server config.resolveDataDir；测试可注入替身）
 * @returns { apiPort, dataDir }，dataDir 为已展开的绝对路径
 *
 * 缺 API_PORT 或端口非法时抛错（不让进程静默用错端口）。
 */
export function resolveServerOpts(
  env: NodeJS.ProcessEnv,
  resolveDataDir: DataDirResolver = defaultResolveDataDir,
): {
  apiPort: number;
  dataDir: string;
} {
  const rawPort = env.API_PORT;
  if (!rawPort) {
    throw new Error(
      'backend-bootstrap: 缺 API_PORT 环境变量（packaged 模式需 prod.env 提供，参考 environments.md §3.1）',
    );
  }
  const apiPort = Number.parseInt(rawPort, 10);
  if (!Number.isFinite(apiPort) || apiPort <= 0 || apiPort > 65535) {
    throw new Error(`backend-bootstrap: API_PORT="${rawPort}" 不是合法端口（1-65535）`);
  }
  // dataDir 复用 @app/server config.resolveDataDir 权威：展开前导 ~ + 未设时回退
  // ~/.{APP_NAME}_{APP_ENV}（同样展开）。禁止在此重复拼接字面 ~（那正是 BUG-004 根因：
  // packaged cwd=/ 下 mkdirSync('/~/...') EACCES → 每请求 500）。
  const dataDir = resolveDataDir(env);
  return { apiPort, dataDir };
}

/**
 * 判断是否需要主进程起后端。
 * @param env 进程环境（main.ts 传 process.env；测试可注入）
 * @returns dev（VITE_DEV_SERVER_URL 非空）→ false；packaged → true
 */
export function shouldStartBackend(env: NodeJS.ProcessEnv): boolean {
  const devUrl = env.VITE_DEV_SERVER_URL;
  return !devUrl || devUrl.trim() === '';
}

/**
 * 在主进程启动 node:http 后端。
 * @param env   进程环境（main.ts 传 process.env）
 * @param starter 可注入的 startServer（默认动态 require @app/server）
 * @param resolveDataDir 可注入的 dataDir 解析器（默认复用 @app/server config.resolveDataDir）
 * @returns StartedServer 句柄（含 close）
 *
 * 默认动态 require 而非顶层 import：让单测无需 server dist 即可跑；
 * 也避免 dev 模式（不会执行 startBackend 时）被 server 模块加载副作用影响。
 */
export async function startBackend(
  env: NodeJS.ProcessEnv,
  starter?: ServerStarter,
  resolveDataDir?: DataDirResolver,
): Promise<{ port: number; close: () => void }> {
  const opts = resolveServerOpts(env, resolveDataDir);
  const start =
    starter ??
    // 动态 require：CJS 编译后 @app/server main = dist/index.js（node:http 实现）
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    (require('@app/server').startServer as ServerStarter);
  return start(opts);
}
