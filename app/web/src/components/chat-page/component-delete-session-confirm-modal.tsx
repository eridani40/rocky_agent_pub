/**
 * component-delete-session-confirm-modal —— 删除会话确认 modal
 * 参考: component-clear-confirm-modal.tsx（同模块 destructive 确认 modal 范式）
 *
 * 列表项「删除」按钮点击 → 父（section-conv-panel）拦截弹本 modal 二次确认 → 确认后才真删。
 * 避免 hover 误点直接删除会话（不可撤销）。
 *
 * body 带 session title 插值，提示用户即将删的是哪条会话。
 *
 * L3 modal（_layering.md §3A）：包 <Portal> 到 overlay-root，z=`--z-modal`(1000) +
 * pointer-events-auto（与其他 L3 modal 统一）。open=false 时 return null。
 */
import { useTranslation } from 'react-i18next';
import { Portal } from '../../lib/portal';

interface DeleteSessionConfirmModalProps {
  /** 是否显示 */
  open: boolean;
  /** 待删会话 title（body 插值用） */
  sessionTitle?: string;
  /** 确认 → DELETE /session/:id（caller 实现） */
  onConfirm: () => void;
  /** 取消 → 关闭 modal，不动 */
  onCancel: () => void;
}

/**
 * 删除会话确认 modal。点 overlay 背景或取消按钮 → onCancel；点确认 → onConfirm。
 */
export function ComponentDeleteSessionConfirmModal({
  open,
  sessionTitle,
  onConfirm,
  onCancel,
}: DeleteSessionConfirmModalProps) {
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');
  if (!open) return null;

  return (
    <Portal>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('conversation.delete.dialogTitle')}
        // z=`--z-modal`(1000) + pointer-events-auto（与其他 L3 modal 统一）
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40 pointer-events-auto"
        onClick={onCancel}
      >
        <div
          className="bg-surface border border-border rounded-xl shadow-lg max-w-[400px] w-[90%] p-5"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="text-[15px] font-semibold text-fg mb-2">{t('conversation.delete.dialogTitle')}</h3>
          <p className="text-[13px] text-muted leading-relaxed mb-5">
            {t('conversation.delete.dialogBody', { title: sessionTitle ?? '' })}
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              data-action-key="chat.session.cancel-delete"
              onClick={onCancel}
              className="px-3 py-1.5 rounded-lg text-[13px] text-muted hover:bg-bg-warm transition-colors"
            >
              {tCommon('action.cancel')}
            </button>
            <button
              type="button"
              data-action-key="chat.session.delete"
              onClick={onConfirm}
              className="px-3 py-1.5 rounded-lg text-[13px] text-[var(--btn-danger-fg)] bg-[var(--btn-danger-bg)] hover:bg-[var(--danger)] transition-colors"
            >
              {tCommon('action.delete')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default ComponentDeleteSessionConfirmModal;
