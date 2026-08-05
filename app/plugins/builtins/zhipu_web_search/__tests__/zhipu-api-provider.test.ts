/**
 * ZhipuWebSearchProvider（REST API impl，按量计费）单测（白盒）
 * 参考: specs/tech/agent/tools/[P1]web_search_tool.md §7（响应映射）
 *       specs/api/overall/08-web-tools.md §2.2
 *
 * 覆盖：
 *   - mapZhipuResults：title←title / url←link / snippet←content(截断) / publishedDate←publish_date
 *   - snippet 超阈值截断（…）
 *   - isAvailable(cfg)：cfg.apiKey 非空→true / 空/缺省→false（无 I/O）
 *   - search：cfg.apiKey 透传到 Authorization 头；REST body 含 search_query/search_engine/count；
 *             cfg.apiKey 空 → 抛 `zhipu provider 未配置 apiKey`
 *
 * mock proxyFetch（vi.hoisted 内 require('path') 派生绝对路径，
 * 避免 Bun+jsdom 并发下相对路径 mock 静默失效；memory: test-vitest-mock-absolute-path）。
 * 不调真实 Zhipu REST API。
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
import ZhipuWebSearchProvider, { mapZhipuResults } from '../zhipu-api-provider';

describe('mapZhipuResults: REST 响应映射', () => {
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

describe('isAvailable(cfg): 无 I/O（仅查 cfg.apiKey）', () => {
  beforeEach(() => {
    delete process.env.ZHIPU_SEARCH_API_KEY;
  });
  afterEach(() => {
    delete process.env.ZHIPU_SEARCH_API_KEY;
  });

  it('cfg.apiKey 非空 → true', () => {
    const p = new ZhipuWebSearchProvider('zhipu_api');
    expect(p.isAvailable({ apiKey: 'sk-real' })).toBe(true);
  });

  it('cfg.apiKey 空串 → false', () => {
    const p = new ZhipuWebSearchProvider('zhipu_api');
    expect(p.isAvailable({ apiKey: '' })).toBe(false);
  });

  it('cfg.apiKey 缺省 → false', () => {
    const p = new ZhipuWebSearchProvider('zhipu_api');
    expect(p.isAvailable({})).toBe(false);
  });

  it('cfg.apiKey 非 string → false', () => {
    const p = new ZhipuWebSearchProvider('zhipu_api');
    expect(p.isAvailable({ apiKey: 123 })).toBe(false);
  });

  it('cfg 缺省（无入参）→ false', () => {
    const p = new ZhipuWebSearchProvider('zhipu_api');
    expect(p.isAvailable()).toBe(false);
  });

  it('env.ZHIPU_SEARCH_API_KEY 设置但 cfg.apiKey 空 → false（env 回退已删）', () => {
    process.env.ZHIPU_SEARCH_API_KEY = 'env-key-real';
    const p = new ZhipuWebSearchProvider('zhipu_api');
    expect(p.isAvailable({})).toBe(false);
    expect(p.isAvailable({ apiKey: '' })).toBe(false);
  });

  it('构造器 cfg.apiKey 非空 + isAvailable 无入参 cfg → false（构造器 cfg 不用于凭证）', () => {
    const p = new ZhipuWebSearchProvider('zhipu_api', { apiKey: 'sk-from-ctor' });
    expect(p.isAvailable()).toBe(false);
    expect(p.isAvailable({})).toBe(false);
    expect(p.isAvailable({ apiKey: 'sk-runtime' })).toBe(true);
  });
});

describe('search: cfg.apiKey 透传 + REST body 校验', () => {
  const mockFetch = mockProxyFetch as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ZHIPU_SEARCH_API_KEY;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ZHIPU_SEARCH_API_KEY;
  });

  it('cfg.apiKey 非空 → Authorization: Bearer <cfg.apiKey> + REST body 正确', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        search_result: [
          { title: 'R1', link: 'https://a.com', content: 'c1', publish_date: '2026-01-01' },
        ],
      }),
    });
    const p = new ZhipuWebSearchProvider('zhipu_api');
    const res = await p.search('hello world', { maxResults: 5 }, { apiKey: 'sk-x' });
    expect(res.provider).toBe('zhipu_api');
    expect(res.query).toBe('hello world');
    expect(res.count).toBe(1);
    expect(res.tookMs).toBeGreaterThanOrEqual(0);
    expect(res.results[0]).toEqual({
      title: 'R1',
      url: 'https://a.com',
      snippet: 'c1',
      publishedDate: '2026-01-01',
    });
    // 校验调用形态：URL = REST 端点（非 MCP），单次调用
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe('https://open.bigmodel.cn/api/paas/v4/web_search');
    const init = call[1] as { method: string; headers: Record<string, string>; body: string };
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-x');
    // REST body：search_query / search_engine / count
    const body = JSON.parse(init.body);
    expect(body.search_query).toBe('hello world');
    expect(body.search_engine).toBe('search_std');
    expect(body.count).toBe(5);
  });

  it('cfg.apiKey 空 → 抛 `zhipu provider 未配置 apiKey`（不调 fetch）', async () => {
    const p = new ZhipuWebSearchProvider('zhipu_api');
    await expect(p.search('q', {}, {})).rejects.toThrow(/zhipu provider 未配置 apiKey/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('cfg 缺省（无入参）→ 抛 `zhipu provider 未配置 apiKey`', async () => {
    const p = new ZhipuWebSearchProvider('zhipu_api');
    await expect(p.search('q')).rejects.toThrow(/zhipu provider 未配置 apiKey/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('env.ZHIPU_SEARCH_API_KEY 设置但 cfg.apiKey 空 → 抛错（env 回退已删）', async () => {
    process.env.ZHIPU_SEARCH_API_KEY = 'env-secret';
    const p = new ZhipuWebSearchProvider('zhipu_api');
    await expect(p.search('q', {}, {})).rejects.toThrow(/zhipu provider 未配置 apiKey/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('构造器 cfg.apiKey 非空 + 运行时 cfg.apiKey 空 → 抛错（构造器 cfg 不用于凭证）', async () => {
    const p = new ZhipuWebSearchProvider('zhipu_api', { apiKey: 'sk-from-ctor' });
    await expect(p.search('q', {}, {})).rejects.toThrow(/zhipu provider 未配置 apiKey/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('HTTP 非 2xx → 抛错含 status', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    });
    const p = new ZhipuWebSearchProvider('zhipu_api');
    await expect(p.search('q', {}, { apiKey: 'bad' })).rejects.toThrow(/401/);
  });

  it('label = 智谱 · API（按量计费）（与 zhipu_coding_plan 不同）', () => {
    const p = new ZhipuWebSearchProvider('zhipu_api');
    expect(p.label).toBe('智谱 · API（按量计费）');
    expect(p.label).not.toContain('Coding Plan');
  });
});
