/**
 * component-train-view-col —— 训练观察页右侧「训练视图」列（可拖宽）
 * 参考: specs/ui/components/academy-page/section-training-observe.md（train-col 契约）
 *       specs/ui/components/academy-page/_overview.md §2（可拖宽列约定）
 *       demo 04-training-observe.html（train-head / task-status 4 cell / iter-item）
 *
 * 从 section-training-observe 拆出控行数（单文件 ≤300 行）：本组件只负责渲染，
 * 所有派生数据（iterTurns / curvePoints / 状态文案）由 section 计算后传入。
 * 列宽受控 + 左缘拖拽手柄（side='right'，复用 chat-page/component-col-resize-handle）。
 */
import { useTranslation } from 'react-i18next';
import { ComponentColResizeHandle } from '../chat-page/component-col-resize-handle';
import { ComponentIterationTimeline, type IterTurn } from './component-iteration-timeline';
import { ComponentScoreCurve, type ScorePoint } from './component-score-curve';
import { ComponentSubagentTree } from '../chat-page/component-subagent-tree';
import type { PersistentWidthState } from '../common/use-persistent-width';
import type { ChildrenView } from '../chat-page/types';

interface Props {
  /** 列宽 state（usePersistentWidth(ACADEMY_COL.train)） */
  col: PersistentWidthState;
  /** train-head 副文案：base 版本 label + 可选评估器名 */
  baseLabel: string;
  graderName?: string;
  /** task-status 4 cell 值 */
  statusText: string;
  statusRunning: boolean;
  turnText: string;
  baselineLabel: string;
  bestScore?: number;
  /** 评分走势（空数组则不渲染） */
  curvePoints: ScorePoint[];
  /** 走势基线分（训练 base 平均分，十分制） */
  curveBaseScore?: number;
  /** coach 工作子代理（null / 全空则不渲染树） */
  subagents?: ChildrenView | null;
  onOpenSubagent: (sessionId: string) => void;
  /** 迭代记录（倒序） */
  turns: IterTurn[];
  compareBaseline: 'temp' | 'training';
  onCompareChange: (v: 'temp' | 'training') => void;
}

/** 训练视图列（右栏，可拖宽 380~800 默认 520） */
export function ComponentTrainViewCol({
  col,
  baseLabel,
  graderName,
  statusText,
  statusRunning,
  turnText,
  baselineLabel,
  bestScore,
  curvePoints,
  curveBaseScore,
  subagents,
  onOpenSubagent,
  turns,
  compareBaseline,
  onCompareChange,
}: Props) {
  const { t } = useTranslation('academy');
  const hasSubagents = !!subagents && (subagents.running.length > 0 || subagents.terminated.length > 0);

  return (
    // relative 供 absolute 手柄定位；宽度受控（style width，非 tailwind 固定类）
    <div style={{ width: col.width }} className="relative flex-shrink-0 flex flex-col bg-surface">
      <ComponentColResizeHandle
        side="right"
        currentWidth={col.width}
        minWidth={col.minWidth}
        maxWidth={col.maxWidth}
        onResize={col.onResize}
        onResizeEnd={col.onResizeEnd}
        ariaLabel={t('resize.ariaLabel')}
        title={t('resize.title')}
      />
      <div className="flex items-center gap-2.5 px-4 py-[11px] border-b border-border shrink-0">
        <span className="text-[13px] font-semibold text-fg">{t('trainView.title')}</span>
        <span className="text-[11px] text-muted truncate">
          {graderName
            ? t('trainView.baseSub', { label: baseLabel, grader: graderName })
            : t('trainView.baseSubNoGrader', { label: baseLabel })}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-[14px]">
        {/* task-status 4 cell */}
        <div className="flex gap-2.5 mb-[14px]">
          <StatusCell k={t('trainStatus.status')} v={statusText} vCls={statusRunning ? 'text-gold' : 'text-fg'} />
          <StatusCell k={t('trainStatus.turn')} v={turnText} />
          <StatusCell k={t('trainStatus.baseline')} v={baselineLabel} />
          <StatusCell k={t('trainStatus.bestScore')} v={bestScore !== undefined ? bestScore.toFixed(1) : '—'} vCls="text-sage" />
        </div>

        {/* 评分走势（有点才渲） */}
        {curvePoints.length > 0 && (
          <div className="mb-2">
            <ComponentScoreCurve points={curvePoints} baseScore={curveBaseScore} />
          </div>
        )}

        {/* subagent 树（working 入口；design §8.8）——共享 chat-page 树 flat 形态，观察入口/文案经 props 注入 */}
        {hasSubagents && subagents && (
          <div className="mb-2">
            <ComponentSubagentTree
              flat
              running={subagents.running}
              terminated={subagents.terminated}
              onOpenNode={onOpenSubagent}
              openNodeLabel={t('iter.watch')}
              terminatedLabel={t('caseTable.total', { count: subagents.terminated.length })}
            />
          </div>
        )}

        {/* 迭代记录 */}
        <ComponentIterationTimeline turns={turns} compareBaseline={compareBaseline} onCompareChange={onCompareChange} onOpenSubagent={onOpenSubagent} />
      </div>
    </div>
  );
}

/** task-status 单元格（demo .ts-cell：border + bg + 10.5px muted k + 13.5px mono 600 v） */
function StatusCell({ k, v, vCls = 'text-fg' }: { k: string; v: string; vCls?: string }) {
  return (
    <div className="flex-1 border border-border rounded-lg px-3 py-2.5 bg-bg min-w-0">
      <div className="text-[10.5px] text-muted mb-0.5 truncate">{k}</div>
      <div className={`text-[13.5px] font-semibold font-mono truncate ${vCls}`}>{v}</div>
    </div>
  );
}

export default ComponentTrainViewCol;
