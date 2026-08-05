/**
 * component-skill-tabs — Skill 页 tab 栏容器
 * 参考: specs/ui/components/skill-page/component-skill-tabs.md
 *       设计稿视觉基线: reqs/v0.0.21/easy-opc-skill-v10.html .skill-tabs/.skill-tab (:80-82)
 *
 * 受控组件：父 page-skill 下发 tabs/active/onChange，不持有激活态。
 * [v0.0.21] 当前仅 1 个 tab「Skill 管理」，预埋多 tab（调用方传 1 项即可）。
 */

/** tab 项（调用方传入） */
export interface SkillTabItem {
  id: string;
  label: string;
}

interface SkillTabsProps {
  /** tab 列表（v0.0.21 传 [{id:'manage', label:'Skill 管理'}]） */
  tabs: SkillTabItem[];
  /** 当前激活 tab id */
  active: string;
  /** 切换 tab 回调 */
  onChange: (tabId: string) => void;
  /** 禁用 tab id 列表（预埋，v0.0.21 不传） */
  disabled?: string[];
  /** 右槽位通用槽（ml-auto self-center）；page-skill 塞「+」安装按钮等。不传时行为不变 */
  actionSlot?: React.ReactNode;
}

/**
 * 渲染 tab 栏。视觉对齐设计稿 .skill-tabs：flex 横排 + 底 1px 分隔线，
 * 每 tab 底 2px 下划线（激活 accent / 非激活 transparent），margin-bottom -1px 压在栏底线上。
 * actionSlot：flex 容器末尾渲染右槽元素，垂直居中、不继承 tab 底下划线。
 */
export function ComponentSkillTabs({ tabs, active, onChange, disabled = [], actionSlot }: SkillTabsProps) {
  return (
    <div

      className="flex gap-1 mb-[18px] border-b border-border"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        const isDisabled = disabled.includes(tab.id);
        return (
          <div
            key={tab.id}
            data-action-key={`skill.tab.open-${tab.id}`}
            role="tab"
            aria-selected={isActive}
            tabIndex={isDisabled ? -1 : 0}
            onClick={() => !isDisabled && onChange(tab.id)}
            onKeyDown={(e) => {
              if (!isDisabled && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                onChange(tab.id);
              }
            }}
            className={
              'text-[13px] font-semibold px-[14px] py-2 border-b-2 -mb-px cursor-pointer transition-colors ' +
              (isActive
                ? 'text-accent border-accent'
                : 'text-muted-2 border-transparent hover:text-fg-2')
            }
          >
            {tab.label}
          </div>
        );
      })}
      {actionSlot && (
        <div className="ml-auto self-center">{actionSlot}</div>
      )}
    </div>
  );
}

export default ComponentSkillTabs;
