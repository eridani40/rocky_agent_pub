/**
 * section-user-memory —— 应用设置「全局长期记忆」tab（v0.0.55 T5）
 * 参考: specs/ui/components/app-dev-config-page/section-user-memory.md（契约权威）
 *       specs/api/overall/15-memory-ui.md §3-§6
 *       specs/tech/agent/memory/[P0]memory_definition.md §2（global 介质=<dataDir>/memory/ per-entry dir store）
 *
 * 职责：
 *   - 进入 group → GET /memory/global 列 entry（无 sessionId，全局一份）
 *   - 新建按钮（顶部）→ 弹编辑 modal → POST → refetch → 关 modal
 *   - 编辑按钮（卡片）→ 弹编辑 modal → PATCH → refetch → 关 modal
 *   - 归档按钮（卡片）→ DELETE → refetch
 *
 * 与 section-memory-panel 区别：
 *   - scope=global（无 sessionId，全局一份，dir store）
 *   - 复用 component-memory-entry-card + component-memory-editor-modal（testIdPrefix=memory-user）
 *   - CRUD 逻辑走 useMemoryCrud hook（与 section-memory-panel 共享，避免重复）
 */
import { useTranslation } from 'react-i18next';
import { ComponentMemoryEntryCard } from '../chat-page/component-memory-entry-card';
import { ComponentMemoryEditorModal } from '../chat-page/component-memory-editor-modal';
import { useMemoryCrud } from '../chat-page/use-memory-crud';

/** 全局长期记忆 tab（[v0.0.112] global scope，无 sessionId）。CRUD 逻辑见 useMemoryCrud。 */
export function SectionUserMemory() {
  const { entries, loading, error, editor, setEditor, handleSave, handleArchive } =
    useMemoryCrud('global');
  // [v0.0.62 i18n] user memory 文案走 app-dev-config ns
  const { t } = useTranslation('app-dev-config');

  return (
    <div className="flex flex-col gap-3">
      {/* header：标题 + scope 词汇标签 + 新建按钮 */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          {/* [v0.0.112] scope 词汇标签：固定 token 'global'（对外统一命名，非 localized，避免随 locale 漂移） */}
          <span

            className="w-fit rounded-xs bg-bg-warm px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.03em] text-muted"
          >
            scope: global
          </span>
          <p className="m-0 text-[12px] text-muted-2">
            {t('userMemory.scopeHint')}
          </p>
        </div>
        <button
          type="button"
          data-action-key="settings.memory.create"
          onClick={() => setEditor({ open: true })}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] text-surface transition-opacity hover:opacity-90"
        >
          {t('userMemory.create')}
        </button>
      </div>
      {error && (
        <div role="alert" className="text-[12px] text-[var(--danger)]">{error}</div>
      )}
      {/* 列表区 */}
      <div className="flex flex-col gap-2">
        {loading && entries.length === 0 ? (
          <div className="py-6 text-center font-mono text-[11px] text-muted">{t('userMemory.loading')}</div>
        ) : entries.length === 0 ? (
          <div className="py-6 text-center text-[12px] text-muted">
            {t('userMemory.empty')}
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
      {/* 编辑/新建 modal */}
      <ComponentMemoryEditorModal
        open={editor.open}
        initial={editor.initial}

        onClose={() => setEditor({ open: false })}
        onSave={handleSave}
      />
    </div>
  );
}

export default SectionUserMemory;
