/**
 * component-preview-conflict-modal —— 409 冲突确认 modal（v0.0.320 D4）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D4（冲突处理契约）+ 文件清单 #20
 *
 * 两选：取消=reload（以服务端 currentVersion 重读）/ 覆盖=force 重发。L3 Portal
 * （对齐 modal-md-editor：overlay-root pointer-events:none 可继承 → 根节点显式 pointer-events-auto）。
 * 非 SaveBar（预览区范式归属 = 确认 modal，见 change_plan 范式归属表）。
 */
import { useTranslation } from 'react-i18next';
import { Portal } from '../../lib/portal';
import { BTN_PRIMARY, BTN_SECONDARY } from '../academy-page/academy-styles';
import type { ConflictAction } from './preview-tabs-types';

interface ComponentPreviewConflictModalProps {
  /** 待确认文件名（title/body 文案用） */
  fileName: string;
  /** 用户选择回调（reload / overwrite） */
  onResolve: (action: ConflictAction) => void;
}

/**
 * 409 冲突确认 modal。点击遮罩 = reload（取消语义，防误丢输入）。
 */
export function ComponentPreviewConflictModal({ fileName, onResolve }: ComponentPreviewConflictModalProps) {
  const { t } = useTranslation('chat');
  return (
    <Portal>
      <div
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center pointer-events-auto"
        style={{ background: 'rgba(10,10,10,.4)' }}
        data-testid="pv-conflict-modal"
        onClick={() => onResolve('reload')}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('workspace.preview.conflictTitle')}
          className="w-[440px] max-w-[92vw] bg-surface rounded-xl shadow-lg flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-[18px] py-[14px] border-b border-border shrink-0 text-[14px] font-semibold text-fg">
            {t('workspace.preview.conflictTitle')}
          </div>
          <div className="px-[18px] py-3 text-[12.5px] text-fg-2">
            {t('workspace.preview.conflictBody', { name: fileName })}
          </div>
          <div className="flex items-center justify-end gap-2 px-[18px] py-3 border-t border-border shrink-0">
            <button type="button" data-testid="pv-conflict-reload" onClick={() => onResolve('reload')} className={BTN_SECONDARY}>
              {t('workspace.preview.conflictReload')}
            </button>
            <button type="button" data-testid="pv-conflict-overwrite" onClick={() => onResolve('overwrite')} className={BTN_PRIMARY}>
              {t('workspace.preview.conflictOverwrite')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default ComponentPreviewConflictModal;
