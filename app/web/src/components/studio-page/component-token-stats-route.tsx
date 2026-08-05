/**
 * component-token-stats-route —— page-studio 主区 token-stats 路由态包装（头部返回键 + 主区容器）
 * 参考: specs/ui/components/studio-page/component-token-stats.md
 *       specs/ui/components/studio-page/component-studio-board-route.tsx（同款路由包装范式）
 *       specs/ui/components/chat-page/component-chat-topbar-back-btn.md（返回按钮 primitive）
 *
 * 职责：token-stats 路由态头部（返回键 + squad 名 + 副标题「squad · Token 统计」）+ 内嵌 TokenStatsPanel。
 *   独立路由态（与 board/panorama 同级），入口 = SeatsPanel tab 条右侧「Token 统计」按钮。
 * 边界：纯展示包装；Panel 自持 state / 数据 fetching。返回键视觉复用 ChatTopbarBackBtn。
 */
import { useTranslation } from 'react-i18next';
import type { SquadDetail } from './squad-types';
import { TokenStatsPanel } from './component-token-stats-panel';
import { ChatTopbarBackBtn } from '../chat-page/component-chat-topbar-back-btn';

interface TokenStatsRouteProps {
  squadId: string;
  detail: SquadDetail;
  /** 顶部返回键 → 回首页 seats */
  onBack: () => void;
}

/** token-stats 路由态包装：头部（返回键 + squad 名 + 副标题）+ TokenStatsPanel */
export function TokenStatsRoute({ squadId, detail, onBack }: TokenStatsRouteProps) {
  const { t } = useTranslation('studio');
  return (
    <main className="flex flex-1 flex-col overflow-y-auto bg-bg">
      {/* 头部：返回键 + squad 名 + 副标题 */}
      <div className="shrink-0 border-b border-border px-8 pb-4 pt-6">
        <div className="mb-2">
          <ChatTopbarBackBtn onClick={onBack} actionKey="studio.token-stats.back" />
        </div>
        <div className="text-[20px] font-bold tracking-tight text-fg">{detail.name}</div>
        <div className="mt-0.5 font-mono text-xs text-muted">{t('tokenStatsRoute.subtitle', 'Token 统计')}</div>
      </div>
      {/* 统计视图主体 */}
      <TokenStatsPanel squadId={squadId} detail={detail} />
    </main>
  );
}

export default TokenStatsRoute;
