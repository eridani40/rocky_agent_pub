/**
 * component-panorama-view —— 全景工作态渲染器（受控 view + kanban/table/bar_chart 装配）
 * 参考: specs/ui/components/studio-page/component-panorama-view.md v2.0
 *       specs/api/overall/14-panorama-endpoints.md §2/§3（实体 CRUD + transition + events）
 *
 * 职责：吃 route 注入的受控 activeViewId 派生 view；toolbar；三原语装配；拖拽 transition；
 *   弹层新建/编辑；事件流面板；SSE entity_update 乐观更新。v0.0.196 起不持 activeTab、不渲 tab 条。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createPanoramaEntity,
  listPanoramaEntities,
  listPanoramaEvents,
  patchPanoramaEntity,
  transitionPanoramaEntity,
} from '../../lib/panorama-api';
import type {
  EntityDef,
  PanoramaEntityUpdateEvent,
  PanoramaEvent,
  PanoramaSchema,
  ViewDef,
} from './panorama-types';
import { recordId } from './panorama-utils';
import { PanoramaKanban } from './component-panorama-kanban';
import { PanoramaTable } from './component-panorama-table';
import { PanoramaBarChart } from './component-panorama-bar-chart';
import { PanoramaEvents } from './component-panorama-events';
import { PanoramaEntityModal } from './component-panorama-entity-modal';
import { ArchiveSwitch, type ArchiveMode } from './component-panorama-archive-switch';
import type { SelectorOption } from './component-shared-selector';
import { Icon } from './studio-icons';

export interface PanoramaViewProps {
  squadId: string;
  schema: PanoramaSchema;
  /** v0.0.196 受控 view id（route 保证是 schema.views 中合法 view id） */
  activeViewId: string;
  /** route 透传的 SSE entity_update（乐观更新数据源） */
  entityEvent?: PanoramaEntityUpdateEvent | null;
}

type EntityData = Record<string, Record<string, unknown>[]>;
type Editing = { mode: 'create' | 'edit'; entity: string; id?: string } | null;

export function PanoramaView({ squadId, schema, activeViewId, entityEvent }: PanoramaViewProps) {
  const { t } = useTranslation(['studio', 'common']);
  const [data, setData] = useState<EntityData>({});
  const [events, setEvents] = useState<PanoramaEvent[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const [editing, setEditing] = useState<Editing>(null);
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeq = useRef(-1);

  // v0.0.196：受控 activeViewId（route 保证合法），未找到 return null
  const view: ViewDef | undefined = schema.views.find((v) => v.id === activeViewId);
  const entityDef: EntityDef | undefined = view ? schema.entities[view.entity] : undefined;

  // v0.0.240 归档开关：仅 view.filter.archived 时显示；'active'=透传 filter（隐藏归档）, 'with_archived'=不传 filter
  const hasArchiveFilter = !!(view?.filter && Object.prototype.hasOwnProperty.call(view.filter, 'archived'));
  const [archiveMode, setArchiveMode] = useState<ArchiveMode>('active');
  useEffect(() => { setArchiveMode('active'); }, [activeViewId]);

  const flash = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ msg, kind });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  /** 拉单实体实例（缓存到 data map；v0.0.240 归档开关 override 时省略 filter） */
  const fetchEntity = useCallback(
    async (name: string) => {
      try {
        const filter = archiveMode === 'with_archived' ? undefined : view?.filter;
        const instances = await listPanoramaEntities(squadId, name, filter ? { filter } : {});
        setData((prev) => ({ ...prev, [name]: instances }));
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e), 'err');
      }
    },
    [squadId, flash, view, archiveMode],
  );

  const fetchEvents = useCallback(async () => {
    try {
      setEvents(await listPanoramaEvents(squadId, 20));
    } catch { /* 事件流失败不阻塞主视图 */ }
  }, [squadId]);

  // view 切换 / mount：拉当前 view 实体数据（v0.0.196 受控 activeViewId 变化触发）
  useEffect(() => {
    if (view) void fetchEntity(view.entity);
  }, [view, fetchEntity]);
  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  // SSE entity_update → 乐观更新 data + 事件流追加一行
  useEffect(() => {
    if (!entityEvent || entityEvent.seq === lastSeq.current) return;
    lastSeq.current = entityEvent.seq;
    const { entity, id, record, action, seq } = entityEvent;
    setData((prev) => {
      const list = prev[entity];
      if (!list) return prev; // 未缓存的实体不乐观加（下次切 tab 拉取）
      const idx = list.findIndex((r) => String(r[schema.entities[entity]?.id_field ?? 'id'] ?? '') === id);
      const next = [...list];
      if (idx >= 0) next[idx] = record;
      else next.push(record);
      return { ...prev, [entity]: next };
    });
    setEvents((prev) => [
      { seq, ts: new Date().toISOString(), type: `entity.${action}`, entity, summary: `${entity}/${id} ${action}`, payload: {} },
      ...prev.filter((e) => e.seq !== seq),
    ].slice(0, 20));
  }, [entityEvent, schema.entities]);

  /** 拖拽跃迁：成功乐观移动 + toast；非法（400）→ 不移动 + toast reason（天然回弹） */
  const handleTransition = useCallback(
    async (entity: string, id: string, to: string) => {
      try {
        await transitionPanoramaEntity(squadId, entity, id, to);
        const ed = schema.entities[entity];
        const stateField = ed?.states?.field;
        if (ed && stateField) {
          setData((prev) => ({
            ...prev,
            [entity]: (prev[entity] ?? []).map((r) =>
              recordId(ed, r) === id ? { ...r, [stateField]: to } : r,
            ),
          }));
        }
        flash(t('studio:panorama.toast.transitionOk', { id, to }));
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e), 'err');
      }
    },
    [squadId, schema.entities, flash, t],
  );

  /** 弹层 ref 字段选项：目标实体实例（value/label=id；未缓存先拉取） */
  const refOptions = useMemo(() => {
    if (!editing) return {};
    const def = schema.entities[editing.entity];
    const out: Record<string, SelectorOption[]> = {};
    if (!def) return out;
    for (const [fname, fdef] of Object.entries(def.fields)) {
      if (fdef.type !== 'ref') continue;
      const target = schema.entities[fdef.entity];
      out[fname] = (data[fdef.entity] ?? []).map((r) => {
        const id = target ? recordId(target, r) : String(r.id ?? '');
        return { value: id, label: id };
      });
    }
    return out;
  }, [editing, schema.entities, data]);

  // 打开弹层时预拉 ref 目标实体数据（补选项）
  useEffect(() => {
    if (!editing) return;
    const def = schema.entities[editing.entity];
    if (!def) return;
    for (const fdef of Object.values(def.fields)) {
      if (fdef.type === 'ref' && !data[fdef.entity]) void fetchEntity(fdef.entity);
    }
  }, [editing, schema.entities, data, fetchEntity]);

  /** v0.0.40 归档卡片：PATCH archived:true；成功乐观从活跃视图移除（fetchEntity 已带 filter 重拉清掉） */
  const handleArchive = useCallback(
    async (entity: string, id: string) => {
      try {
        await patchPanoramaEntity(squadId, entity, id, { archived: true });
        flash(t('studio:panorama.toast.archived', { id }));
        // 重新拉取（archiveMode='active' 时被归档项消失；'with_archived' 时视觉弱化保留）
        void fetchEntity(entity);
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e), 'err');
      }
    },
    [squadId, flash, t, fetchEntity],
  );

  /** 弹层提交：create=POST fields / edit=PATCH dirty patch；成功后重拉实体数据 */
  const handleSubmit = useCallback(
    async (values: Record<string, unknown>) => {
      if (!editing) return;
      try {
        if (editing.mode === 'create') await createPanoramaEntity(squadId, editing.entity, values);
        else if (editing.id) await patchPanoramaEntity(squadId, editing.entity, editing.id, values);
        setEditing(null);
        flash(t('studio:panorama.toast.saveOk'));
        void fetchEntity(editing.entity);
      } catch (e) {
        flash(e instanceof Error ? e.message : String(e), 'err');
      }
    },
    [editing, squadId, flash, t, fetchEntity],
  );

  if (!view || !entityDef) return null;
  const records = data[view.entity] ?? [];
  const editingEntityDef = editing ? schema.entities[editing.entity] : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-8 pb-6 pt-5">
      {/* toolbar：左 归档开关（仅 view.filter.archived 时）+ 右 +新建/刷新（h-7） */}
      <div className="flex items-center justify-between gap-2">
        {hasArchiveFilter ? (
          <ArchiveSwitch mode={archiveMode} onChange={setArchiveMode} />
        ) : (
          <div />
        )}
        <div className="flex h-7 items-center gap-2">
          <button
            type="button"
            data-action-key="studio.panorama.create-entity"
            onClick={() => setEditing({ mode: 'create', entity: view.entity })}
            className="flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-surface-2"
          >
            <Icon name="plus" size={12} />
            {t('studio:panorama.toolbar.create', { label: entityDef.label })}
          </button>
          <button
            type="button"
            data-action-key="studio.panorama.refresh"
            onClick={() => {
              void fetchEntity(view.entity);
              void fetchEvents();
            }}
            className="flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2.5 text-[12px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <Icon name="refresh" size={12} />
            {t('common:action.refresh')}
          </button>
        </div>
      </div>

      {/* 当前 view 渲染区（三原语装配） */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {view.component === 'kanban' && (
          <PanoramaKanban
            view={view}
            entity={entityDef}
            records={records}
            onTransition={(id, to) => void handleTransition(view.entity, id, to)}
            onEdit={(id) => setEditing({ mode: 'edit', entity: view.entity, id })}
            onArchive={(id) => void handleArchive(view.entity, id)}
          />
        )}
        {view.component === 'table' && (
          <PanoramaTable
            view={view}
            entity={entityDef}
            records={records}
            onEdit={(id) => setEditing({ mode: 'edit', entity: view.entity, id })}
          />
        )}
        {view.component === 'bar_chart' && <PanoramaBarChart view={view} entity={entityDef} records={records} />}
      </div>

      {/* 事件流面板（底部可折叠） */}
      <PanoramaEvents events={events} collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />

      {/* 实体弹层（create/edit 共用） */}
      {editing && editingEntityDef && (
        <PanoramaEntityModal
          mode={editing.mode}
          entity={editing.entity}
          entityDef={editingEntityDef}
          initial={
            editing.mode === 'edit'
              ? (data[editing.entity] ?? []).find((r) => recordId(editingEntityDef, r) === editing.id)
              : undefined
          }
          refOptions={refOptions}
          onSubmit={(v) => void handleSubmit(v)}
          onCancel={() => setEditing(null)}
          onToast={(msg) => flash(msg, 'err')}
        />
      )}

      {/* toast（对齐 squad-board-toast 样式） */}
      {toast && (
        <div
          className={
            'fixed bottom-6 left-1/2 z-[300] -translate-x-1/2 rounded-md px-3 py-1.5 text-[12px] font-medium shadow-md ' +
            (toast.kind === 'err' ? 'bg-danger/90 text-white' : 'bg-fg/90 text-bg')
          }
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

export default PanoramaView;
