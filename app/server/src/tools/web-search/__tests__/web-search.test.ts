/**
 * web_search 工具单元测试（白盒）
 * 参考: specs/tech/agent/tools/[P1]web_search_tool.md §4
 *       states/v0.0.72.bugs PRD UC-1/2/3（v0.0.72 重构后路由 + cfg 透传）
 *
 * 覆盖（acceptance）：
 *   - UC-1：config.type=zhipu + cfg.apiKey 非空 → zhipu.search 被调且 cfg.apiKey 非空
 *   - UC-2：apiKey 空 → isError + 文案「不可用 / 凭证未配置」
 *   - UC-3：mock 2 impl（zhipu + fake），config.type=fake → fake.search 被调；
 *           type=unknown → ToolError「未配置 provider type」语义分支
 *   - 序列化 markdown 形态、wrapExternalContent（untrusted 包装）
 *   - 截断超 WEB_TOOLS_MAX_CHARS → 截断标记
 *
 * mock PluginManager + AppConfigService + impl（白盒，不调真实 HTTP / 真实 plugin manager）。
 */
import { describe, it, expect, vi } from 'vitest';
import type { ExtensionPoint } from '../../../plugin/extension-point';
import { webSearchTool, serializeResult } from '../tool';
import { wrapExternalContent, truncate, WEB_TOOLS_MAX_CHARS } from '../../web-tools-utils';
import type { WebSearchCfg, WebSearchProvider, WebSearchResult } from '../types';
import type { ToolCtx, ToolInput } from '../../types';

// ---- mock PluginManager（getExtensionImpls 返回注入的 provider 列表） ----
// 用 any-ish 形态：getExtensionImpls 返回 unknown[]，调用方按需断言
interface MockPluginManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getExtensionImpls(point: ExtensionPoint): any[];
}

/** AppConfigService 鸭子类型 mock */
interface MockAppConfig {
  get(group: string, key: string): unknown;
  // set 等其他方法本测试不需要
}

/** app_config.web_search.default 数据形状 */
interface WsConfigData {
  type: string;
  credentials?: Record<string, Record<string, unknown>>;
}

/** 构造 mock ctx，注入 pluginManager + appConfig */
function makeCtx(
  pm: MockPluginManager | undefined,
  appConfig: MockAppConfig | undefined,
): ToolCtx {
  return {
    config: {
      tools: [webSearchTool],
      pluginManager: pm,
      appConfig,
    },
    workdir: '/tmp',
  };
}

/** 构造 mock AppConfigService.get */
function makeAppConfig(data: WsConfigData | undefined): MockAppConfig {
  return {
    get: (group: string, key: string) =>
      group === 'web_search' && key === 'default' ? data : undefined,
  };
}

/** 构造 mock provider */
function makeProvider(over: Partial<WebSearchProvider> = {}): WebSearchProvider {
  return {
    id: 'mock',
    label: 'Mock Provider',
    isAvailable: () => true,
    search: vi.fn(async (query: string) => ({
      provider: 'mock',
      query,
      count: 0,
      tookMs: 1,
      results: [],
    })),
    ...over,
  };
}

// ============================================================
// UC-1：type=zhipu + cfg.apiKey 非空 → zhipu.search 被调 + cfg.apiKey 透传
// ============================================================
describe('UC-1: type=zhipu + apiKey 非空 → 路由 + cfg 透传', () => {
  it('config.type=zhipu → zhipu.search 被调且 cfg.apiKey 非空', async () => {
    const zhipu = makeProvider({
      id: 'zhipu',
      label: 'Zhipu 智谱',
      search: vi.fn(async (query, _opts, cfg: WebSearchCfg) => ({
        provider: 'zhipu',
        query,
        count: 1,
        tookMs: 5,
        results: [
          { title: 'T', url: 'https://a.com', snippet: 'snip', publishedDate: '2026-01-01' },
        ],
      })),
    });
    const pm: MockPluginManager = { getExtensionImpls: () => [zhipu] };
    const appConfig = makeAppConfig({
      type: 'zhipu',
      credentials: { zhipu: { apiKey: 'sk-real' } },
    });
    const res = await webSearchTool.run(
      { query: 'hello', maxResults: 5 } as ToolInput,
      makeCtx(pm, appConfig),
    );
    expect(res.isError).toBe(false);
    // search 被调，第 3 个参数（cfg）含 apiKey 非空
    expect(zhipu.search).toHaveBeenCalledTimes(1);
    const searchArgs = (zhipu.search as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(searchArgs[0]).toBe('hello');
    expect(searchArgs[1]).toMatchObject({ maxResults: 5, answer: false });
    const cfgArg = searchArgs[2] as WebSearchCfg;
    expect(cfgArg.apiKey).toBe('sk-real');
    // 序列化形态正常
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('<untrusted_external_content>');
    expect(text).toContain('## Results');
    expect(text).toContain('**T**');
    expect(text).toContain('https://a.com');
  });

  it('isAvailable 收到 cfg.apiKey 非空 → 返 true（透传校验）', async () => {
    const zhipu = makeProvider({
      id: 'zhipu',
      label: 'Zhipu 智谱',
      isAvailable: vi.fn(
        (cfg: WebSearchCfg) => typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0,
      ),
      search: vi.fn(async (query) => ({
        provider: 'zhipu',
        query,
        count: 0,
        tookMs: 1,
        results: [],
      })),
    });
    const pm: MockPluginManager = { getExtensionImpls: () => [zhipu] };
    const appConfig = makeAppConfig({
      type: 'zhipu',
      credentials: { zhipu: { apiKey: 'sk-x' } },
    });
    const res = await webSearchTool.run({ query: 'q' } as ToolInput, makeCtx(pm, appConfig));
    expect(res.isError).toBe(false);
    // isAvailable 被调且 cfg 含 apiKey
    expect(zhipu.isAvailable).toHaveBeenCalledTimes(1);
    const availArgs = (zhipu.isAvailable as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((availArgs[0] as WebSearchCfg).apiKey).toBe('sk-x');
  });
});

// ============================================================
// UC-2：apiKey 空 → isError + 文案「不可用 / 凭证未配置」
// ============================================================
describe('UC-2: apiKey 空 → isError 不回退', () => {
  it('credentials.zhipu.apiKey 空 → provider.isAvailable=false → isError 含「不可用 / 凭证未配置」', async () => {
    const zhipu = makeProvider({
      id: 'zhipu',
      label: 'Zhipu 智谱',
      isAvailable: (cfg: WebSearchCfg) => typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0,
      search: vi.fn(async () => ({
        provider: 'zhipu',
        query: '',
        count: 0,
        tookMs: 0,
        results: [],
      })),
    });
    const pm: MockPluginManager = { getExtensionImpls: () => [zhipu] };
    // credentials.zhipu.apiKey 为空串
    const appConfig = makeAppConfig({
      type: 'zhipu',
      credentials: { zhipu: { apiKey: '' } },
    });
    const res = await webSearchTool.run({ query: 'q' } as ToolInput, makeCtx(pm, appConfig));
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Zhipu 智谱');
    expect(text).toContain('不可用');
    expect(text).toContain('凭证未配置');
    // 未调用 search（凭证未配置应精确报错而非尝试调用）
    expect(zhipu.search).not.toHaveBeenCalled();
  });

  it('credentials.zhipu 缺省（无 apiKey 字段）→ isAvailable=false → isError', async () => {
    const zhipu = makeProvider({
      id: 'zhipu',
      label: 'Zhipu 智谱',
      isAvailable: (cfg: WebSearchCfg) => typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0,
    });
    const pm: MockPluginManager = { getExtensionImpls: () => [zhipu] };
    const appConfig = makeAppConfig({ type: 'zhipu', credentials: { zhipu: {} } });
    const res = await webSearchTool.run({ query: 'q' } as ToolInput, makeCtx(pm, appConfig));
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('不可用');
  });
});

// ============================================================
// UC-3：多 impl 共存，按 type 精确路由；type 不匹配 → ToolError
// ============================================================
describe('UC-3: 多 impl 共存 + 按 type 精确路由', () => {
  it('config.type=fake + 2 impl（zhipu+fake）→ fake.search 被调（不取首个、不融合）', async () => {
    const zhipu = makeProvider({
      id: 'zhipu',
      label: 'Zhipu 智谱',
      isAvailable: () => true,
      search: vi.fn(async (query) => ({
        provider: 'zhipu',
        query,
        count: 0,
        tookMs: 1,
        results: [],
      })),
    });
    const fake = makeProvider({
      id: 'fake',
      label: 'Fake Provider',
      isAvailable: () => true,
      search: vi.fn(async (query, _opts, cfg: WebSearchCfg) => ({
        provider: 'fake',
        query,
        count: 1,
        tookMs: 2,
        results: [{ title: 'F', url: 'https://fake.com', snippet: 'fs' }],
      })),
    });
    const pm: MockPluginManager = { getExtensionImpls: () => [zhipu, fake] };
    const appConfig = makeAppConfig({
      type: 'fake',
      credentials: { fake: { apiKey: 'fake-key' } },
    });
    const res = await webSearchTool.run({ query: 'q' } as ToolInput, makeCtx(pm, appConfig));
    expect(res.isError).toBe(false);
    // fake.search 被调，zhipu.search 未被调
    expect(fake.search).toHaveBeenCalledTimes(1);
    expect(zhipu.search).not.toHaveBeenCalled();
    // cfg 透传给 fake
    const args = (fake.search as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((args[2] as WebSearchCfg).apiKey).toBe('fake-key');
  });

  it('config.type=unknown + 2 impl（zhipu+fake）→ ToolError「未配置 provider type」语义', async () => {
    const zhipu = makeProvider({ id: 'zhipu', label: 'Zhipu 智谱' });
    const fake = makeProvider({ id: 'fake', label: 'Fake' });
    const pm: MockPluginManager = { getExtensionImpls: () => [zhipu, fake] };
    // type=unknown 不匹配任何 impl
    const appConfig = makeAppConfig({ type: 'unknown', credentials: {} });
    const res = await webSearchTool.run({ query: 'q' } as ToolInput, makeCtx(pm, appConfig));
    expect(res.isError).toBe(true);
    // 走 resolveProvider 返 undefined 分支 → 「未配置 provider type」语义文案
    expect((res.content[0] as { text: string }).text).toContain('未配置 provider type');
  });
});

// ============================================================
// 错误分支：appConfig 缺失 / type 缺失 / query 缺失 / search 抛错
// ============================================================
describe('错误分支', () => {
  it('appConfig 缺失 → isError「未配置 provider type」', async () => {
    const pm: MockPluginManager = { getExtensionImpls: () => [makeProvider({ id: 'zhipu' })] };
    const res = await webSearchTool.run(
      { query: 'q' } as ToolInput,
      makeCtx(pm, undefined),
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('未配置 provider type');
  });

  it('appConfig.get 返 undefined → isError「未配置 provider type」', async () => {
    const pm: MockPluginManager = { getExtensionImpls: () => [makeProvider({ id: 'zhipu' })] };
    const appConfig: MockAppConfig = { get: () => undefined };
    const res = await webSearchTool.run(
      { query: 'q' } as ToolInput,
      makeCtx(pm, appConfig),
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('未配置 provider type');
  });

  it('data.type 缺失 → isError「未配置 provider type」', async () => {
    const pm: MockPluginManager = { getExtensionImpls: () => [makeProvider({ id: 'zhipu' })] };
    // data 无 type 字段
    const appConfig: MockAppConfig = {
      get: () => ({ credentials: { zhipu: { apiKey: 'x' } } }),
    };
    const res = await webSearchTool.run(
      { query: 'q' } as ToolInput,
      makeCtx(pm, appConfig),
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('未配置 provider type');
  });

  it('pluginManager 缺失 → isError「未配置 provider type」', async () => {
    const appConfig = makeAppConfig({ type: 'zhipu', credentials: { zhipu: { apiKey: 'x' } } });
    const res = await webSearchTool.run(
      { query: 'q' } as ToolInput,
      makeCtx(undefined, appConfig),
    );
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('未配置 provider type');
  });

  it('query 缺失 → isError "query is required"', async () => {
    const zhipu = makeProvider({
      id: 'zhipu',
      label: 'Zhipu 智谱',
      isAvailable: () => true,
    });
    const pm: MockPluginManager = { getExtensionImpls: () => [zhipu] };
    const appConfig = makeAppConfig({ type: 'zhipu', credentials: { zhipu: { apiKey: 'x' } } });
    const res = await webSearchTool.run({} as ToolInput, makeCtx(pm, appConfig));
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain('query is required');
  });

  it('provider.search 抛错 → isError 含 provider label + 错误信息', async () => {
    const zhipu = makeProvider({
      id: 'zhipu',
      label: 'Zhipu 智谱',
      isAvailable: () => true,
      search: vi.fn(async () => {
        throw new Error('network down');
      }),
    });
    const pm: MockPluginManager = { getExtensionImpls: () => [zhipu] };
    const appConfig = makeAppConfig({ type: 'zhipu', credentials: { zhipu: { apiKey: 'x' } } });
    const res = await webSearchTool.run({ query: 'q' } as ToolInput, makeCtx(pm, appConfig));
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Zhipu 智谱');
    expect(text).toContain('network down');
  });
});

// ============================================================
// 序列化 + wrapExternalContent + 截断
// ============================================================
describe('serializeResult', () => {
  it('无结果 → 「（无结果）」', () => {
    const md = serializeResult({
      provider: 'p',
      query: 'q',
      count: 0,
      tookMs: 1,
      results: [],
    } as WebSearchResult);
    expect(md).toContain('（无结果）');
  });
});

describe('wrapExternalContent + truncate', () => {
  it('wrapExternalContent 含 untrusted 标签 + 警示', () => {
    const out = wrapExternalContent('hello');
    expect(out).toContain('<untrusted_external_content>');
    expect(out).toContain('prompt injection');
    expect(out).toContain('hello');
  });
  it('truncate 未超阈值原样返回', () => {
    expect(truncate('short')).toBe('short');
  });

  it('截断：wrapExternalContent 后超 WEB_TOOLS_MAX_CHARS → 截断标记', async () => {
    const big = 'A'.repeat(WEB_TOOLS_MAX_CHARS + 5000);
    const zhipu = makeProvider({
      id: 'zhipu',
      label: 'Zhipu 智谱',
      isAvailable: () => true,
      search: vi.fn(async (query) => ({
        provider: 'zhipu',
        query,
        count: 1,
        tookMs: 1,
        results: [{ title: 'T', url: 'u', snippet: big }],
      })),
    });
    const pm: MockPluginManager = { getExtensionImpls: () => [zhipu] };
    const appConfig = makeAppConfig({ type: 'zhipu', credentials: { zhipu: { apiKey: 'x' } } });
    const res = await webSearchTool.run({ query: 'q' } as ToolInput, makeCtx(pm, appConfig));
    expect(res.isError).toBe(false);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('结果已截断');
  });
});
