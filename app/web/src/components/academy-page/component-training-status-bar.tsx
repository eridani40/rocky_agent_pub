/**
 * component-training-status-bar —— 训练任务状态条（topbar 变体）
 * 参考: specs/ui/components/academy-page/component-training-status-bar.md
 *       demo 04-training-observe.html `.obs-topbar`
 *
 * 三态机（pending/running/paused+pausedReason）按钮逻辑：
 *   - paused + reason≠maxturns → 显「续训」按钮（onResume → POST /resume）
 *   - paused + reason=maxturns  → 显「调大 maxTurns」入口（onIncreaseMaxTurns → POST /update-task）
 *   - running/pending → 显「暂停」（onPause → POST /pause）；去 stop（head 无权 stop，coach 用 pause 可逆停）
 * 原 card 变体（v0.0.220 后无消费方）已删，单文件单职责只管 topbar。
 */
import { useTranslation } from 'react-i18next';
import { PrimitiveStatusBadge } from './primitive-status-badge';
import { BTN_SECONDARY, BTN_SM } from './academy-styles';

/** 任务状态（对齐 TrainingTaskEntity.status 三态机） */
export type TrainingTaskStatus = 'pending' | 'running' | 'paused';

/** pausedReason 闭合 4 值（对齐 schema_defs/training-task.ts） */
export type TrainingTaskPausedReason = 'maxturns' | 'completed' | 'stopped' | 'earlystop';

interface Props {
  task: {
    id: string;
    /** 任务名（如「v1.2 训练任务」，section 派生） */
    name: string;
    mode?: 'simple' | 'multi';
    optimizeStyle?: 'learning' | 'training';
    status: TrainingTaskStatus;
    pausedReason?: TrainingTaskPausedReason;
    currentTurn?: number;
    maxTurns?: number;
  };
  /** 暂停（running/pending → paused） */
  onPause?: () => void;
  /** 续训（paused + reason≠maxturns → running） */
  onResume?: () => void;
  /** 调大 maxTurns（reason=maxturns 时入口；调大后才可 resume） */
  onIncreaseMaxTurns?: () => void;
}

/** pausedReason → i18n key（中文展示） */
function pausedReasonKey(reason: TrainingTaskPausedReason | undefined): string | undefined {
  if (!reason) return undefined;
  return `task.pausedReason.${reason}`;
}

/** 任务状态条（topbar 变体） */
export function ComponentTrainingStatusBar({ task, onPause, onResume, onIncreaseMaxTurns }: Props) {
  const { t } = useTranslation('academy');
  const active = task.status === 'running' || task.status === 'pending';
  const modeTagLabel = task.mode
    ? task.mode === 'multi'
      ? `${t('create.multi')} · ${task.optimizeStyle === 'learning' ? t('optimize.learn') : t('optimize.train')}`
      : `${t('create.simple')} · ${task.optimizeStyle === 'learning' ? t('optimize.learn') : t('optimize.train')}`
    : undefined;

  const reasonKey = pausedReasonKey(task.pausedReason);

  // 顶层 tag：running 显轮次进度 / paused 显 reason 文案 / pending 显「待开始」
  let topBadge: React.ReactNode = null;
  if (task.status === 'running' && task.maxTurns) {
    topBadge = (
      <PrimitiveStatusBadge
        variant="running"
        label={t('observe.turnProgress', { cur: task.currentTurn ?? 0, max: task.maxTurns })}
      />
    );
  } else if (task.status === 'paused') {
    topBadge = (
      <PrimitiveStatusBadge
        variant="paused"
        label={reasonKey ? t(reasonKey) : undefined}
      />
    );
  } else {
    topBadge = <PrimitiveStatusBadge variant="pending" />;
  }

  return (
    <>
      <span className="flex items-center text-[13.5px] font-semibold text-fg min-w-0">
        <span className="truncate">{task.name}</span>
        {modeTagLabel && (
          <span className="ml-2 inline-flex items-center h-5 px-[7px] rounded-sm text-[11px] font-medium bg-[var(--hue-violet-bg)] text-[var(--hue-violet)] whitespace-nowrap">
            {modeTagLabel}
          </span>
        )}
      </span>
      <span className="ml-auto flex items-center gap-2 shrink-0">
        {topBadge}
        {active && onPause && (
          <button
            type="button"
            data-action-key="academy.task.pause"
            onClick={onPause}
            className={`${BTN_SECONDARY} ${BTN_SM}`}
          >
            {t('observe.pause')}
          </button>
        )}
        {task.status === 'paused' && task.pausedReason !== 'maxturns' && onResume && (
          <button
            type="button"
            data-action-key="academy.task.resume"
            onClick={onResume}
            className={`${BTN_SECONDARY} ${BTN_SM}`}
          >
            {t('observe.resume')}
          </button>
        )}
        {task.status === 'paused' && task.pausedReason === 'maxturns' && onIncreaseMaxTurns && (
          <button
            type="button"
            data-action-key="academy.task.increaseMaxTurns"
            onClick={onIncreaseMaxTurns}
            className={`${BTN_SECONDARY} ${BTN_SM}`}
          >
            {t('observe.increaseMaxTurns', { max: (task.maxTurns ?? 0) + 5 })}
          </button>
        )}
      </span>
    </>
  );
}

export default ComponentTrainingStatusBar;
