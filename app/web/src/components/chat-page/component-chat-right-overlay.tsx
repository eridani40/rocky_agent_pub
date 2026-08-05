/**
 * component-chat-right-overlay —— chat-detail 右缘统一 overlay 容器（L1 floating-chrome）
 * 参考: specs/ui/components/chat-page/_layering.md §2/§3（层次体系单一权威）
 *       specs/ui/components/chat-page/component-chat-right-overlay.md §1/§3（定位/几何）
 *
 * chat root（section-chat-session，7 消费方共用）挂载，
 * 纵向承载「悬浮菜单」（上，经 children 插槽传入）+「历史 query minimap」（下），脱离正文文档流。
 *
 * 层次属性（_layering.md）：L1 floating-chrome / z=`--z-floating`(10) / 无 portal / 容器 pointer-events-none。
 * 仅 footprint（float-menu 本体 + minimap 本体 w-8 列）各自显式 pointer-events-auto（Invariant B），
 * 留白处 none 让 wheel/click 穿透到 message-stream——结构性根治「悬停右缘空白→整会话不滚」（症状 1）。
 */
import type { ReactNode } from 'react';
import { ComponentHistoryMinimap } from './component-history-minimap';
import type { MinimapBar } from './minimap-bars';

interface ChatRightOverlayProps {
  /** 当前 session id（float-menu 内嵌消费；本组件自身不直接使用，透传契约保留） */
  sessionId: string;
  /** 隐藏「定时任务」项（squad 群聊无主 cron）；透传契约保留 */
  hideCron?: boolean;
  /** minimap bar 列表（父层 deriveMinimapBars 派生，≤10） */
  bars: MinimapBar[];
  /** float-menu 组合插槽（消费方传入 <ComponentChatFloatMenu sessionId hideCron />，见 spec §7） */
  children?: ReactNode;
}

/**
 * 右缘统一 overlay：absolute 定位 + pointer-events gate（容器 none，子元素各自 auto）。
 * 承载页根容器需 position:relative（overlay 以其为定位基准）。
 */
export function ComponentChatRightOverlay({ bars, children }: ChatRightOverlayProps) {
  return (
    <div

      className="absolute inset-y-0 right-6 z-[var(--z-floating)] flex flex-col items-end pointer-events-none"
    >
      {/* float-menu：顶部（pt-3 与 topbar 留距）。插槽 div 不再 pointer-events-auto（Invariant B：
          仅 footprint 接事件，由 float-menu 根显式 auto；留白处穿透 wheel 到 message-stream） */}
      {children && <div className="pt-3">{children}</div>}
      {/* minimap：flex-1 占满剩余纵向空间 + items-center 纵向居中（justify-end 贴右）。
          插槽 div 不再 pointer-events-auto（结构性修症状 1：避免 flex-1 撑出透明墙吃 wheel）；
          minimap 本体 w-8 列由其根显式 auto 接 hover/click */}
      <div className="flex-1 flex items-center justify-end min-h-0">
        <ComponentHistoryMinimap bars={bars} />
      </div>
    </div>
  );
}

export default ComponentChatRightOverlay;
