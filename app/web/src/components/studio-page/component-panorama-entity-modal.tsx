/**
 * component-panorama-entity-modal —— 泛化实体新建/编辑弹层（edit + create 共用）
 * 参考: specs/ui/components/studio-page/component-panorama-entity-modal.md v1.0
 *       specs/ui/components/studio-page/component-board-entity-modal（清空语义 / dirty 检测模式来源）
 *
 * 与 board-entity-modal（4 固定实体硬编码字段集）不同：字段集完全由 DSL entity.fields 驱动：
 *   string→text / number→number / boolean→checkbox / enum→ChoiceCards|Dropdown（禁原生 select）
 *   ref→实例选择（选项由父注入）/ datetime→datetime-local。
 * 提交语义：dirty 才提交、空串=显式清空；required 空提交 → onToast 提示 + 不提交。
 * 边界：不拉数据、不调 API（onSubmit 回调，父按 mode 调 POST/PATCH）。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EntityDef, FieldDef } from './panorama-types';
import { enumValueLabel, fieldLabel } from './panorama-utils';
import { ChoiceCards, Dropdown, type SelectorOption } from './component-shared-selector';
import { ModalShell } from './component-modal-shell';
import { BTN_PRIMARY, BTN_SECONDARY, FIELD_HINT, FIELD_LABEL, INPUT } from './studio-styles';

export interface PanoramaEntityModalProps {
  mode: 'create' | 'edit';
  entity: string;
  entityDef: EntityDef;
  /** edit 模式实例快照（create 传 undefined） */
  initial?: Record<string, unknown>;
  /** ref 字段选项（fieldName → 目标实体实例选项，父 view 注入） */
  refOptions?: Record<string, SelectorOption[]>;
  /** 保存回调（create=全量 values；edit=dirty patch） */
  onSubmit: (values: Record<string, unknown>) => void;
  onCancel: () => void;
  /** 校验/服务端错误 toast（父 view 持有） */
  onToast: (msg: string) => void;
}

/** 字段空值判定（required 校验 + dirty 对比共用） */
function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '';
}

/** DSL 字段名 → ET 稳定锚点 studio.panorama.edit-field-{kebab}（下划线转连字符 + 小写，_conventions §12.2） */
function fieldActionKey(fieldName: string): string {
  return `studio.panorama.edit-field-${fieldName.toLowerCase().replace(/_/g, '-')}`;
}

/** 单字段控件（按 FieldDef.type 分派） */
function FieldControl({
  entityName,
  fieldName,
  def,
  value,
  readOnly,
  readOnlyText,
  refOptions,
  onChange,
}: {
  entityName: string;
  fieldName: string;
  def: FieldDef;
  value: unknown;
  readOnly?: boolean;
  /** 只读呈现文本（enum 只读时渲染中文 label 而非原值） */
  readOnlyText?: string;
  refOptions?: SelectorOption[];
  onChange: (v: unknown) => void;
}) {
  switch (def.type) {
    case 'boolean':
      return (
        <input
          type="checkbox"
          data-action-key={fieldActionKey(fieldName)}
          checked={Boolean(value)}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
      );
    case 'number':
      return (
        <input
          type="number"
          data-action-key={fieldActionKey(fieldName)}
          value={value === undefined || value === null ? '' : String(value)}
          min={def.min}
          max={def.max}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          className={INPUT}
        />
      );
    case 'datetime':
      return (
        <input
          type="datetime-local"
          data-action-key={fieldActionKey(fieldName)}
          value={typeof value === 'string' ? value.slice(0, 16) : ''}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
        />
      );
    case 'enum': {
      // 只读（edit 模式状态字段）：无 disabled 语义的 selector → 退化为只读 input，与其他只读字段一致
      if (readOnly) {
        const shown = readOnlyText ?? (typeof value === 'string' ? value : '');
        return <input type="text" value={shown} disabled readOnly className={INPUT} />;
      }
      const options: SelectorOption[] = def.values.map((v) => ({ value: v, label: v }));
      if (options.length <= 4) {
        return (
          <ChoiceCards
            actionKey={fieldActionKey(fieldName)}
            value={typeof value === 'string' && value ? value : null}
            options={options}
            onChange={(v) => onChange(v ?? '')}
          />
        );
      }
      return (
        <Dropdown
          actionKey={fieldActionKey(fieldName)}
          value={typeof value === 'string' && value ? value : null}
          options={options}
          onChange={(v) => onChange(typeof v === 'string' ? v : '')}
        />
      );
    }
    case 'ref': {
      const options = refOptions ?? [];
      return (
        <Dropdown
          actionKey={fieldActionKey(fieldName)}
          value={typeof value === 'string' && value ? value : null}
          options={options}
          nullable
          onChange={(v) => onChange(typeof v === 'string' ? v : null)}
        />
      );
    }
    case 'string':
    default:
      return (
        <input
          type="text"
          data-action-key={fieldActionKey(fieldName)}
          value={typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)}
          maxLength={def.type === 'string' ? def.max : undefined}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
        />
      );
  }
}

export function PanoramaEntityModal({
  mode,
  entity,
  entityDef,
  initial,
  refOptions,
  onSubmit,
  onCancel,
  onToast,
}: PanoramaEntityModalProps) {
  const { t } = useTranslation(['studio', 'common']);
  // create 初始值：states.field 缺省 states.initial；edit 用实例快照
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    if (mode === 'edit') return { ...(initial ?? {}) };
    const v: Record<string, unknown> = {};
    if (entityDef.states) v[entityDef.states.field] = entityDef.states.initial;
    return v;
  });

  const fieldNames = useMemo(() => Object.keys(entityDef.fields), [entityDef.fields]);
  const idField = entityDef.id_field;

  /** dirty 对比（edit：与 initial 逐字段比；create：非空即 dirty） */
  const dirtyValues = useMemo(() => {
    if (mode === 'create') return values;
    const patch: Record<string, unknown> = {};
    for (const k of fieldNames) {
      const nv = values[k];
      const ov = initial?.[k];
      if (nv !== ov && !(isEmpty(nv) && isEmpty(ov))) patch[k] = nv;
    }
    return patch;
  }, [mode, values, initial, fieldNames]);

  const handleSubmit = () => {
    // required 校验（空提交 → toast + 不提交）
    for (const k of fieldNames) {
      const def = entityDef.fields[k];
      if (!def) continue;
      const required = def.required || (mode === 'create' && k === idField);
      if (required && isEmpty(values[k]) && !(def.type === 'boolean')) {
        onToast(t('studio:panorama.modal.required', { field: k }));
        return;
      }
    }
    if (mode === 'edit' && Object.keys(dirtyValues).length === 0) {
      onCancel(); // 无改动直接关（dirty 才提交）
      return;
    }
    onSubmit(mode === 'create' ? values : dirtyValues);
  };

  const modalTid = `panorama-${mode}-${entity}-modal`;
  return (
    <ModalShell
      title={t(mode === 'create' ? 'studio:panorama.modal.createTitle' : 'studio:panorama.modal.editTitle', {
        label: entityDef.label,
      })}
      onClose={onCancel}

      footer={
        <>
          <button type="button" onClick={onCancel} className={BTN_SECONDARY} data-action-key="studio.panorama.cancel">
            {t('common:action.cancel')}
          </button>
          <button
            type="button"
            data-action-key={mode === 'create' ? 'studio.panorama.create-entity' : 'studio.panorama.save-entity'}
            onClick={handleSubmit}
            className={BTN_PRIMARY}
          >
            {t('common:action.confirm')}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {fieldNames.map((k) => {
          const def = entityDef.fields[k];
          if (!def) return null;
          const isId = k === idField;
          const isStateField = entityDef.states?.field === k;
          const required = def.required || (mode === 'create' && isId);
          // edit 模式 id + 状态字段只读（状态变更走 transition：拖拽 / 跃迁端点；服务端 update/PATCH 亦过 transition 校验）
          const readOnly = mode === 'edit' && (isId || isStateField);
          return (
            <div key={k}>
              <label className={FIELD_LABEL}>
                {fieldLabel(entityDef, k)}
                {required && <span className="ml-1 text-danger">*</span>}
                {isStateField && (
                  <span className="ml-1.5 normal-case text-muted-2">({t('studio:panorama.modal.statusField')})</span>
                )}
              </label>
              <FieldControl
                entityName={entity}
                fieldName={k}
                def={def}
                value={values[k]}
                readOnly={readOnly}
                readOnlyText={
                  readOnly && def.type === 'enum' ? enumValueLabel(entityDef, k, String(values[k] ?? '')) : undefined
                }
                refOptions={def.type === 'ref' ? refOptions?.[k] : undefined}
                onChange={(v) => setValues((prev) => ({ ...prev, [k]: v }))}
              />
              {readOnly && isStateField && (
                <div className={FIELD_HINT}>{t('studio:panorama.modal.statusReadonly')}</div>
              )}
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}

export default PanoramaEntityModal;
