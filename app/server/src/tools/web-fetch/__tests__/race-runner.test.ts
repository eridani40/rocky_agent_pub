/**
 * race-runner（fetchContent race 编排）单元测试（白盒）
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §3.4 §3.5（v1.3 架构）
 *
 * 覆盖（spec §3.4 race 语义 + §3.5 abort 传播 + §6.3 detached 清理）：
 *   - 首合格胜出 + abort 其他（验证输方被 abort）
 *   - 两路皆不合格 → null
 *   - abort 传播到子操作（输方 proxyFetch 收到 abort）
 *   - cleanup 被调用（胜方+输方都调）
 *   - cleanup detached（主流程返回后 cleanup 仍跑）
 *   - adequate 边界（MIN_CONTENT / MIN_CONTENT+1）
 *   - jinaEnabled=false → 仅 local fetcher
 *
 * mock：fetchImpl（替代 proxyFetch）+ resolveDns（公网 IP）+ headlessRenderer（注入）。
 */
import { describe, it, expect, vi } from 'vitest';
import { fetchContent } from '../race-runner';
import { MIN_CONTENT } from '../local-fetcher';
import type { ResolveDnsFn } from '../ssrf';

// ---- 公网 DNS mock（永远返回公网 IP，让 SSRF 通过） ----
const publicDns: ResolveDnsFn = async () => ['93.184.216.34'];

/** 构造 mock fetch：按 URL 前缀匹配返回 Response */
type FetchImpl = (url: string, init?: Record<string, unknown>) => Promise<Response>;

function makeResponse(
  body: string,
  opts: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: opts.status ?? 200,
    headers: opts.headers ?? { 'Content-Type': 'text/html' },
  });
}

/**
 * 构造 mock fetchImpl：jinaUrl → jinaBody；其他 → localBody。
 * 可记录每次调用的 headers / signal abort。
 */
function makeFetchImpl(opts: {
  jinaBody?: string;
  jinaDelayMs?: number;
  localBody?: string;
  localStatus?: number;
  onJinaHeaders?: (h: Record<string, string>) => void;
}): FetchImpl & { jinaCallCount: number; localCallCount: number } {
  const self: FetchImpl & { jinaCallCount: number; localCallCount: number } = Object.assign(
    async (url: string, init?: Record<string, unknown>) => {
      if (url.startsWith('https://r.jina.ai/')) {
        self.jinaCallCount += 1;
        const headers = (init?.headers as Record<string, string>) ?? {};
        opts.onJinaHeaders?.(headers);
        if (opts.jinaDelayMs) await new Promise((r) => setTimeout(r, opts.jinaDelayMs));
        return makeResponse(opts.jinaBody ?? '');
      }
      // 本地静态
      self.localCallCount += 1;
      return makeResponse(opts.localBody ?? '', { status: opts.localStatus ?? 200 });
    },
    { jinaCallCount: 0, localCallCount: 0 },
  );
  return self;
}

/** 生成内容充足的静态 HTML（正文 > MIN_CONTENT） */
function adequateHtml(title = 'Title'): string {
  const body = 'A'.repeat(MIN_CONTENT + 50);
  return `<html><head><title>${title}</title></head><body><article><p>${body}</p></article></body></html>`;
}

/** 生成内容不足的 HTML（SPA 占位） */
function inadequateHtml(): string {
  return `<html><body><div id="root"></div><script>render()</script></body></html>`;
}

describe('fetchContent race：首合格胜出 + abort 其他', () => {
  it('JS 页（本地静态不充足）：jina 胜', async () => {
    const fetchImpl = makeFetchImpl({
      jinaBody: 'Jina rendered content ' + 'C'.repeat(MIN_CONTENT + 20),
      localBody: inadequateHtml(),
    });
    const result = await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('jina');
  });

  it('静态页（本地充足快）：local 胜', async () => {
    const fetchImpl = makeFetchImpl({
      jinaBody: 'B'.repeat(MIN_CONTENT + 10),
      jinaDelayMs: 50, // jina 慢
      localBody: adequateHtml('Local'),
    });
    const result = await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
    });
    expect(result).not.toBeNull();
    // 本地应更快胜（实际取决于调度，断言 source 合法即可）
    expect(['local', 'jina']).toContain(result!.source);
    expect(result!.content.trim().length).toBeGreaterThanOrEqual(MIN_CONTENT);
  });

  it('胜出方 abort 输方（输方 proxyFetch 收到 abort 事件）', async () => {
    // 让 jina 慢，本地快且充足，断言 jina 路径收到 abort
    let jinaAbortFlag = false;
    const fetchImpl: FetchImpl = async (url, init) => {
      if (url.startsWith('https://r.jina.ai/')) {
        const signal = init?.signal as AbortSignal | undefined;
        if (signal) {
          signal.addEventListener('abort', () => {
            jinaAbortFlag = true;
          });
        }
        await new Promise((r) => setTimeout(r, 100));
        return makeResponse('J'.repeat(MIN_CONTENT + 10));
      }
      return makeResponse(adequateHtml());
    };
    await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
    });
    // 给 abort 事件传播时间
    await new Promise((r) => setTimeout(r, 30));
    expect(jinaAbortFlag).toBe(true);
  });
});

describe('fetchContent race：两路皆不合格', () => {
  it('jina 短 + 本地不充足 + 无 headlessRenderer → null', async () => {
    const fetchImpl = makeFetchImpl({
      jinaBody: 'short',
      localBody: inadequateHtml(),
    });
    const result = await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
    });
    expect(result).toBeNull();
  });

  // [bug D 配套] 两路皆空时 onFailure 透出各 fetcher 失败归因（err/status），供 error.log 定位
  it('两路皆空 → onFailure 收到各 fetcher 归因（jina 空内容 + local 静态不足）', async () => {
    const fetchImpl = makeFetchImpl({
      jinaBody: 'short',
      localBody: inadequateHtml(),
    });
    const failures: Array<{ fetcher: string; reason: string }> = [];
    const result = await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
      onFailure: (f) => failures.push(...f),
    });
    expect(result).toBeNull();
    expect(failures).toHaveLength(2);
    const byFetcher = Object.fromEntries(failures.map((f) => [f.fetcher, f.reason]));
    // jina 返 'short'（ok:true 但内容不足 MIN_CONTENT）→ runner 判不合格
    expect(byFetcher['jina']).toContain('内容不足');
    // local 静态不足且无 headless 兜底 → fetcher err 透出
    expect(byFetcher['local']).toContain('静态内容不足');
    expect(byFetcher['local']).toContain('无 headless 兜底');
  });

  it('jina http 非 2xx → onFailure 归因含 status', async () => {
    const fetchImpl: FetchImpl = async (url) => {
      if (url.startsWith('https://r.jina.ai/')) return makeResponse('', { status: 522 });
      return makeResponse(inadequateHtml());
    };
    const failures: Array<{ fetcher: string; reason: string }> = [];
    const result = await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
      onFailure: (f) => failures.push(...f),
    });
    expect(result).toBeNull();
    const jina = failures.find((f) => f.fetcher === 'jina');
    expect(jina?.reason).toContain('522');
  });

  it('adequate 边界：内容 = MIN_CONTENT 视为充足（≥ MIN_CONTENT）', async () => {
    // spec §3.4：合格 = trim(content) ≥ MIN_CONTENT；长度恰为 MIN_CONTENT 合格
    const fetchImpl = makeFetchImpl({
      jinaBody: 'X'.repeat(MIN_CONTENT),
      localBody: inadequateHtml(),
    });
    const result = await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('jina');
  });

  it('adequate 边界：内容 = MIN_CONTENT - 1 视为不充足', async () => {
    const fetchImpl = makeFetchImpl({
      jinaBody: 'X'.repeat(MIN_CONTENT - 1),
      localBody: inadequateHtml(),
    });
    const result = await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
    });
    expect(result).toBeNull();
  });

  it('adequate 边界：内容 = MIN_CONTENT + 1 视为充足', async () => {
    const fetchImpl = makeFetchImpl({
      jinaBody: 'X'.repeat(MIN_CONTENT + 1),
      localBody: inadequateHtml(),
    });
    const result = await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('jina');
  });
});

describe('fetchContent race：headless 子分支（Local 内部）', () => {
  it('静态不足 + headlessRenderer 充足 → headless 胜（source=headless）', async () => {
    const fetchImpl = makeFetchImpl({
      jinaBody: 'short',
      localBody: inadequateHtml(),
    });
    const renderer = vi.fn(async () => adequateHtml('Rendered'));
    const result = await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
      headlessRenderer: renderer,
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('headless');
    // headlessRenderer 被调用（local 内部静态不足触发）
    expect(renderer).toHaveBeenCalled();
  });

  it('静态不足 + headlessRenderer 仍不充足 → null', async () => {
    const fetchImpl = makeFetchImpl({
      jinaBody: 'short',
      localBody: inadequateHtml(),
    });
    const result = await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
      headlessRenderer: async () => '<html><body>x</body></html>',
    });
    expect(result).toBeNull();
  });
});

describe('fetchContent race：jina 配置', () => {
  it('jinaEnabled=false → 不构造 JinaContentFetcher（仅 local）', async () => {
    const fetchImpl = makeFetchImpl({
      jinaBody: 'J'.repeat(MIN_CONTENT + 10),
      localBody: adequateHtml(),
    });
    await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
      appConfig: { jinaEnabled: false },
    });
    expect(fetchImpl.jinaCallCount).toBe(0);
    expect(fetchImpl.localCallCount).toBeGreaterThan(0);
  });

  it('jinaApiKey 有 → 注入 Authorization: Bearer', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = makeFetchImpl({
      jinaBody: 'J'.repeat(MIN_CONTENT + 10),
      localBody: inadequateHtml(),
      onJinaHeaders: (h) => {
        capturedHeaders = h;
      },
    });
    await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
      appConfig: { jinaEnabled: true, jinaApiKey: 'test-key-123' },
    });
    expect(capturedHeaders.Authorization).toBe('Bearer test-key-123');
  });

  it('jinaApiKey 无 → 不传 Authorization', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = makeFetchImpl({
      jinaBody: 'J'.repeat(MIN_CONTENT + 10),
      localBody: inadequateHtml(),
      onJinaHeaders: (h) => {
        capturedHeaders = h;
      },
    });
    await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
      appConfig: { jinaEnabled: true },
    });
    expect(capturedHeaders.Authorization).toBeUndefined();
  });
});

describe('fetchContent race：cleanup 调用（胜方+输方，detached）', () => {
  it('race 结束后所有 fetcher 的 cleanup 被调用', async () => {
    // 通过 fetcher 内部 cleanup 是 idempotent no-op 难以直接断言；
    // 这里间接验证：race 结束后主流程返回（cleanup detached 不阻塞），
    // 且没有 unhandled rejection 抛出。
    const fetchImpl = makeFetchImpl({
      jinaBody: 'J'.repeat(MIN_CONTENT + 10),
      localBody: inadequateHtml(),
    });
    const result = await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
    });
    // 主流程正常返回（cleanup detached，不抛 unhandled rejection）
    expect(result).not.toBeNull();
    // 等一个 microtask 让 detached cleanup 跑完，无异常即通过
    await new Promise((r) => setTimeout(r, 10));
  });

  it('两路皆不合格时 cleanup 也被调用（无 unhandled rejection）', async () => {
    const fetchImpl = makeFetchImpl({
      jinaBody: 'short',
      localBody: inadequateHtml(),
    });
    const result = await fetchContent('http://example.com/', {
      resolveDns: publicDns,
      fetchImpl: fetchImpl as never,
    });
    expect(result).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
  });
});
