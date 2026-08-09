/**
 * fs-yield singleton library 单测
 * 参考: specs/tech/version_logs/v0.0.291/change_plan.md
 *
 * 覆盖：次数阈值 49/50/51 / 时间阈值 OR / 混合（30次+8ms→第31次触发）
 *      / resetFsYield / acquireFsSlot 不 throw
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  acquireFsSlot,
  trackFsTime,
  resetFsYield,
  THRESHOLD_OP,
  THRESHOLD_NS,
} from '../fs-yield';

beforeEach(() => {
  resetFsYield();
  vi.restoreAllMocks();
});

describe('acquireFsSlot — 次数阈值边界', () => {
  it('连续调 49 次 → 不让出（setImmediate 未被调）', async () => {
    const spy = vi.spyOn(globalThis, 'setImmediate');
    for (let i = 0; i < 49; i++) await acquireFsSlot();
    expect(spy).not.toHaveBeenCalled();
  });

  it('连续调 50 次 → 第 50 次触发让出 1 次 + 归零', async () => {
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((cb) => {
      cb();
      return {} as NodeJS.Immediate;
    });
    for (let i = 0; i < 50; i++) await acquireFsSlot();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('连续调 51 次 → 让出 1 次（50 归零后第 51 次不达阈值）', async () => {
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((cb) => {
      cb();
      return {} as NodeJS.Immediate;
    });
    for (let i = 0; i < 51; i++) await acquireFsSlot();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('调 100 次 → 让出 2 次（50 和 100 各一次）', async () => {
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((cb) => {
      cb();
      return {} as NodeJS.Immediate;
    });
    for (let i = 0; i < 100; i++) await acquireFsSlot();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('acquireFsSlot — 时间阈值 OR', () => {
  it('trackFsTime 累加达 8ms → 下次 acquireFsSlot 触发让出', async () => {
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((cb) => {
      cb();
      return {} as NodeJS.Immediate;
    });
    trackFsTime(THRESHOLD_NS);
    expect(spy).not.toHaveBeenCalled(); // track 本身不让出
    await acquireFsSlot(); // accumulatedNs 已达阈值 → 让出
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('trackFsTime 不足 8ms → 不让出', async () => {
    const spy = vi.spyOn(globalThis, 'setImmediate');
    trackFsTime(THRESHOLD_NS - 1n);
    await acquireFsSlot();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('acquireFsSlot — 混合场景', () => {
  it('30 次 + track 8ms → 第 31 次触发让出（时间先于次数阈值）', async () => {
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((cb) => {
      cb();
      return {} as NodeJS.Immediate;
    });
    for (let i = 0; i < 30; i++) await acquireFsSlot();
    expect(spy).not.toHaveBeenCalled();
    trackFsTime(THRESHOLD_NS);
    await acquireFsSlot(); // opCount=31 < 50，但时间达阈值 → 让出
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('resetFsYield', () => {
  it('归零后从 0 开始计数', async () => {
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation((cb) => {
      cb();
      return {} as NodeJS.Immediate;
    });
    for (let i = 0; i < 40; i++) await acquireFsSlot();
    expect(spy).not.toHaveBeenCalled();
    resetFsYield();
    for (let i = 0; i < 49; i++) await acquireFsSlot();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('acquireFsSlot — 健壮性', () => {
  it('不 throw（setImmediate mock 抛错也静默）', async () => {
    vi.spyOn(globalThis, 'setImmediate').mockImplementation(() => {
      throw new Error('setImmediate exploded');
    });
    trackFsTime(THRESHOLD_NS);
    await expect(acquireFsSlot()).resolves.toBeUndefined();
  });
});

describe('常量导出', () => {
  it('THRESHOLD_OP = 50', () => expect(THRESHOLD_OP).toBe(50));
  it('THRESHOLD_NS = 8_000_000n', () => expect(THRESHOLD_NS).toBe(8_000_000n));
});
