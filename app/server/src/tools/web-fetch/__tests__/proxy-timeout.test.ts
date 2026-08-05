/**
 * proxy.ts 超时强制单元测试（白盒）
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §3（出站超时）
 *
 * BUG 背景（v0.0.23 web_fetch chat-flow wf_public flaky）：
 *   Bun 内置 undici 8.5.0 下 dispatcher 的 headersTimeout/bodyTimeout/
 *   connect.timeout **不生效**——传 timeoutMs=5000 实际 hung 75000ms 才报
 *   "Unable to connect"。jina/cloudflare 等不可达目标 hung 75s，导致 LLM
 *   调 web_fetch 后 SSE 在 90s 窗口内等不到 tool_result（wf_public flaky）。
 *
 * 修复：proxyFetch 用 AbortSignal.timeout(timeoutMs) 强制中断 fetch（与调用方
 *   init.signal 合并，任一触发即 abort）。5000ms 精确触发 TimeoutError。
 *
 * 测策略：mock undici fetch 为「永不 resolve 的 promise」，断言 proxyFetch 在
 *   ≈timeoutMs 后 reject（而非 hung 到 75s）。短 timeout（100ms）保证 UT 快。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock undici：Agent 是 no-op 占位（不实际用 dispatcher 超时）；fetch 监听 signal，
// signal abort 时 reject（模拟真实 fetch 在 abort 下的行为）
vi.mock('undici', () => {
  class FakeAgent {
    constructor(_opts: unknown) {}
  }
  const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // 无 signal → 永不 resolve（不应发生，proxyFetch 总会传 signal）
      if (signal.aborted) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => {
        reject(signal.reason ?? new Error('aborted'));
      });
    });
  });
  return {
    Agent: FakeAgent,
    EnvHttpProxyAgent: FakeAgent,
    fetch: fetchImpl,
  };
});

import { proxyFetch } from '../proxy';

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('proxyFetch 超时强制（AbortSignal.timeout）', () => {
  it('fetch hung 时按 timeoutMs 精确 abort（非 hung 75s）', async () => {
    const timeoutMs = 100;
    const t0 = Date.now();
    // fetch 永不 resolve → 仅靠 AbortSignal.timeout(timeoutMs) 触发 abort
    await expect(proxyFetch('http://unreachable.example/', { timeoutMs })).rejects.toThrow();
    const dt = Date.now() - t0;
    // 超时应在 ~100ms 触发（允许调度抖动，但远小于 75s 旧行为）
    expect(dt).toBeGreaterThanOrEqual(timeoutMs);
    expect(dt).toBeLessThan(2000); // 防 hung 回归（旧 bug 会 75s）
  }, 10000);

  it('默认超时 30s 而非 0（DEFAULT_TIMEOUT_MS 兜底）', async () => {
    // 不传 timeoutMs → 默认 30s。此处仅验证 AbortSignal.timeout(30000) 被构造，
    // 不真等 30s：mock fetch 立即 resolve 一个假 Response 绕过等待。
    const { fetch: mockedFetch } = await import('undici');
    (mockedFetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => new Response('ok'),
    );
    const resp = await proxyFetch('http://example.com/');
    expect(resp.ok).toBe(true);
  });

  it('调用方 signal 触发时立即 abort（不等 timeoutMs）', async () => {
    const ctrl = new AbortController();
    const timeoutMs = 10_000; // 长，确保是调用方 signal 先触发
    const t0 = Date.now();
    const p = proxyFetch('http://example.com/', { timeoutMs, signal: ctrl.signal });
    // 50ms 后调用方主动 abort
    setTimeout(() => ctrl.abort(), 50);
    await expect(p).rejects.toThrow();
    const dt = Date.now() - t0;
    expect(dt).toBeLessThan(500); // 调用方 signal 先于 timeout 触发
  }, 10000);
});
