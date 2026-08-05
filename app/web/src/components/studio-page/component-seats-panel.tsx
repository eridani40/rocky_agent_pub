/**
 * component-seats-panel —— Studio 主区团队首页单页中枢（v0.0.170 修订：页头 C 化）
 * 参考: specs/ui/components/studio-page/component-seats-panel.md v1.3
 *       reqs/[working] v0.0.170.squad_home_ui/design-c-console.html（.pagehead / .tabs，视觉契约）
 *
 * 职责：
 *   常驻头部（squad 名 + 在线 badge + 3 tab）+ 按 activeTab 切主体：
 *     - seats: SeatsBody（双列指挥台：左列队长卡/统计/团队 links + 右列 roster 行列表）
 *     - panel: ManageTab（元信息 + 危险区，复用现有）
 *     - autowork: AutoworkTab（toggle + heartbeat + budget + history，复用现有）
 *   本组件内 activeTab 切换 = 首页内联切换，不改父级 mainView。
 * 边界：seats 数据走 use-seats-data；panel/autowork 内容各自子组件管；本容器只透传 handler。
 */
import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Member, PatchSquadBody, SquadDetail } from './squad-types';
import type { SessionState } from '../chat-page/types';
import type { ChatNode } from './chat-node';
import { useSeatsData, deriveViewRows, type SeatsView } from './use-seats-data';
import { ManageTab } from './component-manage-tab';
import { AutoworkTab } from './component-autowork-tab';
import { SeatsBody } from './component-seats-body';
import { StudioContextMenu } from './component-studio-context-menu';
import { PanoramaRoute } from './component-panorama-route';

/** 首页三 tab 内联标识 */
export type SeatsPanelTab = 'seats' | 'panel' | 'autowork';

export interface SeatsPanelProps {
  squadId: string;
  detail: SquadDetail;
  stateMap: Record<string, SessionState>;
  /** seats tab —— 坐席卡进入对话 / 队长卡群聊 */
  onEnterChat: (node: ChatNode) => void;
  onOpenGroupChat: (node: ChatNode) => void;
  /** Token 统计入口（TokenWidget 整卡点击 → MainView token-stats 路由态） */
  onOpenTokenStats?: (squadId: string) => void;
  /** seats tab —— 坐席卡菜单动作 + 「+」卡 */
  onEditMember: (member: Member) => void;
  onBenchMember: (member: Member) => void;
  onDeployMember: (memberId: string) => void;
  onHire: () => void;
  /** panel tab —— squad 元信息 + 危险区 */
  onSaveMeta: (patch: PatchSquadBody) => Promise<void>;
  onDelete: () => Promise<boolean>;
  /** 全景「更多」tab 的「去群聊 @leader」（透传给内嵌 PanoramaRoute → PanoramaIdle） */
  onAtLeader: () => void;
  /** 可选初始 tab（默认 'seats'） */
  initialTab?: SeatsPanelTab;
}

const TABS: { id: SeatsPanelTab; labelKey: string; testid: string; actionKey: string }[] = [
  { id: 'seats', labelKey: 'seats.tab.seats', testid: 'seats-tab-seats', actionKey: 'studio.squad.open-seats-tab' },
  { id: 'panel', labelKey: 'seats.tab.panel', testid: 'seats-tab-panel', actionKey: 'studio.squad.open-panel-tab' },
  { id: 'autowork', labelKey: 'seats.tab.autowork', testid: 'seats-tab-autowork', actionKey: 'studio.squad.open-autowork-tab' },
];

/** SeatsPanel —— 团队首页单页中枢容器 */
export function SeatsPanel({
  squadId,
  detail,
  stateMap,
  onEnterChat,
  onOpenGroupChat,
  onOpenTokenStats,
  onEditMember,
  onBenchMember,
  onDeployMember,
  onHire,
  onSaveMeta,
  onDelete,
  onAtLeader,
  initialTab = 'seats',
}: SeatsPanelProps): ReactNode {
  const { t } = useTranslation(['studio', 'common']);
  const [activeTab, setActiveTab] = useState<SeatsPanelTab>(initialTab);
  const { seats, stats } = useSeatsData(squadId, detail, stateMap);

  // [v0.0.168] 右键浮层菜单 state（复制 Session ID）；触发点=坐席卡 + 首页群聊入口卡
  const [contextMenu, setContextMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  const openContextMenu = useCallback((sessionId: string, x: number, y: number) => {
    setContextMenu({ sessionId, x, y });
  }, []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  /** 单聊 ChatNode 组装（tag 派生规则：leader/mate 两态，与 use-board-at-mention 同源） */
  const buildMemberChatNode = (memberId: string): ChatNode | null => {
    const m = detail.members.find((mm) => mm.id === memberId);
    if (!m) return null;
    return {
      sessionId: m.sessionId,
      title: m.name,
      tag:
        m.role === 'leader'
          ? t('studio:squadTree.tagLeader', { name: detail.name })
          : t('studio:squadTree.tagSingle', { name: detail.name }),
      squadId: detail.id,
    };
  };

  /** 群聊 ChatNode */
  const buildGroupChatNode = (): ChatNode => ({
    sessionId: detail.squadChatSessionId,
    title: t('studio:squadTree.groupChat'),
    tag: t('studio:squadTree.tagGroup', { name: detail.name }),
    squadId: detail.id,
  });

  const onlineCount = stats.onlineCount;
  const leaderRow = seats.find((r) => r.isLeader) ?? null;
  // seats 视图筛选：view state 归 panel（唯一源）；过滤单点 = deriveViewRows
  // （active → 只留 deployed；all → 全量）。SeatsBody/SeatsViewSwitch 受控不持状态不过滤。
  // leaderRow 不受过滤影响（leader 恒 deployed）；页头 onlineBadge/TokenWidget 口径零改。
  const [seatsView, setSeatsView] = useState<SeatsView>('active');
  const mateRows = deriveViewRows(seats.filter((r) => !r.isLeader), seatsView);

  return (
    <main

      className="flex flex-1 flex-col overflow-y-auto bg-bg"
    >
      {/* 常驻主 header：squad 名 + 绿字 online badge + 下划线式 tab 栏；无 header avatar */}
      <div

        className="shrink-0 border-b border-border bg-surface px-6"
      >
        <div className="flex items-center gap-2.5 pt-2.5">
          <span className="truncate text-[15px] font-semibold text-fg">{detail.name}</span>
          <span

            className="flex items-center gap-1.5 text-[12px] font-medium"
            style={{ color: 'var(--presence-online)' }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: 'var(--presence-online)' }}
              aria-hidden
            />
            {t('studio:seats.onlineBadge', { count: onlineCount })}
          </span>
          <div className="flex-1" />
          <div className="flex gap-0.5">
            {TABS.map((tb) => (
              <button
                key={tb.id}
                type="button"
                data-action-key={tb.actionKey}
                data-active={activeTab === tb.id ? 'true' : 'false'}
                onClick={() => setActiveTab(tb.id)}
                className={
                  '-mb-px border-b-2 px-3 py-1.5 text-[12.5px] transition-colors ' +
                  (activeTab === tb.id
                    ? 'border-b-fg font-semibold text-fg'
                    : 'border-b-transparent text-muted hover:text-fg-2')
                }
              >
                {t(tb.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 按 activeTab 切主体 */}
      {activeTab === 'seats' && (
        <>
          <SeatsBody
            detail={detail}
            seats={seats}
            leaderRow={leaderRow}
            mateRows={mateRows}
            stats={stats}
            view={seatsView}
            onViewChange={setSeatsView}
            onEnterChat={onEnterChat}
            onOpenGroupChat={onOpenGroupChat}
            onOpenTokenStats={onOpenTokenStats}
            onEditMember={onEditMember}
            onBenchMember={onBenchMember}
            onDeployMember={onDeployMember}
            onHire={onHire}
            buildMemberChatNode={buildMemberChatNode}
            buildGroupChatNode={buildGroupChatNode}
            onContextMenu={openContextMenu}
          />
          {/* v0.0.240 第二栏：项目全景内嵌（PanoramaRoute 无 onBack；task tab 恒在 + DSL 动态 views） */}
          <section data-action-key="studio.squad.panorama-section" className="border-t border-border px-6 pb-6 pt-6">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-[12px] font-semibold uppercase tracking-wide text-muted">
                {t('studio:seats.sectionPanorama')}
              </span>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-surface">
              <PanoramaRoute squadId={squadId} onAtLeader={onAtLeader} />
            </div>
          </section>
        </>
      )}
      {activeTab === 'panel' && (
        <div className="max-w-[920px] px-8 pb-10 pt-5">
          <ManageTab
            detail={detail}
            onSaveMeta={onSaveMeta}
            onDelete={onDelete}
          />
        </div>
      )}
      {activeTab === 'autowork' && (
        <div className="max-w-[920px] px-8 pb-10 pt-5">
          <AutoworkTab detail={detail} onSaveMeta={onSaveMeta} />
        </div>
      )}

      {/* [v0.0.168] 右键浮层菜单（复制 Session ID） */}
      {contextMenu && (
        <StudioContextMenu
          sessionId={contextMenu.sessionId}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
        />
      )}
    </main>
  );
}

export default SeatsPanel;
