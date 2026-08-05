/**
 * web_search 工具（按 query 检索 → 结构化结果列表 + 可选 answer）
 * 参考: specs/tech/agent/tools/[P1]web_search_tool.md §4
 *       specs/api/overall/08-web-tools.md §2（ToolDefinition + isError 分支）
 *       specs/tech/config/[P0]app_config.md §3.6（web_search group）
 *
 * resolveProvider 读 ctx.config.appConfig.get("web_search","default") →
 * 按 data.type 在 list EP 中精确匹配 impl（不取首个、不静默回退）→
 * 构造 cfg = credentials[type] ?? {} 透传给 isAvailable / search。
 * 三个错误分支（type 未配置 / impl 不存在 / isAvailable false）均返 errorResult 不回退。
 */
import type { ExtensionPoint } from '../../plugin/extension-point';
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../types';
import { errorResult, textResult } from '../types';
import { WebSearchProviderPoint } from '../../plugin/extension-point';
import { truncate, wrapExternalContent, WEB_TOOLS_MAX_CHARS } from '../web-tools-utils';
import type {
  WebSearchCfg,
  WebSearchOptions,
  WebSearchProvider,
  WebSearchResult,
} from './types';

/** web_search 输入形状 */
interface WebSearchInput {
  query?: unknown;
  maxResults?: unknown;
  answer?: unknown;
}

/** app_config.web_search.default 的最小形状（resolveProvider 用） */
interface WebSearchConfigData {
  type?: string;
  credentials?: Record<string, Record<string, unknown>>;
}

/** AppConfigService 鸭子类型（仅需 get(group, key)） */
interface AppConfigLike {
  get(group: string, key: string): unknown;
}

/** PluginManager 鸭子类型（仅需 getExtensionImpls） */
interface PluginManagerLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getExtensionImpls<T = any>(point: ExtensionPoint): T[];
}

/**
 * web_search 工具（单例导出，registry defaultTools 引用）。
 * 从 ctx.config.appConfig 读 web_search.default → 按 type 在
 * ctx.config.pluginManager.getExtensionImpls(WebSearchProviderPoint) 中精确路由。
 */
export const webSearchTool: Tool = {
  definition: {
    name: 'web_search',
    description:
      'Search the web. Returns a list of results (title/url/snippet) and optional answer.',
    intro: 'Search the web for up-to-date information.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'search query' },
        maxResults: { type: 'number', default: 10, description: 'max results count' },
        answer: {
          type: 'boolean',
          default: false,
          description: 'request an answer with citations (provider may ignore)',
        },
      },
    },
  },
  // [v0.0.130.hang] per-tool 默认超时：网络类工具，30s（见 change_plan.md 模块 A）
  defaultTimeoutMs: 30000,

  async run(input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> {
    // 1. 解析 provider + cfg（按 app_config.type 精确路由；不取首个、不静默回退）
    const { provider, cfg } = resolveProvider(ctx);
    if (!provider) {
      return errorResult(
        'web_search 未配置 provider type（app_config.web_search 缺失或 type 未配置）',
      );
    }
    // 2. isAvailable 校验（凭证是否配置；禁 I/O，精确报错不静默换 provider）
    if (!provider.isAvailable(cfg)) {
      return errorResult(`provider ${provider.label} 不可用（凭证未配置?）`);
    }

    // 3. 解析输入
    const typed = input as WebSearchInput;
    const query = typeof typed.query === 'string' ? typed.query.trim() : '';
    if (!query) {
      return errorResult('web_search: query is required');
    }
    const opts: WebSearchOptions = {
      maxResults:
        typeof typed.maxResults === 'number' && typed.maxResults > 0
          ? Math.floor(typed.maxResults)
          : 10,
      answer: typed.answer === true,
    };

    // 4. 执行检索（透传 cfg + ctx.signal，provider 自带超时/重试）
    let result: WebSearchResult;
    try {
      result = await provider.search(query, opts, cfg, ctx.signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return errorResult(`web_search provider "${provider.label}" 调用失败: ${msg}`);
    }

    // 5. 序列化 markdown + wrapExternalContent（untrusted）+ 截断
    const body = serializeResult(result);
    const wrapped = wrapExternalContent(body);
    return textResult(truncate(wrapped, WEB_TOOLS_MAX_CHARS));
  },
};

/**
 * 从 ctx.config.appConfig + pluginManager 解析 web_search provider + cfg。
 * 按 app_config.web_search.default.data.type 在 list EP 中精确匹配 impl；
 * type 未配置 / impl 不存在 → 返 { cfg }（provider undefined）。
 * 不静默回退其他 impl，不取 list EP 首个。
 *
 * @returns `{ provider?, cfg }`：provider 为匹配到的 impl；cfg = credentials[type] ?? {}
 */
function resolveProvider(ctx: ToolCtx): {
  provider?: WebSearchProvider;
  cfg: WebSearchCfg;
} {
  // 1. 读 app_config.web_search.default
  const appConfig = ctx.config.appConfig as AppConfigLike | undefined;
  if (!appConfig || typeof appConfig.get !== 'function') return { cfg: {} };
  const wsConfig = appConfig.get('web_search', 'default') as WebSearchConfigData | undefined;
  if (!wsConfig || !wsConfig.type) return { cfg: {} };

  // 2. 取 list EP 全部 impl
  const pm = ctx.config.pluginManager as PluginManagerLike | undefined;
  if (!pm || typeof pm.getExtensionImpls !== 'function') return { cfg: {} };
  const impls = pm.getExtensionImpls<WebSearchProvider>(WebSearchProviderPoint);

  // 3. 按 type 精确匹配 impl.id（不取首个、不回退）
  const provider = impls.find((p) => p.id === wsConfig.type);
  if (!provider) return { cfg: {} };

  // 4. cfg = credentials[type] ?? {}（透传给 isAvailable / search）
  return { provider, cfg: wsConfig.credentials?.[wsConfig.type] ?? {} };
}

/**
 * 序列化 WebSearchResult 为 markdown（results 列表 + 可选 answer）。
 * 形态（08-web-tools.md §2.2）：
 *   ## Results
 *   1. **<title>** <url>
 *      <snippet>
 *      (<publishedDate>)
 *   ## Answer（可选）
 *   <answer>
 */
export function serializeResult(res: WebSearchResult): string {
  const lines: string[] = [];
  lines.push(`## Results (provider: ${res.provider}, count: ${res.count}, took: ${res.tookMs}ms)`);
  lines.push('');
  if (res.results.length === 0) {
    lines.push('（无结果）');
  } else {
    res.results.forEach((item, i) => {
      const idx = i + 1;
      lines.push(`${idx}. **${item.title || '(无标题)'}** ${item.url || ''}`);
      if (item.snippet) {
        lines.push(`   ${item.snippet.replace(/\n/g, ' ')}`);
      }
      if (item.publishedDate) {
        lines.push(`   (${item.publishedDate})`);
      }
    });
  }
  if (res.answer) {
    lines.push('');
    lines.push('## Answer');
    lines.push(res.answer);
  }
  return lines.join('\n');
}
