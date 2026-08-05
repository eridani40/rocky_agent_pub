/**
 * squad budget baseline-delta wiring — squadRuntime + budgetAggregator 装配桥。
 * 参考: specs/tech/squad/[P1]scheduler.md §5（budget 横向聚合 baseline-delta 算法）
 *       app/server/src/bootstrap.ts（v0.0.33.4 T3 装配顺序：budgetState → getUsageTotalTokens → budgetAggregator）
 *
 * 从 squad-runtime.ts 拆出（v0.0.58 T2，文件 ≤300 行硬约束）。
 *
 * 流程：sessionStore.getUsageView(sid).total.total_tokens（单调全时 total）→
 *   budgetState.getConsumed(squadId, sid, windowStartISO, total)（窗口翻转/首次见 baseline
 *   重置，详见 budget-state.ts）。standalone session（无 squadId）→ 直接返全时 total。
 */
import type { SessionStore } from '../agent/session-store';
import { BudgetState } from './budget-state';

/**
 * 创建 budget-aggregator 的 getUsageTotalTokens 实现（baseline-delta 算法 wiring）。
 * 在 bootstrap 装配时于 budgetAggregator 构造前调用（避免 SquadRuntime ↔ BudgetAggregator 循环引用）。
 */
export function makeGetUsageTotalTokens(
  sessionStore: SessionStore,
  budgetState: BudgetState,
): (sessionId: string, windowStart: Date) => Promise<number> {
  return async (sessionId, windowStart) => {
    const view = await sessionStore.getUsageView(sessionId);
    // noUncheckedIndexedAccess: total.total_tokens 是 number | undefined，?? 0 兜底
    const currentTotal = view.total?.total_tokens ?? 0;
    const session = await sessionStore.getSession(sessionId);
    const squadId = session?.squadId;
    if (!squadId) return currentTotal;
    return budgetState.getConsumed(
      squadId,
      sessionId,
      windowStart.toISOString(),
      currentTotal,
    );
  };
}
