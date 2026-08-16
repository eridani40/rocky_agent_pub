/**
 * component-circuit-status — 熔断状态红绿灯呈现（v0.0.347 模型路由）
 * 参考 specs/api/overall/21-model-routing.md §2.6（presentation 权威映射 D16）
 *       specs/prd/model-routing-PRD-2026-08-14.md §2.7（状态呈现映射表）
 *
 * 职责：消费 status 端点 presentation 字段，呈现用户友好状态词：
 *   - normal    → 🟢 正常（无倒计时）
 *   - abnormal  → 🔴 异常（带倒计时 remainingSeconds，每秒刷新）
 *   - observing → 🟡 观察中（无倒计时）
 * 不给熔断器词（closed/open/half_open 不出现）。
 *
 * 边界：纯展示组件；数据（presentation/remainingSeconds）由父级拉取传入。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** status 端点 presentation（21-model-routing.md §2.6 D16 权威值） */
export type CircuitPresentation = 'normal' | 'abnormal' | 'observing';

export interface CircuitStatusBadgeProps {
  /** 呈现态（normal/abnormal/observing） */
  presentation: CircuitPresentation;
  /** open 时剩余秒数（abnormal 才有；倒计时本地每秒递减） */
  remainingSeconds?: number;
  /** 测试注入：倒计时 tick 间隔（ms），默认 1000 */
  tickMs?: number;
}

/**
 * CircuitStatusBadge 组件。
 * abnormal 带倒计时：接收服务端 remainingSeconds 快照后本地每秒递减，到 0 显示 0s。
 */
export function CircuitStatusBadge({ presentation, remainingSeconds, tickMs = 1000 }: CircuitStatusBadgeProps) {
  const { t } = useTranslation('app-dev-config');
  // 本地倒计时（服务端只给快照；每秒递减直到 0）
  const [countdown, setCountdown] = useState(remainingSeconds ?? 0);
  useEffect(() => {
    setCountdown(remainingSeconds ?? 0);
  }, [remainingSeconds]);
  useEffect(() => {
    if (presentation !== 'abnormal' || countdown <= 0) return;
    const timer = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), tickMs);
    return () => clearInterval(timer);
  }, [presentation, countdown, tickMs]);

  if (presentation === 'abnormal') {
    return (
      <span
        data-testid="circuit-status"
        data-presentation="abnormal"
        className="inline-flex items-center gap-1 text-[12px] text-danger"
        title={t('modelRouting.status.abnormalTitle')}
      >
        <span aria-hidden>🔴</span>
        <span>{t('modelRouting.status.abnormal')}</span>
        <span data-testid="circuit-countdown" className="font-mono">
          {countdown}s
        </span>
      </span>
    );
  }
  if (presentation === 'observing') {
    return (
      <span
        data-testid="circuit-status"
        data-presentation="observing"
        className="inline-flex items-center gap-1 text-[12px] text-gold"
        title={t('modelRouting.status.observingTitle')}
      >
        <span aria-hidden>🟡</span>
        <span>{t('modelRouting.status.observing')}</span>
      </span>
    );
  }
  return (
    <span
      data-testid="circuit-status"
      data-presentation="normal"
      className="inline-flex items-center gap-1 text-[12px] text-sage"
      title={t('modelRouting.status.normalTitle')}
    >
      <span aria-hidden>🟢</span>
      <span>{t('modelRouting.status.normal')}</span>
    </span>
  );
}

export default CircuitStatusBadge;
