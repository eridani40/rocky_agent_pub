/**
 * section-training-observe —— 训练观察页（obs-topbar + 中 coach 对话 + 右可拖宽训练视图）
 * 参考: specs/ui/components/academy-page/section-training-observe.md
 *       specs/ui/components/academy-page/_overview.md §2（可拖宽列约定）
 *       demo 04-training-observe.html（task-status 4 cell / iter-item / case-table / reflect-box）
 *       design §8.4-8.5（右栏：临时版本 vs 切换 + gate + 每题分数 + 迭代/任务状态）
 *
 * 数据：useTrainingTask 轮询（pending/running）+ coach 消息驱动 reload；
 *   paused 是稳态不轮询。
 * 任务生命周期动作：
 *   - running/pending → 显「暂停」（POST /pause）
 *   - paused + reason≠maxturns → 显「续训」（POST /resume）
 *   - paused + reason=maxturns → 显「调大 maxTurns +5」（POST /update-task，调大后才可 resume）
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getDataset,
  pauseTrainingTask,
  resumeTrainingTask,
  score10,
  updateTrainingTask,
  type DatasetEntity,
  type StudentDetail,
  type TrainingTaskDetail,
  type TrainingTurnEntity,
} from '../../lib/academy-api';
import type { CaseRow } from './component-case-table';
import { SectionChatSession } from '../chat-page/section-chat-session';
import { ComponentAcademyChatHeader } from './component-academy-chat-header';
import { ComponentTrainingStatusBar } from './component-training-status-bar';
import { ComponentTrainViewCol } from './component-train-view-col';
import type { IterTurn, IterStep } from './component-iteration-timeline';
import type { ScorePoint } from './component-score-curve';
import { useCoachChildren } from './use-coach-children';
import { ACADEMY_COL } from './academy-col-widths';
import { usePersistentWidth } from '../common/use-persistent-width';

interface Props {
  classroomId: string;
  taskId: string;
  /** 任务详情（父级 useTrainingTask 持有，含 reload） */
  taskDetail: TrainingTaskDetail;
  onReloadTask: () => void;
  /** 学生详情（版本 label 映射用） */
  studentDetail: StudentDetail;
  onBack: () => void;
  onOpenSubagent: (sessionId: string) => void;
}

/** turn → gateDecision（对照 task.temporaryBaselineVersionId 判 became/was baseline） */
function gateOf(turn: TrainingTurnEntity, tempBaselineId?: string): IterTurn['gateDecision'] {
  if (turn.status === 'running') return 'pending';
  if (turn.decision === 'improve') {
    return turn.candidateVersionId === tempBaselineId ? 'became_baseline' : 'was_baseline';
  }
  if (turn.decision === 'regress') return 'regressed';
  return 'kept_baseline';
}

/** turn → 4 step（fork 恒 done；optimize running 时 working；评估/反思按 status 推进） */
function stepsOf(turn: TrainingTurnEntity, fromLabel: string, toLabel: string, optimizeText: string, t: (k: string) => string): IterStep[] {
  const evaluated = ['graded', 'decided', 'adopted', 'rejected'].includes(turn.status);
  const decided = turn.decision !== undefined || turn.reflection !== undefined;
  return [
    { key: 'fork', text: t('iter.stepFork').replace('{{from}}', fromLabel).replace('{{to}}', toLabel), state: 'done' },
    { key: 'optimize', text: optimizeText, state: turn.status === 'running' ? 'working' : 'done' },
    { key: 'eval', text: t('iter.stepEval'), state: evaluated ? 'done' : 'todo', todoIndex: 4 },
    { key: 'reflect', text: t('iter.stepReflect'), state: decided ? 'done' : 'todo', todoIndex: 5 },
  ];
}

/** 训练观察页 section */
export function SectionTrainingObserve({ classroomId, taskId, taskDetail, onReloadTask, studentDetail, onBack, onOpenSubagent }: Props) {
  const { t } = useTranslation('academy');
  const { task, turns, baselineScore } = taskDetail;
  const [compare, setCompare] = useState<'temp' | 'training'>('temp');
  const [dataset, setDataset] = useState<DatasetEntity | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // coach 工作子代理（5s 轮询，useLifecycle.startTimer 兜底；无 SSE 推送通道）
  const { children } = useCoachChildren(task.coachSessionId);
  // train-col 列宽（可拖 380~800，默认 520；persist localStorage academy-train-col-width）
  const trainCol = usePersistentWidth(ACADEMY_COL.train);

  const versionLabelOf = useCallback(
    (vid?: string) => {
      if (!vid) return '—';
      const v = studentDetail.versions.find((x) => x.id === vid);
      return v ? `v${v.versionLabel}` : '—';
    },
    [studentDetail],
  );

  // 数据集（case 表 question join；simple 模式无 datasetId 不拉）
  useEffect(() => {
    if (!task.datasetId) return;
    let cancelled = false;
    void getDataset(classroomId, task.datasetId).then((d) => { if (!cancelled) setDataset(d); }).catch(() => {});
    return () => { cancelled = true; };
  }, [classroomId, task.datasetId]);

  const runningSub = children?.running[0];

  // coach 消息变化 → 重拉任务详情（引擎 deliverTo → coach 发言 = 进度信号）
  const handleMessagesChange = useCallback(() => onReloadTask(), [onReloadTask]);

  /** 统一动作执行：busy 锁 + 错误展示 + 成功后 reload */
  const runTaskAction = async (label: string, fn: () => Promise<unknown>) => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await fn();
      onReloadTask();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : label);
    } finally {
      setActionBusy(false);
    }
  };

  const handlePause = () => runTaskAction(t('observe.pauseFail'), () => pauseTrainingTask(taskId));
  const handleResume = () => runTaskAction(t('observe.resumeFail'), () => resumeTrainingTask(taskId));
  /** maxturns 到顶：POST /update-task 调大 maxTurns+5（调大后用户再点 resume 续训） */
  const handleIncreaseMaxTurns = () =>
    runTaskAction(t('observe.increaseMaxTurnsFail'), () =>
      updateTrainingTask(taskId, { maxTurns: (task.maxTurns ?? 0) + 5 }),
    );  // turns → IterTurn[]（倒序：最新轮在前）
  const iterTurns = useMemo<IterTurn[]>(() => {
    const questionOf = (caseId: string) => dataset?.items.find((it) => it.id === caseId)?.question ?? caseId;
    const baseScoreRef = compare === 'temp' ? baselineScore : undefined;
    const sorted = [...turns].sort((a, b) => b.round - a.round);
    return sorted.map((turn) => {
      const toLabel = versionLabelOf(turn.candidateVersionId);
      // fork 来源 = 上一轮 candidate 或 base（首论）
      const prevTurn = turns.find((x) => x.round === turn.round - 1);
      const fromLabel = prevTurn ? versionLabelOf(prevTurn.candidateVersionId) : versionLabelOf(task.baseVersionId);
      const avg10 = score10(turn.avgScore);
      const ref10 = score10(baseScoreRef);
      const cases: CaseRow[] | undefined = turn.gradeResults?.slice(0, 5).map((g) => ({
        id: g.caseId,
        score: score10(g.score) ?? 0,
        question: questionOf(g.caseId),
        level: (['positive', 'negative', 'neutral'].includes(g.level ?? '') ? g.level : 'neutral') as CaseRow['level'],
        reasoning: g.reasoning,
      }));
      return {
        id: turn.id,
        versionLabel: toLabel,
        gateDecision: gateOf(turn, task.temporaryBaselineVersionId),
        score: avg10,
        scoreDelta: avg10 !== undefined && ref10 !== undefined ? Math.round((avg10 - ref10) * 10) / 10 : undefined,
        steps: stepsOf(
          turn,
          fromLabel,
          toLabel,
          task.optimizeStyle === 'learning' ? t('iter.stepOptimizeLearn') : t('iter.stepOptimize'),
          (k) => t(k),
        ),
        cases,
        casesTotal: turn.gradeResults?.length,
        reflection: turn.reflection,
        workingSubagentId: turn.status === 'running' ? runningSub?.sessionId : undefined,
        isCurrent: turn.status === 'running',
      };
    });
  }, [turns, compare, baselineScore, dataset, task, versionLabelOf, runningSub, t]);

  // score curve 点（升序轮次；improve 轮标 baseline）
  const curvePoints = useMemo<ScorePoint[]>(
    () =>
      [...turns]
        .filter((x) => x.avgScore !== undefined)
        .sort((a, b) => a.round - b.round)
        .map((x) => ({
          turn: x.round,
          score: score10(x.avgScore) ?? 0,
          isBaseline: x.candidateVersionId === task.temporaryBaselineVersionId,
        })),
    [turns, task.temporaryBaselineVersionId],
  );

  const decidedTurns = turns.filter((x) => x.decision !== undefined);
  const bestScore = decidedTurns.length > 0 ? Math.max(...decidedTurns.map((x) => score10(x.avgScore) ?? 0)) : undefined;
  const maxTurns = task.maxTurns ?? 5;
  // grader 名暂未拉取（无 grader detail 端点；MVP 略，副文案由 train-head 展示）

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* obs-topbar */}
      <div className="flex items-center gap-3 px-[18px] py-2.5 border-b border-border bg-surface shrink-0">
        <button type="button" onClick={onBack} className="text-[13px] text-muted hover:text-fg cursor-pointer">
          ← {t('observe.back')}
        </button>
        <div className="w-px h-[22px] bg-border" />
        <ComponentTrainingStatusBar
          task={{
            id: task.id,
            name: t('observe.taskName', { label: task.baseVersionLabel ? `v${task.baseVersionLabel.split('.')[0]}.${task.taskSeq}` : `v?.${task.taskSeq}` }),
            mode: task.mode,
            optimizeStyle: task.optimizeStyle,
            status: task.status,
            pausedReason: task.pausedReason,
            currentTurn: task.currentTurn,
            maxTurns,
          }}
          onPause={() => void handlePause()}
          onResume={() => void handleResume()}
          onIncreaseMaxTurns={() => void handleIncreaseMaxTurns()}
        />
      </div>
      {actionError && <div className="px-[18px] py-1.5 text-[12px] text-danger bg-danger-light shrink-0">{actionError}</div>}

      {/* 行容器 min-h-0：作为 flex-col 子项防 min-height:auto 撑破高度链（宿主高度链约束，_overview §2） */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* chat-col：coach 对话（复用 chat 内核；消息变化驱动任务刷新）。
            水平 flex（非 flex-col）+ min-h-0 overflow-hidden：BaseChatPage 按 row 子项 stretch 设计 */}
        <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden border-r border-border bg-bg">
          <SectionChatSession
            sessionId={task.coachSessionId}
            topbarLeft={() => (
              <ComponentAcademyChatHeader
                avatarText="教"
                avatarBg="linear-gradient(135deg,#3b82f6,#8b5cf6)"
                title={t('coach.name')}
                statusLine={
                  <div className={`text-[10.5px] ${task.status === 'running' ? 'text-sage' : 'text-muted'}`}>
                    {task.status === 'running' ? t('coach.working') : t('coach.idle')}
                  </div>
                }
                tag={t('coach.tag')}
              />
            )}
            placeholder={t('coach.placeholder')}
            /* 消息驱动任务刷新残留（后端无 training.* SSE）；仅任务刷新，不回收 messages 建 UI */
            onMessagesChange={handleMessagesChange}
          />
        </div>

        {/* train-col：训练视图（可拖宽 380~800 默认 520，拆出组件控行数） */}
        <ComponentTrainViewCol
          col={trainCol}
          baseLabel={versionLabelOf(task.baseVersionId)}
          statusText={t(`task.${task.status}`)}
          statusRunning={task.status === 'running'}
          turnText={`${task.currentTurn ?? 0} / ${maxTurns}`}
          baselineLabel={versionLabelOf(task.temporaryBaselineVersionId)}
          bestScore={bestScore}
          curvePoints={curvePoints}
          curveBaseScore={score10(baselineScore)}
          subagents={children}
          onOpenSubagent={onOpenSubagent}
          turns={iterTurns}
          compareBaseline={compare}
          onCompareChange={setCompare}
        />
      </div>
    </div>
  );
}

export default SectionTrainingObserve;
