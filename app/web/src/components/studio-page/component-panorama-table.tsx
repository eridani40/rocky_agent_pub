/**
 * component-panorama-table —— 全景 table 原语（行=实例，列=DSL columns）
 * 参考: specs/ui/components/studio-page/component-panorama-view.md（table 渲染契约）
 *
 * sort/limit 由 DSL 声明（前端按 DSL 应用，不覆盖）；行点击 → 编辑弹层。
 */
import type { EntityDef, TableViewDef } from './panorama-types';
import { enumValueLabel, fieldLabel, recordId, statusColor } from './panorama-utils';
import { Icon } from './studio-icons';

export interface PanoramaTableProps {
  view: TableViewDef;
  entity: EntityDef;
  records: Record<string, unknown>[];
  /** 行点击 → 编辑弹层 */
  onEdit: (id: string) => void;
}

/** 按 DSL sort 排序 + limit 截断（前端应用 DSL 声明，不提供交互排序） */
function applyDslOrder(view: TableViewDef, records: Record<string, unknown>[]): Record<string, unknown>[] {
  let list = records;
  if (view.sort) {
    const { field, order } = view.sort;
    list = [...list].sort((a, b) => {
      const av = a[field];
      const bv = b[field];
      const cmp = String(av ?? '') < String(bv ?? '') ? -1 : String(av ?? '') > String(bv ?? '') ? 1 : 0;
      return order === 'desc' ? -cmp : cmp;
    });
  }
  if (view.limit) list = list.slice(0, view.limit);
  return list;
}

/** table 渲染区：表头 = 字段 label（兜底字段名）；enum 列走 display labels（状态列染状态色） */
export function PanoramaTable({ view, entity, records, onEdit }: PanoramaTableProps) {
  const rows = applyDslOrder(view, records);
  return (
    <div data-view-id={view.id} className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-border text-left">
            {view.columns.map((col) => (
              <th key={col} className="px-3 py-2 font-mono text-[11px] font-semibold tracking-wider text-muted-2">
                {fieldLabel(entity, col)}
              </th>
            ))}
            <th className="w-9 px-2 py-2" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {rows.map((rec) => {
            const id = recordId(entity, rec);
            return (
              <tr
                key={id}
                data-action-key="studio.panorama.open-entity"
                onClick={() => onEdit(id)}
                className="group cursor-pointer border-b border-border/60 transition-colors last:border-b-0 hover:bg-surface-2"
              >
                {view.columns.map((col) => {
                  const raw = rec[col];
                  const isStatus = entity.states?.field === col;
                  const isEnum = entity.fields[col]?.type === 'enum';
                  const text =
                    raw === undefined || raw === null ? '' : isEnum ? enumValueLabel(entity, col, String(raw)) : String(raw);
                  return (
                    <td key={col} className="px-3 py-2 text-fg-2">
                      {isStatus && text ? (
                        <span
                          className="rounded border px-1.5 py-0.5 font-mono text-[10.5px]"
                          style={{ borderColor: statusColor(entity, String(raw ?? '')) }}
                        >
                          {text}
                        </span>
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
                <td className="px-2 py-2">
                  <button
                    type="button"
                    data-action-key="studio.panorama.edit-entity"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(id);
                    }}
                    className="rounded p-0.5 text-muted opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
                  >
                    <Icon name="edit" size={11} />
                  </button>
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={view.columns.length + 1} className="px-3 py-8 text-center text-muted">
                —
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default PanoramaTable;
