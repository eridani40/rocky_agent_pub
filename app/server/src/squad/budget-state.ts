/**
 * BudgetState — budget daily-window baseline-delta 持久化（按 squadId 分片）。
 * 参考: states/v0.0.33.4/task.json T3（budget baseline-delta 接线）
 *       specs/tech/squad/[P1]scheduler.md §5（daily 窗口按 squad.timezone 当日 0 点）
 *
 * 设计：
 *   - 落 .rocky/state/budget-state.json（与 scheduler.json/history.jsonl 同目录；
 *     squad-store ensureSquadDirSkeleton 已预建 .rocky/state/，零新 mkdir）
 *   - 文件形态：{ windowStart: "<ISO>", baselines: { [sessionId]: <全时 total @ window start> } }
 *   - 窗口翻转（windowStart 变化=跨 squad tz 0 点）→ 重置 baselines 为当前各 session 全时 total
 *   - consumedSinceWindowStart = 全时 total − baseline(sessionId)
 *
 * 为什么 per-session baseline（非 per-squad 单值）：budget-aggregator 横向 Σ 时按 session
 *   调 getUsageTotalTokens(sid, windowStart)，需返 per-session consumed delta；sum 即 team
 *   consumed。per-squad 单值 baseline 无法分解回 per-session delta（Σ 不闭合）。
 *
 * 可靠性：session.usage meta 是主计数器（每 run 累加），全时 total 单调；比 run.usage
 *   时间戳聚合可靠（run schema 是 run 级快照，崩溃恢复有边界）。
 */
import { join } from 'node:path';
import { atomicWriteSync, readJsonFileSync } from '../persistence/fs-io';

/** budget-state.json 文件形态（per-squad 一个文件） */
export interface BudgetStateFile {
  /** 当窗口左界 ISO（squad.timezone 当日 0 点的 UTC 瞬时；caller 用 startOfDayInTz 算） */
  windowStart: string;
  /** per-session baseline：windowStart 时刻各 session 的全时 total_tokens */
  baselines: Record<string, number>;
}

/**
 * BudgetState — squad 级 budget daily-window baseline-delta 持久化。
 * 每 squad 一个 budget-state.json（多 squad 隔离，与 scheduler.json 同分片策略）。
 *
 * 同步 API（与 SchedulerStateStore / fs-io 风格一致；单进程顺序保证无并发）。
 */
export class BudgetState {
  constructor(private readonly root: string) {}

  /** budget-state.json 路径：{root}/squads/{squadId}/.rocky/state/budget-state.json */
  filePath(squadId: string): string {
    return join(this.root, 'squads', squadId, '.rocky', 'state', 'budget-state.json');
  }

  /** 读单 squad 全量 state；文件不存在返 undefined（caller 降级为 cold-start） */
  readAll(squadId: string): BudgetStateFile | undefined {
    return readJsonFileSync<BudgetStateFile>(this.filePath(squadId));
  }

  /**
   * 计算 session 在指定 windowStart 窗口内的 consumed delta（baseline-delta 算法）。
   *
   * 三种情形：
   *   1. 窗口翻转（file.windowStart !== windowStart）：重置 baselines = { sid: currentTotal }，
   *      consumed = 0（窗口刚翻，session 从 0 开始累计）
   *   2. 窗口内首次见此 session（baselines[sid] === undefined）：补 baseline = currentTotal，
   *      consumed = 0（窗口已开但本 session 首次被查，记当前为起点）
   *   3. 窗口内已知 session：consumed = currentTotal − baseline
   *
   * 副作用：read-modify-write 全量 + 原子写 budget-state.json。
   *
   * @param squadId       squad id（文件分片键）
   * @param sessionId     session id（baseline 寻址键）
   * @param windowStart   当窗口左界 ISO 字符串（caller 用 startOfDayInTz(now, tz).toISOString()）
   * @param currentTotal  session 当前全时 total_tokens（caller 从 sessionStore.getUsageView 取）
   * @returns 当窗口内 consumed delta（>=0；currentTotal 单调故理论非负，Math.max 兜底）
   */
  getConsumed(
    squadId: string,
    sessionId: string,
    windowStart: string,
    currentTotal: number,
  ): number {
    const existing = this.readAll(squadId) ?? { windowStart, baselines: {} };
    let consumed: number;
    if (existing.windowStart !== windowStart) {
      // 窗口翻转：重置 baselines，仅记本 session 当前 total（其他 session 后续 query 时补）
      existing.windowStart = windowStart;
      existing.baselines = { [sessionId]: currentTotal };
      consumed = 0;
    } else if (!(sessionId in existing.baselines)) {
      // 窗口内首次见此 session：补 baseline = 当前 total（consumed=0）
      existing.baselines[sessionId] = currentTotal;
      consumed = 0;
    } else {
      // 已知 session：delta
      const baseline = existing.baselines[sessionId] ?? currentTotal;
      consumed = Math.max(0, currentTotal - baseline);
    }
    atomicWriteSync(this.filePath(squadId), JSON.stringify(existing, null, 2));
    return consumed;
  }
}
