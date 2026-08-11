/**
 * section-observability — 可观测性配置区（list/detail 二级视图路由 + 数据装载）
 * 参考: specs/ui/components/app-dev-config-page/observability-config/_overview.md §3
 *
 * 职责：dev config 页 observability group 的右侧配置区。内部二级视图：
 *   - list（默认）：渲染 section-observability-list
 *   - detail：点列表项 / 点「添加配置」→ 渲染 section-observability-detail
 * 数据：挂载 GET /config/app?group=runtime&key=observability → ObservabilityConfig[] | null；
 *   toggle/保存/删除 → PUT /config/app（整列表提交，SecretInput 编辑态明文回传）。
 * 边界：不直接渲染 key-card（observability 是 list-of-objects，非普通 KV group）。
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SectionObservabilityList } from './section-observability-list';
import { SectionObservabilityDetail } from './section-observability-detail';
import {
  emptyObservabilityDraft,
  generateObsId,
  isObservabilityDirty,
  isObservabilityValid,
  type ObservabilityConfig,
} from './types';
import {
  getObservabilityConfigs,
  putObservabilityConfigs,
} from '../../../lib/observability-api';
import type { SectionSaveHandle } from '../use-tab-dirty-aggregator';

/** detail 视图态：null=list，否则持有当前编辑的 id（'new' 表示新增） */
type DetailState = { mode: 'new'; draft: ObservabilityConfig } | { mode: 'edit'; id: string } | null;

interface SectionObservabilityProps {
  /**
   * detail 视图态变化上报（同步触发，无 useEffect 延迟）。
   * 父级（tab-panel）据此隐藏 observability tab 内的其他 group（如 logs），
   * 让 detail 视图独占 tab 内容区。
   */
  onDetailViewChange?: (inDetail: boolean) => void;
  /** [v0.0.316-fix] dirty 变化上报（tab aggregator 注入，驱动 save bar 亮） */
  onDirtyChange?: (dirty: boolean) => void;
}

/**
 * 可观测性配置区（list/detail 路由）。
 * [v0.0.316] forwardRef + useImperativeHandle 暴露 { isDirty, save, reset } 给 tab 级 aggregator。
 * [v0.0.317] list toggle 也进 dirty（不再即时 PUT）。
 *   - detail save 从即时改攒 draft（D5）：detail 编辑的 draft 不立即 PUT，攒在 detailDraft state
 *   - list toggle 攒入 listDraft（v0.0.317）：toggle 不再即时 PUT，走 SaveBar 统一保存
 *   - list delete 保留即时（确定性操作即时反馈合理）
 *   - isDirty = detailDraft 有未保存改动 OR listDraft 有未保存 toggle 改动
 *   - save = 提交 detailDraft（合并入 configs 并 PUT）+ 提交 listDraft（如有）+ 退出 detail
 *   - reset = detailDraft 回 baseline + listDraft 清除
 */
export const SectionObservability = forwardRef<SectionSaveHandle, SectionObservabilityProps>(
  function SectionObservability({ onDetailViewChange, onDirtyChange }, ref) {
  const [configs, setConfigs] = useState<ObservabilityConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>(null);
  /**
   * [v0.0.316] detail draft 攒存（D5）：detail 视图编辑的 draft 不立即 PUT，
   * 攒在此 state 供 tab 级 aggregator 的 isDirty/save/reset 消费。
   * null = 无 detail 或 detail 无改动；非 null = 有未保存的 detail draft。
   */
  const [detailDraft, setDetailDraft] = useState<ObservabilityConfig | null>(null);
  /**
   * [v0.0.317] list toggle draft 攒存：list 页 toggle 不再即时 PUT，
   * 攒在此 state 供 tab 级 aggregator 的 isDirty/save/reset 消费。
   * null = 无 toggle 改动；非 null = 含未保存 toggle 改动的 configs 副本。
   */
  const [listDraft, setListDraft] = useState<ObservabilityConfig[] | null>(null);

  /**
   * 统一的 detail 态切换入口：setDetail + 同步上报 onDetailViewChange。
   * 同步在同事件处理器内完成（React 批处理），避免 useEffect 一帧延迟导致的 logs group 闪烁。
   */
  const updateDetail = useCallback((next: DetailState) => {
    setDetail(next);
    setDetailDraft(null);
    onDetailViewChange?.(next != null);
  }, [onDetailViewChange]);
  // [v0.0.62 i18n] observability 加载/重试文案走 app-dev-config ns
  const { t } = useTranslation('app-dev-config');

  // 挂载 GET
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getObservabilityConfigs();
      setConfigs(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    reload().then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  /** 整列表 PUT（落库）。SaveBar 保存 + 删除走此路径。 */
  const persist = useCallback(async (next: ObservabilityConfig[]) => {
    setError(null);
    try {
      await putObservabilityConfigs(next);
      setConfigs(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // 落库失败时 reload 以同步后端真实状态
      await reload();
    }
  }, [reload]);

  /** [v0.0.317] toggle 进 dirty（不再即时 PUT）：把 toggle 变化攒入 listDraft state */
  const handleToggle = useCallback((id: string, enabled: boolean) => {
    setListDraft((prev) => {
      const base = prev ?? configs;
      const next = base.map((c) => (c.id === id ? { ...c, enabled } : c));
      // 如果 toggle 后和 configs 完全一致（用户 toggle 又 toggle 回来），清除 listDraft → 不 dirty
      const changed = next.some((c, i) => {
        const orig = configs[i];
        return orig && c.enabled !== orig.enabled;
      });
      return changed ? next : null;
    });
  }, [configs]);

  /** 删除（modal 确认后） */
  const handleDelete = useCallback((id: string) => {
    setConfigs((prev) => {
      const next = prev.filter((c) => c.id !== id);
      void persist(next);
      return next;
    });
  }, [persist]);

  /** 进 detail（编辑现有项） */
  const handleSelect = useCallback((id: string) => {
    updateDetail({ mode: 'edit', id });
  }, [updateDetail]);

  /** 进 detail（新增） */
  const handleAdd = useCallback(() => {
    updateDetail({ mode: 'new', draft: emptyObservabilityDraft(generateObsId()) });
  }, [updateDetail]);

  /**
   * [v0.0.316] detail draft 变化回调（D5）：detail 视图编辑时把 draft 攒入 detailDraft state。
   * 替代原 handleSave 即时 PUT——现在 save 由 tab 级 aggregator 触发。
   */
  const handleDetailChange = useCallback((data: ObservabilityConfig) => {
    setDetailDraft(data);
  }, []);

  /** detail 视图的 baseline（dirty 判定对比源） */
  const detailBaseline = detail?.mode === 'edit'
    ? (configs.find((c) => c.id === detail.id) ?? null)
    : detail?.mode === 'new' ? (detail.draft ?? null) : null;

  /** [v0.0.317] list toggle 是否有未保存改动（listDraft 与 configs 的 enabled 不一致） */
  const listDraftDirty = useCallback(() => {
    if (!listDraft) return false;
    return listDraft.some((c, i) => configs[i] && c.enabled !== configs[i].enabled);
  }, [listDraft, configs]);

  /** tab 级 isDirty：detail draft 有未保存改动 OR list toggle 有未保存改动 */
  const isDirtyFn = useCallback(() => {
    if (detailDraft && detailBaseline && isObservabilityDirty(detailDraft, detailBaseline)) return true;
    return listDraftDirty();
  }, [detailDraft, detailBaseline, listDraftDirty]);

  /**
   * [v0.0.317] tab 级 save：提交 detailDraft（如有）+ listDraft（如有 toggle 改动）。
   * detail draft 先合并入 configs，再叠加 listDraft 的 toggle 改动，最后一次 PUT。
   */
  const saveFn = useCallback(async () => {
    let nextConfigs = configs;

    // 1. 提交 detailDraft（如有）
    if (detailDraft && isObservabilityValid(detailDraft)) {
      const exists = nextConfigs.some((c) => c.id === detailDraft.id);
      nextConfigs = exists
        ? nextConfigs.map((c) => (c.id === detailDraft.id ? detailDraft : c))
        : [...nextConfigs, detailDraft];
      setDetailDraft(null);
      setDetail(null);
      onDetailViewChange?.(false);
    }

    // 2. 提交 listDraft（如有 toggle 改动）——在 detail 合并后的基础上叠加
    if (listDraft) {
      // 用 nextConfigs 做 id 对齐合并：listDraft 只改 enabled，其他字段以 nextConfigs 为准
      nextConfigs = nextConfigs.map((c) => {
        const draft = listDraft.find((d) => d.id === c.id);
        return draft ? { ...c, enabled: draft.enabled } : c;
      });
      setListDraft(null);
    }

    // 3. 如果有变化才 PUT
    if (detailDraft || listDraft) {
      void persist(nextConfigs);
    }
  }, [detailDraft, listDraft, configs, persist, onDetailViewChange]);

  /** [v0.0.317] tab 级 reset：detailDraft 回 baseline + listDraft 清除 */
  const resetFn = useCallback(() => {
    if (detailBaseline) {
      setDetailDraft({ ...detailBaseline });
    }
    setListDraft(null);
  }, [detailBaseline]);

  /** [v0.0.316-fix] dirty 变化上报 page（声明式通知，驱动 save bar 亮） */
  useEffect(() => {
    onDirtyChange?.(isDirtyFn());
  }, [isDirtyFn, onDirtyChange]);

  /** [v0.0.316-fix] 暴露 save/reset 给 tab 级 aggregator（dirty 走 onDirtyChange 上报） */
  useImperativeHandle(ref, () => ({
    save: saveFn,
    reset: resetFn,
  }), [saveFn, resetFn]);

  if (detail) {
    // detail 视图：编辑态从 configs 取，新增态用 detail.draft
    // [v0.0.316] detailDraft 优先（编辑中），否则用 initial（刚进 detail）
    const initial = detailDraft ?? (detail.mode === 'edit'
      ? (configs.find((c) => c.id === detail.id) ?? emptyObservabilityDraft(detail.id))
      : detail.draft);
    return (
      <SectionObservabilityDetail
        initialData={initial}
        isNew={detail.mode === 'new'}
        onBack={() => updateDetail(null)}
        onDraftChange={handleDetailChange}
      />
    );
  }

  if (loading) {
    return <div className="p-8 text-muted text-sm">{t('observability.loading')}</div>;
  }
  if (error) {
    return (
      <div className="p-8">
        <div role="alert" className="text-sm text-accent">{error}</div>
        <button type="button" onClick={() => void reload()} className="mt-3 text-xs underline text-accent">
          {t('observability.retry')}
        </button>
      </div>
    );
  }

  return (
    <SectionObservabilityList
      configs={listDraft ?? configs}
      onSelect={handleSelect}
      onAdd={handleAdd}
      onToggle={handleToggle}
      onDelete={handleDelete}
    />
  );
});

export default SectionObservability;
