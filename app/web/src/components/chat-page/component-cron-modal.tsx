/**
 * component-cron-modal —— 定时任务弹层（二级视图导航，v0.0.131 新建）
 * 参考: specs/ui/components/chat-page/component-cron-modal.md
 *       specs/ui/components/chat-page/component-chat-float-menu.md §4/§5（testid 权威）
 *
 * view = form.open ? 'editor' : 'list'（本地 NewFormState，useCronCrud 本身无「新建表单」state，
 * 与 memory 侧 crud.editor 不同源）。list 态复用 component-cron-job-card（含 toggle/delete +
 * 既有二次确认 dialog）；editor 态复用 component-cron-new-form（无 enabled toggle，POST 缺省
 * enabled=true，enable/disable 由列表项既有 toggle 承担）。
 *
 * crud 由父（component-chat-float-menu）恒挂载后以 prop 下传——本组件不重新调用
 * useCronCrud，保证 badge 与弹层列表同一数据源。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CronJobSummary } from '../../lib/cron-api';
import { ChevronLeftIcon, CloseIcon, PlusIcon } from './icons';
import { ComponentCronJobCard } from './component-cron-job-card';
import { ComponentCronNewForm } from './component-cron-new-form';
import { Portal } from '../../lib/portal';
import { INITIAL_NEW, type CronCrud, type NewFormState } from './use-cron-crud';

export interface ChatCronModalProps {
  /** 当前 session id（新建 cron POST 需要） */
  sessionId: string;
  /** float-menu 恒挂载的 useCronCrud 实例（badge 同源） */
  crud: CronCrud;
  /** 关闭弹层 */
  onClose: () => void;
}

export function ComponentCronModal({ sessionId, crud, onClose }: ChatCronModalProps) {
  const { jobs, loading, error, busyId, handleToggle, handleDelete, refetch } = crud;
  const [form, setForm] = useState<NewFormState>(INITIAL_NEW);
  const [confirmDel, setConfirmDel] = useState<CronJobSummary | null>(null);
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');
  const view: 'list' | 'editor' = form.open ? 'editor' : 'list';

  const handleClose = () => {
    setForm(INITIAL_NEW);
    onClose();
  };
  const handleBack = () => setForm(INITIAL_NEW);
  const handleNewSaved = async () => {
    setForm(INITIAL_NEW);
    await refetch();
  };
  // 删除确认后统一收起 dialog；失败时 error 走 crud.error 在列表区展示
  const handleConfirmedDelete = async (job: CronJobSummary) => {
    await handleDelete(job);
    setConfirmDel(null);
  };

  // L3 modal（_layering.md §3A）：包 <Portal> 到 overlay-root，脱离 overlay 的 pointer-events:none 链。
  //   注意 confirmDel sub-dialog（component 内子层 z-10 局部）保留不动——component 内子层不归全局 token。
  return (
    <Portal>
    <div

      // z=`--z-modal`(1000) + pointer-events-auto 双保险（与 memory-modal 统一规矩）
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[rgba(30,25,20,0.45)] backdrop-blur-sm pointer-events-auto"
      onClick={handleClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[88vh] w-[520px] max-w-[92vw] flex-col rounded-[14px] border border-border-2 bg-surface shadow-2xl"
      >
        {/* head：返回（editor 态） / 标题 / 新建（list 态） / 关闭 */}
        <div className="flex shrink-0 items-center gap-2 px-[22px] pt-[18px] pb-3">
          {view === 'editor' && (
            <button
              type="button"

              onClick={handleBack}
              className="flex items-center gap-1 text-[12.5px] text-muted transition-colors hover:text-fg"
            >
              <ChevronLeftIcon size={14} />
              {tCommon('action.back')}
            </button>
          )}
          <span className="flex-1 text-[15px] font-bold text-fg">
            {view === 'editor' ? t('cron.form.newTitle') : t('cron.panel.title')}
          </span>
          {view === 'list' && (
            <button
              type="button"
              data-action-key="chat.cron.create"
              onClick={() => setForm({ ...INITIAL_NEW, open: true })}
              className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-surface transition-colors hover:opacity-90"
            >
              <PlusIcon size={12} />
              {t('cron.panel.newBtn')}
            </button>
          )}
          <button
            type="button"

            aria-label={tCommon('modal.close')}
            onClick={handleClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-warm hover:text-fg"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        {/* body */}
        <div className="flex flex-col overflow-y-auto px-[22px] pb-5">
          {view === 'editor' ? (
            <ComponentCronNewForm
              sessionId={sessionId}
              form={form}
              setForm={setForm}
              onCancel={handleBack}
              onSaved={handleNewSaved}
            />
          ) : (
            <div className="flex flex-col">
              {loading && jobs.length === 0 ? (
                <div className="py-6 text-center font-mono text-[11px] text-muted">{tCommon('status.loading')}</div>
              ) : error ? (
                <div role="alert" className="py-4 text-center text-[12px] text-[var(--danger)]">{error}</div>
              ) : jobs.length === 0 ? (
                <div className="px-6 py-12 text-center text-muted">
                  <div className="mb-1 text-[24px]" aria-hidden>⏰</div>
                  <b className="block text-[13px] text-muted-2">{t('cron.panel.emptyTitle')}</b>
                  <span className="text-[12px]">
                    {t('cron.panel.emptyHintCreate')}
                    <br />
                    {t('cron.panel.emptyHintAgent')}
                  </span>
                </div>
              ) : (
                jobs.map((job) => (
                  <ComponentCronJobCard
                    key={job.id}
                    job={job}
                    onToggle={handleToggle}
                    onConfirmDelete={setConfirmDel}
                    busy={busyId === job.id}
                  />
                ))
              )}
            </div>
          )}
        </div>

        {/* 删除二次确认 dialog（沿用 section-cron-panel 既有语义，非「弹层套 modal」——列表既有交互） */}
        {confirmDel && (
          <div
            role="dialog"
            aria-label={t('cron.delete.dialogAria')}
            className="absolute inset-0 z-10 flex items-center justify-center rounded-[14px] bg-black/30"
          >
            <div className="w-[280px] rounded-md border border-border bg-surface p-3.5">
              <div className="mb-2 text-[13px] font-semibold">{t('cron.delete.dialogTitle')}</div>
              <div className="mb-3 text-[12px] text-muted-2">
                {t('cron.delete.dialogBody', { name: confirmDel.name })}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDel(null)}
                  disabled={busyId === confirmDel.id}
                  className="rounded-md border border-border bg-surface px-3 py-1 text-[13px] hover:border-accent"
                >
                  {tCommon('action.cancel')}
                </button>
                <button
                  type="button"
                  data-action-key="chat.cron.delete"
                  onClick={() => void handleConfirmedDelete(confirmDel)}
                  disabled={busyId === confirmDel.id}
                  className="rounded-md bg-[var(--btn-danger-bg)] px-3 py-1 text-[13px] font-semibold text-[var(--btn-danger-fg)] hover:bg-[var(--danger)] disabled:opacity-50"
                >
                  {tCommon('action.delete')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
    </Portal>
  );
}

export default ComponentCronModal;
