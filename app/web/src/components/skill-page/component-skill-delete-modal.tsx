/**
 * component-skill-delete-modal — Skill 删除确认 modal
 * 参考: specs/ui/components/skill-page/component-skill-delete-modal.md
 *       设计稿视觉基线: reqs/v0.0.21/easy-opc-skill-v10.html .modal-overlay/.modal/.modal-header/.modal-body/.modal-footer/.modal-close/.btn-danger/.btn-secondary (:70-77, :58-61)
 *
 * [v0.0.21] 决策：物理删除（不可撤销，符合设计稿文案「此操作无法撤销」）。
 * 只管确认 UI + 回调；实际 DELETE 由 page 调后端。
 */
import { useTranslation } from 'react-i18next';
import type { SkillEntry } from '../../lib/api-client';

interface SkillDeleteModalProps {
  /** 待删 skill（name 即 id） */
  skill: SkillEntry;
  /** 取消 */
  onCancel: () => void;
  /** 确认删除（page → 后端 DELETE → 关闭 + 刷新） */
  onConfirm: (name: string) => void;
  /** 删除进行中禁用按钮（可选） */
  deleting?: boolean;
}

/**
 * 渲染删除确认 modal。视觉对齐设计稿 .modal：宽 420px（max 90vw），rounded-14px，
 * header(title + close) → body(skill name strong 强调 + 警告) → footer(取消 + danger 确认)。
 */
export function ComponentSkillDeleteModal({ skill, onCancel, onConfirm, deleting = false }: SkillDeleteModalProps) {
  // [v0.0.62 i18n] 删除标题/正文走 skill ns；通用关闭/取消/确认删除走 common ns
  const { t } = useTranslation('common');
  const { t: ts } = useTranslation('skill');
  return (
    <div

      className="fixed inset-0 flex items-center justify-center z-[200]"
      style={{ background: 'rgba(30,25,20,0.4)', backdropFilter: 'blur(4px)' }}
      onClick={onCancel}
    >
      <div

        className="bg-surface border border-border-2 rounded-[14px]"
        style={{ width: '420px', maxWidth: '90vw', boxShadow: '0 16px 48px rgba(40,30,20,0.2)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* header：title + close */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <div className="text-[16px] font-bold text-fg">
            {ts('deleteModal.title')}
          </div>
          <button
            type="button"
            data-action-key="skill.skill.close-delete"
            onClick={onCancel}
            aria-label={t('modal.close')}
            className="w-7 h-7 rounded-md flex items-center justify-center text-muted hover:bg-bg-warm hover:text-fg transition-colors"
          >
            <CloseIcon />
          </button>
        </div>

        {/* body：skill name strong 强调 + 警告文案 */}
        <div

          className="px-6 pb-5 text-[13px] text-muted-2"
        >
          {ts('deleteModal.body', { name: skill.name })}
        </div>

        {/* footer：取消（secondary）+ 确认删除（danger） */}
        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
          <button
            type="button"
            data-action-key="skill.skill.cancel-delete"
            onClick={onCancel}
            disabled={deleting}
            className="px-4 py-2 rounded-md text-[12px] font-semibold border border-border-2 bg-surface-2 text-fg-3 hover:border-accent hover:text-accent transition-colors disabled:opacity-50"
          >
            {t('action.cancel')}
          </button>
          <button
            type="button"
            data-action-key="skill.skill.confirm-delete"
            onClick={() => onConfirm(skill.name)}
            disabled={deleting}
            className="px-4 py-2 rounded-md text-[12px] font-semibold border-none bg-danger text-white hover:brightness-110 transition-filter disabled:opacity-50"
          >
            {t('modal.deleteTitle')}
          </button>
        </div>
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export default ComponentSkillDeleteModal;
