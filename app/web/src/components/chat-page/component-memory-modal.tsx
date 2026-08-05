/**
 * component-memory-modal —— 长期记忆弹层（二级视图导航，v0.0.131 新建）
 * 参考: specs/ui/components/chat-page/component-memory-modal.md
 *       specs/ui/components/chat-page/component-chat-float-menu.md §4/§5（testid 权威）
 *
 * view = crud.editor.open ? 'editor' : 'list'（复用 useMemoryCrud 既有 editor state，不新建
 * view state）。list 态复用 component-memory-entry-card；editor 态复用
 * component-memory-editor-fields。归档 = 单击直接执行，无确认层（禁 window.confirm）。
 *
 * crud 由父（component-chat-float-menu）恒挂载后以 prop 下传——本组件不重新调用
 * useMemoryCrud，保证 badge 与弹层列表同一数据源。
 */
import { useTranslation } from 'react-i18next';
import { ChevronLeftIcon, CloseIcon, PlusIcon } from './icons';
import { ComponentMemoryEntryCard } from './component-memory-entry-card';
import { ComponentMemoryEditorFields } from './component-memory-editor-fields';
import { Portal } from '../../lib/portal';
import type { MemoryCrud } from './use-memory-crud';

export interface ChatMemoryModalProps {
  /** float-menu 恒挂载的 useMemoryCrud 实例（badge 同源） */
  crud: MemoryCrud;
  /** 关闭弹层 */
  onClose: () => void;
}


export function ComponentMemoryModal({ crud, onClose }: ChatMemoryModalProps) {
  const { entries, loading, error, editor, setEditor, handleSave, handleArchive } = crud;
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');
  const view: 'list' | 'editor' = editor.open ? 'editor' : 'list';

  // 关闭须附带重置 editor：crud 在 float-menu 恒挂载，editor.open 会跨弹层开关残留，
  // 不重置则「编辑中关闭 → 重开」直接落 editor 态（违反 float-menu spec §7 重开回列表态）
  const handleClose = () => {
    setEditor({ open: false });
    onClose();
  };

  // L3 modal（_layering.md §3A）：包 <Portal> 到 overlay-root，脱离 overlay 的 pointer-events:none 链
  // ——结构性修症状 2（memory-modal 嵌在 float-menu sibling 挂 overlay 容器下，CSS 继承致 none 不可交互）。
  return (
    <Portal>
    <div

      // z=`--z-modal`(1000) 远高于 popover(50)；pointer-events-auto 双保险（overlay-root 容器 none，modal 本体需 auto）
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[rgba(30,25,20,0.45)] backdrop-blur-sm pointer-events-auto"
      onClick={handleClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88vh] w-[520px] max-w-[92vw] flex-col rounded-[14px] border border-border-2 bg-surface shadow-2xl"
      >
        {/* head：返回（editor 态） / 标题 / 新建（list 态） / 关闭 */}
        <div className="flex shrink-0 items-center gap-2 px-[22px] pt-[18px] pb-3">
          {view === 'editor' && (
            <button
              type="button"

              onClick={() => setEditor({ open: false })}
              className="flex items-center gap-1 text-[12.5px] text-muted transition-colors hover:text-fg"
            >
              <ChevronLeftIcon size={14} />
              {tCommon('action.back')}
            </button>
          )}
          <span className="flex-1 text-[15px] font-bold text-fg">
            {view === 'editor'
              ? editor.initial?.name
                ? t('memory.editor.editTitle')
                : t('memory.editor.createTitle')
              : t('workspace.tab.memory')}
          </span>
          {view === 'list' && (
            <button
              type="button"
              data-action-key="chat.memory.create"
              onClick={() => setEditor({ open: true })}
              className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-semibold text-surface transition-colors hover:opacity-90"
            >
              <PlusIcon size={12} />
              {t('memory.create')}
            </button>
          )}
          <button
            type="button"

            aria-label={tCommon('modal.close')}
            onClick={handleClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-warm hover:text-fg"
          >
            <CloseIcon size={16} />
          </button>
        </div>

        {/* body */}
        <div className="flex flex-col gap-3 overflow-y-auto px-[22px] pb-5">
          {view === 'editor' ? (
            <ComponentMemoryEditorFields
              initial={editor.initial}

              onCancel={() => setEditor({ open: false })}
              onSave={handleSave}
            />
          ) : (
            <div className="flex flex-col gap-2">
              {loading && entries.length === 0 ? (
                <div className="py-6 text-center font-mono text-[11px] text-muted">{t('memory.loading')}</div>
              ) : error ? (
                <div role="alert" className="py-4 text-center text-[12px] text-[var(--danger)]">{error}</div>
              ) : entries.length === 0 ? (
                <div className="px-6 py-12 text-center text-muted">
                  <div className="mb-1 text-[24px]" aria-hidden>🧠</div>
                  <span className="text-[12px]">{t('memory.empty')}</span>
                </div>
              ) : (
                entries.map((entry) => (
                  <ComponentMemoryEntryCard
                    key={entry.name}
                    entry={entry}
                    onEdit={(e) => setEditor({ open: true, initial: e })}
                    onArchive={(name) => void handleArchive(name)}

                  />
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
    </Portal>
  );
}

export default ComponentMemoryModal;
