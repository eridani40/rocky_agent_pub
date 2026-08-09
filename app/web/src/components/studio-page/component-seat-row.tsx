/**
 * component-seat-row —— mate 坐席行（v0.0.170 新增：C 紧凑指挥台 roster 行列表）
 * 参考: specs/ui/components/studio-page/component-seat-row.md v1.0
 *       reqs/[working] v0.0.170.squad_home_ui/design-c-console.html（.row / .who / .st / .ops，视觉契约）
 *
 * 职责：
 *   avatar + presence 点 → who 列（名 13.5px/600 + `role · state` 11.5px muted-2）→
 *   status 列（脉冲点 + statusText 单行 truncate）→ ops 列（进入对话 solid + 更多 outline icon → 弹菜单）。
 *   只服务 mate（leader 走 component-seat-card 队长 mini 卡；本组件无 leader badge）。
 * 交互：
 *   - ops 列恒渲染，opacity-0 → group-hover/focus-within 揭示（布局稳定 + 键盘可达）
 *   - offline → 根 opacity-75；「进入对话」降 secondary 型
 *   - 右键行根 → 父级浮层菜单（复制 sessionId）；行根无整行 onClick（交互只走按钮）
 * 菜单机械与队长卡共享（use-seat-menu）；呈现共享（seat-present）。
 * 边界：纯展示 + 回调；数据只收 row: SeatRow（use-seats-data 派生），组件不自行派生；无 @keyframes（INV-3）。
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

export interface SeatRowViewProps {
  row: SeatRow;
  onEnter: () => void;
  onEdit?: (member: Member) => void;
  onBench?: (member: Member) => void;
  onDeploy?: (memberId: string) => void;
  /** 右键 → 父级浮层菜单（复制 sessionId）。缺省 → 不接右键（浏览器默认菜单） */
  onContextMenu?: (sessionId: string, x: number, y: number) => void;
}

/**
 * SeatRowView —— 单条 mate 坐席行。
 * （命名 SeatRowView 避与 use-seats-data 的 SeatRow type 撞名。）
 */
export function SeatRowView({ row, onEnter, onEdit, onBench, onDeploy, onContextMenu }: SeatRowViewProps): ReactNode {
  const { t } = useTranslation('studio');
  const { member, isLeader, presence } = row;
  const statusText = useSeatStatusText(row);
  const isOffline = presence === 'offline';
  // [v0.0.277] idle 弱化：在线但没跑（非 running 且非 offline，含 suspended）→ 行 + 名字调灰，
  // 弱化程度轻于 offline（opacity-85 < 75 的降权差，文字 fg-2 非 fg-3）——让 running 突出、idle 退后
  const isIdle = !row.isRunning && !isOffline;
  const isFallback = row.statusTextSource.kind === 'fallback';

  // 菜单机械（共享 hook：开关 + rect 定位 + flip-up + 延迟关闭监听）
  const { menuOpen, menuPos, moreBtnRef, avail, openMenu, closeMenu } = useSeatMenu({
    member, isLeader, onEdit, onBench, onDeploy,
  });

  // enter 按钮：小 solid（--btn-primary-bg）；offline 降 secondary 型
  const enterClass = isOffline
    ? 'flex items-center justify-center gap-1 rounded-md border border-border-2 bg-surface px-3 py-1 text-[12px] font-medium text-fg-3 transition-colors hover:bg-surface-2'
    : 'flex items-center justify-center gap-1 rounded-md px-3 py-1 text-[12px] font-medium transition-opacity hover:opacity-90';
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
      className={[
        'group flex items-center gap-3 border-b border-surface-2 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-bg',
        isOffline ? 'opacity-75' : '',
        isIdle ? 'opacity-[0.85]' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {/* avatar + presence 点 */}
      <MemberAvatar
        name={member.name}
        role={member.role}
        id={member.id}
        size="md"
        showName={false}
        showPresence={presence}

      />

      {/* who 列：名 + role · state */}
      <div className="w-40 flex-none min-w-0">
        {/* 名字行：truncate 名 + 可选 running spinner（仅 row.isRunning 渲染）。
         * spinner shrink-0 占位防位移（INV-9）；size=sm 对齐 squad-tree/subagent 紧凑上下文。 */}
        <div className="flex items-center gap-1">
          <span className={['truncate text-[13.5px] font-semibold', isIdle ? 'text-fg-2' : 'text-fg'].join(' ')}>{member.name}</span>
          {row.isRunning && (
            <SpinnerRing
              size="sm"

            />
          )}
        </div>
        <div className="truncate text-[11.5px] text-muted-2">
          {member.role} · {member.state}
        </div>
      </div>

      {/* status 列：脉冲点 + statusText 单行 truncate（fallback 时弱化 muted-2） */}
      <div

        className={[
          'flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px]',
          isFallback ? 'text-muted-2' : 'text-fg-3',
        ].join(' ')}
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={pulseStyle(presence)} aria-hidden />
        <span className="truncate">{statusText}</span>
      </div>

      {/* ops 列：恒渲染只变 opacity（布局稳定）；hover / focus-within 揭示 */}
      <div className="flex flex-none items-center gap-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          data-action-key="studio.member.open-chat"
          onClick={onEnter}
          className={enterClass}
          style={enterStyle}
        >
          <Icon name="chat" size={12} />
          <span>{t('seats.card.enter')}</span>
        </button>
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
          className="flex items-center justify-center rounded-md border border-border-2 bg-surface px-2 py-1 text-fg-3 transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="dots" size={12} />
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

export default SeatRowView;
