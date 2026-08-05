/**
 * component-tab-tree-item — tab 树单项 button（v0.0.89 新增）
 * 参考: specs/ui/components/app-dev-config-page/component-tab-tree-item.md
 *       reqs/[working] v0.0.89.ui_opt/demo.html（视觉契约：左树 item）
 *
 * 职责：应用设置页左侧 tab 树的单项 button。受控（selected 父级管理），点击上抛 onSelect。
 * 视觉态：active（accent 高亮 + 左侧 accent bar）/ inactive（hover 浅底）。
 *
 * 边界：纯受控，不自管 selected state；不路由；单文件 ≤ 80 行。
 */
interface TabTreeItemProps {
  /** tab id（ET 锚点 tab-tree-item-{tabId}） */
  tabId: string;
  /** 显示文案（已 i18n 解析） */
  label: string;
  /** 当前是否选中 */
  active: boolean;
  /** 点击 tab → 上抛切换 */
  onSelect: () => void;
}

/** tab 树单项 button */
export function TabTreeItem({ tabId, label, active, onSelect }: TabTreeItemProps) {
  return (
    <button
      type="button"
      data-action-key={`settings.tab.open-${tabId}`}
      data-active={active ? 'true' : 'false'}
      aria-current={active ? 'page' : undefined}
      onClick={onSelect}
      className={
        'relative flex items-center gap-2 w-full px-3 py-2.5 rounded-md text-[13px] font-medium transition-colors ' +
        (active
          ? 'bg-accent-surface text-accent'
          : 'text-fg-2 hover:bg-bg-warm hover:text-fg')
      }
    >
      {/* 左侧 accent 竖条（active 时显，绝对定位避免占排版流） */}
      {active && (
        <span
          aria-hidden
          className="absolute -left-2 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-sm bg-accent"
        />
      )}
      <span className="min-w-0 flex-1 text-left truncate">{label}</span>
    </button>
  );
}

export default TabTreeItem;
