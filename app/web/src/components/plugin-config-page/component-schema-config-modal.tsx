/**
 * component-schema-config-modal — impl 的 schema 配置弹层
 * 参考: specs/ui/components/plugin-config-page/component-schema-config-modal.md
 *       specs/prd/overall/04-config-center-ui.md §3.9.5
 *
 * 职责：按 configSchema（JSON Schema）字段 type 渲染控件（string/number/boolean/enum/object），
 * 用户编辑 draft，保存通过 onSave 上抛（稀疏 delta），取消/× 丢弃 draft（遮罩点击不关闭，防误丢输入）。
 * 边界：只管按 schema 渲染 + 收集值；不感知扩展点类型、不校验复杂规则。
 *
 * [v0.0.71 D4] 加 readOnly prop：true 时所有控件 disabled（fieldset disabled）+ 隐藏保存按钮。
 *   用于 v0.0.67 整页只读化下「点击齿轮 → 只读查看 impl 配置」（ onSave 不再被调用）。
 * [v0.0.71 D7] 字段源从 schemaConfig（SchemaConfigEntry map）→ configSchema（JSON Schema）。
 *   控件路由按 JSON Schema properties.<key>.type：
 *     - 'string' + `enum: [...]` keyword → select（KeyChoiceCards 读 enum 字段，非旧 options）
 *     - 'string'（无 enum）→ input
 *     - 'number' / 'integer' → 数字 input
 *     - 'boolean' → switch
 *     - 'object' → 分组（嵌套 properties 递归，每组带标题）
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { JsonSchema } from '../../lib/api-client';
import { KeyInput } from '../framework/primitives/key-input';
import { KeyChoiceCards } from '../framework/primitives/key-choice-cards';
import { KeyBoolean } from '../framework/primitives/key-boolean';
import { resolveI18nField } from '../../i18n/resolve-i18n-field';

export interface ComponentSchemaConfigModalProps {
  implId: string;
  /** [v0.0.71 D7] impl 的 configSchema（JSON Schema 形状，从 manifest 透传） */
  configSchema?: JsonSchema;
  /** 当前值（受控初始值，来自 impl.config） */
  value: Record<string, unknown>;
  /** 是否打开 */
  open: boolean;
  /** 关闭（取消/×） */
  onClose: () => void;
  /** 保存回调（draft 全量上抛，父级/后端按稀疏 delta 处理） */
  onSave: (v: Record<string, unknown>) => void;
  /** [v0.0.71 D4] readOnly 模式：true 时所有字段 disabled + 隐藏保存按钮（仅展示） */
  readOnly?: boolean;
}

/**
 * [v0.0.71 D7] 从 configSchema 取 properties map（JSON Schema 标准）。
 * 兜底 undefined / 非对象 → 空对象（modal 渲染空字段表）。
 */
function extractProperties(schema: JsonSchema | undefined): Record<string, JsonSchema> {
  if (!schema || typeof schema !== 'object') return {};
  const props = (schema as { properties?: unknown }).properties;
  if (!props || typeof props !== 'object') return {};
  return props as Record<string, JsonSchema>;
}

/**
 * [v0.0.71 D7] 取字段定义中的 enum 候选值（JSON Schema 标准 enum keyword）。
 * T4 交接：原 schemaConfig.type='enum'+options 现映射为 configSchema `type:'string'+enum:[...]`。
 */
function extractEnumOptions(def: JsonSchema): string[] {
  const opts = (def as { enum?: unknown }).enum;
  if (!Array.isArray(opts)) return [];
  return opts.map((v) => String(v));
}

/**
 * schema 弹层：open=false 不渲染；open=true 渲染遮罩 + 居中弹层。
 * 内部 draft 拷贝 value，编辑只改 draft；按 configSchema 字段 type 分发渲染控件。
 * [v0.0.71 D4] readOnly=true 时整个字段表 wrap `<fieldset disabled>` 隔绝交互 + 隐藏保存按钮。
 */
export function ComponentSchemaConfigModal({
  implId,
  configSchema,
  value,
  open,
  onClose,
  onSave,
  readOnly = false,
}: ComponentSchemaConfigModalProps) {
  // [v0.0.62 i18n] schema 标题走 plugin-config ns；通用关闭/取消/保存走 common ns
  const { t } = useTranslation('common');
  const { t: tp } = useTranslation('plugin-config');
  // draft 仅在 open=true 时初始化一次（open 切回 false 时清空避免脏读）
  const [draft, setDraft] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (open) setDraft({ ...value });
  }, [open, value]);

  if (!open) return null;

  const properties = extractProperties(configSchema);

  /** 单字段渲染：按 configSchema 字段 type 分发到对应 primitive */
  const renderField = (key: string, def: JsonSchema) => {
    const propDef = def as {
      type?: string;
      default?: unknown;
      description?: string;
      enum?: unknown;
    };
    const cur = draft[key] ?? propDef.default ?? '';
    const set = (next: unknown) => setDraft((d) => ({ ...d, [key]: next }));
    // description 是 manifest `__MSG_<key>__` 占位符（builtin）或字面（第三方/未改造），
    // 走 resolveI18nField 统一处理（plugin-config ns 含 plugin.builtin.* 查表）
    const desc = resolveI18nField(propDef.description, tp);
    const type = propDef.type;
    // enum 字段：JSON Schema 标准 `type:'string' + enum:[...]`（T4 交接：原 schemaConfig.options 改读 enum）
    if (type === 'string' && Array.isArray(propDef.enum)) {
      return (
        <div key={key} className="flex flex-col gap-1.5">
          {propDef.description && <span className="text-muted text-xs">{desc}</span>}
          <KeyChoiceCards
            value={String(cur ?? '')}
            options={extractEnumOptions(def)}
            onChange={(next) => set(next)}

          />
        </div>
      );
    }
    switch (type) {
      case 'number':
      case 'integer':
        return (
          <label key={key} className="flex flex-col gap-1">
            {propDef.description && <span className="text-muted text-xs">{desc}</span>}
            <input
              type="number"

              value={String(cur ?? '')}
              onChange={(e) => set(Number(e.target.value))}
              // [v0.0.71 D4] readOnly 时显式 disabled（fieldset disabled 在真浏览器也禁用，
              //   显式属性保证 jsdom/旧浏览器一致性，ET `input.disabled===true` 锚点可靠通过）
              disabled={readOnly}
              className="border border-border rounded-sm px-3 py-2 bg-surface text-fg text-sm focus:outline-none focus:border-accent"
            />
          </label>
        );
      case 'boolean':
        return (
          <KeyBoolean
            key={key}
            value={Boolean(cur)}
            onChange={(next) => set(next)}
            desc={desc}

          />
        );
      case 'object':
        // object 分组：当前 schemas 无嵌套 object 字段，此处仅展示子 properties 的 description 列表
        // （不是递归渲染输入控件）。若未来 impl 用嵌套 object，需补 renderField 递归。
        // v0.0.71 D7：从 schemaConfig.type='object' 改读 JSON Schema type:'object'。
        const subProps = extractProperties(def);
        return (
          <fieldset key={key} className="border border-border rounded-sm p-3">
            <legend className="text-fg-2 text-sm px-2">{desc || key}</legend>
            <div className="flex flex-col gap-2">
              {Object.entries(subProps).map(([subKey, subDef]) => (
                <div key={subKey} className="text-xs text-muted">
                  {String((subDef as { description?: string }).description ?? subKey)}
                </div>
              ))}
            </div>
          </fieldset>
        );
      case 'string':
      default:
        return (
          <KeyInput
            key={key}
            value={String(cur ?? '')}
            onChange={(next) => set(next)}
            desc={desc}

          />
        );
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div
        className="bg-surface border border-border rounded-md p-4 w-96 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-fg text-sm">{tp('schemaConfig.title', { implId })}</h3>
          <button
            type="button"
            data-action-key="plugin.impl.close-config"
            onClick={onClose}
            aria-label={t('modal.close')}
            className="text-muted hover:text-fg text-sm"
          >
            ×
          </button>
        </div>
        {/* [v0.0.71 D4] readOnly 模式：fieldset disabled 浏览器原生隔绝所有 form 控件交互
            （input/button/select/checkbox 全 disabled，无需逐个传 disabled prop）。
            非 readOnly 模式 fieldset 不带 disabled 属性，控件正常可编辑。 */}
        <fieldset
          disabled={readOnly}
          className={readOnly ? 'opacity-80' : ''}
          style={readOnly ? { border: 'none', padding: 0, margin: 0 } : { border: 'none', padding: 0, margin: 0 }}
        >
          <div className="flex flex-col gap-3">
            {Object.entries(properties).map(([key, def]) => renderField(key, def))}
          </div>
        </fieldset>
        {/* [v0.0.71 D4] readOnly=true 时隐藏保存按钮（ onSave 不再被调用，只剩取消/×）。
            保留 cancel/× 按钮作为关闭入口（cancel 在 readOnly 下仍可点 → 触发 onClose）。
            非 readOnly 模式渲染保存按钮（兼容未来恢复写入路径）。 */}
        {!readOnly && (
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              data-action-key="plugin.impl.cancel-config"
              onClick={onClose}
              className="px-3 py-1.5 text-sm text-fg-2 border border-border rounded-sm hover:bg-bg-warm"
            >
              {t('action.cancel')}
            </button>
            <button
              type="button"
              data-action-key="plugin.impl.save-config"
              onClick={() => {
                onSave(draft);
                onClose();
              }}
              className="px-3 py-1.5 text-sm text-surface bg-accent rounded-sm"
            >
              {t('action.save')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ComponentSchemaConfigModal;
