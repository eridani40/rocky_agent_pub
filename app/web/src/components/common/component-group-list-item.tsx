/**
 * component-group-list-item — 单个 group 列表项 component
 * 参考: specs/ui/components/common/component-group-list-item.md
 *       设计稿视觉基线: reqs/v0.0.5/easy-opc-config-center-v4.html .group-item（§9）
 *
 * section-group-list 内部的最小单元：展示 group label + 选中态视觉。
 * 受控（active 由父级 groupId === selected 计算），点击转发 onSelect。
 *
 * [v0.0.65 i18n Batch3] label 经 i18n 化：调用方传 labelKey（含 ns 前缀，如
 * 'app-dev-config:group.appearance.label'）→ t(labelKey) 解析；missing 走 parseMissingKeyHandler
 * 报错（§3 规则4，不 fallback 字面）。未传 labelKey 时 fallback {groupId} 字面（向后兼容第三方/未迁调用）。
 *
 * 视觉基线（对齐设计稿 .group-item）：padding 9/12、rounded 8px、13px/500；
 * active = bg-accent-surface + text-accent + 左侧 3px×20px 竖条（绝对定位，居中，
 * 右侧圆角）。
 *
 * 布局稳定性：竖条用绝对定位（仅 active 时渲染），脱离文档流，切换不位移。
 */
import { useTranslation } from 'react-i18next';

interface ComponentGroupListItemProps {
  /** group 唯一标识（app-dev: config group id；plugin: 扩展点 group） */
  groupId: string;
  /** 是否当前选中（由父级计算） */
  active: boolean;
  /** 点击该项 */
  onSelect: () => void;
  /**
   * testid 前缀（默认 `group-list-item`，拼接 `${prefix}-${groupId}`）。
   * app-dev config 页 ET 锚点用 `group-item-`，通过此 prop 注入避免内联重复实现。
   */
  testIdPrefix?: string;
  /**
   * i18n label key（含 ns 前缀，如 'app-dev-config:group.appearance.label' /
   * 'plugin-config:group.provider.label'）。提供时走 t() 解析，missing →
   * parseMissingKeyHandler 返回「【资源 xxx 不存在】」（不 fallback 字面，强制 keys 对齐）。
   * 未提供时 fallback {groupId} 字面（兼容第三方 / 未迁调用 / 测试 fixture）。
   */
  labelKey?: string;
}

/**
 * 单个 group 列表项：active 时 bg-accent-surface + text-accent + 左侧 3px 竖条；
 * 非 active text-muted-2 + hover:bg-bg-warm。
 */
export function ComponentGroupListItem({
  groupId,
  active,
  onSelect,
  labelKey,
}: ComponentGroupListItemProps) {
  // [v0.0.65 i18n] useTranslation() 默认 common ns；labelKey 含 ns 前缀时 i18next 跨 ns 解析
  const { t } = useTranslation();
  // labelKey 提供 → t() 解析（missing 走报错，不 fallback）；未提供 → groupId 字面（兼容）
  const label = labelKey ? t(labelKey) : groupId;
  return (
    <button
      type="button"
      data-action-key={`common.group.open-${groupId.replace(/_/g, '-')}`}
      data-active={active ? 'true' : 'false'}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      className={
        'relative flex items-center gap-2 w-full px-3 py-2.5 rounded-md text-[13px] font-medium transition-colors ' +
        (active
          ? 'bg-accent-surface text-accent'
          : 'text-muted-2 hover:bg-bg-warm hover:text-fg')
      }
    >
      {/* 激活态左侧 3px×20px 竖条（绝对定位居中，右侧圆角）—— 对齐设计稿 .group-item.active::before */}
      {active && (
        <span aria-hidden className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-r-sm bg-accent" />
      )}
      <span className="min-w-0 flex-1 text-left truncate">{label}</span>
    </button>
  );
}

export default ComponentGroupListItem;
