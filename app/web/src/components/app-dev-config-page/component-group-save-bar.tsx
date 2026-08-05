/**
 * component-group-save-bar — 单个 group 的独立保存条
 * 参考: specs/ui/components/app-dev-config-page/component-group-save-bar.md
 *       specs/prd/overall/04-config-center-ui.md UC-3.9.2.4（保存条恢复干净态）
 *
 * 职责：仅对当前渲染的 group 生效，点保存触发 onSave（page 收到后整组提交）。
 * 视觉态机：dirty（有未保存改动）→ saving（保存中，禁用）→ saved（已保存反馈，短暂）→ 干净。
 *   - dirty=true：按钮高亮 + 「●」标记 + 「有未保存的改动」提示
 *   - saving=true：按钮禁用 + 文案「保存中…」
 *   - saved=true：按钮旁短暂显示「✓ 已保存」（sage 色），1.5s 后由 page 清态恢复干净
 *
 * 布局稳定性（PRD §3.9.1 原则 8）：dirty 提示 + saved 反馈均通过 opacity 显隐（保留占位），
 * 状态切换不导致按钮位移。
 *
 * [v0.0.62 i18n] 三态文案走 common.saveBar.{dirty, saving, save} + common.status.saved（dedup）
 */
import { useTranslation } from 'react-i18next';

interface ComponentGroupSaveBarProps {
  /** 当前 group id（testid 拼接用） */
  groupId: string;
  /** 该 group 是否有未保存改动 */
  dirty: boolean;
  /** 该 group 是否正在保存中 */
  saving: boolean;
  /** 最近一次保存成功的短暂反馈标志（page 维护：保存成功置 true，~1.5s 后清 false） */
  saved?: boolean;
  /** 点保存触发（page 内部 PUT 整组） */
  onSave: () => void;
}

/** group 独立保存条 */
export function ComponentGroupSaveBar({
  groupId,
  dirty,
  saving,
  saved = false,
  onSave,
}: ComponentGroupSaveBarProps) {
  // [v0.0.62 i18n] saveBar 文案走 common ns
  const { t } = useTranslation('common');
  // saved 反馈仅在「非 dirty 且非 saving」时可见（保存刚完成、尚未再编辑的窗口期）
  const showSaved = saved && !dirty && !saving;
  return (
    <div

      className="border-t border-border p-3 flex justify-end items-center gap-2 bg-surface"
    >
      {/* 已保存反馈（BUG-011）：sage 色短暂勾标记，opacity 显隐保留占位（不位移按钮） */}
      <span

        aria-hidden={!showSaved ? 'true' : 'false'}
        className={
          'text-xs transition-opacity ' +
          (showSaved ? 'opacity-100 text-emerald-600' : 'opacity-0')
        }
      >
        ✓ {t('status.saved')}
      </span>
      {/* 脏态提示：opacity 显隐保留占位（不位移按钮），aria-hidden 给读屏避让 */}
      <span
        aria-hidden={!dirty || saving ? 'true' : 'false'}
        className={
          'text-muted text-xs transition-opacity ' +
          (dirty && !saving ? 'opacity-100' : 'opacity-0')
        }
      >
        {t('saveBar.dirty')}
      </span>
      <button
        type="button"
        data-action-key="settings.group.save"
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

export default ComponentGroupSaveBar;
