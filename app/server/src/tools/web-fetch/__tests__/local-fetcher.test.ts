/**
 * LocalContentFetcher 单元测试（白盒）
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §3.3（v1.3，含 headless 子分支）
 *
 * 覆盖：
 *   - 静态充足 → source=local，不起 headless
 *   - 静态不足 + 有 headlessRenderer → 起 headless，source=headless
 *   - 静态不足 + 无 headlessRenderer → ok:false
 *   - headless 子分支被 abort 后仍 kill chrome（mock PlaywrightDriver close 被调）
 *   - fetch 不抛：fetchImpl 抛错 → ok:false
 *   - cleanup idempotent no-op
 *   - 构造注入：signal 字段保存，fetch 内 proxyFetch 接此 signal
 */
import { describe, it, expect, vi } from 'vitest';
import { LocalContentFetcher, MIN_CONTENT, type HeadlessRenderer } from '../local-fetcher';
import type { proxyFetch } from '../proxy';
import type { ResolveDnsFn } from '../ssrf';

type FetchImpl = typeof proxyFetch;

const publicDns: ResolveDnsFn = async () => ['93.184.216.34'];

function makeResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html' } });
}

/** 充足静态 HTML（正文 > MIN_CONTENT） */
function adequateHtml(title = 'Title'): string {
  return `<html><head><title>${title}</title></head><body><article><p>${'A'.repeat(MIN_CONTENT + 50)}</p></article></body></html>`;
}

/** 不充足 SPA HTML */
function inadequateHtml(): string {
  return `<html><body><div id="root"></div><script>render()</script></body></html>`;
}

describe('LocalContentFetcher 静态子分支', () => {
  it('静态充足 → source=local，不起 headless', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(adequateHtml('Doc'))) as unknown as FetchImpl;
    const renderer = vi.fn(async () => adequateHtml('Rendered')) as HeadlessRenderer;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
      headlessRenderer: renderer,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('local');
    // 静态充足 → headless 不应被调用
    expect(renderer).not.toHaveBeenCalled();
  });

  it('静态非 2xx → 退 headless（若有 renderer）', async () => {
    const fetchImpl = vi.fn(async () => makeResponse('', 500)) as unknown as FetchImpl;
    const renderer = vi.fn(async () => adequateHtml('Rendered')) as HeadlessRenderer;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
      headlessRenderer: renderer,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('headless');
    expect(renderer).toHaveBeenCalled();
  });

  it('fetchImpl 抛错 → ok:false（不抛）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('net error');
    }) as unknown as FetchImpl;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    expect(r.ok).toBe(false);
    expect(r.source).toBe('local');
  });
});

describe('LocalContentFetcher headless 子分支', () => {
  it('静态不足 + 有 headlessRenderer 充足 → source=headless', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(inadequateHtml())) as unknown as FetchImpl;
    const renderer = vi.fn(async () => adequateHtml('Rendered')) as HeadlessRenderer;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
      headlessRenderer: renderer,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('headless');
    expect(renderer).toHaveBeenCalledWith('http://example.com/', undefined);
  });

  it('静态不足 + 无 headlessRenderer → ok:false', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(inadequateHtml())) as unknown as FetchImpl;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    expect(r.ok).toBe(false);
  });

  it('静态不足 + headlessRenderer 仍不充足 → ok:false', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(inadequateHtml())) as unknown as FetchImpl;
    const renderer = vi.fn(async () => '<html><body>x</body></html>') as HeadlessRenderer;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
      headlessRenderer: renderer,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    expect(r.ok).toBe(false);
  });

  it('headlessRenderer 抛错 → FetchResult.err 含真实 error message（非笼统吞）', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(inadequateHtml())) as unknown as FetchImpl;
    // 模拟 executeOnce 抛 chrome_not_found（含具体原因）
    const renderer = vi.fn(async () => {
      throw new Error('chrome_not_found: 系统 chrome 未找到且 playwright chromium 不存在');
    }) as HeadlessRenderer;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
      headlessRenderer: renderer,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    expect(r.ok).toBe(false);
    expect(r.err).toBeTruthy();
    // 真实 error message 透出（非笼统 "headless 渲染失败"）
    expect(r.err).toContain('chrome_not_found');
    expect(r.err).toContain('系统 chrome 未找到');
  });

  it('headless 子分支被 abort 后仍调用 cleanup（renderer 内部 finally close/kill）', async () => {
    // mock 一个 PlaywrightDriver 风格的 renderer：navigate 抛 AbortError（模拟 race 输掉被 abort），
    // 但 finally 中 close page/context + kill browser 必须被调用。
    const cleanupLog: string[] = [];
    const renderer: HeadlessRenderer = vi.fn(async () => {
      try {
        // 模拟 navigate 时被 abort
        throw new DOMException('aborted', 'AbortError');
      } finally {
        // spec §3.5：headlessRenderer 内部 finally 关 page + context + kill chrome
        cleanupLog.push('page.close');
        cleanupLog.push('context.close');
        cleanupLog.push('browser.process.kill');
      }
    });
    const fetchImpl = vi.fn(async () => makeResponse(inadequateHtml())) as unknown as FetchImpl;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
      headlessRenderer: renderer,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    // headless 抛 AbortError → fetchHeadless catch → null → ok:false
    expect(r.ok).toBe(false);
    // 关键断言：renderer 内部 finally 的 cleanup 动作被执行（防孤儿 chromium）
    expect(cleanupLog).toContain('page.close');
    expect(cleanupLog).toContain('context.close');
    expect(cleanupLog).toContain('browser.process.kill');
  });
});

describe('LocalContentFetcher 构造注入 signal', () => {
  it('构造时传入的 signal 透传给静态 fetchImpl', async () => {
    const ctrl = new AbortController();
    let captured: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_url: string, init?: Record<string, unknown>) => {
      captured = init?.signal as AbortSignal | undefined;
      return makeResponse(adequateHtml());
    }) as unknown as FetchImpl;
    const fetcher = new LocalContentFetcher({
      signal: ctrl.signal,
      resolveDns: publicDns,
      fetchImpl,
    });
    await fetcher.fetch({ url: 'http://example.com/' });
    expect(captured).toBeDefined();
  });
});

describe('LocalContentFetcher.cleanup', () => {
  it('cleanup idempotent no-op（不抛）', async () => {
    const fetcher = new LocalContentFetcher({ signal: undefined, resolveDns: publicDns });
    await expect(fetcher.cleanup()).resolves.toBeUndefined();
    await expect(fetcher.cleanup()).resolves.toBeUndefined();
  });
});

// ---- v0.0.226 render 参数：forceHeadless 跳过静态直起 headless ----
describe('LocalContentFetcher forceHeadless（render=true）', () => {
  it('forceHeadless=true + renderer 充足 → source=headless，不调静态 fetchImpl', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(adequateHtml('Static'))) as unknown as FetchImpl;
    const renderer = vi.fn(async () => adequateHtml('Rendered')) as HeadlessRenderer;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
      headlessRenderer: renderer,
      forceHeadless: true,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('headless');
    // 关键：静态 fetchImpl 不应被调用（跳过静态分支）
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(renderer).toHaveBeenCalledWith('http://example.com/', undefined);
  });

  it('forceHeadless=true + 无 renderer → ok:false（driver 无 executeOnce，优雅降级）', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(adequateHtml())) as unknown as FetchImpl;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
      forceHeadless: true,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    expect(r.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.err).toContain('无 headlessRenderer');
  });

  it('forceHeadless=true + renderer 内容不足 → ok:false', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(adequateHtml())) as unknown as FetchImpl;
    const renderer = vi.fn(async () => '<html><body>x</body></html>') as HeadlessRenderer;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
      headlessRenderer: renderer,
      forceHeadless: true,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    expect(r.ok).toBe(false);
    // 静态不应被调用
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forceHeadless=true + renderer 抛错 → err 含真实 error', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(adequateHtml())) as unknown as FetchImpl;
    const renderer = vi.fn(async () => {
      throw new Error('chrome_not_found: 系统 chrome 未找到');
    }) as HeadlessRenderer;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
      headlessRenderer: renderer,
      forceHeadless: true,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    expect(r.ok).toBe(false);
    expect(r.err).toContain('chrome_not_found');
  });

  it('forceHeadless 缺省（false）→ 现有行为：静态优先', async () => {
    const fetchImpl = vi.fn(async () => makeResponse(adequateHtml('Static'))) as unknown as FetchImpl;
    const renderer = vi.fn(async () => adequateHtml('Rendered')) as HeadlessRenderer;
    const fetcher = new LocalContentFetcher({
      signal: undefined,
      resolveDns: publicDns,
      fetchImpl,
      headlessRenderer: renderer,
    });
    const r = await fetcher.fetch({ url: 'http://example.com/' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('local');
    // 静态充足 → headless 不调
    expect(renderer).not.toHaveBeenCalled();
  });
});
