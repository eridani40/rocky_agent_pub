/**
 * component-manage-tab —— 管理 tab（squad 元信息编辑 + 危险操作区）
 * 参考: specs/ui/overall/06-studio.md（squad-name-input/squad-model-input/squad-admin-save）
 *       specs/ui/components/studio-page/squad-panel.md（description 编辑唯一入口 squad-admin-desc-input）
 *
 * 职责：squad name/description/modelDefault 编辑（PATCH /squad）
 *   + 底部危险操作区 team 硬删除入口（SquadDeleteSection）。自主性 infra（toggle + budget）在 autowork-tab。
 * 边界：meta 改动 → squad-admin-save（PATCH /squad 合并字段）；删除 → onDelete 上抛父级。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PatchSquadBody, SquadDetail, SaveBarController } from './squad-types';
import { SquadDeleteSection } from './component-squad-delete';
import { GroupChatToggle } from './component-group-chat-toggle';
import { Dropdown } from './component-shared-selector';
import { INPUT, TEXTAREA, FIELD_LABEL } from './studio-styles';
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
  /** [v0.0.317] 上推 SaveBarController 给 SeatsPanel（面板级统一 SaveBar） */
  onSaveBarChange?: (ctrl: SaveBarController | null) => void;
}

/** 管理 tab 内容 */
export function ManageTab({ detail, onSaveMeta, onDelete, onSaveBarChange }: ManageTabProps) {
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
  // [v0.0.316] 群聊开关 draft state（攒入 dirty，与元信息一起统一 save）
  const [enableGroupChat, setEnableGroupChat] = useState(detail.enableGroupChat);
  const [saving, setSaving] = useState(false);

  // [v0.0.317] detail 变化时同步 draft（save 成功后 detail prop 更新 → draft 跟上 → dirty 清零）
  useEffect(() => {
    setName(detail.name);
    setDescription(detail.description);
    setModelDefaultSel(
      detail.modelDefault
        ? { providerId: detail.modelDefaultProviderId ?? '', modelId: detail.modelDefault }
        : null,
    );
    setEffortDefault(detail.effortDefault);
    setEnableGroupChat(detail.enableGroupChat);
  }, [detail]);

  const dirty =
    name !== detail.name ||
    description !== detail.description ||
    // 复合 dirty 判定：modelId 或 providerId 任一变 → dirty
    (modelDefaultSel?.modelId ?? '') !== detail.modelDefault ||
    (modelDefaultSel?.providerId ?? '') !== (detail.modelDefaultProviderId ?? '') ||
    // [v0.0.279] 推理强度变更 → dirty
    effortDefault !== detail.effortDefault ||
    // [v0.0.316] 群聊开关变更 → dirty
    enableGroupChat !== detail.enableGroupChat;

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
        // [v0.0.316] 群聊开关（与元信息一起落盘）
        enableGroupChat,
      });
    } finally {
      setSaving(false);
    }
  };

  /** [v0.0.317] cancel：draft 回 detail 原值（SaveBar cancel 语义） */
  const cancel = () => {
    setName(detail.name);
    setDescription(detail.description);
    setModelDefaultSel(
      detail.modelDefault
        ? { providerId: detail.modelDefaultProviderId ?? '', modelId: detail.modelDefault }
        : null,
    );
    setEffortDefault(detail.effortDefault);
    setEnableGroupChat(detail.enableGroupChat);
  };

  /** [v0.0.317] 上推 SaveBarController 给 SeatsPanel（dirty/saving 变化时重新上报） */
  const ctrl: SaveBarController = { dirty, saving, save, cancel };
  useEffect(() => {
    onSaveBarChange?.(ctrl);
    return () => onSaveBarChange?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saving]);

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
          // [v0.0.344] 加宽：w-full 跟随容器（对齐同区域 INPUT/Dropdown），长模型名（minimax-xxx/deepseek-xxx）完整显示
          triggerClassName="w-full whitespace-nowrap overflow-hidden text-ellipsis"
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
      {/* [v0.0.317] 底部保存按钮去掉——改由 SeatsPanel 面板级 SaveBar 统一驱动 */}

      {/* [v0.0.316] 群聊可见性开关（受控化——攒入 dirty，与元信息一起统一 save） */}
      <div className="mb-5">
        <GroupChatToggle
          enableGroupChat={enableGroupChat}
          onChange={setEnableGroupChat}
        />
      </div>

      {/* 危险操作区：team 硬删除（解散） */}
      <SquadDeleteSection squadName={detail.name} onDelete={onDelete} />
    </div>
  );
}

export default ManageTab;
