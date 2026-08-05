/**
 * component-cron-job-card —— 单 cron job 行
 * 参考: specs/ui/components/chat-page/component-cron-panel.md §2/§6（视觉基线）
 *       specs/api/overall/16-cron.md §4（CronJobSummary）
 *       reqs/v0.0.58.cron/design/cron-manage-demo.html §1（job card 视觉参考）
 *
 * 渲染：name + 人话频率 chip（cronstrue zh_CN）+ 下次触发 + prompt 摘要 + enable/disable toggle + 删除。
 * 受控：所有操作回调上抛父（onToggle/onConfirmDelete）。
 *
 * 布局稳定性 MANDATORY：删除按钮 hover opacity 切换 + flex-shrink:0 占位，不导致位移。
 */
import { useTranslation } from 'react-i18next';
import type { CronJobSummary } from '../../lib/cron-api';
import { cronHumanize } from './cron-humanize';

export interface CronJobCardProps {
  job: CronJobSummary;
  /** 点 toggle：enabled ? POST disable : POST enable */
  onToggle: (job: CronJobSummary) => void;
  /** 点删除：父弹二次确认 */
  onConfirmDelete: (job: CronJobSummary) => void;
  /** 操作中（toggle/delete 进行时禁用按钮） */
  busy?: boolean;
}

/** 格式化 ISO → 简洁「MM-DD HH:mm」 */
function fmt(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 单 cron job 行。disabled 时 opacity 0.55 + bg-bg；enabled 正常。 */
export function ComponentCronJobCard({ job, onToggle, onConfirmDelete, busy }: CronJobCardProps) {
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');
  const tid = (s: string) => `cron-item-${job.id}-${s}`;
  const summary = (job.prompt ?? '').slice(0, 60);
  const meta = job.enabled
    ? job.nextFireAt
      ? t('cron.job.nextFire', { time: fmt(job.nextFireAt) })
      : t('cron.job.notScheduled')
    : t('cron.job.disabled');

  return (
    <div

      className={`cron-job group flex flex-col gap-1 border-b border-border-2 px-3.5 py-3 transition-colors ${
        job.enabled ? '' : 'bg-bg opacity-55'
      }`}
    >
      {/* header: name + 频率 chip + meta */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-fg">{job.name}</span>
        <span

          className="rounded-full border border-accent-light bg-accent-surface px-2 py-0.5 text-[12px] font-semibold text-accent-hover"
        >
          <span aria-hidden>🔁 </span>
          {cronHumanize(job.cron)}
        </span>
        <span

          className="ml-auto font-mono text-[11px] text-muted"
        >
          {meta}
        </span>
      </div>
      {/* prompt 摘要 */}
      {summary && (
        <div className="rounded-md border-l-2 border-[var(--hue-violet)] bg-bg px-2.5 py-1.5 text-[12px] text-muted-2">
          {summary}
        </div>
      )}
      {/* actions: toggle + 删除 */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-action-key="chat.cron.toggle"
          onClick={() => onToggle(job)}
          disabled={busy}
          aria-label={job.enabled ? t('cron.job.disableAria') : t('cron.job.enableAria')}
          aria-pressed={job.enabled}
          className={`h-[17px] w-[30px] shrink-0 cursor-pointer rounded-full border-none p-0 transition-all disabled:cursor-not-allowed ${
            job.enabled ? 'bg-[var(--success)]' : 'bg-[var(--border-2)]'
          }`}
          style={{ position: 'relative' }}
        >
          <span
            aria-hidden
            className="block h-[13px] w-[13px] rounded-full bg-white transition-all"
            style={{ position: 'absolute', top: '2px', left: job.enabled ? '15px' : '2px' }}
          />
        </button>
        <span className="text-[11px] text-muted">{job.enabled ? t('cron.job.stateEnabled') : t('cron.job.stateDisabled')}</span>
        <button
          type="button"
          data-action-key="chat.cron.delete"
          onClick={() => onConfirmDelete(job)}
          disabled={busy}
          className="ml-auto flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] bg-transparent text-muted opacity-0 transition-opacity hover:bg-accent-surface hover:text-[var(--danger)] group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={tCommon('action.delete')}
          title={tCommon('action.delete')}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default ComponentCronJobCard;
