/**
 * component-provider-detail — provider 二级页骨架（v0.0.7；v0.0.53 加 protocolOptions）
 * 参考: specs/ui/components/providers/_overview.md §3-§5
 *       视觉: 面包屑 + section-divider hr + save-bar
 *
 * 职责：组合「连接配置」+「关联模型」+「save-bar」；持 provider draft 与 model 弹层状态。
 * 边界：不调后端、不算 diff-save；保存调 onSaved(draft)（section 负责持久化）。
 *
 * draft 初始：provider=null（新增）→ 空（protocolId 默认 protocols[0].id）；已存 → 映射
 *   label/baseUrl/apiKey(取 credentials.key 即 ***)/enabled + protocolId + models 深拷贝。
 * dirty 判定：draft 与初始 snapshot 任一字段不同（含 protocolId 变化 + models 长度/内容 diff）。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ModelInstance, ProtocolMeta, ProviderInstance } from '../../lib/api-client';
import { ComponentProviderFields, type ProviderDraftFields } from './component-provider-fields';
import { ComponentModelListCard } from './component-model-list-card';
import { ComponentModelEditModal } from './component-model-edit-modal';
import { SaveBar } from '../common/component-save-bar';

/** 二级页 draft 形状（连接配置 + models） */
export interface ProviderDraft extends ProviderDraftFields {
  models: ModelInstance[];
}

export interface ComponentProviderDetailProps {
  /** null=新增；否则编辑已存 provider */
  provider: ProviderInstance | null;
  /** [v0.0.53] 协议选项（父级 section-providers cache 传入，给 fields 下拉 + 拼接地址用） */
  protocolOptions: ProtocolMeta[];
  /** 面包屑/返回 → 回列表 */
  onBack: () => void;
  /** 保存 → 父级算 diff-save（snapshot=provider, draft） */
  onSaved: (draft: ProviderDraft) => void;
}

/** 从 provider 构造初始 draft。
 *  [v0.0.53] 新建 provider 默认 protocolId = protocols[0].id（避免空选触发 400）。 */
function toDraft(provider: ProviderInstance | null, protocolOptions: ProtocolMeta[]): ProviderDraft {
  const defaultProtocolId = protocolOptions[0]?.id ?? 'anthropic_messages';
  if (!provider) {
    return {
      label: '', baseUrl: '', apiKey: '', enabled: true,
      protocolId: defaultProtocolId, models: [],
    };
  }
  return {
    label: provider.label,
    baseUrl: provider.baseUrl,
    apiKey: provider.credentials.key ?? '',
    enabled: provider.enabled,
    // [v0.0.53] 已存 provider 取其 protocolId；若旧 record 无（理论上迁移已写）则兜底默认
    protocolId: provider.protocolId ?? defaultProtocolId,
    models: provider.models.map((m) => ({ ...m })),
  };
}

/** provider 二级页：面包屑 + 连接配置 + 关联模型 + save-bar + model 弹层 */
export function ComponentProviderDetail({ provider, protocolOptions, onBack, onSaved }: ComponentProviderDetailProps) {
  // [v0.0.62 i18n] providers ns 主，common 兼用（action.save/reset 通用词）
  const { t } = useTranslation(['providers', 'common']);
  const [draft, setDraft] = useState<ProviderDraft>(() => toDraft(provider, protocolOptions));
  // model 弹层：null=新增 / ModelInstance=编辑 / 关闭用闭包标志
  const [editingModel, setEditingModel] = useState<ModelInstance | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  /** [v0.0.317] 保存中状态（SaveBar saving prop） */
  const [saving, setSaving] = useState(false);

  // snapshot 用于 dirty 判定（props 变化时重算）
  const snapshot = useMemo(() => toDraft(provider, protocolOptions), [provider, protocolOptions]);

  const dirty = useMemo(() => isDirty(snapshot, draft), [snapshot, draft]);

  /** 连接配置字段变更 → merge patch */
  const handleFieldsChange = (patch: Partial<ProviderDraftFields>) => {
    setDraft((d) => ({ ...d, ...patch }));
  };

  /** 重置 → 回 snapshot（含 models） */
  const handleReset = () => setDraft(snapshot);

  /** [v0.0.317] 保存：async 包装 + saving 状态管理（SaveBar saving prop） */
  const handleSave = async () => {
    setSaving(true);
    try {
      await onSaved(draft);
    } finally {
      setSaving(false);
    }
  };

  /** 开 modal：editing=null 新增；否则编辑该 model */
  const openModal = (editing: ModelInstance | null) => {
    setEditingModel(editing);
    setModalOpen(true);
  };

  /** modal 确定 → 回写 draft.models（新增 push / 编辑替换） */
  const handleModelConfirm = (m: ModelInstance) => {
    setDraft((d) => {
      const idx = d.models.findIndex((x) => x.modelId === m.modelId);
      const models = idx >= 0 ? d.models.map((x, i) => (i === idx ? m : x)) : [...d.models, m];
      return { ...d, models };
    });
    setModalOpen(false);
    setEditingModel(null);
  };

  /** 删除 model → 从 draft.models 移除 */
  const handleModelDelete = (modelId: string) => {
    setDraft((d) => ({ ...d, models: d.models.filter((x) => x.modelId !== modelId) }));
  };

  const title = draft.label || (provider ? provider.id : t('detail.newTitle'));

  return (
    <div className="flex flex-col">
      {/* 面包屑：模型提供商（可点） / {title} */}
      <div className="flex items-center gap-2 text-[13px] mb-3">
        <button
          type="button"
          data-action-key="providers.provider.back"
          onClick={onBack}
          className="text-muted hover:text-accent transition-colors font-mono"
        >
          {t('section.title')}
        </button>
        <span className="text-border-strong">/</span>
        <span className="text-fg font-medium">{title}</span>
      </div>

      {/* logo + title + desc */}
      <div className="flex items-center gap-3 mb-4">
        <div
          aria-hidden
          className={
            'w-12 h-12 rounded-[12px] flex items-center justify-center shrink-0 ' +
            (draft.enabled ? 'bg-sage-bg text-sage' : 'bg-bg-warm text-muted')
          }
        >
          <span className="font-sans font-bold text-[24px] leading-none">
            {(draft.label || '?')[0]?.toUpperCase()}
          </span>
        </div>
        <div className="min-w-0">
          <div className="text-[16px] font-semibold text-fg truncate">{title}</div>
          <div className="text-[11px] text-muted font-mono">provider · anthropic_compatible</div>
        </div>
      </div>

      {/* 连接配置 section */}
      <SectionTitle title={t('detail.connectionTitle')} hint="connection" />
      <ComponentProviderFields
        draft={draft}
        onChange={handleFieldsChange}
        protocolOptions={protocolOptions}
      />

      {/* [v0.0.317] SaveBar 替换原自定义 inline save-bar */}
      <SaveBar
        variant="detail"
        dirty={dirty}
        saving={saving}
        onSave={handleSave}
        onCancel={handleReset}
      />

      <hr className="border-border my-6" />

      {/* 关联模型 section */}
      <SectionTitle title={t('detail.modelsTitle', { count: draft.models.length })} hint="models" />
      <button
        type="button"
        data-action-key="providers.model.create"
        onClick={() => openModal(null)}
        className="mb-2 px-3 py-1.5 text-sm text-accent border border-dashed border-border-strong rounded-md hover:border-accent hover:bg-accent-surface transition-colors self-start"
      >
        {t('detail.addModel')}
      </button>

      {draft.models.length === 0 ? (
        <div className="text-xs text-muted font-mono py-4">{t('detail.emptyModels')}</div>
      ) : (
        draft.models.map((m) => (
          <ComponentModelListCard
            key={m.modelId}
            model={m}
            onClick={() => openModal(m)}
            onDelete={() => handleModelDelete(m.modelId)}
          />
        ))
      )}

      {/* model 弹层 */}
      {modalOpen && (
        <ComponentModelEditModal
          model={editingModel}
          onConfirm={handleModelConfirm}
          onCancel={() => {
            setModalOpen(false);
            setEditingModel(null);
          }}
        />
      )}
    </div>
  );
}

/** section 标题：title + mono hint */
function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-3">
      <span className="text-[13px] font-semibold text-fg-2">{title}</span>
      {hint && <span className="text-[11px] text-muted font-mono ml-2">{hint}</span>}
    </div>
  );
}

/** dirty 判定：draft 与 snapshot 任一字段不同（含 protocolId 变化 + models 长度/内容 diff） */
function isDirty(a: ProviderDraft, b: ProviderDraft): boolean {
  if (a.label !== b.label || a.baseUrl !== b.baseUrl || a.apiKey !== b.apiKey || a.enabled !== b.enabled) return true;
  // [v0.0.53] protocolId 变化也算 dirty
  if (a.protocolId !== b.protocolId) return true;
  if (a.models.length !== b.models.length) return true;
  const am = new Map(a.models.map((m) => [m.modelId, m]));
  for (const m of b.models) {
    const o = am.get(m.modelId);
    if (!o) return true;
    if (
      o.label !== m.label ||
      o.enabled !== m.enabled ||
      o.contextWindow !== m.contextWindow ||
      o.maxOutputTokens !== m.maxOutputTokens
    ) return true;
  }
  return false;
}

export default ComponentProviderDetail;
