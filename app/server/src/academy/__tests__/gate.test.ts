/**
 * gate.ts 纯函数单测（acceptGate + checkEarlyStop + reviseBaselineAvg）
 * 参考: specs/tech/academy/[P0]training_engine.md §4（纯函数 hill-climbing gate + reviseBaselineAvg）
 *
 * 覆盖：
 *   - acceptGate：improve / regress / equal 三分支
 *   - acceptGate：边界（严格 >，相等不判 improve）
 *   - checkEarlyStop：连续 3 轮 / 不足 3 轮 / 含 improve 不触发
 *   - reviseBaselineAvg：首次候选返 undefined / 历史命中返 avgScore / 无命中返 undefined
 */
import { describe, it, expect } from 'vitest';
import {
  acceptGate,
  checkEarlyStop,
  reviseBaselineAvg,
  type EarlyStopTurn,
  type BaselineTask,
  type BaselineTurn,
} from '../training-engine/gate';

describe('acceptGate — 纯函数 hill-climbing', () => {
  it('candidateAvg > baselineAvg → improve', () => {
    expect(acceptGate({ candidateAvg: 0.8, baselineAvg: 0.5 })).toBe('improve');
  });
  it('candidateAvg < baselineAvg → regress', () => {
    expect(acceptGate({ candidateAvg: 0.3, baselineAvg: 0.5 })).toBe('regress');
  });
  it('candidateAvg === baselineAvg → equal（严格 >，相等不 improve）', () => {
    expect(acceptGate({ candidateAvg: 0.5, baselineAvg: 0.5 })).toBe('equal');
  });
  it('边界：0.51 vs 0.50 → improve（小数差异也算）', () => {
    expect(acceptGate({ candidateAvg: 0.51, baselineAvg: 0.50 })).toBe('improve');
  });
  it('边界：0 vs 0 → equal', () => {
    expect(acceptGapZero()).toBe('equal');
  });
  it('边界：负分场景（rate_limited 兜底 score=-1 → avg 可能负）→ less → regress', () => {
    expect(acceptGate({ candidateAvg: -0.5, baselineAvg: 0 })).toBe('regress');
  });
});

function acceptGapZero(): 'improve' | 'regress' | 'equal' {
  return acceptGate({ candidateAvg: 0, baselineAvg: 0 });
}

describe('checkEarlyStop — 连续 N 轮无 improve', () => {
  it('连续 3 轮 regress/equal → 触发', () => {
    const turns: EarlyStopTurn[] = [
      { round: 1, decision: 'improve' },
      { round: 2, decision: 'regress' },
      { round: 3, decision: 'equal' },
      { round: 4, decision: 'regress' },
    ];
    expect(checkEarlyStop(turns)).toBe(true);
  });

  it('最近一轮是 improve → 不触发', () => {
    const turns: EarlyStopTurn[] = [
      { round: 1, decision: 'regress' },
      { round: 2, decision: 'equal' },
      { round: 3, decision: 'improve' },
    ];
    expect(checkEarlyStop(turns)).toBe(false);
  });

  it('轮数不足 3 → 不触发', () => {
    expect(checkEarlyStop([
      { round: 1, decision: 'regress' },
      { round: 2, decision: 'equal' },
    ])).toBe(false);
  });

  it('空列表 → 不触发', () => {
    expect(checkEarlyStop([])).toBe(false);
  });

  it('乱序输入也能稳定判定（内部按 round asc 排序）', () => {
    const turns: EarlyStopTurn[] = [
      { round: 4, decision: 'regress' },
      { round: 2, decision: 'equal' },
      { round: 3, decision: 'regress' },
      { round: 1, decision: 'improve' },
    ];
    expect(checkEarlyStop(turns)).toBe(true);
  });

  it('decision 缺失（undefined）视为非 improve → 触发', () => {
    const turns: EarlyStopTurn[] = [
      { round: 1 },
      { round: 2 },
      { round: 3 },
    ];
    expect(checkEarlyStop(turns)).toBe(true);
  });

  it('自定义 minNoImproveRounds=2', () => {
    const turns: EarlyStopTurn[] = [
      { round: 1, decision: 'regress' },
      { round: 2, decision: 'equal' },
    ];
    expect(checkEarlyStop(turns, 2)).toBe(true);
  });
});

describe('reviseBaselineAvg — revise 基线解析（v0.0.213 首次候选直接采纳语义）', () => {
  // scenario：base 正式版 id 固定，round1 候选（process）id 固定
  const baseId = '01BASE00000000000000000000';
  const round1CandidateId = '01CAND00000000000000000001';
  const round2CandidateId = '01CAND00000000000000000002';

  it('分支①：temporaryBaselineVersionId === baseVersionId（从未采纳过过程版）→ 返 undefined', () => {
    // 初始任务：temporaryBaseline 仍是 base formal，coach 第一次 revise 不应与 base 比
    const task: BaselineTask = {
      baseVersionId: baseId,
      temporaryBaselineVersionId: baseId, // === baseVersionId
    };
    const turns: BaselineTurn[] = [
      { candidateVersionId: round1CandidateId, decision: 'improve', avgScore: 0.8 },
    ];
    expect(reviseBaselineAvg(task, turns)).toBeUndefined();
  });

  it('分支①：temporaryBaselineVersionId 缺失 → 返 undefined（防御）', () => {
    const task: BaselineTask = { baseVersionId: baseId };
    expect(reviseBaselineAvg(task, [])).toBeUndefined();
  });

  it('分支②：有历史命中 → 返最近一次 candidateVersionId===temporaryBaseline 且 decision=improve 的 avgScore', () => {
    // round1 候选被采纳（improve），temporaryBaseline 现在指向 round1CandidateId；
    // round2 revise 时 baselineAvg 应取 round1 turn 的 avgScore
    const task: BaselineTask = {
      baseVersionId: baseId,
      temporaryBaselineVersionId: round1CandidateId,
    };
    const turns: BaselineTurn[] = [
      { candidateVersionId: round1CandidateId, decision: 'improve', avgScore: 0.72 },
    ];
    expect(reviseBaselineAvg(task, turns)).toBe(0.72);
  });

  it('分支②：多个候选历史 → 取最近的 improve 命中（倒序找到第一个）', () => {
    // 经过两轮：round1 候选A improve→成为baseline；round2 候选B regress→保留baseline=A。
    // round3 revise 时 baseline 仍是 A，baselineAvg 应取 round1 turn（A 被采纳）的 avgScore
    const task: BaselineTask = {
      baseVersionId: baseId,
      temporaryBaselineVersionId: round1CandidateId,
    };
    const turns: BaselineTurn[] = [
      { candidateVersionId: round1CandidateId, decision: 'improve', avgScore: 0.65 },
      { candidateVersionId: round2CandidateId, decision: 'regress', avgScore: 0.40 },
    ];
    expect(reviseBaselineAvg(task, turns)).toBe(0.65);
  });

  it('分支②：temporaryBaseline 指向某版本但历史无 decision=improve 命中 → 返 undefined', () => {
    // 异常场景：baseline 指向某 process，但历史 turn 无该 candidate 的 improve 记录
    const task: BaselineTask = {
      baseVersionId: baseId,
      temporaryBaselineVersionId: round1CandidateId,
    };
    const turns: BaselineTurn[] = [
      { candidateVersionId: round2CandidateId, decision: 'improve', avgScore: 0.5 },
    ];
    expect(reviseBaselineAvg(task, turns)).toBeUndefined();
  });

  it('分支②：命中但 decision !== improve（regress/equal）→ 跳过不取', () => {
    const task: BaselineTask = {
      baseVersionId: baseId,
      temporaryBaselineVersionId: round1CandidateId,
    };
    const turns: BaselineTurn[] = [
      { candidateVersionId: round1CandidateId, decision: 'equal', avgScore: 0.5 },
    ];
    expect(reviseBaselineAvg(task, turns)).toBeUndefined();
  });
});
