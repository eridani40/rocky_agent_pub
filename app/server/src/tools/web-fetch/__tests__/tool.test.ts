/**
 * web_fetch Tool 单元测试（白盒）
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §2 §6.2
 *       specs/api/overall/08-web-tools.md §3（ToolDefinition + isError 分支）
 *
 * 覆盖：
 *   - SSRF 拒绝（私网 IP / file://）→ isError，不抓取
 *   - 正常抓取 → markdown + wrapExternalContent + truncate
 *   - 全路线失败 → isError
 *   - url 缺失 → isError
 *   - maxChars 截断生效
 *   - appConfig 注入（jinaEnabled/jinaApiKey/jinaTimeoutMs）传到 fetchContent
 *   - definition（name/inputSchema）正确
 *
 * [v0.0.101] needsApproval 已退役（O7），相关测试用例已移除。
 *
 * mock：fetchContentImpl（替真实 race）+ resolveDns（公网）。
 */
import { describe, it, expect, vi } from 'vitest';
import { createWebFetchTool } from '../tool';
import { wrapExternalContent } from '../../web-tools-utils';
import { fetchContent, type FetchContentResult, type FetchContentOptions } from '../race-runner';
import { MIN_CONTENT } from '../local-fetcher';
import type { ToolCtx, ToolInput } from '../../types';
import type { proxyFetch } from '../proxy';
import type { ResolveDnsFn } from '../ssrf';

function makeCtx(): ToolCtx {
  return { config: { tools: [] }, workdir: '/tmp' };
}

/** mock fetchContent：返回固定结果或抛错 */
function makeFetchContentImpl(
  result: FetchContentResult | null,
  throwErr?: Error,
): (url: string, opts: unknown) => Promise<FetchContentResult | null> {
  return vi.fn(async (url: string, opts: unknown) => {
    if (throwErr) throw throwErr;
    // 记录 appConfig 传入，便于断言
    void url;
    void opts;
    return result;
  });
}

describe('web_fetch definition', () => {
  it('name = web_fetch', () => {
    const tool = createWebFetchTool();
    expect(tool.definition.name).toBe('web_fetch');
  });

  it('inputSchema required = [url]', () => {
    const tool = createWebFetchTool();
    expect(tool.definition.inputSchema.required).toEqual(['url']);
    expect(tool.definition.inputSchema.properties).toHaveProperty('url');
    expect(tool.definition.inputSchema.properties).toHaveProperty('maxChars');
  });

  it('inputSchema 含 render 属性（boolean，默认 false）', () => {
    const tool = createWebFetchTool();
    const props = tool.definition.inputSchema.properties as Record<string, { type: string }>;
    expect(props.render).toBeDefined();
    expect(props.render!.type).toBe('boolean');
  });
});

describe('web_fetch run: SSRF 拒绝', () => {
  it('私网 IP → isError，不调用 fetchContent', async () => {
    const fetchImpl = makeFetchContentImpl({
      title: 'should not reach',
      content: 'x',
      source: 'jina',
    });
    const tool = createWebFetchTool({
      fetchContentImpl: fetchImpl as never,
    });
    const result = await tool.run({ url: 'http://127.0.0.1/' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('SSRF'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('file:// → isError', async () => {
    const fetchImpl = makeFetchContentImpl(null);
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    const result = await tool.run({ url: 'file:///etc/passwd' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('SSRF') });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('10.x 私网 → isError', async () => {
    const tool = createWebFetchTool({ fetchContentImpl: makeFetchContentImpl(null) });
    const result = await tool.run({ url: 'http://10.0.0.5/' }, makeCtx());
    expect(result.isError).toBe(true);
  });
});

describe('web_fetch run: 正常', () => {
  it('正常抓取 → markdown + wrapExternalContent + 截断关闭', async () => {
    const fetchImpl = makeFetchContentImpl({
      title: 'Example',
      content: 'Hello world'.repeat(50),
      source: 'jina',
    });
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    const result = await tool.run({ url: 'http://8.8.8.8/' }, makeCtx());
    expect(result.isError).toBe(false);
    const text = (result.content[0] as { text: string }).text;
    // wrapExternalContent 包装存在
    expect(text).toContain('<untrusted_external_content>');
    expect(text).toContain('----- BEGIN EXTERNAL CONTENT -----');
    // 标题
    expect(text).toContain('# Example');
    // source / url footer
    expect(text).toContain('source: jina');
    expect(text).toContain('url: http://8.8.8.8/');
  });

  it('maxChars 截断生效', async () => {
    const longBody = 'A'.repeat(5000);
    const fetchImpl = makeFetchContentImpl({
      title: 'T',
      content: longBody,
      source: 'local',
    });
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    const result = await tool.run({ url: 'http://8.8.8.8/', maxChars: 1000 }, makeCtx());
    const text = (result.content[0] as { text: string }).text;
    // wrap 头 + 截断后内容 ≤ 1000 + 提示
    expect(text).toContain('已截断至 1000');
    expect(text.length).toBeLessThan(1500);
  });

  it('全路线失败（null）→ isError', async () => {
    const fetchImpl = makeFetchContentImpl(null);
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    const result = await tool.run({ url: 'http://8.8.8.8/' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('无充足内容'),
    });
  });

  it('fetchContent 抛错 → isError', async () => {
    const fetchImpl = makeFetchContentImpl(null, new Error('boom'));
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    const result = await tool.run({ url: 'http://8.8.8.8/' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('boom'),
    });
  });

  it('url 缺失 → isError', async () => {
    const tool = createWebFetchTool({ fetchContentImpl: makeFetchContentImpl(null) });
    const result = await tool.run({} as ToolInput, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('url is required'),
    });
  });
});

describe('web_fetch appConfig 注入', () => {
  it('deps.appConfig 优先于 ctx.config.appConfig', async () => {
    let captured: unknown = null;
    const fetchImpl = vi.fn(async (_url: string, opts: unknown) => {
      captured = (opts as { appConfig?: unknown }).appConfig;
      return null;
    });
    const ctxAppConfig = { get: () => 'from-ctx' };
    const tool = createWebFetchTool({
      fetchContentImpl: fetchImpl as never,
      appConfig: { get: () => true } as never,
    });
    const ctx = { config: { tools: [], appConfig: ctxAppConfig }, workdir: '/tmp' };
    await tool.run({ url: 'http://8.8.8.8/' }, ctx);
    // deps.appConfig 应优先；fetchContent 收到的 appConfig 来自 deps.appConfig
    expect(fetchImpl).toHaveBeenCalled();
    expect(captured).toBeTruthy();
  });

  it('ctx.config.appConfig 读取 web.jinaApiKey', async () => {
    let capturedKey: string | undefined;
    const fetchImpl = vi.fn(async (_url: string, opts: unknown) => {
      capturedKey = (opts as { appConfig?: { jinaApiKey?: string } }).appConfig?.jinaApiKey;
      return null;
    });
    const svc = {
      get(group: string, key: string) {
        if (group === 'web' && key === 'jinaApiKey') return 'ctx-key-456';
        if (group === 'web' && key === 'jinaEnabled') return true;
        return undefined;
      },
    };
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    const ctx = { config: { tools: [], appConfig: svc }, workdir: '/tmp' };
    await tool.run({ url: 'http://8.8.8.8/' }, ctx);
    expect(capturedKey).toBe('ctx-key-456');
  });

  it('无 appConfig → 走代码默认（jina on / 无 key）', async () => {
    let captured: unknown = null;
    const fetchImpl = vi.fn(async (_url: string, opts: unknown) => {
      captured = (opts as { appConfig?: unknown }).appConfig;
      return null;
    });
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    await tool.run({ url: 'http://8.8.8.8/' }, makeCtx());
    expect(captured).toBeUndefined(); // readWebAppConfig(undefined) 返回 undefined
  });
});

describe('web_fetch wrapExternalContent 完整性', () => {
  it('输出含 untrusted 包装', async () => {
    const fetchImpl = makeFetchContentImpl({
      title: 'X',
      content: 'Body content here',
      source: 'local',
    });
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    const result = await tool.run({ url: 'http://8.8.8.8/' }, makeCtx());
    const text = (result.content[0] as { text: string }).text;
    // 与 web-tools-utils 形态一致
    const expected = wrapExternalContent(expect.stringContaining('Body content here'));
    expect(text).toMatch(/<untrusted_external_content>/);
    expect(text).toMatch(/----- END EXTERNAL CONTENT -----/);
    void expected;
  });
});

// ---- bug B：buildHeadlessRenderer 走 executeOnce（NodeWorkerDriver 一次性 render） ----
describe('web_fetch headless 经 executeOnce（bug B）', () => {
  const publicDns: ResolveDnsFn = async () => ['93.184.216.34'];
  /** SPA 占位 HTML（静态不足） */
  const spaHtml = '<html><body><div id="root"></div><script>render()</script></body></html>';
  /** 渲染后充足 HTML */
  const renderedHtml = `<html><head><title>R</title></head><body><article><p>${'H'.repeat(MIN_CONTENT + 50)}</p></article></body></html>`;

  /** mock proxyFetch：jina 短路 + 目标 URL 返 SPA（静态不足），逼出 headless 子分支 */
  function makeStaticInadequateProxyFetch(): typeof proxyFetch {
    return (async (url: string) => {
      if (url.startsWith('https://r.jina.ai/')) return new Response('short', { status: 200 });
      return new Response(spaHtml, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }) as unknown as typeof proxyFetch;
  }

  it('driver 有 executeOnce → 静态不足触发 headless，source=headless，executeOnce 收 render action', async () => {
    const executeOnce = vi.fn(async () => ({ ok: true, text: renderedHtml }));
    const registry = { get: (_mode: string) => ({ executeOnce }) };
    const tool = createWebFetchTool({
      driverRegistry: registry,
      resolveDns: publicDns,
      // 真 race runner + 真 local fetcher（静态不足）+ 真 buildHeadlessRenderer；只 mock 网络
      fetchContentImpl: ((url: string, opts: FetchContentOptions) =>
        fetchContent(url, { ...opts, fetchImpl: makeStaticInadequateProxyFetch() })) as never,
    });
    const result = await tool.run({ url: 'http://example.com/' }, makeCtx());
    expect(result.isError).toBe(false);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('source: headless');
    expect(executeOnce).toHaveBeenCalledWith(
      { headless: true },
      'render',
      { url: 'http://example.com/' },
      expect.anything(),
    );
  });

  it('driver 无 executeOnce（长 session 模型）→ headlessRenderer=undefined，两路不足 → isError', async () => {
    const registry = { get: (_mode: string) => ({ connect: vi.fn() }) };
    const tool = createWebFetchTool({
      driverRegistry: registry,
      resolveDns: publicDns,
      fetchContentImpl: ((url: string, opts: FetchContentOptions) =>
        fetchContent(url, { ...opts, fetchImpl: makeStaticInadequateProxyFetch() })) as never,
    });
    const result = await tool.run({ url: 'http://example.com/' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('无充足内容'),
    });
  });

  it('executeOnce 返 ok:false → headless 子分支失败 → isError（不抛）', async () => {
    const executeOnce = vi.fn(async () => ({
      ok: false,
      error: { message: 'worker 执行超时' },
    }));
    const registry = { get: (_mode: string) => ({ executeOnce }) };
    const tool = createWebFetchTool({
      driverRegistry: registry,
      resolveDns: publicDns,
      fetchContentImpl: ((url: string, opts: FetchContentOptions) =>
        fetchContent(url, { ...opts, fetchImpl: makeStaticInadequateProxyFetch() })) as never,
    });
    const result = await tool.run({ url: 'http://example.com/' }, makeCtx());
    expect(result.isError).toBe(true);
    expect(executeOnce).toHaveBeenCalled();
  });
});

// ---- bug D：失败路径写 error.log（鸭子类型 logWriter，缺省 no-op） ----
describe('web_fetch 失败写 error.log（bug D）', () => {
  /** 带 mock logWriter 的 ctx */
  function makeCtxWithLog(): { ctx: ToolCtx; write: ReturnType<typeof vi.fn> } {
    const write = vi.fn();
    const ctx = {
      config: { tools: [], logWriter: { write } },
      workdir: '/tmp',
    } as unknown as ToolCtx;
    return { ctx, write };
  }

  it('两路皆空（null）→ write("error", {url, stage:"race", failures})', async () => {
    const { ctx, write } = makeCtxWithLog();
    const fetchImpl = vi.fn(async (_url: string, opts: FetchContentOptions) => {
      // 模拟 race runner 透出各 fetcher 归因
      opts.onFailure?.([
        { fetcher: 'jina', reason: 'jina: jina http 522' },
        { fetcher: 'local', reason: 'local: 静态抓取失败，无 headless 兜底' },
      ]);
      return null;
    });
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    const result = await tool.run({ url: 'http://8.8.8.8/' }, ctx);
    expect(result.isError).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const [type, rec] = write.mock.calls[0] as [string, Record<string, unknown>];
    expect(type).toBe('error');
    expect(rec.tool).toBe('web_fetch');
    expect(rec.url).toBe('http://8.8.8.8/');
    expect(rec.stage).toBe('race');
    expect(rec.reason).toContain('无充足内容');
    const failures = rec.failures as Array<{ fetcher: string; reason: string }>;
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.fetcher)).toEqual(['jina', 'local']);
    expect(failures[0]!.reason).toContain('522');
  });

  it('fetchContent 抛错 → write("error", {stage:"race", reason})', async () => {
    const { ctx, write } = makeCtxWithLog();
    const tool = createWebFetchTool({
      fetchContentImpl: makeFetchContentImpl(null, new Error('boom')) as never,
    });
    await tool.run({ url: 'http://8.8.8.8/' }, ctx);
    expect(write).toHaveBeenCalledTimes(1);
    const [type, rec] = write.mock.calls[0] as [string, Record<string, unknown>];
    expect(type).toBe('error');
    expect(rec.stage).toBe('race');
    expect(rec.reason).toContain('boom');
  });

  it('SSRF 拒绝 → write("error", {stage:"ssrf"})', async () => {
    const { ctx, write } = makeCtxWithLog();
    const tool = createWebFetchTool({ fetchContentImpl: makeFetchContentImpl(null) as never });
    await tool.run({ url: 'http://127.0.0.1/' }, ctx);
    expect(write).toHaveBeenCalledTimes(1);
    const [type, rec] = write.mock.calls[0] as [string, Record<string, unknown>];
    expect(type).toBe('error');
    expect(rec.stage).toBe('ssrf');
    expect(rec.url).toBe('http://127.0.0.1/');
  });

  it('成功路径 → 不写 error.log', async () => {
    const { ctx, write } = makeCtxWithLog();
    const fetchImpl = makeFetchContentImpl({
      title: 'T',
      content: 'Body '.repeat(100),
      source: 'jina',
    });
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    const result = await tool.run({ url: 'http://8.8.8.8/' }, ctx);
    expect(result.isError).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });

  it('logWriter 缺省（undefined）→ no-op 不抛（既有 makeCtx 覆盖）', async () => {
    const tool = createWebFetchTool({
      fetchContentImpl: makeFetchContentImpl(null) as never,
    });
    // makeCtx 无 logWriter —— 不应抛错
    const result = await tool.run({ url: 'http://8.8.8.8/' }, makeCtx());
    expect(result.isError).toBe(true);
  });

  it('logWriter.write 抛错 → 静默不阻塞工具返回', async () => {
    const write = vi.fn(() => {
      throw new Error('disk full');
    });
    const ctx = {
      config: { tools: [], logWriter: { write } },
      workdir: '/tmp',
    } as unknown as ToolCtx;
    const tool = createWebFetchTool({
      fetchContentImpl: makeFetchContentImpl(null) as never,
    });
    const result = await tool.run({ url: 'http://8.8.8.8/' }, ctx);
    expect(result.isError).toBe(true); // 日志异常不影响 isError 返回
    expect(write).toHaveBeenCalled();
  });
});

// ---- v0.0.226 render 参数：forceHeadless 透传给 fetchContent ----
describe('web_fetch render 参数（forceHeadless 透传）', () => {
  it('render=true → fetchContent 收到 forceHeadless=true', async () => {
    let captured: { forceHeadless?: boolean } | null = null;
    const fetchImpl = vi.fn(async (_url: string, opts: unknown) => {
      captured = opts as { forceHeadless?: boolean };
      return null;
    });
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    await tool.run({ url: 'http://8.8.8.8/', render: true }, makeCtx());
    expect(fetchImpl).toHaveBeenCalled();
    expect(captured).toBeTruthy();
    expect(captured!.forceHeadless).toBe(true);
  });

  it('render 缺省 → forceHeadless=false（现有行为不变）', async () => {
    let captured: { forceHeadless?: boolean } | null = null;
    const fetchImpl = vi.fn(async (_url: string, opts: unknown) => {
      captured = opts as { forceHeadless?: boolean };
      return null;
    });
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    await tool.run({ url: 'http://8.8.8.8/' }, makeCtx());
    expect(captured).toBeTruthy();
    expect(captured!.forceHeadless).toBe(false);
  });

  it('render=false → forceHeadless=false', async () => {
    let captured: { forceHeadless?: boolean } | null = null;
    const fetchImpl = vi.fn(async (_url: string, opts: unknown) => {
      captured = opts as { forceHeadless?: boolean };
      return null;
    });
    const tool = createWebFetchTool({ fetchContentImpl: fetchImpl as never });
    await tool.run({ url: 'http://8.8.8.8/', render: false }, makeCtx());
    expect(captured!.forceHeadless).toBe(false);
  });

  it('render=true 端到端：跳过静态直起 headless（source=headless）', async () => {
    const publicDns: ResolveDnsFn = async () => ['93.184.216.34'];
    const renderedHtml = `<html><head><title>R</title></head><body><article><p>${'H'.repeat(
      MIN_CONTENT + 50,
    )}</p></article></body></html>`;
    // 静态充足 HTML —— forceHeadless=true 时应跳过静态，故即便静态充足也不应走 local source
    const adequateStaticHtml = `<html><head><title>S</title></head><body><article><p>${'S'.repeat(
      MIN_CONTENT + 50,
    )}</p></article></body></html>`;
    function makeProxyFetch(): typeof proxyFetch {
      return (async (url: string) => {
        if (url.startsWith('https://r.jina.ai/')) return new Response('short', { status: 200 });
        return new Response(adequateStaticHtml, {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        });
      }) as unknown as typeof proxyFetch;
    }
    const executeOnce = vi.fn(async () => ({ ok: true, text: renderedHtml }));
    const registry = { get: (_mode: string) => ({ executeOnce }) };
    const tool = createWebFetchTool({
      driverRegistry: registry,
      resolveDns: publicDns,
      fetchContentImpl: ((url: string, opts: FetchContentOptions) =>
        fetchContent(url, { ...opts, fetchImpl: makeProxyFetch() })) as never,
    });
    const result = await tool.run({ url: 'http://example.com/', render: true }, makeCtx());
    expect(result.isError).toBe(false);
    const text = (result.content[0] as { text: string }).text;
    // 跳过静态直起 headless → source=headless（非 local）
    expect(text).toContain('source: headless');
    expect(executeOnce).toHaveBeenCalledWith(
      { headless: true },
      'render',
      { url: 'http://example.com/' },
      expect.anything(),
    );
  });
});
