// @vitest-environment node
/**
 * sse-client 重连机制单测（v0.0.92 §7.2）
 * 参考: specs/tech/app/frontend/[P0]sse_client_singleton.md §7.2（重连策略权威）
 *
 * 覆盖：
 *   ① 瞬时 throw → scheduleReconnect + 退避时序（1s/2s/4s/cap 30s ± 20% jitter）
 *   ② AbortError 不重连（终态）
 *   ③ 瞬时错误时 handlers 不 clear（保订阅重连后继续路由）
 *   ④ destroy 中止 pending 重连（destroyed 守卫）
 *   ⑤ onResumed 回调在重连成功触发 + attempts 归零；首次连接成功不触发
 *   ⑥ notifyResume 触发 onResumed 回调（visibility 返前台场景由 singleton 调）
 *
 * Mock：fetch（throw/AbortError/res.ok），禁跑真 fetch；timer 用 vi.useFakeTimers。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SseClient } from '../sse-client';

/** 构造成功的 fetch response（带可控 reader） */
function makeOkResponse(reader: { read: () => Promise<{ done: boolean; value?: Uint8Array }> }): Response {
  return {
    ok: true,
    status: 200,
    body: { getReader: () => reader },
  } as unknown as Response;
}

/** reader.read 立即 done（模拟 stream 立即结束） */
function makeDoneReader() {
  return { read: async () => ({ done: true, value: undefined }) };
}

/** reader.read 永不 resolve（模拟 stream 长连接不结束，让 connect 卡在循环不进 finally） */
function makeHangReader() {
  return { read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}) };
}

/** flush microtasks（fetch reject + catch + scheduleReconnect 链路需要多次 flush） */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

/** 访问 SseClient 私有字段（测试专用，绕 TS 私有检查） */
function internals(client: SseClient): {
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  destroyed: boolean;
  handlers: Map<string, () => void>;
} {
  return client as unknown as {
    reconnectAttempts: number;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    destroyed: boolean;
    handlers: Map<string, () => void>;
  };
}

describe('SseClient 重连机制 (v0.0.92 §7.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('① 瞬时 fetch throw → scheduleReconnect 指数退避 1s/2s/4s/cap 30s + ±20% jitter', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => Promise.reject(new Error('network down')));
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const client = new SseClient('http://test');
    void client.connect();
    await flush();

    // 第 1 次：attempts 0→1，base=1s，delay∈[800,1200]
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    let d = setTimeoutSpy.mock.calls[0]![1] as number;
    expect(d).toBeGreaterThanOrEqual(800);
    expect(d).toBeLessThanOrEqual(1200);
    expect(internals(client).reconnectAttempts).toBe(1);

    // 推进时间 → 第 2 次 connect 仍 fail → scheduleReconnect（attempts 1→2，base=2s）
    await vi.advanceTimersByTimeAsync(2000);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
    d = setTimeoutSpy.mock.calls[1]![1] as number;
    expect(d).toBeGreaterThanOrEqual(1600);
    expect(d).toBeLessThanOrEqual(2400);

    // 第 3 次（attempts 2→3，base=4s）
    await vi.advanceTimersByTimeAsync(3000);
    d = setTimeoutSpy.mock.calls[2]![1] as number;
    expect(d).toBeGreaterThanOrEqual(3200);
    expect(d).toBeLessThanOrEqual(4800);

    // 第 4 次（attempts 3→4，base=8s）
    await vi.advanceTimersByTimeAsync(5000);
    d = setTimeoutSpy.mock.calls[3]![1] as number;
    expect(d).toBeGreaterThanOrEqual(6400);
    expect(d).toBeLessThanOrEqual(9600);

    // 第 5 次（attempts 4→5，base=16s）
    await vi.advanceTimersByTimeAsync(10000);
    d = setTimeoutSpy.mock.calls[4]![1] as number;
    expect(d).toBeGreaterThanOrEqual(12800);
    expect(d).toBeLessThanOrEqual(19200);

    // 第 6 次（attempts 5→6，base capped at 30s，delay∈[24000,36000]）
    await vi.advanceTimersByTimeAsync(20000);
    d = setTimeoutSpy.mock.calls[5]![1] as number;
    expect(d).toBeGreaterThanOrEqual(24000);
    expect(d).toBeLessThanOrEqual(36000);
  });

  it('② AbortError 不触发重连（终态）', async () => {
    const abortErr = new DOMException('aborted', 'AbortError');
    vi.spyOn(global, 'fetch').mockImplementation(() => Promise.reject(abortErr));
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const client = new SseClient('http://test');
    void client.connect();
    await flush();

    // 不应调度重连（scheduleReconnect 未被调用）
    expect(internals(client).reconnectAttempts).toBe(0);
    expect(internals(client).reconnectTimer).toBeNull();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });

  it('③ 瞬时错误时 handlers 不 clear（保订阅重连后继续路由）', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => Promise.reject(new Error('net')));
    const client = new SseClient('http://test');
    // 模拟已有一个订阅（手动塞 handler 进 Map）
    const h = internals(client).handlers;
    h.set('sub-x', () => {});
    expect(h.size).toBe(1);

    void client.connect();
    await flush();
    expect(internals(client).reconnectAttempts).toBe(1);

    // handlers 没被清（瞬时错误保订阅）
    expect(h.size).toBe(1);
    expect(h.has('sub-x')).toBe(true);
  });

  it('④ destroy 中止 pending 重连 timer + destroyed 守卫防僵尸', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(() => Promise.reject(new Error('net')));
    const client = new SseClient('http://test');
    void client.connect();
    await flush();
    expect(internals(client).reconnectTimer).not.toBeNull();

    client.destroy();
    expect(internals(client).destroyed).toBe(true);
    expect(internals(client).reconnectTimer).toBeNull();
    expect(internals(client).reconnectAttempts).toBe(0); // destroy 清零

    // 推进时间不应触发新 fetch（timer 已清 + destroyed 守卫）
    const fetchSpy = vi.spyOn(global, 'fetch');
    fetchSpy.mockClear();
    vi.advanceTimersByTime(60000);
    await flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('④ destroyed 后再调 connect 不建连（终态守卫，直接 return）', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(makeOkResponse(makeDoneReader())),
    );
    const client = new SseClient('http://test');
    client.destroy();
    await client.connect();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('⑤ 重连成功（reconnectAttempts>0 后 fetch res.ok）→ 触发 onResumed + attempts 归零', async () => {
    let firstFail = true;
    vi.spyOn(global, 'fetch').mockImplementation(() => {
      if (firstFail) {
        firstFail = false;
        return Promise.reject(new Error('first fail'));
      }
      // 第二次成功 + hang reader（让 connect 卡在循环不进 finally，attempts 保持 0）
      return Promise.resolve(makeOkResponse(makeHangReader()));
    });

    const client = new SseClient('http://test');
    const cb = vi.fn();
    client.onResumed(cb);

    void client.connect();
    await flush();
    // 第一次错误 → scheduleReconnect（attempts=1），未触发 cb
    expect(internals(client).reconnectAttempts).toBe(1);
    expect(cb).not.toHaveBeenCalled();

    // 推进触发第二次 connect（fetch res.ok + hang reader）→ notifyResume + attempts 归零
    vi.advanceTimersByTime(2000);
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(internals(client).reconnectAttempts).toBe(0);
  });

  it('⑤ 首次连接成功（reconnectAttempts 一直=0）不触发 onResumed', async () => {
    // hang reader：让 connect 卡在循环，不会因 stream done 触发 scheduleReconnect
    vi.spyOn(global, 'fetch').mockImplementation(() =>
      Promise.resolve(makeOkResponse(makeHangReader())),
    );
    const client = new SseClient('http://test');
    const cb = vi.fn();
    client.onResumed(cb);
    void client.connect();
    await flush();
    // 首次连接成功（attempts=0）→ 不触发 notifyResume
    expect(cb).not.toHaveBeenCalled();
    expect(internals(client).reconnectAttempts).toBe(0);
  });

  it('⑥ notifyResume 触发所有 onResumed 回调 + unsubscribe 后不再触发', () => {
    const client = new SseClient('http://test');
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = client.onResumed(cb1);
    client.onResumed(cb2);

    client.notifyResume();
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);

    unsub1();
    client.notifyResume();
    expect(cb1).toHaveBeenCalledTimes(1); // 不再增加
    expect(cb2).toHaveBeenCalledTimes(2);
  });

  it('⑥ onResumed 回调抛异常不阻塞其他回调（best-effort）', () => {
    const client = new SseClient('http://test');
    const cb1 = vi.fn(() => {
      throw new Error('boom');
    });
    const cb2 = vi.fn();
    client.onResumed(cb1);
    client.onResumed(cb2);

    expect(() => client.notifyResume()).not.toThrow();
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
