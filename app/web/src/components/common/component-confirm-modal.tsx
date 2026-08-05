/**
 * component-confirm-modal — 通用确认 modal（v0.0.89 从 page-app-settings-merged 抽出）
 * 参考: specs/ui/components/app-dev-config-page/page-app-settings-merged.md（dirty 切 tab 确认）
 *
 * 职责：危险操作前的确认 modal（如丢弃未保存改动）。纯受控（open 由父级管理）。
 * 布局：fixed inset-0 半透明遮罩 + 居中 card；title + body + 取消/确认 两按钮。
 *
 * 边界：不持业务态；单文件 ≤ 60 行。
 */
interface ConfirmModalProps {
  title: string;
  body: string;
  okLabel: string;
  cancelLabel: string;
  onOk: () => void;
  onCancel: () => void;
}

/** 通用确认 modal（遮罩 + 居中 card） */
export function ConfirmModal({
  title,
  body,
  okLabel,
  cancelLabel,
  onOk,
  onCancel,
}: ConfirmModalProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"

      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    >
      <div className="rounded-lg bg-surface border border-border p-6 max-w-sm w-full mx-4 shadow-lg">
        <h3 className="text-[15px] font-semibold text-fg mb-2">{title}</h3>
        <p className="text-[13px] text-muted-2 mb-4 leading-relaxed">{body}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            data-action-key="common.confirm-modal.cancel"
            onClick={onCancel}
            className="px-4 py-1.5 rounded-md text-sm border border-border text-fg-2 hover:bg-bg-warm"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-action-key="common.confirm-modal.confirm"
            onClick={onOk}
            className="px-4 py-1.5 rounded-md text-sm bg-accent text-white hover:opacity-90"
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmModal;
