/**
 * fs-yield — 进程级 fs I/O event loop 让出闸门（singleton library）
 * 参考: specs/tech/version_logs/v0.0.291/change_plan.md
 *
 * 解决问题：team.reset 等批量操作连续 sync fs I/O 阻塞 event loop → UI 彩虹圈。
 * acquireFsSlot 统计 opCount + accumulatedNs，达阈值让出一次 tick。
 * 模块级 singleton（进程内所有 async fs I/O 共享）。
 */

/** 次数阈值：每 50 次 fs 操作让出一次 */
export const THRESHOLD_OP = 50;
/** 时间阈值：累计 8ms 真实耗时让出一次（兜底大操作） */
export const THRESHOLD_NS = 8_000_000n;

// 模块级 singleton 状态（进程内单实例）
let opCount = 0;
let accumulatedNs = 0n;

/**
 * 获取一个 fs 操作槽位。每次 fs 操作前 await 本函数。
 * 未达阈值：仅 opCount++ + 一次比较（纳秒级零开销）。
 * 达阈值（次数≥50 OR 累计≥8ms）：await setImmediate 让出 tick → 归零。
 */
export async function acquireFsSlot(): Promise<void> {
  opCount++;
  if (opCount >= THRESHOLD_OP || accumulatedNs >= THRESHOLD_NS) {
    try {
      await new Promise<void>((r) => setImmediate(r));
    } catch {
      // 让出失败静默，不影响 fs 操作
    }
    opCount = 0;
    accumulatedNs = 0n;
  }
}

/** 累计单次 fs 操作耗时到 singleton accumulatedNs（入参为 hrtime 差值 BigInt） */
export function trackFsTime(ns: bigint): void {
  accumulatedNs += ns;
}

/** 重置 singleton 状态（UT 隔离用） */
export function resetFsYield(): void {
  opCount = 0;
  accumulatedNs = 0n;
}
