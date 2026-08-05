/**
 * section-studio-sidebar —— Studio 左 sidebar（squad 列表 + 新建按钮；无展开树）
 * 参考: specs/ui/components/studio-page/studio-sidebar.md v1.6（v0.0.168 手风琴展开树彻底删除）
 *       specs/ui/overall/06-studio.md §2 v0.0.168 修订（sidebar 只留 squad 行 + 新建）
 *
 * v0.0.168 修订：删手风琴展开树（团队看板/群聊/leader/mate/subagent 子节点全部）。
 *   侧栏承接 squad 「选中即进首页 seats」的唯一入口（IA 决策 D6）；chat 入口全部改为首页坐席卡/团队入口卡；
 *   右键「复制 Session ID」菜单迁到坐席卡与群聊入口卡（详见 `component-studio-context-menu.md`）。
 *
 * 边界：squads 列表由父级传入；本组件不再管展开态、detail 缓存、SSE stateMap/unreadMap 消费；
 *   点 squad 行 → 上抛 onSelectSquad（父级 page-studio 落 `{kind:'seats', squadId}`）。
 *   已删 props：`dataVersion` / `onOpenBoard` / `onOpenChat` / `unreadMap` / `activeChatSessionId` / `stateMap`（tree 已死）。
 */
import { useTranslation } from 'react-i18next';
import type { SquadSummary } from './squad-types';
import { Icon } from './studio-icons';

interface StudioSidebarProps {
  squads: SquadSummary[];
  selectedSquadId: string | null;
  onSelectSquad: (id: string) => void;
  onNewSquad: () => void;
}

/** Studio 左 sidebar */
export function StudioSidebar({
  squads,
  selectedSquadId,
  onSelectSquad,
  onNewSquad,
}: StudioSidebarProps) {
  const { t } = useTranslation('studio');

  return (
    <aside

      className="flex w-56 shrink-0 flex-col border-r border-border bg-surface"
    >
      {/* 头部：标题 + 新建按钮 */}
      <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-4">
        <div className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-2">{t('sidebar.title')}</div>
        <button
          type="button"
          data-action-key="studio.squad.create"
          aria-label={t('sidebar.newSquadAria')}
          title={t('sidebar.newSquadAria')}
          onClick={onNewSquad}
          className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-accent-surface hover:text-accent"
        >
          <Icon name="plus" size={14} />
        </button>
      </div>
      {/* 列表：只 squad 行（无展开树） */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {squads.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted">{t('sidebar.empty')}</div>
        ) : (
          squads.map((s) => (
            <SquadRow
              key={s.id}
              squad={s}
              selected={selectedSquadId === s.id}
              onSelect={() => onSelectSquad(s.id)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

/**
 * 单个 squad 行（点行选中，进首页 seats）。
 * 视觉基线（`studio-sidebar.md` §视觉基线）：`px-2.5 py-3 rounded-lg` + 选中 `bg-accent-surface` +
 *   squad 图标 accent 15px + 名称 16px 半粗 + 成员数 badge mono 11px。
 * v0.0.168 移除：`aria-expanded`（无展开态）、cursor-pointer 保留（行本身可点）。
 */
function SquadRow({
  squad,
  selected,
  onSelect,
}: {
  squad: SquadSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      data-action-key="studio.squad.select"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={
        'mb-0.5 flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-3 transition-colors ' +
        (selected ? 'bg-accent-surface' : 'hover:bg-bg-warm')
      }
    >
      <span className="inline-flex shrink-0 text-accent">
        <Icon name="squad" size={15} />
      </span>
      <span className={'min-w-0 flex-1 truncate text-[16px] font-semibold ' + (selected ? 'text-accent' : 'text-fg')}>
        {squad.name}
      </span>
      <span className="rounded-xs bg-bg-warm px-1.5 py-px font-mono text-[11px] text-muted">{squad.memberCount}</span>
    </div>
  );
}

export default StudioSidebar;
