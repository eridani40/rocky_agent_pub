/**
 * page-studio —— Studio 视图页根（左 sidebar + 右主区：seats/chat/member/panorama/token-stats）
 * 参考: specs/ui/overall/06-studio.md（v0.0.168 IA 收敛为单页中枢）
 *       specs/ui/components/studio-page/component-seats-panel.md
 *       specs/ui/components/studio-page/studio-sidebar.md（侧栏树删除）
 *       specs/ui/components/studio-page/component-panorama-route.md（动态 views + more）
 *
 * 边界：nav-rail 由 app-shell 提供；chat 路由由 StudioChatRouter 持有；member 面板独立 section。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HireMemberBody, Member, SquadDetail, SquadSummary } from './squad-types';
import type { MentionAttrs } from '../chat-page/chat-composer-extension';
import { listSquads } from '../../lib/squad-api';
import { useMemberPanelHandlers } from './use-member-panel-handlers';
import { useStudioUnreadMeta } from './use-studio-unread-meta';
import { useSquadMutations } from './use-squad-mutations';
import { StudioSidebar } from './section-studio-sidebar';
import { StudioChatRouter } from './component-studio-chat-router';
import { MemberPanel } from './section-member-panel';
import { MemberCreate } from './section-member-create';
import { TokenStatsRoute } from './component-token-stats-route';
import { NewSquadModal } from './component-new-squad-modal';
import { BenchModal } from './component-bench-modal';
import { SeatsPanel } from './component-seats-panel';
import type { ChatNode } from './chat-node';
import { useViewStore } from '../../store/view-store';
import { Icon } from './studio-icons';
import { BTN_PRIMARY } from './studio-styles';

/**
 * 主区态（v0.0.240：panorama 内嵌首页第二栏，独立路由态删除）：
 *   - seats：**唯一首页**；SeatsPanel 内部 3 tab 内联切换（首页/管理/自动工作）+ 第二栏内嵌 PanoramaRoute
 *   - token-stats：token 统计路由
 *   - chat：真聊（onBack 常驻回 seats）
 *   - member：member 编辑面板（onBack 恒回 seats）
 *   - member-create：成员创建页（v0.0.169）
 */
type MainView =
  | { kind: 'seats'; squadId: string }
  | { kind: 'token-stats'; squadId: string }
  | { kind: 'chat'; node: ChatNode; prefill?: MentionAttrs[] | string }
  | { kind: 'member'; member: Member }
  | { kind: 'member-create' };

type ModalState = null | { kind: 'new-squad' } | { kind: 'bench'; member: Member };

/** Studio 页根 */
export function PageStudio() {
  const { t } = useTranslation(['studio', 'common']);
  const [squads, setSquads] = useState<SquadSummary[]>([]);
  const [selectedSquadId, setSelectedSquadId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SquadDetail | null>(null);
  // v0.0.168：首屏默认 seats（有 squad 时），无 squad 时用 seats 兜底空
  const [mainView, setMainView] = useState<MainView>({ kind: 'seats', squadId: '' });
  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<string | null>(null);

  const { stateMap } = useStudioUnreadMeta();

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }, []);

  // v0.0.168：mutation 后统一回落首页 seats；无选中 squad 时保持空 seats（占位）
  const fallbackToSeats = useCallback(() => {
    if (selectedSquadId) setMainView({ kind: 'seats', squadId: selectedSquadId });
    else setMainView({ kind: 'seats', squadId: '' });
  }, [selectedSquadId]);

  // mutation handler 簇（含 reloadSquads/reloadDetail/refresh 三 fetch 工具）
  const {
    reloadDetail, refresh,
    handleCreateSquad, handleHire, handleBench, handleDeploy,
    handleSaveMeta, handleDeleteSquad,
  } = useSquadMutations({
    selectedSquadId, detail,
    setSquads,
    overwriteSquads: setSquads,
    setSelectedSquadId, setDetail,
    setModalClose: () => setModal(null),
    // v0.0.168 mutation 后统一回落首页 seats（panel 路由已废）
    fallbackToHome: fallbackToSeats,
    flash, t,
  });

  const memberPanel = useMemberPanelHandlers({ squadId: selectedSquadId, detail, onSaved: refresh, flash });

  // 成员创建页提交包装：复用 handleHire 链路（POST /squad/:id/member + refresh + toast）；
  //   成功回首页 seats，失败停留创建页 flash 错误。
  const handleHireSubmit = useCallback(
    async (body: HireMemberBody) => {
      try {
        await handleHire(body);
        fallbackToSeats();
      } catch (e) {
        flash(e instanceof Error ? e.message : t('studio:toast.memberHireFail'));
      }
    },
    [handleHire, fallbackToSeats, flash, t],
  );

  // 挂载：拉 squad 列表 + 自动选中第一个 → landing 'seats'（IA 决策 D7）
  useEffect(() => {
    void (async () => {
      try {
        const list = await listSquads();
        setSquads(list);
        if (list.length > 0 && list[0]) {
          const id = list[0].id;
          setSelectedSquadId(id);
          await reloadDetail(id);
          setMainView({ kind: 'seats', squadId: id });
        }
      } catch { /* 空态兜底 */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 选 squad → 落 seats（唯一首页） */
  const selectSquad = useCallback(
    (id: string) => {
      setSelectedSquadId(id);
      setMainView({ kind: 'seats', squadId: id });
      void reloadDetail(id);
    },
    [reloadDetail],
  );

  // [v0.0.210] academy「派生到团队」预填：view-store 有 prefill 且 squad detail 已就绪
  //   → 自动进成员创建页（mode=derive_academy 由 MemberCreate 自身消费 prefill）。
  //   清 prefill 在 MemberCreate 的 back/submit 完成（一次性消费契约）。
  const studioDerivePrefill = useViewStore((s) => s.studioDerivePrefill);
  useEffect(() => {
    if (studioDerivePrefill && detail && selectedSquadId) {
      setMainView({ kind: 'member-create' });
    }
  }, [studioDerivePrefill, detail, selectedSquadId]);

  const renderEmptyState = () => (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <Icon name="squad" size={40} />
      <div className="text-[15px] font-semibold text-fg-2">{t('studio:empty.title')}</div>
      <div className="max-w-[320px] text-xs text-muted">{t('studio:empty.hint')}</div>
      <button type="button" onClick={() => setModal({ kind: 'new-squad' })} className={BTN_PRIMARY}>
        <Icon name="plus" size={12} /> {t('studio:empty.newBtn')}
      </button>
    </div>
  );

  // —— 主区渲染 chain ——
  let mainArea: React.ReactNode;
  if (mainView.kind === 'seats' && detail && detail.id === mainView.squadId) {
    mainArea = (
      <SeatsPanel
        squadId={mainView.squadId}
        detail={detail}
        stateMap={stateMap}
        onEnterChat={(node) => setMainView({ kind: 'chat', node })}
        onOpenTokenStats={(sid) => setMainView({ kind: 'token-stats', squadId: sid })}
        onOpenGroupChat={(node) => setMainView({ kind: 'chat', node })}
        onEditMember={(m) => setMainView({ kind: 'member', member: m })}
        onBenchMember={(m) => setModal({ kind: 'bench', member: m })}
        onDeployMember={(id) => void handleDeploy(id)}
        onHire={() => setMainView({ kind: 'member-create' })}
        onSaveMeta={handleSaveMeta}
        onDelete={handleDeleteSquad}
        onAtLeader={() => {
          // 业务全景「更多」tab「找 leader 搭看板」：切 leader 单聊 + composer 预填模板请求文本
          const d = detail?.id === mainView.squadId ? detail : null;
          const leader = d?.members.find((m) => m.role === 'leader');
          if (!d || !leader) {
            flash(t('studio:toast.noLeaderAvailable'));
            return;
          }
          const node: ChatNode = {
            sessionId: leader.sessionId,
            title: leader.name,
            tag: t('studio:squadTree.tagLeader', { name: d.name }),
            squadId: d.id,
          };
          setMainView({
            kind: 'chat',
            node,
            prefill: '帮我搭建一个看板，展示…',
          });
        }}
      />
    );
  } else if (mainView.kind === 'seats') {
    mainArea = squads.length === 0
      ? renderEmptyState()
      : <div className="flex flex-1 items-center justify-center text-xs text-muted">{t('common:status.loading')}</div>;
  } else if (mainView.kind === 'chat') {
    const backSquadId = mainView.node.squadId ?? selectedSquadId;
    mainArea = (
      <StudioChatRouter
        node={mainView.node}
        prefill={mainView.prefill}
        onBack={() => {
          if (backSquadId) setMainView({ kind: 'seats', squadId: backSquadId });
          else fallbackToSeats();
        }}
      />
    );
  } else if (mainView.kind === 'token-stats') {
    // token 统计独立路由态（与 panorama 同级）
    const tsSquadId = mainView.squadId;
    const tsDetail = detail?.id === tsSquadId ? detail : null;
    mainArea = tsDetail ? (
      <TokenStatsRoute squadId={tsSquadId} detail={tsDetail} onBack={fallbackToSeats} />
    ) : (
      <div className="flex flex-1 items-center justify-center text-xs text-muted">{t('common:status.loading')}</div>
    );
  } else if (mainView.kind === 'member') {
    // v0.0.168：member-panel 唯一入口 = 坐席卡菜单编辑；返回恒回 seats（无 fromChatNode 分支）
    const editMember = detail?.members.find((m) => m.id === mainView.member.id) ?? mainView.member;
    mainArea = (
      <MemberPanel
        member={editMember}
        onBack={() => {
          fallbackToSeats();
          if (selectedSquadId) void reloadDetail(selectedSquadId);
        }}
        onSave={memberPanel.onSaveMember}
        squadTimezone={memberPanel.squadTimezone}
        squadEnableHeartBeat={memberPanel.squadEnableHeartBeat}
      />
    );
  } else if (mainView.kind === 'member-create') {
    // v0.0.169：成员创建页（替代 hire 弹层）；唯一入口 = seat-add-card；返回/取消/成功均回 seats
    mainArea = detail ? (
      <MemberCreate
        detail={detail}
        onBack={fallbackToSeats}
        onSubmit={handleHireSubmit}
      />
    ) : (
      <div className="flex flex-1 items-center justify-center text-xs text-muted">{t('common:status.loading')}</div>
    );
  } else {
    mainArea = <div className="flex flex-1 items-center justify-center text-xs text-muted">{t('common:status.loading')}</div>;
  }

  return (
    <div className="flex h-full min-h-0">
      <StudioSidebar
        squads={squads}
        selectedSquadId={selectedSquadId}
        onSelectSquad={selectSquad}
        onNewSquad={() => setModal({ kind: 'new-squad' })}
      />
      {mainArea}

      {/* 弹层（v0.0.169：hire 弹层已软删——新增成员走主区 member-create 态） */}
      {modal?.kind === 'new-squad' && <NewSquadModal onClose={() => setModal(null)} onCreate={handleCreateSquad} />}
      {modal?.kind === 'bench' && (
        <BenchModal member={modal.member} onClose={() => setModal(null)} onConfirm={(reason) => void handleBench(modal.member, reason)} />
      )}

      {/* toast（bench/操作最小可见反馈） */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[300] -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-lg bg-fg px-4 py-2.5 text-[12.5px] text-surface shadow-xl">
            <span className="text-accent"><Icon name="info" size={14} /></span>
            {toast}
          </div>
        </div>
      )}
    </div>
  );
}

export default PageStudio;
