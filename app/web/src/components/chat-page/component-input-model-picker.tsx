/**
 * component-input-model-picker —— chat-input-bar 按钮行内的模型选择器
 * 参考: specs/ui/components/chat-page/component-input-model-picker.md
 *       specs/tech/version_logs/v0.0.165/change_plan.md §7（v0.0.165 panel 视觉重塑：走统一 ModelPickerPanel primitive）
 *
 * 职责：
 *   - 21px 纯图标 trigger（BrainIcon size=12，按钮行最左位）—— v0.0.165 保持特例（chat-input 3 按钮 21px 尺寸统一，见 spec §9.1）
 *   - hover → 单行预览菜单（testid model-picker-preview）：展示当前生效模型（selected 高亮）或「未配置」
 *   - click → 完整菜单（testid model-picker-menu）：走统一 ModelPickerPanel primitive
 *     * 默认项（若 hasDefault）→ panel.extraTopItems 顶部置顶
 *     * 全量 options → items（default 在列表中重复出现一次——正确行为，用户裁决 2026-07-17 明确保留）
 *   - 双场景：配了 defaultA → 顶部「a(默认)」+ 完整列表（a 重复）；未配 → 仅完整列表
 *   - 选「a(默认)」→ onChange({ providerId:'', modelId:'default' })（保留字=跟随默认）
 *   - 选列表里 a → onChange({ providerId, modelId })（固定 a）
 *
 * 默认模型 4 源优先级（spec §7）：defaultModelId+defaultModelProviderId 复合（studio 精确）>
 *   defaultModelId 跨 provider 反查（back-compat）> defaultModel（父级算好）> 内部自拉（playground GET /config/app default_models.chat）
 *
 * 边界：subagent readOnly 分支由父级不挂载；session running 时 disabled；hover 预览仅在 !open 时显。
 * 单文件 ≤300 行。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviders, formatModelDisplay, findProviderIdByModelId, type ModelSelection } from '../../lib/providers';
import { BrainIcon } from './icons';
import { CHAT_ACTION_BTN_CLS } from './action-button-styles';
import { ModelPickerPanel, type PickerItem } from '../common/component-model-picker-panel';
import { resolveApiBase } from '../../lib/api-base';

interface InputModelPickerProps {
  /** 当前选中（modelId='default' 哨兵 = 跟随默认；具体 ModelRef = 固定；null = 未回填） */
  model: ModelSelection | null;
  /** studio 原始默认模型 id（纯 modelId，如 "MiniMax-M3"）。picker 反查 provider 得 effectiveDefault。 */
  defaultModelId?: string;
  /** defaultModelId 的配对 providerId（复合 ModelRef 精确，消除同名歧义） */
  defaultModelProviderId?: string;
  /** defaultA 派生（playground 走 default_models.chat）；undefined=父级未传→内部自拉；null=显式无默认 */
  defaultModel?: ModelSelection | null;
  /** [v0.0.357] 该 kind 挂载的默认方案（chrome.defaultRoutingPlan 透传）；null/undefined = 无方案维度默认 */
  defaultPlan?: { planId: string; planName: string } | null;
  /** session running 时 disabled（仍可见，不响应点击） */
  disabled?: boolean;
  /** 选中变更上抛（顶部「a(默认)」→ {providerId:'',modelId:'default'}；列表 a → 具体 ModelRef） */
  onChange: (sel: ModelSelection) => void;
}

/** GET /config/app?group=default_models&key=default 响应形状（最小局部定义） */
interface DefaultModelsConfig {
  chat?: string;
  summary?: string;
}

/**
 * preview 与 menu 共用的容器定位 className（同几何：绝对定位、上方左对齐展开）：
 *   absolute bottom-full right-0 mb-1（菜单右侧对齐 trigger 右沿、下沿贴 trigger 上沿，向上向左延伸）；
 *   z=--z-popover（L2）浮在消息流之上；宽度 300px（regulation 02 §7 白卡宽度）；
 *   实际白卡视觉（bg-surface / border / shadow-lg / rounded-lg）由 ModelPickerPanel primitive 内提供；
 *   preview 单条时也需相同容器视觉，见 previewContainerCls。
 */
const PICKER_POSITION_CLS = 'absolute bottom-full right-0 mb-1 z-[var(--z-popover)]';

/**
 * hover 预览容器（单条）—— 与 ModelPickerPanel 共用视觉（regulation 02 §7 白卡）：
 *   相同 bg/border/shadow/rounded/padding，只是内容是单条 preview item 而非可选列表。
 */
const PREVIEW_CONTAINER_CLS =
  'w-[300px] bg-surface border border-border rounded-lg shadow-lg py-1 overflow-hidden';

/**
 * InputModelPicker：chat-input-bar 按钮行内的模型选择 trigger + hover 预览 / click 菜单。
 * 挂载时拉 providers（useProviders）+ default_models.chat（GET /config/app）。
 */
export function InputModelPicker({
  model,
  defaultModelId,
  defaultModelProviderId,
  defaultModel,
  defaultPlan,
  disabled,
  onChange,
}: InputModelPickerProps) {
  const { providers, error } = useProviders();
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  // hover state（mouseenter/leave）—— 仅在 !open 时显预览菜单
  const [hovered, setHovered] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [internalDefault, setInternalDefault] = useState<ModelSelection | null>(null);
  const [internalLoaded, setInternalLoaded] = useState(false);

  useEffect(() => {
    // 优先级守卫：defaultModelId（studio）或 defaultModel（显式）任一传入 → 不走内部自拉。
    if (defaultModel !== undefined || defaultModelId !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${resolveApiBase()}/config/app?group=default_models&key=default`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          if (!cancelled) setInternalLoaded(true);
          return;
        }
        const data = (await res.json()) as { value?: DefaultModelsConfig | null };
        if (cancelled) return;
        const chatModelId = data.value?.chat;
        if (chatModelId) {
          const pid = findProviderIdByModelId(providers, chatModelId);
          setInternalDefault(pid ? { providerId: pid, modelId: chatModelId } : null);
        } else {
          setInternalDefault(null);
        }
      } catch {
        // 拉取失败：视为未配默认（不影响主流程）
      } finally {
        if (!cancelled) setInternalLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [defaultModel, defaultModelId, defaultModelProviderId, providers]);

  // 点外部关闭 click 菜单
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // 默认模型 4 源优先级（spec §7）
  let effectiveDefault: ModelSelection | null;
  if (defaultModelId !== undefined) {
    if (!defaultModelId || defaultModelId === 'default') {
      effectiveDefault = null;
    } else if (defaultModelProviderId) {
      // 反查时配套判 enabled —— 默认项指向停用 provider 时第一源失败，
      // 落到 findProviderIdByModelId（也已跳过 disabled），全 fail 则 effectiveDefault=null（显「未配置」）
      const p = providers.find((it) => it.id === defaultModelProviderId && it.enabled !== false);
      const hasModel = p?.models.some((m) => m.modelId === defaultModelId);
      if (p && hasModel) {
        effectiveDefault = { providerId: defaultModelProviderId, modelId: defaultModelId };
      } else {
        const pid = findProviderIdByModelId(providers, defaultModelId);
        effectiveDefault = pid ? { providerId: pid, modelId: defaultModelId } : null;
      }
    } else {
      const pid = findProviderIdByModelId(providers, defaultModelId);
      effectiveDefault = pid ? { providerId: pid, modelId: defaultModelId } : null;
    }
  } else if (defaultModel !== undefined) {
    effectiveDefault = defaultModel;
  } else {
    effectiveDefault = internalDefault;
  }
  const hasDefault = effectiveDefault !== null && effectiveDefault !== undefined;
  void internalLoaded;

  // [v0.0.357] 默认语义双维度：默认模型 or 挂载方案（T6 互斥，方案优先口径与 resolve 一致）
  const hasPlan = defaultPlan != null;
  const hasDefaultRoute = hasDefault || hasPlan;

  const isReservedDefault = model?.modelId === 'default';
  const isUnconfigured = isReservedDefault ? !hasDefaultRoute : !model;
  const triggerTone = isUnconfigured ? 'text-muted' : 'text-fg';

  // hover 预览单条内容（spec §3 四态；方案优先于「未配置」）
  let previewLabel: string;
  let previewSelected: boolean;
  if (isReservedDefault && hasDefault) {
    previewLabel = `${formatModelDisplay(effectiveDefault, providers)}（默认）`;
    previewSelected = true;
  } else if (isReservedDefault && hasPlan) {
    previewLabel = t('planDefaultLabel', { name: defaultPlan!.planName });
    previewSelected = true;
  } else if (isReservedDefault || !model) {
    previewLabel = '未配置';
    previewSelected = false;
  } else {
    previewLabel = formatModelDisplay(model, providers);
    previewSelected = true;
  }

  // 全量选项列表（展平 enabled provider × enabled model；双层过滤 disabled，
  // 对齐样板 KeyModelPicker + 后端 `enabled !== false` 语义）
  const items: PickerItem[] = providers
    .filter((p) => p.enabled !== false)
    .flatMap((p) =>
      p.models
        .filter((m) => m.enabled !== false)
        .map((m) => ({
          providerId: p.id,
          providerLabel: p.label,
          modelId: m.modelId,
          // display 走 formatModelDisplay 保留 provider / model 前缀语义
          modelLabel: formatModelDisplay({ providerId: p.id, modelId: m.modelId }, providers),
        })),
    );

  const handleSelect = (sel: ModelSelection) => {
    onChange(sel);
    setOpen(false);
  };

  // extraTopItems: 默认项（模型态「a(默认)」/ 方案态「方案 · 名（默认)」；用户裁决：保留 default 项 + 全量列表 a 重复出现一次）
  // onClick 复用保留字 {providerId:'',modelId:'default'}（写回链路后端零改动，use-chat-chrome L102-114）
  const extraTopItems = hasDefaultRoute
    ? [
        {
          key: 'default',
          label: hasDefault
            ? `${formatModelDisplay(effectiveDefault, providers)}（默认）`
            : t('planDefaultLabel', { name: defaultPlan!.planName }),
          selected: isReservedDefault,
          onClick: () => handleSelect({ providerId: '', modelId: 'default' }),
        },
      ]
    : undefined;

  // click menu selected 判定（非 reserved default 时才用 model 判 selected）
  const menuValue = !isReservedDefault && model ? model : null;

  const emptyMessage = error ? `加载失败：${error}` : '去插件设置页配置';
  const ariaLabel = previewLabel;

  return (
    <div
      ref={wrapRef}
      className="relative shrink-0 z-[var(--z-popover)]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        data-action-key="chat.model.open"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={
          CHAT_ACTION_BTN_CLS +
          ' rounded-md transition-colors ' +
          (disabled ? 'opacity-60 cursor-not-allowed text-muted' : `hover:bg-surface-2 ${triggerTone}`)
        }
      >
        <BrainIcon size={12} />
      </button>

      {/* click 完整菜单：走统一 ModelPickerPanel primitive（regulation 02 §7 白卡） */}
      {open && (
        <div className={PICKER_POSITION_CLS}>
          <ModelPickerPanel
            items={items}
            value={menuValue}
            onPick={(it) => handleSelect({ providerId: it.providerId, modelId: it.modelId })}
            headerTitle={t('pickerTitle.model')}
            extraTopItems={extraTopItems}
            emptyMessage={items.length === 0 ? emptyMessage : undefined}
          />
        </div>
      )}

      {/* hover 预览单条菜单（仅在未 click 展开 + hovered 时显）：容器视觉与 panel 一致（同 bg/border/shadow/rounded） */}
      {!open && hovered && (
        <div className={PICKER_POSITION_CLS}>
          <div role="listbox" className={PREVIEW_CONTAINER_CLS}>
            <div
              className={
                'w-full flex items-center gap-2 px-3 py-2 text-left cursor-default rounded-md font-mono text-[13px] ' +
                (previewSelected ? 'text-fg font-medium' : 'text-muted')
              }
            >
              {previewLabel}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default InputModelPicker;
