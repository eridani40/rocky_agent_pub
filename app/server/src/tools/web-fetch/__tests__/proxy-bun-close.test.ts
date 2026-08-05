/**
 * proxy.ts Bun undici 兼容性单元测试（白盒）
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §3（dispatcher 用完 close）
 *
 * BUG 背景（v0.0.23 web_search ws_zhipu_tc1）：
 *   Bun 内置 undici 8.5.0 的 Dispatcher（Agent / EnvHttpProxyAgent）**没有 close() 方法**
 *   （`typeof dispatcher.close === 'undefined'`），与官方 undici 不一致。
 *   proxyFetch 的 finally 块直接 `await dispatcher.close()` 会抛
 *   "dispatcher.close is not a function"，被上层 catch 当成 provider 调用失败，
 *   导致 zhipu web_search provider 永远 isError=true（即使 HTTP 已成功返回）。
 *
 * 修复：finally 块加 `typeof d.close === 'function'` 守卫，无 close 则跳过
 * （Bun 下 Agent 由 GC 回收，无句柄泄漏）。
 *
 * 本测试**不 mock undici 的 close**（区别于 proxy-pinning.test.ts 的 FakeAgent.close=vi.fn），
 * 而是构造一个**没有 close 方法**的 dispatcher，验证 proxyFetch 仍能正常返回 Response。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 关键：mock 的 FakeAgent **不带 close 方法**（模拟 Bun 内置 undici 8.5.0）
const agentOptionsCapture: Array<Record<string, unknown>> = [];
vi.mock('undici', () => {
  // Bun-like Agent：无 close 方法（typeof inst.close === 'undefined'）
  class BunLikeAgent {
    constructor(opts: unknown) {
      agentOptionsCapture.push(opts as Record<string, unknown>);
    }
    // 故意不定义 close —— 模拟 Bun undici 缺失
  }
  return {
    Agent: BunLikeAgent,
    EnvHttpProxyAgent: BunLikeAgent,
    fetch: vi.fn(async () => new Response('bun-ok')),
  };
});

import { proxyFetch } from '../proxy';

beforeEach(() => {
  agentOptionsCapture.length = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('proxyFetch Bun undici 兼容（dispatcher 无 close 方法）', () => {
  it('dispatcher.close 缺失时 proxyFetch 不抛错且返回 Response', async () => {
    // 直连路径（env 无 PROXY）→ createDirectDispatcher → new Agent（Bun-like，无 close）
    const resp = await proxyFetch('http://example.com/');
    expect(resp.ok).toBe(true);
    const text = await resp.text();
    expect(text).toBe('bun-ok');
  });

  it('dispatcher.close 缺失时多次调用稳定（不残留 throw）', async () => {
    // 多次调用验证 finally 守卫稳定（GC 路径不抛）
    for (let i = 0; i < 3; i++) {
      const r = await proxyFetch('http://example.com/' + i);
      expect(r.ok).toBe(true);
    }
    // 至少构造了 3 个 dispatcher（每次新建）
    expect(agentOptionsCapture.length).toBeGreaterThanOrEqual(3);
  });

  it('有 PROXY env 时 EnvHttpProxyAgent 无 close 也不抛', async () => {
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:7890');
    try {
      const resp = await proxyFetch('http://example.com/proxy');
      expect(resp.ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
