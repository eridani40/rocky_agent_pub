/**
 * scheduler.json 持久化 — lastFiredAt/lastResult 落盘（按 squadId 分片）。
 * 参考: specs/tech/squad/[P1]scheduler.md §7（持久化 state）
 *       specs/tech/scheduling/[P1]heartbeat_handler.md §3（v2 schema + 清理方案）
 *
 * 落盘路径：{root}/squads/{squadId}/.rocky/state/scheduler.json
 *   （squad-store.ts ensureSquadDirSkeleton 已预建 .rocky/state 目录，零新 mkdir）
 *
 * [v0.0.116] schema v2 — squad 级平铺（去 roles 分桶）：
 * {
 *   "version": 2,
 *   "lastFiredAt": "<ISO> | null",
 *   "lastResult": "fired|skipped_*"
 * }
 *
 * v1→v2 清理方案（非运行时破坏性迁移）：
 *   - readSquad：见 v2 平铺直接用；见 v1 旧 roles{} 结构 → 忽略，返 null lastFiredAt（从当前重排）
 *   - writeSquad：首次 fire 落盘即写 v2，自然覆盖旧文件（旧 roles entries 随之消失=保存时收敛）
 *   - 不做启动期扫库清 member entries（runtime 启动路径绝不破坏性清理，memory runtime-no-ext-policy-write）
 *
 * 设计：
 *   - 仅 lastFiredAt 参与决策（排下次到点）；history 另存（不进此文件，防膨胀）
 *   - 每 fire/skip 立即落盘（防重启丢 lastFiredAt）—— 原子写
 *   - 同步 API（单进程顺序保证无并发）
 */
import { join } from 'node:path';
import { atomicWriteSync, readJsonFileSync } from '../../persistence/fs-io';

/**
 * scheduler.json lastResult 值域（与 TickResultKind 对齐，spec §7）。
 */
export type SchedulerLastResult =
  | 'fired'
  | 'skipped_window'
  | 'skipped_budget'
  | 'skipped_busy'
  | 'skipped_killswitch';

/** [v0.0.116] scheduler.json v2 squad 级平铺形态（单条，去 roles 分桶） */
export interface SchedulerStateFileV2 {
  version: 2;
  lastFiredAt: string | null;
  lastResult: SchedulerLastResult;
}

/** v1 旧形态（读时识别忽略，存时收敛消失） */
interface SchedulerStateFileV1 {
  version: number;
  roles: Record<string, { lastFiredAt: string | null; lastResult: SchedulerLastResult }>;
}

/** squad 级持久化条目（readSquad 返回） */
export interface SquadStateEntry {
  /** 最近一次 fire 的 ISO 时刻；null=从未触发 */
  lastFiredAt: string | null;
  /** 最近一次 gate 结果（fired | skipped_*） */
  lastResult: SchedulerLastResult;
}

/**
 * SchedulerStateStore — squad 级 scheduler.json 读写（按 squadId 分片）。
 * 每 squad 一个 scheduler.json 文件（多 squad 独立隔离）。
 */
export class SchedulerStateStore {
  constructor(private readonly root: string) {}

  /** scheduler.json 路径：{root}/squads/{squadId}/.rocky/state/scheduler.json */
  filePath(squadId: string): string {
    return join(this.root, 'squads', squadId, '.rocky', 'state', 'scheduler.json');
  }

  /**
   * 读 squad 级状态（v2 平铺）。
   * - 见 v2 platform lastFiredAt：直接返回。
   * - 见 v1 旧 roles{}：忽略返 {lastFiredAt:null}（心跳从当前重排，最多漏一次）。
   * - 文件不存在：返 undefined。
   */
  readSquad(squadId: string): SquadStateEntry | undefined {
    const raw = readJsonFileSync<SchedulerStateFileV2 | SchedulerStateFileV1>(this.filePath(squadId));
    if (!raw) return undefined;
    // v2：有 lastFiredAt 直接平铺（version 字段值忽略，按结构判）
    if ('lastFiredAt' in raw && !('roles' in raw)) {
      const v2 = raw as SchedulerStateFileV2;
      return { lastFiredAt: v2.lastFiredAt, lastResult: v2.lastResult };
    }
    // v1：有 roles{} 结构 → 忽略旧 per-member 分桶，返 null lastFiredAt（开放点3：不 migrate）
    return { lastFiredAt: null, lastResult: 'skipped_killswitch' };
  }

  /**
   * 写 squad 级状态（v2 平铺原子写）。
   * 首次写即覆盖旧文件为 v2（旧 roles entries 随之消失=保存时收敛，非运行时主动删）。
   */
  writeSquad(squadId: string, entry: SquadStateEntry): void {
    const v2: SchedulerStateFileV2 = {
      version: 2,
      lastFiredAt: entry.lastFiredAt,
      lastResult: entry.lastResult,
    };
    atomicWriteSync(this.filePath(squadId), JSON.stringify(v2, null, 2));
  }
}
