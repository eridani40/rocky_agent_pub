/**
 * component-model-or-plan-picker —— 「模型 / 方案」二合一选择器（跨页复用）
 * 参考: specs/ui/components/common/component-model-or-plan-picker.md（T6 新增）
 *       specs/tech/version_logs/v0.0.347/change_plan.md 决策㉕-㉚
 *
 * 职责：trigger 复用 ModelPickerTrigger；panel 自绘两段（上组「模型」= 内部 useProviders
 *   展平，下组「方案」= props plans）；选中态互斥呈现（模型比 providerId+modelId、方案比 planId）。
 * 边界：不扩展 ModelPicker/ModelPickerPanel（决策㉕）；互斥写策略由消费方落实（决策㉛ 严格互斥）；
 *   方案空 → 组标题保留 + 空态文案（不隐藏组标题）；i18n 走 ns prop（双消费方同构 5 keys）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviders, formatModelDisplay, type ModelSelection } from '../../lib/providers';
import { IconBox } from './component-icon-box';
import { ModelPickerTrigger } from './component-model-picker-trigger';

/** 二选一值：模型 或 方案（planName 由消费方经 plans 反查补齐） */
export type ModelOrPlanValue =
  | { kind: 'model'; selection: ModelSelection }
  | { kind: 'plan'; planId: string; planName: string };

export interface ModelOrPlanPickerProps {
  /** 当前选中；null = 未设置（trigger 显 placeholder） */
  value: ModelOrPlanValue | null;
  /** 方案清单（消费方各自拉 routingPlans 后传 {id,name}） */
  plans: { id: string; name: string }[];
  onPickModel: (sel: ModelSelection) => void;
  onPickPlan: (planId: string) => void;
  /** i18n 命名空间（modelOrPlan.* 5 keys 双 ns 同构；默认 app-dev-config） */
  ns?: 'app-dev-config' | 'studio';
  actionKey?: string;
  triggerClassName?: string;
}

/** 选中 ✓（复刻 ModelPickerPanel 视觉） */
function CheckMarkSvg() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-[13px] h-[13px] text-fg shrink-0"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/** 通用行 class（复刻 ModelPickerPanel：hover/active/selected 三态） */
const ROW_CLS =
  'w-full flex items-center gap-2 px-3 py-2 text-left rounded-md ' +
  'hover:bg-surface-2 data-[active=true]:bg-surface-3 transition-colors text-fg';

/** ModelOrPlanPicker —— 单 select 内上「模型」下「方案」二选一 */
export function ModelOrPlanPicker({
  value,
  plans,
  onPickModel,
  onPickPlan,
  ns = 'app-dev-config',
  actionKey,
  triggerClassName,
}: ModelOrPlanPickerProps): ReactNode {
  const { t } = useTranslation(ns);
  const { providers, error } = useProviders();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点外部收起（menu 与 trigger 都在 wrapRef 内，同 ModelPicker 范式）
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // 展平 providers（双层 enabled!==false 过滤，同 ModelPicker L79-91）
  const models = useMemo(
    () =>
      providers
        .filter((p) => p.enabled !== false)
        .flatMap((p) =>
          p.models
            .filter((m) => m.enabled !== false)
            .map((m) => ({
              providerId: p.id,
              providerLabel: p.label,
              modelId: m.modelId,
              modelLabel: formatModelDisplay({ providerId: p.id, modelId: m.modelId }, providers),
            })),
        ),
    [providers],
  );

  // 本地搜索（模型三字段 + 方案 name/id，大小写不敏感）
  const q = query.trim().toLowerCase();
  const filteredModels = useMemo(
    () =>
      q
        ? models.filter((it) =>
            [it.modelLabel, it.providerLabel, it.modelId].some((s) =>
              s?.toLowerCase().includes(q),
            ),
          )
        : models,
    [models, q],
  );
  const filteredPlans = useMemo(
    () =>
      q
        ? plans.filter(
            (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
          )
        : plans,
    [plans, q],
  );

  // trigger 展示（模型 = formatModelDisplay；方案 = 「方案 · <名>」前缀；未选 = placeholder）
  const triggerValue =
    value?.kind === 'model'
      ? {
          providerId: value.selection.providerId,
          modelId: value.selection.modelId,
          modelLabel: formatModelDisplay(value.selection, providers),
        }
      : value?.kind === 'plan'
        ? {
            providerId: '',
            modelId: value.planId,
            modelLabel: `${t('modelOrPlan.planPrefix')} · ${value.planName || plans.find((p) => p.id === value.planId)?.name || value.planId}`,
          }
        : null;

  const selModel =
    value?.kind === 'model' ? { providerId: value.selection.providerId, modelId: value.selection.modelId } : null;
  const selPlanId = value?.kind === 'plan' ? value.planId : null;

  return (
    <div ref={wrapRef} className="relative">
      <ModelPickerTrigger
        value={triggerValue}
        placeholder={t('modelOrPlan.placeholder')}
        onClick={() => setOpen((v) => !v)}
        actionKey={actionKey}
        title={value?.kind === 'model' ? `${value.selection.providerId} / ${value.selection.modelId}` : undefined}
        ariaExpanded={open}
        className={triggerClassName ?? 'w-[180px] whitespace-nowrap overflow-hidden text-ellipsis'}
      />
      {open && (
        <div className="absolute top-full mt-1 left-0 z-[var(--z-popover)]">
          <div
            role="listbox"
            className="w-[300px] bg-surface border border-border rounded-lg shadow-lg py-1 overflow-hidden"
          >
            {/* 搜索框（复刻 ModelPickerPanel searchable） */}
            <div className="px-2.5 py-2 border-b border-border">
              <input
                data-action-key="common.model-or-plan.search"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-[30px] text-[12.5px] px-2 rounded-md border border-border-2 bg-surface w-full outline-none focus:border-border-strong"
              />
            </div>
            <div className="max-h-[380px] overflow-y-auto">
              {/* 上组：模型（组标题恒显） */}
              <div
                className="px-3 py-1.5 text-xs text-muted select-none border-b border-border"
                role="heading"
                aria-level={2}
              >
                {t('modelOrPlan.groupModels')}
              </div>
              <div className="p-1">
                {filteredModels.map((it) => {
                  const selected =
                    selModel?.providerId === it.providerId && selModel?.modelId === it.modelId;
                  return (
                    <button
                      key={`${it.providerId}-${it.modelId}`}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      data-action-key="common.model-or-plan.pick-model"
                      data-active={selected ? 'true' : undefined}
                      onClick={() => {
                        onPickModel({ providerId: it.providerId, modelId: it.modelId });
                        setOpen(false);
                      }}
                      className={ROW_CLS + (selected ? ' font-medium' : '')}
                    >
                      <IconBox hueBy={it.providerId} size={24} />
                      <span className="font-mono text-[13px] truncate flex-1 min-w-0">{it.modelLabel}</span>
                      {selected && <CheckMarkSvg />}
                    </button>
                  );
                })}
                {error && filteredModels.length === 0 && (
                  <div className="px-3 py-2 text-xs text-muted">{`加载失败：${error}`}</div>
                )}
              </div>
              {/* 下组：方案（组标题恒显；空态文案不隐藏标题） */}
              <div className="border-t border-border">
                <div
                  className="px-3 py-1.5 text-xs text-muted select-none border-b border-border"
                  role="heading"
                  aria-level={2}
                >
                  {t('modelOrPlan.groupPlans')}
                </div>
                <div className="p-1">
                  {filteredPlans.map((p) => {
                    const selected = selPlanId === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        data-action-key="common.model-or-plan.pick-plan"
                        data-active={selected ? 'true' : undefined}
                        onClick={() => {
                          onPickPlan(p.id);
                          setOpen(false);
                        }}
                        className={ROW_CLS + (selected ? ' font-medium' : '')}
                      >
                        <IconBox hueBy={p.id} size={24} />
                        <span className="font-mono text-[13px] truncate flex-1 min-w-0">{p.name}</span>
                        {selected && <CheckMarkSvg />}
                      </button>
                    );
                  })}
                  {plans.length === 0 && (
                    <div className="px-3 py-2 text-xs text-muted">{t('modelOrPlan.emptyPlans')}</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ModelOrPlanPicker;
