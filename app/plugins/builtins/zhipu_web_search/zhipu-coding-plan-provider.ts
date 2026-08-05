/**
 * builtin zhipu_web_search plugin — WebSearchProvider 实现（智谱 web_search 后端）
 * 参考: specs/tech/agent/tools/[P1]web_search_tool.md §7（Zhipu provider 映射）
 *       specs/research/v0.0.23-web-search.md
 *       specs/api/overall/08-web-tools.md §2.2（内置 Zhipu provider）
 *       reqs/v0.0.72.bugs/req.md §2.6（凭证迁 app_config + 删 env 回退）
 *
 * EP: web_search_provider（v0.0.72 cardinality=list, group=web）。implId=zhipu_coding_plan。
 * MCP 端点，走订阅（Coding Plan）额度。凭证 = credentials.zhipu_coding_plan.apiKey。
 *
 * [v0.0.72 修订] 凭证唯一源 = `app_config.web_search.credentials.zhipu_coding_plan.apiKey`：
 *   - tool 从该处构造 cfg 入参 `{ apiKey: <secret> }`，每次 `search`/`isAvailable` 调用时传入
 *   - impl 不再依赖构造器 cfg 取凭证；构造器 cfg 仅保留签名兼容 PluginManager (implId, cfg) 实例化
 *   - 删 `process.env.ZHIPU_SEARCH_API_KEY` env 回退路径
 *   - key 空 → isAvailable=false / search 抛 `Error('zhipu provider 未配置 apiKey')`
 *
 * API（v0.0.121 改走 MCP 托管端点，实测连通 2026-07-12）：
 *   背景：REST /api/paas/v4/web_search 按量计费需单独资源包（本 key 报 1113 余额不足）；
 *   MCP 端点走订阅（Coding Plan）额度，同 key 可用。协议 = Streamable HTTP + JSON-RPC 2.0。
 *   POST https://open.bigmodel.cn/api/mcp/web_search_prime/mcp
 *   Header: Authorization: Bearer <apiKey> ; Accept: application/json, text/event-stream
 *   两步（鉴权绑 session，跳过握手直调会报 "Api key not found"）：
 *     ① initialize 握手 → 响应头 mcp-session-id
 *     ② tools/call { name:"web_search_prime", arguments:{ search_query } } 带 session 头
 *   Resp: SSE（data: 行内 JSON-RPC）；result.content[0].text 为**双重 JSON 编码**的
 *         [{ title, link, content, refer, publish_date?, ... }]
 *   注意：MCP 工具无 count 参数，maxResults 由客户端截断。
 *
 * 响应映射（web_search_tool §7）：
 *   title←title / url←link / snippet←content(截断) / publishedDate←publish_date
 *   无 score；无综合 answer（search_intent 是意图分析，不映射）。
 */
import type {
  SearchResultItem,
  WebSearchCfg,
  WebSearchOptions,
  WebSearchResult,
} from '../../../server/src/tools/web-search/types';
// 复用 web-fetch 代理层（消除 EnvHttpProxyAgent 重复实现；proxyFetch 统一读 HTTP_PROXY env）
// 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §3（代理 util 单一来源）
import { proxyFetch } from '../../../server/src/tools/web-fetch/proxy';

/** Zhipu web_search_prime MCP 端点（Streamable HTTP） */
const ZHIPU_MCP_URL = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp';

/** snippet 最大长度（Zhipu content 偏长，截断为摘要长度） */
const SNIPPET_MAX_CHARS = 500;

/** 默认结果数（API count 字段） */
const DEFAULT_COUNT = 10;

/** 请求超时 ms（web_search_tool §6：provider 自带 30s） */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 从入参 cfg 解析 apiKey（v0.0.72：唯一源 = cfg.apiKey，删 env 回退）。
 * @returns 非空 string → 可用；空/缺省 → undefined（isAvailable false / search 抛错）
 */
function resolveApiKey(cfg: WebSearchCfg): string | undefined {
  const v = cfg.apiKey;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Zhipu search_result[] 项的最小化形状（运行时形状校验用） */
interface ZhipuSearchItem {
  title?: unknown;
  link?: unknown;
  content?: unknown;
  publish_date?: unknown;
}

/** MCP JSON-RPC 响应的最小化形状 */
interface McpRpcResponse {
  error?: { code?: number; message?: string };
  result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
}

/**
 * Zhipu web_search provider（实现 WebSearchProvider 契约）。
 * 构造器签名 (implId, cfg)——plugin_manager.instantiate 按 (implId, cfg) new。
 * [v0.0.72] 构造器 cfg 不再用于取凭证；凭证从运行时入参 cfg 读（isAvailable/search）。
 */
export default class ZhipuWebSearchProvider {
  /** implId（registry 登记，自识别） */
  readonly id: string;

  constructor(implId: string, _cfg: Record<string, unknown> = {}) {
    this.id = implId;
    // 构造器 cfg 不再用于取凭证；保留签名兼容 PluginManager (implId, cfg) 实例化链路
  }

  /** 展示名（错误提示用，与 zhipu_api impl 区分） */
  get label(): string {
    return '智谱 · Coding Plan（订阅额度）';
  }

  /**
   * 是否可用：只查入参 cfg.apiKey 配置非空（**禁止 I/O**，web_search_tool §5.3）。
   * [v0.0.72] 改为接收 cfg 入参；不再读 this.cfg / env。
   * @returns cfg.apiKey 非空 string → true；否则 false
   */
  isAvailable(cfg: WebSearchCfg = {}): boolean {
    return resolveApiKey(cfg) !== undefined;
  }

  /**
   * 执行检索：调 Zhipu web_search API，映射 search_result[] → WebSearchResult。
   * [v0.0.72] 签名加 cfg 入参；apiKey 从 cfg 读，空抛 `Error('zhipu provider 未配置 apiKey')`。
   * 超时/重试：单次调用 + AbortSignal 透传（ctx.signal）；重试留待后续版本。
   */
  async search(
    query: string,
    opts: WebSearchOptions = {},
    cfg: WebSearchCfg = {},
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    const apiKey = resolveApiKey(cfg);
    if (apiKey === undefined) {
      // 双保险：Tool 层应先 isAvailable 校验，这里防御性抛错
      throw new Error('zhipu provider 未配置 apiKey');
    }

    const count =
      typeof opts.maxResults === 'number' && opts.maxResults > 0
        ? opts.maxResults
        : DEFAULT_COUNT;

    // 组合超时 signal（provider 30s 覆盖两步 MCP 调用）+ 透传 ctx.signal（任一触发即取消）
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutCtrl.signal])
      : timeoutCtrl.signal;

    const startedAt = Date.now();
    // proxyFetch 统一走 EnvHttpProxyAgent（有 PROXY env）/ 直连（无），与 web_fetch 同源。
    const mcpPost = (sessionId: string | undefined, rpcBody: Record<string, unknown>) =>
      proxyFetch(ZHIPU_MCP_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(sessionId !== undefined ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify(rpcBody),
        signal: combinedSignal,
        timeoutMs: REQUEST_TIMEOUT_MS,
        noFollowRedirect: true,
      });

    let items: ZhipuSearchItem[];
    try {
      // ① initialize 握手拿 mcp-session-id（鉴权绑 session，跳过直调会报 "Api key not found"）
      const initRes = await mcpPost(undefined, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'rocky-agent', version: '0' },
        },
      });
      if (!initRes.ok) {
        throw new Error(`Zhipu MCP initialize HTTP ${initRes.status}: ${await safeReadText(initRes)}`);
      }
      const sessionId = initRes.headers.get('mcp-session-id');
      await safeReadText(initRes); // 消费 SSE 响应体；只用响应头
      if (sessionId === null || sessionId.length === 0) {
        throw new Error('Zhipu MCP initialize 未返回 mcp-session-id');
      }

      // ② tools/call 执行搜索（MCP 工具无 count 参数，maxResults 客户端截断）
      const callRes = await mcpPost(sessionId, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'web_search_prime', arguments: { search_query: query } },
      });
      if (!callRes.ok) {
        throw new Error(`Zhipu MCP tools/call HTTP ${callRes.status}: ${await safeReadText(callRes)}`);
      }
      items = extractMcpItems(parseSsePayload(await callRes.text()));
    } finally {
      clearTimeout(timer);
    }

    const results = mapZhipuResults(items.slice(0, count));
    return {
      provider: this.id,
      query,
      count: results.length,
      tookMs: Date.now() - startedAt,
      results,
      // MCP 端点不返回综合 answer，省略
    };
  }
}

/** 解析 Streamable HTTP 响应体：SSE 格式取 data: 行拼接，否则整体按 JSON 解析 */
function parseSsePayload(text: string): McpRpcResponse {
  const dataLines = text.split('\n').filter((l) => l.startsWith('data:'));
  const payload = dataLines.length
    ? dataLines.map((l) => l.slice('data:'.length).trim()).join('')
    : text;
  return JSON.parse(payload) as McpRpcResponse;
}

/** 从 tools/call JSON-RPC 结果提取结果数组（content[0].text 双重 JSON 编码，需 parse 两次） */
function extractMcpItems(rpc: McpRpcResponse): ZhipuSearchItem[] {
  if (rpc.error !== undefined) {
    throw new Error(`Zhipu MCP error ${rpc.error.code ?? ''}: ${rpc.error.message ?? ''}`);
  }
  const text = rpc.result?.content?.[0]?.text;
  if (rpc.result?.isError === true) {
    throw new Error(`Zhipu MCP tool error: ${text ?? '(no message)'}`);
  }
  if (typeof text !== 'string' || text.length === 0) return [];
  let parsed: unknown = JSON.parse(text);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return Array.isArray(parsed) ? (parsed as ZhipuSearchItem[]) : [];
}

/**
 * Zhipu 结果项 → SearchResultItem[] 映射（web_search_tool §7）。
 * title←title / url←link / snippet←content(截断) / publishedDate←publish_date。
 */
export function mapZhipuResults(items: ZhipuSearchItem[]): SearchResultItem[] {
  return items.map((item) => ({
    title: toStringValue(item.title),
    url: toStringValue(item.link),
    snippet: truncateSnippet(toStringValue(item.content)),
    publishedDate: toStringValue(item.publish_date) || undefined,
  }));
}

/** 安全转字符串（非 string → 空串） */
function toStringValue(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 截断 snippet 为摘要长度（避免 content 过长撑爆 context） */
function truncateSnippet(s: string): string {
  return s.length <= SNIPPET_MAX_CHARS ? s : s.slice(0, SNIPPET_MAX_CHARS) + '…';
}

/** 安全读响应文本（失败返空串，避免错误信息丢失） */
async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
