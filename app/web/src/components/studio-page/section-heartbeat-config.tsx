/**
 * section-heartbeat-config —— squad 级心跳配置 section（interval + activeWindows + scope）
 * 参考: specs/ui/components/studio-page/heartbeat-config.md（testid 契约 + 状态/交互）
 *       specs/api/overall/11a-squad-endpoints.md §1.4（PATCH /squad heartbeatConfig）
 *
 * [v0.0.116] 重构：per-member → squad 级统一配置。
 * 职责：为整个 squad 配置心跳调度参数（间隔 + 多工作时间段 + 范围）。
 * 写走 PATCH /squad/:id { heartbeatConfig }，非旧 member 心跳端点。
 * 总开关关时显示 disabled 提示（heartbeat-disabled-by-killswitch），配置保存但不生效。
 *
 * [v0.0.316 P1] 受控化：从「自管 draft + save/reset 按钮 + onSave PATCH」改为「受控 + onChange 上报」。
 *   三子控件（interval / activeWindows / scope）改 draft 后汇总为一个 heartbeatConfig 对象上报 onChange；
 *   不再自管 PATCH（父级 AutoworkTab 统一 save）；去掉 save/reset 按钮 + pending/error 自管态。
 */
import { useTranslation } from 'react-i18next';
import type { Member, SquadHeartbeatConfig } from './squad-types';
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
  enableHeartBeat: boolean;
  /** 当前配置（受控：来自父级 draft；null = 未配置，用 DEFAULT_CONFIG 基线展示） */
  heartbeatConfig: SquadHeartbeatConfig | null;
  members: Member[];
  timezone: string;
  /** 上报变更（子控件改 draft 后汇总为完整 heartbeatConfig 对象）→ 父级 dirty */
  onChange: (config: SquadHeartbeatConfig) => void;
}

/**
 * squad 级心跳配置 section。[v0.0.316] 受控模式：
 * 值从 props.heartbeatConfig 派生（非自管 useState）；子控件改动汇总 onChange 上报；无自管 PATCH。
 */
export function HeartbeatConfigSection({ enableHeartBeat, heartbeatConfig, members, timezone, onChange }: HeartbeatConfigProps) {
  const { t } = useTranslation(['studio', 'common']);

  // 受控派生：基线 = props.heartbeatConfig ?? DEFAULT_CONFIG（父级 draft 直灌，无本地 useState）
  const base = heartbeatConfig ?? DEFAULT_CONFIG;
  const interval = base.interval;
  const activeWindows = base.activeWindows;
  const scope = base.scope;

  return (
    <div className="flex flex-col gap-3">
      {/* 总开关关时提示（非阻断，配置仍可编辑攒入 draft） */}
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

              onClick={() => onChange({ interval: opt, activeWindows, scope })}
              className={
                'rounded-md border px-3 py-1 font-mono text-[12px] transition-colors ' +
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
            onChange={(windows) => onChange({ interval, activeWindows: windows, scope })}
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
            onChange={(s) => onChange({ interval, activeWindows, scope: s })}
          />
        </div>
      </div>
    </div>
  );
}

export default HeartbeatConfigSection;
