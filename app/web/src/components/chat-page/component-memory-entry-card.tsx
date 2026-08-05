/**
 * component-memory-entry-card —— 单 memory entry 卡片
 * 参考: specs/ui/components/chat-page/component-memory-entry-card.md（契约权威）
 *       specs/api/overall/15-memory-ui.md §2（entry schema）
 *       reqs/v0.0.55.memory_ui_session_lock/design/ui-demo.html §1/§2/§4（视觉基线 .entry）
 *
 * 复用三处（testIdPrefix 区分场景）：
 *   - chat 右侧（section-memory-panel）→ prefix=memory-session
 *   - studio 右侧（section-right-tabs）→ prefix=squad-memory
 *   - 应用设置（section-user-memory）→ prefix=memory-user
 *
 * 渲染：name + type badge + intro（常显）+ body/why/how（展开）+ edit/archive 按钮（hover）。
 *   intro（一句话摘要，v0.0.114 由 description 改名）；DOM testid 仍保留 `-desc`（E2E 观测契约稳定）。
 * 受控组件：所有操作回调上抛父（onEdit/onArchive）。
 *
 * 布局稳定性（MANDATORY）：edit/archive 按钮 opacity 0→1，绝对空间预留（flex-shrink:0），
 * 不因出现/消失导致 name 位移。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MemoryEntry } from '../../lib/memory-api';
import { ChevronIcon } from './icons';

/** type badge 配色 token（对齐 component-memory-entry-card.md §5） */
const TYPE_BADGE_CLASS: Record<MemoryEntry['type'], string> = {
  user: 'b-user',
  feedback: 'b-feedback',
  project: 'b-project',
  reference: 'b-reference',
};

/** type 中文短标（badge 文案） */
const TYPE_LABEL: Record<MemoryEntry['type'], string> = {
  user: 'user',
  feedback: 'feedback',
  project: 'project',
  reference: 'reference',
};

export interface MemoryEntryCardProps {
  entry: MemoryEntry;
  /** 点编辑按钮 → 父弹 modal */
  onEdit: (entry: MemoryEntry) => void;
  /** 点归档按钮 → 父调 DELETE */
  onArchive: (name: string) => void;
}

/**
 * 单 memory entry 卡片。默认折叠（仅 name + type + desc），
 * 点卡片/chevron 展开 body + why/how；hover 出 edit/archive 按钮。
 * archived=true 时整卡 opacity 0.6 + 「已归档」badge。
 */
export function ComponentMemoryEntryCard({
  entry,
  onEdit,
  onArchive,
}: MemoryEntryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');
  const hasExtra = Boolean(entry.why || entry.howToApply);

  return (
    <div

      className={`memory-entry group flex flex-col gap-1 rounded-[10px] border border-border bg-surface px-3.5 py-3 transition-colors hover:border-border-strong hover:bg-bg-warm ${
        entry.archived ? 'opacity-60' : ''
      }`}
    >
      {/* header：name + type badge + 展开按钮 + 操作按钮组（hover 出现） */}
      <div className="flex items-center gap-2">
        <span

          className="font-mono text-[13px] font-semibold text-fg"
        >
          {entry.name}
        </span>
        <span

          className={`badge ${TYPE_BADGE_CLASS[entry.type]} rounded-xs px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.03em]`}
        >
          {TYPE_LABEL[entry.type]}
        </span>
        {entry.archived && (
          <span className="rounded-xs bg-bg-warm px-1.5 py-0.5 font-mono text-[10px] text-muted">
            {t('memory.entryCard.archived')}
          </span>
        )}
        {/* [v0.0.112] evolvable=false 透出「手动维护」标记（true 默认不渲染，避免视觉噪声） */}
        {entry.evolvable === false && (
          <span

            title={t('memory.entryCard.manualTitle')}
            className="rounded-xs bg-bg-warm px-1.5 py-0.5 font-mono text-[10px] text-muted"
          >
            {t('memory.entryCard.manual')}
          </span>
        )}
        {/* 展开按钮：仅当有 body/why/how 才可点（占位保持对齐） */}
        <button
          type="button"

          onClick={() => setExpanded((v) => !v)}
          disabled={!entry.body && !hasExtra}
          aria-label={expanded ? t('memory.entryCard.collapseDetail') : t('memory.entryCard.expandDetail')}
          className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center text-muted transition-transform disabled:opacity-30"
          style={{ transform: expanded ? 'rotate(180deg)' : undefined }}
        >
          <ChevronIcon size={12} />
        </button>
        {/* 操作按钮组：edit/archive —— 布局稳定性 MANDATORY（opacity 切换，flex-shrink:0 占位） */}
        <button
          type="button"
          data-action-key="chat.memory.edit"
          onClick={() => onEdit(entry)}
          aria-label={tCommon('action.edit')}
          title={tCommon('action.edit')}
          className="memory-act flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] bg-transparent text-muted opacity-0 transition-opacity hover:bg-accent-surface hover:text-accent group-hover:opacity-100"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 113 3L7 19l-4 1 1-4z" />
          </svg>
        </button>
        <button
          type="button"
          data-action-key="chat.memory.archive"
          onClick={() => onArchive(entry.name)}
          aria-label={t('memory.entryCard.archive')}
          title={t('memory.entryCard.archive')}
          className="memory-act flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] bg-transparent text-muted opacity-0 transition-opacity hover:bg-accent-surface hover:text-accent group-hover:opacity-100"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
        </button>
      </div>
      {/* intro 一句话摘要（一行省略）；testid 仍用 'desc' 保持 E2E 观测契约稳定 */}
      <p

        className="m-0 text-[12px] leading-[1.5] text-muted-2"
      >
        {entry.intro}
      </p>
      {/* 展开后：body + why + how */}
      {expanded && entry.body && (
        <div

          className="mt-1 rounded-md bg-bg px-2.5 py-2 font-mono text-[12px] leading-relaxed text-fg-2 whitespace-pre-wrap"
        >
          {entry.body}
        </div>
      )}
      {expanded && entry.why && (
        <div className="mt-1 text-[12px] italic text-muted-2">
          <span className="font-semibold not-italic">why：</span>
          {entry.why}
        </div>
      )}
      {expanded && entry.howToApply && (
        <div className="text-[12px] italic text-muted-2">
          <span className="font-semibold not-italic">how：</span>
          {entry.howToApply}
        </div>
      )}
    </div>
  );
}

export default ComponentMemoryEntryCard;
