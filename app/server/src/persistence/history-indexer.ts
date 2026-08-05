/**
 * HistoryIndexer — search.sqlite 写入队列 + 兜底机制
 * 参考: specs/tech/persistence/[P1]search_engine.md §4（写入路径）+ §5（兜底机制）+ §3.3（文本来源时序）
 *       specs/tech/version_logs/v0.0.126/change_plan.md 模块2
 *
 * 偏离 spec §3.1：T1 SqlStatement 无 bind()，all/run 直接参数化（...params）。
 * 文本提取走 search-text-util.ts 共享实现（extractPlainText）。
 */
import type { SqlDriver } from './search-sql-driver';
import { extractPlainText } from './search-text-util';
import { reconcileTranscripts } from './history-indexer-reconcile';

/** 别名（UT 引用此名；语义 = extractPlainText） */
export const extractTextFromContent = extractPlainText;

/** 批量 INSERT 默认大小（spec §4：默认 32 条一批） */
const BATCH_SIZE = 32;
/** 批间 sleep 时长（用户原话「处理完就 sleep 1 秒」；削峰填谷 + 防 SQLite 写锁被 indexer 独占） */
const BATCH_INTERVAL_MS = 1000;
/** queue 空时 loop 轮询间隔（unref timer，不阻塞进程退出） */
const IDLE_WAIT_MS = 50;
/** 队列背压上限（防御性，正常用例永不触发；满时 drop new + warn，被丢的由 reconcile 补） */
const MAX_QUEUE_SIZE = 5000;
/** flush() 轮询步长（UT 用；生产不调 flush） */
const FLUSH_POLL_MS = 20;
/** flush() 安全 deadline（防 UT 永久 hang） */
const FLUSH_DEADLINE_MS = 30_000;
/** idx_meta 里存的水位 key（reconcile 增量扫的起点） */
const META_LAST_ULID = 'last_ulid';

/** 延迟 ms（unref timer 不阻塞进程退出，与 channel-send-queue.ts L28-31 同模式） */
const sleep = (ms: number): Promise<void> =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

/**
 * indexer 投递载荷。handler 从内存 messages 提取后直接投递，零回读 jsonl。
 * - messageId：ULID，全链路锚点（= transcript record id = chunks.message_id）
 * - ts：= messageId（ULID 字典序 = 时间序，recency 排序用）
 * - role：仅 user/assistant 进索引（system/tool 由 handler 过滤掉）
 */
export interface IndexPayload {
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant';
  ts: string;
  text: string;
}

/**
 * 建 search.sqlite schema（chunks + fts external-content + triggers + idx_meta）。
 * 幂等（IF NOT EXISTS）。FTS5 external-content 模式：fts 虚表引用 chunks 的 rowid，
 * triggers 保证同步。deleteBySession 走 DELETE FROM chunks → trigger 自动级联删 fts 行。
 */
export function ensureHistorySchema(driver: SqlDriver): void {
  driver.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      message_id  TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      role        TEXT NOT NULL,
      ts          TEXT NOT NULL,
      text        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      text, content='chunks', content_rowid='rowid', tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO fts(fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO fts(fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TABLE IF NOT EXISTS idx_meta (k TEXT PRIMARY KEY, v TEXT);
  `);
}

/**
 * search.sqlite 写入队列 + 兜底机制。
 * 不变量（spec §4）：单 worker 保序 / batch 32 单事务 / 失败吞 + reconcile 兜底 / last_ulid 水位。
 * 不变量（spec §3.3）：index() 不 await、不阻塞 ingest、异常吞。
 * 不变量：consumer loop 批间必须 await 让出 event loop（MUST NOT 同步排空）。
 */
export class HistoryIndexer {
  private readonly driver: SqlDriver;
  private queue: IndexPayload[] = [];
  /** consumer loop 是否已启动（lazy on first index；单 worker 守卫） */
  private loopStarted = false;
  /** dataRoot：reconcile/rebuild 扫 jsonl 的根目录（扫 sessions/{sid}/transcript 下的 .jsonl） */
  private readonly dataRoot: string | null;

  /**
   * @param driver SqlDriver 实例（dev=BunSqlDriver / packaged=Node/BetterSqlite3）
   * @param dataRoot 数据根目录；传 null 则 reconcile/rebuild 不扫文件（UT 隔离用）
   */
  constructor(driver: SqlDriver, dataRoot: string | null = null) {
    this.driver = driver;
    this.dataRoot = dataRoot;
    ensureHistorySchema(driver);
  }

  /**
   * handler 投递入口：push 内部队列，lazy 启动 consumer loop（首次）。
   * 不 await（fire-and-forget），异常吞掉（不影响 ingest，spec §3.3 invariant）。
   *
   * 背压：queue + arr 超 MAX_QUEUE_SIZE → drop new + warn（保 FIFO 序；被丢的 payload
   * 已在 store_sink 落 jsonl，下次启动 reconcile 扫 id > last_ulid 自动补）。
   */
  index(payload: IndexPayload | IndexPayload[]): void {
    const arr = Array.isArray(payload) ? payload : [payload];
    if (arr.length === 0) return;
    // 背压检查：drop new 不 drop old（保 FIFO，与 SendQueue 同策略）
    if (this.queue.length + arr.length > MAX_QUEUE_SIZE) {
      console.warn(
        `[history_indexer] queue overflow (${this.queue.length}+${arr.length} > ${MAX_QUEUE_SIZE}), ` +
          `dropping new (reconcile will catch up on next startup)`,
      );
      return;
    }
    for (const p of arr) this.queue.push(p);
    // [history_search] 临时验证 log：投递入队的 payload 数 + 队列当前长度
    try {
      const firstSid = arr[0]?.sessionId ?? '?';
      const lastMid = arr[arr.length - 1]?.messageId ?? '?';
      console.log(
        `[history_search] indexer.index: queued=${arr.length}, queueLen=${this.queue.length}, ` +
          `session=${firstSid}, lastMsgId=${lastMid}`,
      );
    } catch {
      // log 本身不抛错
    }
    // lazy 启动 consumer loop（首次；loopStarted flag 守卫 = 单 worker 保证）
    if (!this.loopStarted) {
      this.loopStarted = true;
      void this._consumerLoop().catch(() => {
        // 异常吞：loop 顶层不应抛，但兜底防 promise 未处理告警；失败由 reconcile 兜底
      });
    }
  }

  /**
   * 单 worker async consumer loop（spec §4 invariant 1：单 worker 保序）。
   * - queue 空 → await sleep(IDLE_WAIT_MS) 轮询（unref timer）
   * - queue 非空 → splice(0, BATCH_SIZE) → _flushBatch + await sleep(BATCH_INTERVAL_MS)
   * - 单批失败 try/catch 吞（reconcile 兜底；继续下一批不堆积死锁）
   * - while(true) 永久运行（进程 lifetime）
   *
   * 核心：每批后 MUST await sleep 让出 event loop，MUST NOT 退回同步 while 排空。
   */
  private async _consumerLoop(): Promise<void> {
    while (true) {
      if (this.queue.length === 0) {
        await sleep(IDLE_WAIT_MS);
        continue;
      }
      const batch = this.queue.splice(0, BATCH_SIZE);
      try {
        this._flushBatch(batch);
      } catch {
        // 单批失败吞（reconcile 兜底），继续下一批避免堆积死锁
      }
      await sleep(BATCH_INTERVAL_MS); // 核心：批间 yield + 节流
    }
  }

  /**
   * 等待队列排空（UT 用）。生产路径不调（fire-and-forget）。
   * 实现 = bounded poll queue 空即可（不直接调 _flushBatch，保单 worker invariant）。
   * deadline 防 UT 永久 hang；queue 空立即 return（idle test 不误 hang）。
   */
  async flush(): Promise<void> {
    const deadline = Date.now() + FLUSH_DEADLINE_MS;
    while (this.queue.length > 0 && Date.now() < deadline) {
      await sleep(FLUSH_POLL_MS);
    }
  }

  /**
   * 批量写：BATCH_SIZE 条 chunks（triggers 自动插 fts），单事务原子。
   * 更新 idx_meta.last_ulid = 本批最大 ts（reconcile 水位）。
   * 单事务保证：全成或全败（不会半批入库导致 last_ulid 推进但 chunks 缺失）。
   *
   * 调用契约：仅 _consumerLoop（运行时）与 reconcile() 包装（启动期，委托
   * history-indexer-reconcile.ts）调用，保 spec §4 invariant 1 单 worker。
   * BATCH_SIZE=32 / BEGIN-COMMIT 单事务 / last_ulid 更新 均不可改（spec §4 invariant 2+4）。
   */
  private _flushBatch(batch: IndexPayload[]): void {
    if (batch.length === 0) return;
    this.driver.exec('BEGIN');
    try {
      const stmt = this.driver.prepare(
        'INSERT INTO chunks (message_id, session_id, role, ts, text) VALUES (?, ?, ?, ?, ?)',
      );
      for (const p of batch) stmt.run(p.messageId, p.sessionId, p.role, p.ts, p.text);
      // last_ulid = 本批最大 ts（ULID 字典序 = 时间序）
      const maxTs = batch.reduce((m, p) => (p.ts > m ? p.ts : m), batch[0]!.ts);
      this._setMeta(META_LAST_ULID, maxTs);
      this.driver.exec('COMMIT');
      // [history_search] 临时验证 log：批次落库情况 + 水位推进
      try {
        console.log(
          `[history_search] indexer flushed: batch=${batch.length}, last_ulid=${maxTs}, ` +
            `driver=${this.driver.constructor?.name ?? '?'}`,
        );
      } catch {
        // log 本身不抛错
      }
    } catch (e) {
      this.driver.exec('ROLLBACK');
      throw e;
    }
  }

  /** UPSERT idx_meta(k, v) */
  private _setMeta(k: string, v: string): void {
    this.driver
      .prepare('INSERT INTO idx_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(k, v);
  }

  /** 读 idx_meta（无 key 返回 undefined） */
  private _getMeta(k: string): string | undefined {
    const rows = this.driver.prepare('SELECT v FROM idx_meta WHERE k = ?').all<{ v: string }>(k);
    return rows[0]?.v;
  }

  /**
   * 启动兜底：扫 jsonl 补索（委托 history-indexer-reconcile.ts，独立于 consumer loop）。
   * @returns { scanned, indexed } 扫描行数 + 实际入库条数
   */
  async reconcile(): Promise<{ scanned: number; indexed: number }> {
    return reconcileTranscripts({
      dataRoot: this.dataRoot,
      lastUlid: this._getMeta(META_LAST_ULID) ?? '',
      flushBatch: (b) => this._flushBatch(b),
    });
  }

  /**
   * 清库 + 全扫 jsonl 重建。用于 schema 升级 / 首次启用历史回填。
   * 进度写 idx_meta（last_ulid）。
   * @returns { total, indexed } 扫描行数 + 入库条数（应一致）
   */
  async rebuild(): Promise<{ total: number; indexed: number }> {
    this.driver.exec('DELETE FROM chunks'); // triggers 级联删 fts 行
    this.driver.exec("DELETE FROM idx_meta WHERE k = 'last_ulid'");
    const res = await this.reconcile(); // lastUlid 已清 = 全扫
    return { total: res.scanned, indexed: res.indexed };
  }

  /**
   * session 级联删：DELETE FROM chunks WHERE session_id=?
   * FTS external-content triggers 自动级联删 fts 索引行。Idempotent。
   * @returns 删除的 chunks 行数（0 = 无此 session 数据或已删）
   */
  async deleteBySession(sessionId: string): Promise<number> {
    // 先 COUNT 再 DELETE：因 triggers 会让 run().changes 含 fts 级联行数（不准）
    const before =
      this.driver
        .prepare('SELECT COUNT(*) AS c FROM chunks WHERE session_id = ?')
        .all<{ c: number }>(sessionId)[0]?.c ?? 0;
    // [history_search] 临时验证 log：session 级联删
    try {
      console.log(
        `[history_search] deleteBySession: sid=${sessionId}, willDelete=${before}, ` +
          `driver=${this.driver.constructor?.name ?? '?'}`,
      );
    } catch {
      // log 本身不抛错
    }
    if (before === 0) return 0;
    this.driver.prepare('DELETE FROM chunks WHERE session_id = ?').run(sessionId);
    return before;
  }

  /**
   * 返回索引状态。库未初始化不抛错，返 count=0。
   * @returns count=chunks 行数；last_ulid=水位；driver=类名；sizeBytes=0（一期不统计）
   */
  stats(): { count: number; last_ulid: string | null; driver: string; sizeBytes: number } {
    let count = 0;
    let lastUlid: string | null = null;
    try {
      count = this.driver.prepare('SELECT COUNT(*) AS c FROM chunks').all<{ c: number }>()[0]?.c ?? 0;
      lastUlid = this._getMeta(META_LAST_ULID) ?? null;
    } catch {
      count = 0;
      lastUlid = null;
    }
    return { count, last_ulid: lastUlid, driver: this.driver.constructor?.name ?? 'unknown', sizeBytes: 0 };
  }
}
