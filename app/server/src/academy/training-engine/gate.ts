/**
 * training-engine/gate — acceptGate + checkEarlyStop 纯函数
 * 参考: specs/tech/academy/[P0]training_engine.md §4（acceptGate 纯函数 hill-climbing gate）
 *       refs/skillopt（hill-climbing + early-stop 蓝本）
 *
 * 核心约束（spec §4）：
 *   - 纯函数（无 IO / 无 LLM / 无副作用）
 *   - 单测覆盖 improve / regress / equal 三分支 + early-stop 连续 N 轮无提升
 *
 * 决策（hill-climbing）：
 *   - candidateAvg > baselineAvg → 'improve'（替换临时基线）
 *   - candidateAvg < baselineAvg → 'regress'（保留原临时基线）
 *   - 相等 → 'equal'（保留原临时基线；可扩展为"持平接受"策略）
 *
 * 早停策略（skillopt 蓝本 + spec §4）：
 *   - 连续 `minNoImproveRounds`（默认 3） 轮 decision ∈ {regress, equal} → 触发早停
 *   - 检测窗口：turns 按 round asc 排序后取最后 N 轮
 */

/** acceptGate 入参（candidate vs baseline 平均分） */
export interface GateInput {
  candidateAvg: number;
  baselineAvg: number;
}

/** acceptGate 出参：'improve'（接受候选）/ 'regress'（拒）/ 'equal'（持平） */
export type GateDecision = 'improve' | 'regress' | 'equal';

/**
 * 纯函数 hill-climbing gate。candidate 严格 > baseline 才判 'improve'；
 * 相等保守起见判 'equal'（不替换基线）。
 */
export function acceptGate(input: GateInput): GateDecision {
  if (input.candidateAvg > input.baselineAvg) return 'improve';
  if (input.candidateAvg < input.baselineAvg) return 'regress';
  return 'equal';
}

/** reviseBaselineAvg 入参的 task 最小形状（避免耦合完整 TrainingTaskEntity） */
export interface BaselineTask {
  baseVersionId: string;
  temporaryBaselineVersionId?: string;
}

/** reviseBaselineAvg 入参的 turn 最小形状 */
export interface BaselineTurn {
  candidateVersionId: string;
  decision?: GateDecision;
  avgScore?: number;
}

/**
 * 解析 revise 的 baseline avgScore。
 *
 * 语义：baseline = 当前临时基线版本被采纳时的历史 avgScore。
 *   - task.temporaryBaselineVersionId === task.baseVersionId（或缺失）→ 从未采纳过过程版 → 返 undefined
 *     （首次候选 revise 直接采纳 decision='improve' 不比，避免「0 vs candidate」恒 improve 的假迭代）
 *   - 否则 → 返最近一次 candidateVersionId === temporaryBaselineVersionId 且 decision='improve'
 *     的 turn.avgScore（即当前 baseline 被采纳为临时基线时的分数）
 *
 * 返回 undefined 时 caller（reviseCandidate）走「首次采纳」分支直接判 improve；否则用 acceptGate 比。
 */
export function reviseBaselineAvg(
  task: BaselineTask,
  turns: BaselineTurn[],
): number | undefined {
  if (!task.temporaryBaselineVersionId) return undefined;
  if (task.temporaryBaselineVersionId === task.baseVersionId) return undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (
      t.candidateVersionId === task.temporaryBaselineVersionId
      && t.decision === 'improve'
      && t.avgScore !== undefined
    ) {
      return t.avgScore;
    }
  }
  return undefined;
}

/** 早停检查的最小轮对象（避免耦合 TrainingTurnEntity） */
export interface EarlyStopTurn {
  round: number;
  decision?: 'improve' | 'regress' | 'equal';
}

/**
 * 早停检查：连续 `minNoImproveRounds` 轮（默认 3）无 improve → true。
 *
 * 输入 turns 可乱序；内部按 round asc 排序后取最后 N 轮判定。
 * turns < N 时直接 false（轮数不够不触发）。
 */
export function checkEarlyStop(
  turns: EarlyStopTurn[],
  minNoImproveRounds = 3,
): boolean {
  if (turns.length < minNoImproveRounds) return false;
  const sorted = [...turns].sort((a, b) => a.round - b.round);
  const lastN = sorted.slice(-minNoImproveRounds);
  return lastN.every((t) => t.decision !== 'improve');
}
