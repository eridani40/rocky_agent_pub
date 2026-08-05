/**
 * 渲染进程长任务（long task）监控 — PerformanceObserver 抓捕主线程卡顿现场
 * 参考: v0.0.254 task 指令（跨三进程卡顿监控之 renderer 侧）
 *       app/server/src/observability/event-loop-monitor.ts（Node 侧同款设计）
 *
 * 设计要点：
 *   - PerformanceObserver 监听 'longtask'（>50ms 即上报，Chromium 支持）；'long-animation-frame'
 *     （LoAF，能给出归因脚本 sourceURL/functionName）有则一并监听，没有静默跳过。
 *   - 单条任务时长 > thresholdMs（默认 200ms）才 console.warn('[LONGTASK]', ...)，避免
 *     50-200ms 的常规任务刷屏；warn 附 entryType + 归因摘要。
 *   - 开关：VITE_LONGTASK_MONITOR 显式控制（'1/true' 开 / '0/false' 关）；未设时
 *     **dev 默认开、prod 默认关**（import.meta.env.DEV）。
 *   - 零阻断：全程 try/catch；PerformanceObserver 缺失（jsdom/老浏览器）或 observe 不支持
 *     该 entryType（抛错）均静默降级，绝不影响首屏渲染。
 */

/** startLongTaskMonitor 入参（全部可选；测试注入 env/observerCtor/log） */
export interface LongTaskMonitorOptions {
  /** 显式开关；缺省按 VITE_LONGTASK_MONITOR → import.meta.env.DEV 解析 */
  enabled?: boolean;
  /** 判定长任务的阈值 ms，默认 200 */
  thresholdMs?: number;
  /** 测试注入 env（缺省读 import.meta.env） */
  env?: { DEV?: boolean; VITE_LONGTASK_MONITOR?: string };
  /** 测试注入 PerformanceObserver 构造（缺省取全局；传 undefined 模拟不支持） */
  observerCtor?: typeof PerformanceObserver;
  log?: Pick<Console, 'warn'>;
}

/** 监控句柄：active=false 表示未启动（开关关 / 环境不支持），stop 断开所有 observer */
export interface LongTaskMonitorHandle {
  readonly active: boolean;
  stop(): void;
}

const INACTIVE: LongTaskMonitorHandle = { active: false, stop: () => undefined };

/** env 字符串真值判定（'1/true/yes/on' 不区分大小写） */
function isTruthy(v: string | undefined): boolean {
  return !!v && ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

/**
 * 从 entry 提取归因摘要：
 *   - long-animation-frame：scripts[0] 给出耗时脚本 sourceFunctionName@sourceURL
 *   - longtask：attribution[0] 给出任务来源（name/containerSrc）
 * 字段缺失/异常一律回退空串（不影响 warn 主信息）。
 */
function summarizeAttribution(entry: PerformanceEntry): string {
  try {
    const e = entry as PerformanceEntry & {
      scripts?: Array<{ sourceURL?: string; sourceFunctionName?: string }>;
      attribution?: Array<{ name?: string; containerSrc?: string }>;
    };
    if (Array.isArray(e.scripts) && e.scripts.length > 0) {
      const s = e.scripts[0];
      if (!s) return '';
      return `script=${s.sourceFunctionName || 'anon'}@${s.sourceURL || 'unknown'}`;
    }
    if (Array.isArray(e.attribution) && e.attribution.length > 0) {
      const a = e.attribution[0];
      if (!a) return '';
      return `task=${a.name || 'unknown'} src=${a.containerSrc || ''}`.trim();
    }
  } catch {
    // 静默
  }
  return '';
}

/**
 * 启动渲染进程长任务监控。任何失败静默，绝不 throw（首屏前调用，不能阻断渲染）。
 * @returns active=false 表示未启动
 */
export function startLongTaskMonitor(options: LongTaskMonitorOptions = {}): LongTaskMonitorHandle {
  const log = options.log ?? console;
  try {
    const env = options.env ?? {
      DEV: import.meta.env.DEV,
      VITE_LONGTASK_MONITOR: import.meta.env.VITE_LONGTASK_MONITOR,
    };
    const flag = env.VITE_LONGTASK_MONITOR;
    const enabled = options.enabled ?? (flag !== undefined && flag !== '' ? isTruthy(flag) : env.DEV === true);
    if (!enabled) return INACTIVE;

    const Ctor =
      options.observerCtor ??
      (typeof PerformanceObserver !== 'undefined' ? PerformanceObserver : undefined);
    if (!Ctor) return INACTIVE; // 环境不支持 PerformanceObserver（jsdom 等）→ 静默降级

    const thresholdMs = options.thresholdMs ?? 200;
    const observers: PerformanceObserver[] = [];
    const callback: PerformanceObserverCallback = (list) => {
      try {
        for (const entry of list.getEntries()) {
          if (entry.duration <= thresholdMs) continue;
          // eslint-disable-next-line no-console
          log.warn(
            '[LONGTASK]',
            `${entry.duration.toFixed(0)}ms`,
            entry.entryType,
            summarizeAttribution(entry),
          );
        }
      } catch {
        // 静默：单批 entry 处理失败不影响后续
      }
    };
    // 逐个 entryType 尝试：某类型不支持时 observe 抛错 → 只跳过该类型
    for (const type of ['longtask', 'long-animation-frame']) {
      try {
        const obs = new Ctor(callback);
        obs.observe({ entryTypes: [type] });
        observers.push(obs);
      } catch {
        // 静默：该 entryType 不支持
      }
    }
    if (observers.length === 0) return INACTIVE;

    let stopped = false;
    return {
      active: true,
      stop: () => {
        if (stopped) return;
        stopped = true;
        for (const o of observers) {
          try {
            o.disconnect();
          } catch {
            // 静默
          }
        }
      },
    };
  } catch {
    return INACTIVE;
  }
}
