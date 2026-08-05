/**
 * section-observability-detail — 可观测性详情/编辑视图
 * 参考: specs/ui/components/app-dev-config-page/observability-config/section-observability-detail.md
 *       设计稿视觉基线: reqs/v0.0.11/easy-opc-config-v10.html L476-553
 *
 * 职责：breadcrumb + 头部（logo + 名称 + type + 启停）+ 基础信息 section（name + type + baseUrl，
 *   name/type **竖排各占一整行**，用户决策②对设计稿差异）+ 认证密钥 section（publicKey + secretKey）
 *   + save-bar（dirty 指示 + 重置 + 保存）。
 * dirty 判定：enabled 不计（toggle 即时）。secretKey 用 primitive-secret-input 四态机
 *   （value=已保存值，mask 展示；onCommit 提交新值→updateField→标 dirty；编辑态自动清空 draft 等重输）。
 *   后端 GET 返回明文，SecretInput display 态自动 mask（头4+*+尾4 长度对齐）；编辑态清空重输。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ToggleSwitch } from '../../framework/primitives/toggle-switch';
import { SecretInput } from '../../framework/primitives/secret-input';
import { PrimitiveTooltip } from '../../common/primitive-tooltip';
import {
  isObservabilityDirty,
  isObservabilityValid,
  type ObservabilityConfig,
} from './types';

interface SectionObservabilityDetailProps {
  /** 初始数据（新增时父级构造空壳） */
  initialData: ObservabilityConfig;
  /** 是否新增模式（影响头部 toggle 是否禁用 + breadcrumb 文案） */
  isNew: boolean;
  /** 返回 list */
  onBack: () => void;
  /** 保存 → 父级落库 */
  onSave: (data: ObservabilityConfig) => void;
  /** 头部 toggle 即时（仅编辑态；新增态无 id 不触发） */
  onToggle: (id: string, enabled: boolean) => void;
}

/** 详情/编辑视图 */
export function SectionObservabilityDetail({
  initialData,
  isNew,
  onBack,
  onSave,
  onToggle,
}: SectionObservabilityDetailProps) {
  // draft：受控编辑副本；saved：已保存基线（dirty 判定对比）
  const [draft, setDraft] = useState<ObservabilityConfig>(initialData);
  const [saved] = useState<ObservabilityConfig>(initialData);
  // [v0.0.62 i18n] observability 详情文案走 app-dev-config ns；通用保存/重置走 common ns
  const { t } = useTranslation('app-dev-config');
  const { t: tc } = useTranslation('common');

  const dirty = isObservabilityDirty(draft, saved);
  const valid = isObservabilityValid(draft);
  const canSave = dirty && valid;

  /** 通用字段更新（enabled 走 toggle 不走这里） */
  const updateField = <K extends keyof ObservabilityConfig>(k: K, v: ObservabilityConfig[K]) => {
    setDraft((prev) => ({ ...prev, [k]: v }));
  };

  /** 头部 toggle：编辑态即时生效 + 本地同步 draft.enabled；新增态禁用 */
  const handleHeaderToggle = (next: boolean) => {
    if (isNew) return; // 新增无 id，先保存
    updateField('enabled', next);
    onToggle(initialData.id, next);
  };

  return (
    <div className="flex flex-col">
      {/* breadcrumb：可观测性 / {name 或 新建配置} */}
      <div className="flex gap-2 mb-4 items-center text-[12px] font-mono">
        <button
          type="button"
          data-action-key="settings.observability.back"
          onClick={onBack}
          className="text-muted-2 hover:text-accent transition-colors"
        >
          {t('observability.breadcrumbRoot')}
        </button>
        <span className="text-border-strong">/</span>
        <span className="text-accent">
          {isNew ? t('observability.newConfig') : (draft.name || t('observability.unnamed'))}
        </span>
      </div>

      {/* header */}
      <div className="pt-6 pb-5 border-b border-border flex items-center gap-3">
        <div

          className="w-9 h-9 rounded-[10px] bg-[var(--color-sage)] flex items-center justify-center shrink-0"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 12h3l3 8 4-16 3 8h5" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-[20px] font-bold tracking-[-0.02em] text-fg">
            {draft.name || t('observability.newConfig')}
          </h2>
          <div className="text-[12px] font-mono text-muted mt-0.5">
            {t('observability.langfuseDesc')}
          </div>
        </div>
        {/* 右：状态文案 + toggle（新增态禁用） */}
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] font-mono text-muted">
            {draft.enabled ? t('observability.enabled') : t('observability.disabled')}
          </span>
          <ToggleSwitch
            value={draft.enabled}
            onChange={handleHeaderToggle}
            label={t('observability.toggleLabel')}

          />
        </div>
      </div>

      {/* 基础信息 section */}
      <section className="mt-7">
        <div className="flex items-center gap-2 mb-1.5">
          {/* zap icon */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg" aria-hidden>
            <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
          </svg>
          <h3 className="text-[14px] font-bold text-fg">{t('observability.basic.title')}</h3>
        </div>
        <p className="text-[11px] font-mono text-muted mb-5">{t('observability.basic.hint')}</p>

        {/* name（竖排，各占一整行 — 用户决策②） */}
        <FieldRow label={t('observability.field.name')} hint="name">
          <input
            type="text"

            placeholder="Production Tracing"
            value={draft.name}
            onChange={(e) => updateField('name', e.target.value)}
            className={INPUT_CLASS}
          />
        </FieldRow>

        {/* type（竖排，disabled 固定 langfuse） */}
        <FieldRow label={t('observability.field.type')} hint="type">
          <input
            type="text"

            value={draft.type}
            disabled
            className={INPUT_CLASS + ' opacity-60 cursor-not-allowed bg-bg-warm'}
          />
        </FieldRow>

        {/* baseUrl */}
        <FieldRow label="Base URL" hint="base_url">
          <input
            type="text"

            placeholder="https://cloud.langfuse.com"
            value={draft.baseUrl}
            onChange={(e) => updateField('baseUrl', e.target.value)}
            className={INPUT_CLASS}
          />
        </FieldRow>
      </section>

      {/* 分隔线 */}
      <div className="h-px bg-border my-7" />

      {/* 认证密钥 section */}
      <section>
        <div className="flex items-center gap-2 mb-1.5">
          {/* check icon */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg" aria-hidden>
            <path d="M9 12l2 2 4-4" />
            <circle cx="12" cy="12" r="10" />
          </svg>
          <h3 className="text-[14px] font-bold text-fg">{t('observability.auth.title')}</h3>
          <span className="text-[10px] text-muted">{t('observability.auth.localOnly')}</span>
        </div>
        <p className="text-[11px] font-mono text-muted mb-5">{t('observability.auth.hint')}</p>

        {/* publicKey */}
        <FieldRow label="Public Key" hint="pk">
          <input
            type="text"

            placeholder="pk-lf-..."
            value={draft.publicKey}
            onChange={(e) => updateField('publicKey', e.target.value)}
            className={INPUT_CLASS}
          />
        </FieldRow>

        {/* secretKey：primitive-secret-input 四态机（mask 展示 / 编辑态明文 / ✓ commit → updateField 标 dirty）。
            SecretInput 编辑态自动清空 draft 等重输（spec 行为），后端 GET 回来 '***' 时 mask 视觉等同。 */}
        <FieldRow label="Secret Key" hint="sk">
          <SecretInput
            value={draft.secretKey}
            onCommit={(next) => updateField('secretKey', next)}
            placeholder="sk-lf-..."

          />
        </FieldRow>
      </section>

      {/* 分隔线（对齐 basic→auth 的视觉节奏） */}
      <div className="h-px bg-border my-7" />

      {/* 物理层记录 section（v0.0.50：logPhysical 开关，默认 off）
          v0.0.50 调整：常显长说明 → hover tooltip（info icon），界面精简；
          label 改「双重记录」（业务语义），hint 保留 logPhysical（字段名）。
          tooltip 文案集中说明 logical+physical 双 generation + 不污染 usage + 重启/新会话生效 */}
      <section>
        <div className="flex items-center gap-2 mb-1.5">
          {/* activity icon */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg" aria-hidden>
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
          </svg>
          <h3 className="text-[14px] font-bold text-fg">{t('observability.physical.title')}</h3>
        </div>

        <div

          className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border bg-surface-2"
        >
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-[13px] font-semibold text-fg-2">
              {t('observability.dualRecord.label')} <span className="font-mono text-[11px] text-muted ml-1">{t('observability.dualRecord.hint')}</span>
            </span>
            {/* hover info icon：鼠标悬停显 tooltip（PrimitiveTooltip，不占排版流，键盘 focus 也可触发） */}
            <PrimitiveTooltip
              content={t('observability.dualRecord.tooltip')}

            >
              <span

                aria-label={t('observability.dualRecord.ariaLabel')}
                className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-border text-muted hover:text-fg-2 hover:border-border-strong text-[10px] font-mono cursor-help leading-none"
              >
                ?
              </span>
            </PrimitiveTooltip>
          </div>
          <ToggleSwitch
            value={draft.logPhysical}
            onChange={(next) => updateField('logPhysical', next)}
            label={t('observability.dualRecord.toggleLabel')}

          />
        </div>
      </section>

      {/* save-bar */}
      <div className="flex items-center gap-3 mt-5 pt-5 border-t border-border">
        <span

          className={'text-[11px] font-mono flex-1 ' + (dirty ? 'text-accent' : 'text-[var(--color-sage)]')}
        >
          {dirty ? t('observability.dirtyHint') : t('observability.savedHint')}
        </span>
        <button
          type="button"
          data-action-key="settings.observability.reset"
          disabled={!dirty}
          onClick={() => setDraft({ ...saved })}
          className={
            'px-4 py-1.5 rounded-md border border-border text-fg-2 text-sm transition-colors hover:bg-bg-warm ' +
            (!dirty ? 'opacity-40 cursor-not-allowed' : '')
          }
        >
          {t('observability.resetBtn')}
        </button>
        <button
          type="button"
          data-action-key="settings.observability.save"
          disabled={!canSave}
          onClick={() => onSave(draft)}
          className={
            'px-4 py-1.5 rounded-md text-sm font-medium text-white transition-colors ' +
            (canSave ? 'bg-accent hover:opacity-90' : 'bg-accent opacity-40 cursor-not-allowed')
          }
        >
          {tc('action.save')}
        </button>
      </div>

      {/* 重启/下 session 生效提示（spec §3.4.1 决策） */}
      <p className="mt-3 text-[11px] font-mono text-muted">
        {t('observability.changeNotice')}
      </p>
    </div>
  );
}

/** f-input 视觉基线（对齐设计稿 .f-input + key-input primitive） */
const INPUT_CLASS =
  'w-full border border-border-2 rounded-lg px-3 py-2 bg-surface-2 text-fg text-[13px] font-mono outline-none transition-colors focus:border-accent focus:shadow-[var(--shadow-focus)] hover:border-border-strong';

/** 单字段行（label + hint + 控件） */
function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-5">
      <label className="block text-[12px] font-semibold text-fg-2 mb-1.5">
        {label} <span className="font-mono text-[11px] text-muted ml-1">{hint}</span>
      </label>
      {children}
    </div>
  );
}

export default SectionObservabilityDetail;
