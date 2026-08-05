/**
 * component-seats-body —— SeatsPanel seats tab 主体（双列指挥台）
 * 参考: specs/ui/components/studio-page/component-seats-body.md
 *       reqs/[working] v0.0.240.squad_task/demo-home.html（.seats / .col / .roster，视觉契约）
 *
 * 职责：
 *   左列 seats-side（296px）= 队长 mini 卡（SeatCard）+ TokenWidget（图文组件，整卡点击进 token-stats）
 *   右列 roster 白卡 = roster 头（成员计数 N=当前视图行数 + 视图筛选开关 + 「＋ 新增成员」按钮）
 *   + 行列表（SeatRowView × N，仅 mate）。mates=0 → roster 体内 seats-empty 占位。
 * 边界：纯展示 + 回调；数据由 SeatsPanel 通过 use-seats-data 派生后传入（含视图过滤，本组件零过滤）。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Member, SquadDetail } from './squad-types';
import type { ChatNode } from './chat-node';
import type { SeatRow, SeatStatsData, SeatsView } from './use-seats-data';
import { SeatCard } from './component-seat-card';
import { SeatRowView } from './component-seat-row';
import { TokenWidget } from './component-token-widget';
import { SeatsViewSwitch } from './component-seats-view-switch';
import { Icon } from './studio-icons';

export interface SeatsBodyProps {
  detail: SquadDetail;
  seats: SeatRow[];
  leaderRow: SeatRow | null;
  mateRows: SeatRow[];
  stats: SeatStatsData;
  /** 当前视图（active=在岗 / all=全部），SeatsPanel state 注入（受控，本组件不持） */
  view: SeatsView;
  /** 视图切换回调（透传 SeatsViewSwitch.onChange；过滤在 SeatsPanel 单点） */
  onViewChange: (v: SeatsView) => void;
  onEnterChat: (node: ChatNode) => void;
  onOpenGroupChat: (node: ChatNode) => void;
  /** [v0.0.194] Token 统计入口（TokenWidget 整卡点击） */
  onOpenTokenStats?: (squadId: string) => void;
  onEditMember: (m: Member) => void;
  onBenchMember: (m: Member) => void;
  onDeployMember: (id: string) => void;
  onHire: () => void;
  buildMemberChatNode: (memberId: string) => ChatNode | null;
  buildGroupChatNode: () => ChatNode;
  /** 右键 → 父级浮层菜单（复制 sessionId）。坐席卡/行 + 群聊入口 link 共用；缺省 → 不接右键 */
  onContextMenu?: (sessionId: string, x: number, y: number) => void;
}

/** seats tab 主体（双列指挥台） */
export function SeatsBody(props: SeatsBodyProps): ReactNode {
  const { t } = useTranslation('studio');
  const {
    detail, leaderRow, mateRows, view, onViewChange,
    onEnterChat, onOpenGroupChat, onOpenTokenStats,
    onEditMember, onBenchMember, onDeployMember, onHire,
    buildMemberChatNode, buildGroupChatNode,
    onContextMenu,
  } = props;

  // roster 头计数：成员 N = mateRows.length（队长不计）——跟随当前视图（mateRows 已被 panel 按视图过滤）
  const memberCount = mateRows.length;

  return (
    <div className="px-6 py-5">
      <div className="grid grid-cols-[296px_minmax(0,1fr)] items-start gap-5">
        {/* 左列：队长 mini 卡 + token 小组件 */}
        <div className="flex flex-col gap-3.5">
          {leaderRow && (
            <SeatCard
              row={leaderRow}
              onEnter={() => {
                const n = buildMemberChatNode(leaderRow.member.id);
                if (n) onEnterChat(n);
              }}
              /* 群聊入口（v0.0.194 挪入队长卡操作行）：点击开群聊；右键复制 squadChat sessionId */
              onOpenGroupChat={() => onOpenGroupChat(buildGroupChatNode())}
              onGroupChatContextMenu={
                onContextMenu
                  ? (x, y) => onContextMenu(detail.squadChatSessionId, x, y)
                  : undefined
              }
              onEdit={onEditMember}
              onDeploy={onDeployMember}
              onContextMenu={onContextMenu}
              /* onBench 不传 —— leader 硬规则不可 bench（UI 双层拒） */
            />
          )}
          <TokenWidget
            squadId={detail.id}
            detail={detail}
            onOpenTokenStats={onOpenTokenStats ?? (() => {})}
          />
        </div>

        {/* 右列：roster 白卡（头 + mate 行列表） */}
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          {/* roster 头：成员计数（N=当前视图行数）+ 视图筛选开关（恒渲染）+ 「＋ 新增成员」按钮 */}
          <div className="flex items-center border-b border-border px-4 py-2.5">
            <span className="text-[13.5px] font-semibold text-fg">
              {t('seats.sectionMembers', { count: memberCount })}
            </span>
            <div className="ml-auto flex items-center gap-3">
              <SeatsViewSwitch view={view} onChange={onViewChange} />
              <button
                type="button"
                data-action-key="studio.member.hire"
                onClick={onHire}
                className="flex items-center gap-1 rounded-md border border-border bg-surface px-3 py-1 text-[12.5px] font-medium text-fg transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
              >
                <Icon name="plus" size={12} />
                {t('seats.addCard.title')}
              </button>
            </div>
          </div>

          {/* mate 行列表（seats-mates-grid 语义=行列表容器，恒渲染；空态内含 seats-empty） */}
          <div>
            {mateRows.length === 0 ? (
              <div

                className="px-6 py-10 text-center text-[12.5px] text-muted"
              >
                {t('seats.emptyMembers')}
              </div>
            ) : (
              mateRows.map((row) => (
                <SeatRowView
                  key={row.member.id}
                  row={row}
                  onEnter={() => {
                    const n = buildMemberChatNode(row.member.id);
                    if (n) onEnterChat(n);
                  }}
                  onEdit={onEditMember}
                  onBench={onBenchMember}
                  onDeploy={onDeployMember}
                  onContextMenu={onContextMenu}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SeatsBody;
