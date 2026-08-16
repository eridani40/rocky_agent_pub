/**
 * component-plan-item-row — 方案条目行（v0.0.347 模型路由 UI v2）
 * 参考 specs/prd/model-routing-demo-v2.html（冻结视觉契约：7 列行）
 *       specs/tech/version_logs/v0.0.347/change_plan.md 决策⑪/⑭
 *
 * 职责：单条目 7 列横排行（展示 + 交互回调，无列表逻辑）：
 *   col-handle（DragHandle 唯一拖拽源）/ col-order / col-model（ModelPicker）/
 *   col-time（时钟 icon + tooltip + 弹层）/ col-circuit / col-toggle / col-more（⋯）
 * 边界：受控展示组件；状态（弹层开合/拖拽源）由父级 editor 持有（互斥 + 排序）。
 * [拆分报备] editor 超 300 行硬门禁，行组件独立文件（change_plan 风险点 6 授权）。
 */
import { useTranslation } from 'react-i18next';
import { ModelPicker } from '../chat/ModelPicker';
import { DragHandle } from '../framework/primitives/drag-handle';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';
import { CircuitStatusBadge } from './component-circuit-status';
import { HourGridPicker, fmtHours } from './component-hour-grid-picker';
import type { RoutingItem, ModelRoutingStatusItem } from './model-routing-types';
import type { ModelSelection } from '../../lib/providers';

/** 时钟 icon（demo 同款） */
const CLOCK_SVG = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 15 14" />
  </svg>
);

export interface PlanItemRowProps {
  /** 条目数据（受控） */
  item: RoutingItem;
  /** 行序（0 起；展示 idx+1；拖拽/弹层定位用） */
  idx: number;
  /** 保存中禁用 */
  disabled?: boolean;
  /** 红绿灯（status 按 pid+mid 匹配结果；无匹配不渲染 badge） */
  badge?: ModelRoutingStatusItem;
  /** 时间弹层开合（父级互斥态） */
  timeOpen: boolean;
  /** 更多菜单开合（父级互斥态） */
  moreOpen: boolean;
  /** 本行是拖拽源（视觉 35% 透明） */
  isDragging: boolean;
  /** 本行是拖拽落点（视觉高亮） */
  isDragOver: boolean;
  /** [v0.0.349] 条目 dangling（provider/model 已删或禁用）→ col-model 红描边（父级 editor 按 providers 判定传入） */
  invalid?: boolean;
  /** 条目字段更新 */
  onPatch: (idx: number, patch: Partial<RoutingItem>) => void;
  /** 时间弹层开合切换（互斥由父级保证） */
  onToggleTime: (idx: number) => void;
  /** 更多菜单开合切换 */
  onToggleMore: (idx: number) => void;
  /** 点删除（父级弹 ConfirmModal） */
  onRequestDelete: (idx: number) => void;
  /** 手柄 dragstart */
  onDragStart: (idx: number) => void;
  /** 行 dragover（preventDefault 允许 drop） */
  onDragOver: (idx: number) => void;
  /** 行 drop（排序落位） */
  onDrop: (idx: number) => void;
  /** 拖拽结束（清视觉态） */
  onDragEnd: () => void;
}

/** 单条目行（7 列：handle/序号/model/time/circuit/toggle/more） */
export function PlanItemRow({
  item, idx, disabled, badge, timeOpen, moreOpen, isDragging, isDragOver, invalid,
  onPatch, onToggleTime, onToggleMore, onRequestDelete, onDragStart, onDragOver, onDrop, onDragEnd,
}: PlanItemRowProps) {
  const { t } = useTranslation('app-dev-config');
  const sel: ModelSelection | null = item.providerId && item.modelId ? { providerId: item.providerId, modelId: item.modelId } : null;
  const hasTime = !!item.timeCondition && item.timeCondition.hours.length > 0;
  return (
    <div
      data-testid="plan-editor-item"
      data-idx={idx}
      className={
        'relative flex items-center gap-3.5 rounded-lg border border-border bg-surface px-4 py-3 transition-colors ' +
        (item.enabled ? '' : 'opacity-60 ') +
        (isDragOver && !isDragging ? 'border-fg shadow-focus ' : '') +
        (isDragging ? 'opacity-35' : '')
      }
      onDragOver={(e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        onDragOver(idx);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop(idx);
      }}
      onDragEnd={onDragEnd}
    >
      {/* col-handle：拖拽源（DragHandle 自带 draggable；dragstart 冒泡到 wrapper，决策⑭） */}
      <span
        data-testid="plan-editor-item-handle"
        className="flex shrink-0"
        onDragStart={() => onDragStart(idx)}
      >
        <DragHandle />
      </span>
      {/* col-order：序号（拖拽后 reindex 重算） */}
      <span className="w-4 shrink-0 text-center font-mono text-[12px] text-muted">{idx + 1}</span>
      {/* col-model：ModelPicker（选中后固定文案，点击重开）；invalid → 红描边（dangling，仅描边冻结契约） */}
      <div
        data-testid="plan-editor-item-model"
        data-invalid={invalid ? 'true' : 'false'}
        className={
          'w-[220px] min-w-0 rounded-md border ' +
          (invalid ? 'border-danger' : 'border-transparent')
        }
      >
        <ModelPicker
          actionKey={`settings.models.plan.item-model-${idx}`}
          value={sel}
          triggerClassName="w-[220px] whitespace-nowrap overflow-hidden text-ellipsis"
          onChange={(s) => onPatch(idx, { providerId: s.providerId, modelId: s.modelId })}
        />
      </div>
      {/* col-time：时钟 icon + hover tooltip + 时间弹层（草稿态，决策⑫） */}
      <div className="group relative shrink-0">
        <button
          type="button"
          data-testid="plan-editor-item-time"
          data-keep-popover
          data-active={hasTime ? 'true' : 'false'}
          aria-label={t('modelRouting.editor.timeCondition')}
          className={
            'flex h-8 w-8 items-center justify-center rounded-md border transition-colors ' +
            (hasTime ? 'border-fg bg-surface-2 text-fg' : 'border-border bg-surface text-muted-2 hover:border-border-strong')
          }
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onToggleTime(idx);
          }}
        >
          {CLOCK_SVG}
          {hasTime && (
            <span
              data-testid="plan-editor-time-tooltip"
              className="pointer-events-none absolute bottom-full left-1/2 z-[var(--z-popover)] mb-1.5 -translate-x-1/2 whitespace-nowrap rounded bg-fg px-2 py-1 font-mono text-[11px] text-bg opacity-0 transition-opacity group-hover:opacity-100"
            >
              {fmtHours(item.timeCondition!.hours)}
            </span>
          )}
        </button>
        {timeOpen && (
          <div
            data-testid="time-popover"
            data-keep-popover
            className="absolute left-1/2 top-full z-[var(--z-popover)] mt-1.5 w-[504px] -translate-x-1/2 rounded-lg border border-border-2 bg-surface p-3.5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <HourGridPicker
              value={item.timeCondition?.hours ?? []}
              onConfirm={(hours) => {
                onPatch(idx, { timeCondition: { hours } });
                onToggleTime(-1); // 关闭（父级语义：-1 = 全关）
              }}
              onClear={() => {
                onPatch(idx, { timeCondition: undefined });
                onToggleTime(-1);
              }}
            />
          </div>
        )}
      </div>
      {/* col-circuit：红绿灯（无匹配不渲染） */}
      <div className="flex shrink-0 items-center">
        {badge && <CircuitStatusBadge presentation={badge.presentation} remainingSeconds={badge.remainingSeconds} />}
      </div>
      {/* col-toggle：开关（禁用行 opacity-60） */}
      <div className="ml-auto shrink-0" data-testid="plan-editor-enabled" data-enabled={item.enabled ? 'true' : 'false'}>
        <ToggleSwitch
          value={item.enabled}
          disabled={disabled}
          label={t('modelRouting.editor.enabled')}
          actionKey={`settings.models.plan.item-enabled-${idx}`}
          onChange={(v) => onPatch(idx, { enabled: v })}
        />
      </div>
      {/* col-more：⋯ 菜单 → 删除确认 */}
      <div className="relative shrink-0">
        <button
          type="button"
          data-testid="plan-editor-item-more"
          data-keep-popover
          className="flex h-7 w-7 items-center justify-center rounded text-[18px] leading-none text-muted transition-colors hover:bg-surface-2 hover:text-fg-2"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            onToggleMore(idx);
          }}
        >
          ⋯
        </button>
        {moreOpen && (
          <div
            data-testid="plan-editor-more-menu"
            data-keep-popover
            className="absolute right-0 top-full z-[var(--z-popover)] mt-1 min-w-[120px] overflow-hidden rounded-lg border border-border-2 bg-surface shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              data-testid="plan-editor-item-delete"
              className="block w-full px-3.5 py-2 text-left text-[13px] text-danger transition-colors hover:bg-danger-light"
              onClick={() => onRequestDelete(idx)}
            >
              {t('modelRouting.list.delete')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default PlanItemRow;
