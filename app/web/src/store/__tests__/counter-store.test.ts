// @vitest-environment node
/**
 * 计数器 store 单测
 * 参考: specs/ui/overall/01-counter.md §2.3 / §3.4
 *
 * 覆盖：
 *   - fetchCounter 成功 → value/loaded
 *   - fetchCounter 失败 → error 设置，loading 复位
 *   - incrementCounter 成功 → value 更新
 *   - in-flight 期间并发 increment 被忽略（防竞态，ui spec §3.4）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCounterStore, type CounterResponse } from '../counter-store';

function mkRes(body: CounterResponse, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('counter store', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetchCounter 成功时回填 value 并清 error', async () => {
    const fetchImpl = vi.fn(async () => mkRes({ value: 7, updatedAt: '2026-06-19T00:00:00.000Z' }));
    const store = createCounterStore(fetchImpl);

    expect(store.getState().value).toBeNull();

    await store.getState().fetchCounter();

    expect(fetchImpl).toHaveBeenCalledWith('/counter', expect.objectContaining({ method: 'GET' }));
    expect(store.getState().value).toBe(7);
    expect(store.getState().loading).toBe(false);
    expect(store.getState().error).toBeNull();
  });

  it('fetchCounter 失败时设置 error 并复位 loading', async () => {
    const fetchImpl = vi.fn(async () => mkRes({ value: 0, updatedAt: '' }, false, 500));
    const store = createCounterStore(fetchImpl);

    await store.getState().fetchCounter();

    expect(store.getState().loading).toBe(false);
    expect(store.getState().error).toContain('500');
    expect(store.getState().value).toBeNull();
  });

  it('incrementCounter 成功时 value 自增到服务端返回值', async () => {
    const fetchImpl = vi.fn(async () => mkRes({ value: 1, updatedAt: '2026-06-19T00:00:01.000Z' }));
    const store = createCounterStore(fetchImpl);

    await store.getState().incrementCounter();

    expect(fetchImpl).toHaveBeenCalledWith('/counter/inc', expect.objectContaining({ method: 'POST' }));
    expect(store.getState().value).toBe(1);
  });

  it('VITE_API_BASE 注入时 fetch URL 带绝对前缀（packaged 模式跨域）', async () => {
    const fetchImpl = vi.fn(async () => mkRes({ value: 3, updatedAt: '2026-06-19T00:00:03.000Z' }));
    // 显式注入 base（模拟 packaged build 时 VITE_API_BASE=http://127.0.0.1:3720）
    const store = createCounterStore(fetchImpl, 'http://127.0.0.1:3720');

    await store.getState().fetchCounter();

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:3720/counter',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('VITE_API_BASE 缺省时 fetch URL 保持相对（dev 经 vite proxy）', async () => {
    const fetchImpl = vi.fn(async () => mkRes({ value: 0, updatedAt: '2026-06-19T00:00:00.000Z' }));
    // 显式传空串 = dev 模式（VITE_API_BASE 未设 → ''）
    const store = createCounterStore(fetchImpl, '');

    await store.getState().fetchCounter();
    await store.getState().incrementCounter();

    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/counter', expect.objectContaining({ method: 'GET' }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/counter/inc', expect.objectContaining({ method: 'POST' }));
  });

  it('in-flight 期间并发 increment 被忽略（防竞态）', async () => {
    let resolveInc!: (r: Response) => void;
    const incPromise = new Promise<Response>((r) => {
      resolveInc = r;
    });
    const fetchImpl = vi.fn(async () => incPromise);
    const store = createCounterStore(fetchImpl);

    // 触发一次未完成的 inc
    void store.getState().incrementCounter();
    expect(store.getState().loading).toBe(true);

    // 在 in-flight 期间再触发一次 increment，应被忽略（不发起第二次 fetch）
    await store.getState().incrementCounter();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.getState().loading).toBe(true);

    // 完成 in-flight 请求
    resolveInc(mkRes({ value: 5, updatedAt: '2026-06-19T00:00:02.000Z' }));
    await vi.waitFor(() => expect(store.getState().loading).toBe(false));

    expect(store.getState().value).toBe(5);
  });
});
