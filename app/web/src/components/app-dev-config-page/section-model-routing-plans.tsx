/**
 * section-model-routing-plans — 模型组合方案库（v0.0.347 UI v2 两层结构）
 * 参考 specs/prd/model-routing-demo-v2.html（冻结视觉契约：外层卡片列表 → 详情）
 *       specs/tech/version_logs/v0.0.347/change_plan.md 决策⑨/⑩/⑯/⑰
 *       components/providers/component-provider-detail.tsx（详情风格唯一基准，T4 补丁）
 *
 * 职责（两层）：
 *   - 外层：方案卡片列表（PlanCard：名称 / N 个模型 / 模型名 · join / 挂载徽章 /
 *     ⋯ 菜单 rename+copy+delete / chevron）；整卡点击进详情
 *   - 内层：ComponentPlanDetail 独立页（面包屑 + logo 标题区 + 编辑器 + SaveBar，
 *     provider detail 同款风格）；进详情 structuredClone 快照，面包屑回退 = 快照回滚
 *     （新建未保存 = 移除），SaveBar 保存 = PUT + 清快照回列表（风险点 1）
 *   - 红绿灯：列表不放（决策⑰）；详情打开拉单方案 status 供 item 行 badge
 *   - viewLevel 上抛（T4 补丁）：detail 态时父级 tab 隐藏其余 group（独立页独占，
 *     同 SectionProviders onViewLevelChange 机制）
 *
 * 边界：自渲染即时操作（不走 page-tab dirty，同 provider 独立 save 范式）；后端零改动。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmModal } from '../common/component-confirm-modal';
import { ComponentPlanDetail } from './component-plan-detail';
import { PlanCard } from './component-plan-card';
import { isPlanDirty, reindexPriorities, validatePlanLocal } from './model-routing-plan-lib';
import {
  listModelRoutingPlans, saveModelRoutingPlan, deleteModelRoutingPlan,
  getModelRoutingStatus, listPlanMounts, defaultPlanName, copyPlanName,
} from './model-routing-api';
import type { ModelRoutingPlan, ModelRoutingStatus } from './model-routing-types';
import { useProviders } from '../../lib/providers';
import { ulid } from '../../lib/ulid';

/** 视图态：列表 / 详情（planId 指向 plans 内 draft；isNew = 新建未落库） */
type ViewState = { level: 'list' } | { level: 'detail'; planId: string; isNew: boolean };

interface SectionModelRoutingPlansProps {
  /** view level 变更通知（detail 态时父级 tab 隐藏同 tab 其余 group——独立页，同 SectionProviders 机制） */
  onViewLevelChange?: (level: 'list' | 'detail') => void;
  /** [v0.0.349 BUG-004] 删除成功后上抛 detached 列表 + 被删 planId（含 'playground' 时消费方清本地挂载态） */
  onPlanDeleted?: (detached: string[], planId: string) => void;
}

/** 方案库区块（两层） */
export function SectionModelRoutingPlans({ onViewLevelChange, onPlanDeleted }: SectionModelRoutingPlansProps = {}) {
  const { t } = useTranslation('app-dev-config');
  const [plans, setPlans] = useState<ModelRoutingPlan[]>([]);
  const [view, setView] = useState<ViewState>({ level: 'list' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ModelRoutingStatus | null>(null);
  const [mounts, setMounts] = useState<Record<string, string[]>>({});
  const [snapshot, setSnapshot] = useState<ModelRoutingPlan | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ModelRoutingPlan | null>(null);
  const [renameDraft, setRenameDraft] = useState<{ planId: string; value: string } | null>(null);
  const [menuPlanId, setMenuPlanId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // [v0.0.349] providers 拉取（dangling 存在性预检 + 逐行 invalid 红描边数据源）；
  // 未加载完成 / 拉取失败 → undefined 跳过存在性检查（加载窗口不误判全条目失效；服务端 PUT 校验仍兜底）
  const { providers: providerItems, error: providerError, loaded: providersLoaded } = useProviders();
  const planProviders = providerError || !providersLoaded ? undefined : providerItems;

  // viewLevel 上抛（含挂载初始 list——切 tab 重挂后父级状态随之复位，同 provider 机制）
  useEffect(() => {
    onViewLevelChange?.(view.level);
  }, [view.level, onViewLevelChange]);

  /** 拉方案列表 + 挂载徽章（listPlanMounts 失败降级空不阻断，决策⑯） */
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPlans(await listModelRoutingPlans());
      listPlanMounts().then(setMounts).catch(() => setMounts({}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 点空白关 ⋯ 菜单（菜单内点击 data-keep-popover 豁免） */
  useEffect(() => {
    if (menuPlanId === null) return;
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-keep-popover]')) return;
      setMenuPlanId(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuPlanId]);

  /** 进详情：structuredClone 快照（决策⑨）+ 拉单方案红绿灯（决策⑰） */
  const openDetail = (planId: string) => {
    const plan = plans.find((p) => p.id === planId);
    if (!plan) return;
    setSnapshot(structuredClone(plan));
    setView({ level: 'detail', planId, isNew: false });
    setMenuPlanId(null);
    setStatus(null);
    getModelRoutingStatus(planId).then(setStatus).catch(() => setStatus(null));
  };

  /** 取消 = 快照回滚（新建未保存 = 移除），回列表 */
  const cancelDetail = () => {
    if (view.level === 'detail' && snapshot) {
      setPlans((prev) =>
        view.isNew ? prev.filter((p) => p.id !== view.planId)
          : prev.map((p) => (p.id === snapshot.id ? snapshot : p)));
    }
    setSnapshot(null);
    setStatus(null);
    setView({ level: 'list' });
  };

  /** 新建：入 plans + 进详情（isNew；取消 = 移除） */
  const handleCreate = () => {
    const plan: ModelRoutingPlan = { id: ulid(), name: defaultPlanName(plans.length), items: [], createdAt: Date.now() };
    setPlans((prev) => [...prev, plan]);
    setSnapshot(structuredClone(plan));
    setView({ level: 'detail', planId: plan.id, isNew: true });
  };

  /** 复制（「<原名> 副本」独立 id 深拷贝 → PUT → 刷新） */
  const handleCopy = async (plan: ModelRoutingPlan) => {
    setMenuPlanId(null);
    try {
      await saveModelRoutingPlan({
        ...plan, id: ulid(), name: copyPlanName(plan.name), createdAt: Date.now(),
        items: plan.items.map((it) => ({ ...it, timeCondition: it.timeCondition ? { hours: [...it.timeCondition.hours] } : undefined })),
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 重命名提交（受控输入值 trim；空/未变更不 PUT — BUG-002 回归语义） */
  const handleRename = async (plan: ModelRoutingPlan) => {
    const name = renameDraft?.value.trim();
    setRenameDraft(null);
    setMenuPlanId(null);
    if (!name || name === plan.name) return;
    try {
      await saveModelRoutingPlan({ ...plan, name });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 删除（DELETE → detached 提示 → 刷新） */
  const handleDelete = async () => {
    if (!confirmDelete) return;
    const plan = confirmDelete;
    setConfirmDelete(null);
    setMenuPlanId(null);
    try {
      const { detached } = await deleteModelRoutingPlan(plan.id);
      if (detached.length > 0) setError(t('modelRouting.delete.detachedHint', { count: detached.length }));
      // [v0.0.349 BUG-004] 上抛 detached + planId：服务端已解绑挂载点（含 'playground'），
      // page 级 hook 同步清本地 mountDraft/mountSnapshot（否则会话 tab trigger 残显「方案 · <planId>」）
      onPlanDeleted?.(detached, plan.id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 保存：本地预检 → reindex → PUT → 清快照回列表（风险点 1） */
  const handleSave = async (plan: ModelRoutingPlan) => {
    setError(null);
    // [v0.0.349] providers 可用时做 dangling 存在性预检（与编辑器实时预检同语义，此处拦 PUT）
    const localErrors = validatePlanLocal(plan, planProviders);
    if (localErrors.length > 0) throw new Error(localErrors.map((k) => t(k)).join('；'));
    setSaving(true);
    try {
      await saveModelRoutingPlan({
        ...plan,
        items: reindexPriorities(plan.items),
        circuit: plan.circuit && Object.keys(plan.circuit).length > 0 ? plan.circuit : undefined,
      });
      setSnapshot(null);
      setStatus(null);
      setView({ level: 'list' });
      await reload();
    } finally {
      setSaving(false);
    }
  };

  /** SaveBar 取消 = 重置回快照，留在详情页（provider detail 同语义） */
  const resetToSnapshot = () => {
    if (!snapshot) return;
    const restored = structuredClone(snapshot);
    setPlans((prev) => prev.map((p) => (p.id === restored.id ? restored : p)));
  };

  const editPlan = view.level === 'detail' ? plans.find((p) => p.id === view.planId) : undefined;

  /* —— 内层：详情独立页（provider detail 风格基准：面包屑 + logo 标题 + SaveBar）—— */
  if (view.level === 'detail' && editPlan) {
    return (
      <div data-testid="model-routing-plans">
        <ComponentPlanDetail
          plan={editPlan}
          dirty={snapshot ? isPlanDirty(snapshot, editPlan) : false}
          saving={saving}
          status={status}
          providers={planProviders}
          serverError={error}
          onChange={(next) => setPlans((prev) => prev.map((p) => (p.id === next.id ? next : p)))}
          onBack={cancelDetail}
          onSave={() => {
            void handleSave(editPlan).catch((e) => setError(e instanceof Error ? e.message : String(e)));
          }}
          onReset={resetToSnapshot}
        />
      </div>
    );
  }

  /* —— 外层：方案卡片列表 —— */
  return (
    <div data-testid="model-routing-plans">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="m-0 text-[15px] font-semibold text-fg">{t('group.model_routing_plans.label')}</h3>
        <button
          type="button"
          data-testid="plan-create"
          data-action-key="settings.models.plan.create"
          className="rounded-md bg-fg px-4 py-1.5 text-[13px] font-medium text-bg hover:bg-fg-hover"
          onClick={handleCreate}
        >
          + {t('modelRouting.list.create')}
        </button>
      </div>

      {error && (
        <div data-testid="model-routing-error" className="mb-2 rounded border border-danger/30 bg-danger-light px-2 py-1 text-[12px] text-danger">
          {error}
        </div>
      )}
      {loading && <div className="text-[12px] text-muted">{t('modelRouting.list.loading')}</div>}
      {!loading && plans.length === 0 && (
        <div className="rounded-lg border border-dashed border-border-strong px-3 py-4 text-center text-[12px] text-muted">
          {t('modelRouting.list.empty')}
        </div>
      )}

      {!loading && plans.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {plans.map((p) => (
            <PlanCard
              key={p.id}
              plan={p}
              mounted={mounts[p.id] ?? []}
              menuOpen={menuPlanId === p.id}
              renameDraft={renameDraft}
              onOpen={() => openDetail(p.id)}
              onMenuToggle={() => setMenuPlanId(menuPlanId === p.id ? null : p.id)}
              onRenameStart={() => {
                setMenuPlanId(null);
                setRenameDraft({ planId: p.id, value: p.name });
              }}
              onRenameChange={(value) => setRenameDraft({ planId: p.id, value })}
              onRenameCommit={() => void handleRename(p)}
              onRenameCancel={() => setRenameDraft(null)}
              onCopy={() => void handleCopy(p)}
              onDeleteRequest={() => {
                setMenuPlanId(null);
                setConfirmDelete(p);
              }}
            />
          ))}
        </div>
      )}

      {confirmDelete && (
        <ConfirmModal
          title={t('modelRouting.delete.title')}
          body={t('modelRouting.delete.body', { name: confirmDelete.name })}
          okLabel={t('modelRouting.delete.ok')}
          cancelLabel={t('modelRouting.delete.cancel')}
          onOk={() => void handleDelete()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

export default SectionModelRoutingPlans;
