/**
 * component-model-list-card — 二级页内单个 model 卡（v0.0.7）
 * 参考: specs/ui/components/providers/_overview.md §5
 *       视觉: key-card 同款（surface-2 + border + radius 10px + hover border-strong）
 *
 * 职责：展示 model 外显字段 + 点击整卡开 modal 编辑 + 右侧删除按钮。
 * 边界：不调后端、不持本地状态；点击/删除上抛父级（父级写 draft.models）。
 *
 * 外显：label(13/600) + modelId mono 副标 + 禁用徽章(muted)
 *       + ctx·out mono 副标 + 右 chevron + 删除按钮。
 * testid: model-card-{modelId}；删除 model-card-{modelId}-delete
 */
import { useTranslation } from 'react-i18next';
import type { ModelInstance } from '../../lib/api-client';

export interface ComponentModelListCardProps {
  /** 要展示的 model */
  model: ModelInstance;
  /** 点击整卡 → 父级开 modal 编辑该 model */
  onClick: () => void;
  /** 删除 → 父级从 draft.models 移除 */
  onDelete: () => void;
}

/** model 卡：横向布局——左 [label + modelId + ctx·out]，右 [徽章 + 删除 + chevron] */
export function ComponentModelListCard({ model, onClick, onDelete }: ComponentModelListCardProps) {
  // [v0.0.62 i18n] 默认/禁用徽章 + 删除 aria 走 providers.modelList.*
  const { t } = useTranslation('providers');
  return (
    <div
      data-action-key="providers.model.edit"
      onClick={onClick}
      className="border border-border rounded-[10px] py-[16px] px-[20px] mb-2 bg-surface-2 transition-colors hover:border-border-strong cursor-pointer flex items-center gap-3"
    >
      {/* 左：label + modelId 副标 + ctx·out 副标 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-fg truncate">{model.label || model.modelId}</span>
          {!model.enabled && (
            <Badge color="muted" label={t('modelList.disabled')} />
          )}
        </div>
        <div className="text-[11px] text-muted font-mono mt-1 truncate">
          <span className="text-muted-2">{model.modelId}</span>
          <span className="mx-1.5 text-border-strong">·</span>
          <span>{model.contextWindow} ctx · {model.maxOutputTokens} out</span>
        </div>
      </div>

      {/* 右：删除 + chevron */}
      <button
        type="button"
        data-action-key="providers.model.delete"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label={t('modelList.deleteAria')}
        className="text-muted hover:text-accent text-sm transition-colors opacity-60 hover:opacity-100"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" /></svg>
      </button>
      <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted shrink-0"><path d="M9 6l6 6-6 6" /></svg>
    </div>
  );
}

/** 小徽章：type-tag 风格（9px/700 mono uppercase + 彩色底） */
function Badge({ color, label }: { color: 'accent' | 'muted'; label: string }) {
  const cls =
    color === 'accent'
      ? 'bg-accent-surface text-accent'
      : 'bg-bg-warm text-muted';
  return (
    <span className={'inline-block px-1.5 py-[1px] rounded text-[9px] font-bold font-mono uppercase tracking-wide ' + cls}>
      {label}
    </span>
  );
}

export default ComponentModelListCard;
