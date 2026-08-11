/**
 * component-squad-autonomy-toggle —— squad 自主性总开关（killswitch）
 * 参考: specs/ui/components/studio-page/squad-autonomy-toggle.md（testid 契约 + 状态/交互）
 *       specs/api/version_logs/v0.0.33.4/change_log.md §2（PATCH /squad enableHeartBeat 字段生效）
 *
 * 职责：开/关 squad.enableHeartBeat。开 → scheduler 心跳调度生效；
 *   关 → scheduler 下一 tick（≤1s）读到 false 即整体跳过心跳触发（群聊 reactive 不受影响）。
 * 边界：只控 enableHeartBeat 一个布尔；不配 activeWindow/interval（per-role，见 heartbeat-config）。
 *
 * [v0.0.316 P1] 受控化：从「自管 pending/error + onPatch PATCH」改为「受控 + onChange 上报」。
 *   不再自管 PATCH（父级 AutoworkTab 统一 save）；toggle 点击仅上报 onChange(!enableHeartBeat)。
 */
import { useTranslation } from 'react-i18next';
import { FIELD_LABEL, FIELD_HINT } from './studio-styles';

interface SquadAutonomyToggleProps {
  /** 反映 squad.enableHeartBeat 当前值（受控：来自父级 draft，非 server 直灌） */
  enableHeartBeat: boolean;
  /** 上报变更 → 父级 dirty（不再自管 PATCH） */
  onChange: (value: boolean) => void;
}

/** 自主性总开关（killswitch）。[v0.0.316] 受控模式：纯上报，无自管 PATCH/pending/error。 */
export function SquadAutonomyToggle({ enableHeartBeat, onChange }: SquadAutonomyToggleProps) {
  const { t } = useTranslation('studio');

  const on = enableHeartBeat;

  return (
    <div className="flex flex-col gap-1.5">
      <label className={FIELD_LABEL}>{t('autonomy.label')}</label>
      <div className="flex items-center gap-3">
        {/* 态标识（二态之一存在，ET 断言 squad-autonomy-toggle-{on|off}） */}
        <span className="hidden" />
        {/* toggle 控件本体（点击目标） */}
        <button
          type="button"
          data-action-key="studio.squad.toggle-autonomy"
          role="switch"
          aria-checked={on}
          onClick={() => onChange(!on)}
          className={
            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors ' +
            (on ? 'bg-accent' : 'bg-border-strong')
          }
        >
          <span
            className={
              'inline-block h-4 w-4 transform rounded-full bg-white transition-transform ' +
              (on ? 'translate-x-4' : 'translate-x-0.5')
            }
          />
        </button>
        <span className={FIELD_HINT + ' mt-0'}>
          {on ? t('autonomy.on') : t('autonomy.off')}
        </span>
      </div>
    </div>
  );
}

export default SquadAutonomyToggle;
