/**
 * section-plugin-list — 插件 tab 的插件列表区
 * 参考: specs/ui/components/plugin-config-page/section-plugin-list.md
 *
 * 职责：遍历 inventory.plugins[] 渲染 component-plugin-item。
 * 边界：纯展示 + 转发 toggle；不持有开关状态（每 plugin 独立 state 由父级 page 维护，
 * 严禁多个 plugin 共享 state slice——v0.0.4 plugin 联动 bug 根因）。
 *
 * [v0.0.67] 新增 disabled prop：配置只读化时透传给 component-plugin-item，
 *   plugin toggle 不可点（保留展示）。
 */
import type { PluginListItem } from '../../lib/api-client';
import { ComponentPluginItem } from './component-plugin-item';
import { useTranslation } from 'react-i18next';

export interface SectionPluginListProps {
  /** inventory 顶层 plugins[] 平面列表 */
  plugins: PluginListItem[];
  /** 单 plugin 开关翻转（pluginId 定位，next 翻转后值） */
  onToggle: (pluginId: string, next: boolean) => void;
  /** [v0.0.67] 只读态：透传给 component-plugin-item，toggle 不可点 */
  disabled?: boolean;
}

/**
 * 插件列表：纵向排列，每行委托 component-plugin-item 渲染。
 * 每个 plugin 开关独立——key 用 pluginId 保证 React 不复用同一实例。
 */
export function SectionPluginList({ plugins, onToggle, disabled = false }: SectionPluginListProps) {
  // [v0.0.62 i18n] 空态文案走 plugin-config ns
  const { t } = useTranslation('plugin-config');
  return (
    <div className="flex flex-col gap-2">
      {plugins.length === 0 && (
        <p className="text-muted text-sm">{t('empty.plugins')}</p>
      )}
      {plugins.map((p) => (
        <ComponentPluginItem
          key={p.pluginId}
          plugin={p}
          onToggle={(next) => onToggle(p.pluginId, next)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

export default SectionPluginList;
