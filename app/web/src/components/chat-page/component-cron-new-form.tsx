/**
 * component-cron-new-form —— cron 新建表单
 * 参考: specs/ui/components/chat-page/component-cron-new-form.md（契约权威）
 *       specs/api/overall/16-cron.md §2（POST /session/:sid/cron）
 *
 * 职责：
 *   - 受控渲染 name / cron freq / prompt 三输入 + 错误 + 取消/保存
 *   - 保存：校验非空 → POST /session/:sid/cron（带 client tz）→ onSaved（refetch + 父层收起）
 *   - 失败：error 写回 form.error，不关表单
 *
 * 设计：state owner 在父层（component-cron-modal 二级 editor 视图），本组件受控；
 *   提交逻辑封装在本组件内（POST createCronJob），父层只提供 onSaved（refetch）+ onCancel（收起）。
 *   无外层容器/标题（标题由 modal head 承担），仅渲染字段。
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { createCronJob } from '../../lib/cron-api';
import { ComponentCronFreqPicker } from './component-cron-freq-picker';
import type { NewFormState } from './use-cron-crud';

export interface ComponentCronNewFormProps {
  /** 当前 session id */
  sessionId: string;
  /** 表单 state（父层持有） */
  form: NewFormState;
  /** 父层 setForm updater */
  setForm: (updater: (s: NewFormState) => NewFormState) => void;
  /** 取消：父层重置为 INITIAL_NEW 并收起 */
  onCancel: () => void;
  /** 保存成功后回调（父层 refetch） */
  onSaved: () => Promise<void>;
}

/** cron 新建表单（name + freq + prompt + 取消/保存） */
export function ComponentCronNewForm({
  sessionId,
  form,
  setForm,
  onCancel,
  onSaved,
}: ComponentCronNewFormProps) {
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');

  // 提交新建：校验 → POST（带 client tz）→ onSaved refetch
  const handleSubmit = useCallback(async () => {
    if (!form.cron.trim() || !form.prompt.trim()) {
      setForm((s) => ({ ...s, error: t('cron.form.validationRequired') }));
      return;
    }
    setForm((s) => ({ ...s, submitting: true, error: null }));
    try {
      // 传客户端本地 tz（IANA），server 用作 schedule.tz。
      // 「全局用本地 timezone 随时取用」：每次建 cron 现取当前 client tz，不存 session。
      await createCronJob(sessionId, {
        cron: form.cron.trim(),
        prompt: form.prompt.trim(),
        name: form.name.trim() || undefined,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      await onSaved();
    } catch (e) {
      setForm((s) => ({
        ...s,
        submitting: false,
        error: e instanceof Error ? e.message : t('cron.error.createFail'),
      }));
    }
  }, [sessionId, form.cron, form.prompt, form.name, setForm, onSaved, t]);

  return (
    <div>
      <div className="mb-2.5 flex flex-col gap-1">
        <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-2">
          {t('cron.form.nameLabel')}
        </label>
        <input
          type="text"
          value={form.name}
          onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
          placeholder={t('cron.form.namePlaceholder')}
          className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] focus:border-accent"
        />
      </div>
      <div className="mb-2.5 flex flex-col gap-1">
        <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-2">
          {t('cron.form.freqLabel')}
        </label>
        <ComponentCronFreqPicker
          value={form.cron}
          onChange={(cron) => setForm((s) => ({ ...s, cron }))}

        />
      </div>
      <div className="mb-2.5 flex flex-col gap-1">
        <label className="text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-2">
          {t('cron.form.promptLabel')}
        </label>
        <textarea
          value={form.prompt}

          onChange={(e) => setForm((s) => ({ ...s, prompt: e.target.value }))}
          placeholder={t('cron.form.promptPlaceholder')}
          className="min-h-[54px] w-full resize-y rounded-md border border-border bg-surface px-2 py-1.5 text-[13px] focus:border-accent"
        />
        <div className="font-mono text-[11px] text-muted">
          {t('cron.form.promptHint')}
        </div>
      </div>
      {form.error && (
        <div role="alert" className="mb-2 text-[12px] text-[var(--danger)]">
          {form.error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"

          onClick={onCancel}
          disabled={form.submitting}
          className="rounded-md border border-border bg-surface px-3 py-1 text-[13px] hover:border-accent hover:text-accent-hover"
        >
          {tCommon('action.cancel')}
        </button>
        <button
          type="button"
          data-action-key="chat.cron.save"
          onClick={() => void handleSubmit()}
          disabled={form.submitting}
          className="rounded-md bg-accent px-3 py-1 text-[13px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {form.submitting ? tCommon('status.saving') : tCommon('action.save')}
        </button>
      </div>
    </div>
  );
}

export default ComponentCronNewForm;
