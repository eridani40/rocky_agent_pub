/**
 * component-history-minimap —— 历史 query minimap
 * 参考: specs/ui/components/chat-page/component-history-minimap.md（概念权威源：数据契约/交互/视觉基线）
 *       specs/ui/components/chat-page/component-history-minimap.tsx（architect 实现示意原型）
 *
 * 聊天区右缘一列纵向堆叠的小横条（bar），每条对应一条渲染为右侧 user 气泡的历史消息
 * （由父层 `deriveMinimapBars` 派生后经 props 传入，见 minimap-bars.ts）。
 * 悬停 Dock 放大（CSS width transition，右锚向左延伸）+ 左侧预览气泡（query + 回答头部截断），
 * 点击滚动跳转到该 query 消息（按全局 id 约定 `msg-${messageId}` 定位，message-stream 行设置）。
 * 仅作定位辅助，不展全文。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MinimapBar } from './minimap-bars';

interface HistoryMinimapProps {
  /** 父层派生的 bar 列表（≤20，时间序旧→新；上限对齐 minimap-bars.DEFAULT_MAX_BARS） */
  bars: MinimapBar[];
}

/**
 * Dock 宽度曲线（px）：到 hover bar 的距离 → 宽度，比例 28(悬停):24:20:16:6(常态)。
 * 收起态 6px，悬停放大到 28px（dist 0），相邻递减 24/20/16。dist 越界（未悬停任何 bar，或距离 >3）落常态 6。
 * v0.0.133 调参：在 v0.0.131 原值（4 / 20·16·12·8）基础上整体放大（用户「在原来基础上变长」）。
 */
const DOCK_WIDTHS = [28, 24, 20, 16] as const;
const DEFAULT_WIDTH = 6;

function barWidth(dist: number | null): number {
  if (dist === null) return DEFAULT_WIDTH;
  return DOCK_WIDTHS[dist] ?? DEFAULT_WIDTH;
}

/**
 * 历史 query minimap：空 bars 不渲染（无独立空态）。
 * hover 状态只用单个 `hoverIndex` state（onMouseEnter 每 bar 记录一次，非逐帧 JS 动画），
 * 宽度/预览气泡展示均由该 state 派生渲染，放大效果交给 CSS width transition。
 */
export function ComponentHistoryMinimap({ bars }: HistoryMinimapProps) {
  const { t } = useTranslation('chat');
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (bars.length === 0) return null;

  // 点击跳转：按全局 id 约定 `msg-${messageId}`（message-stream 行 div 设置）定位目标元素
  const jumpTo = (messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // footprint 任意位置点击 → 跳转当前 hoverIndex 的 bar（命中区从单 bar 扩大到整个 footprint，
  // 详见 spec §4 点击跳转）；per-bar 仅设 hoverIndex，onClick 统一在容器处理以避免双触发。
  const handleFootprintClick = () => {
    if (hoverIndex === null) return;
    const bar = bars[hoverIndex];
    if (bar) jumpTo(bar.messageId);
  };

  return (
    <div
      // pointer-events-auto：footprint = w-8 列（_layering.md §3B：仅 footprint auto）。
      //   overlay 插槽父 div 已改 pointer-events-none，本体需显式 auto 才能接 hover/click。
      className="flex flex-col items-end gap-2 w-8 pointer-events-auto"
      onClick={handleFootprintClick}
      onMouseLeave={() => setHoverIndex(null)}
    >
      {bars.map((bar, index) => {
        const dist = hoverIndex === null ? null : Math.abs(hoverIndex - index);
        const isActive = hoverIndex === index;
        return (
          <div key={bar.messageId} className="relative flex items-center justify-end w-full h-[3px]">
            {/* 悬停预览气泡：绝对定位于 bar 左侧，脱离流不推动布局；仅 hover 该 bar 时渲染 */}
            {isActive && (
              <div
                // L2 popover 性质（_layering.md §2）：z=`--z-popover`；pointer-events-none 不接 click（hover only）
                className="absolute right-full mr-2 top-1/2 -translate-y-1/2 w-[220px] max-w-[240px] bg-surface border border-border rounded-[12px] shadow px-3 py-2 pointer-events-none z-[var(--z-popover)]"
              >
                <div className="text-[12px] font-semibold text-fg truncate">
                  {bar.query}
                </div>
                <div className="text-[11px] text-muted truncate mt-0.5">
                  {bar.preview ?? t('minimap.noReply')}
                </div>
              </div>
            )}
            {/* bar 保留 <button> 供键盘聚焦（a11y）；onClick 上提到 footprint 容器（冒泡统一处理），onMouseEnter 设 hoverIndex */}
            <button
              type="button"
              onMouseEnter={() => setHoverIndex(index)}
              style={{ width: barWidth(dist) }}
              aria-label={bar.query}
              className={`h-[3px] rounded-full transition-[width,background-color] duration-150 cursor-pointer ${
                isActive ? 'bg-accent' : 'bg-muted/50'
              }`}
            />
          </div>
        );
      })}
    </div>
  );
}

export default ComponentHistoryMinimap;
