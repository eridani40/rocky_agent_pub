/**
 * component-seats-body —— SeatsPanel seats tab 主体（v0.0.288 左竖条 + 右全景）
 * 参考: specs/ui/components/studio-page/component-seats-body.md
 *
 * 职责（v0.0.288 重构）：
 *   左列（296px，flex-col gap）= TokenWidget（上）+ 成员列表卡（下）
 *     - 成员卡头部：左标题「成员·N」+ 右组右对齐（在岗/全部 → 群聊图标(icon-only) → 加号(icon-only)）
 *     - 成员卡体：MemberRosterList（三分区 running/idle/benched，showBenched=view==='all'）
 *   右列 = PanoramaRoute（overflow-hidden + min-w-0，不横滑）
 *   队长卡删除——队长入 MemberRosterList 行内 isLeader badge 区分
 * 边界：纯展示 + 回调；数据由 SeatsPanel 传入（detail + memberStateMap → derivePanelRows 派生三分区）。
 */
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SquadDetail } from './squad-types';
import type { SessionState } from '../chat-page/types';
import type { ChatNode } from './chat-node';
import type { SeatsView } from './use-seats-data';
import { TokenWidget } from './component-token-widget';
import { SeatsViewSwitch } from './component-seats-view-switch';
import { MemberRosterList } from './component-member-roster-list';
import { derivePanelRows } from './squad-status-utils';
import { PanoramaRoute } from './component-panorama-route';
import { Icon } from './studio-icons';

export interface SeatsBodyProps {
  detail: SquadDetail;
  /** 成员 session state map（derivePanelRows 需要） */
  memberStateMap: Record<string, SessionState>;
  /** 当前视图（active=在岗 / all=全部），控制 showBenched */
  view: SeatsView;
  onViewChange: (v: SeatsView) => void;
  onEnterChat: (node: ChatNode) => void;
  onOpenGroupChat: (node: ChatNode) => void;
  /** [v0.0.194] Token 统计入口（TokenWidget 整卡点击） */
  onOpenTokenStats?: (squadId: string) => void;
  onHire: () => void;
  buildMemberChatNode: (memberId: string) => ChatNode | null;
  buildGroupChatNode: () => ChatNode;
  /** 全景「更多」tab 的「去群聊 @leader」透传 */
  onAtLeader: () => void;
  /** 右键 → 父级浮层菜单（复制 sessionId） */
  onContextMenu?: (sessionId: string, x: number, y: number) => void;
}

/** seats tab 主体（v0.0.288 左竖条 + 右全景） */
export function SeatsBody(props: SeatsBodyProps): ReactNode {
  const { t } = useTranslation('studio');
  const {
    detail, memberStateMap, view, onViewChange,
    onEnterChat, onOpenGroupChat, onOpenTokenStats,
    onHire, buildMemberChatNode, buildGroupChatNode,
    onAtLeader, onContextMenu,
  } = props;

  // 三分区派生（首页统一用 derivePanelRows，替代旧 deriveViewRows；含 leader 行）
  const rows = useMemo(() => derivePanelRows(detail, memberStateMap), [detail, memberStateMap]);
  // [v0.0.292] 成员计数 = 当前视图实际行数（含队长）——删 288 的 nonLeaderCount 排除逻辑
  const memberCount = view === 'all'
    ? rows.running.length + rows.idle.length + rows.benched.length
    : rows.running.length + rows.idle.length;

  const groupChatEnabled = detail.enableGroupChat !== false;

  return (
    <div className="flex gap-5 px-6 py-5">
      {/* 左竖条：296px（token 卡上 + 成员卡下） */}
      <div className="flex w-[296px] shrink-0 flex-col gap-3.5">
        <TokenWidget
          squadId={detail.id}
          detail={detail}
          onOpenTokenStats={onOpenTokenStats ?? (() => {})}
        />

        {/* 成员列表卡（[v0.0.292] 删 overflow-hidden，高度随内容撑开） */}
        <div className="rounded-xl border border-border bg-surface">
          {/* 成员卡头部：左标题「成员·N」+ 右组右对齐（在岗/全部 → 群聊图标 → 加号） */}
          <div className="flex items-center border-b border-border px-4 py-2.5">
            <span className="text-[13.5px] font-semibold text-fg">
              {t('seats.sectionMembers', { count: memberCount })}
            </span>
            <div className="ml-auto flex items-center gap-3">
              <SeatsViewSwitch view={view} onChange={onViewChange} />
              {/* 群聊图标按钮（icon-only 无文字；enableGroupChat !== false 时渲染） */}
              {groupChatEnabled && (
                <button
                  type="button"
                  data-action-key="studio.squad.open-group-chat"
                  data-testid="seats-group-chat-btn"
                  onClick={() => onOpenGroupChat(buildGroupChatNode())}
                  onContextMenu={
                    onContextMenu
                      ? (e) => {
                          e.preventDefault();
                          onContextMenu(detail.squadChatSessionId, e.clientX, e.clientY);
                        }
                      : undefined
                  }
                  className="flex items-center justify-center rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                  aria-label={t('squadTree.groupChat')}
                >
                  <Icon name="chat" size={14} />
                </button>
              )}
              {/* 加号图标按钮（icon-only 无文字，新增成员） */}
              <button
                type="button"
                data-action-key="studio.member.hire"
                data-testid="seats-hire-btn"
                onClick={onHire}
                className="flex items-center justify-center rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                aria-label={t('seats.addCard.title')}
              >
                <Icon name="plus" size={14} />
              </button>
            </div>
          </div>

          {/* 成员列表体（MemberRosterList 三分区） */}
          <div className="p-1">
            <MemberRosterList
              rows={rows}
              showBenched={view === 'all'}
              onEnterChat={(memberId) => {
                const n = buildMemberChatNode(memberId);
                if (n) onEnterChat(n);
              }}
            />
          </div>
        </div>
      </div>

      {/* 右主体：全景（[v0.0.292] 加外层卡片边界；[v0.0.294] 去掉 flex-1/min-w-0 让卡片随内容撑开，整页滚动由外层 overflow-y-auto 负责） */}
      <div className="self-start overflow-x-auto rounded-xl border border-border bg-surface p-4">
        <PanoramaRoute squadId={detail.id} onAtLeader={onAtLeader} />
      </div>
    </div>
  );
}

export default SeatsBody;
