/**
 * component-preview-floating-actions —— 预览区正文区悬浮操作胶囊容器（v0.0.323 改造）
 *
 * 位置：正文区（viewer/editor 内容区）最右侧、偏上。
 * 显隐：常驻显示（不再依赖父级 group-hover）——胶囊容器自带背景/边框/阴影。
 *
 * 容器样式：对齐 component-chat-float-menu.tsx 的悬浮胶囊（rounded-xl border bg-surface p-1 shadow-sm）。
 *
 * 按钮逻辑：
 *   - 只读态：1 个「编辑」按钮（点击进编辑态）
 *   - 编辑态：保存（第1）→ 撤销（第2）→ 格式化（第3·仅 structured）→ 校验（第4·仅 structured）
 *
 * 按钮样式：对齐 chat-float-menu 的容器内图标按钮（h-8 w-8 rounded-lg text-muted hover:bg-bg-warm hover:text-fg），
 *   图标 size 统一 16；保存按钮保留主色调（bg-accent）。
 * 图标：编辑(PencilIcon=feather edit-2) / 保存(SaveIcon) / 撤销(UndoIcon) / 格式化(AlignIcon) / 校验(CheckSquareIcon=feather check-circle)
 * 每个按钮 title + aria-label 文字 tooltip（i18n `workspace.preview.*`）。
 *
 * 参考：specs/tech/version_logs/v0.0.323/change_plan.md
 */
import { useTranslation } from 'react-i18next';
import { PencilIcon, SaveIcon, UndoIcon, AlignIcon, CheckSquareIcon, GlobeIcon } from './preview-icons';

/** 容器内图标按钮公共样式（对齐 chat-float-menu L96） */
const ICON_BTN =
  'flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg-warm hover:text-fg shrink-0';

/** 保存按钮（主色调，嵌入胶囊容器） */
const ICON_BTN_PRIMARY =
  'flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:bg-accent-hover shrink-0 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export interface FloatingActionsProps {
  /** 当前模式 */
  mode: 'view' | 'edit';
  /** 保存中（禁用按钮） */
  saving: boolean;
  /** structured 格式（控制格式化/校验按钮显隐） */
  isStructured: boolean;
  /** [v0.0.325] html 预览态（控制浏览器打开按钮显隐，仅 mode=view 时有效） */
  isHtml: boolean;
  /** 只读态：点「编辑」进编辑态 */
  onEdit: () => void;
  /** 编辑态：保存 */
  onSave: () => void;
  /** 编辑态：撤销（放弃修改回只读） */
  onUndo: () => void;
  /** 编辑态：格式化 */
  onFormat: () => void;
  /** 编辑态：校验 */
  onValidate: () => void;
  /** [v0.0.325] 只读态 html：浏览器打开 */
  onOpenInBrowser: () => void;
}

/**
 * 正文区悬浮操作胶囊容器。常驻显示（带背景/边框/阴影），按钮竖排。
 * 编辑态按钮顺序：保存 → 撤销 → 格式化（仅 structured）→ 校验（仅 structured）。
 */
export function ComponentPreviewFloatingActions({
  mode, saving, isStructured, isHtml, onEdit, onSave, onUndo, onFormat, onValidate, onOpenInBrowser,
}: FloatingActionsProps) {
  const { t } = useTranslation('chat');

  return (
    <div
      data-testid="pv-floating-actions"
      className="absolute right-3 top-4 z-[5] flex flex-col gap-1 rounded-xl border border-border bg-surface p-1 shadow-sm pointer-events-auto"
    >
      {mode === 'view' ? (
        <>
          {/* ① 编辑（常驻） */}
          <button
            type="button"
            data-testid="pv-float-edit"
            onClick={onEdit}
            aria-label={t('workspace.preview.edit')}
            title={t('workspace.preview.edit')}
            className={ICON_BTN}
          >
            <PencilIcon size={16} />
          </button>
          {/* ② 浏览器打开（仅 html 预览态） */}
          {isHtml && (
            <button
              type="button"
              data-testid="pv-float-open-browser"
              onClick={onOpenInBrowser}
              aria-label={t('workspace.preview.openInBrowser')}
              title={t('workspace.preview.openInBrowser')}
              className={ICON_BTN}
            >
              <GlobeIcon size={16} />
            </button>
          )}
        </>
      ) : (
        <>
          {/* ① 保存（主色调置顶） */}
          <button
            type="button"
            data-testid="pv-float-save"
            onClick={onSave}
            disabled={saving}
            aria-label={t('workspace.preview.save')}
            title={saving ? t('workspace.preview.saving') : t('workspace.preview.save')}
            className={ICON_BTN_PRIMARY}
          >
            <SaveIcon size={16} />
          </button>
          {/* ② 撤销（放弃修改回只读） */}
          <button
            type="button"
            data-testid="pv-float-undo"
            onClick={onUndo}
            aria-label={t('workspace.preview.undo')}
            title={t('workspace.preview.undo')}
            className={ICON_BTN}
          >
            <UndoIcon size={16} />
          </button>
          {/* ③ 格式化 / ④ 校验（仅 structured 格式显示） */}
          {isStructured && (
            <>
              <button
                type="button"
                data-testid="pv-float-format"
                onClick={onFormat}
                aria-label={t('workspace.preview.format')}
                title={t('workspace.preview.format')}
                className={ICON_BTN}
              >
                <AlignIcon size={16} />
              </button>
              <button
                type="button"
                data-testid="pv-float-validate"
                onClick={onValidate}
                aria-label={t('workspace.preview.validate')}
                title={t('workspace.preview.validate')}
                className={ICON_BTN}
              >
                <CheckSquareIcon size={16} />
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

export default ComponentPreviewFloatingActions;
