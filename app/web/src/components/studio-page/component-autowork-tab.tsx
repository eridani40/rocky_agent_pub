/**
 * component-autowork-tab —— 自动工作 tab 容器（toggle + heartbeat + budget + history 四块）
 * 参考: specs/ui/components/studio-page/component-autowork-tab.md（组合 + testid）
 *       specs/ui/components/studio-page/{squad-autonomy-toggle,heartbeat-config,budget-meter,auto-work-history}.md
 *
 * [v0.0.116] 新增 HeartbeatConfigSection 块（squad 级心跳配置）；BudgetMeter 加 budget/onSaveBudget prop。
 * 职责：autowork tab 的组合容器——垂直堆叠各功能块。
 * 边界：纯容器，各块各自管自己的数据流；容器只透传 squad detail + onSaveMeta。
 */
import type { PatchSquadBody, SquadDetail } from './squad-types';
import { SquadAutonomyToggle } from './component-squad-autonomy-toggle';
import { HeartbeatConfigSection } from './section-heartbeat-config';
import { BudgetMeter } from './component-budget-meter';
import { AutoWorkHistory } from './section-auto-work-history';

interface AutoworkTabProps {
  detail: SquadDetail;
  /** 透传给各块（PATCH /squad 通用保存） */
  onSaveMeta: (patch: PatchSquadBody) => Promise<void>;
}

/** 自动工作 tab 容器（toggle + heartbeat-config + budget + history 垂直堆叠） */
export function AutoworkTab({ detail, onSaveMeta }: AutoworkTabProps) {
  return (
    <div className="flex flex-col gap-5">
      {/* 自主性总开关（killswitch） */}
      <SquadAutonomyToggle
        squadId={detail.id}
        enableHeartBeat={detail.enableHeartBeat}
        onPatch={(patch) => onSaveMeta(patch)}
      />

      {/* squad 级心跳配置（[v0.0.116] — interval + activeWindows + scope） */}
      <HeartbeatConfigSection
        squadId={detail.id}
        enableHeartBeat={detail.enableHeartBeat}
        heartbeatConfig={detail.heartbeatConfig ?? null}
        members={detail.members}
        timezone={detail.timezone}
        onSave={onSaveMeta}
      />

      {/* token 预算仪表 + 配置（[v0.0.116] 加 budget switch/limit/save） */}
      <BudgetMeter
        squadId={detail.id}
        budget={detail.budget ?? null}
        onSaveBudget={(b) => onSaveMeta({ budget: b })}
      />

      {/* 自动工作历史（心跳唤醒记录） */}
      <AutoWorkHistory squadId={detail.id} />
    </div>
  );
}

export default AutoworkTab;
