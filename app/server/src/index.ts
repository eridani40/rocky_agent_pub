/**
 * @app/server 进程入口 — 用 node:http 启动 /counter HTTP API（运行时可移植）
 * 参考: specs/api/overall/01-counter.md §2.1（监听 127.0.0.1:API_PORT）
 *       specs/tech/app/envs/[P0]environments.md §3.1（API_PORT 来自 env）
 *       specs/tech/app/package/[P0]package_structure.md §3.3（server 零 electron）
 *       本 task 指令（Bun.serve → node:http：dev 用 bun、packaged 用 Electron Node 主进程，同一份代码）
 *
 * 启动流程：loadConfig → startServer({ apiPort, dataDir })（node:http）。
 * 由 API_START_CMD=bun run app/server/src/index.ts 拉起（tests/api/env_start.sh），
 * 或由 Electron 主进程 packaged 模式 import { startServer } 调用（见 @app/electron main.ts）。
 *
 * 运行时可移植：node:http 在 Node 与 Bun 均原生可用，故此入口既可由 bun 跑（dev），
 * 也可编译后由 Node 直接 require（packaged Electron 主进程）。
 */
export { startServer } from './http-server';
export type { StartedServer, StartServerOptions } from './http-server';
// v0.0.10：observability flush（electron before-quit 调用；@app/electron/main.ts require 本模块）
export { shutdownObservability } from './observability/index';
// 事件循环卡顿监控（@app/electron 主进程复用同一实现；server 侧由 http-server.startServer 自接）
export { startEventLoopMonitor } from './observability/index';
export type { EventLoopMonitorOptions, EventLoopMonitorHandle } from './observability/index';
// v0.0.105：computer use 原生能力端口注入 seam（@app/electron main.ts packaged 分支调 setter 注入
// makeElectronComputerNativePort()；dev/AT 不经此，走 loopback/mock env 解析，见 bootstrap precedence）。
export { setComputerNativePort } from './platform/computer/native-port-registry';
export type {
  ComputerNativePort,
  ComputerPermissions,
  ComputerScreenshotResult,
  ComputerScreenshotOptions,
} from './platform/computer/native-port';

import { startServer as start } from './http-server';
import { getConfig } from './config';
import { shutdownObservability } from './observability/index';

/**
 * 进程直接运行入口（bun run src/index.ts 或 node dist/index.js）。
 * 仅当本文件作为主模块时启动（被 import 时不自动起服务，由 Electron 显式调 startServer）。
 */
async function main(): Promise<void> {
  const cfg = getConfig();
  await start({ apiPort: cfg.apiPort, dataDir: cfg.dataDir });
}

/**
 * v0.0.10：node server 优雅关停 — 收到 SIGTERM/SIGINT 后强制 flush observability。
 * 背景：shutdownObservability() 原仅接在 electron before-quit，node server（test/prod）
 *   收 kill 时不 flush → langfuse SDK 末尾 batch trace 丢（API verifier 实测需 server
 *   存活 ≥12s 靠 SDK 定时 flush，否则丢）。注册本 handler 后，kill 立即 flush，不再
 *   依赖存活时长。
 * 红线：handler 仅做 flush+exit，不影响正常运行；observability 仍 safe（flush 失败也退出，
 *   不抛进主流程）。仅当本模块作为 main（直跑 server，非 Electron require）时注册——
 *   Electron packaged 模式 isMain=false，electron before-quit 自行 flush。
 * @param sig 信号名（用于日志）
 */
async function gracefulShutdown(sig: NodeJS.Signals): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[server] received ${sig}, flushing observability before exit`);
  try {
    await shutdownObservability();
  } catch {
    // 静默：flush 失败不阻塞退出（核心红线：observability 不影响关停）
  }
  process.exit(0);
}

// 检测是否作为入口模块运行（避免被 import/require 时自动起服务）。
// 三种运行场景：
//   ① bun run src/index.ts（dev/test）：ESM，import.meta.main（bun 专属）
//   ② node dist/index.js（Node 直跑）：CJS，require.main === module
//   ③ Electron require('@app/server')（packaged）：被 require，非 main，不起服务
// 用 process.argv[1] 末段匹配入口文件名作为通用判据（三场景均成立）。
const entryArg = process.argv[1] ?? '';
const isMain =
  // CJS 场景：require.main === module（编译产物 dist/index.js 由 node 直跑）
  (typeof require !== 'undefined' && require.main === module) ||
  // 通用兜底：argv[1] 末段含 'index'（bun run src/index.ts 或 node dist/index.js）
  /[/\\]index\.[jt]s$/.test(entryArg);

if (isMain) {
  void main();
  // v0.0.10：node server 优雅关停信号 handler（flush observability 后 exit）
  // Electron packaged 模式不会进此分支（isMain=false），其 before-quit 自行 flush。
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
}
