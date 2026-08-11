/**
 * component-preview-dirty-modal —— dirty 守卫确认 modal（v0.0.320 D4）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D4（dirty 守卫契约）+ 文件清单 #19
 *
 * 三选：保存并切换 / 放弃修改 / 取消。L3 Portal（对齐 modal-md-editor：
 * overlay-root pointer-events:none 可继承 → 根节点显式 pointer-events-auto）。
 * 非 SaveBar（预览区范式归属 = 确认 modal，见 change_plan 范式归属表）。
 */
import { useTranslation } from 'react-i18next';
import { Portal } from '../../lib/portal';
import { BTN_PRIMARY, BTN_SECONDARY } from '../academy-page/academy-styles';
import type { DirtyAction } from './preview-tabs-types';

interface ComponentPreviewDirtyModalProps {
  /** 待确认文件名（title/body 文案用） */
  fileName: string;
  /** 用户选择回调（save-switch / discard / cancel） */
  onResolve: (action: DirtyAction) => void;
}

/**
 * dirty 守卫确认 modal。点击遮罩 = 取消（防误丢输入，对齐 modal-md-editor 关闭语义）。
 */
export function ComponentPreviewDirtyModal({ fileName, onResolve }: ComponentPreviewDirtyModalProps) {
  const { t } = useTranslation('chat');
  return (
    <Portal>
      <div
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center pointer-events-auto"
        style={{ background: 'rgba(10,10,10,.4)' }}
        data-testid="pv-dirty-modal"
        onClick={() => onResolve('cancel')}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('workspace.preview.dirtyTitle', { name: fileName })}
          className="w-[440px] max-w-[92vw] bg-surface rounded-xl shadow-lg flex flex-col overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-[18px] py-[14px] border-b border-border shrink-0 text-[14px] font-semibold text-fg">
            {/* [ET-fix BLOCKING1] {{name}} 插值：标题带文件名（原实现漏传参渲染字面量） */}
            {t('workspace.preview.dirtyTitle', { name: fileName })}
          </div>
          <div className="px-[18px] py-3 text-[12.5px] text-fg-2">
            {t('workspace.preview.dirtyBody', { name: fileName })}
          </div>
          <div className="flex items-center justify-end gap-2 px-[18px] py-3 border-t border-border shrink-0">
            <button type="button" data-testid="pv-dirty-cancel" onClick={() => onResolve('cancel')} className={BTN_SECONDARY}>
              {t('workspace.preview.dirtyCancel')}
            </button>
            <button type="button" data-testid="pv-dirty-discard" onClick={() => onResolve('discard')} className={BTN_SECONDARY}>
              {t('workspace.preview.dirtyDiscard')}
            </button>
            <button type="button" data-testid="pv-dirty-save" onClick={() => onResolve('save-switch')} className={BTN_PRIMARY}>
              {t('workspace.preview.dirtySaveSwitch')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default ComponentPreviewDirtyModal;
