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
import { GroupChatToggle } from './component-group-chat-toggle';
import { Dropdown } from './component-shared-selector';
import { Icon } from './studio-icons';
import { INPUT, TEXTAREA, FIELD_LABEL, BTN_PRIMARY } from './studio-styles';
import { ModelPicker } from '../chat/ModelPicker';
import type { ModelSelection } from '../../lib/providers';
import type { EffortLevel } from '../chat-page/component-input-effort-picker';

/** [v0.0.279] 团队默认推理强度 4 档（顺序对齐成员级 picker；EFFORT_LEVELS 未 export，本地定义值数组） */
const EFFORT_LEVEL_OPTIONS: EffortLevel[] = ['default', 'low', 'high', 'max'];

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
  // [v0.0.279] 团队默认推理强度（detail 恒有值——后端回显 ?? 'default'）
  const [effortDefault, setEffortDefault] = useState<EffortLevel>(detail.effortDefault);
  const [saving, setSaving] = useState(false);

  const dirty =
    name !== detail.name ||
    description !== detail.description ||
    // 复合 dirty 判定：modelId 或 providerId 任一变 → dirty
    (modelDefaultSel?.modelId ?? '') !== detail.modelDefault ||
    (modelDefaultSel?.providerId ?? '') !== (detail.modelDefaultProviderId ?? '') ||
    // [v0.0.279] 推理强度变更 → dirty
    effortDefault !== detail.effortDefault;

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
        // [v0.0.279] 团队默认推理强度（显式 'default' 也落盘）
        effortDefault,
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
      {/* [v0.0.279] 团队默认推理强度下拉（4 档，恒有值——detail 回显 ?? 'default'） */}
      <div className="mb-4">
        <label className={FIELD_LABEL}>{t('studio:manageTab.effortDefaultLabel')}</label>
        <Dropdown
          value={effortDefault}
          options={EFFORT_LEVEL_OPTIONS.map((l) => ({
            value: l,
            label: t(`studio:manageTab.effortOptions.${l}`),
          }))}
          onChange={(v) => setEffortDefault((v as EffortLevel) ?? 'default')}
          actionKey="studio.squad.select-default-effort"
        />
      </div>
      <div className="mb-5 flex justify-end">
        <button type="button" data-action-key="studio.squad.save" onClick={() => void save()} disabled={!dirty || saving} className={BTN_PRIMARY}>
          <Icon name="check" size={12} /> {saving ? t('common:status.saving') : t('studio:manageTab.save')}
        </button>
      </div>

      {/* [v0.0.292] 群聊可见性开关（从 autowork-tab 迁入；元信息编辑区后、危险操作区前） */}
      <div className="mb-5">
        <GroupChatToggle
          squadId={detail.id}
          enableGroupChat={detail.enableGroupChat}
          onPatch={(patch) => onSaveMeta(patch)}
        />
      </div>

      {/* 危险操作区：team 硬删除（解散） */}
      <SquadDeleteSection squadName={detail.name} onDelete={onDelete} />
    </div>
  );
}

export default ManageTab;
