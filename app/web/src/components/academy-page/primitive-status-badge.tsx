/**
 * primitive-status-badge —— academy 通用状态徽标（版本类型/任务状态/优化模式/gate 决策）
 * 参考: specs/ui/components/academy-page/primitive-status-badge.md（variant 映射表权威）
 *       demo `_tokens.css` .tag（h-20 + p-0/7 + rounded-sm + 11px/500）
 *
 * 纯展示无交互；配色走 regulation 银灰 + hue token（禁字面 hex——demo #b45309 用
 *   amber-800 等价色 var 兜底，此处统一走 tailwind 任意值 + 既有 token）。
 */
import { useTranslation } from 'react-i18next';

/** 徽标变体（spec §Props Variant 表） */
export type StatusBadgeVariant =
  | 'formal' | 'process' | 'current'
  | 'training' | 'ready' | 'untrained'
  | 'pending' | 'running' | 'paused' | 'awaiting_confirm' | 'done' | 'rejected' | 'aborted'
  | 'learn' | 'train'
  | 'gate-baseline' | 'gate-regressed' | 'gate-pending' | 'gate-kept' | 'gate-was-baseline';

interface Props {
  variant: StatusBadgeVariant;
  /** 自定义文案；缺省走 i18n 默认（spec「默认文案」列 = E2E 定位契约） */
  label?: string;
  size?: 'sm' | 'md';
}

/** variant → tailwind 配色类（token 化；violet 走 hue-violet 系列，gold 文案用 amber-800 等价） */
const VARIANT_CLS: Record<StatusBadgeVariant, string> = {
  formal: 'bg-accent text-white',
  process: 'bg-[var(--hue-violet-bg)] text-[var(--hue-violet)]',
  current: 'bg-sage-bg text-sage',
  training: 'bg-gold-bg text-[#b45309]',
  ready: 'bg-sage-bg text-sage',
  untrained: 'bg-surface-2 text-muted',
  pending: 'bg-surface-2 text-muted',
  running: 'bg-gold-bg text-[#b45309]',
  paused: 'bg-surface-2 text-muted',
  awaiting_confirm: 'bg-gold-bg text-[#b45309]',
  done: 'bg-sage-bg text-sage',
  rejected: 'bg-danger-light text-danger',
  aborted: 'bg-surface-2 text-muted',
  learn: 'bg-[var(--info-bg)] text-[var(--info)]',
  train: 'bg-[var(--hue-violet-bg)] text-[var(--hue-violet)]',
  'gate-baseline': 'bg-sage-bg text-sage',
  'gate-regressed': 'bg-danger-light text-danger',
  'gate-pending': 'bg-gold-bg text-[#b45309]',
  'gate-kept': 'bg-surface-2 text-muted',
  'gate-was-baseline': 'bg-sage-bg text-sage',
};

/** variant → i18n key（academy ns；与 spec variant 表一一对应） */
const VARIANT_KEY: Record<StatusBadgeVariant, string> = {
  formal: 'badge.formal',
  process: 'badge.process',
  current: 'badge.current',
  training: 'badge.training',
  ready: 'badge.ready',
  untrained: 'badge.untrained',
  pending: 'task.pending',
  running: 'task.running',
  paused: 'task.paused',
  awaiting_confirm: 'task.awaiting_confirm',
  done: 'task.done',
  rejected: 'task.rejected',
  aborted: 'task.aborted',
  learn: 'optimize.learn',
  train: 'optimize.train',
  'gate-baseline': 'gate.baseline',
  'gate-regressed': 'gate.regressed',
  'gate-pending': 'gate.pending',
  'gate-kept': 'gate.kept',
  'gate-was-baseline': 'gate.wasBaseline',
};

/** academy 状态徽标（.tag 视觉：h-20 p-0/7 rounded-sm 11px/500 whitespace-nowrap） */
export function PrimitiveStatusBadge({ variant, label, size = 'md' }: Props) {
  const { t } = useTranslation('academy');
  const sizeCls = size === 'sm' ? 'h-[18px] px-1.5 text-[10.5px]' : 'h-5 px-[7px] text-[11px]';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm font-medium whitespace-nowrap ${sizeCls} ${VARIANT_CLS[variant]}`}
    >
      {label ?? t(VARIANT_KEY[variant])}
    </span>
  );
}

export default PrimitiveStatusBadge;
