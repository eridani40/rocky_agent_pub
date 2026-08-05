/**
 * component-key-model-picker —— 配置页 model 选择器 primitive
 * 参考: specs/ui/components/common/component-key-model-picker.md
 *       specs/prd/version_logs/v0.0.89/02-default-models-and-request.md §3.3
 *       specs/tech/version_logs/v0.0.165/change_plan.md §7（v0.0.165 视觉重塑：内部组装 trigger + panel primitive）
 *
 * 职责：配置页 key 卡片形式的 model 选择器。trigger button + dropdown 菜单（enabled provider × enabled 文本 model）
 *   + x 清除按钮。选了模型后右侧显示 x，点 x 清空字段（onChange(undefined)）。
 *
 * 与 chat-input-bar 的 InputModelPicker 是**不同组件**：本组件不实现「a(默认)」双项语义
 *   （配置页本身在定义默认，不应把「默认」列进选项）；要清除用 x。
 *
 * 数据：挂载 GET /provider → enabled provider × enabled 文本 model 扁平表；本组件**不含默认项**（用户裁决 2026-07-17）。
 *
 * v0.0.165 视觉重塑：trigger + panel 内部走 `ModelPickerTrigger` / `ModelPickerPanel` primitive
 *   （regulation 02 §7 300px 白卡 + IconBox + 黑✓）；testid 契约完整向后兼容。
 *
 * 边界：纯受控（value/onChange）；菜单 open 态内部自管（点击外部关闭）；
 *   ModelRef = 纯 modelId string（不含 providerId，运行时跨 enabled provider 反查）；
 *   单文件 ≤ 200 行。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { listProviders, type ProviderInstance } from '../../lib/api-client';
import { ModelPickerTrigger } from './component-model-picker-trigger';
import { ModelPickerPanel, type PickerItem } from './component-model-picker-panel';

interface KeyModelPickerProps {
  /** 当前值（ModelRef = 纯 modelId string；未配 = undefined） */
  value?: string;
  /** 选择/清除上抛（选具体模型 → modelId；清除 → undefined） */
  onChange: (next: string | undefined) => void;
}

/** model picker primitive（v0.0.165 内部走统一 trigger + panel primitive） */
export function KeyModelPicker({ value, onChange }: KeyModelPickerProps) {
  const { t } = useTranslation('app-dev-config');
  const [items, setItems] = useState<PickerItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 挂载：GET /provider → 扁平 enabled provider × enabled 文本 model 列表
  useEffect(() => {
    let cancelled = false;
    listProviders()
      .then((providers: ProviderInstance[]) => {
        if (cancelled) return;
        const list: PickerItem[] = [];
        for (const p of providers) {
          if (!p.enabled) continue;
          for (const m of p.models ?? []) {
            if (!m.enabled) continue;
            // 前端 ModelInstance 类型未暴露 inputModalities；服务端 protocol 默认 ['text']，
            // 此处仅按 enabled 过滤（全部视为文本模型，符合 default_models 用例）
            list.push({
              providerId: p.id,
              providerLabel: p.label || p.id,
              modelId: m.modelId,
              modelLabel: m.label || m.modelId,
            });
          }
        }
        setItems(list);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 点击外部关闭菜单
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // 命中当前 value 的 item（构造 trigger value 用 provider hash 色 IconBox）
  const currentItem = useMemo(() => {
    if (!value || !items) return null;
    return items.find((it) => it.modelId === value) ?? null;
  }, [value, items]);

  // trigger value 组装：优先命中的 item（IconBox 有 provider 色）；命中不到但 value 存在
  // （providers 未加载 / provider 被删）→ 降级为纯文本 trigger（无 IconBox 但显 modelId）。
  const triggerValue = value
    ? currentItem
      ? {
          providerId: currentItem.providerId,
          modelId: currentItem.modelId,
          // trigger 显 `${providerLabel} / ${modelLabel}`（对齐 formatModelDisplay 口径，
          // 与 ModelPicker / InputModelPicker 一致——配置页默认模型不再显裸 modelId）
          modelLabel: `${currentItem.providerLabel} / ${currentItem.modelLabel}`,
        }
      : {
          // 降级：providers 未加载或 provider 被删/禁用 → 无 IconBox，仅显 modelId
          providerId: '',
          modelId: value,
          modelLabel: value,
        }
    : null;

  // trigger 未配时显 i18n「未配置」；已配显 `${providerLabel} / ${modelLabel}`
  const placeholder = t('defaultModels.unconfigured');
  const isEmpty = !value;

  // panel value（selected 判定）：当前命中的 provider+model
  const panelValue = currentItem
    ? { providerId: currentItem.providerId, modelId: currentItem.modelId }
    : null;

  const emptyMessage =
    items === null ? t('defaultModels.loading') : t('defaultModels.empty');

  return (
    <div ref={wrapRef} className="relative flex items-center gap-2 w-full">
      {/* trigger + IconBox（provider hash 色）；trigger primitive 内部渲 IconBox 22px */}
      <div className="flex-1 min-w-0">
        <ModelPickerTrigger
          value={triggerValue}
          placeholder={placeholder}
          onClick={() => setOpen((p) => !p)}
          actionKey="common.model-picker.open"
          ariaExpanded={open}
          className="w-full"
        />
      </div>
      {/* x 清除按钮：始终渲染固定占位（isEmpty 时 visibility:hidden 不可见但占位）。
          组件规范 §11：条件内容只允许「出现/不出现」，不允许尺寸变化 —— trigger 宽度恒定，
          不随有值/无值变。禁条件渲染（{cond && <X/>}）致 flex-1 trigger 被挤；用 visibility 占位。 */}
      <button
        type="button"
        data-action-key="common.model-picker.clear"
        aria-label={t('defaultModels.clear')}
        disabled={isEmpty}
        onClick={() => onChange(undefined)}
        className={
          'shrink-0 text-muted hover:text-fg text-sm px-1 ' +
          (isEmpty ? 'invisible' : '')
        }
      >
        ✕
      </button>
      {/* dropdown 菜单（open 时渲染，向右下展开） */}
      {open && (
        <div className="absolute top-full left-0 z-[var(--z-popover)] mt-1 w-full min-w-[280px]">
          <ModelPickerPanel
            items={items ?? []}
            value={panelValue}
            onPick={(it) => {
              onChange(it.modelId);
              setOpen(false);
            }}
            searchable
            searchPlaceholder={t('defaultModels.searchPlaceholder', { defaultValue: '搜索模型...' })}
            showModelIdSubtitle
            emptyMessage={items && items.length === 0 ? emptyMessage : undefined}
            className="w-full"
          />
        </div>
      )}
    </div>
  );
}

export default KeyModelPicker;
