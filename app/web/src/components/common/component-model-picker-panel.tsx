/**
 * component-model-picker-panel —— 模型选择「展开态」panel primitive（跨页复用）
 * 参考: specs/ui/components/common/component-model-picker-panel.md
 *       specs/ui/regulation/02-components.md §7（模型选择面板全局统一契约）
 *       specs/tech/version_logs/v0.0.165/change_plan.md §7
 *
 * 职责：
 *   300px 白卡（默认宽），radius-lg + shadow-lg + border + bg-surface；
 *   可选顶部搜索框 / 题目行 / extraTopItems 特殊置顶项；常规 items 列表用 IconBox + mono 名 + 选中 ✓。
 * 边界：不持有 open state（受控 open 由消费方管理）；不查 providers（消费方供给 items）；
 *   点击外部关闭由消费方 wrap；无 hex 硬编码。
 * 单文件 ≤200 行。
 */
import { useMemo, useState, type ReactNode } from 'react';
import { IconBox } from './component-icon-box';

/** 单个 model 选项（跨消费方通用形态） */
export interface PickerItem {
  providerId: string;
  providerLabel?: string;
  modelId: string;
  modelLabel: string;
  meta?: string;
}

/** 常规 items 之上的特殊置顶项（如「继承默认」/「a(默认)」） */
export interface ExtraTopItem {
  key: string;
  label: string;
  onClick: () => void;
  selected?: boolean;
}

export interface ModelPickerPanelProps {
  items: PickerItem[];
  value?: { providerId: string; modelId: string } | null;
  onPick: (item: PickerItem) => void;
  searchable?: boolean;
  searchPlaceholder?: string;
  headerTitle?: string;
  extraTopItems?: ExtraTopItem[];
  emptyMessage?: string;
  /** 是否显示每项右侧的 mono modelId 副标（配置页 grouped list 场景 true；chat 场景 false） */
  showModelIdSubtitle?: boolean;
  className?: string;
}

/** 大小写不敏感包含匹配 */
function includesIgnoreCase(hay: string | undefined, needle: string): boolean {
  if (!hay) return false;
  return hay.toLowerCase().includes(needle.toLowerCase());
}

/** 下拉箭头（inline SVG，不引 chat-page/icons 避免层级反向） */
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

/** ModelPickerPanel —— 展开态 primitive（受控 open） */
export function ModelPickerPanel({
  items,
  value,
  onPick,
  searchable,
  searchPlaceholder,
  headerTitle,
  extraTopItems,
  emptyMessage,
  showModelIdSubtitle,
  className,
}: ModelPickerPanelProps): ReactNode {
  const [query, setQuery] = useState('');

  // 本地过滤（modelLabel + providerLabel + modelId 三字段大小写不敏感）
  const filteredItems = useMemo(() => {
    if (!searchable || !query.trim()) return items;
    const q = query.trim();
    return items.filter(
      (it) =>
        includesIgnoreCase(it.modelLabel, q) ||
        includesIgnoreCase(it.providerLabel, q) ||
        includesIgnoreCase(it.modelId, q),
    );
  }, [items, searchable, query]);

  const hasExtraTop = (extraTopItems?.length ?? 0) > 0;
  const isEmpty = filteredItems.length === 0 && !hasExtraTop;

  const containerCls =
    'w-[300px] bg-surface border border-border rounded-lg shadow-lg py-1 overflow-hidden' +
    (className ? ' ' + className : '');

  return (
    <div role="listbox" className={containerCls}>
      {searchable && (
        <div className="px-2.5 py-2 border-b border-border">
          <input
            data-action-key="common.model-picker.search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="h-[30px] text-[12.5px] px-2 rounded-md border border-border-2 bg-surface w-full outline-none focus:border-border-strong"
          />
        </div>
      )}

      {headerTitle && (
        <div

          className="px-3 py-1.5 text-xs text-muted select-none border-b border-border"
          role="heading"
          aria-level={2}
        >
          {headerTitle}
        </div>
      )}

      {/* extraTopItems 区（继承默认 / a(默认) 等特殊置顶项） */}
      {hasExtraTop && (
        <div className="p-1">
          {extraTopItems!.map((it) => (
            <button
              key={it.key}
              type="button"

              data-active={it.selected ? 'true' : undefined}
              onClick={it.onClick}
              className={
                'w-full flex items-center gap-2 px-3 py-2 text-left rounded-md ' +
                'hover:bg-surface-2 data-[active=true]:bg-surface-3 ' +
                (it.selected ? 'text-fg font-medium' : 'text-fg')
              }
            >
              <span className="font-mono text-[13px] truncate flex-1 min-w-0">{it.label}</span>
              {it.selected && <CheckMarkSvg />}
            </button>
          ))}
          {filteredItems.length > 0 && <div className="my-1 border-t border-border" />}
        </div>
      )}

      {/* 常规 items 列表 */}
      {filteredItems.length > 0 && (
        <div className="p-1 max-h-[320px] overflow-y-auto">
          {filteredItems.map((it) => {
            const selected =
              value?.providerId === it.providerId && value?.modelId === it.modelId;
            return (
              <button
                key={`${it.providerId}-${it.modelId}`}
                type="button"
                role="option"
                aria-selected={selected}
                data-action-key="common.model-picker.pick"
                data-active={selected ? 'true' : undefined}
                onClick={() => onPick(it)}
                className={
                  'w-full flex items-center gap-2 px-3 py-2 text-left rounded-md ' +
                  'hover:bg-surface-2 data-[active=true]:bg-surface-3 transition-colors ' +
                  (selected ? 'text-fg font-medium' : 'text-fg')
                }
              >
                <IconBox hueBy={it.providerId} size={24} />
                <span className="font-mono text-[13px] truncate flex-1 min-w-0">
                  {it.modelLabel}
                </span>
                {showModelIdSubtitle && it.modelLabel !== it.modelId && (
                  <span className="font-mono text-[11px] text-muted shrink-0">
                    {it.modelId}
                  </span>
                )}
                {it.meta && (
                  <span className="font-mono text-[11px] text-muted shrink-0">{it.meta}</span>
                )}
                {selected && <CheckMarkSvg />}
              </button>
            );
          })}
        </div>
      )}

      {isEmpty && emptyMessage && (
        <div className="px-3 py-2 text-xs text-muted">{emptyMessage}</div>
      )}
    </div>
  );
}

export default ModelPickerPanel;
