/**
 * section-providers — providers group 内容区根（v0.0.7；v0.0.53 持 protocols cache）
 * 参考: specs/ui/components/providers/_overview.md §3-§4 + section-providers.md（spec）
 *       持久化: saveProviderWithModels（diff-save 已在 lib 内）
 *
 * 职责：providers group 内容区根；持 view 状态机（list | detail）+ draft/snapshot + save diff；
 *   挂载 GET /provider 加载（响应含 items + protocols，[v0.0.53] cache protocols 给 fields）；
 *   detail 保存调 saveProviderWithModels → reload → 回 list。
 * 边界：自管理，仅通过 onViewLevelChange 上抛 view level（[v0.0.140] detail 二级页时
 *   父级隐藏同 tab 的 default_models/llm_request group）。
 *
 * testid: providers-section
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  loadProvidersAndProtocols,
  saveProviderWithModels,
  type ProviderInstance,
  type ModelInstance,
  type ProtocolMeta,
} from '../../lib/api-client';
import { ComponentProviderListCard } from './component-provider-list-card';
import {
  ComponentProviderDetail,
  type ProviderDraft,
} from './component-provider-detail';

/** view 状态：list | detail（pid=null=新增） */
type ViewState = { level: 'list' } | { level: 'detail'; pid: string | null };

interface SectionProvidersProps {
  /** view level 变更通知（[v0.0.140] detail 二级页时父级隐藏同 tab 其余 group） */
  onViewLevelChange?: (level: 'list' | 'detail') => void;
}

/** providers group 内容区：列表 ↔ 二级页 状态机 */
export function SectionProviders({ onViewLevelChange }: SectionProvidersProps = {}) {
  // [v0.0.62 i18n] providers ns 主，common 兼用（status.loading 等通用词）
  const { t } = useTranslation(['providers', 'common']);
  const [providers, setProviders] = useState<ProviderInstance[]>([]);
  // [v0.0.53] protocols cache：一次加载全程共享（不随 detail 切换重拉）
  const [protocols, setProtocols] = useState<ProtocolMeta[]>([]);
  const [view, setView] = useState<ViewState>({ level: 'list' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** 拉取 /provider 列表 + protocols metadata（[v0.0.53] 一次调用取两项） */
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { items, protocols: protos } = await loadProvidersAndProtocols();
      setProviders(items);
      // [v0.0.53] 只在 protos 非空时覆盖（避免后端旧版无 protocols 字段时清空 cache）
      if (protos.length > 0) setProtocols(protos);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  // view level 上抛（含挂载初始 list——切 tab 重挂后父级状态随之复位）
  useEffect(() => {
    onViewLevelChange?.(view.level);
  }, [view.level, onViewLevelChange]);

  /** 进二级页：已存 provider / null=新增 */
  const openDetail = (pid: string | null) => setView({ level: 'detail', pid });

  /** 返回列表 */
  const backToList = () => setView({ level: 'list' });

  /** 二级页保存 → 算 diff-save（snapshot=进入时 provider 或 null）→ reload → 回 list */
  const handleSaved = useCallback(
    async (draft: ProviderDraft) => {
      setError(null);
      try {
        const snapshot =
          view.level === 'detail' && view.pid
            ? providers.find((p) => p.id === view.pid) ?? null
            : null;
        await saveProviderWithModels(snapshot, {
          id: snapshot?.id,
          label: draft.label,
          baseUrl: draft.baseUrl,
          apiKey: draft.apiKey,
          enabled: draft.enabled,
          // [v0.0.53] protocolId 必传（新建 provider 必填，已存 diff 算 dirty）
          protocolId: draft.protocolId,
          models: draft.models as ModelInstance[],
        });
        await reload();
        setView({ level: 'list' });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [providers, view, reload],
  );

  const totalModels = providers.reduce((s, p) => s + p.models.length, 0);

  return (
    <div className="flex flex-col">
      {error && (
        <div role="alert" className="mb-3 px-3 py-2 text-sm text-accent bg-accent-surface border border-border rounded-md">
          {error}
        </div>
      )}

      {view.level === 'detail' ? (
        <Detail
          providers={providers}
          pid={view.pid}
          protocols={protocols}
          onBack={backToList}
          onSaved={handleSaved}
        />
      ) : (
        <>
          {/* list header */}
          <div className="mb-3">
            <div className="text-[11px] text-muted font-mono mt-0.5">
              {t('section.subtitle', { providerCount: providers.length, modelCount: totalModels })}
            </div>
          </div>

          {loading ? (
            <div className="text-xs text-muted font-mono py-4">{t('common:status.loading')}</div>
          ) : (
            providers.map((p) => (
              <ComponentProviderListCard key={p.id} provider={p} onClick={() => openDetail(p.id)} />
            ))
          )}

          {/* 添加提供商卡：虚线边框 */}
          <button
            type="button"
            data-action-key="providers.provider.create"
            onClick={() => openDetail(null)}
            className="border border-dashed border-border-strong rounded-[10px] py-[16px] px-[20px] text-muted hover:border-accent hover:text-accent hover:bg-accent-surface transition-colors text-left"
          >
            <span className="text-[14px] font-medium">{t('section.addProvider')}</span>
          </button>
        </>
      )}
    </div>
  );
}

/** 二级页包装：按 pid 找 provider（null=新增）传给 detail */
function Detail({
  providers,
  pid,
  protocols,
  onBack,
  onSaved,
}: {
  providers: ProviderInstance[];
  pid: string | null;
  protocols: ProtocolMeta[];
  onBack: () => void;
  onSaved: (draft: ProviderDraft) => void;
}) {
  const provider = pid ? providers.find((p) => p.id === pid) ?? null : null;
  return (
    <ComponentProviderDetail
      provider={provider}
      protocolOptions={protocols}
      onBack={onBack}
      onSaved={onSaved}
    />
  );
}

export default SectionProviders;
