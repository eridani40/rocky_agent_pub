/**
 * connectChannelWithRetry 单测：3 次 × 5s 上限 + abort + 成功重置计数
 * 参考: specs/tech/channel/[P0]channel_manager.md §3.3（重连策略）
 *       reqs/[done] v0.0.103.channel/design-feishu.md §7
 *
 * 覆盖：
 *   1. 首次 connect 成功 → connection='connected' + retryCount 清零 + rt.handle 挂新句柄
 *   2. connect 失败 3 次 → connection='error' + errorDetail（connectFn 调 3 次）
 *   3. 第 2 次成功 → connection='connected'（不重试到上限）
 *   4. aborted=true 时立即退出，不重试不改 state
 *   5. connect 成功后被 abort → 对新 handle 调 disconnect 补偿，不改 state
 *
 * v0.0.206：connect 委托 connectFn（组合器注入 `() => impl.connect(config, backend)`），
 * 每 attempt 产出 fresh ChannelHandle 挂 rt.handle。
 *
 * 注：RETRY_INTERVAL_MS 是常量（5s），UT 不能真等 15s。
 * 此处采用「不触发 sleep 路径」的方式（首次 connect 成功 / aborted 不进 sleep）。
 */
import { describe, it, expect, vi } from 'vitest';
import { connectChannelWithRetry } from '../channel-retry';
import type { RetryController } from '../channel-retry';
import type { RuntimeState } from '../channel-manager';
import type { ChannelHandle } from '../types';

/** 构造 mock ChannelHandle */
function makeHandle(configId = 'cfg-1'): ChannelHandle {
  return {
    configId,
    disconnect: vi.fn().mockResolvedValue(undefined),
    handleInbound: vi.fn().mockResolvedValue(undefined),
    sendOutbound: vi.fn().mockResolvedValue(undefined),
    updateInputState: vi.fn().mockResolvedValue(undefined),
  };
}

/** 构造最小 RuntimeState（无 handle——connect 成功前 undefined） */
function makeRuntime(): RuntimeState {
  return {
    connection: 'disconnected',
    retryCount: 0,
  };
}

describe('connectChannelWithRetry', () => {
  it('首次 connect 成功 → connection=connected + retryCount 清零 + rt.handle 挂句柄', async () => {
    const handle = makeHandle();
    const connectFn = vi.fn().mockResolvedValue(handle);
    const rt = makeRuntime();
    const ctrl: RetryController = { aborted: false };
    await connectChannelWithRetry(rt, ctrl, connectFn);
    expect(rt.connection).toBe('connected');
    expect(rt.retryCount).toBe(0);
    expect(rt.lastConnectedAt).toBeTruthy();
    expect(rt.errorDetail).toBeUndefined();
    expect(rt.handle).toBe(handle);
    expect(connectFn).toHaveBeenCalledTimes(1);
  });

  it('connect 失败 3 次 → connection=error + errorDetail（connectFn 调 3 次）', async () => {
    const connectFn = vi.fn().mockRejectedValue(new Error('boom'));
    const rt = makeRuntime();
    const ctrl: RetryController = { aborted: false };
    // 不真等 5s sleep：mock setTimeout 立即 resolve（避免 fake timers 全局影响）
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void) => { queueMicrotask(fn); return 0 as unknown as NodeJS.Timeout; }) as typeof setTimeout,
    );
    await connectChannelWithRetry(rt, ctrl, connectFn);
    timeoutSpy.mockRestore();
    expect(rt.connection).toBe('error');
    expect(rt.retryCount).toBe(3);
    expect(rt.errorDetail).toContain('boom');
    expect(rt.handle).toBeUndefined();
    expect(connectFn).toHaveBeenCalledTimes(3);
  });

  it('第 2 次成功 → connection=connected（不重试到上限）', async () => {
    const handle = makeHandle();
    const connectFn = vi.fn()
      .mockRejectedValueOnce(new Error('first fail'))
      .mockResolvedValueOnce(handle);
    const rt = makeRuntime();
    const ctrl: RetryController = { aborted: false };
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: () => void) => { queueMicrotask(fn); return 0 as unknown as NodeJS.Timeout; }) as typeof setTimeout,
    );
    await connectChannelWithRetry(rt, ctrl, connectFn);
    timeoutSpy.mockRestore();
    expect(rt.connection).toBe('connected');
    expect(rt.handle).toBe(handle);
    expect(connectFn).toHaveBeenCalledTimes(2);
  });

  it('aborted=true 时立即退出，不重试不改 state', async () => {
    const connectFn = vi.fn();
    const rt = makeRuntime();
    const ctrl: RetryController = { aborted: true };
    await connectChannelWithRetry(rt, ctrl, connectFn);
    expect(rt.connection).toBe('disconnected');
    expect(connectFn).not.toHaveBeenCalled();
  });

  it('connect 成功后被 abort → 对新 handle 调 disconnect 补偿，不改 state', async () => {
    const handle = makeHandle();
    const ctrl: RetryController = { aborted: false };
    const connectFn = vi.fn().mockImplementation(async () => {
      ctrl.aborted = true; // connect 进行中 toggle off
      return handle;
    });
    const rt = makeRuntime();
    await connectChannelWithRetry(rt, ctrl, connectFn);
    expect(handle.disconnect).toHaveBeenCalledTimes(1);
    // 补偿路径不改 state（保持 attempt 前的 'connecting'，由 setEnabled off 路径自行置 disconnected）
    expect(rt.connection).toBe('connecting');
    expect(rt.handle).toBeUndefined(); // 补偿路径不挂句柄
  });
});
