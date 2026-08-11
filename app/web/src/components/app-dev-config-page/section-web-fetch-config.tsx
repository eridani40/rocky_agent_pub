/**
 * section-web-fetch-config — 应用设置 → 工具 tab → 网络抓取 自渲染 section（v0.0.121 新增）
 * 参考: specs/ui/components/app-dev-config-page/section-web-fetch-config/_overview.md
 *       specs/api/overall/08-web-tools.md §5（app_config web group + jinaApiKey redact/merge）
 *       specs/api/overall/03-config-center.md §2.2（单 key PUT 语义）
 *
 * 职责：
 *   - 挂载 GET `/config/app?group=web` 整组取 jinaApiKey baseline（GET 明文真值）
 *   - 渲染唯一字段 jinaApiKey（SecretInput，展示 mask 态）
 *   - saveMode='item'：自管 save/reset 按钮，单 key PUT `{group:'web', key:'jinaApiKey', data}`
 *     （选单 key 而非整组 items[]，避免误覆盖 jinaEnabled/jinaTimeoutMs 等同组其他 key）
 *
 * PUT 占位 merge 契约（与后端对齐，向后兼容旧前端）：
 *   - data='***'（占位/旧前端未改）→ 后端保留原值（merge）
 *   - data=真值 → 后端落盘覆盖（当前前端 draft 是真值，未改时送真值，幂等覆盖无害）
 *
 * 边界：
 *   - 不做 jinaEnabled/jinaTimeoutMs UI（范围纪律，req 只要 key 字段）
 *   - 不消费 useAppSettingsConfig（自渲染，与 providers/observability 同范式）
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState, type ForwardedRef } from 'react';
import { useTranslation } from 'react-i18next';
import { req } from '../../lib/api-client';
import { SecretInput } from '../framework/primitives/secret-input';
import type { SectionSaveHandle } from './use-tab-dirty-aggregator';

/** GET /config/app?group=web → items[] 单条形状 */
interface WebGroupItem {
  key: string;
  data: string;
}

/** 从 GET 整组响应中提取 jinaApiKey 的值；缺失（从未配置）返 '' */
function extractJinaApiKey(items: WebGroupItem[]): string {
  return items.find((item) => item.key === 'jinaApiKey')?.data ?? '';
}

/** [v0.0.316-fix] section props：onDirtyChange 上报 dirty 变化给 tab aggregator */
interface SectionWebFetchConfigProps {
  onDirtyChange?: (dirty: boolean) => void;
}

/** 网络抓取自渲染 section（forwardRef 暴露 save/reset 给 tab 级 aggregator） */
export const SectionWebFetchConfig = forwardRef<SectionSaveHandle, SectionWebFetchConfigProps>(function SectionWebFetchConfig({ onDirtyChange }, ref: ForwardedRef<SectionSaveHandle>) {
  const { t } = useTranslation('app-dev-config');

  /** 服务端基线值（GET 明文真值或 ''，从未配置时为 ''） */
  const [baseline, setBaseline] = useState<string>('');
  /** 当前草稿值 */
  const [draft, setDraft] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** 挂载：GET /config/app?group=web 整组，取 jinaApiKey */
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await req<{ items: WebGroupItem[] }>('/config/app?group=web');
      const value = extractJinaApiKey(res.items ?? []);
      setBaseline(value);
      setDraft(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** dirty：draft 与 baseline 字符串比较 */
  const dirty = draft !== baseline;

  /** SecretInput onCommit：更新 draft → dirty 判定 */
  const handleKeyCommit = (next: string) => {
    setDraft(next);
  };

  /**
   * 保存：单 key PUT（选单 key 不选整组，避免误覆盖同组 jinaEnabled/jinaTimeoutMs）
   * 当前前端 draft 是真值，未改时送真值（幂等覆盖无害）；data='***' 占位后端也兼容（merge 回原值）。
   */
  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      await req<{ ok: true }>('/config/app', {
        method: 'PUT',
        body: JSON.stringify({ group: 'web', key: 'jinaApiKey', data: draft }),
      });
      setBaseline(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await reload();
    } finally {
      setSaving(false);
    }
  };

  /** 重置：draft 回 baseline */
  const handleReset = () => {
    setDraft(baseline);
  };

  /** [v0.0.316-fix] dirty 变化上报 page（声明式通知，驱动 save bar 亮） */
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  /** [v0.0.316-fix] 暴露 save/reset 给 tab 级 aggregator（dirty 走 onDirtyChange 上报） */
  useImperativeHandle(ref, () => ({
    save: handleSave,
    reset: handleReset,
  }), [handleSave, handleReset]);

  if (loading) {
    return (
      <div className="p-8 text-muted text-sm">
        {t('observability.loading')}
      </div>
    );
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
    <div className="flex flex-col gap-3">
      {/* 顶部描述（对齐 section-web-search-config：text-[11px] text-muted font-mono mt-0.5） */}
      <div>
        <p className="text-[11px] text-muted font-mono mt-0.5">
          {t('webFetch.sectionDesc')}
        </p>
      </div>

      {/* jinaApiKey 字段（唯一字段） */}
      <div className="flex flex-col gap-1">
        <span className="text-xs text-fg-2 font-medium">
          {t('webFetch.jinaApiKeyLabel')}
        </span>
        <SecretInput
          value={draft}
          onCommit={handleKeyCommit}

          placeholder="jina_api_key_..."
        />
        <span className="text-[11px] text-muted">
          {t('webFetch.jinaApiKeyDesc')}
        </span>
      </div>
    </div>
  );
});

export default SectionWebFetchConfig;
