/**
 * component-modal-shell —— Studio 弹层外壳（遮罩 + 卡片 + head/body/foot）
 * 参考: specs/ui/components/studio-page/new-squad-wizard.md（视觉基线）
 *       设计稿: reqs/[done] v0.0.33.1/studio-main.html .modal-mask / .modal
 *
 * 职责：统一弹层骨架（遮罩点击关闭 + 标题 + 关闭按钮 + 滚动 body + 底部操作区）。
 *   被 new-squad-wizard / hire-modal / bench-modal 复用。
 * 边界：不含具体表单字段（由 children 传入）；遮罩点击/关闭按钮均触发 onClose。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './studio-icons';

interface ModalShellProps {
  /** 标题 */
  title: string;
  /** 关闭回调（遮罩点击 + 右上角 X） */
  onClose: () => void;
  /** body 内容 */
  children: ReactNode;
  /** 底部操作区（按钮组） */
  footer?: ReactNode;
  /** 容器 testid */
  /** 自定义宽度（默认 520px；bench 等小弹层可传 420） */
  widthPx?: number;
}

/** 弹层外壳：遮罩居中 + 卡片（head/body/foot）—— 视觉 token 严格对齐设计稿 reqs/[done] v0.0.33.1/*.html
 *  - 卡片圆角 14px（设计稿 .modal border-radius:14px；不用 rounded-xl=12px 偏小）
 *  - head/body/foot padding 严格对齐设计稿 .modal-head(18 22 12) / .modal-body(0 22 20) / .modal-foot(14 22)
 *  - 遮罩 rgba(30,25,20,0.45) 中性暖灰 + backdrop-blur-sm（设计稿 .stage） */
export function ModalShell({ title, onClose, children, footer, widthPx = 520 }: ModalShellProps) {
  const { t } = useTranslation('common');
  return (
    // 遮罩：fixed 全屏 + 半透明 + 模糊，点击空白关闭（设计稿 .stage rgba(30,25,20,.45)）
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[rgba(30,25,20,0.45)] backdrop-blur-sm"
      onClick={onClose}
    >
      {/* 卡片：阻止冒泡，避免点内容误关；圆角 14px 严格对齐设计稿 .modal */}
      <div

        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        style={{ width: widthPx }}
        className="flex max-h-[88vh] max-w-[92vw] flex-col rounded-[14px] border border-border-2 bg-surface shadow-2xl"
      >
        <div className="flex shrink-0 items-center justify-between px-[22px] pt-[18px] pb-3">
          <div className="text-[15px] font-bold text-fg">{title}</div>
          <button
            type="button"

            aria-label={t('modal.close')}
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-warm hover:text-fg"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="overflow-y-auto px-[22px] pb-5">{children}</div>
        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-[22px] py-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export default ModalShell;
