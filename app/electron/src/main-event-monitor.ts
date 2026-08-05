/**
 * Electron 主进程事件循环卡顿监控接线（v0.0.254）
 * 参考: app/server/src/observability/event-loop-monitor.ts 模块头（共享实现设计要点）
 *       v0.0.254 task 指令（三进程卡顿监控之 electron-main 侧）
 *
 * 设计要点：
 *   - 复用 @app/server 导出的 startEventLoopMonitor（同一实现，server/electron 共用）。
 *   - env 开关用 MAIN_EVENT_LOOP_MONITOR，与 server 进程的 EVENT_LOOP_MONITOR **区分**：
 *     packaged 下后端内嵌主进程（backend-bootstrap.startBackend → startServer 也接了一个
 *     source='server' 的监控），两者采样的是**同一条 event loop**——若共用一个 env，
 *     一次卡顿两进程各写一份 profile 重复抓。调试主进程卡顿开 MAIN_* 即可。
 *   - profile 目录 = <resolveDataDir(env)>/profiles/（复用 @app/server config.resolveDataDir
 *     唯一权威，已展开 ~ —— BUG-004 护栏，禁字面 ~）；文件名 source='electron-main' 前缀
 *     与 server 的 'server' 前缀区分（packaged 同机同目录）。
 *   - 默认动态 require（非顶层 import）：让 electron 单测无需 server dist 构建即可跑
 *     （测试注入替身），也避免 dev 模式模块加载副作用。
 *   - 失败静默：任何一步（require 失败 / resolveDataDir 抛错 / start 抛错）只 log 不 throw，
 *     绝不影响主进程启动（观测红线）。
 */
import { join } from 'node:path';
// import type 编译期擦除（无运行时 require），契约与真身同步不漂移
import type { EventLoopMonitorOptions } from '@app/server';

/** 可注入依赖（UT mock；生产缺省动态 require @app/server） */
export interface MainEventMonitorDeps {
  /** 同 @app/server startEventLoopMonitor（测试注入 spy） */
  startMonitor?: (opts: EventLoopMonitorOptions) => unknown;
  /** dataDir 解析器（默认 @app/server config.resolveDataDir；测试注入替身） */
  resolveDataDir?: (env: NodeJS.ProcessEnv) => string;
  log?: Pick<Console, 'info' | 'error'>;
}

/**
 * 启动主进程事件循环卡顿监控（默认关，MAIN_EVENT_LOOP_MONITOR=1 开）。
 * 在 main.ts 的 loadRuntimeConfig 之后调用（packaged 下 env 的 DATA_DIR 由 runtime-config 注入）。
 * @param env 进程环境（main.ts 传 process.env；测试可注入）
 */
export function startMainEventLoopMonitor(
  env: NodeJS.ProcessEnv,
  deps: MainEventMonitorDeps = {},
): void {
  const log = deps.log ?? console;
  try {
    const start =
      deps.startMonitor ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('@app/server') as { startEventLoopMonitor?: MainEventMonitorDeps['startMonitor'] })
        .startEventLoopMonitor;
    if (typeof start !== 'function') return; // server dist 未构建等场景静默跳过
    const resolve =
      deps.resolveDataDir ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (require('@app/server/dist/config') as { resolveDataDir: (e: NodeJS.ProcessEnv) => string })
        .resolveDataDir;
    start({
      source: 'electron-main',
      envFlag: 'MAIN_EVENT_LOOP_MONITOR',
      profileDir: join(resolve(env), 'profiles'),
      // env 走 deps 通道（startEventLoopMonitor 只读 options.deps.env，顶层无 env 字段）
      deps: { env },
    });
  } catch (e) {
    // 静默：监控失败绝不影响主进程启动
    // eslint-disable-next-line no-console
    log.error('[main-event-monitor] start failed (ignored):', e);
  }
}
