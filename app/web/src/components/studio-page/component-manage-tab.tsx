/**
 * component-manage-tab —— 管理 tab（squad 元信息编辑 + 危险操作区）
 * 参考: specs/ui/overall/06-studio.md（squad-name-input/squad-model-input/squad-admin-save）
 *       specs/ui/components/studio-page/squad-panel.md（description 编辑唯一入口 squad-admin-desc-input）
 *
 * 职责：squad name/description/modelDefault 编辑（PATCH /squad）
 *   + 底部危险操作区 team 硬删除入口（SquadDeleteSection）。自主性 infra（toggle + budget）在 autowork-tab。
 * 边界：meta 改动 → squad-admin-save（PATCH /squad 合并字段）；删除 → onDelete 上抛父级。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PatchSquadBody, SquadDetail } from './squad-types';
import { SquadDeleteSection } from './component-squad-delete';
import { Icon } from './studio-icons';
import { INPUT, TEXTAREA, FIELD_LABEL, BTN_PRIMARY } from './studio-styles';
import { ModelPicker } from '../chat/ModelPicker';
import type { ModelSelection } from '../../lib/providers';

interface ManageTabProps {
  detail: SquadDetail;
  onSaveMeta: (patch: PatchSquadBody) => Promise<void>;
  /** team 硬删除（解散）→ 父级发 DELETE /squad/:id；返回 true=成功 / false=失败（弹层据此决定是否关） */
  onDelete: () => Promise<boolean>;
}

/** 管理 tab 内容 */
export function ManageTab({ detail, onSaveMeta, onDelete }: ManageTabProps) {
  const { t } = useTranslation(['studio', 'common']);
  const [name, setName] = useState(detail.name);
  const [description, setDescription] = useState(detail.description);
  // modelDefault 存复合 ModelSelection（providerId+modelId），空 modelDefault → null。
  const [modelDefaultSel, setModelDefaultSel] = useState<ModelSelection | null>(
    detail.modelDefault
      ? { providerId: detail.modelDefaultProviderId ?? '', modelId: detail.modelDefault }
      : null,
  );
  const [saving, setSaving] = useState(false);

  const dirty =
    name !== detail.name ||
    description !== detail.description ||
    // 复合 dirty 判定：modelId 或 providerId 任一变 → dirty
    (modelDefaultSel?.modelId ?? '') !== detail.modelDefault ||
    (modelDefaultSel?.providerId ?? '') !== (detail.modelDefaultProviderId ?? '');

  const save = async () => {
    if (!dirty || !name.trim()) return;
    setSaving(true);
    try {
      await onSaveMeta({
        name: name.trim(),
        description,
        // 复合透传：modelDefault + modelDefaultProviderId 同时落盘
        ...(modelDefaultSel
          ? { modelDefault: modelDefaultSel.modelId, modelDefaultProviderId: modelDefaultSel.providerId }
          : { modelDefault: '' }),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {/* squad 元信息 */}
      <div className="mb-4">
        <label className={FIELD_LABEL}>{t('studio:manageTab.nameLabel')}</label>
        <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="mb-4">
        <label className={FIELD_LABEL}>{t('studio:manageTab.descLabel')}</label>
        <textarea

          className={TEXTAREA}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="mb-4">
        <label className={FIELD_LABEL}>{t('studio:manageTab.modelLabel')}</label>
        {/* ModelPicker 复合：value 直接传 ModelSelection（含 providerId），onChange 透传复合。
            杜绝非法 modelId 入库；同时落 providerId 消除同名歧义。 */}
        <ModelPicker
          actionKey="studio.squad.select-default-model"
          value={modelDefaultSel}
          onChange={(sel) => setModelDefaultSel(sel)}
        />
      </div>
      <div className="mb-5 flex justify-end">
        <button type="button" data-action-key="studio.squad.save" onClick={() => void save()} disabled={!dirty || saving} className={BTN_PRIMARY}>
          <Icon name="check" size={12} /> {saving ? t('common:status.saving') : t('studio:manageTab.save')}
        </button>
      </div>

      {/* 危险操作区：team 硬删除（解散） */}
      <SquadDeleteSection squadName={detail.name} onDelete={onDelete} />
    </div>
  );
}

export default ManageTab;
