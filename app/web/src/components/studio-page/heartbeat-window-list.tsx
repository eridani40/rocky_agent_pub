/**
 * heartbeat-window-list —— activeWindows 多段工作时间段增删列表
 * 参考: specs/ui/components/studio-page/heartbeat-config.md §testid §状态
 *
 * 职责：管理 heartbeat 的 activeWindows 列表（多段 HH:mm 时间段增删）。
 * 每段包含 start/end time input + 删除按钮；「添加工作时间段」按钮追加新段。
 * 空列表时显示「全天」提示（heartbeat-windows-empty）。
 * 前端可提示段重叠/跨0点，后端 400 校验兜底。
 */
import { useTranslation } from 'react-i18next';

/** 单个时间窗口段 */
export interface TimeWindow {
  start: string; // "HH:mm"
  end: string;   // "HH:mm"
}

interface HeartbeatWindowListProps {
  windows: TimeWindow[];
  disabled?: boolean;
  onChange: (windows: TimeWindow[]) => void;
}

/** activeWindows 多段增删列表 */
export function HeartbeatWindowList({ windows, disabled, onChange }: HeartbeatWindowListProps) {
  const { t } = useTranslation('studio');

  const addWindow = () => {
    onChange([...windows, { start: '09:00', end: '18:00' }]);
  };

  const removeWindow = (idx: number) => {
    onChange(windows.filter((_, i) => i !== idx));
  };

  const updateWindow = (idx: number, field: 'start' | 'end', value: string) => {
    onChange(windows.map((w, i) => i === idx ? { ...w, [field]: value } : w));
  };

  return (
    <div className="flex flex-col gap-2">
      {windows.length === 0 && (
        <div

          className="rounded-md border border-border-2 bg-surface px-2.5 py-1.5 text-[11.5px] text-muted"
        >
          {t('heartbeat.windowsEmptyHint', { defaultValue: '未设时段 = 全天可调度' })}
        </div>
      )}

      {windows.map((w, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <input
            type="time"

            className="rounded-md border border-border-2 bg-surface px-2 py-1 font-mono text-[12px] text-fg disabled:opacity-50"
            value={w.start}
            disabled={disabled}
            onChange={(e) => updateWindow(idx, 'start', e.target.value)}
          />
          <span className="text-muted text-[11px]">—</span>
          <input
            type="time"

            className="rounded-md border border-border-2 bg-surface px-2 py-1 font-mono text-[12px] text-fg disabled:opacity-50"
            value={w.end}
            disabled={disabled}
            onChange={(e) => updateWindow(idx, 'end', e.target.value)}
          />
          <button
            type="button"

            disabled={disabled}
            onClick={() => removeWindow(idx)}
            className="rounded-md border border-border-2 bg-surface px-2 py-1 text-[11px] text-muted-2 hover:border-danger/40 hover:text-danger disabled:opacity-40"
          >
            {t('heartbeat.windowRemove', { defaultValue: '删除' })}
          </button>
        </div>
      ))}

      <button
        type="button"

        disabled={disabled}
        onClick={addWindow}
        className="self-start rounded-md border border-border-2 bg-surface px-2.5 py-1 text-[11.5px] text-muted-2 hover:border-accent hover:text-accent disabled:opacity-40"
      >
        + {t('heartbeat.windowAdd', { defaultValue: '添加工作时间段' })}
      </button>
    </div>
  );
}

export default HeartbeatWindowList;
