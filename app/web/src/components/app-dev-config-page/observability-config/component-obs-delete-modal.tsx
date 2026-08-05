/**
 * component-obs-delete-modal — 删除可观测性配置的二次确认 modal
 * 参考: specs/ui/components/app-dev-config-page/observability-config/component-obs-delete-modal.md
 *       设计稿视觉基线: reqs/v0.0.11/easy-opc-config-v10.html L440-456
 *
 * 职责：点遮罩 / 取消 / 关闭 → 取消；「确认删除」→ 执行删除。
 * 交互：ESC → onCancel；modal 内点击 stopPropagation（不冒泡到遮罩）。
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { ObservabilityConfig } from './types';

interface ComponentObsDeleteModalProps {
  /** 待删项 */
  target: ObservabilityConfig;
  /** 取消（遮罩点击 / 取消按钮 / 关闭图标 / ESC） */
  onCancel: () => void;
  /** 确认删除 → 回调 target.id */
  onConfirm: (id: string) => void;
}

/** 删除确认 modal */
export function ComponentObsDeleteModal({ target, onCancel, onConfirm }: ComponentObsDeleteModalProps) {
  // [v0.0.62 i18n] 删除标题/正文走 app-dev-config ns；通用关闭/取消/确认删除走 common ns
  const { t } = useTranslation('common');
  const { t: ta } = useTranslation('app-dev-config');
  // ESC 关闭（标准 modal 行为）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div

      onClick={onCancel}
      className="fixed inset-0 bg-[rgba(30,25,20,0.4)] backdrop-blur-[4px] z-[200] flex items-center justify-center"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface border border-border-2 rounded-[14px] shadow-xl w-[420px] max-w-[90vw]"
      >
        {/* header */}
        <div className="px-6 pt-5 pb-3 flex justify-between items-center">
          <h3 className="text-[16px] font-bold text-fg">
            {ta('observability.deleteTitle')}
          </h3>
          <button
            type="button"
            data-action-key="settings.observability.close-delete"
            aria-label={t('modal.close')}
            onClick={onCancel}
            className="w-7 h-7 rounded-md flex items-center justify-center text-muted-2 transition-colors hover:bg-bg-warm"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* body */}
        <div className="px-6 pb-5 text-[13px] text-muted-2">
          {ta('observability.deleteBody', { name: target.name || ta('observability.unnamed') })}
        </div>
        {/* footer */}
        <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
          <button
            type="button"
            data-action-key="settings.observability.cancel-delete"
            onClick={onCancel}
            className="px-4 py-1.5 rounded-md border border-border text-fg-2 text-sm transition-colors hover:bg-bg-warm"
          >
            {t('action.cancel')}
          </button>
          <button
            type="button"
            data-action-key="settings.observability.confirm-delete"
            onClick={() => onConfirm(target.id)}
            className="px-4 py-1.5 rounded-md bg-red-600 text-white text-sm font-medium transition-colors hover:bg-red-700"
          >
            {t('modal.deleteTitle')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ComponentObsDeleteModal;
