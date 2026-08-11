/**
 * section-config-sync-export — 配置同步导出视图。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D6
 *      specs/prd/v0.0.318-config-sync.md §2.2
 *
 * 挂载时 GET /provider → ConfigTree(mode='export') 默认全选 → 点导出 → 下载。
 */

import { type ReactNode, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigTree, type SelectionState } from './component-config-tree';
import { collectExportData, triggerDownload, TOOL_TAB_IDS } from '../../lib/config-sync-export';
import { loadProvidersAndProtocols } from '../../lib/api-client';
import { buildSelectAll, type ToastState } from './section-config-sync-types';

/** 导出视图：挂载数据 + 树形选择 + 导出按钮 */
export function ExportView({ onBack, onToast }: {
  onBack: () => void;
  onToast: (toast: ToastState) => void;
}): ReactNode {
  const { t } = useTranslation('app-dev-config');
  const [providers, setProviders] = useState<{ label: string; protocolId?: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<SelectionState>({ providers: new Set(), tools: new Set() });

  // 挂载时 GET /provider
  useEffect(() => {
    (async () => {
      try {
        const { items } = await loadProvidersAndProtocols();
        const labels = items.map((p) => ({ label: p.label, protocolId: p.protocolId }));
        setProviders(labels);
        setSelected(buildSelectAll(labels.map((l) => l.label), [...TOOL_TAB_IDS]));
      } catch {
        onToast({ kind: 'error', message: t('config_sync.export.load_failed') });
      } finally {
        setLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasSelection = selected.providers.size > 0 || selected.tools.size > 0;

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const data = await collectExportData(selected);
      await triggerDownload(data);
      onToast({
        kind: 'success',
        message: t('config_sync.export.success', {
          providerCount: data.providers.length,
          toolCount: Object.keys(data.tools).length,
        }),
      });
    } catch {
      onToast({ kind: 'error', message: t('config_sync.export.failed') });
    } finally {
      setExporting(false);
    }
  }, [selected, onToast, t]);

  if (loading) return <div className="text-[13px] text-muted py-4">{t('config_sync.loading')}</div>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-semibold text-fg">{t('config_sync.export.title')}</h3>
        <button type="button" onClick={onBack} className="text-[13px] text-muted hover:text-fg-2">
          {t('config_sync.back')}
        </button>
      </div>

      <ConfigTree
        mode="export"
        providers={providers}
        tools={[...TOOL_TAB_IDS]}
        selected={selected}
        onSelectionChange={setSelected}
      />

      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={handleExport}
          disabled={!hasSelection || exporting}
          data-testid="config-sync-do-export"
          className="px-5 py-2 rounded-md text-sm bg-accent text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {exporting ? t('config_sync.export.exporting') : t('config_sync.export.do_export')}
        </button>
      </div>
    </div>
  );
}
