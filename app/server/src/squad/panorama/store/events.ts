/**
 * Panorama 事件流 — events.jsonl append-only 读/写/订阅.
 * 参考: specs/tech/squad/[P1]panorama_store.md §7（events.jsonl 格式）
 *
 * 每行一个事件：{seq, ts, type, entity, id?, summary?, payload, source?, messageId?}.
 * seq 单调递增（per-squad panorama/ 内）.
 */
import { join } from 'node:path';
import * as fs from 'node:fs';
import { atomicWriteSync, readJsonFileSync, ensureDirSync } from '../../../persistence/fs-io';

// ── 事件类型 ────────────────────────────────────────────────

export type PanoramaEventType =
  | 'board.defined'
  | 'entity.created'
  | 'entity.updated'
  | 'entity.transition'
  | 'entity.deleted'
  | 'migration.executed';

export type EventSource = 'user' | 'agent' | 'system' | 'drag' | 'api';

export interface PanoramaEvent {
  seq: number;
  ts: string;
  type: PanoramaEventType | string;
  entity: string;
  id?: string;
  summary?: string;
  payload: Record<string, unknown>;
  source?: EventSource;
  messageId?: string | null;
}

export type EventSubscriber = (event: PanoramaEvent) => void;

export interface EventStoreOpts {
  panoramaDir: string;
  now?: () => string;
}

/**
 * events.jsonl 读写器.
 * - append：追加一行（seq 自动递增）.
 * - allocateSeq：预分配 seq（不写文件），供 migration 备份命名 + 后续 appendWithSeq.
 * - read：从 since 之后读事件，返回最新的 limit 条.
 * - subscribe：进程内订阅（SSE 推送用）.
 */
export class EventStore {
  private readonly eventsFile: string;
  private readonly seqFile: string;
  private readonly panoramaDir: string;
  private readonly now: () => string;
  private readonly subscribers = new Set<EventSubscriber>();

  constructor(opts: EventStoreOpts) {
    this.panoramaDir = opts.panoramaDir;
    this.eventsFile = join(opts.panoramaDir, 'events.jsonl');
    this.seqFile = join(opts.panoramaDir, '.state', 'event-seq.json');
    this.now = opts.now ?? (() => new Date().toISOString());
    ensureDirSync(opts.panoramaDir);
  }

  /** 追加一条事件（seq 自动递增） */
  append(event: Omit<PanoramaEvent, 'seq' | 'ts'> & Partial<Pick<PanoramaEvent, 'ts'>>): PanoramaEvent {
    return this.writeEvent(this.allocateSeq(), event);
  }

  /** 预分配一个 seq（不写 events.jsonl），供 migration 用 */
  allocateSeq(): number {
    const cur = readJsonFileSync<{ seq: number }>(this.seqFile);
    const seq = (cur?.seq ?? 0) + 1;
    ensureDirSync(join(this.panoramaDir, '.state'));
    atomicWriteSync(this.seqFile, JSON.stringify({ seq }));
    return seq;
  }

  /** 用预分配的 seq 写事件（与 allocateSeq 配对） */
  appendWithSeq(seq: number, event: Omit<PanoramaEvent, 'seq' | 'ts'> & Partial<Pick<PanoramaEvent, 'ts'>>): PanoramaEvent {
    return this.writeEvent(seq, event);
  }

  /** 读取事件流：从 since 之后读事件，返回最新的 limit 条 */
  read(since = 0, limit = 100): PanoramaEvent[] {
    return this.readAll()
      .filter(e => e.seq > since)
      .slice(-limit);
  }

  /** 读取全部事件 */
  readAll(): PanoramaEvent[] {
    return this.readAllLines()
      .map(line => safeParse(line))
      .filter((e): e is PanoramaEvent => e !== null);
  }

  /** 订阅事件流（进程内） */
  subscribe(fn: EventSubscriber): () => void {
    this.subscribers.add(fn);
    return () => { this.subscribers.delete(fn); };
  }

  // ── 内部 ──────────────────────────────────────────────────

  private writeEvent(seq: number, event: Omit<PanoramaEvent, 'seq' | 'ts'> & Partial<Pick<PanoramaEvent, 'ts'>>): PanoramaEvent {
    const full: PanoramaEvent = { seq, ts: event.ts ?? this.now(), ...event };
    fs.appendFileSync(this.eventsFile, JSON.stringify(full) + '\n', 'utf8');
    this.notify(full);
    return full;
  }

  private readAllLines(): string[] {
    try {
      const raw = fs.readFileSync(this.eventsFile, 'utf8');
      return raw.split('\n').filter(l => l.trim().length > 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  private notify(event: PanoramaEvent): void {
    for (const fn of this.subscribers) {
      try { fn(event); } catch { /* 订阅者错误不阻塞 */ }
    }
  }
}

function safeParse(line: string): PanoramaEvent | null {
  try {
    return JSON.parse(line) as PanoramaEvent;
  } catch {
    return null;
  }
}
