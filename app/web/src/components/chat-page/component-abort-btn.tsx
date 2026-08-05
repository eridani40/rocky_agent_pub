/**
 * component-abort-btn —— 圆环+方框视觉
 * 参考: specs/ui/components/chat-page/_overview.md §4.11b（圆环+方框视觉）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.7（两层状态 UI）
 *       specs/tech/version_logs/v0.0.42/change_log.md 块2
 *
 * 渲染条件：session.running === true（running bool = state∈{running, interrupting}）。
 *   running + interrupting 态均渲染；idle/interrupted/error 不渲染（由父级 ComponentRunStateAbortSlot 门控）。
 *
 * 视觉：
 *   - 外圈旋转环（accent border + animate-spin）+ 中心实心方框（stop icon）。
 *   - interrupting 态圆环减速（duration 1s → 2.5s）做视觉反馈。
 *
 * 行为：点击 → POST /session/:id/abort（202，fire-and-forget）→ 按钮立即本地 disabled（防连点）；
 *   state 转 interrupting 后圆环减速但仍可见；转 interrupted 后父级不再渲染本组件。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StopIcon } from './icons';
import { CHAT_ACTION_BTN_CLS } from './action-button-styles';

/** session 状态机子集（仅关心 running / interrupting 两态，其余态本组件不渲染） */
export type AbortSessionState = 'running' | 'interrupting';

interface AbortBtnProps {
  /** 当前 session id */
  sessionId: string;
  /**
   * session 状态（running / interrupting）—— 切换圆环 animation-duration 做减速视觉反馈。
   * 默认 'running'（caller 未透传时按正常速度转）。
   */
  sessionState?: AbortSessionState;
  /** 点击 abort 后回调（父级发起 POST /abort） */
  onAbort?: (sessionId: string) => void;
}

/**
 * 中断按钮（圆环视觉）。组件内部维护 disabled 本地态（点击后立即禁用，等父级因 running=false 卸载）。
 *
 * interrupting 减速实现：CSS `animation-duration` 按 sessionState 切换（running=1s / interrupting=2.5s）。
 */
export function ComponentAbortBtn({ sessionId, sessionState = 'running', onAbort }: AbortBtnProps) {
  const [disabled, setDisabled] = useState(false);
  const { t } = useTranslation('chat');

  function handleClick() {
    if (disabled) return;
    setDisabled(true); // 防连点（§4.11b）
    onAbort?.(sessionId);
  }

  // 圆环 animation-duration 按 sessionState 切换：running=1s，interrupting=2.5s（减速视觉反馈）
  const ringDuration = sessionState === 'interrupting' ? '2.5s' : '1s';

  return (
    <button
      type="button"
      data-action-key="chat.run.abort"
      data-session-state={sessionState}
      onClick={handleClick}
      disabled={disabled}
      aria-label={t('abort.ariaLabel')}
      title={t('abort.title')}
      style={{ animationDuration: ringDuration }}
      className={
        // 统一 21px（CHAT_ACTION_BTN_CLS），与 picker/send 同高
        CHAT_ACTION_BTN_CLS +
        ' relative rounded-full transition-opacity ' +
        (disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:opacity-80')
      }
    >
      {/* 外圈旋转环（accent border + animate-spin，duration 按 sessionState 切换） */}
      <span
        aria-hidden
        className="absolute inset-0 rounded-full border-[1.5px] border-[var(--color-border-strong)] border-t-[var(--color-accent)] animate-spin"
        style={{ animationDuration: ringDuration }}
      />
      {/* 中心实心方框（stop icon，size=11） */}
      <span className="relative flex items-center justify-center text-fg-2">
        <StopIcon size={11} />
      </span>
    </button>
  );
}

export default ComponentAbortBtn;
