/**
 * component-new-squad-modal —— 新建 squad wizard（弹层）
 * 参考: specs/ui/components/studio-page/new-squad-wizard.md（视觉基线）
 *       specs/ui/overall/06-studio.md §6（字段 + testid）；11a §1.1（POST /squad body）
 *       设计稿: reqs/[done] v0.0.33.1/new-squad.html / studio-main.html NewSquadModal
 *
 * 职责：填 name/description/modelDefault/leader.name →
 *   POST /squad（建 squad + leader + 群聊 + 目录骨架）→ 成功跳转新 squad 面板。
 * 边界：API 要求 name/modelDefault/leader.name 非空（提交按钮据此 disabled）。提交/取消上抛父级。
 * modelDefault 用 ModelPicker（复用 chat/ModelPicker）从已配置 provider/model 选，
 *   杜绝手填非法 modelId 入库（激活时 ModelNotFoundError）。
 *   选中存 modelId（CreateSquadBody.modelDefault 仍为 string，providerId 由后端 resolveProviderModel 跨 provider 搜）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CreateSquadBody } from './squad-types';
import { ModalShell } from './component-modal-shell';
import { Icon } from './studio-icons';
import { INPUT, TEXTAREA, FIELD_LABEL, BTN_SECONDARY, BTN_PRIMARY } from './studio-styles';
import { ModelPicker } from '../chat/ModelPicker';
import type { ModelSelection } from '../../lib/providers';

interface NewSquadModalProps {
  onClose: () => void;
  /** 提交建 squad（POST /squad）→ 父级刷新 + 选中新 squad */
  onCreate: (body: CreateSquadBody) => Promise<void>;
}

/** 新建 squad wizard */
export function NewSquadModal({ onClose, onCreate }: NewSquadModalProps) {
  const { t } = useTranslation(['studio', 'common']);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // 模型选择：null = 未选（提交 disabled）。删原硬编码非法默认值 'claude-sonnet'。
  const [modelSel, setModelSel] = useState<ModelSelection | null>(null);
  const [leaderName, setLeaderName] = useState('Rocky');
  const [submitting, setSubmitting] = useState(false);

  const valid =
    name.trim().length > 0 && modelSel !== null && leaderName.trim().length > 0;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const body: CreateSquadBody = {
        name: name.trim(),
        description: description.trim() || undefined,
        // [v0.0.155] modelDefault 复合：同时落 modelId + providerId（消除同名歧义；providerId 由前端 picker 直接提供）
        modelDefault: modelSel!.modelId,
        modelDefaultProviderId: modelSel!.providerId,
        leader: { name: leaderName.trim() },
      };
      await onCreate(body);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalShell

      title={t('studio:newSquadModal.title')}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={BTN_SECONDARY}>
            {t('common:action.cancel')}
          </button>
          <button type="button" data-action-key="studio.squad.create" disabled={!valid || submitting} onClick={() => void submit()} className={BTN_PRIMARY}>
            <Icon name="check" size={12} /> {submitting ? t('studio:newSquadModal.creating') : t('studio:newSquadModal.create')}
          </button>
        </>
      }
    >
      <div className="mb-[18px]">
        <label className={FIELD_LABEL}>{t('studio:newSquadModal.nameLabel')}</label>
        <input className={INPUT} value={name} placeholder={t('studio:newSquadModal.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="mb-[18px]">
        <label className={FIELD_LABEL}>{t('studio:newSquadModal.descLabel')}</label>
        <textarea className={TEXTAREA} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="mb-[18px]">
        <label className={FIELD_LABEL}>{t('studio:newSquadModal.modelLabel')}</label>
        <ModelPicker value={modelSel} onChange={setModelSel} actionKey="studio.squad.select-default-model" />
      </div>
      <div className="mb-[18px]">
        <label className={FIELD_LABEL}>{t('studio:newSquadModal.leaderNameLabel')}</label>
        <input className={INPUT} value={leaderName} onChange={(e) => setLeaderName(e.target.value)} />
      </div>
    </ModalShell>
  );
}

export default NewSquadModal;
