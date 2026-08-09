/**
 * component-panorama-kanban —— 全景 kanban 原语（按 group_by 分列 + 卡片 + 拖拽跃迁）
 * 参考: specs/ui/components/studio-page/component-panorama-view.md（kanban 渲染 + 拖拽契约）
 *       reqs/[working] v0.0.189.dsl_board/demo/src/components/kanban.js（交互参考）
 *
 * 拖拽：仅 group_by == states.field 时可拖（HTML5 DnD，dataTransfer 带实例 id）；
 *   drop → POST transition；非法（400）→ 不移动 + toast 可读 reason（卡片未乐观移动，天然回弹）。
 * 卡片点击 → 弹实体弹层（mode=edit）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EntityDef, KanbanViewDef } from './panorama-types';
import { groupLabel, interpolate, isStateGrouping, recordId, statusColor, statusLabel } from './panorama-utils';
import { Icon } from './studio-icons';

export interface PanoramaKanbanProps {
  view: KanbanViewDef;
  entity: EntityDef;
  records: Record<string, unknown>[];
  /** 拖拽跃迁回调（父组件发 POST transition + toast；本组件只上报意图） */
  onTransition: (id: string, to: string) => void;
  /** 卡片点击 → 编辑弹层 */
  onEdit: (id: string) => void;
  /** v0.0.240 归档回调（PATCH archived:true）；仅 entity 声明 archived 字段时显示按钮 */
  onArchive?: (id: string) => void;
}

/** 状态色加透明度底色（v0.0.223 列头底色多通道编码用）。
 * 6 位 hex → rgba()（全环境确定支持，含 jsdom；color-mix 在 jsdom 会被丢弃）。
 * 非 6 位 hex（理论上 DSL 可配任意 CSS 颜色）→ transparent 兜底（色带/文字色仍多通道可辨）。 */
function tintedBg(color: string, alpha = 0.12): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!m) return 'transparent';
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** kanban 渲染区：列 = view.columns 顺序；卡片 = card 模板插值 */
export function PanoramaKanban({ view, entity, records, onTransition, onEdit, onArchive }: PanoramaKanbanProps) {
  const draggable = isStateGrouping(entity, view);
  const [dropHover, setDropHover] = useState<string | null>(null);
  // v0.0.240 归档按钮：仅 entity 声明 archived 字段时显示（task builtin 首例）
  const canArchive = !!entity.fields.archived && !!onArchive;

  return (
    <div data-view-id={view.id} className="flex items-start gap-3 overflow-x-auto pb-2">
      {view.columns.map((col) => {
        const colRecords = records.filter((r) => String(r[view.group_by] ?? '') === col);
        const colColor = statusColor(entity, col);
        return (
          <section
            key={col}
            data-action-key="studio.panorama.drop-column"
            className={
              // v0.0.223 响应式列宽：min-w + flex-1（窄屏缩/宽屏平铺）
              // [v0.0.294] 去 overflow-hidden，列高度随内容撑开（整页滚动由外层负责）
              'flex min-w-[200px] flex-1 flex-col rounded-xl border bg-surface ' +
              (dropHover === col ? 'border-accent' : 'border-border')
            }
            onDragOver={
              draggable
                ? (e) => {
                    e.preventDefault();
                    setDropHover(col);
                  }
                : undefined
            }
            onDragLeave={draggable ? () => setDropHover((h) => (h === col ? null : h)) : undefined}
            onDrop={
              draggable
                ? (e) => {
                    e.preventDefault();
                    setDropHover(null);
                    const id = e.dataTransfer.getData('text/plain');
                    const rec = records.find((r) => recordId(entity, r) === id);
                    if (!id || !rec) return;
                    if (String(rec[view.group_by] ?? '') === col) return; // 同列 drop 无操作
                    onTransition(id, col);
                  }
                : undefined
            }
          >
            {/* v0.0.223 甬道多通道编码（防色弱）：列顶全宽色带 + 列头底色 + 状态文字带色（原 8×8 圆点移除） */}
            <div className="h-1 w-full shrink-0" style={{ background: colColor }} aria-hidden />
            {/* 列头：底色（状态色 12% alpha）+ 状态文字带色 + 计数 */}
            <header
              className="flex items-center gap-1.5 border-b border-border px-3 py-2"
              style={{ background: tintedBg(colColor) }}
            >
              <span className="text-[12px] font-semibold" style={{ color: colColor }}>
                {groupLabel(entity, view.group_by, col)}
              </span>
              <span className="ml-auto font-mono text-[11px] text-muted">{colRecords.length}</span>
            </header>
            <div className="flex min-h-[60px] flex-col gap-2 p-2">
              {colRecords.map((rec) => (
                <PanoramaCard
                  key={recordId(entity, rec)}
                  view={view}
                  entity={entity}
                  record={rec}
                  draggable={draggable}
                  onEdit={onEdit}
                  canArchive={canArchive}
                  onArchive={onArchive}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

interface PanoramaCardProps {
  view: KanbanViewDef;
  entity: EntityDef;
  record: Record<string, unknown>;
  draggable: boolean;
  onEdit: (id: string) => void;
  canArchive: boolean;
  onArchive?: (id: string) => void;
}

/** 单卡片：title 插值 + badges + footer；可拖时 dragstart 带 id；左缘竖条带列状态色（v0.0.223 加强列色归属） */
function PanoramaCard({ view, entity, record, draggable, onEdit, canArchive, onArchive }: PanoramaCardProps) {
  const { t } = useTranslation('studio');
  const id = recordId(entity, record);
  const testid = `panorama-card-${view.entity}-${id}`;
  // 卡片左缘竖条色 = 记录所属列（group_by 值）的状态色
  const laneColor = statusColor(entity, String(record[view.group_by] ?? ''));
  // v0.0.240 已归档卡片视觉弱化（archiveMode='with_archived' 时可见）
  const isArchived = record.archived === true;
  return (
    <article
      data-action-key="studio.panorama.open-entity"
      draggable={draggable}
      style={{ borderLeftColor: laneColor }}
      onDragStart={
        draggable
          ? (e) => {
              e.dataTransfer.setData('text/plain', id);
              e.dataTransfer.effectAllowed = 'move';
            }
          : undefined
      }
      onClick={() => onEdit(id)}
      className={
        'group cursor-pointer rounded-lg border border-l-4 border-border bg-surface-2 px-3 py-2 transition-colors hover:border-accent/60 ' +
        (draggable ? 'cursor-grab active:cursor-grabbing ' : '') +
        (isArchived ? 'opacity-55' : '')
      }
    >
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          {/* 实例 id 外显（v0.0.243：footer 依赖只显 id，需在卡片上能反查谁是谁） */}
          <div className="font-mono text-[10.5px] leading-tight text-muted">{id}</div>
          <div className="text-[12.5px] font-medium text-fg">{interpolate(view.card.title, record)}</div>
        </div>
        <button
          type="button"
          data-action-key="studio.panorama.edit-entity"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(id);
          }}
          className="shrink-0 rounded p-0.5 text-muted opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
        >
          <Icon name="edit" size={11} />
        </button>
        {canArchive && !isArchived && (
          <button
            type="button"
            data-action-key="studio.panorama.archive-entity"
            title={t('panorama.archive.buttonTitle')}
            onClick={(e) => {
              e.stopPropagation();
              onArchive?.(id);
            }}
            className="shrink-0 rounded p-0.5 text-muted opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
          >
            <Icon name="archive" size={11} />
          </button>
        )}
      </div>
      {view.card.badges && view.card.badges.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {view.card.badges.map((field) => {
            const raw = record[field];
            const text =
              entity.states?.field === field ? statusLabel(entity, String(raw ?? '')) : raw === undefined || raw === null ? '' : String(raw);
            if (!text) return null;
            const isStatus = entity.states?.field === field;
            return (
              <span
                key={field}
                className="rounded border border-border-2 px-1.5 py-0.5 font-mono text-[10.5px] text-fg-2"
                style={isStatus ? { borderColor: statusColor(entity, String(raw ?? '')) } : undefined}
              >
                {text}
              </span>
            );
          })}
        </div>
      )}
      {view.card.footer && (
        <div className="mt-1.5 text-[11px] text-muted">{interpolate(view.card.footer, record)}</div>
      )}
    </article>
  );
}

export default PanoramaKanban;
