/**
 * component-ext-impl-checkbox — list 类型扩展点的实现列表（checkbox 独立勾选）
 * 参考: specs/ui/components/plugin-config-page/component-ext-impl-checkbox.md
 *       specs/prd/overall/04-config-center-ui.md §3.9.4
 *
 * 职责：同一扩展点内每 impl 独立勾选启用（互不影响，可同时启用多个或全不启用）。
 * 边界：只管同一 point 内多选；不负责顺序、不感知互斥。
 * 关键约束（对齐 plugin 开关独立性修复）：每 impl.enabled 由父级独立维护，严禁共享 state。
 */
import { useTranslation } from 'react-i18next';
import { ComponentImplConfigBtn } from './component-impl-config-btn';
import { resolveI18nField } from '../../i18n/resolve-i18n-field';

export interface CheckboxImpl {
  implId: string;
  pluginId: string;
  /** 该实现是否启用 */
  enabled: boolean;
  hasSchemaConfig?: boolean;
  /** [v0.0.18] impl 级描述（来自 inventory description 字段），无则空串不渲染副文本 */
  description?: string;
}

export interface ComponentExtImplCheckboxProps {
  pointId: string;
  impls: CheckboxImpl[];
  /** 单项独立翻转 */
  onToggle: (implId: string, next: boolean) => void;
  onConfig?: (implId: string) => void;
  /** [v0.0.26] 灰显态：未激活 EP 时强制 true，checkbox/配置入口不可点（继承 default 视图，只读） */
  disabled?: boolean;
}

/**
 * checkbox 列表：逐项渲染 checkbox + implId/pluginId/pointId + （可选）配置入口。
 * 启用态 terracotta 边框强调。
 * [v0.0.26] disabled prop：未激活 EP 时整组灰显（opacity-60 + pointer-events-none），
 *   checkbox 强制 disabled，配置入口不渲染。
 */
export function ComponentExtImplCheckbox({
  pointId,
  impls,
  onToggle,
  onConfig,
  disabled = false,
}: ComponentExtImplCheckboxProps) {
  // [v0.0.62 i18n] impl.description 是 manifest `__MSG_<key>__` 占位符（builtin）或字面（第三方），
  //   走 resolveI18nField 统一处理（plugin-config ns 含 plugin.builtin.* 查表）
  const { t } = useTranslation('plugin-config');
  return (
    <div

      className={
        'flex flex-col gap-1.5 ' +
        (disabled ? 'opacity-60 pointer-events-none' : '')
      }
    >
      {impls.map((impl) => {
        const enabled = impl.enabled;
        const desc = resolveI18nField(impl.description, t);
        return (
          <label
            key={impl.implId}

            aria-disabled={disabled || undefined}
            className={
              'flex items-center gap-3 border rounded-md px-4 py-3 transition-colors bg-surface-2 ' +
              (disabled ? 'cursor-not-allowed ' : 'cursor-pointer ') +
              (enabled ? 'border-accent bg-accent-surface' : 'border-border hover:border-border-strong')
            }
          >
            <input
              type="checkbox"
              data-action-key="plugin.impl.toggle"
              checked={enabled}
              disabled={disabled}
              onChange={(e) => onToggle(impl.implId, e.target.checked)}
              className="accent-accent shrink-0"
            />
            <div className="flex flex-col flex-1 min-w-0">
              <span className={'text-[13px] font-semibold truncate ' + (enabled ? 'text-fg' : 'text-fg')}>
                {impl.implId}
              </span>
              <span className="text-[11px] text-muted font-mono truncate">
                plugin: {impl.pluginId}
              </span>
              {/* [v0.0.18] impl 级描述副文本（11px muted），空串则不渲染 */}
              {impl.description && (
                <span

                  className="text-[11px] text-muted truncate"
                >
                  {desc}
                </span>
              )}
            </div>
            {/* [v0.0.71 D4] 齿轮按钮恢复：删 `!disabled` 守卫，按钮在 disabled（v0.0.67 整页只读）下也渲染。
                点击齿轮开 readOnly modal（modal 内字段 disabled + 无保存按钮）。 */}
            {impl.hasSchemaConfig && onConfig && (
              <ComponentImplConfigBtn implId={impl.implId} onClick={onConfig} />
            )}
          </label>
        );
      })}
    </div>
  );
}

export default ComponentExtImplCheckbox;
