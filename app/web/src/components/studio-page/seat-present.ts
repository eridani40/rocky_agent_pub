/**
 * seat-present —— 坐席卡（队长 mini 卡）/ 坐席行（mate 行）共享呈现层
 * 参考: specs/ui/components/studio-page/component-seat-card.md v1.4
 *       specs/ui/components/studio-page/component-seat-row.md v1.0
 *       specs/tech/version_logs/v0.0.170/change_plan.md（seat-present 契约行）
 *
 * 职责：队长 mini 卡与 mate 行共享的纯呈现逻辑——presence 静态脉冲点样式 + 状态文案选择。
 * 边界：无 @keyframes（INV-3 严肃基调）；颜色只走 var(--presence-*)；文案仍走 t() 查 i18n。
 */
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { SeatPresence, SeatRow } from './use-seats-data';

/** presence → 静态脉冲点 CSS（无 @keyframes；box-shadow 光晕 + 底色，offline 无晕） */
export function pulseStyle(presence: SeatPresence): CSSProperties {
  const color = `var(--presence-${presence})`;
  if (presence === 'offline') return { background: color };
  return {
    background: color,
    boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 20%, transparent)`,
  };
}

/** 状态文案：优先 currentWork.text；空则 i18n `seats.status.{presence}` 兜底 */
export function useSeatStatusText(row: SeatRow): string {
  const { t } = useTranslation('studio');
  const src = row.statusTextSource;
  if (src.kind === 'currentWork') return src.text;
  return t(`seats.status.${row.presence}` as const);
}
