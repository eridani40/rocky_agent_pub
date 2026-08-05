/**
 * component-seat-card —— 队长 mini 卡（v0.0.170 重写：C 紧凑指挥台左列首张卡）
 * 参考: specs/ui/components/studio-page/component-seat-card.md v1.4
 *       reqs/[working] v0.0.170.squad_home_ui/design-c-console.html（.side .card / .leader-mini，视觉契约）
 *
 * 职责：
 *   seclabel「队长」→ mini 行（MemberAvatar lg + presence / 名 + 行内 LEADER badge /
 *   meta 行 = 脉冲点 + statusText · state 单行 truncate）→ 操作行（进入对话 flex-1 solid +
 *   群聊 flex-1 灰色 outline（v0.0.194 从 TeamEntryRow 挪入）+ 更多 outline icon → 弹菜单，
 *   见 component-seat-card-menu）。
 *   「坐席卡」概念 = 队长卡；mate 列表形态见 component-seat-row.tsx。
 * 视觉降级：
 *   - leader 标识 = 行内 amber badge
 *   - offline → 根 opacity-75；「进入对话」降 secondary 型
 * 菜单机械与 mate 行共享（use-seat-menu）；呈现共享（seat-present）。
 * 边界：纯展示 + 回调；数据全由 use-seats-data 派生传入；无 @keyframes（INV-3 严肃基调）；
 *   无 hover 位移/内边距变化（布局稳定）。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MemberAvatar } from '../common/member-avatar';
import { SpinnerRing } from '../common/spinner-ring';
import { Icon } from './studio-icons';
import type { Member } from './squad-types';
import type { SeatRow } from './use-seats-data';
import { SeatCardMenu } from './component-seat-card-menu';
import { useSeatMenu } from './use-seat-menu';
import { pulseStyle, useSeatStatusText } from './seat-present';

export interface SeatCardProps {
  row: SeatRow;
  onEnter: () => void;
  /** 「群聊」按钮回调（操作行中档，flex-1 灰色 outline）。缺省 → 不渲染群聊按钮 */
  onOpenGroupChat?: () => void;
  /** 群聊按钮右键 → 父级浮层菜单（复制 squadChat sessionId）。缺省 → 不接右键 */
  onGroupChatContextMenu?: (x: number, y: number) => void;
  onEdit?: (member: Member) => void;
  onBench?: (member: Member) => void;
  onDeploy?: (memberId: string) => void;
  /** 右键 → 父级浮层菜单（复制 sessionId）。缺省 → 不接右键（浏览器默认菜单） */
  onContextMenu?: (sessionId: string, x: number, y: number) => void;
}

/**
 * SeatCard —— 队长 mini 卡（C 指挥台左列）。
 */
export function SeatCard({ row, onEnter, onOpenGroupChat, onGroupChatContextMenu, onEdit, onBench, onDeploy, onContextMenu }: SeatCardProps): ReactNode {
  const { t } = useTranslation('studio');
  const { member, isLeader, presence } = row;
  const statusText = useSeatStatusText(row);
  const isOffline = presence === 'offline';

  // 菜单机械（共享 hook：开关 + rect 定位 + flip-up + 延迟关闭监听）
  const { menuOpen, menuPos, moreBtnRef, avail, openMenu, closeMenu } = useSeatMenu({
    member, isLeader, onEdit, onBench, onDeploy,
  });

  // enter 按钮：solid（--btn-primary-bg）；offline 降 secondary 型
  const enterClass = isOffline
    ? 'flex-1 flex items-center justify-center gap-1 h-8 rounded-md border border-border-2 bg-surface text-fg-3 text-[12.5px] font-medium hover:bg-surface-2 transition-colors'
    : 'flex-1 flex items-center justify-center gap-1 h-8 rounded-md text-[12.5px] font-medium transition-opacity hover:opacity-90';
  const enterStyle = isOffline ? undefined : { background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)' };

  return (
    <div

      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              onContextMenu(member.sessionId, e.clientX, e.clientY);
            }
          : undefined
      }
      className={['rounded-xl border border-border bg-surface p-3.5', isOffline ? 'opacity-75' : '']
        .filter(Boolean)
        .join(' ')}
    >
      {/* seclabel「队长」 */}
      <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-2">
        {t('seats.sectionLeader')}
      </div>

      {/* mini 行：avatar + 名/badge + meta */}
      <div className="flex items-center gap-2.5">
        <MemberAvatar
          name={member.name}
          role={member.role}
          id={member.id}
          size="lg"
          showName={false}
          showPresence={presence}

        />
        <div className="flex-1 min-w-0">
          {/* 名字行：truncate 名 → leader badge（若队长）→ running spinner（仅 row.isRunning，最末）。
           * gap-1.5 统一间距防挤；spinner shrink-0 占位防位移（INV-9）；size=sm 对齐 squad 紧凑上下文。 */}
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold text-fg">{member.name}</span>
            {isLeader && (
              <span

                className="shrink-0 rounded-xs px-1.5 py-px text-[10px] font-bold"
                style={{ background: 'var(--hue-amber-bg)', color: 'var(--hue-amber)' }}
              >
                {t('seats.card.leaderBadge')}
              </span>
            )}
            {row.isRunning && (
              <SpinnerRing
                size="sm"

              />
            )}
          </div>
          {/* meta 行：脉冲点 + statusText · state（12px muted 单行 truncate） */}
          <div

            className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={pulseStyle(presence)} aria-hidden />
            <span className="truncate">
              {statusText} · {member.state}
            </span>
          </div>
        </div>
      </div>

      {/* 操作行：enter flex-1 solid + 群聊 flex-1 灰色 outline + more outline icon */}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          data-action-key="studio.member.open-chat"
          onClick={onEnter}
          className={enterClass}
          style={enterStyle}
        >
          <Icon name="chat" size={13} />
          <span>{t('seats.card.enter')}</span>
        </button>
        {/* 群聊入口（v0.0.194 从 TeamEntryRow 挪入）：与 enter 各占一半；灰色 outline 不抢主按钮视觉。
         * 右键 stopPropagation 必需——否则冒泡到根卡右键 handler 触发 leader sessionId 浮层（双重弹层）。 */}
        {onOpenGroupChat && (
          <button
            type="button"
            data-action-key="studio.squad.open-group-chat"
            onClick={onOpenGroupChat}
            onContextMenu={
              onGroupChatContextMenu
                ? (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onGroupChatContextMenu(e.clientX, e.clientY);
                  }
                : undefined
            }
            className="flex-1 flex items-center justify-center gap-1 h-8 rounded-md border border-border-2 bg-surface text-fg-3 text-[12.5px] font-medium hover:bg-surface-2 transition-colors"
          >
            <Icon name="squad" size={13} />
            <span>{t('seats.team.groupChatTitle')}</span>
          </button>
        )}
        <button
          ref={moreBtnRef}
          type="button"
          data-action-key="studio.member.open-menu"
          onClick={(e) => {
            e.stopPropagation();
            openMenu();
          }}
          disabled={!avail.anyAvailable}
          aria-label={t('seats.card.more')}
          title={t('seats.card.more')}
          className="flex h-8 w-8 items-center justify-center rounded-md border border-border-2 bg-surface text-fg-3 transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="dots" size={13} />
        </button>
      </div>

      {/* 菜单弹层（portal body，fixed 右对齐触发按钮） */}
      {menuOpen && menuPos && (
        <SeatCardMenu
          member={member}
          isLeader={isLeader}
          anchor={menuPos}
          onEdit={onEdit}
          onBench={onBench}
          onDeploy={onDeploy}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}

export default SeatCard;
