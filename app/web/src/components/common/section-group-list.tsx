/**
 * section-group-list — 通用 group 列表 section
 * 参考: specs/ui/components/common/section-group-list.md
 *
 * app-dev config 的 config group 与 plugin config 的扩展点 group 共用本组件
 * （两者结构一致：一组可选项，选中一个）。只管列表展示 + 选中态转发，
 * 不含 group 内部内容渲染（由父级右侧 section 渲染详情）。
 */
import { ComponentGroupListItem } from './component-group-list-item';

/** 单个 group 项（app-dev: config group id；plugin: 扩展点 group） */
export interface GroupItem {
  groupId: string;
  /**
   * [v0.0.65 i18n] group label 的 i18n key（含 ns 前缀，如 'plugin-config:group.provider.label'）。
   * 提供时 component-group-list-item 走 t() 解析；未提供时 fallback {groupId} 字面
   * （兼容第三方 / 测试 fixture / 未迁调用）。
   */
  labelKey?: string;
}

interface SectionGroupListProps {
  /** 全部 group 列表 */
  groups: GroupItem[];
  /** 当前选中 groupId */
  selected: string;
  /** 切换选中回调 */
  onSelect: (groupId: string) => void;
}

/**
 * 通用 group 列表：纵向排列多个 group，逐项委托 component-group-list-item 渲染。
 * 选中态由 active prop 透传给子项（左竖条 + 浅底强调）。
 */
export function SectionGroupList({ groups, selected, onSelect }: SectionGroupListProps) {
  return (
    <div

      className="flex flex-col gap-1 w-[200px] shrink-0 border-r border-border bg-surface p-2 overflow-y-auto"
    >
      {groups.map((g) => (
        <ComponentGroupListItem
          key={g.groupId}
          groupId={g.groupId}
          active={g.groupId === selected}
          onSelect={() => onSelect(g.groupId)}
          labelKey={g.labelKey}
        />
      ))}
    </div>
  );
}

export default SectionGroupList;
