/**
 * component-squad-autonomy-toggle —— squad 自主性总开关（killswitch）
 * 参考: specs/ui/components/studio-page/squad-autonomy-toggle.md（testid 契约 + 状态/交互）
 *       specs/api/version_logs/v0.0.33.4/change_log.md §2（PATCH /squad enableHeartBeat 字段生效）
 *
 * 职责：开/关 squad.enableHeartBeat。开 → scheduler 心跳调度生效；
 *   关 → scheduler 下一 tick（≤1s）读到 false 即整体跳过心跳触发（群聊 reactive 不受影响）。
 * 边界：只控 enableHeartBeat 一个布尔；不配 activeWindow/interval（per-role，见 heartbeat-config）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FIELD_LABEL, FIELD_HINT } from './studio-styles';

interface SquadAutonomyToggleProps {
  squadId: string;
  /** 反映 squad.enableHeartBeat 当前值（PATCH 成功后父级 refresh → 新值回灌） */
  enableHeartBeat: boolean;
  /** 上抛 → PATCH /squad/:id { enableHeartBeat } */
  onPatch: (patch: { enableHeartBeat: boolean }) => Promise<void>;
}

/** 自主性总开关（killswitch） */
export function SquadAutonomyToggle({ squadId, enableHeartBeat, onPatch }: SquadAutonomyToggleProps) {
  const { t } = useTranslation('studio');
  const [pending, setPending] = useState(false);
  // 错误态：PATCH 失败时 banner 显示；toggle 回滚到原态（父级未 refresh，enableHeartBeat 仍是原值）
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (pending) return; // 防 in-flight 双击竞态
    setError(null);
    setPending(true);
    try {
      await onPatch({ enableHeartBeat: !enableHeartBeat });
      // 成功：父级 refresh → enableHeartBeat 回灌新值；本组件无本地态切换
    } catch (e) {
      // 失败：显示 banner，toggle 视觉保持原态（enableHeartBeat 未变）
      setError(e instanceof Error ? e.message : t('autonomy.toggleFail'));
    } finally {
      setPending(false);
    }
  };

  const on = enableHeartBeat;

  return (
    <div data-squad-id={squadId} className="flex flex-col gap-1.5">
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
          disabled={pending}
          onClick={() => void toggle()}
          className={
            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ' +
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
      {error && (
        <div

          className="mt-1 flex items-center gap-2 rounded-md border border-danger/40 bg-danger/5 px-2.5 py-1.5 text-[11.5px] text-danger"
        >
          {t('autonomy.errorPrefix')}{error}
        </div>
      )}
    </div>
  );
}

export default SquadAutonomyToggle;
