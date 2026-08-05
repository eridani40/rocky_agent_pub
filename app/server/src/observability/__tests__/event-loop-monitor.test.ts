/**
 * event-loop-monitor 单测 — 事件循环卡顿监控（v0.0.254）
 * 参考: app/server/src/observability/event-loop-monitor.ts 模块头（设计要点）
 *
 * 覆盖矩阵：
 *   - 开关：默认关零副作用（不建直方图/不起 timer）；env 开；显式 enabled 覆盖 env
 *   - Bun 降级：createHistogram 返 null → info 一条 + active=false，不抛
 *   - lag episode：超阈值 → warn + 一次 captureProfile；episode 内不重复；回落退出；再超再抓
 *   - warn 内容：lag/cpuUser 差分/elu 字段齐全；cpuUsage 收到上次绝对值（差分语义）
 *   - captureProfile 失败 → error 日志 + 闸复位（下一 episode 可再抓），不 throw
 *   - stop()：幂等 + clearInterval + histogram.disable
 *   - profile 文件路径：<profileDir>/<source>-<ts>.cpuprofile（profileDir 由调用方注入 tmp 绝对路径）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startEventLoopMonitor,
  type EventLoopMonitorDeps,
  type LoopHistogram,
} from '../event-loop-monitor';
import { setHangSink, type HangRecord } from '../hang-sink';

/** 可控 max 的 fake 直方图（记录 enable/disable 调用） */
function fakeHistogram() {
  const h = {
    max: 0,
    enableCalls: 0,
    disableCalls: 0,
    enable() {
      h.enableCalls++;
    },
    disable() {
      h.disableCalls++;
    },
    reset() {
      h.max = 0;
    },
  };
  return h;
}

/** 手动 timer：收集 tick 回调，test 显式 fire() 驱动；返回对象故意不带 unref（测能力探测不崩） */
function manualTimer() {
  const fns: Array<() => void> = [];
  return {
    setIntervalFn: vi.fn((fn: () => void) => {
      fns.push(fn);
      return {}; // 无 unref —— 能力探测路径
    }),
    clearIntervalFn: vi.fn(),
    fire: () => fns.forEach((f) => f()),
  };
}

/** log spy 三件套 */
function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface Fixture {
  deps: EventLoopMonitorDeps;
  hist: ReturnType<typeof fakeHistogram>;
  timer: ReturnType<typeof manualTimer>;
  log: ReturnType<typeof fakeLog>;
  captureProfile: ReturnType<typeof vi.fn>;
  profileDir: string;
}

/** 标准 fixture：开监控所需全部 fake（deps 注入，不动全局） */
function makeFixture(overrides: Partial<EventLoopMonitorDeps> = {}): Fixture {
  const hist = fakeHistogram();
  const timer = manualTimer();
  const log = fakeLog();
  const captureProfile = vi.fn(() => Promise.resolve());
  const profileDir = mkdtempSync(join(tmpdir(), 'rocky-elm-'));
  const deps: EventLoopMonitorDeps = {
    createHistogram: () => hist as LoopHistogram,
    setIntervalFn: timer.setIntervalFn,
    clearIntervalFn: timer.clearIntervalFn,
    captureProfile,
    log,
    env: {},
    ...overrides,
  };
  return { deps, hist, timer, log, captureProfile, profileDir };
}

describe('startEventLoopMonitor — 开关', () => {
  it('默认关（无 enabled 无 env）→ active=false，不建直方图不起 timer（零副作用）', () => {
    const f = makeFixture();
    const createSpy = vi.fn();
    const h = startEventLoopMonitor({ deps: { ...f.deps, createHistogram: createSpy } });
    expect(h.active).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
    expect(f.timer.setIntervalFn).not.toHaveBeenCalled();
  });

  it('env EVENT_LOOP_MONITOR=1 → active=true，直方图 enable + timer 启动', () => {
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' } });
    const h = startEventLoopMonitor({ deps: f.deps });
    expect(h.active).toBe(true);
    expect(f.hist.enableCalls).toBe(1);
    expect(f.timer.setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 1000);
    h.stop();
  });

  it('显式 enabled=false 覆盖 env=1 → 关', () => {
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' } });
    const h = startEventLoopMonitor({ enabled: false, deps: f.deps });
    expect(h.active).toBe(false);
    expect(f.timer.setIntervalFn).not.toHaveBeenCalled();
  });

  it('自定义 envFlag（electron 主进程 MAIN_EVENT_LOOP_MONITOR）', () => {
    const f = makeFixture({ env: { MAIN_EVENT_LOOP_MONITOR: 'true' } });
    const h = startEventLoopMonitor({ envFlag: 'MAIN_EVENT_LOOP_MONITOR', deps: f.deps });
    expect(h.active).toBe(true);
    h.stop();
  });
});

describe('startEventLoopMonitor — Bun 降级', () => {
  it('createHistogram 返 null（runtime 不支持）→ info 一条 + active=false，不抛', () => {
    const f = makeFixture({ createHistogram: () => null, env: { EVENT_LOOP_MONITOR: '1' } });
    const h = startEventLoopMonitor({ deps: f.deps });
    expect(h.active).toBe(false);
    expect(f.log.info).toHaveBeenCalledWith(expect.stringContaining('monitorEventLoopDelay 不可用'));
    expect(f.timer.setIntervalFn).not.toHaveBeenCalled();
  });

  it('createHistogram 内部抛错 → 外层 catch 兜底 active=false，不 throw', () => {
    const f = makeFixture({
      createHistogram: () => {
        throw new Error('bun boom');
      },
      env: { EVENT_LOOP_MONITOR: '1' },
    });
    // createHistogram 抛错发生在 try 外层的启用流程中 —— startEventLoopMonitor 整体不抛
    const h = startEventLoopMonitor({ deps: f.deps });
    expect(h.active).toBe(false);
  });
});

describe('startEventLoopMonitor — lag episode', () => {
  it('lag 超阈值 → warn 一次（含 lag/cpuUser/elu 字段）+ captureProfile 一次（路径在 profileDir 下带 source 前缀）', async () => {
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' } });
    const h = startEventLoopMonitor({ source: 'server', profileDir: f.profileDir, deps: f.deps });
    f.hist.max = 1500e6; // 1500ms >= 默认阈值 1000ms
    f.timer.fire();
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    const warnMsg = f.log.warn.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain('lag=1500ms');
    expect(warnMsg).toContain('cpuUser=');
    expect(warnMsg).toContain('elu=');
    expect(f.captureProfile).toHaveBeenCalledTimes(1);
    const [durationMs, filePath] = f.captureProfile.mock.calls[0] as [number, string];
    expect(durationMs).toBe(3000);
    expect(filePath.startsWith(f.profileDir)).toBe(true);
    expect(filePath).toMatch(/server-.*\.cpuprofile$/);
    await Promise.resolve(); // flush .then 日志
    h.stop();
  });

  it('episode 内连续超阈值不重复触发；回落退出 episode；再次超阈值重新抓捕', async () => {
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' } });
    const h = startEventLoopMonitor({ profileDir: f.profileDir, deps: f.deps });
    // 注意：fake reset() 会把 max 归零，所以每次 fire 前重新设置 max
    f.hist.max = 2000e6;
    f.timer.fire(); // 进入 episode，抓 1 次
    f.hist.max = 3000e6;
    f.timer.fire(); // episode 内 → 不再抓
    expect(f.captureProfile).toHaveBeenCalledTimes(1);
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    // 回落（reset 后 max=0，直接 fire 即低水位）
    f.timer.fire();
    expect(f.log.info).toHaveBeenCalledWith(expect.stringContaining('lag recovered'));
    // profileInFlight 闸在 promise finally 释放 —— flush 微任务后才可再抓（闸跨 episode 防重叠）
    await new Promise((r) => setTimeout(r, 0));
    // 再次超阈值 → 新 episode，抓第 2 次
    f.hist.max = 2500e6;
    f.timer.fire();
    expect(f.captureProfile).toHaveBeenCalledTimes(2);
    expect(f.log.warn).toHaveBeenCalledTimes(2);
    h.stop();
  });

  it('无 profileDir → 只打 warn 不抓 profile', () => {
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' } });
    const h = startEventLoopMonitor({ deps: f.deps }); // 不传 profileDir
    f.hist.max = 1500e6;
    f.timer.fire();
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    expect(f.captureProfile).not.toHaveBeenCalled();
    h.stop();
  });

  it('cpuUsage 差分语义：第二 tick 起以之前绝对值为 prev 入参', () => {
    const calls: Array<unknown> = [];
    let t = 0;
    const cpuUsage = (prev?: { user: number; system: number }) => {
      calls.push(prev);
      t += 1000;
      return { user: t, system: t };
    };
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' }, cpuUsage });
    const h = startEventLoopMonitor({ deps: f.deps });
    f.timer.fire();
    f.timer.fire();
    // 首 tick 无基准只调 abs（1 次）；次 tick 调 abs + diff（2 次），diff 收到首 tick 绝对值
    expect(calls.length).toBe(3);
    expect(calls[0]).toBeUndefined(); // 首 tick abs
    expect(calls[1]).toBeUndefined(); // 次 tick abs
    expect(calls[2]).toEqual({ user: 1000, system: 1000 }); // 次 tick diff 收到首 tick 绝对值
    h.stop();
  });

  it('captureProfile reject → error 日志 + 闸复位（下一 episode 可再抓），不 throw', async () => {
    const rejecting = vi.fn(() => Promise.reject(new Error('inspector down')));
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' }, captureProfile: rejecting });
    const h = startEventLoopMonitor({ profileDir: f.profileDir, deps: f.deps });
    f.hist.max = 1500e6;
    f.timer.fire();
    // flush 微任务链（.catch/.finally）
    await new Promise((r) => setTimeout(r, 0));
    expect(f.log.error).toHaveBeenCalledWith(
      expect.stringContaining('cpu profile failed'),
      expect.any(Error),
    );
    // 闸已复位：回落后再超阈值可再抓
    f.timer.fire();
    f.hist.max = 1500e6;
    f.timer.fire();
    expect(rejecting).toHaveBeenCalledTimes(2);
    h.stop();
  });
});

describe('startEventLoopMonitor — stop', () => {
  it('stop() 幂等：clearInterval + histogram.disable 各一次，二次调用无副作用', () => {
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' } });
    const h = startEventLoopMonitor({ deps: f.deps });
    h.stop();
    h.stop();
    expect(f.timer.clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(f.hist.disableCalls).toBe(1);
    // stop 后 tick 不再采样
    f.hist.max = 1500e6;
    f.timer.fire();
    expect(f.log.warn).not.toHaveBeenCalled();
  });
});

// ============================================================
// hang sink（v0.0.258）：episode enter/recover → reportHang
// ============================================================

afterEach(() => {
  setHangSink(null); // 模块级 sink 必须复位（隔离 UT 间状态）
});

describe('startEventLoopMonitor — hang sink', () => {
  it('episode enter → reportHang 被调，record 含 kind/phase/source/lagMs/cpuUserMs/cpuSysMs/elu/profileFile', () => {
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' } });
    const records: HangRecord[] = [];
    setHangSink((r) => records.push(r));
    const h = startEventLoopMonitor({ source: 'server', profileDir: f.profileDir, deps: f.deps });
    f.hist.max = 1500e6; // 1500ms >= 默认阈值 1000ms
    f.timer.fire();

    expect(records.length).toBe(1);
    const r = records[0]!;
    expect(r.kind).toBe('hang');
    expect(r.phase).toBe('enter');
    expect(r.source).toBe('server');
    expect(r.lagMs).toBe(1500);
    expect(typeof r.cpuUserMs).toBe('number');
    expect(typeof r.cpuSysMs).toBe('number');
    expect(typeof r.elu).toBe('number');
    expect(r.profileFile).toBeDefined();
    expect(r.profileFile!.startsWith(f.profileDir)).toBe(true);
    expect(r.profileFile).toMatch(/server-.*\.cpuprofile$/);
    h.stop();
  });

  it('无 profileDir → record.profileFile 缺省', () => {
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' } });
    const records: HangRecord[] = [];
    setHangSink((r) => records.push(r));
    const h = startEventLoopMonitor({ deps: f.deps }); // 不传 profileDir
    f.hist.max = 1500e6;
    f.timer.fire();

    expect(records.length).toBe(1);
    expect(records[0]!.profileFile).toBeUndefined();
    h.stop();
  });

  it('episode recover → reportHang phase=recover（仅 source，无当前指标）', () => {
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' } });
    const records: HangRecord[] = [];
    setHangSink((r) => records.push(r));
    const h = startEventLoopMonitor({ profileDir: f.profileDir, deps: f.deps });
    f.hist.max = 2000e6;
    f.timer.fire(); // 进入 episode
    f.timer.fire(); // 回落（reset 后 max=0 < 阈值）

    expect(records.length).toBe(2);
    const recoverRecord = records[1]!;
    expect(recoverRecord.kind).toBe('hang');
    expect(recoverRecord.phase).toBe('recover');
    expect(recoverRecord.source).toBe('server');
    expect(recoverRecord.lagMs).toBeUndefined();
    expect(recoverRecord.cpuUserMs).toBeUndefined();
    expect(recoverRecord.profileFile).toBeUndefined();
    h.stop();
  });

  it('sink 未注册（setHangSink(null)）→ episode 触发但不调 sink（零副作用）', () => {
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' } });
    const records: HangRecord[] = [];
    setHangSink(null); // 显式未注册
    const h = startEventLoopMonitor({ profileDir: f.profileDir, deps: f.deps });
    f.hist.max = 1500e6;
    f.timer.fire();

    expect(records.length).toBe(0); // 零产出
    // 但主路径仍执行：warn + captureProfile 照常（双写不互斥）
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    expect(f.captureProfile).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('inEpisode 守卫：连续超阈值只调一次 reportHang（enter）', () => {
    const f = makeFixture({ env: { EVENT_LOOP_MONITOR: '1' } });
    const records: HangRecord[] = [];
    setHangSink((r) => records.push(r));
    const h = startEventLoopMonitor({ profileDir: f.profileDir, deps: f.deps });
    f.hist.max = 2000e6;
    f.timer.fire(); // 进入 episode
    f.hist.max = 3000e6;
    f.timer.fire(); // episode 内 → 不重复 enter

    expect(records.filter((r) => r.phase === 'enter').length).toBe(1);
    h.stop();
  });
});
