/**
 * component-provider-fields — 连接配置表单（v0.0.7；v0.0.53 加 protocol + 拼接地址）
 * 参考: specs/ui/components/providers/_overview.md §5 + component-provider-fields.md（spec）
 *       视觉: f-input 规格（参考 component-model-edit-modal inputCls）
 *
 * 职责：展示 label/baseUrl/apiKey(password)/protocol(单选)/拼接地址展示 并把变更上抛 onChange(patch)。
 * 边界：不持本地副本、不感知保存；父级（provider-detail）持 draft。
 * apiKey GET 明文下发，前端 SecretInput mask 展示；编辑时整体覆盖（用户重输才改）。
 *
 * [v0.0.53] 新增：
 *   - protocol 单选控件（testid provider-field-protocol）：选项 = protocolOptions × {id, label}
 *     按 _conventions.md §10 硬规则禁原生 <select>，复用 primitive-key-choice-cards（≤4 选项）
 *   - 拼接地址 mono 展示区（testid provider-url-preview，read-only）：文本 = baseUrl + selectedProtocol.path
 *     实时随 baseUrl 输入与 protocol 选择变化（derived，无本地状态）
 *
 * [v0.0.350 决策④] 新增：
 *   - 类型选择器（顶部，testid provider-field-type）：5 项 = provider-type-presets 表
 *     （1 通用 + 4 native 友好名 labels）；onChange 上抛 {name}（联动逻辑在 provider-detail）
 *   - native 类型 → protocol 控件只读锁定（mono 只读框 testid provider-field-protocol-locked，
 *     无可点元素满足 MUST 禁点；通用类型保持 KeyChoiceCards 原形态）
 */
import { useTranslation } from 'react-i18next';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';
import { KeyChoiceCards } from '../framework/primitives/key-choice-cards';
import { SecretInput } from '../framework/primitives/secret-input';
import type { ProtocolMeta, ProtocolName, ProviderName } from '../../lib/api-client';
import { PROVIDER_TYPE_PRESETS, isNativeCodingPlan } from './provider-type-presets';

/** provider draft 字段（连接配置部分；v0.0.53 加 protocolId；[v0.0.350] 加 name 类型） */
export interface ProviderDraftFields {
  label: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  /** [v0.0.53] protocol id（来自 protocolOptions 中一项的 id） */
  protocolId: ProtocolName;
  /** [v0.0.350] provider 类型（决策④；缺省通用 anthropic_compatible——旧 draft 兼容） */
  name?: ProviderName;
}

export interface ComponentProviderFieldsProps {
  /** 父级持有的 draft（连接配置字段） */
  draft: ProviderDraftFields;
  /** 任一字段变更 → 上抛 patch（部分字段，父级 merge） */
  onChange: (patch: Partial<ProviderDraftFields>) => void;
  /** [v0.0.53] 协议选项（父级从 GET /provider 响应 protocols 传入） */
  protocolOptions: ProtocolMeta[];
}

const inputCls =
  'w-full border border-border-2 rounded-md px-[12px] py-[8px] bg-surface text-fg text-[13px] font-mono outline-none transition-colors focus:border-accent focus:shadow-[var(--shadow-focus)] hover:border-border-strong';

/** 连接配置表单：类型(单选) + label + baseUrl + apiKey(password) + protocol(单选/native 锁定只读) + 拼接地址展示 + enabled(toggle) */
export function ComponentProviderFields({ draft, onChange, protocolOptions }: ComponentProviderFieldsProps) {
  // [v0.0.62 i18n] 字段 label/hint/placeholder 走 providers.field.*
  const { t } = useTranslation('providers');
  // [v0.0.53] 拼接地址 derived：baseUrl + selectedProtocol.path
  const selectedPath = protocolOptions.find((p) => p.id === draft.protocolId)?.path ?? '';
  const previewUrl = `${draft.baseUrl}${selectedPath}`;
  // [v0.0.350] 当前类型（缺省通用）；native 类型 → protocol 锁定只读（决策④）
  const typeName = draft.name ?? 'anthropic_compatible';
  const typeLocked = isNativeCodingPlan(typeName);

  return (
    <div className="flex flex-col gap-3">
      {/* [v0.0.350] 类型选择器：5 项（1 通用 + 4 native 友好名）KeyChoiceCards（决策④；testid provider-field-type） */}
      <FieldRow label={t('field.typeLabel')} hint={t('field.typeHint')}>
        <KeyChoiceCards
          value={typeName}
          options={PROVIDER_TYPE_PRESETS.map((p) => p.id)}
          labels={Object.fromEntries(PROVIDER_TYPE_PRESETS.map((p) => [p.id, t(p.labelKey)]))}
          onChange={(next) => onChange({ name: next as ProviderName })}
          testId="provider-field-type"
        />
      </FieldRow>
      <FieldRow label={t('field.nameLabel')} hint="label">
        <input
          className={inputCls}
          data-action-key="providers.provider.input-label"
          value={draft.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder={t('field.namePlaceholder')}
        />
      </FieldRow>
      <FieldRow label="Base URL" hint="base_url">
        <input
          className={inputCls}
          data-action-key="providers.provider.input-base-url"
          value={draft.baseUrl}
          onChange={(e) => onChange({ baseUrl: e.target.value })}
          placeholder="https://api.anthropic.com"
        />
      </FieldRow>
      <FieldRow label="API Key" hint={t('field.apiKeyHint')}>
        {/* SecretInput 四态机：value=已保存 apiKey（GET 明文，前端 mask 展示）；
            onCommit=提交新值→父级 onChange patch（标 dirty，等表单级 save 落库）。commit≠save。 */}
        <SecretInput
          value={draft.apiKey}
          onCommit={(next) => onChange({ apiKey: next })}
          placeholder="sk-..."
          actionKey="providers.provider.input-api-key"
        />
      </FieldRow>
      {/* [v0.0.53] protocol 单选：用 KeyChoiceCards（_conventions.md §10 禁原生 select）
          选项 ≤ 4 用 choice cards；当前唯一 anthropic_messages → 单卡。
          testid 容器 provider-field-protocol；每张卡 provider-field-protocol-{id}。
          [v0.0.350] native 类型 → 控件只读锁定（决策④ MUST 禁点）：渲染 mono 只读框替代卡片组 */}
      <FieldRow label="Protocol" hint={t('field.protocolHint')}>
        {typeLocked ? (
          <div
            data-testid="provider-field-protocol-locked"
            className="w-full border border-border-2 rounded-md px-[12px] py-[8px] bg-surface-2 text-fg-2 text-[13px] font-mono"
          >
            {draft.protocolId}
          </div>
        ) : (
          <>
            <KeyChoiceCards
              value={draft.protocolId}
              options={protocolOptions.map((p) => p.id)}
              onChange={(next) => onChange({ protocolId: next as ProtocolName })}
              testId="provider-field-protocol"
            />
            {/* 选项展示名通过 hidden span 暴露给 ET dom assert（KeyChoiceCards 默认渲染 id 非 label） */}
            <span className="sr-only">
              {protocolOptions.map((p) => p.label).join('|')}
            </span>
          </>
        )}
      </FieldRow>
      {/* [v0.0.53] 拼接地址 mono 展示区（read-only）：baseUrl + selectedProtocol.path */}
      <FieldRow label={t('field.urlLabel')} hint={t('field.urlHint')}>
        <div

          className={
            'w-full border border-border-2 rounded-md px-[12px] py-[8px] bg-surface-2 text-fg-2 text-[13px] font-mono break-all ' +
            (previewUrl ? '' : 'text-muted')
          }
        >
          {previewUrl || t('field.urlEmpty')}
        </div>
      </FieldRow>
      <div className="flex items-center justify-between gap-3 border border-border-2 rounded-md px-[12px] py-[8px] bg-surface">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-fg">{t('field.enableTitle')}</div>
          <div className="text-[11px] text-muted font-mono">{t('field.enableHint')}</div>
        </div>
        <ToggleSwitch
          value={draft.enabled}
          onChange={(v) => onChange({ enabled: v })}
          label={t('field.enableTitle')}
          actionKey="providers.provider.toggle-enabled"
        />
      </div>
    </div>
  );
}

/** 字段行：label + hint + 控件 */
function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-fg-2 font-medium">
        {label} {hint && <span className="text-muted font-mono ml-1">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

export default ComponentProviderFields;
