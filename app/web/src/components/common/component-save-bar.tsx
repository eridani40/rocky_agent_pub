/**
 * component-save-bar — 通用保存条（sticky bottom）
 * 参考: specs/ui/components/app-dev-config-page/component-tab-save-bar.md
 *       specs/tech/version_logs/v0.0.317/change_plan.md D1（改名 + variant prop）
 *
 * 职责：页面/面板底部 sticky 保存条（dirty/saving/saved/cancel 状态展示 + 保存/取消按钮）。
 * v0.0.317: 从 component-tab-save-bar.tsx 迁移并升级——改名 SaveBar + 新增 variant prop。
 *
 * variant：
 *   'tab'（缺省）：action-key 后缀 .tab.save / .tab.cancel（既有行为，向后兼容）
 *   'detail'：action-key 后缀 .detail.save / .detail.cancel
 *
 * 布局稳定性（MANDATORY）：取消按钮用 visibility:hidden 预留空间（非 display:none），
 * 避免 dirty 切换时按钮位移。
 *
 * 边界：不直接调 API（onSave/onCancel 上抛父级）。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface SaveBarProps {
  /** 当前是否有未保存改动 */
  dirty: boolean;
  /** 是否正在保存 */
  saving: boolean;
  /** 最近一次保存成功的短暂反馈标志（父级维护：保存成功置 true，~1.5s 后清） */
  saved?: boolean;
  /** 点保存 → 父级提交 */
  onSave: () => void;
  /** 点取消 → 父级重置 draft 到 snapshot */
  onCancel: () => void;
  /** action-key 后缀模式：'tab'（缺省）= settings.tab.save/cancel；'detail' = settings.detail.save/cancel */
  variant?: 'tab' | 'detail';
  /** [可选] 测试锚点 data-testid（不传 = 无 testid，既有消费方零影响） */
  saveTestId?: string;
  /** [可选] 测试锚点 data-testid（同上） */
  cancelTestId?: string;
  /** [v0.0.349][可选] 尾部插槽（渲染在保存按钮右端；如详情页 danger 删除按钮）。缺省不渲染，既有消费方零影响 */
  trailing?: ReactNode;
}

/** 通用保存条（sticky bottom） */
export function SaveBar({ dirty, saving, saved = false, onSave, onCancel, variant = 'tab', saveTestId, cancelTestId, trailing }: SaveBarProps) {
  const { t } = useTranslation('common');
  // saved 反馈仅在「非 dirty 且非 saving」时可见
  const showSaved = saved && !dirty && !saving;
  const statusText = showSaved
    ? `✓ ${t('status.saved')}`
    : dirty
      ? `● ${t('saveBar.dirty')}`
      : `✓ ${t('status.saved')}`;

  // action-key 按 variant 选择后缀
  const suffix = variant === 'detail' ? 'detail' : 'tab';
  const saveActionKey = `settings.${suffix}.save`;
  const cancelActionKey = `settings.${suffix}.cancel`;

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
        data-testid={cancelTestId}
        data-action-key={cancelActionKey}
        onClick={onCancel}
        disabled={saving || !dirty}
        style={{ visibility: dirty && !saving ? 'visible' : 'hidden' }}
        className="min-w-24 px-4 py-1.5 rounded-md text-sm transition-colors border border-border text-fg-2 hover:bg-bg-warm disabled:cursor-not-allowed"
      >
        {t('saveBar.cancel')}
      </button>
      <button
        type="button"
        data-testid={saveTestId}
        data-action-key={saveActionKey}
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
      {/* [v0.0.349] 尾部插槽（保存按钮右端；缺省不渲染，既有消费方零影响） */}
      {trailing}
    </div>
  );
}

/** 向后兼容 alias（下版本删） */
export { SaveBar as TabSaveBar };

export default SaveBar;
