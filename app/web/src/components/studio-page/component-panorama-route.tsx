/**
 * component-panorama-route —— 业务全景路由（schema 分发 + 动态 views；v0.0.240 内嵌首页第二栏）
 * 参考: specs/ui/components/studio-page/component-panorama-route.md
 *
 * 职责：
 *   1. GET /squad/:squadId/panorama/schema → 三态：undefined=loading / null=空态（理论不出现）/ 有值=工作态
 *   2. tab 装配：后端 injectSystemEntities 保证 task_kanban 恒在 views 首项 + DSL views 顺延 + 固定「更多」tab 永远在最右
 *   3. v0.0.240：内嵌组件（无头部返回键 / 无独立路由头部）—— 首页第二栏直接渲染
 *   4. 按 activeTab 受控分发 → PanoramaView(activeViewId) / PanoramaIdle(activeTab==='more')
 *   5. SSE topic='panorama' + group=panorama:squad:{id}；
 *      schema_update → 重拉 schema + 校验 activeTab；entity_update → 透传 view
 * 边界：持 activeTab 唯一 tab 状态源；不渲视图内容（受控子组件负责）；不直调实体 CRUD。
 *
 * v0.0.243 恢复「更多」tab：永远在最右，提醒用户可以让 leader 搭看板。点击展示 PanoramaIdle 引导。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSseClient } from '../../lib/sse-singleton';
import { getPanoramaSchema } from '../../lib/panorama-api';
import type { PanoramaEntityUpdateEvent, PanoramaSchema, PanoramaSseEvent } from './panorama-types';
import { panoramaGroup } from './panorama-types';
import { parsePanoramaDsl } from './panorama-utils';
import { PanoramaView } from './component-panorama-view';
import { PanoramaIdle } from './component-panorama-idle';
import { BTN_SECONDARY } from './studio-styles';

export interface PanoramaRouteProps {
  squadId: string;
  /** 「更多」tab 的「去群聊 @leader」回调（切群聊 + 预填 mention，由 page-studio 实现） */
  onAtLeader: () => void;
}

/** 「更多」固定 tab 的 id（永远在最右，不依赖 schema） */
export const PANORAMA_MORE_TAB_ID = 'more';

/** schema 三态：undefined=loading / null=空态（理论不出现，后端 ensure 兜底恒返含 task 的 DSL）/ 有值=工作态 */
type SchemaState = PanoramaSchema | null | undefined;

/** tab id = DSL view id 或 'more' 固定项（后端 inject 保证 task_kanban 恒在 views 首项） */
export type PanoramaActiveTab = string & {};

/** 统一 tab 条按钮样式 */
const tabBtnClass = (isActive: boolean) =>
  '-mb-px border-b-2 px-3 py-1.5 text-[12.5px] transition-colors ' +
  (isActive ? 'border-b-fg font-semibold text-fg' : 'border-b-transparent text-muted hover:text-fg-2');

/** 动态 view id → action-key 片段归一（全小写 + 下划线转连字符，_conventions §12.2 kebab 约定） */
const kebabId = (id: string) => id.toLowerCase().replace(/_/g, '-');

export function PanoramaRoute({ squadId, onAtLeader }: PanoramaRouteProps) {
  const { t } = useTranslation(['studio', 'common']);
  const [schema, setSchema] = useState<SchemaState>(undefined);
  const [error, setError] = useState<string | null>(null);
  /** 最近一条 entity_update（透传 view 乐观更新；同 seq 去重由 view 侧处理） */
  const [entityEvent, setEntityEvent] = useState<PanoramaEntityUpdateEvent | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const dsl = await getPanoramaSchema(squadId);
      // 后端 ensureSystemEntities 保证 DSL 恒含 task entity（非 null）；DSL=null 走空态分支（理论不出现）
      setSchema(dsl ? parsePanoramaDsl(dsl) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSchema(undefined);
    }
  }, [squadId]);

  useEffect(() => {
    setSchema(undefined);
    void load();
  }, [load]);

  // SSE：schema_update → 重拉重建 + 校验 activeTab；entity_update → 透传 view
  useEffect(() => {
    let disposed = false;
    let unsub: (() => Promise<void>) | null = null;
    getSseClient()
      .subscribe('panorama', panoramaGroup(squadId), (frame) => {
        if (disposed) return;
        const evt = frame.data as PanoramaSseEvent;
        if (evt?.type === 'panorama_schema_update') void load();
        else if (evt?.type === 'panorama_entity_update') setEntityEvent(evt);
      })
      .then((h) => {
        if (disposed) void h.unsubscribe();
        else unsub = h.unsubscribe;
      })
      .catch(() => { /* subscribe 失败不阻塞 UI */ });
    return () => {
      disposed = true;
      if (unsub) void unsub();
    };
  }, [squadId, load]);

  // 后端 inject 保证 task_kanban 恒在 views 首项 → defaultTab = 首项 view id（'more' 不作默认）
  const dynamicViews = useMemo(() => schema?.views ?? [], [schema]);
  const defaultTab: PanoramaActiveTab = dynamicViews[0]?.id ?? '';
  const [activeTab, setActiveTab] = useState<PanoramaActiveTab>(defaultTab);

  // schema 变化后校验 activeTab 仍合法（动态 view 或固定 'more'）；非法回落 defaultTab
  useEffect(() => {
    const isMore = activeTab === PANORAMA_MORE_TAB_ID;
    if (!isMore && !dynamicViews.some((v) => v.id === activeTab)) {
      setActiveTab(defaultTab);
    }
  }, [dynamicViews, activeTab, defaultTab]);

  return (
    <div className="flex min-h-0 flex-col">
      {schema === undefined && !error && (
        <div className="flex flex-1 items-center justify-center px-8 py-6 text-xs text-muted">
          {t('common:status.loading')}
        </div>
      )}
      {error && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-6">
          <div className="text-xs text-muted">{error}</div>
          <button type="button" onClick={() => void load()} className={BTN_SECONDARY} data-action-key="studio.panorama.retry">
            {t('common:action.retry')}
          </button>
        </div>
      )}
      {schema !== undefined && !error && (
        <>
          {/* tab 条：动态 views（task_kanban 首项）+ 固定「更多」tab 永远在最右 */}
          <div className="flex gap-0.5 border-b border-border">
            {dynamicViews.map((v) => (
              <button
                key={v.id}
                type="button"
                data-action-key={`studio.panorama.open-${kebabId(v.id)}`}
                data-active={activeTab === v.id ? 'true' : 'false'}
                onClick={() => setActiveTab(v.id)}
                className={tabBtnClass(activeTab === v.id)}
              >
                {v.label}
              </button>
            ))}
            {/* 固定「更多」tab（永远在最右，提醒用户可以让 leader 搭看板） */}
            <button
              type="button"
              data-action-key="studio.panorama.open-more"
              data-active={activeTab === PANORAMA_MORE_TAB_ID ? 'true' : 'false'}
              onClick={() => setActiveTab(PANORAMA_MORE_TAB_ID)}
              className={tabBtnClass(activeTab === PANORAMA_MORE_TAB_ID)}
            >
              {t('studio:panorama.tabs.more')}
            </button>
          </div>

          {/* 按 activeTab 受控分发：'more' → PanoramaIdle；其他 → PanoramaView（activeViewId 合法） */}
          {schema && activeTab === PANORAMA_MORE_TAB_ID && (
            <PanoramaIdle squadId={squadId} onAtLeader={onAtLeader} />
          )}
          {schema && activeTab !== PANORAMA_MORE_TAB_ID && (
            <PanoramaView
              squadId={squadId}
              schema={schema}
              activeViewId={activeTab}
              entityEvent={entityEvent}
            />
          )}
        </>
      )}
    </div>
  );
}

export default PanoramaRoute;
