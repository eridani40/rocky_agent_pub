/**
 * proxy.ts DNS pinning + redirect 默认值单元测试（白盒）
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §4（DNS pinning 要求）
 *
 * M2 闭合验证：
 *   - resolvedIp 给定 → 用 pinned dispatcher（connect.lookup 固定返该 IP，不重新解析）
 *   - rebinding 场景：lookup 永远返第一次 pinned 的 IP（即使后续 DNS 变化）
 *   - 未给 resolvedIp → 普通 dispatcher（无 lookup hook，DNS 重新解析）
 * m2 闭合验证：
 *   - init.redirect 显式 → 用之
 *   - 未给 redirect：noFollowRedirect=true → 'manual'；false/undefined → 'follow'
 *
 * 测试手法：mock undici 的 Agent / EnvHttpProxyAgent 构造，捕获 connect.lookup，
 * 直接调用 lookup callback 验证它返回 pinned IP（不真联网）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock undici：捕获 Agent 构造 options + 替换 fetch
const agentOptionsCapture: Array<{ connect?: { lookup?: unknown } }> = [];
vi.mock('undici', () => {
  class FakeAgent {
    constructor(opts: unknown) {
      agentOptionsCapture.push(opts as { connect?: { lookup?: unknown } });
    }
    close = vi.fn(async () => {});
  }
  return {
    Agent: FakeAgent,
    EnvHttpProxyAgent: class {
      close = vi.fn(async () => {});
    },
    fetch: vi.fn(async () => new Response('ok')),
  };
});

import { proxyFetch, createPinnedDispatcher } from '../proxy';
import { fetch as mockFetch } from 'undici';

beforeEach(() => {
  agentOptionsCapture.length = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('proxyFetch DNS pinning（M2）', () => {
  it('resolvedIp 给定 → dispatcher 用 pinned Agent 且 connect.lookup 固定返该 IP', async () => {
    await proxyFetch('http://example.com/', { resolvedIp: '93.184.216.34' });
    // 应该构造了至少一个 Agent（pinned 路径走 createPinnedDispatcher → new Agent）
    expect(agentOptionsCapture.length).toBeGreaterThanOrEqual(1);
    const last = lastAgentOpts();
    expect(last.connect).toBeDefined();
    expect(typeof last.connect?.lookup).toBe('function');
    // 直接调 lookup callback，验证它返回 pinned IP（而非重新解析）
    const lookup = last.connect!.lookup as (
      host: string,
      opts: unknown,
      cb: (err: unknown, addr: string, fam: number) => void,
    ) => void;
    let resolved: { addr: string; fam: number } | null = null;
    lookup('example.com', {}, (_err, addr, fam) => {
      resolved = { addr, fam };
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.addr).toBe('93.184.216.34');
    expect(resolved!.fam).toBe(4);
  });

  it('rebinding 防护：lookup 多次调用永远返第一次 pinned 的 IP', async () => {
    await proxyFetch('http://example.com/', { resolvedIp: '1.2.3.4' });
    const last = lastAgentOpts();
    const lookup = last.connect!.lookup as (
      host: string,
      opts: unknown,
      cb: (err: unknown, addr: string, fam: number) => void,
    ) => void;
    // 模拟攻击者两次 DNS 解析返回不同 IP——但 pinned lookup 应该忽略，固定返 1.2.3.4
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      lookup('example.com', {}, (_e, addr) => {
        results.push(addr);
      });
    }
    expect(results).toEqual(['1.2.3.4', '1.2.3.4', '1.2.3.4']);
  });

  it('IPv6 pinned IP → lookup 返 family=6', async () => {
    await proxyFetch('http://example.com/', { resolvedIp: '2606:2800:220:1::1' });
    const last = lastAgentOpts();
    const lookup = last.connect!.lookup as (
      host: string,
      opts: unknown,
      cb: (err: unknown, addr: string, fam: number) => void,
    ) => void;
    let fam = 0;
    lookup('example.com', {}, (_e, _addr, f) => {
      fam = f;
    });
    expect(fam).toBe(6);
  });

  it('未给 resolvedIp → dispatcher 无 lookup hook（DNS 走默认重新解析）', async () => {
    // 确保没有代理 env 干扰（直连路径）
    const saved: NodeJS.ProcessEnv = { ...process.env };
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    try {
      await proxyFetch('http://example.com/');
      const last = lastAgentOpts();
      // 普通 Agent 不设 lookup（connect 只有 timeout）
      expect(last.connect?.lookup).toBeUndefined();
    } finally {
      process.env = saved;
    }
  });
});

describe('createPinnedDispatcher', () => {
  it('构造的 Agent connect.lookup 返 pinned IP', () => {
    agentOptionsCapture.length = 0;
    createPinnedDispatcher('8.8.8.8');
    expect(agentOptionsCapture.length).toBe(1);
    const opts = agentOptionsCapture[0]!;
    expect(typeof opts.connect?.lookup).toBe('function');
  });
});

// [bug A 锁死] undici/node net 真实调用形态：lookup(hostname, {all:true,...}, cb)
// 期望 cb(null, [{address, family}])（数组形态）。此前 UT 只测无 all 形态 → prod Node
// runtime 抛 "Invalid IP address: undefined" 全挂却 UT 全绿（漏检根源）。
describe('lookup options.all 形态（undici 真实调用，bug A）', () => {
  /** 从 pinned dispatcher 取 lookup hook */
  function captureLookup(): (
    host: string,
    opts: unknown,
    cb: (...args: unknown[]) => void,
  ) => void {
    agentOptionsCapture.length = 0;
    createPinnedDispatcher('93.184.216.34');
    const opts = agentOptionsCapture[0]!;
    return opts.connect!.lookup as (
      host: string,
      o: unknown,
      cb: (...args: unknown[]) => void,
    ) => void;
  }

  it('all:true → cb 收到 [{address, family}] 数组形态（IPv4）', () => {
    const lookup = captureLookup();
    const calls: unknown[][] = [];
    // 模拟 undici/node net 真实调用：lookup(host, {all:true, family:0, hints}, cb)
    lookup('example.com', { all: true, family: 0, hints: 0 }, (...args: unknown[]) => {
      calls.push(args);
    });
    expect(calls.length).toBe(1);
    const [err, list] = calls[0]!;
    expect(err).toBeNull();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('all:true + IPv6 pinned → 数组元素 family=6', () => {
    agentOptionsCapture.length = 0;
    createPinnedDispatcher('2606:2800:220:1::1');
    const lookup = agentOptionsCapture[0]!.connect!.lookup as (
      host: string,
      o: unknown,
      cb: (...args: unknown[]) => void,
    ) => void;
    let list: unknown = null;
    lookup('example.com', { all: true }, (_e: unknown, l: unknown) => {
      list = l;
    });
    expect(list).toEqual([{ address: '2606:2800:220:1::1', family: 6 }]);
  });

  it('all 缺省/false → 保持 (err, address, family) 标量形态（回归既有契约）', () => {
    const lookup = captureLookup();
    const calls: unknown[][] = [];
    lookup('example.com', {}, (...args: unknown[]) => calls.push(args));
    lookup('example.com', { all: false }, (...args: unknown[]) => calls.push(args));
    expect(calls[0]).toEqual([null, '93.184.216.34', 4]);
    expect(calls[1]).toEqual([null, '93.184.216.34', 4]);
  });

  it('(_, cb) 两实参形态 → 标量形态（形参归一逻辑保留）', () => {
    const lookup = captureLookup();
    const calls: unknown[][] = [];
    (lookup as unknown as (host: string, cb: (...a: unknown[]) => void) => void)(
      'example.com',
      (...args: unknown[]) => calls.push(args),
    );
    expect(calls[0]).toEqual([null, '93.184.216.34', 4]);
  });
});

describe('proxyFetch redirect 默认值（m2）', () => {
  it('init.redirect 显式 follow → 透传 follow', async () => {
    await proxyFetch('http://example.com/', { redirect: 'follow' });
    expect(capturedRedirect()).toBe('follow');
  });

  it('init.redirect 显式 manual → 透传 manual', async () => {
    await proxyFetch('http://example.com/', { redirect: 'manual' });
    expect(capturedRedirect()).toBe('manual');
  });

  it('无 redirect + noFollowRedirect=true → manual', async () => {
    await proxyFetch('http://example.com/', { noFollowRedirect: true });
    expect(capturedRedirect()).toBe('manual');
  });

  it('无 redirect + noFollowRedirect=false → follow', async () => {
    await proxyFetch('http://example.com/', { noFollowRedirect: false });
    expect(capturedRedirect()).toBe('follow');
  });
});

/** 取最近一次构造的 Agent options（断言非空） */
function lastAgentOpts(): { connect?: { lookup?: unknown } } {
  const opts = agentOptionsCapture[agentOptionsCapture.length - 1];
  if (!opts) throw new Error('test setup: 没有 Agent 被构造');
  return opts;
}

/** 取最近一次 mock fetch 调用的 init.redirect */
function capturedRedirect(): string {
  const calls = (mockFetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('test setup: 没有 fetch 调用');
  return (last[1] as { redirect: string }).redirect;
}
