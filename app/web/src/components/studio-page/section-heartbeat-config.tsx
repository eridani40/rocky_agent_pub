/**
 * section-heartbeat-config —— squad 级心跳配置 section（interval + activeWindows + scope）
 * 参考: specs/ui/components/studio-page/heartbeat-config.md（testid 契约 + 状态/交互）
 *       specs/api/overall/11a-squad-endpoints.md §1.4（PATCH /squad heartbeatConfig）
 *
 * [v0.0.116] 重构：per-member → squad 级统一配置。
 * 职责：为整个 squad 配置心跳调度参数（间隔 + 多工作时间段 + 范围）。
 * 写走 PATCH /squad/:id { heartbeatConfig }，非旧 member 心跳端点。
 * 总开关关时显示 disabled 提示（heartbeat-disabled-by-killswitch），配置保存但不生效。
 */
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { Member, PatchSquadBody, SquadHeartbeatConfig } from './squad-types';
import { FIELD_LABEL, FIELD_HINT } from './studio-styles';
import { HeartbeatWindowList } from './heartbeat-window-list';
import { HeartbeatScopePicker } from './heartbeat-scope-picker';

/** interval 枚举（5/15/30/60 分钟） */
const INTERVAL_OPTIONS = [5, 15, 30, 60] as const;

/** 默认配置（null heartbeatConfig 时的回填基线） */
const DEFAULT_CONFIG: SquadHeartbeatConfig = {
  interval: 15,
  activeWindows: [],
  scope: { mode: 'all', memberIds: [] },
};

interface HeartbeatConfigProps {
  squadId: string;
  enableHeartBeat: boolean;
  heartbeatConfig: SquadHeartbeatConfig | null;
  members: Member[];
  timezone: string;
  onSave: (patch: PatchSquadBody) => Promise<void>;
}

/** squad 级心跳配置 section */
export function HeartbeatConfigSection({ squadId, enableHeartBeat, heartbeatConfig, members, timezone, onSave }: HeartbeatConfigProps) {
  const { t } = useTranslation(['studio', 'common']);

  // 编辑态（基线 = heartbeatConfig ?? 默认）
  const base = heartbeatConfig ?? DEFAULT_CONFIG;
  const [interval, setInterval] = useState<number>(base.interval);
  const [activeWindows, setActiveWindows] = useState(base.activeWindows);
  const [scope, setScope] = useState(base.scope);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 外部 heartbeatConfig 变化时重置编辑态（保存成功后父级 refresh 回灌）
  useEffect(() => {
    const b = heartbeatConfig ?? DEFAULT_CONFIG;
    setInterval(b.interval);
    setActiveWindows(b.activeWindows);
    setScope(b.scope);
    setError(null);
  }, [heartbeatConfig]);

  // dirty 判定
  const dirty =
    interval !== base.interval ||
    JSON.stringify(activeWindows) !== JSON.stringify(base.activeWindows) ||
    JSON.stringify(scope) !== JSON.stringify(base.scope);

  const handleSave = async () => {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await onSave({
        heartbeatConfig: { interval, activeWindows, scope },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common:error.saveFail'));
    } finally {
      setPending(false);
    }
  };

  const handleReset = async () => {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await onSave({ heartbeatConfig: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('common:error.saveFail'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div data-squad-id={squadId} className="flex flex-col gap-3">
      {/* 总开关关时提示（非阻断，保存仍可操作） */}
      {!enableHeartBeat && (
        <div

          className="rounded-md border border-border-2 bg-bg-warm px-2.5 py-1.5 text-[11.5px] text-muted"
        >
          {t('studio:heartbeat.killswitchOff')}
        </div>
      )}

      {/* 间隔配置（segmented chip，禁 select） */}
      <div>
        <label className={FIELD_LABEL}>
          {t('studio:heartbeat.intervalLabel', { defaultValue: '心跳间隔（分钟）' })}
        </label>
        <div className="mt-1.5 flex gap-1.5 flex-wrap">
          {INTERVAL_OPTIONS.map((opt) => (
            <button
              key={opt}
              type="button"

              disabled={pending}
              onClick={() => setInterval(opt)}
              className={
                'rounded-md border px-3 py-1 font-mono text-[12px] transition-colors disabled:opacity-50 ' +
                (interval === opt
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border-2 bg-surface text-muted-2 hover:border-accent hover:text-accent')
              }
            >
              {opt}
              <span className="ml-0.5 text-[10px] opacity-70">min</span>
            </button>
          ))}
        </div>
        <div className={FIELD_HINT}>
          {t('studio:heartbeat.intervalHint', {
            defaultValue: '每 {{interval}} 分钟触发一次心跳（仅在工作时间段内）',
            interval,
          })}
        </div>
      </div>

      {/* 工作时间段（activeWindows 多段增删） */}
      <div>
        <label className={FIELD_LABEL}>
          {t('studio:heartbeat.windowsLabel', {
            defaultValue: '工作时间段（跟 squad.timezone {{timezone}}）',
            timezone,
          })}
        </label>
        <div className="mt-1.5">
          <HeartbeatWindowList
            windows={activeWindows}
            disabled={pending}
            onChange={setActiveWindows}
          />
        </div>
      </div>

      {/* 范围（scope switch + whitelist 成员勾选） */}
      <div>
        <label className={FIELD_LABEL}>
          {t('studio:heartbeat.scopeLabel', { defaultValue: '触发范围' })}
        </label>
        <div className="mt-1.5">
          <HeartbeatScopePicker
            scope={scope}
            members={members}
            disabled={pending}
            onChange={setScope}
          />
        </div>
      </div>

      {/* 错误 banner */}
      {error && (
        <div

          className="rounded-md border border-danger/40 bg-danger/5 px-2.5 py-1.5 text-[11.5px] text-danger"
        >
          {error}
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex items-center gap-2">
        <button
          type="button"

          disabled={!dirty || pending}
          onClick={() => void handleSave()}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {pending ? t('common:status.saving') : t('studio:heartbeat.save', { defaultValue: '保存心跳配置' })}
        </button>
        <button
          type="button"

          disabled={pending}
          onClick={() => void handleReset()}
          className="rounded-md border border-border-2 bg-surface px-3 py-1.5 text-[12px] text-muted-2 hover:border-accent hover:text-accent disabled:opacity-40"
        >
          {t('studio:heartbeat.reset', { defaultValue: '重置默认' })}
        </button>
      </div>
    </div>
  );
}

export default HeartbeatConfigSection;
