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
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SectionObservabilityList } from './section-observability-list';
import { SectionObservabilityDetail } from './section-observability-detail';
import {
  emptyObservabilityDraft,
  generateObsId,
  type ObservabilityConfig,
} from './types';
import {
  getObservabilityConfigs,
  putObservabilityConfigs,
} from '../../../lib/observability-api';

/** detail 视图态：null=list，否则持有当前编辑的 id（'new' 表示新增） */
type DetailState = { mode: 'new'; draft: ObservabilityConfig } | { mode: 'edit'; id: string } | null;

interface SectionObservabilityProps {
  /**
   * detail 视图态变化上报（同步触发，无 useEffect 延迟）。
   * 父级（tab-panel）据此隐藏 observability tab 内的其他 group（如 logs），
   * 让 detail 视图独占 tab 内容区。
   */
  onDetailViewChange?: (inDetail: boolean) => void;
}

/** 可观测性配置区（list/detail 路由） */
export function SectionObservability({ onDetailViewChange }: SectionObservabilityProps = {}) {
  const [configs, setConfigs] = useState<ObservabilityConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>(null);

  /**
   * 统一的 detail 态切换入口：setDetail + 同步上报 onDetailViewChange。
   * 同步在同事件处理器内完成（React 批处理），避免 useEffect 一帧延迟导致的 logs group 闪烁。
   */
  const updateDetail = useCallback((next: DetailState) => {
    setDetail(next);
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

  /** 整列表 PUT（落库）。保存/启停/删除均走此路径。 */
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

  /** toggle 即时（不计 dirty）：本地 + 后端同步 */
  const handleToggle = useCallback((id: string, enabled: boolean) => {
    setConfigs((prev) => {
      const next = prev.map((c) => (c.id === id ? { ...c, enabled } : c));
      void persist(next);
      return next;
    });
  }, [persist]);

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

  /** 保存 detail（新增 / 编辑）：合并入 configs 并 PUT */
  const handleSave = useCallback((data: ObservabilityConfig) => {
    setConfigs((prev) => {
      const exists = prev.some((c) => c.id === data.id);
      const next = exists
        ? prev.map((c) => (c.id === data.id ? data : c))
        : [...prev, data];
      void persist(next);
      return next;
    });
    updateDetail(null);
  }, [persist, updateDetail]);

  if (detail) {
    // detail 视图：编辑态从 configs 取，新增态用 detail.draft
    const initial = detail.mode === 'edit'
      ? (configs.find((c) => c.id === detail.id) ?? emptyObservabilityDraft(detail.id))
      : detail.draft;
    return (
      <SectionObservabilityDetail
        initialData={initial}
        isNew={detail.mode === 'new'}
        onBack={() => updateDetail(null)}
        onSave={handleSave}
        onToggle={handleToggle}
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
      configs={configs}
      onSelect={handleSelect}
      onAdd={handleAdd}
      onToggle={handleToggle}
      onDelete={handleDelete}
    />
  );
}

export default SectionObservability;
