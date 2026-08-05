/**
 * component-clear-confirm-modal —— 清空会话确认 modal（§3.4）
 * 参考: specs/ui/components/chat-page/component-usage-panel.md §3.4（ClearBtn + 确认 modal）
 *
 * 标题「清空会话」+ 说明「将清除当前会话的所有消息、整理记录、运行历史与累积用量，操作不可撤销。」
 * + 确认（danger 色）/ 取消。
 *
 * testid（ET 锚点，逐字对齐 component-usage-panel.md §5）：
 *   - clear-confirm-modal（容器）
 *   - clear-confirm-ok（确认按钮）
 *   - clear-confirm-cancel（取消按钮）
 */
import { useTranslation } from 'react-i18next';
import { Portal } from '../../lib/portal';

interface ClearConfirmModalProps {
  /** 是否显示 */
  open: boolean;
  /** 确认 → POST /session/:id/clear（caller 实现） */
  onConfirm: () => void;
  /** 取消 → 关闭 modal，不动 */
  onCancel: () => void;
}

/**
 * 清空会话确认 modal。open=false 时不渲染（caller 保留占位无位移由 caller 保证）。
 * 点 overlay 背景或取消按钮 → onCancel；点确认 → onConfirm。
 *
 * L3 modal（_layering.md §3A）：包 <Portal> 到 overlay-root 统一规矩，不靠 caller 不在
 * pointer-events:none 链里的侥幸。open=false 时 return null（Portal 容许 children null）。
 */
export function ComponentClearConfirmModal({
  open,
  onConfirm,
  onCancel,
}: ClearConfirmModalProps) {
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');
  if (!open) return null;

  return (
    <Portal>
    <div

      // z=`--z-modal`(1000) + pointer-events-auto（与其他 L3 modal 统一）
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40 pointer-events-auto"
      onClick={onCancel}
    >
      <div
        className="bg-surface border border-border rounded-xl shadow-lg max-w-[400px] w-[90%] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[15px] font-semibold text-fg mb-2">{t('clearConfirm.title')}</h3>
        <p className="text-[13px] text-muted leading-relaxed mb-5">{t('clearConfirm.body')}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-action-key="chat.session.cancel-clear"
            onClick={onCancel}
            className="px-3 py-1.5 rounded-lg text-[13px] text-muted hover:bg-bg-warm transition-colors"
          >
            {tCommon('action.cancel')}
          </button>
          <button
            type="button"
            data-action-key="chat.session.clear"
            onClick={onConfirm}
            className="px-3 py-1.5 rounded-lg text-[13px] text-[var(--btn-danger-fg)] bg-[var(--btn-danger-bg)] hover:bg-[var(--danger)] transition-colors"
          >
            {t('clearConfirm.confirm')}
          </button>
        </div>
      </div>
    </div>
    </Portal>
  );
}

export default ComponentClearConfirmModal;
