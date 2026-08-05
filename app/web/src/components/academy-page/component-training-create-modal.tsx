/**
 * component-training-create-modal —— 发起训练弹层（模式卡 + picker + 目标 + 迭代策略）
 * 参考: specs/ui/components/academy-page/component-training-create-modal.md
 *       demo 05-training-create.html（640px / mode-cards / stepper / hint-bar）
 * mode-cards 二选一（简单/多轮）；多轮需评估能力（教室有数据集+评估器），无则 dis 禁用。
 * demo 映射：simple ⇒ optimizeStyle='learning'；multi ⇒ optimizeStyle='training'。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal } from '../../lib/portal';
import type { CreateTrainingTaskBody, DatasetEntity, GraderEntity } from '../../lib/academy-api';
import { BTN_PRIMARY, BTN_SECONDARY, ICON_BTN, SIDE_LABEL, TEXTAREA } from './academy-styles';

/** 提交配置（onSubmit 上抛；section 组 CreateTrainingTaskBody） */
export interface TrainingFormConfig {
  mode: 'simple' | 'multi';
  directive: string;
  datasetId?: string;
  graderId?: string;
  maxTurns: number;
}

interface Props {
  open: boolean;
  student: { id: string; name: string };
  formalVersions: { id: string; label: string }[];  // baseline picker 可 cycle（PRD §2.4 不锁 currentFormal）
  defaultBaseVersionId: string;  // 默认 baseline（currentFormal 或调用方 hint）
  datasets: DatasetEntity[];
  graders: GraderEntity[];
  /** false → 多轮卡禁用（需先备评估能力） */
  hasEvaluationCapability: boolean;
  /** 下一任务序号（hint 文案「v{baseMajor}.{seq} 训练任务」） */
  nextTaskSeq: number;
  onCancel: () => void;
  onSubmit: (baseVersionId: string, config: TrainingFormConfig) => Promise<void> | void;
}

/** picker 循环切换选项（demo › 语义即「可换」；下拉 popover 超 MVP 不引入） */
function cycleOption<T extends { id: string }>(items: T[], id: string | undefined, set: (v: string) => void) {
  if (items.length < 2) return;
  const idx = items.findIndex((i) => i.id === id);
  set(items[(idx + 1) % items.length]!.id);
}

/** 数值步进器（− / value / ＋；maxTurns / earlyStop 复用） */
function Stepper({ label, value, set, min, max }: { label: string; value: number; set: (v: number) => void; min: number; max: number; }) {
  return (
    <div className="flex flex-col gap-[5px]">
      <label className="text-[12px] font-medium text-fg-2">{label}</label>
      <div className="flex items-center border border-border rounded-md overflow-hidden">
        <button type="button" onClick={() => set(Math.max(min, value - 1))} className="w-[26px] h-[28px] text-muted hover:bg-accent-light">−</button>
        <input value={value} readOnly className="w-[38px] text-center border-none outline-none font-mono text-[13px]" />
        <button type="button" onClick={() => set(Math.min(max, value + 1))} className="w-[26px] h-[28px] text-muted hover:bg-accent-light">＋</button>
      </div>
    </div>
  );
}

/** picker 行（demo .picker：icon + 名 + 副 + ›；click 循环选项） */
function PickerRow({ icon, label, sub, onClick }: { icon: string; label: string; sub: string; onClick?: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' && onClick) onClick(); }}
      className="flex-1 flex items-center gap-[9px] px-3 py-[9px] border border-border rounded-md cursor-pointer hover:border-border-strong"
    >
      <span className="text-[15px]">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] font-medium text-fg truncate">{label}</div>
        <div className="text-[10.5px] text-muted truncate">{sub}</div>
      </div>
      <span className="text-muted">›</span>
    </div>
  );
}

export function ComponentTrainingCreateModal({
  open, student, formalVersions, defaultBaseVersionId, datasets, graders, hasEvaluationCapability, nextTaskSeq, onCancel, onSubmit,
}: Props) {
  const { t } = useTranslation('academy');
  const [mode, setMode] = useState<'simple' | 'multi'>('multi');
  const [baseVersionId, setBaseVersionId] = useState<string>(defaultBaseVersionId);
  const [datasetId, setDatasetId] = useState<string | undefined>();
  const [graderId, setGraderId] = useState<string | undefined>();
  const [directive, setDirective] = useState('');
  const [maxTurns, setMaxTurns] = useState(5);
  const [earlyStop, setEarlyStop] = useState(3);
  const [autoFix, setAutoFix] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 打开时重置 + 默认选第一个数据集/评估器 + baseline 落 defaultBaseVersionId
  useEffect(() => {
    if (open) {
      setMode(hasEvaluationCapability ? 'multi' : 'simple');
      setBaseVersionId(defaultBaseVersionId);
      setDatasetId(datasets[0]?.id);
      setGraderId(graders[0]?.id);
      setDirective('');
      setMaxTurns(5);
      setEarlyStop(3);
      setAutoFix(true);
      setError(null);
    }
  }, [open, hasEvaluationCapability, datasets, graders, defaultBaseVersionId]);

  if (!open) return null;

  const multiValid = mode === 'simple' || (datasetId !== undefined && graderId !== undefined);
  const valid = directive.trim().length > 0 && multiValid && !!baseVersionId;
  const dataset = datasets.find((d) => d.id === datasetId);
  const grader = graders.find((g) => g.id === graderId);
  const baseVersion = formalVersions.find((v) => v.id === baseVersionId);

  const submit = async () => {
    if (!valid || submitting || !baseVersionId) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(baseVersionId, { mode, directive: directive.trim(), datasetId, graderId, maxTurns });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('create.submitFail'));
    } finally {
      setSubmitting(false);
    }
  };

  /** hint 文案用的任务名前缀：v{baseMajor}.{seq}（PRD §2.5） */
  const hintName = baseVersion
    ? `v${baseVersion.label.split('.')[0]}.${nextTaskSeq}`
    : `v?.${nextTaskSeq}`;

  /** mode 卡（demo .mode-card：border-2 + sel border-accent + dis 半透明） */
  const modeCard = (
    id: 'simple' | 'multi', icon: string, name: string, desc: string, reqOk: boolean, reqText: string, disabled: boolean,
  ) => (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-pressed={mode === id}
      aria-disabled={disabled}
      onClick={() => { if (!disabled) setMode(id); }}
      onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) setMode(id); }}
      className={
        'relative border-2 rounded-xl p-[15px] transition-all duration-150 ' +
        (disabled
          ? 'opacity-55 cursor-not-allowed border-border'
          : mode === id
            ? 'border-accent bg-bg cursor-pointer'
            : 'border-border cursor-pointer hover:border-border-strong')
      }
    >
      {/* radio 圈（sel 黑底 + inset 白环） */}
      <span
        className={
          'absolute top-3 right-3 w-[18px] h-[18px] rounded-full border-2 ' +
          (mode === id && !disabled ? 'border-accent bg-accent shadow-[inset_0_0_0_3px_var(--color-surface)]' : 'border-border-2')
        }
      />
      <div className="text-[22px] mb-[7px]">{icon}</div>
      <div className="text-[13.5px] font-semibold mb-[3px] text-fg">{name}</div>
      <div className="text-[11.5px] text-muted leading-normal">{desc}</div>
      <div className={`mt-2 text-[11px] px-2 py-[5px] rounded-sm ${reqOk ? 'bg-sage-bg text-sage' : 'bg-gold-bg text-[#b45309]'}`}>
        {reqText}
      </div>
    </div>
  );

  return (
    <Portal>
      {/* 遮罩（点击取消）
          pointer-events-auto 必须显式声明：overlay-root 容器为 pointer-events:none，
          该属性可继承——漏写则整棵子树不接事件，所有按钮 click 全穿透。 */}
      <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center pointer-events-auto" style={{ background: 'rgba(10,10,10,.45)' }} onClick={onCancel}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('create.title', { name: student.name })}
          className="w-[640px] max-w-[92vw] max-h-[88vh] bg-surface rounded-xl shadow-lg flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* head */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
            <span className="text-[15px] font-semibold text-fg">{t('create.title', { name: student.name })}</span>
            <button type="button" onClick={onCancel} aria-label={t('create.cancel')} className={ICON_BTN}>✕</button>
          </div>

          {/* body */}
          <div className="flex-1 overflow-y-auto px-5 py-[18px]">
            <div className={`${SIDE_LABEL} normal-case tracking-normal text-fg-2 text-[12px] mb-[9px]`}>{t('create.modeLabel')}</div>
            <div className="grid grid-cols-2 gap-3 mb-[18px]">
              {modeCard('simple', '⚡', t('create.simple'), t('create.simpleDesc'), true, t('create.reqOk'), false)}
              {modeCard('multi', '📈', t('create.multi'), t('create.multiDesc'), hasEvaluationCapability, hasEvaluationCapability ? t('create.reqReady') : t('create.reqMiss'), !hasEvaluationCapability)}
            </div>

            <div className={`${SIDE_LABEL} normal-case tracking-normal text-fg-2 text-[12px] mt-4 mb-[9px]`}>{t('create.baseLabel')}</div>
            <div className="flex gap-3">
              <PickerRow
                icon="🌳"
                label={baseVersion ? t('create.baseCurrent', { label: `v${baseVersion.label}` }) : t('create.selectPlaceholder')}
                sub={t('create.baseSub')}
                onClick={formalVersions.length > 1 ? () => cycleOption(formalVersions, baseVersionId, setBaseVersionId) : undefined}
              />
            </div>

            {mode === 'multi' && (
              <>
                <div className={`${SIDE_LABEL} normal-case tracking-normal text-fg-2 text-[12px] mt-4 mb-[9px]`}>
                  {t('create.datasetLabel')} · {t('create.graderLabel')}
                </div>
                <div className="flex gap-3">
                  <PickerRow
                    icon="📚"
                    label={dataset?.name ?? t('create.selectPlaceholder')}
                    sub={dataset ? t('create.datasetCaseCount', { count: dataset.items.length }) : ''}
                    onClick={() => cycleOption(datasets, datasetId, setDatasetId)}
                  />
                  <PickerRow
                    icon="⚖️"
                    label={grader?.name ?? t('create.selectPlaceholder')}
                    sub={grader ? (grader.type === 'llm-judge' ? t('create.graderJudge') : t('create.graderEm')) : ''}
                    onClick={() => cycleOption(graders, graderId, setGraderId)}
                  />
                </div>
              </>
            )}

            <div className="flex items-center gap-1.5 text-[12px] font-semibold text-fg-2 mt-4 mb-[9px]">
              {t('create.directiveLabel')}
              <span className="font-normal text-muted text-[11px]">{t('create.directiveSub')}</span>
            </div>
            <textarea
              rows={2}
              value={directive}
              placeholder={t('create.directivePlaceholder')}
              onChange={(e) => setDirective(e.target.value)}
              className={TEXTAREA}
            />

            <div className={`${SIDE_LABEL} normal-case tracking-normal text-fg-2 text-[12px] mt-4 mb-[9px]`}>{t('create.strategyLabel')}</div>
            <div className="grid grid-cols-3 gap-[11px]">
              <Stepper label={t('create.maxTurns')} value={maxTurns} set={setMaxTurns} min={1} max={20} />
              <Stepper label={t('create.earlyStop')} value={earlyStop} set={setEarlyStop} min={1} max={10} />
              <div className="flex flex-col gap-[5px]">
                <label className="text-[12px] font-medium text-fg-2">{t('create.acceptRule')}</label>
                <div className="flex items-center border border-border rounded-md w-full h-[28px]">
                  <span className="text-[12px] px-2 text-fg-2">{t('create.acceptRuleValue')}</span>
                </div>
              </div>
            </div>

            <div className="mt-[14px]">
              <label className="flex items-center gap-2 text-[12.5px] text-fg-2 py-[5px] cursor-pointer" onClick={() => setAutoFix((v) => !v)}>
                <span
                  className={
                    'w-4 h-4 rounded border-[1.5px] flex items-center justify-center text-[10px] ' +
                    (autoFix ? 'bg-accent border-accent text-white' : 'border-border-strong text-transparent')
                  }
                >
                  ✓
                </span>
                {t('create.autoFix')}
              </label>
            </div>

            <div className="mt-4 px-[13px] py-2.5 bg-[var(--info-bg)] rounded-md text-[12px] text-fg-2 leading-[1.55]">
              {t('create.hint', { name: hintName })}
            </div>
            {error && <div className="mt-2 text-[12px] text-danger">{error}</div>}
          </div>

          {/* foot */}
          <div className="flex justify-end gap-[9px] px-5 py-[14px] border-t border-border shrink-0">
            <button type="button" onClick={onCancel} className={BTN_SECONDARY}>{t('create.cancel')}</button>
            <button type="button" data-action-key="academy.training.start" disabled={!valid || submitting} onClick={() => void submit()} className={BTN_PRIMARY}>
              {submitting ? t('create.submitting') : t('create.submit')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

/** 表单配置 → API body（section 用；simple⇒learning / multi⇒training 的 demo 映射在此收敛） */
export function toCreateTaskBody(baseVersionId: string, config: TrainingFormConfig): CreateTrainingTaskBody {
  return {
    baseVersionId,
    mode: config.mode,
    optimizeStyle: config.mode === 'multi' ? 'training' : 'learning',
    directive: config.directive,
    ...(config.mode === 'multi' ? { datasetId: config.datasetId, graderId: config.graderId, maxTurns: config.maxTurns } : {}),
  };
}

export default ComponentTrainingCreateModal;
