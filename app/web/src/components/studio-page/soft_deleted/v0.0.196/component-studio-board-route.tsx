/**
 * component-studio-board-route —— page-studio 主区 board 路由态包装（头部 + 返回键 + SquadBoard）
 * 参考: specs/ui/components/studio-page/squad-board.md（被组合：page-studio board 路由态）
 *       specs/ui/components/studio-page/_overview.md §1（主区四态：board 路由态独立于 panel/chat/member）
 *       视觉契约: reqs/[done] v0.0.57.squad_ui_1/design/ui-demo.html scene ①（mhead: squad 名 + 副标题 + 三视图 sub-tab）
 *       specs/ui/components/chat-page/component-chat-topbar-back-btn.md（返回按钮 primitive 视觉基线，v0.0.183 共享至 chat-page/）
 *
 * 职责：board 路由态头部（返回键 + squad 名 + 副标题「squad · 看板」）+ 内嵌 SquadBoard 三视图。
 *   头部由本组件自渲染（不复用 squad-panel 头部——board 与 seats 是不同 MainView 态）。
 *   [v0.0.168] 侧栏树删除后，看板唯一入口 = 首页坐席面板团队入口卡；新增返回键回首页 seats。
 * 边界：纯展示包装；SquadBoard 自持 view state / 数据拉取 / 三态。members 未就绪时传空数组（SquadBoard 容错）。
 */
import { useTranslation } from 'react-i18next';
import type { Member, SquadSummary } from './squad-types';
import type { BoardEntityKind } from './board-types';
import { SquadBoard } from './component-squad-board';
import type { BoardMentionPayload } from './component-board-at-button';
import { ChatTopbarBackBtn } from '../chat-page/component-chat-topbar-back-btn';

interface BoardRouteProps {
  squadId: string;
  /** squad 列表（用于按 id 解析 squad 名渲染头部） */
  squads: SquadSummary[];
  /** 当前 detail 的 members（owner/assignee 字典解析）；非当前 squad 时传空数组 */
  members: Member[];
  /**
   * +新建 入口通知回调：parent（page-studio）传任意函数即启用 +新建 按钮；
   *   具体创建逻辑在 SquadBoard 内部 useBoardCreate hook 自治（onCreate 仅作
   *   「parent 已开启 +新建」的开关信号 + side-effect 通知，例如 analytics）。
   */
  onCreate?: (kind: BoardEntityKind, parentGoalId?: string) => void;
  /**
   * 看板 @ 按钮 → 切 leader 对话预填 workitem pill 回路。
   * parent（page-studio）传入 → 透传到 SquadBoard → 3 view → 卡片 hover @ 按钮。
   */
  onAtMention?: (payload: BoardMentionPayload) => void;
  /**
   * [v0.0.168] 顶部返回键 → 回首页 seats；缺省 → 不渲染返回键。
   * 视觉复用 `ChatTopbarBackBtn` primitive（h-8 ghost + ChevronLeft + i18n common:action.back）。
   */
  onBack?: () => void;
}

/** board 路由态包装：头部（返回键 + squad 名 + 副标题）+ SquadBoard 三视图 */
export function BoardRoute({ squadId, squads, members, onCreate, onAtMention, onBack }: BoardRouteProps) {
  const { t } = useTranslation('studio');
  const squadName = squads.find((s) => s.id === squadId)?.name ?? '—';
  return (
    <main className="flex flex-1 flex-col overflow-y-auto">
      {/* 头部：返回键 + squad 名 + 副标题（沿用 squad-panel 头部视觉；副标题语义=「看板」非「团队看板」） */}
      <div className="shrink-0 border-b border-border px-8 pb-4 pt-6">
        {onBack && (
          <div className="mb-2">
            <ChatTopbarBackBtn onClick={onBack} />
          </div>
        )}
        <div className="text-[20px] font-bold tracking-tight text-fg">{squadName}</div>
        <div className="mt-0.5 font-mono text-xs text-muted">{t('boardRoute.subtitle')}</div>
      </div>
      {/* 看板主体：沿用 squad-panel 内容区宽度约束 + SquadBoard 自渲染 sub-tab 栏
          透传 onCreate 启用 +新建 按钮 + onAtMention 启用 @ 按钮（缺省则隐藏） */}
      <div className="max-w-[920px] px-8 pb-10 pt-5">
        <SquadBoard squadId={squadId} members={members} onCreate={onCreate} onAtMention={onAtMention} />
      </div>
    </main>
  );
}

export default BoardRoute;
