/**
 * web_search 子系统协议类型（WebSearchProvider 契约权威源）
 * 参考: specs/tech/agent/tools/[P1]web_search_tool.md §2
 *
 * 协议 search/isAvailable 带 cfg 入参（不透明 map）；
 * 凭证不进协议（cfg 由 tool 从 app_config 构造传入）；
 * impl 不得从 this.cfg / env 读凭证，统一从运行时入参 cfg 读。
 */

/** 搜索结果项（最小集：title/url/snippet；score/publishedDate 可选） */
export interface SearchResultItem {
  title: string;
  url: string;
  /** 摘要正文（provider 截断为 snippet 长度） */
  snippet: string;
  /** 相关度（provider 自定义刻度，可选） */
  score?: number;
  /** 发布日期 ISO，可选 */
  publishedDate?: string;
}

/** 搜索结果（provider.search 返回值） */
export interface WebSearchResult {
  /** provider.id */
  provider: string;
  query: string;
  /** results.length */
  count: number;
  /** 耗时 ms */
  tookMs: number;
  /** 结构化结果项 */
  results: SearchResultItem[];
  /** provider 综合出的带引用答案（answer=true 时可能返回，可选） */
  answer?: string;
}

/** search 调用选项 */
export interface WebSearchOptions {
  /** 默认 10；上限由 provider 定 */
  maxResults?: number;
  /** 是否请求「带引用的答案」（部分后端支持；不支持则忽略） */
  answer?: boolean;
}

/**
 * 不透明配置 map。
 * 由 tool 从 `app_config.web_search.credentials[type]` 构造，每次调用传入 impl。
 * 协议不规定字段，由 impl 自定义（zhipu 期望 { apiKey?: string }）。
 */
export type WebSearchCfg = Record<string, unknown>;

/**
 * 搜索后端提供方契约（由插件 ext impl 实现）。
 * 凭证归 app_config web_search group，不进协议；
 * impl 从运行时入参 cfg 读凭证，禁从 this.cfg / env 读。
 */
export interface WebSearchProvider {
  /** provider 唯一 id（snake_case，与 ext impl implId 对应） */
  id: string;
  /** 展示名（配置 UI / 错误提示用） */
  label: string;
  /**
   * 是否可用（如凭证是否配置）。**禁止做 I/O**（只查内存配置），否则每次 assemble 阻塞。
   * 接收 cfg 入参（map，由 tool 从 app_config 构造传入）。
   * 返回 false → Tool 返精确错误（"provider X 不可用 / 凭证未配置"），不静默换 provider。
   */
  isAvailable(cfg: WebSearchCfg): boolean;
  /**
   * 执行检索。超时/重试由 provider 内部处理（默认 30s + 2 次指数退避）。
   * 带 cfg 入参（map，由 tool 从 app_config.web_search.credentials[type] 构造传入）。
   * 协议不定义 apiKey 字段——cfg 是不透明 map，各 impl 自定义字段（zhipu 读 cfg.apiKey）。
   */
  search(
    query: string,
    opts: WebSearchOptions,
    cfg: WebSearchCfg,
    signal?: AbortSignal,
  ): Promise<WebSearchResult>;
}
