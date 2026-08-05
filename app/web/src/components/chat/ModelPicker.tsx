/**
 * ModelPicker —— 选 provider/model（studio wizard / manage-tab / new-squad / hire 场景）
 * 参考: specs/ui/overall/02-llm-chat.md §3.3
 *       specs/api/overall/02-llm-chat.md §5（GET /provider → {items:ProviderInstance[]}）
 *       specs/tech/version_logs/v0.0.165/change_plan.md §7（v0.0.165 全站统一视觉：内部组装 trigger + panel primitive）
 *
 * v0.0.165 视觉重塑：内部组装 `ModelPickerTrigger` + `ModelPickerPanel` primitive（regulation 02 §7 300px 白卡）；
 *   testid（`chat-model-picker` trigger + `chat-model-picker-list` panel）+ props 签名向后兼容——消费方（page-chat/studio wizard/manage-tab/new-squad/hire）零改。
 *   `inheritLabel`/`onInherit` 走 panel.extraTopItems（顶部置顶「继承默认」）。
 *
 * 历史脉络：
 *   - v0.0.9：下拉方向从 bottom-full 改 top-full；显示 provider label + model label
 *   - v0.0.36：providers 数据源抽 lib/providers.ts；去永久缓存
 *   - v0.0.72 UIFix2：trigger 固定 w-[180px] + ellipsis
 *   - v0.0.165：视觉重塑（primitive 组装，向后兼容 testid）
 */
import { useEffect, useRef, useState } from 'react';
import {
  useProviders,
  formatModelDisplay,
  type ModelSelection,
} from '../../lib/providers';
import { ModelPickerTrigger } from '../common/component-model-picker-trigger';
import { ModelPickerPanel, type PickerItem } from '../common/component-model-picker-panel';

/** 兼容旧引用：re-export ModelSelection（page-chat 等从 ModelPicker 导入） */
export type { ModelSelection };

interface ModelPickerProps {
  /** 当前选中项 */
  value: ModelSelection | null;
  /** 选中变更回调 */
  onChange: (sel: ModelSelection) => void;
  /**
   * 触发按钮根 testid（v0.0.36 复用到 studio 弹层时按语义命名）。
   * 默认 'chat-model-picker'；下拉列表 testid = `${testid}-list`。
   * 例：new-squad-modal 传 'new-squad-model'。
   */
  /** [v0.0.36 member inherit] 继承选项标签：给则下拉顶部加此项，点击触发 onInherit；value=null 且给 inheritLabel 时按钮显示它 */
  inheritLabel?: string;
  /** [v0.0.36 member inherit] 选中「继承」时的回调（member.model 清空 = inherit，运行时解析 squad.modelDefault） */
  onInherit?: () => void;
  /** data-action-key 透传到 trigger 按钮（ET 稳定定位锚点，命名规范见 specs/ui/components/_conventions.md §12） */
  actionKey?: string;
}

/**
 * ModelPicker 组件。
 * 挂载时（经 useProviders）实时拉 provider 列表；空态显示「去插件设置页配置」。
 * 下拉面板 top-full 向下展开（v0.0.9 行为不变）。
 */
export function ModelPicker({
  value,
  onChange,
  inheritLabel,
  onInherit,
  actionKey,
}: ModelPickerProps) {
  const { providers, error } = useProviders();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点外部收起下拉（menu 与 trigger 都在 wrapRef 内）
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // 展平 providers 为 panel PickerItem[]（双层过滤 disabled provider/model，
  // 对齐样板 KeyModelPicker `if(!p.enabled) continue; if(!m.enabled) continue;`。
  // 用 `!== false` 让 undefined 视为 enabled，对齐后端 `enabled !== false` 语义）
  const items: PickerItem[] = providers
    .filter((p) => p.enabled !== false)
    .flatMap((p) =>
      p.models
        .filter((m) => m.enabled !== false)
        .map((m) => ({
          providerId: p.id,
          providerLabel: p.label,
          modelId: m.modelId,
          // display 走 formatModelDisplay 「provider / model」保持 v0.0.9 显示语义
          modelLabel: formatModelDisplay({ providerId: p.id, modelId: m.modelId }, providers),
        })),
    );

  // trigger 上的完整 label（含 provider / model 前缀）；未配 → placeholder
  const triggerLabel = value ? formatModelDisplay(value, providers) : inheritLabel ?? '选择 model';
  // hover title 保留 v0.0.72 UIFix2 语义（完整 providerId/modelId 便于复制/查看）
  const modelTitle = value ? `${value.providerId} / ${value.modelId}` : undefined;

  // trigger value 组装（IconBox hueBy=providerId；label 直接用 formatModelDisplay 结果）
  const triggerValue = value
    ? { providerId: value.providerId, modelId: value.modelId, modelLabel: triggerLabel }
    : null;

  // 继承选项走 extraTopItems（value===null 视为「继承」选中）
  const extraTopItems =
    inheritLabel && onInherit
      ? [
          {
            key: 'inherit',
            label: inheritLabel,
            selected: value === null,
            onClick: () => {
              onInherit();
              setOpen(false);
            },
          },
        ]
      : undefined;

  const emptyMessage = error ? `加载失败：${error}` : '去插件设置页配置';

  return (
    <div ref={wrapRef} className="relative">
      <ModelPickerTrigger
        value={triggerValue}
        placeholder={inheritLabel ?? '选择 model'}
        onClick={() => setOpen((v) => !v)}
        actionKey={actionKey}
        title={modelTitle}
        ariaExpanded={open}
        // v0.0.72 UIFix2 兼容：固定 w-[180px] + truncate（trigger 尺寸稳定，避免布局跳动）
        className="w-[180px] whitespace-nowrap overflow-hidden text-ellipsis"
      />
      {open && (
        // v0.0.9：向下展开（top-full）；panel testid 沿用 `${testid}-list` 保 back-compat
        <div className="absolute top-full mt-1 left-0 z-[var(--z-popover)]">
          <ModelPickerPanel
            items={items}
            value={value}
            onPick={(it) => {
              onChange({ providerId: it.providerId, modelId: it.modelId });
              setOpen(false);
            }}
            extraTopItems={extraTopItems}
            emptyMessage={items.length === 0 ? emptyMessage : undefined}
          />
        </div>
      )}
    </div>
  );
}

export default ModelPicker;
