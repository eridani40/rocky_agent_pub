/**
 * HistoryIndexer 启动兜底扫描（reconcile）— 与运行时 consumer loop 解耦的独立模块。
 * 参考: specs/tech/persistence/[P1]search_engine.md §5（兜底机制）
 *
 * 职责：读 idx_meta.last_ulid → 扫 dataRoot 下各 session 的 transcript .jsonl →
 *   补索 id > last_ulid 的 user/assistant 记录（走 flushBatch 回调保证原子 + 水位推进）。
 * 文本来源 = 落盘 jsonl（非内存 messages；spec §5 不变量）。
 * 只在启动期同步执行一次（bootstrap fire-and-forget），不走运行时 consumer loop。
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { extractPlainText } from './search-text-util';
import type { IndexPayload } from './history-indexer';

/** 补索批大小（与生产 BATCH_SIZE 对齐） */
const RECONCILE_BATCH_SIZE = 32;

/**
 * 扫 jsonl 补索。依赖通过参数注入（driver/idx_meta 访问封装在 HistoryIndexer 内，
 * 此处只接收 dataRoot + lastUlid + flushBatch 回调），不暴露 HistoryIndexer 私有成员。
 * @returns { scanned, indexed } 扫描行数 + 实际入库条数
 */
export function reconcileTranscripts(opts: {
  dataRoot: string | null;
  lastUlid: string;
  flushBatch: (batch: IndexPayload[]) => void;
}): { scanned: number; indexed: number } {
  const { dataRoot, lastUlid, flushBatch } = opts;
  if (!dataRoot) return { scanned: 0, indexed: 0 };
  const sessionsDir = path.join(dataRoot, 'sessions');

  let sessionIds: string[] = [];
  try {
    sessionIds = fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { scanned: 0, indexed: 0 };
    throw e;
  }

  // session 维度并行收集 payloads
  const allBatches: IndexPayload[][] = [];
  let scanned = 0;
  for (const sid of sessionIds) {
    const res = scanSessionTranscripts(sessionsDir, sid, lastUlid);
    scanned += res.scanned;
    if (res.records.length > 0) allBatches.push(res.records);
  }

  // 批量入库（走 flushBatch 回调保证原子 + last_ulid 更新）
  let indexed = 0;
  for (const batch of allBatches) {
    for (let i = 0; i < batch.length; i += RECONCILE_BATCH_SIZE) {
      const slice = batch.slice(i, i + RECONCILE_BATCH_SIZE);
      try {
        flushBatch(slice);
        indexed += slice.length;
      } catch {
        // 批失败吞，下一批继续
      }
    }
  }
  try {
    console.log(
      `[history_search] reconcile done: start_last_ulid=${lastUlid || '(empty)'}, ` +
        `scanned_sessions=${sessionIds.length}, scanned_rows=${scanned}, indexed=${indexed}`,
    );
  } catch {
    // log 本身不抛错
  }
  return { scanned, indexed };
}

/** 扫单个 session 的 transcript 目录，过滤 id > lastUlid 的 record。 */
function scanSessionTranscripts(
  sessionsDir: string,
  sessionId: string,
  lastUlid: string,
): { scanned: number; records: IndexPayload[] } {
  const transcriptDir = path.join(sessionsDir, sessionId, 'transcript');
  let files: string[];
  try {
    files = fs.readdirSync(transcriptDir).filter((f) => f.endsWith('.jsonl'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { scanned: 0, records: [] };
    throw e;
  }
  const records: IndexPayload[] = [];
  let scanned = 0;
  for (const f of files) {
    const raw = fs.readFileSync(path.join(transcriptDir, f), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue; // 跳过坏行
      }
      scanned++;
      const id = rec.id;
      if (typeof id !== 'string' || id <= lastUlid) continue;
      const role = rec.role;
      if (role !== 'user' && role !== 'assistant') continue; // system/tool 跳过
      records.push({
        messageId: id,
        sessionId,
        role,
        ts: id,
        text: extractPlainText(rec.content),
      });
    }
  }
  return { scanned, records };
}
