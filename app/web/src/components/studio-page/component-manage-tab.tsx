/**
 * component-manage-tab —— 管理 tab（squad 元信息编辑 + 危险操作区）
 * 参考: specs/ui/overall/06-studio.md（squad-name-input/squad-model-input/squad-admin-save）
 *       specs/ui/components/studio-page/squad-panel.md（description 编辑唯一入口 squad-admin-desc-input）
 *
 * 职责：squad name/description/模型或方案（单 select 严格互斥二选一）编辑（PATCH /squad）
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
import { ModelOrPlanPicker, type ModelOrPlanValue } from '../common/component-model-or-plan-picker';
import type { EffortLevel } from '../chat-page/component-input-effort-picker';
import { listModelRoutingPlans } from '../app-dev-config-page/model-routing-api';
import type { ModelRoutingPlan } from '../app-dev-config-page/model-routing-types';

/** [v0.0.347 T6] detail → pick 初值（方案优先：存量双设呈现方案对齐 resolve 真值，用户触碰即收敛） */
function derivePick(d: SquadDetail): ModelOrPlanValue | null {
  if (d.modelRoutingPlanId) return { kind: 'plan', planId: d.modelRoutingPlanId, planName: '' };
  if (d.modelDefault) {
    return { kind: 'model', selection: { providerId: d.modelDefaultProviderId ?? '', modelId: d.modelDefault } };
  }
  return null;
}

/** [v0.0.347 T6] pick 相等判定（模型比 providerId+modelId；方案比 planId；null=双空未设置） */
function samePick(a: ModelOrPlanValue | null, b: ModelOrPlanValue | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'model' && b.kind === 'model') {
    return a.selection.providerId === b.selection.providerId && a.selection.modelId === b.selection.modelId;
  }
  if (a.kind === 'plan' && b.kind === 'plan') return a.planId === b.planId;
  return false;
}

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
  // [v0.0.347 T6] 默认模型/方案单 select 合一（严格互斥二选一；方案优先初值；null=未设置）
  const [pick, setPick] = useState<ModelOrPlanValue | null>(() => derivePick(detail));
  // [v0.0.279] 团队默认推理强度（detail 恒有值——后端回显 ?? 'default'）
  const [effortDefault, setEffortDefault] = useState<EffortLevel>(detail.effortDefault);
  // [v0.0.347] 方案库列表（挂载下拉数据源）
  const [routingPlans, setRoutingPlans] = useState<ModelRoutingPlan[]>([]);
  // [v0.0.316] 群聊开关 draft state（攒入 dirty，与元信息一起统一 save）
  const [enableGroupChat, setEnableGroupChat] = useState(detail.enableGroupChat);
  const [saving, setSaving] = useState(false);

  // [v0.0.347] 挂载时拉方案库（供下拉选择）
  useEffect(() => {
    listModelRoutingPlans().then(setRoutingPlans).catch(() => setRoutingPlans([]));
  }, []);

  // [v0.0.317] detail 变化时同步 draft（save 成功后 detail prop 更新 → draft 跟上 → dirty 清零）
  useEffect(() => {
    setName(detail.name);
    setDescription(detail.description);
    setPick(derivePick(detail));
    setEffortDefault(detail.effortDefault);
    setEnableGroupChat(detail.enableGroupChat);
  }, [detail]);

  const dirty =
    name !== detail.name ||
    description !== detail.description ||
    // [v0.0.347 T6] pick 复合 dirty 判定（模型比 providerId+modelId；方案比 planId；null 比双空）
    !samePick(pick, derivePick(detail)) ||
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
        // [v0.0.347 T6 决策㉛ 严格互斥载荷]：pick 是模型 → 双清 planId（null）；
        // pick 是方案 → 显式清空 modelDefault+modelDefaultProviderId（非省略字段）；null=未设置态双清
        ...(pick?.kind === 'model'
          ? {
              modelDefault: pick.selection.modelId,
              modelDefaultProviderId: pick.selection.providerId,
              modelRoutingPlanId: null,
            }
          : pick?.kind === 'plan'
            ? {
                modelRoutingPlanId: pick.planId,
                modelDefault: '',
                modelDefaultProviderId: '',
              }
            : { modelDefault: '', modelDefaultProviderId: '', modelRoutingPlanId: null }),
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
    setPick(derivePick(detail));
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
        {/* [v0.0.347 T6] 单 select 二选一：上组「模型」下组「方案」（严格互斥——pick 合一，方案优先初值）。
            选模型 → 载荷带 planId:null；选方案 → 载荷显式清空 modelDefault+modelDefaultProviderId（save 组装）。 */}
        <ModelOrPlanPicker
          value={pick}
          plans={routingPlans.map((p) => ({ id: p.id, name: p.name }))}
          onPickModel={(sel) => setPick({ kind: 'model', selection: sel })}
          onPickPlan={(planId) => setPick({ kind: 'plan', planId, planName: routingPlans.find((p) => p.id === planId)?.name ?? '' })}
          ns="studio"
          actionKey="studio.squad.select-default-model"
          // [v0.0.344] 加宽：w-full 跟随容器（对齐同区域 INPUT/Dropdown），长模型名完整显示
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
