/**
 * component-plugin-item — 单个插件项卡片（插件 tab 列表项）
 * 参考: specs/ui/components/plugin-config-page/component-plugin-item.md
 *       设计稿视觉基线: reqs/v0.0.5/easy-opc-config-center-v4.html .plugin-card（§9）
 *
 * 职责：展示单个 plugin 的 logo(首字母) + 名称 + 已启用徽章 + 描述 + 启用开关。
 * 边界：只管本 plugin，**不感知其他 plugin**——独立性是 v0.0.4 plugin 联动 bug 修复核心。
 *
 * 视觉基线（.plugin-card）：surface-2 底 + 10px 圆角 + 16/20 padding + 40×40 logo
 * （font-sans 首字母；启用=sage）+ name 14/600 + 已启用 sage 徽章 + desc 12 mono +
 * enabled 时左侧 3px sage 边。插件本身无 configSchema（无齿轮，与设计稿一致）。
 */
import type { PluginListItem } from '../../lib/api-client';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';
import { useTranslation } from 'react-i18next';
import { resolveI18nField } from '../../i18n/resolve-i18n-field';

export interface ComponentPluginItemProps {
  /** 单个 plugin（label/description/enabled 来自 inventory 顶层 plugins[]） */
  plugin: PluginListItem;
  /** 开关翻转回调（参数为翻转后的新值） */
  onToggle: (next: boolean) => void;
  /** [v0.0.67] 只读态：toggle 不可点（保留展示） */
  disabled?: boolean;
}

/** 单个插件项：logo + 名称(+已启用徽章) + 描述 + 开关。开关独立，仅反映本 plugin.enabled。
 *  [v0.0.67] disabled=true：ToggleSwitch disabled，整卡片 opacity-60 视觉只读提示。 */
export function ComponentPluginItem({ plugin, onToggle, disabled = false }: ComponentPluginItemProps) {
  // [v0.0.62 i18n] plugin 配置页 UI 文案走 plugin-config ns；label/description 是 manifest
  //   声明的 `__MSG_<key>__` 占位符（builtin）或字面文案（第三方/未改造），统一走 resolveI18nField
  const { t } = useTranslation('plugin-config');
  const name = resolveI18nField(plugin.label, t) || plugin.pluginId;
  const description = resolveI18nField(plugin.description, t);
  return (
    <div

      className={
        'flex items-center gap-3.5 border border-border rounded-[10px] py-[16px] px-[20px] mb-2 bg-surface-2 transition-colors ' +
        (disabled ? 'opacity-60 ' : 'hover:border-border-strong ') +
        (plugin.enabled ? 'border-l-[3px] border-l-sage' : '')
      }
    >
      {/* plugin-logo：40×40，首字母，font-sans bold；启用=sage 底/字，未启用=bg-warm/fg-3 —— .plugin-logo */}
      <div
        className={
          'shrink-0 w-10 h-10 rounded-[10px] flex items-center justify-center font-sans font-bold text-base ' +
          (plugin.enabled ? 'bg-sage-bg text-sage' : 'bg-bg-warm text-fg-3')
        }
      >
        {name.charAt(0)}
      </div>
      <div className="flex flex-col flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-fg truncate">{name}</span>
          {plugin.enabled && (
            <span className="shrink-0 text-[10px] font-bold font-mono uppercase tracking-wide px-1.5 py-0.5 rounded bg-sage-bg text-sage">
              {t('plugin.enabledBadge')}
            </span>
          )}
        </div>
        {plugin.description && (
          <span className="text-xs text-muted font-mono truncate mt-0.5">{description}</span>
        )}
      </div>
      <ToggleSwitch
        value={plugin.enabled}
        onChange={onToggle}
        actionKey="plugin.plugin.toggle"
        label={t('plugin.toggleAria', { name })}
        disabled={disabled}
      />
    </div>
  );
}

export default ComponentPluginItem;
