/**
 * 事件循环卡顿（hang）监控 — monitorEventLoopDelay 周期采样 + 超阈值抓 inspector CPU profile
 * 参考: v0.0.254 task 指令（跨三进程卡顿自动抓捕现场：server / electron-main / renderer）
 *       specs/tech/agent/observability/[P0]overall.md（observability 模块归属与「不影响主流程」红线）
 *
 * 设计要点：
 *   - 双 runtime 兼容：dev=Bun 直跑源码 / packaged=Electron Node 主进程跑编译产物，同一份代码。
 *     perf_hooks.monitorEventLoopDelay 与 node:inspector 在 Bun 下可用性不确定 → 一律特性检测 +
 *     try/catch；不可用静默降级（info 日志一条），绝不 throw 阻断启动或请求。
 *   - 开关：options.enabled 显式优先；未传时读 deps.env[envFlag]（默认 EVENT_LOOP_MONITOR）。
 *     **默认关**——关时不建直方图、不启 timer，近零开销。
 *   - 采样：setInterval（默认 1s，unref 不拖住进程退出）。每 tick 读直方图 max（ns→ms）作为
 *     本周期最坏事件循环延迟，读完即 reset，保证下一周期独立测量。
 *   - episode 状态机：lag ≥ lagThresholdMs 进入 episode —— 打一条 warn 结构化日志
 *     （lag + process.cpuUsage() 差分 + eventLoopUtilization() 差分）并触发一次 node:inspector
 *     CPU profile（~3s）写盘；episode 内不重复触发；lag 回落 < 阈值退出 episode，
 *     下一次超阈值重新抓捕。profile 同时在飞只许一个（profileInFlight 闸）。
 *   - profile 文件：<profileDir>/<source>-<ISO 时间戳>.cpuprofile（Chrome DevTools
 *     Performance 面板可直接拖入看火焰图）。packaged 下 server / electron-main 用
 *     source 前缀区分同机两进程。
 *   - 依赖均可经 options.deps 注入（UT 用 fake histogram / spy captureProfile / 手动 timer）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// namespace import（非具名 import）：Bun 的 ESM 具名绑定缺失时可能链接期报错，
// namespace 形式下缺失 API 只是 undefined，由下方特性检测兜底。
import * as perfHooks from 'node:perf_hooks';
import type { EventLoopUtilization } from 'node:perf_hooks';
// 卡顿 episode 结构化记录通道（performance.log 接管卡顿，避免 console 蒸发）
import { reportHang } from './hang-sink';

/** 直方图最小接口（perf_hooks.IntervalHistogram 子集；UT 用 fake 实现） */
export interface LoopHistogram {
  /** 本周期观测到的最坏延迟（ns） */
  readonly max: number;
  enable(): void;
  disable(): void;
  reset(): void;
}

/** cpuUsage 采样值（process.cpuUsage() 同形：微秒） */
export interface CpuUsageSample {
  user: number;
  system: number;
}

/** 可注入依赖（生产缺省全走 node 真身；UT 注入 fake/spy） */
export interface EventLoopMonitorDeps {
  /** 直方图工厂；返回 null = 本 runtime 不支持（Bun 降级路径） */
  createHistogram?: () => LoopHistogram | null;
  /** 同 process.cpuUsage(prev?)：传 prev 返相对 prev 的增量（Node 内建差分语义） */
  cpuUsage?: (prev?: CpuUsageSample) => CpuUsageSample;
  /** 同 perf_hooks.eventLoopUtilization(prev?)：传 prev 返增量 ELU */
  elu?: (prev?: EventLoopUtilization) => EventLoopUtilization;
  /** 默认全局 setInterval；返回值只需可能带 unref()（能力探测） */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (timer: unknown) => void;
  /** 抓 CPU profile 写盘（默认 inspector 实现；UT 注入 spy 避免真抓 3s） */
  captureProfile?: (durationMs: number, filePath: string) => Promise<void>;
  now?: () => number;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  env?: NodeJS.ProcessEnv;
}

/** startEventLoopMonitor 入参 */
export interface EventLoopMonitorOptions {
  /** 显式开关；缺省读 env[envFlag]（'1/true/yes/on' 为开）。默认关 */
  enabled?: boolean;
  /** env 开关名，默认 EVENT_LOOP_MONITOR（electron 主进程传 MAIN_EVENT_LOOP_MONITOR 区分） */
  envFlag?: string;
  /** 来源标识（profile 文件名前缀 + 日志 tag），默认 'server' */
  source?: string;
  /** 采样周期 ms，默认 1000 */
  sampleIntervalMs?: number;
  /** lag 阈值 ms，默认 1000（单周期最坏延迟达到即判卡顿） */
  lagThresholdMs?: number;
  /** CPU profile 时长 ms，默认 3000 */
  profileDurationMs?: number;
  /** profile 写盘目录（绝对路径，调用方负责经 resolveDataDir 派生）；缺省只打日志不写盘 */
  profileDir?: string;
  /** 测试/特殊 runtime 依赖注入 */
  deps?: EventLoopMonitorDeps;
}

/** 监控句柄：active=false 表示未启动（开关关 / runtime 不支持），stop 幂等 */
export interface EventLoopMonitorHandle {
  readonly active: boolean;
  stop(): void;
}

const INACTIVE_HANDLE: EventLoopMonitorHandle = { active: false, stop: () => undefined };

/** env 字符串真值判定（'1/true/yes/on' 不区分大小写） */
function isTruthyEnv(v: string | undefined): boolean {
  return !!v && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

/** 文件名安全化（source 只留字母数字/-/_) */
function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 默认直方图工厂：perf_hooks.monitorEventLoopDelay，Bun 下不可用/缺方法 → null 降级 */
function defaultCreateHistogram(): LoopHistogram | null {
  try {
    if (typeof perfHooks.monitorEventLoopDelay !== 'function') return null;
    const h = perfHooks.monitorEventLoopDelay({ resolution: 20 });
    if (typeof h.enable !== 'function' || typeof h.reset !== 'function') return null;
    return h;
  } catch {
    return null;
  }
}

/**
 * 默认 CPU profile 实现：node:inspector Profiler 域抓 durationMs 后写 .cpuprofile。
 * Bun 的 inspector Session 各域方法可能未实现 —— 任何一步失败抛给调用方 catch（记日志，不上抛）。
 */
async function captureCpuProfileViaInspector(durationMs: number, filePath: string): Promise<void> {
  // 动态 import：Bun 下模块为 stub，静态 import 也会让 Session 缺失 —— 统一在这里探测
  const inspector = await import('node:inspector');
  if (typeof inspector.Session !== 'function') return; // 降级：本 runtime 不支持，跳过写盘
  const session = new inspector.Session();
  const post = (method: string): Promise<unknown> =>
    new Promise((resolve, reject) => {
      try {
        session.post(method, (err: Error | null, result?: unknown) =>
          err ? reject(err) : resolve(result),
        );
      } catch (e) {
        reject(e);
      }
    });
  try {
    session.connect();
    await post('Profiler.enable');
    await post('Profiler.start');
    // unref：抓 profile 的等待不拖住进程退出（与采样 timer 同一原则）
    await new Promise((r) => {
      const t = setTimeout(r, durationMs);
      (t as { unref?: () => void }).unref?.();
    });
    const stopped = (await post('Profiler.stop')) as { profile?: unknown } | undefined;
    if (stopped && stopped.profile) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(stopped.profile));
    }
  } finally {
    try {
      session.disconnect();
    } catch {
      // 静默：disconnect 失败无影响
    }
  }
}

/**
 * 启动事件循环卡顿监控。任何失败静默（最多一条日志），绝不 throw。
 * @returns active=false 表示未启动（开关关 / runtime 不支持 monitorEventLoopDelay）
 */
export function startEventLoopMonitor(options: EventLoopMonitorOptions = {}): EventLoopMonitorHandle {
  const deps = options.deps ?? {};
  const log = deps.log ?? console;
  try {
    const env = deps.env ?? process.env;
    const envFlag = options.envFlag ?? 'EVENT_LOOP_MONITOR';
    const enabled = options.enabled ?? isTruthyEnv(env[envFlag]);
    if (!enabled) return INACTIVE_HANDLE;

    const createHistogram = deps.createHistogram ?? defaultCreateHistogram;
    const hist = createHistogram();
    if (!hist) {
      // eslint-disable-next-line no-console
      log.info('[event-loop-monitor] monitorEventLoopDelay 不可用（当前 runtime 不支持），监控静默降级关闭');
      return INACTIVE_HANDLE;
    }
    // enable 由启动方统一调（工厂只建不开，注入的 fake 不需要自带 enable 契约）；
    // 抛错由外层 catch 兜底为 INACTIVE（Bun 半实现场景）
    hist.enable();

    const source = options.source ?? 'server';
    const sampleIntervalMs = options.sampleIntervalMs ?? 1000;
    const lagThresholdMs = options.lagThresholdMs ?? 1000;
    const profileDurationMs = options.profileDurationMs ?? 3000;
    const profileDir = options.profileDir;
    const cpuUsage = deps.cpuUsage ?? ((prev?: CpuUsageSample) => process.cpuUsage(prev));
    const elu =
      deps.elu ??
      ((prev?: EventLoopUtilization) =>
        typeof perfHooks.eventLoopUtilization === 'function'
          ? perfHooks.eventLoopUtilization(prev)
          : ({ idle: 0, active: 0, utilization: 0 } as EventLoopUtilization));
    const setIntervalFn = deps.setIntervalFn ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    const clearIntervalFn =
      deps.clearIntervalFn ?? ((t: unknown) => clearInterval(t as Parameters<typeof clearInterval>[0]));
    const captureProfile = deps.captureProfile ?? captureCpuProfileViaInspector;
    const now = deps.now ?? Date.now;

    // 差分基准：cpuUsage/elu 传上一次绝对值返增量（Node 内建语义），首 tick 以启动值为基准
    let lastCpu: CpuUsageSample | undefined;
    let lastElu: EventLoopUtilization | undefined;
    let inEpisode = false;
    let profileInFlight = false;
    let stopped = false;

    const tick = (): void => {
      if (stopped) return;
      try {
        const lagMs = hist.max / 1e6; // ns → ms
        hist.reset(); // 每 tick reset：下一周期独立测量（episode 退出判定依赖回落读数）
        const cpuAbs = cpuUsage();
        const cpuDiff = lastCpu ? cpuUsage(lastCpu) : cpuAbs;
        lastCpu = cpuAbs;
        const eluNow = elu();
        const eluDiff = lastElu ? elu(lastElu) : eluNow;
        lastElu = eluNow;

        if (lagMs >= lagThresholdMs) {
          if (inEpisode) return; // episode 内不重复触发
          inEpisode = true;
          const tsIso = new Date(now()).toISOString(); // warn 与文件名共用同一时间戳
          // profileFile 派生：reportHang 与 captureProfile 共用；即使 profileInFlight 跳过抓捕也写进 record
          const profileFile = profileDir
            ? join(profileDir, `${sanitizeName(source)}-${tsIso.replace(/[:.]/g, '-')}.cpuprofile`)
            : undefined;
          // eslint-disable-next-line no-console
          log.warn(
            `[event-loop-monitor] ${source} event loop lag=${lagMs.toFixed(0)}ms >= ${lagThresholdMs}ms ` +
              `cpuUser=+${(cpuDiff.user / 1000).toFixed(0)}ms cpuSys=+${(cpuDiff.system / 1000).toFixed(0)}ms ` +
              `elu=${eluDiff.utilization.toFixed(2)} ts=${tsIso}`,
          );
          // 双写 console + LogWriter sink（sink 未注册零短路；开关门禁在 LogWriter.write 内部）
          reportHang({
            kind: 'hang', phase: 'enter', source,
            lagMs: Math.round(lagMs),
            cpuUserMs: Math.round(cpuDiff.user / 1000),
            cpuSysMs: Math.round(cpuDiff.system / 1000),
            elu: eluDiff.utilization, profileFile,
          });
          if (profileDir && !profileInFlight) {
            profileInFlight = true;
            void captureProfile(profileDurationMs, profileFile!)
              .then(() => {
                // eslint-disable-next-line no-console
                log.info(`[event-loop-monitor] cpu profile written: ${profileFile}`);
              })
              .catch((e: unknown) => {
                // eslint-disable-next-line no-console
                log.error('[event-loop-monitor] cpu profile failed:', e);
              })
              .finally(() => {
                profileInFlight = false;
              });
          }
        } else if (inEpisode) {
          inEpisode = false;
          // eslint-disable-next-line no-console
          log.info(`[event-loop-monitor] ${source} lag recovered (<${lagThresholdMs}ms)`);
          reportHang({ kind: 'hang', phase: 'recover', source }); // 恢复信号：仅 source，无当前指标
        }
      } catch {
        // 静默：单次采样失败不影响后续 tick 与主流程
      }
    };

    const timer = setIntervalFn(tick, sampleIntervalMs);
    // unref：监控 timer 不拖住进程退出（Bun/Node Timer 均有 unref，能力探测防精简实现）
    const maybeUnref = timer as { unref?: () => void } | null;
    if (maybeUnref && typeof maybeUnref.unref === 'function') maybeUnref.unref();

    // eslint-disable-next-line no-console
    log.info(
      `[event-loop-monitor] ${source} started: interval=${sampleIntervalMs}ms threshold=${lagThresholdMs}ms` +
        (profileDir ? ` profileDir=${profileDir}` : ' (no profileDir, log only)'),
    );

    return {
      active: true,
      stop: () => {
        if (stopped) return;
        stopped = true;
        try {
          clearIntervalFn(timer);
        } catch {
          // 静默
        }
        try {
          hist.disable();
        } catch {
          // 静默
        }
      },
    };
  } catch (e) {
    // 启动失败静默（红线：监控绝不影响主流程）
    // eslint-disable-next-line no-console
    log.error('[event-loop-monitor] start failed (ignored):', e);
    return INACTIVE_HANDLE;
  }
}
