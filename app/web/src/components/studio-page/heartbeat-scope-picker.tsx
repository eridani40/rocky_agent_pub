/**
 * heartbeat-scope-picker —— scope switch（all/whitelist）+ deployed 成员勾选
 * 参考: specs/ui/components/studio-page/heartbeat-config.md §testid §状态
 *
 * 职责：配置心跳触发范围。
 * - off（mode='all'）：唤醒所有 deployed 成员
 * - on（mode='whitelist'）：展开成员勾选列表，仅唤醒勾选成员
 * 提示「仅唤醒勾选成员，后续新增成员不自动纳入」。
 */
import { useTranslation } from 'react-i18next';
import type { Member } from './squad-types';

/** scope 配置 */
export interface ScopeConfig {
  mode: 'all' | 'whitelist';
  memberIds: string[];
}

interface HeartbeatScopePickerProps {
  scope: ScopeConfig;
  /** 可选的成员列表（deployed 状态）用于 whitelist 勾选 */
  members: Member[];
  disabled?: boolean;
  onChange: (scope: ScopeConfig) => void;
}

/** scope switch + whitelist 成员勾选 */
export function HeartbeatScopePicker({ scope, members, disabled, onChange }: HeartbeatScopePickerProps) {
  const { t } = useTranslation('studio');
  const isWhitelist = scope.mode === 'whitelist';

  const toggleMode = () => {
    if (isWhitelist) {
      onChange({ mode: 'all', memberIds: [] });
    } else {
      onChange({ mode: 'whitelist', memberIds: [] });
    }
  };

  const toggleMember = (memberId: string) => {
    const ids = scope.memberIds.includes(memberId)
      ? scope.memberIds.filter((id) => id !== memberId)
      : [...scope.memberIds, memberId];
    onChange({ ...scope, memberIds: ids });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        {/* scope switch：off=all / on=whitelist */}
        <button
          type="button"

          role="switch"
          aria-checked={isWhitelist}
          disabled={disabled}
          onClick={toggleMode}
          className={
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ' +
            (isWhitelist ? 'bg-accent' : 'bg-border-strong')
          }
        >
          <span
            className={
              'inline-block h-4 w-4 transform rounded-full bg-white transition-transform ' +
              (isWhitelist ? 'translate-x-4' : 'translate-x-0.5')
            }
          />
        </button>
        <span className="font-mono text-[11px] text-muted">
          {isWhitelist
            ? t('heartbeat.scopeWhitelist', { defaultValue: '白名单（仅勾选成员）' })
            : t('heartbeat.scopeAll', { defaultValue: '全员（所有 deployed 成员）' })}
        </span>
      </div>

      {/* whitelist 展开：deployed 成员勾选 */}
      {isWhitelist && (
        <div className="flex flex-col gap-1.5 pl-2">
          <div className="text-[11px] text-muted-2">
            {t('heartbeat.scopeWhitelistHint', { defaultValue: '仅唤醒勾选成员，后续新增成员不自动纳入' })}
          </div>
          {members.filter((m) => m.state === 'deployed').map((m) => (
            <label
              key={m.id}
              className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-2"
            >
              <input
                type="checkbox"

                disabled={disabled}
                checked={scope.memberIds.includes(m.id)}
                onChange={() => toggleMember(m.id)}
                className="h-3.5 w-3.5 rounded accent-accent disabled:opacity-50"
              />
              <span>{m.name}</span>
              <span className="font-mono text-[10px] text-muted">{m.role}</span>
            </label>
          ))}
          {members.filter((m) => m.state === 'deployed').length === 0 && (
            <div className="text-[11px] text-muted-2">
              {t('heartbeat.scopeNoMembers', { defaultValue: '暂无 deployed 成员' })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default HeartbeatScopePicker;
