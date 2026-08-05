/**
 * component-tab-save-bar — page-tab 级保存条（v0.0.89 新增）
 * 参考: specs/ui/components/app-dev-config-page/component-tab-save-bar.md
 *       reqs/[working] v0.0.89.ui_opt/demo.html（底部 sticky save bar）
 *
 * 职责：应用设置页底部 sticky 保存条（page-tab 级保存/取消）。
 *   当前 tab 内任一 KV group 有改动 → dirty 高亮保存 + 显示取消；
 *   保存 = 当前 tab 全部 dirty group 原子提交；取消 = 重置 draft 到 snapshot。
 *
 * 布局稳定性（MANDATORY）：取消按钮用 visibility:hidden 预留空间（非 display:none），
 * 避免 dirty 切换时按钮位移（CLAUDE.md 布局稳定性硬约束）。
 *
 * 边界：不进 provider 编辑器 / observability 的 dirty（例外，独立 save 流）；
 *   不直接调 API（onSave/onCancel 上抛父级）；单文件 ≤ 100 行。
 */
import { useTranslation } from 'react-i18next';

interface TabSaveBarProps {
  /** 当前 tab 是否有未保存改动（tab 内任一 KV group dirty） */
  dirty: boolean;
  /** 是否正在保存 */
  saving: boolean;
  /** 最近一次保存成功的短暂反馈标志（page 维护：保存成功置 true，~1.5s 后清） */
  saved?: boolean;
  /** 点保存 → 父级提交当前 tab 全部 dirty group */
  onSave: () => void;
  /** 点取消 → 父级重置 draft 到 snapshot */
  onCancel: () => void;
}

/** page-tab 级保存条（sticky bottom） */
export function TabSaveBar({ dirty, saving, saved = false, onSave, onCancel }: TabSaveBarProps) {
  const { t } = useTranslation('common');
  // saved 反馈仅在「非 dirty 且非 saving」时可见
  const showSaved = saved && !dirty && !saving;
  const statusText = showSaved
    ? `✓ ${t('status.saved')}`
    : dirty
      ? `● ${t('saveBar.dirty')}`
      : `✓ ${t('status.saved')}`;

  return (
    <div

      className="sticky bottom-0 border-t border-border p-3 flex justify-end items-center gap-2 bg-surface"
    >
      <span

        data-dirty={dirty ? 'true' : 'false'}
        className={
          'text-xs transition-colors ' +
          (dirty ? 'text-accent' : 'text-muted')
        }
      >
        {statusText}
      </span>
      {/* 取消按钮：dirty 时可见，否则 visibility:hidden 预留空间（禁 display:none 避免位移） */}
      <button
        type="button"
        data-action-key="settings.tab.cancel"
        onClick={onCancel}
        disabled={saving || !dirty}
        style={{ visibility: dirty && !saving ? 'visible' : 'hidden' }}
        className="min-w-24 px-4 py-1.5 rounded-md text-sm transition-colors border border-border text-fg-2 hover:bg-bg-warm disabled:cursor-not-allowed"
      >
        {t('saveBar.cancel')}
      </button>
      <button
        type="button"
        data-action-key="settings.tab.save"
        disabled={saving}
        onClick={onSave}
        className={
          'min-w-24 px-4 py-1.5 rounded-md text-sm transition-colors ' +
          (dirty && !saving
            ? 'bg-accent text-white hover:opacity-90'
            : 'border border-border text-fg-2 hover:bg-bg-warm') +
          (saving ? ' opacity-60 cursor-not-allowed' : '')
        }
      >
        {saving ? t('saveBar.saving') : dirty ? `● ${t('saveBar.save')}` : t('saveBar.save')}
      </button>
    </div>
  );
}

export default TabSaveBar;
