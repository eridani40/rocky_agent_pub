/**
 * component-ext-impl-radio — exclusive 类型扩展点的实现列表（radio 单选互斥）
 * 参考: specs/ui/components/plugin-config-page/component-ext-impl-radio.md
 *       设计稿视觉基线: reqs/v0.0.5/easy-opc-config-center-v4.html .impl-row（§9）
 *
 * 职责：同一扩展点内 radio 单选——点未选项触发 onSelect，父级负责把该 impl 设 selected
 * 并取消同 point 其余。impl 带 configSchema 时项内显示齿轮配置入口。
 * 边界：只管同一 point 内单选，不感知其他扩展点。
 *
 * 视觉基线（对齐设计稿 .impl-row）：卡片 border + 8px 圆角 + 12/16 padding + bg-surface-2；
 * 选中 = accent 边框 + accent-surface 底；配置入口 = 28×28 齿轮按钮（hover accent）。
 * 保留原生 <input type=radio>（ext-impl 单测靠 querySelector('input[type=radio]') 驱动）。
 */
import { useTranslation } from 'react-i18next';
import { ComponentImplConfigBtn } from './component-impl-config-btn';
import { resolveI18nField } from '../../i18n/resolve-i18n-field';

export interface RadioImpl {
  implId: string;
  pluginId: string;
  /** 是否为当前选中的实现 */
  selected: boolean;
  /** [v0.0.71 D7] configSchema 存在 → 项内显示齿轮配置入口（旧 schemaConfig 已删） */
  hasSchemaConfig?: boolean;
  /** [v0.0.18] impl 级描述（来自 inventory description 字段），无则空串不渲染副文本 */
  description?: string;
}

export interface ComponentExtImplRadioProps {
  pointId: string;
  impls: RadioImpl[];
  /** 选中某实现；父级负责互斥（取消同 point 其余 selected） */
  onSelect: (implId: string) => void;
  /** 点齿轮配置入口（父级挂载 component-schema-config-modal） */
  onConfig?: (implId: string) => void;
  /** [v0.0.26] 灰显态：未激活 EP 时强制 true，radio/配置入口不可点（继承 default 视图，只读） */
  disabled?: boolean;
}

/**
 * radio 卡片列表：逐项渲染 radio + implId + plugin 来源 + （可选）齿轮配置入口。
 * 已选中项 disabled（互斥语义：取消由「选别的」实现）。
 * [v0.0.26] disabled prop：未激活 EP 时整组灰显（opacity-60 + pointer-events-none），
 *   radio input 强制 disabled，配置入口不渲染（灰显下不可改）。
 */
export function ComponentExtImplRadio({
  pointId,
  impls,
  onSelect,
  onConfig,
  disabled = false,
}: ComponentExtImplRadioProps) {
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
        const selected = impl.selected;
        const desc = resolveI18nField(impl.description, t);
        return (
          <label
            key={impl.implId}

            aria-disabled={disabled || undefined}
            className={
              'flex items-center gap-3 border rounded-md px-4 py-3 transition-colors bg-surface-2 ' +
              (disabled ? 'cursor-not-allowed ' : 'cursor-pointer ') +
              (selected ? 'border-accent bg-accent-surface' : 'border-border hover:border-border-strong')
            }
          >
            <input
              type="radio"
              data-action-key="plugin.impl.select"
              name={`ext-impl-radio-group-${pointId}`}
              checked={selected}
              // disabled 态：自身已选 disabled 或 组 disabled（未激活 EP）
              disabled={selected || disabled}
              onChange={() => onSelect(impl.implId)}
              className="accent-accent shrink-0"
            />
            <div className="flex flex-col flex-1 min-w-0">
              <span className={'text-[13px] font-semibold truncate ' + (selected ? 'text-fg' : 'text-fg')}>
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
            {/* 齿轮配置入口（28×28，hover accent）—— 设计稿 .impl-config-btn。
                [v0.0.71 D4] 删 `!disabled` 守卫，按钮在 disabled（v0.0.67 整页只读）下也渲染。
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

export default ComponentExtImplRadio;
