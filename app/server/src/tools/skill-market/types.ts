/**
 * skill 市场子系统协议类型（SkillMarketProvider 契约权威源）
 * 参考: specs/tech/agent/skills/[P1]skill_market.md §2/§3
 *
 * 设计要点（对齐 web-search/types.ts 风格）：
 *   - 协议只定义 search / getDetail / fetchSkillFiles 行为 + capabilities 自描述，
 *     **不定义 install**（install 的校验/落盘/治理是 installer 通用核心，source 无关）；
 *   - capability negotiation 三层字段模型（§3）：核心必有 ref/name + 可选 description +
 *     能力门控的可选字段/参数——provider 只填/只认自己声明的能力，缺字段=undefined 不造假；
 *   - 凭证不进协议（cfg 是不透明 map，由 tool 从 app_config.skill_market.credentials 构造传入），
 *     impl 不得从 this.cfg / env 读凭证，统一从运行时入参 cfg 读。
 */

/**
 * provider 自描述支持能力（capability negotiation 核心）。
 * 上层先读 capabilities 再决定渲染/传参：能力多的源多渲染几维、能力少的源少渲染。
 * 据实收窄：skills.sh 只有 installs 一个统计维度，无 categories/collections/显式 sorts。
 */
export interface SkillMarketCapabilities {
  /** 支持的分类枚举；false=不支持分类过滤；undefined=未声明（skills.sh 不声明） */
  categories?: string[] | false;
  /** 支持的集合/精选清单名（skills.sh 不声明） */
  collections?: string[];
  /** 支持的排序模式（skills.sh 不声明——search 已是后端相关度/installs 排序，无显式 sort 参数） */
  sorts?: SkillSortMode[];
  /** 结果里能带哪些统计维度（skills.sh = ['installs']，无 stars） */
  stats?: ('installs' | 'stars')[];
}

/** 排序模式全集（provider 只声明自己支持的子集，上层只传声明支持的） */
export type SkillSortMode =
  | 'relevance'
  | 'trending'
  | 'hot'
  | 'updated'
  | 'stars'
  | 'installs';

/**
 * 市场结果项（通用核心必有 + 可选能力门控字段，见 §3 三层字段模型）。
 * provider 只填自己 capabilities 声明支持的门控字段；缺字段=undefined，不报错、不造假。
 */
export interface SkillMarketItem {
  /**
   * 通用核心（必有）：install 唯一标识 ref（provider 定义格式；
   * skills.sh = `{source}/{skillId}`，如 `github/awesome-copilot/git-commit`，
   * 可拆成 owner/repo/slug 供 /api/download）。
   */
  ref: string;
  /** 通用核心（必有）：skill 名 */
  name: string;
  /**
   * 核心可选：search 阶段部分源（如 skills.sh）**不返回** description → 留 undefined；
   * getDetail 从 SKILL.md frontmatter 补填。上层缺则不渲染描述，不报错。
   */
  description?: string;
  /** 可选 + 能力门控（结果字段，provider 只填 capabilities 声明支持的） */
  category?: string;
  tags?: string[];
  collection?: string;
  version?: string;
  /** ISO 时间戳 */
  updatedAt?: string;
  /** 统计维度（skills.sh 仅 installs，无 stars） */
  stats?: { installs?: number; stars?: number };
  verified?: boolean;
  official?: boolean;
}

/**
 * search 调用选项（可选 + 能力门控参数）。
 * provider 只认自己 capabilities 声明支持的；传不支持的一律忽略（不报错）。
 * skills.sh 只认 owner（+ limit）。
 */
export interface SkillMarketSearchOptions {
  /** 按 gh_owner 过滤（skills.sh 支持 &owner=） */
  owner?: string;
  /** provider 不支持则忽略 */
  category?: string;
  collection?: string;
  sort?: SkillSortMode;
  /** 默认 20，上限由 provider 定 */
  limit?: number;
  /** 游标翻页（skills.sh 无 → 不返回 nextCursor） */
  cursor?: string;
}

/** search 返回值 */
export interface SkillMarketSearchResult {
  /** provider.id */
  provider: string;
  query: string;
  /** = items.length */
  count: number;
  /** 耗时 ms（skills.sh duration_ms 或本地计时） */
  tookMs: number;
  items: SkillMarketItem[];
  /** 有更多时返回（skills.sh 无 → 不返回） */
  nextCursor?: string;
}

/**
 * skill 详情（getDetail 返回；README + 元数据）。
 * skills.sh 无独立详情端点——getDetail 走 /api/download 取文件，
 * 从 SKILL.md frontmatter 解析 name/description，SKILL.md 正文作 readme。
 */
export interface SkillMarketDetail extends SkillMarketItem {
  readme?: string;
  /** 仓库定位（url + 可选子路径；skills.sh monorepo skill 用 subpath 指向子目录） */
  repository?: { url: string; subpath?: string };
  /** provider 自定义结构（skills.sh 无） */
  securityAudit?: unknown;
  /**
   * v0.0.167：当前内容哈希（可更新惰性比对锚点）。详情 modal 用 detail.hash 与已安装
   * SkillEntry.installedHash 本地比对判「可更新」，零额外请求（skills.sh getDetail 内部已 fetch）。
   * 缺失=能力门控（provider 不返 → undefined，UI 不做可更新判定）。
   */
  hash?: string;
  /**
   * v0.0.167：包含文件列表（仅相对路径，**不回传 contents** 省 payload）。详情 modal 展示文件清单。
   */
  files?: Array<{ path: string }>;
}

/**
 * provider.fetchSkillFiles 返回：某个 skill 的所有文件（内联内容）+ 可选校验 hash。
 * install 用此喂给 installer 通用核心（source 无关，不做校验/落盘）。
 */
export interface FetchedSkillFiles {
  /** path=相对 skill 根；contents=utf-8 文本 */
  files: Array<{ path: string; contents: string }>;
  hash?: string;
}

/**
 * 不透明配置 map；由 tool 从 app_config.skill_market.credentials[impl.id] 构造传入；
 * 协议不定义字段。skills.sh 全端点匿名可用，cfg.token 可选（未来提额度用，当前不依赖）。
 */
export type SkillMarketCfg = Record<string, unknown>;

/**
 * 市场源提供方契约（由插件 ext impl 实现）。
 * 凭证不进协议（归 app_config skill_market group）；impl 从运行时入参 cfg 读凭证，禁从 this.cfg / env 读。
 * 协议**不定义 install**——install 的校验/落盘/治理是 installer source-无关核心；
 * fetchSkillFiles 只 source-specific 取文件，不落盘。
 */
export interface SkillMarketProvider {
  /** provider 唯一 id（snake_case，与 ext impl implId 对应） */
  id: string;
  /** 展示名（配置 UI / 错误提示用） */
  label: string;
  /** 自描述能力（静态属性，上层据此协商） */
  readonly capabilities: SkillMarketCapabilities;
  /**
   * 是否可用（如可选 token 是否配置）。**禁止 I/O**（只查内存 cfg），否则每次 assemble 阻塞。
   * 匿名公开只读源恒返 true。
   */
  isAvailable(cfg: SkillMarketCfg): boolean;
  /** 搜索市场（超时/重试 provider 内部处理，默认 30s） */
  search(
    query: string,
    opts: SkillMarketSearchOptions,
    cfg: SkillMarketCfg,
    signal?: AbortSignal,
  ): Promise<SkillMarketSearchResult>;
  /** 取 skill 详情（ref = provider 定义格式；skills.sh 走 /api/download + SKILL.md frontmatter） */
  getDetail(ref: string, cfg: SkillMarketCfg, signal?: AbortSignal): Promise<SkillMarketDetail>;
  /**
   * 取 skill 的所有文件（source-specific；install 用，喂给 installer source-无关核心）。
   * 不做校验/落盘（那是 installer 通用核心的职责）；只负责「从本源精确取到这个 skill 的文件」。
   * ref 形状校验/防注入归本方法（ref 格式由 provider 定义）。
   */
  fetchSkillFiles(
    ref: string,
    cfg: SkillMarketCfg,
    signal?: AbortSignal,
  ): Promise<FetchedSkillFiles>;
}
