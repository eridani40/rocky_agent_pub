/**
 * ZhipuWebSearchProvider（Coding Plan MCP impl）单测（白盒）
 * 参考: specs/tech/agent/tools/[P1]web_search_tool.md §7（响应映射）
 *       states/v0.0.72.bugs PRD UC-1/2（v0.0.72 重构后 cfg 透传 + key 空抛错）
 *
 * 覆盖：
 *   - mapZhipuResults：title←title / url←link / snippet←content(截断) / publishedDate←publish_date
 *   - snippet 超阈值截断（…）
 *   - isAvailable(cfg)：cfg.apiKey 非空→true / 空/缺省→false（无 I/O）
 *   - search：cfg.apiKey 透传到 Authorization 头；MCP 两步协议 initialize→tools/call；
 *             cfg.apiKey 空 → 抛 `zhipu provider 未配置 apiKey`
 *
 * mock proxyFetch（vi.hoisted 内 require('path') 派生绝对路径，
 * 避免 Bun+jsdom 并发下相对路径 mock 静默失效；memory: test-vitest-mock-absolute-path）。
 * 不调真实 MCP API。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.hoisted 在 mock 提升之前执行；用 require() 而非 ESM import（ESM import 被提升后 path 尚未初始化）
const { PROXY_ABS } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const path = require('path') as typeof import('path');
  return {
    PROXY_ABS: path.resolve(__dirname, '../../../../server/src/tools/web-fetch/proxy'),
  };
});

// mock proxyFetch：替换为可控 vi.fn()
vi.mock(PROXY_ABS, () => ({
  proxyFetch: vi.fn(),
}));

import { proxyFetch as mockProxyFetch } from '../../../../server/src/tools/web-fetch/proxy';
import ZhipuWebSearchProvider, { mapZhipuResults } from '../zhipu-coding-plan-provider';

describe('mapZhipuResults: 响应映射', () => {
  it('title←title / url←link / snippet←content / publishedDate←publish_date', () => {
    const items = [
      { title: 'T1', link: 'https://x.com/1', content: '正文片段', publish_date: '2026-06-25' },
      { title: 'T2', link: 'https://y.com/2', content: 123 }, // 非 string → 空串
    ];
    const out = mapZhipuResults(items);
    expect(out[0]).toEqual({
      title: 'T1',
      url: 'https://x.com/1',
      snippet: '正文片段',
      publishedDate: '2026-06-25',
    });
    expect(out[1]).toEqual({
      title: 'T2',
      url: 'https://y.com/2',
      snippet: '',
      publishedDate: undefined,
    });
  });

  it('snippet 超阈值(500) → 截断带 …', () => {
    const long = 'B'.repeat(600);
    const out = mapZhipuResults([{ title: 't', link: 'u', content: long }]);
    expect(out[0].snippet.length).toBe(501); // 500 + …
    expect(out[0].snippet.endsWith('…')).toBe(true);
  });

  it('空数组 → 空数组', () => {
    expect(mapZhipuResults([])).toEqual([]);
  });
});

describe('isAvailable(cfg): 无 I/O（v0.0.72 仅查入参 cfg.apiKey）', () => {
  beforeEach(() => {
    delete process.env.ZHIPU_SEARCH_API_KEY;
  });
  afterEach(() => {
    delete process.env.ZHIPU_SEARCH_API_KEY;
  });

  it('cfg.apiKey 非空 → true', () => {
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan');
    expect(p.isAvailable({ apiKey: 'sk-real' })).toBe(true);
  });
  it('cfg.apiKey 空串 → false', () => {
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan');
    expect(p.isAvailable({ apiKey: '' })).toBe(false);
  });
  it('cfg.apiKey 缺省 → false', () => {
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan');
    expect(p.isAvailable({})).toBe(false);
  });
  it('cfg.apiKey 非 string → false', () => {
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan');
    expect(p.isAvailable({ apiKey: 123 })).toBe(false);
  });
  it('cfg 缺省（无入参）→ false', () => {
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan');
    expect(p.isAvailable()).toBe(false);
  });

  it('env.ZHIPU_SEARCH_API_KEY 设置但 cfg.apiKey 空 → false（env 回退已删）', () => {
    process.env.ZHIPU_SEARCH_API_KEY = 'env-key-real';
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan');
    expect(p.isAvailable({})).toBe(false);
    expect(p.isAvailable({ apiKey: '' })).toBe(false);
  });

  it('构造器 cfg.apiKey 非空 + isAvailable 无入参 cfg → false（构造器 cfg 不用于凭证）', () => {
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan', { apiKey: 'sk-from-ctor' });
    expect(p.isAvailable()).toBe(false);
    expect(p.isAvailable({})).toBe(false);
    expect(p.isAvailable({ apiKey: 'sk-from-runtime' })).toBe(true);
  });
});

describe('search: cfg.apiKey 透传到 Authorization 头（MCP 两步协议）', () => {
  const mockFetch = mockProxyFetch as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ZHIPU_SEARCH_API_KEY;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ZHIPU_SEARCH_API_KEY;
  });

  /**
   * MCP 两步协议 mock：
   *   step1 = initialize 响应（返回 mcp-session-id header）
   *   step2 = tools/call 响应（SSE data: 行，result.content[0].text 为 JSON 字符串）
   */
  function makeMcpMocks(
    items: Array<{ title: string; link: string; content: string; publish_date?: string }>,
  ) {
    const rpcPayload = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        content: [{ type: 'text', text: JSON.stringify(items) }],
      },
    });
    const sseText = `data: ${rpcPayload}\n\n`;

    // step1: initialize（返回 mcp-session-id），用 Map 模拟 Response.headers 的 .get()
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map([['mcp-session-id', 'sess-123']]),
      text: async () => '',
    });
    // step2: tools/call（返回 SSE payload）
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => sseText,
    });
  }

  it('cfg.apiKey 非空 → Authorization: Bearer <cfg.apiKey>（两步 MCP 调用）', async () => {
    makeMcpMocks([
      { title: 'R1', link: 'https://a.com', content: 'c1', publish_date: '2026-01-01' },
    ]);
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan');
    const res = await p.search('hello world', { maxResults: 5 }, { apiKey: 'sk-x' });
    expect(res.provider).toBe('zhipu_coding_plan');
    expect(res.query).toBe('hello world');
    expect(res.count).toBe(1);
    expect(res.tookMs).toBeGreaterThanOrEqual(0);
    expect(res.results[0]).toEqual({
      title: 'R1',
      url: 'https://a.com',
      snippet: 'c1',
      publishedDate: '2026-01-01',
    });
    // step1（initialize）：URL = MCP 端点，Authorization = Bearer sk-x
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const initArgs = mockFetch.mock.calls[0];
    expect(initArgs[0]).toBe('https://open.bigmodel.cn/api/mcp/web_search_prime/mcp');
    expect((initArgs[1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer sk-x');
    // step2（tools/call）：带 mcp-session-id + search_query
    const callArgs = mockFetch.mock.calls[1];
    expect((callArgs[1] as { headers: Record<string, string> }).headers['mcp-session-id']).toBe('sess-123');
    const body = JSON.parse((callArgs[1] as { body: string }).body);
    expect(body.method).toBe('tools/call');
    expect(body.params.name).toBe('web_search_prime');
    expect(body.params.arguments.search_query).toBe('hello world');
  });

  it('cfg.apiKey 空 → 抛 `zhipu provider 未配置 apiKey`（不调 fetch）', async () => {
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan');
    await expect(p.search('q', {}, {})).rejects.toThrow(/zhipu provider 未配置 apiKey/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('cfg 缺省（无入参）→ 抛 `zhipu provider 未配置 apiKey`', async () => {
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan');
    await expect(p.search('q')).rejects.toThrow(/zhipu provider 未配置 apiKey/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('env.ZHIPU_SEARCH_API_KEY 设置但 cfg.apiKey 空 → 抛错（env 回退已删）', async () => {
    process.env.ZHIPU_SEARCH_API_KEY = 'env-secret';
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan');
    await expect(p.search('q', {}, {})).rejects.toThrow(/zhipu provider 未配置 apiKey/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('构造器 cfg.apiKey 非空 + 运行时 cfg.apiKey 空 → 抛错（构造器 cfg 不用于凭证）', async () => {
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan', { apiKey: 'sk-from-ctor' });
    await expect(p.search('q', {}, {})).rejects.toThrow(/zhipu provider 未配置 apiKey/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('initialize HTTP 非 2xx → 抛错含 status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Map(),
      text: async () => 'unauthorized',
    });
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan');
    await expect(p.search('q', {}, { apiKey: 'bad' })).rejects.toThrow(/401/);
  });

  it('label = 智谱 · Coding Plan（订阅额度）（与 zhipu_api 不同）', () => {
    const p = new ZhipuWebSearchProvider('zhipu_coding_plan');
    expect(p.label).toBe('智谱 · Coding Plan（订阅额度）');
    expect(p.label).not.toContain('API（按量计费）');
  });
});
