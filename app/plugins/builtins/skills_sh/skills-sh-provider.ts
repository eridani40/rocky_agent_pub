/**
 * builtin skills_sh plugin — SkillMarketProvider 实现（skills.sh 公开 skill 市场源）
 * 参考: specs/tech/agent/skills/[P1]skill_market.md §8；change_plan v0.0.166 模块 ③
 *
 * EP: skill_market_provider（exclusive）。implId=skills_sh。skills.sh 全端点匿名 200，无需 token：
 *   - 搜索 GET /api/search?q=<query>[&owner=] → { skills:[{id,skillId,name,installs,source}], count, duration_ms }
 *   - 下载 GET /api/download/{owner}/{repo}/{slug} → { files:[{path,contents}], hash }（内联单 skill 全部文件）
 *
 * 要点：capabilities 据实收窄 {stats:['installs']}；isAvailable 恒 true 禁 I/O；凭证只从运行时入参 cfg 读（cfg.token 可选）；
 * 出站走 proxyFetch（统一代理层）；ref 形状校验/防注入归本 provider
 * （格式 `{owner}/{repo}/{slug}`）；getDetail 无独立端点，复用 fetchSkillFiles + SKILL.md frontmatter 解析 name/description。
 */
import type {
  FetchedSkillFiles,
  SkillMarketCapabilities,
  SkillMarketCfg,
  SkillMarketDetail,
  SkillMarketItem,
  SkillMarketProvider,
  SkillMarketSearchOptions,
  SkillMarketSearchResult,
} from '../../../server/src/tools/skill-market/types';
// 复用 web-fetch 代理层（proxyFetch 统一读 HTTP_PROXY env，与 web_fetch/web_search 同源出站）
import { proxyFetch } from '../../../server/src/tools/web-fetch/proxy';

/** skills.sh 站点根（search/download 端点均基于此） */
const SKILLS_SH_BASE = 'https://skills.sh';

/** 请求超时 ms（skill_market §8：provider 自带 30s） */
const REQUEST_TIMEOUT_MS = 30_000;

/** search 默认返回条数（skills.sh API 无 per_page 保证 → 客户端 slice 兜底） */
const DEFAULT_LIMIT = 20;

/** ref 单段合法字符（防路径遍历/注入：仅字母数字与 . _ -） */
const REF_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** skills.sh /api/search 项的最小化形状（运行时形状校验用） */
interface SkillsShApiItem {
  id?: unknown; // `{owner}/{repo}/{slug}`，作 ref
  skillId?: unknown;
  name?: unknown;
  installs?: unknown;
  source?: unknown; // `{owner}/{repo}`
}

/** skills.sh /api/search 响应最小化形状 */
interface SkillsShSearchResponse {
  skills?: SkillsShApiItem[];
  count?: unknown;
  duration_ms?: unknown;
}

/** skills.sh /api/download 响应最小化形状 */
interface SkillsShDownloadResponse {
  files?: Array<{ path?: unknown; contents?: unknown }>;
  hash?: unknown;
}

/**
 * skills.sh 市场源 provider（实现 SkillMarketProvider 契约）。
 * 构造器 (implId, cfg)——PluginManager 按此 new；cfg 不用于取凭证，凭证从运行时入参 cfg 读。
 */
export default class SkillsShProvider implements SkillMarketProvider {
  /** implId（registry 登记，自识别） */
  readonly id: string;

  /** 据实收窄：skills.sh 唯一统计维度 installs（无 stars）；categories/collections/sorts 均不声明。 */
  readonly capabilities: SkillMarketCapabilities = { stats: ['installs'] };

  constructor(implId: string, _cfg: Record<string, unknown> = {}) {
    this.id = implId;
  }

  /** 展示名（配置 UI / 错误提示用） */
  get label(): string {
    return 'skills.sh';
  }

  /** 恒 true：全端点匿名 200，无需 token（cfg.token 可选）。**禁止 I/O**（skill_market §8）。 */
  isAvailable(_cfg: SkillMarketCfg = {}): boolean {
    return true;
  }

  /**
   * 搜索市场：GET /api/search?q=<query>[&owner=] → skills[] 映射 SkillMarketSearchResult。
   * tookMs=duration_ms 或本地计时；limit 客户端截断（API 无 per_page 保证）。
   */
  async search(
    query: string,
    opts: SkillMarketSearchOptions = {},
    cfg: SkillMarketCfg = {},
    signal?: AbortSignal,
  ): Promise<SkillMarketSearchResult> {
    const params = new URLSearchParams({ q: query });
    if (typeof opts.owner === 'string' && opts.owner.length > 0) {
      params.set('owner', opts.owner);
    }
    const url = `${SKILLS_SH_BASE}/api/search?${params.toString()}`;

    const startedAt = Date.now();
    const json = (await fetchJson(url, cfg, signal)) as SkillsShSearchResponse;

    const limit =
      typeof opts.limit === 'number' && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
    const items = mapSkillsShItems(json.skills ?? []).slice(0, limit);
    const tookMs =
      typeof json.duration_ms === 'number' ? json.duration_ms : Date.now() - startedAt;

    return {
      provider: this.id,
      query,
      count: items.length,
      tookMs,
      items,
      // skills.sh 无游标翻页 → 不返回 nextCursor
    };
  }

  /** skills.sh 无独立详情端点 → 复用 fetchSkillFiles，从 SKILL.md frontmatter 解析 name/description、正文作 readme。 */
  async getDetail(
    ref: string,
    cfg: SkillMarketCfg = {},
    signal?: AbortSignal,
  ): Promise<SkillMarketDetail> {
    const { owner, repo, slug } = parseRef(ref);
    const fetched = await this.fetchSkillFiles(ref, cfg, signal);
    const skillMd = pickSkillMd(fetched.files);
    const fm = skillMd ? parseSkillFrontmatter(skillMd.contents) : { body: '' };

    return {
      ref,
      name: fm.name ?? slug,
      description: fm.description,
      readme: fm.body || undefined,
      // 仓库定位：skills.sh 站点上该 skill 的规范地址（best-effort，不臆造 GitHub 直链）
      repository: { url: `${SKILLS_SH_BASE}/${owner}/${repo}/${slug}` },
      // v0.0.167：hash/files 复用上面已 fetch 的 fetched（零额外请求）——hash 供前端惰性可更新比对，files 仅路径省 payload。
      hash: fetched.hash,
      files: fetched.files.map((f) => ({ path: f.path })),
    };
  }

  /**
   * 取 skill 全部文件（install 用，喂给 installer source-无关核心；不做校验/落盘）。
   * 拆 ref（本方法校验形状 + 防注入）→ GET /api/download/{owner}/{repo}/{slug} → 透传 FetchedSkillFiles。
   */
  async fetchSkillFiles(
    ref: string,
    cfg: SkillMarketCfg = {},
    signal?: AbortSignal,
  ): Promise<FetchedSkillFiles> {
    const { owner, repo, slug } = parseRef(ref);
    const url = `${SKILLS_SH_BASE}/api/download/${owner}/${repo}/${slug}`;
    const json = (await fetchJson(url, cfg, signal)) as SkillsShDownloadResponse;

    const files = (json.files ?? [])
      .map((f) => ({ path: toStringValue(f.path), contents: toStringValue(f.contents) }))
      .filter((f) => f.path.length > 0);

    return {
      files,
      hash: typeof json.hash === 'string' ? json.hash : undefined,
    };
  }
}

/**
 * skills.sh search 项 → SkillMarketItem[]：id→ref、name→name、installs→stats.installs。
 * description 留 undefined（search 阶段不返回，getDetail 从 SKILL.md frontmatter 补填）；
 * 未声明能力的门控字段一律不填（不造假）。
 */
export function mapSkillsShItems(skills: SkillsShApiItem[]): SkillMarketItem[] {
  const out: SkillMarketItem[] = [];
  for (const s of skills) {
    const ref = toStringValue(s.id);
    if (ref.length === 0) continue; // ref 是 install 唯一标识，缺则跳过
    const item: SkillMarketItem = {
      ref,
      name: toStringValue(s.name) || ref,
    };
    if (typeof s.installs === 'number') {
      item.stats = { installs: s.installs };
    }
    out.push(item);
  }
  return out;
}

/**
 * 拆解并校验 ref=`{owner}/{repo}/{slug}`（provider 定义格式）。
 * 严格 3 段、每段仅允许 [A-Za-z0-9._-]（防路径遍历/注入）；非法抛错。
 */
export function parseRef(ref: string): { owner: string; repo: string; slug: string } {
  const segs = typeof ref === 'string' ? ref.split('/') : [];
  const valid =
    segs.length === 3 &&
    segs.every((s) => REF_SEGMENT_RE.test(s) && s !== '.' && s !== '..');
  if (!valid) {
    throw new Error(
      `无效 skill ref '${ref}'：期望格式 {owner}/{repo}/{slug}（仅字母数字与 . _ -）`,
    );
  }
  return { owner: segs[0], repo: segs[1], slug: segs[2] };
}

/** 统一出站请求 + JSON 解析：proxyFetch，30s 超时 + 透传 ctx.signal。 */
async function fetchJson(
  url: string,
  cfg: SkillMarketCfg,
  signal?: AbortSignal,
): Promise<unknown> {
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutCtrl.signal])
    : timeoutCtrl.signal;

  let res: Response;
  try {
    res = await proxyFetch(url, {
      method: 'GET',
      headers: buildHeaders(cfg),
      signal: combinedSignal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      noFollowRedirect: true,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`skills.sh HTTP ${res.status}: ${await safeReadText(res)}`);
  }
  return await res.json();
}

/** 构造请求头：默认 Accept JSON；cfg.token 非空则加 Authorization（可选增强，不依赖）。 */
function buildHeaders(cfg: SkillMarketCfg): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = cfg.token;
  if (typeof token === 'string' && token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** 从文件列表中挑出 SKILL.md（优先最短路径，兼容 `SKILL.md` 与 `<slug>/SKILL.md`）。 */
function pickSkillMd(
  files: Array<{ path: string; contents: string }>,
): { path: string; contents: string } | undefined {
  const candidates = files.filter((f) => f.path.split('/').pop() === 'SKILL.md');
  candidates.sort((a, b) => a.path.length - b.path.length);
  return candidates[0];
}

/**
 * 极简 SKILL.md frontmatter 解析（仅取 name/description 标量 + 正文 body）。
 * 不引第三方 YAML 库（保持 plugin 自包含、无新 EXTERNALS）；只解析单行 `key: value` 标量。
 */
export function parseSkillFrontmatter(md: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(md);
  if (!m) return { body: md };
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let val = kv[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    fields[kv[1]] = val;
  }
  return { name: fields.name, description: fields.description, body: m[2] ?? '' };
}

/** 安全转字符串（非 string → 空串） */
function toStringValue(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 安全读响应文本（失败返空串，避免错误信息丢失） */
async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
