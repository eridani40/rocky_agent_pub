/**
 * component-memory-editor-fields —— memory entry 表单字段（无 modal 壳，v0.0.131 从
 * component-memory-editor-modal 抽出）
 * 参考: specs/ui/components/chat-page/component-memory-editor-fields.md
 *       specs/api/overall/15-memory-ui.md §4（POST）/§5（PATCH）
 *
 * 字段：name / intro / type / body / why / howToApply / evolvable + 校验 + 取消/保存按钮行。
 * 挂载即代表"编辑态激活"——本地 form state 直接由 initial prop 初始化（不用 useEffect 同步），
 * 卸载即代表取消/返回（承载方各自控制挂载时机：component-memory-modal 在 view==='editor' 时挂载；
 * component-memory-editor-modal 在 open===true 时挂载）。
 *
 * testid 与旧 component-memory-editor-modal 一致（{prefix}-editor-*），ET 观测契约稳定。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemoryType, MemoryWriteInput } from '../../lib/memory-api';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';
import type { MemoryEditorInitial } from './component-memory-editor-modal';

export interface MemoryEditorFieldsProps {
  /** undefined = 新建模式（name 可输入）；object = 编辑模式（name 锁定） */
  initial?: MemoryEditorInitial;
  /** 取消/返回（父决定：memory-modal 传返回 list；editor-modal 传 onClose） */
  onCancel: () => void;
  /** 保存 → 父调 POST/PATCH（成功后父负责 refetch + 关闭/返回） */
  onSave: (entry: MemoryWriteInput) => Promise<void> | void;
}

const TYPE_OPTIONS: MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** type=feedback|project 强制 why+howToApply（specs/api/overall/15-memory-ui.md §4.1） */
function needsWhy(type: MemoryType): boolean {
  return type === 'feedback' || type === 'project';
}

/** memory entry 表单字段（挂载即初始化，无 open/useEffect） */
export function ComponentMemoryEditorFields({
  initial,
  onCancel,
  onSave,
}: MemoryEditorFieldsProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [intro, setIntro] = useState(initial?.intro ?? '');
  const [type, setType] = useState<MemoryType>(initial?.type ?? 'user');
  const [body, setBody] = useState(initial?.body ?? '');
  const [why, setWhy] = useState(initial?.why ?? '');
  const [howToApply, setHowToApply] = useState(initial?.howToApply ?? '');
  // evolvable 开关：新建缺省 false（用户资产），编辑回填该条实际值
  const [evolvable, setEvolvable] = useState(initial?.evolvable ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editing = !!initial?.name;
  const { t: tCommon } = useTranslation('common');
  const { t: tChat } = useTranslation('chat');

  const requireWhy = needsWhy(type);
  // 校验：必填字段（name + intro + type + body）+ feedback/project 强制 why+how
  const missing: string[] = [];
  if (!name.trim()) missing.push('name');
  if (!intro.trim()) missing.push('intro');
  if (!body.trim()) missing.push('body');
  if (requireWhy) {
    if (!why.trim()) missing.push('why');
    if (!howToApply.trim()) missing.push('how');
  }
  const canSave = missing.length === 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        intro: intro.trim(),
        type,
        body: body.trim(),
        why: requireWhy ? why.trim() : undefined,
        howToApply: requireWhy ? howToApply.trim() : undefined,
        evolvable,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : tCommon('error.saveFail'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Field label="name（slug）">
        <input
          type="text"

          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={editing}
          placeholder="prefer-vitest"
          className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[12.5px] text-fg outline-none focus:border-accent disabled:opacity-60"
        />
      </Field>
      {/* intro（一句话摘要，v0.0.114 由 description 改名）；DOM testid 仍用 'description' 保持 E2E 观测契约稳定 */}
      <Field label="intro">
        <input
          type="text"

          value={intro}
          onChange={(e) => setIntro(e.target.value)}
          placeholder={tChat('memory.editor.introPlaceholder')}
          className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent"
        />
      </Field>
      <Field label="type">
        <select

          value={type}
          onChange={(e) => setType(e.target.value as MemoryType)}
          className="w-full rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] text-fg outline-none focus:border-accent"
        >
          {TYPE_OPTIONS.map((tp) => (
            <option key={tp} value={tp}>{tp}</option>
          ))}
        </select>
        {requireWhy && (
          <span className="mt-1 font-mono text-[10.5px] text-accent">
            {tChat('memory.editor.whyRequiredHint')}
          </span>
        )}
      </Field>
      <Field label="body">
        <textarea

          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          placeholder={tChat('memory.editor.bodyPlaceholder')}
          className="w-full resize-y rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[12.5px] leading-relaxed text-fg outline-none focus:border-accent"
        />
      </Field>
      {requireWhy && (
        <>
          <Field label="why">
            <textarea

              value={why}
              onChange={(e) => setWhy(e.target.value)}
              rows={2}
              placeholder={tChat('memory.editor.whyPlaceholder')}
              className="w-full resize-y rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-fg outline-none focus:border-accent"
            />
          </Field>
          <Field label="how to apply">
            <textarea

              value={howToApply}
              onChange={(e) => setHowToApply(e.target.value)}
              rows={2}
              placeholder={tChat('memory.editor.howPlaceholder')}
              className="w-full resize-y rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-fg outline-none focus:border-accent"
            />
          </Field>
        </>
      )}
      {/* evolvable 开关：无置灰、不防呆，全字段可编辑（UI 不 gate，UC-M4） */}
      <div

        className="flex items-center justify-between rounded-md border border-border bg-surface-2 px-2.5 py-2"
      >
        <div className="flex flex-col gap-0.5">
          <span className="font-mono text-[10.5px] font-semibold tracking-wide text-muted-2">
            {tChat('memory.editor.evolvableLabel')}
          </span>
          <span className="text-[10.5px] text-muted">
            {tChat('memory.editor.evolvableHint')}
          </span>
        </div>
        <ToggleSwitch
          value={evolvable}
          onChange={setEvolvable}

          label={tChat('memory.editor.evolvableLabel')}
        />
      </div>
      {missing.length > 0 && (
        <div className="font-mono text-[10.5px] text-[var(--danger)]">
          {tChat('memory.editor.missingFields', { fields: missing.join(', ') })}
        </div>
      )}
      {error && (
        <div role="alert" className="text-[12px] text-[var(--danger)]">{error}</div>
      )}
      {/* footer：取消 + 保存 */}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3.5">
        <button
          type="button"

          onClick={onCancel}
          className="rounded-md border border-border px-3 py-1.5 text-[12px] text-fg-2 transition-colors hover:bg-bg-warm"
        >
          {tCommon('action.cancel')}
        </button>
        <button
          type="button"
          data-action-key="chat.memory.save"
          onClick={() => void handleSave()}
          disabled={!canSave}
          className="rounded-md bg-accent px-3 py-1.5 text-[12px] text-surface transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? tCommon('status.saving') : tCommon('action.save')}
        </button>
      </div>
    </div>
  );
}

/**
 * 表单字段容器：label + children（纯视觉包裹）。
 * testid 落在控件（input/select/textarea）而非 label——E2E 需在字段 testid 上直接读 `.value`/`.disabled`。
 */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10.5px] font-semibold tracking-wide text-muted-2">{label}</span>
      {children}
    </label>
  );
}

export default ComponentMemoryEditorFields;
