/**
 * SearchEngine — 历史检索引擎（一期 BM25 + recency 重排）
 * 参考: specs/tech/persistence/[P1]search_engine.md §3.2(schema) §3.5(检索) §3.6(副本vs锚点)
 *       specs/tech/version_logs/v0.0.126/change_plan.md 模块1（8 符号行）
 *
 * 不变量：召回只读副本不回读 transcript；message_id=ULID 全链路锚点；ts=message_id；
 *   sanitize 防 FTS5 注入；半衰期 30 天代码默认（spec §6）。
 * 协作：持 SqlDriver（T1）+ SessionTitleResolver（最小回调，避免硬耦合 SessionStore）；
 *   SqlStatement 是 all/run 直接参数化（T1 偏离：无 bind）；本类做轻量 stmtCache。
 */
import type { SqlDriver, SqlStatement } from './search-sql-driver';
// extractPlainText 共享实现（UT 从 search-engine re-export 读；实现本体在 search-text-util）
export { extractPlainText } from './search-text-util';

/**
 * SessionTitle 解析器（最小回调契约，解耦 SearchEngine 与 SessionStore）。
 * bootstrap 注入 `(sid) => sessionStore.getSession(sid)?.title ?? null`。
 */
export type SessionTitleResolver = (sessionId: string) => Promise<string | null> | string | null;

/** search() 选项 */
export interface SearchOptions {
  /** 召回时附加 OR 关键词（boost 语义，一期并入 MATCH 表达式） */
  keywords?: string[];
  /** 排除/限定 session（一期 scope=exclude_current 时必填 currentSession） */
  scope?: 'all' | 'exclude_current';
  currentSession?: string;
  /** 时间下限（ISO 或 ULID，字典序比较） */
  after?: string;
  /** 时间上限（ISO 或 ULID，字典序比较） */
  before?: string;
  /** 返回 top_k，默认 10 */
  topK?: number;
}

/** 调试信息（searchWithDebug 附加到每条 hit） */
export interface HistorySearchHitDebug {
  /** bm25 原始分（越小越好；SQLite bm25 返回负数，取绝对值方便阅读） */
  bm25_score: number;
  /** 匹配到的 trigram token 列表 */
  matched_terms: string[];
  /** 路由标记：一期恒 'bm25'（二期有 RRF 融合再扩） */
  fts_route: 'bm25';
}

/** 单条检索命中 */
export interface HistorySearchHit {
  sessionId: string;
  sessionTitle: string | null;
  messageId: string;
  role: 'user' | 'assistant';
  /** ISO 时间戳（从 message_id ULID 解码） */
  timestamp: string;
  /** snippet(fts) 产出，含 «...» 高亮标记 */
  snippet: string;
  /** 综合得分（bm25 归一化 × recency decay）；越大越好 */
  score: number;
  /** 仅 searchWithDebug 附带 */
  debug?: HistorySearchHitDebug;
}

/** recency 半衰期（天）— 一期代码默认（spec §3.5） */
const RECENCY_HALF_LIFE_DAYS = 30;
const K_PRE_MULTIPLIER = 3;     // k_pre = top_k × 3
const K_PRE_CAP = 50;           // 召回上限
const DEFAULT_TOP_K = 10;
const SNIPPET_TOKENS = 12;
const SNIPPET_BEFORE = '«';
const SNIPPET_AFTER = '»';
const SNIPPET_ELLIPSIS = ' … ';

const ULID_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 解码 ULID 内嵌时间戳（前 10 字符 Crockford base32 → ms since epoch）。
 * 非 ULID / 非法字符返 null（recency 视为「无信息」）。
 */
export function decodeUlidTime(ulid: string): number | null {
  if (!ulid || ulid.length < 10) return null;
  let ms = 0;
  for (let i = 0; i < 10; i++) {
    const v = ULID_BASE32.indexOf((ulid[i] ?? '').toUpperCase());
    if (v < 0) return null;
    ms = ms * 32 + v;
  }
  return ms;
}

/**
 * 历史检索引擎主类（spec §3.5 召回+打分+snippet）。
 * 构造调 ensureSchema；search 是同步方法（SqlDriver.all 同步）。
 */
export class SearchEngine {
  private readonly stmtCache = new Map<string, SqlStatement>();

  constructor(
    private readonly driver: SqlDriver,
    private readonly titleResolver: SessionTitleResolver = () => null,
  ) {
    this.ensureSchema();
  }

  /** 建 chunks + fts(external-content, trigram) + idx_chunks_session + idx_meta。IF NOT EXISTS 幂等。 */
  ensureSchema(): void {
    this.driver.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        message_id  TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        role        TEXT NOT NULL,
        ts          TEXT NOT NULL,
        text        TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        text,
        content='chunks', content_rowid='rowid',
        tokenize='trigram'
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
      CREATE TABLE IF NOT EXISTS idx_meta (k TEXT PRIMARY KEY, v TEXT);
    `);
  }

  /**
   * 检索入口（spec §3.5）：
   * sanitize → trigram 分词 → MATCH + OR keywords → bm25 拉 k_pre → recency 重排取 top_k → snippet。
   */
  search(query: string, opts: SearchOptions = {}): HistorySearchHit[] {
    return this._searchInternal(query, opts, false).hits;
  }

  /** search + 每 hit 附 debug（bm25 原始分 / matched_terms / fts_route） */
  searchWithDebug(query: string, opts: SearchOptions = {}): HistorySearchHit[] {
    return this._searchInternal(query, opts, true).hits;
  }

  /** 内部共享检索逻辑，返回 hits + matchedTerms */
  private _searchInternal(
    query: string,
    opts: SearchOptions,
    withDebug: boolean,
  ): { hits: HistorySearchHit[]; matchedTerms: string[] } {
    const topK = Math.max(1, opts.topK ?? DEFAULT_TOP_K);
    const kPre = Math.min(K_PRE_CAP, topK * K_PRE_MULTIPLIER);

    // sanitize → MATCH 表达式；空查询返空（spec §3.5）
    const { expression, matchedTerms } = this._sanitize(query, opts.keywords);
    if (!expression) return { hits: [], matchedTerms };

    // external-content 模式：JOIN chunks 取业务字段 + snippet；bm25 返负数越小越相关
    const sql =
      `SELECT c.message_id, c.session_id, c.role, c.ts, ` +
      `snippet(fts, 0, '${SNIPPET_BEFORE}', '${SNIPPET_AFTER}', '${SNIPPET_ELLIPSIS}', ${SNIPPET_TOKENS}) AS snippet, ` +
      `bm25(fts) AS bm25_score ` +
      `FROM fts JOIN chunks c ON c.rowid = fts.rowid ` +
      `WHERE fts MATCH ? `;
    const whereClauses: string[] = [];
    const whereParams: unknown[] = [];
    if (opts.scope === 'exclude_current' && opts.currentSession) {
      whereClauses.push('c.session_id != ?');
      whereParams.push(opts.currentSession);
    }
    if (opts.after) { whereClauses.push('c.ts > ?'); whereParams.push(opts.after); }
    if (opts.before) { whereClauses.push('c.ts < ?'); whereParams.push(opts.before); }
    const fullSql = whereClauses.length
      ? sql + 'AND ' + whereClauses.join(' AND ') + ' ORDER BY bm25(fts) LIMIT ?'
      : sql + 'ORDER BY bm25(fts) LIMIT ?';
    const params: unknown[] = [expression, ...whereParams, kPre];

    type Row = {
      message_id: string; session_id: string; role: 'user' | 'assistant';
      ts: string; snippet: string; bm25_score: number;
    };
    const rows = this.getStmt(fullSql).all<Row>(...params);
    const ranked = this._applyRecency(rows).slice(0, topK);

    const hits: HistorySearchHit[] = ranked.map((r) => {
      const tsMs = decodeUlidTime(r.message_id);
      const timestamp = tsMs !== null ? new Date(tsMs).toISOString() : r.ts;
      const bm25Abs = Math.abs(r.bm25_score);
      const hit: HistorySearchHit = {
        sessionId: r.session_id,
        sessionTitle: this._tryResolveTitleSync(r.session_id),
        messageId: r.message_id,
        role: r.role,
        timestamp,
        snippet: r.snippet,
        score: bm25Abs * this._decayFor(r.message_id),
      };
      if (withDebug) {
        hit.debug = { bm25_score: bm25Abs, matched_terms: matchedTerms, fts_route: 'bm25' };
      }
      return hit;
    });

    // [history_search] 临时验证 log：检索召回情况
    try {
      const topScore = hits.length > 0 ? hits[0]!.score.toFixed(4) : 'n/a';
      console.log(
        `[history_search] SearchEngine.search: query=${JSON.stringify(query)}, ` +
          `scope=${opts.scope ?? 'all'}, topK=${topK}, recalled=${rows.length}, ` +
          `returned=${hits.length}, topScore=${topScore}, ` +
          `matchedTerms=${JSON.stringify(matchedTerms)}, ` +
          `driver=${this.driver.constructor?.name ?? '?'}`,
      );
    } catch {
      // log 本身不抛错
    }

    return { hits, matchedTerms };
  }

  /** 同步取 title：titleResolver 若返 Promise（异步）则忽略返 null（保 search 同步语义） */
  private _tryResolveTitleSync(sessionId: string): string | null {
    try {
      const v = this.titleResolver(sessionId);
      return typeof v === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * 剥 FTS5 控制字符（`"`/`*`/`:`/`(`/`)`/`^`）+ trigram 分词 + 拼 OR 表达式。
   * @returns { expression, matchedTerms }；空 query / 全控制字符 → expression=''（search 返空）
   */
  private _sanitize(query: string, keywords?: string[]): { expression: string; matchedTerms: string[] } {
    const cleaned = (query ?? '').replace(/["*:()^]/g, ' ').trim();
    const tokens = this._trigramTokens(cleaned);
    const kwTokens = (keywords ?? []).flatMap((k) => this._trigramTokens(k.replace(/["*:()^]/g, ' ').trim()));
    const all = Array.from(new Set([...tokens, ...kwTokens]));
    if (all.length === 0) return { expression: '', matchedTerms: [] };
    const expression = all.map((t) => `"${t}"`).join(' OR ');
    return { expression, matchedTerms: all };
  }

  /** 切 trigram token（中英文均按 3 char 滑窗；<3 字符段直接当 token） */
  private _trigramTokens(s: string): string[] {
    if (!s) return [];
    const tokens: string[] = [];
    for (const seg of s.toLowerCase().split(/\s+/)) {
      if (seg.length < 3) { if (seg) tokens.push(seg); continue; }
      for (let i = 0; i + 3 <= seg.length; i++) tokens.push(seg.slice(i, i + 3));
    }
    return Array.from(new Set(tokens));
  }

  /** 按 ts(=message_id ULID) 算 age_days，decay = 0.5^(age_days/30)，重排。重排 key = abs(bm25) × decay。 */
  private _applyRecency<T extends { message_id: string; bm25_score: number }>(rows: T[]): T[] {
    return rows
      .map((r) => ({ row: r, sortKey: Math.abs(r.bm25_score) * this._decayFor(r.message_id) }))
      .sort((a, b) => b.sortKey - a.sortKey)
      .map((x) => x.row);
  }

  /** 计算单条 message 的 recency decay（非 ULID 视为最新，不打折） */
  private _decayFor(messageId: string): number {
    const ms = decodeUlidTime(messageId);
    if (ms === null) return 1;
    const ageDays = (Date.now() - ms) / (1000 * 60 * 60 * 24);
    return ageDays <= 0 ? 1 : Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
  }

  /** stmtCache：避免同名 SQL 重复 prepare（driver 是否缓存由实现决定，本类不假定） */
  private getStmt(sql: string): SqlStatement {
    let s = this.stmtCache.get(sql);
    if (!s) { s = this.driver.prepare(sql); this.stmtCache.set(sql, s); }
    return s;
  }
}
