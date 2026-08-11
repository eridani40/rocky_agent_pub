/**
 * component-preview-tab-bar —— 预览区 TabBar（横滑 + chevron + × 关闭 + Tab 键循环）（v0.0.320 D5；[老板第三批]）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D5（TabBar 契约）
 *
 * 功能：tabs 横排（fileName + dirty ● + × 关闭）；横滑容器；
 * 左右 chevron 按钮（[老板试玩修复3] 溢出才显示 + hover 才显示，不溢出完全不渲染）；
 * active 高亮；点击 tab → activateTab；× → closeTab。
 *
 * [老板第三批反馈①] tab 加 title tooltip = 完整路径（hover 显示全路径+文件名）。
 * [老板第三批 Tab 键] 焦点在 tab 区时按 Tab = 循环切下一个 / Shift+Tab = 反向；
 *   复用 activateTab 走编辑态守卫（mode='edit' 弹守卫 modal）。
 *
 * 约束（D5 MUST）：按钮显隐用 opacity/visibility（布局稳定不位移）；
 * dirty 圆点 ● 仅 dirty=true 显示。
 */
import { useCallback, useRef, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { PreviewTab } from './preview-tabs-types';
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from './icons';

interface ComponentPreviewTabBarProps {
  tabs: PreviewTab[];
  activeTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
}

/**
 * 预览 TabBar。[老板试玩修复3] 左右 chevron 仅在 tabs 总宽溢出可视宽度时渲染；
 * 且默认 opacity-0，鼠标 hover TabBar 区域才 opacity-100（group-hover）。
 */
export function ComponentPreviewTabBar({ tabs, activeTabId, onActivate, onClose }: ComponentPreviewTabBarProps) {
  const { t } = useTranslation('chat');
  const scrollRef = useRef<HTMLDivElement>(null);
  // [老板试玩修复3] 溢出检测：scrollWidth > clientWidth → 左右按钮渲染
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 2);
    check();
    // 监听容器尺寸变化（tab 增减 / 容器 resize）
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(check);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [tabs.length]);

  const scrollBy = useCallback((dir: 1 | -1) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  }, []);

  // [老板第三批 Tab 键] Tab/Shift+Tab 循环切换 tab（复用 activateTab 走守卫）
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'Tab' || tabs.length < 2) return;
      e.preventDefault(); // 阻止焦点移走，保持在 tab 区
      const curIdx = tabs.findIndex((t) => t.id === activeTabId);
      const dir = e.shiftKey ? -1 : 1;
      // 首尾循环：(curIdx + dir + len) % len
      const nextIdx = ((curIdx < 0 ? 0 : curIdx) + dir + tabs.length) % tabs.length;
      const nextTab = tabs[nextIdx];
      if (nextTab) onActivate(nextTab.id);
    },
    [tabs, activeTabId, onActivate],
  );

  return (
    <div className="pv-tabbar group flex items-center gap-0.5 px-2 pt-2 pb-1 shrink-0 min-w-0 border-b border-border">
      {/* [老板试玩修复3] 左 chevron：仅溢出才渲染；默认隐藏 hover 显示 */}
      {overflow && (
        <button
          type="button"
          data-testid="pv-tabbar-left"
          aria-label={t('workspace.preview.tabLeft')}
          onClick={() => scrollBy(-1)}
          className="w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted bg-transparent border-none cursor-pointer hover:bg-bg-warm hover:text-fg-2 shrink-0 transition-all opacity-0 group-hover:opacity-100"
        >
          <ChevronLeftIcon size={14} />
        </button>
      )}
      {/* 横滑容器（overflow-x-auto + scroll-smooth；隐藏滚动条视觉） */}
      <div
        ref={scrollRef}
        data-testid="pv-tabbar-scroll"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="pv-tabs flex-1 min-w-0 flex gap-1 overflow-x-auto scroll-smooth outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              data-testid={`pv-tab-${tab.id.replace(/[^a-zA-Z0-9]/g, '-')}`}
              data-active={active ? 'true' : 'false'}
              title={tab.subtitle}
              className={`pv-tab group/tab flex items-center gap-1 px-2 py-1 rounded-md text-[12px] whitespace-nowrap shrink-0 cursor-pointer select-none border transition-colors ${
                active
                  ? 'bg-accent text-white border-accent'
                  : 'text-muted border-border bg-surface hover:bg-bg-warm hover:text-fg-2'
              }`}
              onClick={() => onActivate(tab.id)}
            >
              {/* dirty ●（仅 dirty=true 显示） */}
              {tab.dirty && (
                <span data-testid={`pv-tab-dirty-${tab.id.replace(/[^a-zA-Z0-9]/g, '-')}`} aria-hidden className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
              )}
              <span className="max-w-[160px] overflow-hidden text-ellipsis">{tab.fileName}</span>
              {/* × 关闭（stopPropagation 防触发激活） */}
              <button
                type="button"
                data-testid={`pv-tab-close-${tab.id.replace(/[^a-zA-Z0-9]/g, '-')}`}
                aria-label={t('workspace.preview.closeTab', { name: tab.fileName })}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className="w-[16px] h-[16px] rounded-[3px] flex items-center justify-center bg-transparent border-none cursor-pointer hover:bg-black/10 hover:text-inherit shrink-0"
              >
                <CloseIcon size={11} />
              </button>
            </div>
          );
        })}
      </div>
      {/* [老板试玩修复3] 右 chevron：仅溢出才渲染；默认隐藏 hover 显示 */}
      {overflow && (
        <button
          type="button"
          data-testid="pv-tabbar-right"
          aria-label={t('workspace.preview.tabRight')}
          onClick={() => scrollBy(1)}
          className="w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted bg-transparent border-none cursor-pointer hover:bg-bg-warm hover:text-fg-2 shrink-0 transition-all opacity-0 group-hover:opacity-100"
        >
          <ChevronRightIcon size={14} />
        </button>
      )}
    </div>
  );
}

export default ComponentPreviewTabBar;
