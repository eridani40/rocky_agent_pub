/**
 * component-cron-freq-picker —— cron 频率选择器
 * 参考: specs/ui/components/chat-page/component-cron-freq-picker.md（契约权威）
 *       specs/prd/version_logs/v0.0.58/change_log.md §5.2（4 预设 + 高级折叠）
 *       reqs/v0.0.58.cron/design/cron-manage-demo.html §4（视觉参考非契约）
 *
 * 职责：
 *   - 4 预设 chip（每 N 分钟 / 每 N 小时 / 每天 / 每周）→ 程序生成 cron expr（buildCronExpr）
 *   - 高级：自定义 cron expr raw input（折叠 details，默认收起）
 *   - 实时预览人话（cronHumanize zh_CN）
 *
 * 受控组件：value/onChange 与父同步 cron expr；父 mount 时透传 testIdPrefix（cron-new / cron-edit-{id}）。
 *
 * 不做：cron expr 5 字段解析（前端只程序生成 + raw 直传，校验由后端 POST 时做）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buildCronExpr, cronHumanize, WEEKDAY_LABELS, type CronPreset } from './cron-humanize';

export interface CronFreqPickerProps {
  /** 受控：当前 cron expr */
  value: string;
  /** 受控变化回调 */
  onChange: (cron: string) => void;
  /** testid 前缀（缺省 'cron-new'） */
  testIdPrefix?: string;
}

/**
 * 预设 chip 元数据：key + testid（label 由 i18n 查表，不在此静态化以跟随 locale 切换）。
 * 对齐 chat.cron.freq.preset{Minutes,Hours,Daily,Weekly} 4 leaf。
 */
const PRESET_CHIPS: { key: CronPreset; testid: string; labelKey: string }[] = [
  { key: 'minutes', testid: 'cron-freq-minutes', labelKey: 'cron.freq.presetMinutes' },
  { key: 'hours', testid: 'cron-freq-hours', labelKey: 'cron.freq.presetHours' },
  { key: 'daily', testid: 'cron-freq-daily', labelKey: 'cron.freq.presetDaily' },
  { key: 'weekly', testid: 'cron-freq-weekly', labelKey: 'cron.freq.presetWeekly' },
];

/** 推断 expr → 初始 preset（无法识别默认 advanced） */
function detectPreset(expr: string): CronPreset {
  const e = expr.trim();
  // */N * * * *
  if (/^\*\/\d+\s+\*\s+\*\s+\*\s+\*$/.test(e)) return 'minutes';
  // 0 */N * * *
  if (/^0\s+\*\/\d+\s+\*\s+\*\s+\*$/.test(e)) return 'hours';
  // M H * * *
  if (/^\d+\s+\d+\s+\*\s+\*\s+\*$/.test(e)) return 'daily';
  // M H * * D
  if (/^\d+\s+\d+\s+\*\s+\*\s+\d+$/.test(e)) return 'weekly';
  return 'advanced';
}

/** 从 expr 反推输入字段（切回预设时用） */
function parseInputs(preset: CronPreset, expr: string): {
  intervalMin: number; intervalHour: number; timeHHmm: string; weekday: number;
} {
  const parts = expr.trim().split(/\s+/);
  const base = { intervalMin: 30, intervalHour: 4, timeHHmm: '09:00', weekday: 1 };
  if (parts.length !== 5) return base;
  const m = parts[0] ?? '0';
  const h = parts[1] ?? '0';
  const d = parts[4] ?? '1';
  if (preset === 'minutes') {
    const n = parseInt(m.slice(2), 10);
    return { ...base, intervalMin: isNaN(n) ? 30 : n };
  }
  if (preset === 'hours') {
    const n = parseInt(h.slice(2), 10);
    return { ...base, intervalHour: isNaN(n) ? 4 : n };
  }
  if (preset === 'daily' || preset === 'weekly') {
    const hh = h.padStart(2, '0');
    const mm = m.padStart(2, '0');
    const time = `${hh}:${mm}`;
    if (preset === 'weekly') {
      const wd = parseInt(d, 10);
      return { ...base, timeHHmm: time, weekday: isNaN(wd) ? 1 : wd === 7 ? 0 : wd };
    }
    return { ...base, timeHHmm: time };
  }
  return base;
}

/** cron 频率选择器（4 预设 + 高级折叠 + 实时预览） */
export function ComponentCronFreqPicker({ value, onChange, testIdPrefix = 'cron-new' }: CronFreqPickerProps) {
  const [preset, setPreset] = useState<CronPreset>(() => detectPreset(value));
  const initial = parseInputs(preset, value);
  const [intervalMin, setIntervalMin] = useState(initial.intervalMin);
  const [intervalHour, setIntervalHour] = useState(initial.intervalHour);
  const [timeHHmm, setTimeHHmm] = useState(initial.timeHHmm);
  const [weekday, setWeekday] = useState(initial.weekday);
  const { t } = useTranslation('chat');

  // 切 preset 时按当前输入重算 expr（advanced 切入时把当前 expr 填进 raw input）
  useEffect(() => {
    if (preset === 'advanced') return; // advanced 由用户直接编辑 raw
    const next = buildCronExpr(preset, { intervalMin, intervalHour, timeHHmm, weekday });
    if (next !== value) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, intervalMin, intervalHour, timeHHmm, weekday]);

  const chipCls = (key: CronPreset) =>
    `cursor-pointer rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors ${
      preset === key
        ? 'border-accent bg-accent-surface text-accent font-semibold'
        : 'border-border bg-bg text-muted-2 hover:border-accent hover:text-accent-hover'
    }`;

  return (
    <div className="flex flex-col gap-2">
      {/* 预设 chips（含「高级」） */}
      <div className="flex flex-wrap gap-1.5">
        {PRESET_CHIPS.map((c) => (
          <button
            type="button"
            key={c.key}

            onClick={() => setPreset(c.key)}
            className={chipCls(c.key)}
          >
            {t(c.labelKey)}
          </button>
        ))}
        <button
          type="button"

          onClick={() => setPreset('advanced')}
          className={chipCls('advanced')}
        >
          {t('cron.freq.advancedToggle')}
        </button>
      </div>

      {/* 输入控件：按 preset 切 */}
      {preset === 'minutes' && (
        <label className="flex items-center gap-2 text-[12px] text-muted-2">
          {t('cron.freq.intervalMinutes')}
          <input
            type="number"
            min={1}
            value={intervalMin}

            onChange={(e) => setIntervalMin(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className="w-[80px] rounded-md border border-border bg-surface px-2 py-1 text-[13px] focus:border-accent"
          />
        </label>
      )}
      {preset === 'hours' && (
        <label className="flex items-center gap-2 text-[12px] text-muted-2">
          {t('cron.freq.intervalHours')}
          <input
            type="number"
            min={1}
            value={intervalHour}

            onChange={(e) => setIntervalHour(Math.max(1, parseInt(e.target.value, 10) || 1))}
            className="w-[80px] rounded-md border border-border bg-surface px-2 py-1 text-[13px] focus:border-accent"
          />
        </label>
      )}
      {(preset === 'daily' || preset === 'weekly') && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-2">
          <label className="flex items-center gap-1">
            {t('cron.freq.timeLabel')}
            <input
              type="time"
              value={timeHHmm}

              onChange={(e) => setTimeHHmm(e.target.value || '09:00')}
              className="w-[88px] rounded-md border border-border bg-surface px-2 py-1 font-mono text-[13px] focus:border-accent"
            />
          </label>
          {preset === 'weekly' && (
            <label className="flex items-center gap-1">
              {t('cron.freq.weekdayLabel')}
              <div className="flex gap-0.5">
                {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
                  <button
                    type="button"
                    key={wd}

                    onClick={() => setWeekday(wd)}
                    className={`rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
                      weekday === wd
                        ? 'border-accent bg-accent-surface text-accent font-semibold'
                        : 'border-border bg-bg text-muted-2 hover:border-accent'
                    }`}
                  >
                    {WEEKDAY_LABELS[wd]}
                  </button>
                ))}
              </div>
            </label>
          )}
        </div>
      )}

      {/* 高级：自定义 cron（折叠 raw input + 实时预览） */}
      {preset === 'advanced' && (
        <details
          open

          className="rounded-md border-t border-dashed border-border pt-2"
        >
          <summary className="cursor-pointer text-[12px] text-muted-2 outline-none">
            {t('cron.freq.advancedSummary')}
          </summary>
          <input
            type="text"
            value={value}

            onChange={(e) => onChange(e.target.value)}
            placeholder="*/30 * * * *"
            className="mt-1.5 w-full rounded-md border border-border bg-surface px-2 py-1 font-mono text-[13px] focus:border-accent"
          />
        </details>
      )}

      {/* 实时预览：人话 + raw */}
      <div

        className="rounded-md border border-border-2 bg-bg px-2.5 py-2 text-[13px] text-fg"
      >
        <span aria-hidden>🔁 </span>
        <b>{cronHumanize(value)}</b>
        <span className="ml-2 font-mono text-[11px] text-muted">{t('cron.freq.previewCaption')}</span>
      </div>
    </div>
  );
}

export default ComponentCronFreqPicker;
