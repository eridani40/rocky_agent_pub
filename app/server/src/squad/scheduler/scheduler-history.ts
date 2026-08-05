/**
 * SchedulerHistory — 自动工作历史 ring buffer + history.jsonl append。
 * 参考: specs/tech/squad/[P1]scheduler.md §8（自动工作历史）
 *
 * 形态：每条 {roleId, at, reason:"heartbeat", result, actionSummary?}
 *   - 内存 ring buffer（最近 N=100 条），重启后内存为空 → 读 jsonl 兜底
 *   - append history.jsonl（重启不丢；best-effort，落盘失败不阻塞 scheduler）
 *   - getHistory(squadId, limit, roleId?) 倒序（最新在前），scheduler-handler 调用
 *   - 存量 jsonl 里历史 file-changed 条目（功能已删）读盘时过滤，不再展示
 *
 * 路径：{root}/squads/{squadId}/.rocky/state/history.jsonl
 *   （与 scheduler.json 同目录，spec §7/§8 共用 .rocky/state/）
 *
 * 多 squad 隔离：buffers Map<squadId, ...> + filePath 按 squadId 分片。
 */
import { join } from 'node:path';
import { appendFileSync, readFileSync } from 'node:fs';
import { ensureDirSync } from '../../persistence/fs-io';

/** ring buffer 容量（spec §8：最近 N=100 条） */
const RING_BUFFER_SIZE = 100;

/**
 * 历史条目（spec §8）。
 * actionSummary 由 role run 结束后回填（best-effort，本模块只存储不主动填）。
 */
export interface HistoryEntry {
  /** 触发该条目的 role（memberId） */
  roleId: string;
  /** 触发时刻 ISO（UTC 瞬时） */
  at: string;
  /** 触发原因（心跳到点） */
  reason: 'heartbeat';
  /** gate 结果（fired | skipped_*） */
  result: string;
  /** role run 结束后回填的行动摘要（best-effort，可选） */
  actionSummary?: string;
}

/**
 * SchedulerHistory — 内存 ring buffer + 落盘 history.jsonl 双写。
 * scheduler.tick 触发时 append。
 */
export class SchedulerHistory {
  /** squadId → ring buffer（最新在尾；getHistory 时倒序） */
  private buffers = new Map<string, HistoryEntry[]>();

  constructor(private readonly root: string) {}

  /** history.jsonl 路径：{root}/squads/{squadId}/.rocky/state/history.jsonl */
  filePath(squadId: string): string {
    return join(this.root, 'squads', squadId, '.rocky', 'state', 'history.jsonl');
  }

  /**
   * 追加一条历史：内存 ring buffer + append jsonl（双写）。
   * 落盘失败不阻塞 scheduler（spec §8 best-effort）。
   */
  append(squadId: string, entry: HistoryEntry): void {
    // 内存 ring buffer（容量 100，FIFO 淘汰最旧）
    let buf = this.buffers.get(squadId);
    if (!buf) {
      buf = [];
      this.buffers.set(squadId, buf);
    }
    buf.push(entry);
    if (buf.length > RING_BUFFER_SIZE) {
      buf.splice(0, buf.length - RING_BUFFER_SIZE);
    }
    // append jsonl（best-effort，失败不阻塞 tick）
    try {
      ensureDirSync(join(this.root, 'squads', squadId, '.rocky', 'state'));
      appendFileSync(this.filePath(squadId), `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // 落盘失败忽略（spec §8 best-effort，内存仍有该条）
    }
  }

  /**
   * 读历史：limit 缺省=50，倒序（最新在前），可选 roleId 过滤。
   * 内存 ring buffer 命中即返；内存空（重启场景）→ 读 jsonl 兜底。
   */
  getHistory(squadId: string, limit: number = 50, roleId?: string): HistoryEntry[] {
    const buf = this.buffers.get(squadId) ?? [];
    if (buf.length > 0) {
      const filtered = roleId ? buf.filter(e => e.roleId === roleId) : buf.slice();
      filtered.reverse();   // 最新在前
      return filtered.slice(0, limit);
    }
    // 内存空 → 读 jsonl（重启后场景；best-effort，读失败返空）
    try {
      const raw = readFileSync(this.filePath(squadId), 'utf8');
      const lines = raw.split('\n').filter(l => l.length > 0);
      const entries: HistoryEntry[] = lines
        .map(l => JSON.parse(l) as HistoryEntry)
        // 存量数据兼容：历史 file-changed 条目（功能已删）读盘时丢弃
        .filter(e => e.reason === 'heartbeat');
      const filtered = roleId ? entries.filter(e => e.roleId === roleId) : entries;
      filtered.reverse();   // jsonl 是 append 顺序（旧→新），倒序后最新在前
      return filtered.slice(0, limit);
    } catch {
      return [];
    }
  }
}
