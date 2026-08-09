/**
 * component-squad-status-modal —— Squad 成员状态弹层（v0.0.269 自 entry 改造）
 * 参考: specs/ui/components/studio-page/component-squad-status-modal.md（组件契约）
 *       specs/tech/version_logs/v0.0.269/change_plan.md（决策③④：入口拆解）
 *
 * 职责：chat 右上浮菜单「团队状态」按钮点击后的成员状态弹层（L3 modal）：
 *   - running 上 / idle 下分区（derivePanelRows）+ presence 文字 + hover 进入对话 icon
 *   - 防套娃：row.member.id === currentMemberId → 不渲染进入对话 icon（行内容保留——
 *     用户已在其中，点进入=原地跳转无意义；群聊/无当前 chat 上下文 → 全部显示 icon）
 *   - 打开弹层触发一次 refreshDetail（fire-and-forget，presence 尽量新；失败不阻塞旧快照）
 *   - 无 Provider → 不渲染（fail-safe；float-menu 已 gate 按钮，双保险）
 *
 * 数据注入：useSquadStatus() 读 SquadStatusContext（page-studio chat 分支 Provider 下传；
 *   不新增 SSE 订阅——memberStateMap 由 page-studio 已订阅的 session_meta `_all` 派生）。
 * 布局稳定：hover chat icon 用 opacity 保留占位（不 display:none 位移）；防套娃行仅不渲染
 *   icon（avatar/名字/presence 行内容保留）。
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CloseIcon } from '../chat-page/icons';
import { Portal } from '../../lib/portal';
import { useSquadStatus } from './squad-status-context';
import { buildMemberChatNode, derivePanelRows } from './squad-status-utils';
import { MemberRosterList } from './component-member-roster-list';

export interface ComponentSquadStatusModalProps {
  /** 关闭弹层（浮菜单 setOpen(null)） */
  onClose: () => void;
  /** 当前查看 chat 会话所属 member id（studio 单聊 = chrome.memberId；群聊/其他 = undefined）——防套娃判定 */
  currentMemberId?: string;
}

/**
 * Squad 成员状态弹层（L3 modal）。
 * 打开（挂载）即 refreshDetail 一次；遮罩点击 / Esc / 右上关闭三路关闭。
 * [v0.0.288] PanelRowView + 分区渲染委托 MemberRosterList（showBenched=false——弹层天然无 benched）。
 */
export function ComponentSquadStatusModal({ onClose, currentMemberId }: ComponentSquadStatusModalProps) {
  const { t } = useTranslation('studio');
  const ctx = useSquadStatus();

  // L3 modal Esc 关闭（挂载即监听；卸载清理）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // 打开弹层 → 触发一次 refreshDetail（fire-and-forget，presence 尽量新；失败不阻塞旧快照）
  // 注意：必须在 ctx null 守卫之前无条件调用（hooks 规则；ctx null 时跳过刷新）
  useEffect(() => {
    ctx?.refreshDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 无 Provider → 不渲染（fail-safe；float-menu 已 gate 按钮，双保险）
  if (!ctx) return null;

  const { detail, memberStateMap, onEnterChat } = ctx;
  // derivePanelRows 返三区；弹层 showBenched=false → MemberRosterList 只渲 running+idle
  const rows = detail ? derivePanelRows(detail, memberStateMap) : { running: [], idle: [], benched: [] };

  // 面板进入对话：组装 ChatNode → setMainView chat（弹层随 chat 卸载关闭）
  const enterChat = (memberId: string) => {
    if (!detail) return;
    const node = buildMemberChatNode(detail, memberId, t);
    if (node) onEnterChat(node);
  };

  // L3 modal（_layering.md §3A）：包 <Portal> 到 overlay-root，脱离 overlay 的 pointer-events:none 链。
  return (
    <Portal>
      <div
        // z=`--z-modal`(1000) + pointer-events-auto 双保险（与 todo/cron modal 统一规矩）
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[rgba(30,25,20,0.45)] backdrop-blur-sm pointer-events-auto"
        onClick={onClose}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          data-testid="squad-status-modal"
          className="relative flex max-h-[88vh] w-[420px] max-w-[92vw] flex-col rounded-[14px] border border-border-2 bg-surface shadow-2xl"
        >
          {/* head：标题 + 关闭 */}
          <div className="flex shrink-0 items-center gap-2 px-[22px] pb-3 pt-[18px]">
            <span className="flex-1 text-[15px] font-bold text-fg">{t('squadStatus.title')}</span>
            <button
              type="button"
              data-action-key="chat.squad-status.close"
              aria-label={t('common:modal.close')}
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-warm hover:text-fg"
            >
              <CloseIcon size={16} />
            </button>
          </div>

          {/* body：统一成员列表（running+idle 分区） / 加载 */}
          <div className="flex flex-col overflow-y-auto px-[22px] pb-5">
            {!detail ? (
              <div className="px-4 py-6 text-center text-xs text-muted">{t('common:status.loading')}</div>
            ) : (
              <MemberRosterList
                rows={rows}
                currentMemberId={currentMemberId}
                onEnterChat={enterChat}
                showBenched={false}
              />
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default ComponentSquadStatusModal;
