/**
 * component-ext-impl-ordered — ordered 类型扩展点的实现列表（拖拽排序 + 独立开关）
 * 参考: specs/ui/components/plugin-config-page/component-ext-impl-ordered.md
 *       specs/prd/overall/04-config-center-ui.md §3.9.4
 *
 * 职责：每 impl 同时具备拖拽排序手柄 + 独立 enabled 开关；两者各自独立互不干扰
 * （排序只改 order，开关只改 enabled）。典型场景：handler 类扩展点的执行顺序 + 启停。
 * 边界：拖拽结果通过 onReorder(from,to) 上抛，开关通过 onToggle(implId,next) 上抛；
 * 父级 section-ext-point-area 负责合并持久化。
 */
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DragHandle } from '../framework/primitives/drag-handle';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';
import { ComponentImplConfigBtn } from './component-impl-config-btn';
import { resolveI18nField } from '../../i18n/resolve-i18n-field';

export interface OrderedImpl {
  implId: string;
  pluginId: string;
  enabled: boolean;
  /** [v0.0.18] 显示顺序（1..n，父级按 order 升序传入；顺序号用此值） */
  order: number;
  hasSchemaConfig?: boolean;
  /** [v0.0.18] impl 级描述（来自 inventory description 字段），无则空串不渲染副文本 */
  description?: string;
}

export interface ComponentExtImplOrderedProps {
  pointId: string;
  /** 父级已按 order 升序排好的 impl 列表 */
  impls: OrderedImpl[];
  /** 从索引 from 移到索引 to（父级重排 order） */
  onReorder: (from: number, to: number) => void;
  /** 单项独立翻转 enabled（不影响 order） */
  onToggle: (implId: string, next: boolean) => void;
  onConfig?: (implId: string) => void;
  /** [v0.0.26] 灰显态：未激活 EP 时强制 true，拖拽/开关/配置入口均不可点（继承 default 视图，只读） */
  disabled?: boolean;
}

/**
 * ordered 列表：每行 = 拖拽手柄 + 顺序号 + implId/pluginId/pointId + 开关 + 配置入口。
 * HTML5 DnD：dragStart 记 from 索引，drop 调 onReorder(from, to)。
 * 拖拽手柄与开关是两个独立交互——拖拽不冒泡触发开关，点开关不误触拖拽。
 * [v0.0.26] disabled prop：未激活 EP 时整组灰显（opacity-60 + pointer-events-none），
 *   draggable=false（禁拖）、ToggleSwitch disabled、配置入口不渲染。
 */
export function ComponentExtImplOrdered({
  pointId,
  impls,
  onReorder,
  onToggle,
  onConfig,
  disabled = false,
}: ComponentExtImplOrderedProps) {
  // 当前正在拖拽的项索引（仅本组件内 DnD 视觉，排序逻辑由父级执行）
  const dragFrom = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);
  // [v0.0.62 i18n] impl toggle aria + impl.description 走 plugin-config ns；
  //   description 是 manifest `__MSG_<key>__` 占位符（builtin）或字面（第三方），走 resolveI18nField
  const { t } = useTranslation('plugin-config');

  return (
    <div

      className={
        'flex flex-col gap-1.5 ' +
        (disabled ? 'opacity-60 pointer-events-none' : '')
      }
    >
      {impls.map((impl, idx) => {
        const enabled = impl.enabled;
        const desc = resolveI18nField(impl.description, t);
        return (
          <div
            key={impl.implId}

            // [v0.0.26] disabled 时禁拖（draggable=false）—— 与 pointer-events-none 双保险
            draggable={!disabled}
            onDragStart={(e) => {
              if (disabled) return;
              dragFrom.current = idx;
              // jsdom 测试环境 dataTransfer 可能为 undefined，可选链避免报错
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              if (disabled) return;
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
              setDragOverIdx(idx);
            }}
            onDrop={(e) => {
              if (disabled) return;
              e.preventDefault();
              const from = dragFrom.current;
              dragFrom.current = null;
              setDragOverIdx(null);
              if (from === null || from === idx) return;
              onReorder(from, idx);
            }}
            onDragEnd={() => {
              dragFrom.current = null;
              setDragOverIdx(null);
            }}
            className={
              'flex items-center gap-3 border rounded-md px-4 py-3 transition-colors bg-surface-2 ' +
              (disabled ? 'cursor-not-allowed ' : '') +
              (enabled ? 'border-accent bg-accent-surface' : 'border-border') +
              (dragOverIdx === idx ? ' ring-1 ring-accent' : '')
            }
          >
            <DragHandle />
            <span className="text-muted text-xs w-5 text-right shrink-0">{impl.order}</span>
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
            <ToggleSwitch
              value={enabled}
              onChange={(next) => onToggle(impl.implId, next)}
              actionKey="plugin.impl.toggle"
              label={t('impl.toggleAria', { implId: impl.implId })}
              // [v0.0.26] 未激活 EP 时开关不可点（与 pointer-events-none 双保险）
              disabled={disabled}
            />
          </div>
        );
      })}
    </div>
  );
}

export default ComponentExtImplOrdered;
