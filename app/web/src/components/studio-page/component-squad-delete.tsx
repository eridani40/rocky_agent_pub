/**
 * component-squad-delete —— 管理 tab 底部「危险操作区」：team 硬删除（解散）入口
 * 参考: specs/ui/components/studio-page/component-squad-delete.md
 *       specs/tech/version_logs/v0.0.111/change_plan.md 块②（DELETE /squad/:id 硬删）
 *
 * 职责：删除按钮 + 二次确认弹层（复用 ModalShell）。须**输入完整队名匹配**才启用「确认删除」，
 *   防误删；确认后 await onDelete()，期间弹层保持 + 确认按钮 loading + 不可关闭；
 *   成功（onDelete resolve true）才关弹层，失败（resolve false）保留弹层可重试。
 * 边界：仅渲染 UI + 上抛，不含 API 调用；队名匹配校验在本组件。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModalShell } from './component-modal-shell';
import { SpinnerRing } from '../common/spinner-ring';
import { INPUT, FIELD_LABEL, BTN_SECONDARY, BTN_DANGER } from './studio-styles';

interface SquadDeleteSectionProps {
  /** 当前队名（二次确认须精确输入匹配） */
  squadName: string;
  /** 确认删除 → 父级发 DELETE /squad/:id；返回 true=成功（本组件据此关弹层）/ false=失败（保持打开可重试） */
  onDelete: () => Promise<boolean>;
}

/** 危险操作区 + 硬删除二次确认弹层 */
export function SquadDeleteSection({ squadName, onDelete }: SquadDeleteSectionProps) {
  const { t } = useTranslation(['studio', 'common']);
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  // submitting = 删除请求 in-flight：弹层不可关、按钮 disabled + 文案切换 + spinner
  const [submitting, setSubmitting] = useState(false);
  // 输入必须精确匹配队名才启用确认（防误删）
  const matched = confirmText.trim() === squadName;

  const close = () => {
    if (submitting) return;
    setOpen(false);
    setConfirmText('');
  };

  const confirm = async () => {
    if (!matched || submitting) return;
    setSubmitting(true);
    try {
      const ok = await onDelete();
      if (ok) {
        setOpen(false);
        setConfirmText('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-6 border-t border-border pt-5">
      {/* 危险操作区标题 + 说明 */}
      <div className={FIELD_LABEL + ' text-danger'}>{t('studio:deleteSquad.sectionLabel')}</div>
      <p className="mb-3 text-[12.5px] leading-relaxed text-muted">{t('studio:deleteSquad.hint')}</p>
      <button
        type="button"
        data-action-key="studio.squad.delete"
        onClick={() => setOpen(true)}
        className={BTN_DANGER}
      >
        {t('studio:deleteSquad.btn')}
      </button>

      {open && (
        <ModalShell

          title={t('studio:deleteSquad.modalTitle', { name: squadName })}
          onClose={close}
          widthPx={420}
          footer={
            <>
              <button
                type="button"
                onClick={close}
                disabled={submitting}
                className={BTN_SECONDARY + ' disabled:opacity-40 disabled:cursor-not-allowed'}
              >
                {t('common:action.cancel')}
              </button>
              <button
                type="button"
                data-action-key="studio.squad.confirm-delete"
                disabled={!matched || submitting}
                onClick={() => void confirm()}
                className={BTN_DANGER + (matched && !submitting ? '' : ' opacity-40 cursor-not-allowed')}
              >
                {submitting && <SpinnerRing size="sm" />}
                {submitting ? t('studio:deleteSquad.confirming') : t('studio:deleteSquad.confirm')}
              </button>
            </>
          }
        >
          <p className="mb-3 text-[12.5px] leading-relaxed text-fg-2">
            {t('studio:deleteSquad.warning')}
          </p>
          {/* v0.0.315: 去掉 uppercase——confirmLabel 含 squadName，须保持原始大小写让用户精确输入匹配 */}
          <label className={FIELD_LABEL.replace(' uppercase', '')}>{t('studio:deleteSquad.confirmLabel', { name: squadName })}</label>
          <input

            className={INPUT}
            value={confirmText}
            placeholder={squadName}
            onChange={(e) => setConfirmText(e.target.value)}
            autoFocus
          />
        </ModalShell>
      )}
    </div>
  );
}

export default SquadDeleteSection;
