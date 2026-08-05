/**
 * component-model-edit-modal — model 编辑弹层（v0.0.7；v0.0.53 删 protocolId 字段）
 * 参考: specs/ui/components/providers/_overview.md §5 + component-model-edit-modal.md（spec）
 *       视觉: reqs/v0.0.7/easy-opc-config-v6b.html modal + f-input
 *
 * 职责：model 字段编辑弹层；底部「确定」回写父级 draft（**不调后端、非保存**）+「取消」。
 * 边界：只产出 model draft 给父级；不感知 provider、不持久化。
 * 新增(model=null)→ modelId 可编辑；编辑(已有 model)→ modelId 只读（它是 diff 配对 key）。
 *
 * [v0.0.53] 字段表删除 protocolId（迁到 ProviderInstance.protocolId，单一事实源）。
 * 弹层不再涉及 protocol 字段；protocol 选择改在 provider 二级页 component-provider-fields。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelInstance } from '../../lib/api-client';

export interface ComponentModelEditModalProps {
  /** null=新增；否则编辑该 model */
  model: ModelInstance | null;
  /** 确定回写（父级写入 draft.models） */
  onConfirm: (model: ModelInstance) => void;
  /** 取消/关闭 */
  onCancel: () => void;
}

/** [v0.0.53] empty 不再含 protocolId（已迁出 → ProviderInstance.protocolId） */
const empty = (): ModelInstance => ({
  modelId: '',
  contextWindow: 0,
  maxOutputTokens: 0,
  label: '',
  enabled: true,
});

/** model 编辑弹层。 */
export function ComponentModelEditModal({ model, onConfirm, onCancel }: ComponentModelEditModalProps) {
  // [v0.0.62 i18n] providers ns 主，common 兼用（action.confirm/cancel 通用词）
  const { t } = useTranslation(['providers', 'common']);
  const isNew = model === null;
  const [draft, setDraft] = useState<ModelInstance>(() => (model ? { ...model } : empty()));

  // 每次打开重置 draft（model 引用变化时）
  useEffect(() => {
    setDraft(model ? { ...model } : empty());
  }, [model]);

  const set = <K extends keyof ModelInstance>(k: K, v: ModelInstance[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const valid = draft.modelId.trim().length > 0 && draft.label.trim().length > 0;

  return (
    <div

      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-[480px] max-w-[92vw] rounded-xl bg-surface-2 border border-border shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="px-5 py-4 border-b border-border">
          <div className="text-[15px] font-semibold text-fg">{isNew ? t('model.add') : t('model.edit')}</div>
          {/* [v0.0.53] 副标不再展示 protocol（model 已无 protocolId；protocol 元数据在 provider 二级页） */}
          <div className="text-xs text-muted font-mono mt-0.5">{t('model.fieldEditHint')}</div>
        </div>

        {/* body — 字段（单列堆叠，宽松间距） */}
        <div className="px-5 py-4 flex flex-col gap-4">
          <Field label={t('model.labelName')} hint="label">
            <input data-action-key="providers.model.input-label" className={inputCls} value={draft.label} onChange={(e) => set('label', e.target.value)} placeholder={t('model.labelPlaceholder')} />
          </Field>
          <Field label={t('model.labelId')} hint="model_name">
            <input data-action-key="providers.model.input-model-id" className={inputCls} value={draft.modelId} disabled={!isNew} onChange={(e) => set('modelId', e.target.value)} placeholder="claude-sonnet-4-6" />
          </Field>
          <Field label={t('model.labelCtx')} hint="context_window (tokens)">
            <input data-action-key="providers.model.input-context-window" type="number" className={inputCls} value={draft.contextWindow} onChange={(e) => set('contextWindow', Number(e.target.value) || 0)} />
          </Field>
          <Field label={t('model.labelMaxOutput')} hint="max_output_tokens">
            <input data-action-key="providers.model.input-max-output-tokens" type="number" className={inputCls} value={draft.maxOutputTokens} onChange={(e) => set('maxOutputTokens', Number(e.target.value) || 0)} />
          </Field>
          <ToggleRow kind="check" checked={draft.enabled} onChange={(v) => set('enabled', v)} title={t('model.enableTitle')} desc={t('model.enableHint')} />
        </div>

        {/* footer — 确定 / 取消（非保存） */}
        <div className="px-5 py-3 border-t border-border flex justify-end gap-2">
          <button type="button" data-action-key="providers.model.cancel" onClick={onCancel}
            className="px-3 py-1.5 text-sm text-fg-2 border border-border-2 rounded-md hover:border-accent hover:text-accent transition-colors">
            {t('common:action.cancel')}
          </button>
          <button type="button" data-action-key="providers.model.confirm" disabled={!valid} onClick={() => onConfirm({ ...draft, modelId: draft.modelId.trim(), label: draft.label.trim() })}
            className="px-3 py-1.5 text-sm text-white bg-accent rounded-md hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
            {t('common:action.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  'w-full border border-border-2 rounded-md px-[12px] py-[8px] bg-surface text-fg text-[13px] font-mono outline-none transition-colors focus:border-accent focus:shadow-[var(--shadow-focus)] hover:border-border-strong disabled:opacity-60';

function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={'flex flex-col gap-1 ' + (className ?? '')}>
      <span className="text-xs text-fg-2 font-medium">{label} {hint && <span className="text-muted font-mono ml-1">{hint}</span>}</span>
      {children}
    </label>
  );
}

/** toggle 行（checkbox / radio 二选一视觉）：checked 时渲染 indicator，title/desc 右侧文案。 */
function ToggleRow({
  kind,
  checked,
  onChange,
  title,
  desc,
}: {
  kind: 'check' | 'radio';
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc: string;
}) {
  return (
    <button type="button" data-action-key="providers.model.toggle-enabled" onClick={() => onChange(!checked)} className={'flex items-center gap-2 w-full text-left border rounded-md px-3 py-2 transition-colors ' + (checked ? 'border-accent bg-accent-surface' : 'border-border hover:border-border-strong')}>
      <span aria-hidden className={'w-4 h-4 border-2 flex items-center justify-center ' + (kind === 'check' ? 'rounded ' : 'rounded-full ') + (kind === 'check' && checked ? 'border-accent bg-accent text-white' : 'border-border-strong')}>
        {kind === 'check' && checked && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l5 5L20 7" /></svg>}
      </span>
      <span className="flex-1">
        <span className="block text-[13px] font-semibold text-fg">{title}</span>
        <span className="block text-[11px] text-muted font-mono">{desc}</span>
      </span>
    </button>
  );
}

export default ComponentModelEditModal;
