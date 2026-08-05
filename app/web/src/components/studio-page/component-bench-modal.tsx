/**
 * component-bench-modal —— 下岗 member 弹层（填 reason）
 * 参考: specs/api/overall/11a-squad-endpoints.md §2.4（bench：reason 必填，leader 403）
 *       设计稿: reqs/[done] v0.0.33.1/studio-main.html BenchModal
 *
 * 职责：弹层填下岗原因 → 确认 → 上抛 onConfirm(reason)。reason 必填（API 空串返 400，UI 同步禁用）。
 * 边界：仅 mate 卡片可触发（leader 无 bench 按钮，UI 双层拒）；确认/关闭上抛父级。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Member } from './squad-types';
import { ModalShell } from './component-modal-shell';
import { TEXTAREA, FIELD_LABEL, BTN_SECONDARY, BTN_DANGER } from './studio-styles';

interface BenchModalProps {
  member: Member;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}

/** 下岗弹层 */
export function BenchModal({ member, onClose, onConfirm }: BenchModalProps) {
  const { t } = useTranslation(['studio', 'common']);
  const [reason, setReason] = useState('');
  const valid = reason.trim().length > 0;
  return (
    <ModalShell

      title={t('studio:benchModal.title', { name: member.name })}
      onClose={onClose}
      widthPx={420}
      footer={
        <>
          <button type="button" onClick={onClose} className={BTN_SECONDARY}>
            {t('common:action.cancel')}
          </button>
          <button
            type="button"
            data-action-key="studio.member.confirm-bench"
            disabled={!valid}
            onClick={() => valid && onConfirm(reason.trim())}
            className={BTN_DANGER + (valid ? '' : ' opacity-40 cursor-not-allowed')}
          >
            {t('studio:benchModal.confirm')}
          </button>
        </>
      }
    >
      <label className={FIELD_LABEL}>{t('studio:benchModal.reasonLabel')}</label>
      <textarea

        className={TEXTAREA}
        value={reason}
        placeholder={t('studio:benchModal.reasonPlaceholder')}
        onChange={(e) => setReason(e.target.value)}
        autoFocus
      />
    </ModalShell>
  );
}

export default BenchModal;
