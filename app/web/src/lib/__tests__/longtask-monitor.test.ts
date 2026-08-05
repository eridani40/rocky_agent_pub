/**
 * longtask-monitor 单测 — 渲染进程长任务监控（v0.0.254）
 * 参考: app/web/src/lib/longtask-monitor.ts 模块头（设计要点）
 *
 * 覆盖矩阵：
 *   - 降级：环境无 PerformanceObserver（stubGlobal 模拟）→ 不抛 + active=false
 *   - 正常：fake observer 监听 longtask + long-animation-frame；>200ms warn 归因；<=200ms 静默
 *   - 部分支持：long-animation-frame observe 抛错 → longtask 仍生效（active=true）
 *   - 全不支持：两种 entryType observe 都抛 → active=false，不抛
 *   - 开关解析：DEV 默认 / VITE_LONGTASK_MONITOR 显式覆盖 / options.enabled 最优先
 *   - stop()：disconnect 全部 observer + 幂等
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { startLongTaskMonitor } from '../longtask-monitor';

/** fake PerformanceObserver 工厂；failTypes 中的 entryType 在 observe 时抛错（模拟不支持） */
function makeFakeObserverCtor(failTypes: string[] = []) {
  const instances: Array<{
    observed: string[];
    disconnected: boolean;
    emit: (entries: Array<Record<string, unknown>>) => void;
  }> = [];
  class FakeObserver {
    observed: string[] = [];
    disconnected = false;
    constructor(private cb: PerformanceObserverCallback) {
      instances.push(this as unknown as (typeof instances)[number]);
    }
    observe(init: PerformanceObserverInit) {
      const types = init.entryTypes ?? [];
      if (types.some((t) => failTypes.includes(t))) throw new SyntaxError('unsupported entryType');
      this.observed.push(...types);
    }
    disconnect() {
      this.disconnected = true;
    }
    takeRecords() {
      return [];
    }
    emit(entries: Array<Record<string, unknown>>) {
      this.cb({ getEntries: () => entries } as unknown as PerformanceObserverEntryList, this as unknown as PerformanceObserver);
    }
  }
  return { ctor: FakeObserver as unknown as typeof PerformanceObserver, instances };
}

function fakeLog() {
  return { warn: vi.fn() };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('startLongTaskMonitor — 降级', () => {
  it('环境无 PerformanceObserver → 不抛 + active=false', () => {
    // stubGlobal 模拟老环境/jsdom 缺 API（本测试 env 的 jsdom 实际带 PerformanceObserver）
    vi.stubGlobal('PerformanceObserver', undefined);
    const h = startLongTaskMonitor({ env: { DEV: true } });
    expect(h.active).toBe(false);
    vi.unstubAllGlobals();
  });

  it('两种 entryType observe 都抛错 → active=false，不抛', () => {
    const { ctor } = makeFakeObserverCtor(['longtask', 'long-animation-frame']);
    const h = startLongTaskMonitor({ env: { DEV: true }, observerCtor: ctor });
    expect(h.active).toBe(false);
  });
});

describe('startLongTaskMonitor — 正常监听', () => {
  it('监听 longtask + long-animation-frame；>200ms warn 含时长/类型/归因；<=200ms 静默', () => {
    const { ctor, instances } = makeFakeObserverCtor();
    const log = fakeLog();
    const h = startLongTaskMonitor({ env: { DEV: true }, observerCtor: ctor, log });
    expect(h.active).toBe(true);
    expect(instances).toHaveLength(2);
    expect(instances[0]?.observed).toEqual(['longtask']);
    expect(instances[1]?.observed).toEqual(['long-animation-frame']);

    // longtask 350ms + attribution → warn
    instances[0]?.emit([
      { duration: 350, entryType: 'longtask', attribution: [{ name: 'script', containerSrc: 'https://x/a.js' }] },
    ]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const args = log.warn.mock.calls[0] ?? [];
    expect(args[0]).toBe('[LONGTASK]');
    expect(args[1]).toBe('350ms');
    expect(args[2]).toBe('longtask');
    expect(args[3]).toContain('a.js');

    // 100ms 低于阈值 → 不再 warn
    instances[0]?.emit([{ duration: 100, entryType: 'longtask' }]);
    expect(log.warn).toHaveBeenCalledTimes(1);

    // long-animation-frame 带 scripts 归因
    instances[1]?.emit([
      { duration: 480, entryType: 'long-animation-frame', scripts: [{ sourceURL: 'https://x/b.ts', sourceFunctionName: 'renderAll' }] },
    ]);
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1]?.[3]).toContain('renderAll@https://x/b.ts');
    h.stop();
  });

  it('long-animation-frame 不支持（observe 抛错）→ longtask 仍生效（active=true）', () => {
    const { ctor, instances } = makeFakeObserverCtor(['long-animation-frame']);
    const h = startLongTaskMonitor({ env: { DEV: true }, observerCtor: ctor, log: fakeLog() });
    expect(h.active).toBe(true);
    expect(instances).toHaveLength(2); // 两个类型都 new 了，只是第二个 observe 抛错
    expect(instances[0]?.observed).toEqual(['longtask']);
    h.stop();
  });
});

describe('startLongTaskMonitor — 开关解析', () => {
  it('env DEV=false 且无 flag → 关（不构造 observer）', () => {
    const { ctor, instances } = makeFakeObserverCtor();
    const h = startLongTaskMonitor({ env: { DEV: false }, observerCtor: ctor });
    expect(h.active).toBe(false);
    expect(instances).toHaveLength(0);
  });

  it('VITE_LONGTASK_MONITOR=1 覆盖 DEV=false → 开', () => {
    const { ctor } = makeFakeObserverCtor();
    const h = startLongTaskMonitor({
      env: { DEV: false, VITE_LONGTASK_MONITOR: '1' },
      observerCtor: ctor,
    });
    expect(h.active).toBe(true);
    h.stop();
  });

  it('VITE_LONGTASK_MONITOR=0 覆盖 DEV=true → 关', () => {
    const { ctor } = makeFakeObserverCtor();
    const h = startLongTaskMonitor({
      env: { DEV: true, VITE_LONGTASK_MONITOR: '0' },
      observerCtor: ctor,
    });
    expect(h.active).toBe(false);
  });

  it('options.enabled=false 最优先（覆盖 DEV=true + flag=1）', () => {
    const { ctor } = makeFakeObserverCtor();
    const h = startLongTaskMonitor({
      enabled: false,
      env: { DEV: true, VITE_LONGTASK_MONITOR: '1' },
      observerCtor: ctor,
    });
    expect(h.active).toBe(false);
  });
});

describe('startLongTaskMonitor — stop', () => {
  it('stop() disconnect 全部 observer 且幂等', () => {
    const { ctor, instances } = makeFakeObserverCtor();
    const h = startLongTaskMonitor({ env: { DEV: true }, observerCtor: ctor });
    h.stop();
    h.stop();
    expect(instances.every((i) => i.disconnected)).toBe(true);
  });
});
