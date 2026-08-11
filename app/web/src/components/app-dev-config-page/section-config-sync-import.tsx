/**
 * section-config-sync-import — 配置同步导入视图。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D6
 *      specs/prd/v0.0.318-config-sync.md §2.3
 *
 * 文件选择 → 解密解析 → ConfigTree(mode='import') + 重名标签 → 确认 modal → 执行导入。
 */

import { type ReactNode, useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfigTree, type SelectionState } from './component-config-tree';
import { ConfirmModal } from '../common/component-confirm-modal';
import { TOOL_TAB_IDS } from '../../lib/config-sync-export';
import {
  parseImportFile,
  checkDuplicateLabels,
  executeImport,
  getLocalProviders,
} from '../../lib/config-sync-import';
import type { ConfigExportData, ProviderExportItem } from '../../lib/config-crypto';
import { buildSelectAll, type ToastState } from './section-config-sync-types';

/** 导入视图：文件选择 → 树形选择 + 导入执行 */
export function ImportView({ onBack, onToast, onImported }: {
  onBack: () => void;
  onToast: (toast: ToastState) => void;
  onImported: () => void;
}): ReactNode {
  const { t } = useTranslation('app-dev-config');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsedData, setParsedData] = useState<ConfigExportData | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [duplicateLabels, setDuplicateLabels] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<SelectionState>({ providers: new Set(), tools: new Set() });
  const [importing, setImporting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // 打开时自动触发文件选择
  useEffect(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(null);
    try {
      const data = await parseImportFile(file);
      const localProviders = await getLocalProviders();
      const dupLabels = checkDuplicateLabels(data.providers, localProviders);
      setParsedData(data);
      setDuplicateLabels(dupLabels);
      setSelected(buildSelectAll(
        data.providers.map((p) => p.label),
        Object.keys(data.tools).filter((k) => (TOOL_TAB_IDS as readonly string[]).includes(k)),
      ));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : t('config_sync.import.parse_failed'));
    }
  }, [t]);

  const hasSelection = selected.providers.size > 0 || selected.tools.size > 0;

  const handleImportClick = useCallback(() => {
    setShowConfirm(true);
  }, []);

  const handleConfirmImport = useCallback(async () => {
    if (!parsedData) return;
    setShowConfirm(false);
    setImporting(true);
    try {
      const result = await executeImport(parsedData, selected);
      onToast({
        kind: 'success',
        message: t('config_sync.import.success', {
          providerCount: result.providersImported,
          toolCount: result.toolsImported,
        }),
      });
      onImported();
    } catch {
      onToast({ kind: 'error', message: t('config_sync.import.failed') });
    } finally {
      setImporting(false);
    }
  }, [parsedData, selected, onToast, onImported, t]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[15px] font-semibold text-fg">{t('config_sync.import.title')}</h3>
        <button type="button" onClick={onBack} className="text-[13px] text-muted hover:text-fg-2">
          {t('config_sync.back')}
        </button>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileSelect}
        className="hidden"
        data-testid="config-sync-file-input"
      />

      {parseError && (
        <div className="px-4 py-3 rounded-md bg-red-500/10 text-red-600 text-[13px]" data-testid="config-sync-parse-error">
          {parseError}
        </div>
      )}

      {(parseError || parsedData) && (
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="self-start text-[13px] text-accent hover:underline"
        >
          {t('config_sync.import.reselect')}
        </button>
      )}

      {parsedData && !parseError && (
        <>
          <ConfigTree
            mode="import"
            providers={(parsedData.providers as ProviderExportItem[]).map((p) => ({
              label: p.label,
              protocolId: p.protocolId,
            }))}
            tools={Object.keys(parsedData.tools).filter((k) => (TOOL_TAB_IDS as readonly string[]).includes(k))}
            duplicateLabels={duplicateLabels}
            selected={selected}
            onSelectionChange={setSelected}
          />

          <div className="flex justify-end pt-2">
            <button
              type="button"
              onClick={handleImportClick}
              disabled={!hasSelection || importing}
              data-testid="config-sync-do-import"
              className="px-5 py-2 rounded-md text-sm bg-accent text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {importing ? t('config_sync.import.importing') : t('config_sync.import.do_import')}
            </button>
          </div>
        </>
      )}

      {showConfirm && (
        <ConfirmModal
          title={t('config_sync.import.confirm_title')}
          body={t('config_sync.import.confirm_body', {
            providerCount: selected.providers.size,
            toolCount: selected.tools.size,
          })}
          okLabel={t('config_sync.import.confirm_ok')}
          cancelLabel={t('config_sync.import.confirm_cancel')}
          onOk={handleConfirmImport}
          onCancel={() => setShowConfirm(false)}
        />
      )}
    </div>
  );
}
