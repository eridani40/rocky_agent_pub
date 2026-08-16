/**
 * section-providers — providers group 内容区根（v0.0.7；v0.0.53 持 protocols cache）
 * 参考: specs/ui/components/providers/_overview.md §3-§4 + section-providers.md（spec）
 *       持久化: saveProviderWithModels（diff-save 已在 lib 内）
 *
 * 职责：providers group 内容区根；持 view 状态机（list | detail）+ draft/snapshot + save diff；
 *   挂载 GET /provider 加载（响应含 items + protocols，[v0.0.53] cache protocols 给 fields）；
 *   detail 保存调 saveProviderWithModels → reload → 回 list。
 *   [v0.0.350 决策⑤⑥] 保存链透传 name（类型）；list 视图底部挂 CodingPlansQuotaFooter
 *   （native 子集非空才渲染；额度轮询在组件内 use-quota-polling）。
 * 边界：自管理，仅通过 onViewLevelChange 上抛 view level（[v0.0.140] detail 二级页时
 *   父级隐藏同 tab 的 default_models/llm_request group）。
 *
 * testid: providers-section
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  loadProvidersAndProtocols,
  saveProviderWithModels,
  deleteProvider,
  type ProviderInstance,
  type ModelInstance,
  type ProtocolMeta,
} from '../../lib/api-client';
import { ComponentProviderListCard } from './component-provider-list-card';
import { isNativeCodingPlan } from './provider-type-presets';
import { CodingPlansQuotaFooter } from './component-coding-plans-quota-footer';
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
          // [v0.0.350 决策⑤] name 类型透传（POST 必传；PUT name 变化才传）
          name: draft.name,
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

  /** [v0.0.349] 二级页删除确认 → DELETE → reload → 回 list（即时生效，不进 diff-save） */
  const handleDeleted = useCallback(async () => {
    if (view.level !== 'detail' || !view.pid) return;
    setError(null);
    try {
      await deleteProvider(view.pid);
      await reload();
      setView({ level: 'list' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [view, reload]);

  const totalModels = providers.reduce((s, p) => s + p.models.length, 0);
  // [v0.0.352 T1] 按 enabled 分组：默认渲染启用组；停用组非空时渲染折叠入口
  const { enabledProviders, disabledProviders } = useMemo(
    () => ({
      enabledProviders: providers.filter((p) => p.enabled),
      disabledProviders: providers.filter((p) => !p.enabled),
    }),
    [providers],
  );
  const [disabledExpanded, setDisabledExpanded] = useState(false);
  // [v0.0.350 决策⑥] native coding plan 子集（额度总览参与渠道；旧 record 无 name → 视为通用不参与）
  const nativeProviders = providers.filter((p) => isNativeCodingPlan(p.name));

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
          onDeleted={handleDeleted}
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
            enabledProviders.map((p) => (
              <ComponentProviderListCard key={p.id} provider={p} onClick={() => openDetail(p.id)} />
            ))
          )}

          {/* 添加提供商卡：虚线边框（始终置于启用组之后） */}
          <button
            type="button"
            data-action-key="providers.provider.create"
            onClick={() => openDetail(null)}
            className="border border-dashed border-border-strong rounded-[10px] py-[16px] px-[20px] text-muted hover:border-accent hover:text-accent hover:bg-accent-surface transition-colors text-left"
          >
            <span className="text-[14px] font-medium">{t('section.addProvider')}</span>
          </button>

          {/* [v0.0.352 T1] 停用折叠入口：非空时渲染，点击切换展开态 */}
          {!loading && disabledProviders.length > 0 && (
            <button
              type="button"
              data-testid="providers-disabled-fold"
              onClick={() => setDisabledExpanded((v) => !v)}
              className={`mt-2 flex items-center justify-center gap-2 w-full py-2 text-[12px] text-muted transition-colors ${
                disabledExpanded ? 'border border-border rounded-[10px] hover:border-border-strong' : 'border border-dashed border-border-strong rounded-[10px] hover:border-border-strong hover:text-fg-2'
              }`}
            >
              <span>{t('fold.disabled', { count: disabledProviders.length })}</span>
              <svg
                aria-hidden
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`transition-transform ${disabledExpanded ? 'rotate-180' : ''}`}
              >
                <path d={disabledExpanded ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} />
              </svg>
            </button>
          )}

          {/* [v0.0.352 T1] 展开的停用 provider 列表 */}
          {!loading && disabledExpanded && (
            <div data-testid="providers-disabled-list" className="mt-2">
              {disabledProviders.map((p) => (
                <ComponentProviderListCard key={p.id} provider={p} onClick={() => openDetail(p.id)} />
              ))}
            </div>
          )}

          {/* [v0.0.350 决策⑥] 额度总览 footer：仅 list 视图底部 + 存在 native provider 时渲染 */}
          {nativeProviders.length > 0 && (
            <CodingPlansQuotaFooter
              providers={nativeProviders.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl }))}
            />
          )}
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
  onDeleted,
}: {
  providers: ProviderInstance[];
  pid: string | null;
  protocols: ProtocolMeta[];
  onBack: () => void;
  onSaved: (draft: ProviderDraft) => void;
  /** [v0.0.349] 删除确认回调（DELETE + reload + 回 list） */
  onDeleted: () => void;
}) {
  const provider = pid ? providers.find((p) => p.id === pid) ?? null : null;
  return (
    <ComponentProviderDetail
      provider={provider}
      protocolOptions={protocols}
      onBack={onBack}
      onSaved={onSaved}
      onDeleted={onDeleted}
    />
  );
}

export default SectionProviders;
