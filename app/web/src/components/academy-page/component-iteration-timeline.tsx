/**
 * component-iteration-timeline —— 训练观察右栏迭代记录（倒序折叠卡 + gate 三色 tag）
 * 参考: specs/ui/components/academy-page/component-iteration-timeline.md
 *       demo 04-training-observe.html `.iter-item / .step / .working-link / .vs-toggle`
 *
 * 结构：sec-label 头 + vs-toggle 对比基准切换 + 倒序 iter-item 列表；
 * iter-detail 展开含 4 step（fork→优化→评估→反思）+ case 表（评估 step）+ 反思盒。
 * working step 出「👁 观察 →」working-link（design §8.8：仅 subagent 进行中可点）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PrimitiveStatusBadge } from './primitive-status-badge';
import { ComponentCaseTable, type CaseRow } from './component-case-table';

/** 迭代 step（4 步固定：fork / 优化 / 评估 / 反思） */
export interface IterStep {
  key: string;
  text: string;
  /** done=sage ✓ / working=indigo ◐ spin / todo=muted 序号 */
  state: 'done' | 'working' | 'todo';
  /** todo 态显示的序号（demo 数字 dot） */
  todoIndex?: number;
}

/** 一轮迭代（section 从 TrainingTurnEntity + version map + dataset 派生） */
export interface IterTurn {
  id: string;
  /** 展示用版本号（含 v 前缀，如 'v1.2.3'） */
  versionLabel: string;
  gateDecision: 'became_baseline' | 'regressed' | 'pending' | 'kept_baseline' | 'was_baseline';
  /** 本轮均分（pending 无） */
  score?: number;
  /** 与对比基准的分差（>0 ↑ sage / <0 ↓ danger / 0 或 undefined —） */
  scoreDelta?: number;
  steps: IterStep[];
  /** 评估 step 展开时的 case 表 */
  cases?: CaseRow[];
  casesTotal?: number;
  /** 反思 step 展开时的反思正文 */
  reflection?: string;
  /** 优化中 subagent session id（存在 → working-link 可点） */
  workingSubagentId?: string;
  /** 当前进行中轮（cur 边框 accent + shadow-xs + 默认展开） */
  isCurrent?: boolean;
}

interface Props {
  /** 倒序：最新轮在前 */
  turns: IterTurn[];
  compareBaseline: 'temp' | 'training';
  onCompareChange: (b: 'temp' | 'training') => void;
  onOpenSubagent?: (sessionId: string) => void;
}

/** gate 文案 variant 映射 */
const GATE_VARIANT = {
  became_baseline: 'gate-baseline',
  regressed: 'gate-regressed',
  pending: 'gate-pending',
  kept_baseline: 'gate-kept',
  was_baseline: 'gate-was-baseline',
} as const;

/** step dot（demo .step-dot 18×18：sage ✓ / indigo ◐ spin / muted 序号） */
function StepDot({ step }: { step: IterStep }) {
  if (step.state === 'done') {
    return <span className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[9px] text-white flex-shrink-0 bg-sage">✓</span>;
  }
  if (step.state === 'working') {
    return (
      <span className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[9px] text-white flex-shrink-0 bg-[var(--color-indigo)]">
        <span className="inline-block animate-spin" style={{ animationDuration: '1.2s' }}>◐</span>
      </span>
    );
  }
  return (
    <span className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[9px] text-white flex-shrink-0 bg-muted-2">
      {step.todoIndex ?? '·'}
    </span>
  );
}

/** 分数 + 箭头（demo .iter-score：mono 12px/600，↑ sage / ↓ danger） */
function ScoreView({ score, delta }: { score?: number; delta?: number }) {
  if (score === undefined) return <span className="ml-auto font-mono text-[12px] font-semibold text-muted">—</span>;
  const arrow = delta === undefined || delta === 0 ? '' : delta > 0 ? '↑' : '↓';
  const cls = delta === undefined || delta === 0 ? 'text-fg' : delta > 0 ? 'text-sage' : 'text-danger';
  return (
    <span className={`ml-auto font-mono text-[12px] font-semibold ${cls}`}>
      {score.toFixed(1)}{arrow ? ` ${arrow}` : ''}
    </span>
  );
}

/** 迭代记录区（倒序列表；cur 轮默认展开） */
export function ComponentIterationTimeline({ turns, compareBaseline, onCompareChange, onOpenSubagent }: Props) {
  const { t } = useTranslation('academy');
  // 展开态：默认 cur 轮展开（demo 行为）；用户可点 head 折叠/展开
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({});
  const isOpen = (turn: IterTurn) => openMap[turn.id] ?? turn.isCurrent === true;
  const toggle = (turn: IterTurn) => setOpenMap((m) => ({ ...m, [turn.id]: !isOpen(turn) }));

  return (
    <div>
      {/* sec-label + vs-toggle（demo：激活段黑底白字） */}
      <div className="flex items-center gap-[7px] text-[12px] font-semibold text-fg-2 mt-4 mb-[9px] first:mt-0">
        {t('iter.title')}
        <span className="ml-auto flex border border-border rounded-md overflow-hidden">
          {(['temp', 'training'] as const).map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={compareBaseline === b}
              onClick={() => onCompareChange(b)}
              className={`px-[9px] py-[3px] text-[11px] ${compareBaseline === b ? 'bg-accent text-white' : 'text-muted'}`}
            >
              {b === 'temp' ? t('iter.vsTemp') : t('iter.vsBase')}
            </button>
          ))}
        </span>
      </div>

      {turns.length === 0 && <div className="text-[12px] text-muted">{t('iter.empty')}</div>}

      {turns.map((turn) => {
        const open = isOpen(turn);
        return (
          <div
            key={turn.id}
            className={
              'border rounded-lg mb-[9px] overflow-hidden bg-surface ' +
              (turn.isCurrent ? 'border-accent shadow-xs' : 'border-border')
            }
          >
            {/* iter-head（demo：p-9/12 cursor-pointer hover bg-warm） */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggle(turn)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggle(turn); }}
              className="flex items-center gap-[9px] px-3 py-[9px] cursor-pointer hover:bg-bg-warm"
            >
              <span className="font-mono text-[12.5px] font-semibold text-fg">{turn.versionLabel}</span>
              <PrimitiveStatusBadge variant={GATE_VARIANT[turn.gateDecision]} />
              <ScoreView score={turn.score} delta={turn.scoreDelta} />
            </div>

            {/* iter-detail（展开：top border + bg 底） */}
            {open && (
              <div className="border-t border-border px-[14px] py-3 bg-bg">
                {turn.steps.map((step) => (
                  <div
                    key={step.key}
                    className={
                      'flex items-center gap-[9px] py-[7px] text-[12.5px] ' +
                      (step.state === 'working' ? 'text-fg font-medium' : step.state === 'todo' ? 'text-muted' : 'text-fg')
                    }
                  >
                    <StepDot step={step} />
                    <span className="min-w-0">{step.text}</span>
                    {/* working-link（design §8.8：仅 workingSubagentId 存在时渲染） */}
                    {step.state === 'working' && turn.workingSubagentId && onOpenSubagent && (
                      <button
                        type="button"
                        data-action-key="academy.training.observe"
                        onClick={() => onOpenSubagent(turn.workingSubagentId!)}
                        className="ml-auto text-[11px] text-[var(--color-indigo)] flex items-center gap-1 cursor-pointer hover:underline shrink-0"
                      >
                        {t('iter.watch')}
                      </button>
                    )}
                  </div>
                ))}
                {turn.cases && turn.cases.length > 0 && (
                  <div className="mt-2">
                    <ComponentCaseTable cases={turn.cases} total={turn.casesTotal} />
                  </div>
                )}
                {turn.reflection && (
                  <div className="mt-2.5 px-3 py-2.5 bg-[var(--hue-violet-bg)] rounded-md text-[12px] leading-relaxed text-fg-2">
                    <b>{t('reflect.label')}</b>{turn.reflection}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default ComponentIterationTimeline;
