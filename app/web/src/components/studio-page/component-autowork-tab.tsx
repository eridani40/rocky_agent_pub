/**
 * component-autowork-tab —— 自动工作 tab 容器（toggle + heartbeat + budget + history 四块）
 * 参考: specs/ui/components/studio-page/component-autowork-tab.md（组合 + testid）
 *       specs/ui/components/studio-page/{squad-autonomy-toggle,heartbeat-config,budget-meter,auto-work-history}.md
 *
 * [v0.0.116] 新增 HeartbeatConfigSection 块（squad 级心跳配置）；BudgetMeter 加 budget/onSaveBudget prop。
 * [v0.0.292] GroupChatToggle 迁出（挪入 manage-tab）。本 tab 从五块→四块。
 *
 * [v0.0.316 P1] 方案 A：从「纯容器」提升为「dirty 管理者」。
 *   3 子组件（toggle/heartbeat/budget）改受控（上报 onChange），本组件持 3 draft useState +
 *   dirty 派生 + save 合并 PATCH + cancel 重置；底部新增统一保存/取消按钮（BTN_PRIMARY 风格）。
 *   detail 外部变化（保存成功后父级 refresh 回灌）→ useEffect 重置 3 draft。
 * [v0.0.317] 底部保存/取消按钮去掉——改由 SeatsPanel 面板级 SaveBar 统一驱动（onSaveBarChange 上推）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PatchSquadBody, SquadDetail, SquadHeartbeatConfig, SaveBarController } from './squad-types';
import { SquadAutonomyToggle } from './component-squad-autonomy-toggle';
import { HeartbeatConfigSection } from './section-heartbeat-config';
import { BudgetMeter } from './component-budget-meter';
import { AutoWorkHistory } from './section-auto-work-history';

/** budget 配置形（与 SquadDetail.budget 一致） */
type BudgetConfig = { limit: number; window: 'daily'; scope: 'team' } | null;

interface AutoworkTabProps {
  detail: SquadDetail;
  /** 统一保存（PATCH /squad 合并提交 3 字段） */
  onSaveMeta: (patch: PatchSquadBody) => Promise<void>;
  /** [v0.0.317] 上推 SaveBarController 给 SeatsPanel（面板级统一 SaveBar） */
  onSaveBarChange?: (ctrl: SaveBarController | null) => void;
}

/**
 * 自动工作 tab 容器。[v0.0.316] 方案 A：dirty 管理者。
 * 持 3 draft（enableHeartBeat / heartbeatConfig / budget），聚合 dirty；底部统一保存/取消按钮。
 */
export function AutoworkTab({ detail, onSaveMeta, onSaveBarChange }: AutoworkTabProps) {
  const { t } = useTranslation(['studio', 'common']);

  // [v0.0.316] 3 个独立 draft useState（D2：不合并为单一对象，避免每次改一字段 spread 整个对象）
  const [enableHeartBeatDraft, setEnableHeartBeatDraft] = useState(detail.enableHeartBeat);
  const [heartbeatConfigDraft, setHeartbeatConfigDraft] = useState<SquadHeartbeatConfig | null>(
    detail.heartbeatConfig ?? null,
  );
  const [budgetDraft, setBudgetDraft] = useState<BudgetConfig>(detail.budget ?? null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // detail 外部变化（保存成功后父级 refresh 回灌）→ 重置 3 draft（仅 detail 引用变化时触发，非每次 render）
  useEffect(() => {
    setEnableHeartBeatDraft(detail.enableHeartBeat);
    setHeartbeatConfigDraft(detail.heartbeatConfig ?? null);
    setBudgetDraft(detail.budget ?? null);
    setSaveError(null);
  }, [detail]);

  // dirty 派生（3 字段各自 !== detail 对应字段；复合对象 JSON.stringify 比较）
  const dirty =
    enableHeartBeatDraft !== detail.enableHeartBeat ||
    JSON.stringify(heartbeatConfigDraft) !== JSON.stringify(detail.heartbeatConfig ?? null) ||
    JSON.stringify(budgetDraft) !== JSON.stringify(detail.budget ?? null);

  /** 统一保存：一次 PATCH 合并 3 字段（enableHeartBeat + heartbeatConfig + budget） */
  const save = async () => {
    if (!dirty || saving) return;
    setSaveError(null);
    setSaving(true);
    try {
      await onSaveMeta({
        enableHeartBeat: enableHeartBeatDraft,
        heartbeatConfig: heartbeatConfigDraft,
        budget: budgetDraft,
      });
      // 成功：父级 refresh → detail 变化 → useEffect 重置 draft（dirty 自动熄灭）
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : t('common:error.saveFail'));
    } finally {
      setSaving(false);
    }
  };

  /** 取消：3 draft 回 detail 原值（TabSaveBar cancel 语义） */
  const cancel = () => {
    setEnableHeartBeatDraft(detail.enableHeartBeat);
    setHeartbeatConfigDraft(detail.heartbeatConfig ?? null);
    setBudgetDraft(detail.budget ?? null);
    setSaveError(null);
  };

  /** [v0.0.317] 上推 SaveBarController 给 SeatsPanel（dirty/saving 变化时重新上报） */
  const ctrl: SaveBarController = { dirty, saving, save, cancel };
  useEffect(() => {
    onSaveBarChange?.(ctrl);
    return () => onSaveBarChange?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, saving]);

  return (
    <div className="flex flex-col gap-5">
      {/* 自主性总开关（killswitch）—— [v0.0.316] 受控：传 draft + onChange */}
      <SquadAutonomyToggle
        enableHeartBeat={enableHeartBeatDraft}
        onChange={setEnableHeartBeatDraft}
      />

      {/* squad 级心跳配置（[v0.0.116] — interval + activeWindows + scope）—— [v0.0.316] 受控 */}
      <HeartbeatConfigSection
        enableHeartBeat={enableHeartBeatDraft}
        heartbeatConfig={heartbeatConfigDraft}
        members={detail.members}
        timezone={detail.timezone}
        onChange={setHeartbeatConfigDraft}
      />

      {/* token 预算仪表 + 配置（[v0.0.116] 加 budget switch/limit）—— [v0.0.316] 受控 */}
      <BudgetMeter
        squadId={detail.id}
        budget={budgetDraft}
        onChange={setBudgetDraft}
      />

      {/* 自动工作历史（心跳唤醒记录）—— 只读，不纳入 dirty */}
      <AutoWorkHistory squadId={detail.id} />

      {/* [v0.0.317] save error inline banner（保存失败反馈——SaveBarController 无 error 字段，组件内部自渲染） */}
      {saveError && (
        <div className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2 text-[11.5px] text-danger">
          {saveError}
        </div>
      )}
    </div>
  );
}

export default AutoworkTab;
