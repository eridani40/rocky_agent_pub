/**
 * mask-key + JinaContentFetcher console.log 单元测试（v0.0.121 新增）
 * 参考: app/server/src/tools/web-fetch/mask-key.ts
 *       app/server/src/tools/web-fetch/jina-fetcher.ts（log 行为）
 *
 * 覆盖：
 *   - maskKey 全分支：空/len≤4/4<len≤8/len>8
 *   - 有 key → console.log 含 mask 后的 key
 *   - 无 key → console.log 含 'anonymous'
 */
import { describe, it, expect, vi } from 'vitest';
import { maskKey } from '../mask-key';
import { JinaContentFetcher } from '../jina-fetcher';
import type { proxyFetch } from '../proxy';

type FetchImpl = typeof proxyFetch;

function makeResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/markdown' } });
}

// ——— maskKey 分支测试 ———

describe('maskKey 全分支', () => {
  it('空字符串 → ""', () => {
    expect(maskKey('')).toBe('');
  });

  it('len=1 → "*"（全掩码，len≤4 分支）', () => {
    expect(maskKey('a')).toBe('*');
  });

  it('len=2 → "**"（全掩码，len≤4 分支）', () => {
    expect(maskKey('ab')).toBe('**');
  });

  it('len=4 → "****"（全掩码，len≤4 边界）', () => {
    expect(maskKey('abcd')).toBe('****');
  });

  it('len=5 → 首1+中间3*+末1（4<len≤8 分支）', () => {
    // 'abcde' → 'a***e'
    expect(maskKey('abcde')).toBe('a***e');
  });

  it('len=6 → 首1+中间4*+末1（4<len≤8 分支）', () => {
    // 'abcdef' → 'a****f'
    expect(maskKey('abcdef')).toBe('a****f');
  });

  it('len=8 → 首1+中间6*+末1（4<len≤8 边界）', () => {
    // 'abcdefgh' → 'a******h'
    expect(maskKey('abcdefgh')).toBe('a******h');
  });

  it('len=9 → 首4+中间1*+末4（len>8 分支）', () => {
    // 'abcdefghi' → 'abcd*fghi'
    expect(maskKey('abcdefghi')).toBe('abcd*fghi');
  });

  it('len=12 → 首4+中间4*+末4（len>8 分支）', () => {
    // 'abcdefghijkl' → 'abcd****ijkl'
    expect(maskKey('abcdefghijkl')).toBe('abcd****ijkl');
  });

  it('长 key（len=32）→ 首4+24*+末4', () => {
    const key = 'a'.repeat(4) + 'b'.repeat(24) + 'c'.repeat(4);
    const masked = maskKey(key);
    expect(masked.startsWith('aaaa')).toBe(true);
    expect(masked.endsWith('cccc')).toBe(true);
    expect(masked.length).toBe(32);
    expect(masked.slice(4, 28)).toBe('*'.repeat(24));
  });
});

// ——— JinaContentFetcher console.log 行为测试 ———

describe('JinaContentFetcher console.log（有/无 key）', () => {
  it('有 key → console.log 含 mask 后的 key 字符串', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => makeResponse('content')) as unknown as FetchImpl;
    const fetcher = new JinaContentFetcher({
      signal: undefined,
      fetchImpl,
      devConfig: { jinaApiKey: 'jina_api_key_testkey12' },
    });
    await fetcher.fetch({ url: 'http://example.com/' });

    // 应有 log，且 log 内容含 mask 后的 key（不含原始 key）
    expect(logSpy).toHaveBeenCalled();
    const logCalls = logSpy.mock.calls.flat().join(' ');
    // 原始 key 不应出现
    expect(logCalls).not.toContain('jina_api_key_testkey12');
    // 应含 mask 后的字符（maskKey('jina_api_key_testkey12') = 'jina**************ey12'，len>8 规则）
    expect(logCalls).toContain(maskKey('jina_api_key_testkey12'));
    logSpy.mockRestore();
  });

  it('无 key（undefined）→ console.log 含 "anonymous"', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => makeResponse('content')) as unknown as FetchImpl;
    const fetcher = new JinaContentFetcher({ signal: undefined, fetchImpl });
    await fetcher.fetch({ url: 'http://example.com/' });

    expect(logSpy).toHaveBeenCalled();
    const logCalls = logSpy.mock.calls.flat().join(' ');
    expect(logCalls).toContain('anonymous');
    logSpy.mockRestore();
  });

  it('空 key（空字符串）→ console.log 含 "anonymous"', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => makeResponse('content')) as unknown as FetchImpl;
    const fetcher = new JinaContentFetcher({
      signal: undefined,
      fetchImpl,
      devConfig: { jinaApiKey: '' },
    });
    await fetcher.fetch({ url: 'http://example.com/' });

    expect(logSpy).toHaveBeenCalled();
    const logCalls = logSpy.mock.calls.flat().join(' ');
    expect(logCalls).toContain('anonymous');
    logSpy.mockRestore();
  });

  it('jinaEnabled=false → 不调用 fetchImpl，不 log key（提前返回）', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => makeResponse('content')) as unknown as FetchImpl;
    const fetcher = new JinaContentFetcher({
      signal: undefined,
      fetchImpl,
      devConfig: { jinaEnabled: false, jinaApiKey: 'should-not-log' },
    });
    await fetcher.fetch({ url: 'http://example.com/' });

    // jinaEnabled=false 时 fetch 直接返回 ok:false，不走 key 注入逻辑，不应 log
    const logCalls = logSpy.mock.calls.flat().join(' ');
    expect(logCalls).not.toContain('jina-fetcher');
    logSpy.mockRestore();
  });
});
