/**
 * component-token-stats-controls —— 控制条（粒度 / 范围 / 类型 / 视图 / model / 日期）
 * 参考: specs/ui/components/studio-page/component-token-stats.md
 *       specs/ui/components/_conventions.md §10（禁原生 select）/ §11（尺寸恒定）
 *
 * 5 组控制 + 单日粒度日期：
 *   - 粒度（2 段 chip）：跨天 / 单日
 *   - 范围（自定义下拉）：团队 + 全 member
 *   - 类型（5 段 chip）：总览 / 输入 / 输出 / 缓存 / 缓存率
 *   - 视图（2 段 chip）：日历 / 时间轴
 *   - model（自定义下拉）：全部 + squad 默认 model（如有）
 *   - 日期：<input type="date">（仅 hour 粒度显）
 *
 * 单日粒度下额外显示日期选择。
 */
import { useEffect, useRef, useState } from 'react';
import type { Granularity, KindFilter, ViewMode, AvailableModel } from './component-token-stats-types';
import { kindLabelCN } from './component-token-stats-helpers';
import type { Member } from './squad-types';

interface TokenStatsControlsProps {
  granularity: Granularity;
  scope: string; // '__team__' | memberId
  members: Member[];
  kind: KindFilter;
  view: ViewMode;
  selectedDate: string; // 'YYYY-MM-DD'
  /** model 筛选：'__all__' 或 `${providerId}/${modelId}` */
  modelSelection: string;
  /**
   * 可选 model 列表（从 API response.availableModels 派生）。
   * 实际使用过的 distinct (providerId, modelId) 组合；下拉选项 = 「全部」+ 每条。
   * 缺省/空数组 → model 下拉不渲染（无数据时隐藏）。
   */
  availableModels?: AvailableModel[];
  onGranularity: (g: Granularity) => void;
  onScope: (s: string) => void;
  onKind: (k: KindFilter) => void;
  onView: (v: ViewMode) => void;
  onSelectedDate: (d: string) => void;
  onModelSelection: (m: string) => void;
}

/** chip/选项值 → action-key 片段归一（camelCase→kebab + 全小写，如 cacheRate→cache-rate；_conventions §12.2） */
const kebabValue = (v: string) => v.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** 2-N 段 chip 组 */
function ChipGroup<T extends string>({
  value,
  options,
  onChange,
  actionKey,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  /** ET 稳定语义锚点基段：每个 chip 渲 `{actionKey}-{kebab(value)}`（命名见 _conventions §12），缺省不渲染 */
  actionKey?: string;
}) {
  return (
    <div
      className="inline-flex items-center gap-px rounded-md border border-border bg-border p-px"
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          data-action-key={actionKey ? `${actionKey}-${kebabValue(o.value)}` : undefined}
          onClick={() => onChange(o.value)}
          className={`rounded-[5px] px-2.5 py-1 text-[12px] font-medium transition-colors ${
            value === o.value ? 'bg-surface text-fg shadow-xs' : 'bg-transparent text-muted hover:text-fg-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 通用自定义下拉（无原生 select，符合 _conventions §10） */
function CustomDropdown({
  currentLabel,
  options,
  onSelect,
  actionKey,
}: {
  currentLabel: string;
  options: { value: string; label: string; hint?: string }[];
  onSelect: (v: string) => void;
  /** ET 稳定语义锚点：trigger 渲 `{actionKey}`、选项渲 `{actionKey}-option`（命名见 _conventions §12），缺省不渲染 */
  actionKey?: string;
}) {
  const [open, setOpen] = useState(false);
  // outside-close 判定锚点 = 整个 wrap 容器（含触发按钮 + 下拉列表）。
  // 注意：列表是触发按钮的兄弟节点，若只对按钮做 contains 判定，点列表项的 mousedown
  // 会被误判为「容器外」→ 列表在 click 派发前卸载 → item onClick 永不触发（v0.0.194 验收 bug）。
  // 对齐 component-input-model-picker.tsx 的 wrapRef 模式。
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // 延迟一拍注册，躲开触发按钮同次事件冒泡关闭（memory dropdown-close-listener-defer-register）
    const id = setTimeout(() => {
      window.addEventListener('mousedown', onDown);
      window.addEventListener('keydown', onEsc);
    }, 0);
    return () => {
      clearTimeout(id);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        data-action-key={actionKey}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] font-medium text-fg hover:bg-surface-2"
      >
        <span className="max-w-[160px] truncate">{currentLabel}</span>
        <span className="text-muted">▾</span>
      </button>
      {open && (
        <div
          className="absolute left-0 top-[calc(100%+4px)] z-popover min-w-[160px] overflow-hidden rounded-md border border-border bg-surface shadow-md"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              data-action-key={actionKey ? `${actionKey}-option` : undefined}
              onClick={() => { onSelect(o.value); setOpen(false); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-surface-2"
            >
              <span className="flex-1 truncate">{o.label}</span>
              {o.hint && <span className="text-muted">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 控制条容器 */
export function TokenStatsControls(props: TokenStatsControlsProps) {
  const {
    granularity, scope, members, kind, view, selectedDate, modelSelection, availableModels,
    onGranularity, onScope, onKind, onView, onSelectedDate, onModelSelection,
  } = props;

  const labelCls = 'text-[11px] font-medium uppercase tracking-wide text-muted';

  // 范围下拉选项：团队 + 全 member（leader 标「队长」）
  const scopeOptions: { value: string; label: string; hint?: string }[] = [
    { value: '__team__', label: '整个团队' },
    ...members.map((m) => ({
      value: m.id,
      label: m.name,
      hint: m.role === 'leader' ? '队长' : undefined,
    })),
  ];
  const currentScope = scopeOptions.find((o) => o.value === scope) ?? scopeOptions[0]!;
  const currentScopeLabel = currentScope.hint
    ? `${currentScope.label} · ${currentScope.hint}`
    : currentScope.label;

  // model 下拉选项：「全部」+ 实际使用过的 distinct model（从 API availableModels 派生）
  const modelOptions: { value: string; label: string }[] = [
    { value: '__all__', label: '全部模型' },
    ...(availableModels ?? []).map((m) => {
      const value = `${m.providerId}/${m.modelId}`;
      const sanitized = `${m.providerId}_${m.modelId}`.replace(/[^A-Za-z0-9_-]/g, '_');
      return { value, label: m.label };
    }),
  ];
  const currentModel = modelOptions.find((o) => o.value === modelSelection) ?? modelOptions[0]!;
  const showModelDropdown = modelOptions.length > 1; // 有 distinct model 时才显（非仅有「全部」）

  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
      <div className="flex flex-col gap-1">
        <span className={labelCls}>粒度</span>
        <ChipGroup<Granularity>
          actionKey="studio.token-stats.select-granularity"
          value={granularity}
          onChange={onGranularity}
          options={[
            { value: 'day', label: '跨天' },
            { value: 'hour', label: '单日' },
          ]}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className={labelCls}>范围</span>
        <CustomDropdown
          actionKey="studio.token-stats.select-scope"
          currentLabel={currentScopeLabel}
          options={scopeOptions}
          onSelect={onScope}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className={labelCls}>类型</span>
        <ChipGroup<KindFilter>
          actionKey="studio.token-stats.select-kind"
          value={kind}
          onChange={onKind}
          options={[
            { value: 'total', label: kindLabelCN('total') },
            { value: 'input', label: kindLabelCN('input') },
            { value: 'output', label: kindLabelCN('output') },
            { value: 'cache', label: kindLabelCN('cache') },
            { value: 'cacheRate', label: kindLabelCN('cacheRate') },
          ]}
        />
      </div>

      <div className="flex flex-col gap-1">
        <span className={labelCls}>视图</span>
        <ChipGroup<ViewMode>
          actionKey="studio.token-stats.select-view"
          value={view}
          onChange={onView}
          options={[
            { value: 'calendar', label: '日历' },
            { value: 'timeline', label: '时间轴' },
          ]}
        />
      </div>

      {showModelDropdown && (
        <div className="flex flex-col gap-1">
          <span className={labelCls}>模型</span>
          <CustomDropdown
            actionKey="studio.token-stats.select-model"
            currentLabel={currentModel.label}
            options={modelOptions}
            onSelect={onModelSelection}
          />
        </div>
      )}

      {granularity === 'hour' && (
        <div className="flex flex-col gap-1">
          <span className={labelCls}>日期</span>
          <input
            type="date"
            data-action-key="studio.token-stats.select-date"
            value={selectedDate}
            onChange={(e) => onSelectedDate(e.target.value)}
            className="rounded-md border border-border bg-surface px-2.5 py-1 text-[12px] text-fg"
          />
        </div>
      )}
    </div>
  );
}
