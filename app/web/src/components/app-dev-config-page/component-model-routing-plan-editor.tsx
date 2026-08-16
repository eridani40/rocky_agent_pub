/**
 * component-model-routing-plan-editor — 方案编辑器（v0.0.347 模型路由 UI v2）
 * 参考 specs/prd/model-routing-demo-v2.html（冻结视觉契约）
 *       specs/tech/version_logs/v0.0.347/change_plan.md 决策⑪~⑮
 *
 * 职责：详情内方案编辑（7 列行列表 + 熔断高级区常显）：
 *   - 条目行渲染委托 PlanItemRow（7 列视觉拆分组件）
 *   - 弹层互斥（时间弹层/更多菜单单开；点空白关闭 = 时间草稿丢弃）
 *   - 拖拽排序（手柄唯一拖拽源；drop → splice + reindexPriorities）
 *   - 删除条目 → ConfirmModal
 *   - 本地预检错误 + 服务端 400 透传展示
 *
 * 边界：受控组件（value/onChange）；不直接调 API（保存由父级完成）。
 * [v2 删除] moveItem 死代码 / 时间模式 select / inline picker / name input / 格子 hover tooltip。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmModal } from '../common/component-confirm-modal';
import { PlanItemRow } from './component-plan-item-row';
import { DEFAULT_CIRCUIT, isItemModelInvalid, reindexPriorities, validatePlanLocal } from './model-routing-plan-lib';
import type { ModelRoutingPlan, RoutingItem, CircuitConfig, ModelRoutingStatus } from './model-routing-types';
import type { ProviderItem } from '../../lib/providers';

/** 熔断参数字段（key → i18n label） */
const CIRCUIT_FIELDS = [
  ['failureThreshold', 'modelRouting.editor.circuitFailureThreshold'],
  ['successThreshold', 'modelRouting.editor.circuitSuccessThreshold'],
  ['timeoutSeconds', 'modelRouting.editor.circuitTimeoutSeconds'],
  ['errorRateThreshold', 'modelRouting.editor.circuitErrorRateThreshold'],
  ['minRequests', 'modelRouting.editor.circuitMinRequests'],
] as const;

export interface ModelRoutingPlanEditorProps {
  /** 方案 draft（受控） */
  value: ModelRoutingPlan;
  /** draft 变更回调 */
  onChange: (next: ModelRoutingPlan) => void;
  /** 服务端 400 message（父级保存失败透传展示） */
  serverError?: string | null;
  /** 保存中禁用 */
  disabled?: boolean;
  /** 方案红绿灯状态（父级进详情时拉一次；item 行按 pid+mid 匹配，决策⑰） */
  status?: ModelRoutingStatus | null;
  /** [v0.0.349] providers 列表透传（section useProviders 拉取）：dangling 存在性预检 + 逐行 invalid 判定 */
  providers?: ProviderItem[];
}

/**
 * ModelRoutingPlanEditor 组件（UI v2）。
 * 条目顺序 = priority（index+1）；保存时父级调 reindexPriorities 落盘。
 */
export function ModelRoutingPlanEditor({
  value, onChange, serverError, disabled, status, providers,
}: ModelRoutingPlanEditorProps) {
  const { t } = useTranslation('app-dev-config');
  // [v0.0.349] providers 传入时做 dangling 存在性预检（缺省仅同模型约束，向后兼容）
  const errors = validatePlanLocal(value, providers);
  // 弹层互斥态：时间弹层 / 更多菜单（单开）；-1 = 全关（row 回调语义）
  const [openTimeIdx, setOpenTimeIdx] = useState<number>(-1);
  const [openMoreIdx, setOpenMoreIdx] = useState<number>(-1);
  const [pendingDeleteIdx, setPendingDeleteIdx] = useState<number | null>(null);
  // 拖拽排序态（源/落点行号；drop 落位 + reindex）
  const [dragFromIdx, setDragFromIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  const circuit: Required<CircuitConfig> = { ...DEFAULT_CIRCUIT, ...(value.circuit ?? {}) };

  /** 点空白关弹层（时间弹层未确定 = 丢弃草稿；触发器与弹层内点击豁免） */
  useEffect(() => {
    if (openTimeIdx < 0 && openMoreIdx < 0) return;
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-keep-popover]')) return;
      setOpenTimeIdx(-1);
      setOpenMoreIdx(-1);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [openTimeIdx, openMoreIdx]);

  const patchItems = (items: RoutingItem[]) => onChange({ ...value, items });
  const patchItem = (index: number, patch: Partial<RoutingItem>) =>
    patchItems(value.items.map((it, i) => (i === index ? { ...it, ...patch } : it)));

  /** 时间弹层开合（互斥：开时间关更多；-1 = 全关） */
  const toggleTime = (idx: number) => {
    setOpenMoreIdx(-1);
    setOpenTimeIdx(openTimeIdx === idx ? -1 : idx);
  };
  /** 更多菜单开合（互斥：开更多关时间） */
  const toggleMore = (idx: number) => {
    setOpenTimeIdx(-1);
    setOpenMoreIdx(openMoreIdx === idx ? -1 : idx);
  };

  /** 拖拽 drop 落位：splice 移动 + reindex + 关弹层（决策⑭） */
  const handleDrop = (idx: number) => {
    const from = dragFromIdx;
    setDragFromIdx(null);
    setDragOverIdx(null);
    if (from === null || from === idx) return;
    const items = [...value.items];
    const [moved] = items.splice(from, 1);
    if (!moved) return;
    items.splice(idx, 0, moved);
    setOpenTimeIdx(-1);
    setOpenMoreIdx(-1);
    onChange({ ...value, items: reindexPriorities(items) });
  };

  /** 熔断参数更新（number 输入；空串 → 回默认 = 删 key） */
  const patchCircuit = (key: keyof CircuitConfig, raw: string) => {
    const n = raw === '' ? undefined : Number(raw);
    const next: CircuitConfig = { ...value.circuit };
    if (n === undefined || Number.isNaN(n)) delete next[key];
    else next[key] = n as never;
    onChange({ ...value, circuit: next });
  };

  return (
    <div data-testid="plan-editor" className="flex flex-col">
      {/* 本地预检错误提示（实时） */}
      {errors.length > 0 && (
        <div data-testid="plan-editor-validation" className="mb-2 rounded border border-danger/30 bg-danger-light px-2 py-1.5 text-[12px] text-danger">
          {errors.map((k) => (
            <div key={k} className="flex items-center gap-1"><span>⚠</span><span>{t(k)}</span></div>
          ))}
        </div>
      )}
      {/* 服务端 400 透传 */}
      {serverError && (
        <div data-testid="plan-editor-server-error" className="mb-2 rounded border border-danger/30 bg-danger-light px-2 py-1.5 text-[12px] text-danger">
          <span>⚠ {serverError}</span>
        </div>
      )}

      {/* 条目区标题 + 添加（demo toolbar） */}
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[13px] font-medium text-fg-2">{t('modelRouting.editor.degradeOrder')}</span>
        <button
          type="button"
          data-testid="plan-editor-add-item"
          className="rounded bg-fg px-4 py-1.5 text-[13px] font-medium text-bg hover:bg-fg-hover disabled:opacity-50"
          disabled={disabled}
          onClick={() =>
            patchItems(reindexPriorities([
              ...value.items,
              { providerId: '', modelId: '', priority: value.items.length + 1, enabled: true },
            ]))
          }
        >
          + {t('modelRouting.editor.addItem')}
        </button>
      </div>

      {/* 条目列表（7 列行，渲染委托 PlanItemRow） */}
      <div data-testid="plan-editor-items" className="flex flex-col gap-2">
        {value.items.map((it, idx) => (
          <PlanItemRow
            key={`${it.providerId}|${it.modelId}|${idx}`}
            item={it}
            idx={idx}
            disabled={disabled}
            badge={status?.items?.find((s) => s.providerId === it.providerId && s.modelId === it.modelId)}
            timeOpen={openTimeIdx === idx}
            moreOpen={openMoreIdx === idx}
            isDragging={dragFromIdx === idx}
            isDragOver={dragOverIdx === idx}
            invalid={providers ? isItemModelInvalid(it, providers) : false}
            onPatch={patchItem}
            onToggleTime={toggleTime}
            onToggleMore={toggleMore}
            onRequestDelete={(i) => {
              setOpenMoreIdx(-1);
              setPendingDeleteIdx(i);
            }}
            onDragStart={setDragFromIdx}
            onDragOver={setDragOverIdx}
            onDrop={handleDrop}
            onDragEnd={() => {
              setDragFromIdx(null);
              setDragOverIdx(null);
            }}
          />
        ))}
      </div>

      {/* 熔断参数高级区（常显，决策⑮：5 参数 + 默认值 hint） */}
      <div data-testid="plan-editor-circuit" className="mt-5 rounded-lg border border-border bg-surface px-4 py-4">
        <div className="mb-3 text-[13px] font-semibold text-fg">{t('modelRouting.editor.circuitTitle')}</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {CIRCUIT_FIELDS.map(([key, labelKey]) => (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-[11px] text-muted">{t(labelKey)}</span>
              <input
                data-testid={`plan-editor-circuit-${key}`}
                type="number"
                step={key === 'errorRateThreshold' ? 0.1 : 1}
                min={key === 'errorRateThreshold' ? 0 : 1}
                className="rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[13px] text-fg outline-none focus:border-fg"
                value={circuit[key]}
                disabled={disabled}
                onChange={(e) => patchCircuit(key, e.target.value)}
              />
              <span className="text-[10px] text-muted-2">{t('modelRouting.editor.defaultHint', { value: DEFAULT_CIRCUIT[key] })}</span>
            </label>
          ))}
        </div>
      </div>

      {/* 删除条目确认（demo 文案：删除路由条目？） */}
      {pendingDeleteIdx !== null && value.items[pendingDeleteIdx] && (
        <ConfirmModal
          title={t('modelRouting.deleteItem.title')}
          body={t('modelRouting.deleteItem.body', {
            name: value.items[pendingDeleteIdx].modelId || '—',
            index: pendingDeleteIdx + 1,
          })}
          okLabel={t('modelRouting.deleteItem.ok')}
          cancelLabel={t('modelRouting.deleteItem.cancel')}
          onOk={() => {
            patchItems(reindexPriorities(value.items.filter((_, i) => i !== pendingDeleteIdx)));
            setPendingDeleteIdx(null);
          }}
          onCancel={() => setPendingDeleteIdx(null)}
        />
      )}
    </div>
  );
}

export default ModelRoutingPlanEditor;
