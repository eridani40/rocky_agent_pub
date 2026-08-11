/**
 * section-config-sync — 配置同步 tab 根组件（landing/export/import 三态）。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D6
 *      specs/prd/v0.0.318-config-sync.md §2.2 §2.3
 *
 * 即时操作页（不走 SaveBar）：
 *   landing（导出/导入入口）→ export（树形选择 + 导出下载）→ import（文件选择 → 树形选择 + 导入执行）。
 */

import { type ReactNode, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ExportView } from './section-config-sync-export';
import { ImportView } from './section-config-sync-import';
import type { ViewMode, ToastState } from './section-config-sync-types';

/** 配置同步 tab 根组件 */
export function SectionConfigSync(): ReactNode {
  const { t } = useTranslation('app-dev-config');

  const [view, setView] = useState<ViewMode>('landing');
  const [toast, setToast] = useState<ToastState | null>(null);

  // 自动消失 toast
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <div data-testid="section-config-sync">
      {toast && (
        <div
          role="status"
          className={`mb-4 px-4 py-2 rounded-md text-[13px] ${
            toast.kind === 'success'
              ? 'bg-green-500/15 text-green-600'
              : 'bg-red-500/15 text-red-600'
          }`}
        >
          {toast.message}
        </div>
      )}

      {view === 'landing' && (
        <LandingView
          onExport={() => setView('export')}
          onImport={() => setView('import')}
        />
      )}

      {view === 'export' && (
        <ExportView
          onBack={() => setView('landing')}
          onToast={setToast}
        />
      )}

      {view === 'import' && (
        <ImportView
          onBack={() => setView('landing')}
          onToast={setToast}
          onImported={() => setView('landing')}
        />
      )}
    </div>
  );
}

/** Landing 态：导出/导入入口按钮 */
function LandingView({ onExport, onImport }: {
  onExport: () => void;
  onImport: () => void;
}): ReactNode {
  const { t } = useTranslation('app-dev-config');
  return (
    <div className="flex flex-col gap-4 mt-2">
      <button
        type="button"
        onClick={onExport}
        data-testid="config-sync-export-btn"
        className="flex flex-col items-start gap-1 px-5 py-4 rounded-lg border border-border hover:border-accent hover:bg-bg-warm transition-colors text-left"
      >
        <span className="text-[15px] font-semibold text-fg">{t('config_sync.export.title')}</span>
        <span className="text-[12px] text-muted">{t('config_sync.export.desc')}</span>
      </button>
      <button
        type="button"
        onClick={onImport}
        data-testid="config-sync-import-btn"
        className="flex flex-col items-start gap-1 px-5 py-4 rounded-lg border border-border hover:border-accent hover:bg-bg-warm transition-colors text-left"
      >
        <span className="text-[15px] font-semibold text-fg">{t('config_sync.import.title')}</span>
        <span className="text-[12px] text-muted">{t('config_sync.import.desc')}</span>
      </button>
    </div>
  );
}
