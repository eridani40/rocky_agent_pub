/**
 * component-key-card — 单个 key 配置卡片
 * 参考: specs/ui/components/app-dev-config-page/component-key-card.md
 *
 * 职责：展示 label + 说明 + 按 key.type 路由到对应 primitive 输入控件
 *   (string/number → primitive-key-input, enum → primitive-key-choice-cards, boolean → primitive-key-boolean)。
 * 边界：不持本地副本，输入即时上抛 onChange；不做保存（保存由 group-save-bar 在 group 粒度执行）。
 *
 * 输入控件 testid 约定（ET 锚点）：`key-input-{key}` / `key-select-{key}` / `key-boolean-{key}`。
 */
import { useTranslation } from 'react-i18next';
import { KeyInput } from '../framework/primitives/key-input';
import { KeyChoiceCards } from '../framework/primitives/key-choice-cards';
import { KeyBoolean } from '../framework/primitives/key-boolean';

/** key 元信息（type 决定控件类型） */
export interface KeyInfo {
  key: string;
  type: 'string' | 'number' | 'enum' | 'boolean';
  value: string | number | boolean | string[];
  desc?: string;
  /**
   * [v0.0.65 i18n] key label 的 i18n key（如 'schema.appearance.theme.label'，app-dev-config ns）。
   * 提供时 label 走 t() 解析（missing → parseMissingKeyHandler 报错，不 fallback 字面）；
   * 未提供时 fallback {key} 字面（兼容第三方 / 测试 fixture / 未迁调用）。
   */
  labelKey?: string;
  /** type === 'enum' 时下拉选项 */
  options?: string[];
}

interface ComponentKeyCardProps {
  keyInfo: KeyInfo;
  /** 输入变更 → 立即上抛新值（无 debounce） */
  onChange: (next: unknown) => void;
}

/** key 卡片：横向布局——左 [label + 说明]，右 [控件 min-w-280]（设计稿 .key-card / .key-card-top） */
export function ComponentKeyCard({ keyInfo, onChange }: ComponentKeyCardProps) {
  const { key, desc, labelKey } = keyInfo;
  // [v0.0.62 i18n] desc 字段为 i18n key（schema.<group>.<key>.desc），查 app-dev-config ns
  const { t } = useTranslation('app-dev-config');
  // [v0.0.65 i18n] label 走 t(labelKey)（missing 报错不 fallback）；未传 labelKey → fallback {key} 字面（兼容）
  const label = labelKey ? t(labelKey) : key;
  // 缺 key 检测：parseMissingKeyHandler 在 init 时返回「【资源 xxx 不存在】」前缀；非 string/未声明 desc 直展
  const resolvedDesc = desc ? t(desc) : '';
  const descMissing = !resolvedDesc || resolvedDesc.includes('【资源');
  return (
    <div

      className="border border-border rounded-lg py-[16px] px-[20px] mb-[8px] bg-surface-2 transition-colors hover:border-border-strong"
    >
      <div className="flex items-start justify-between gap-4">
        {/* 左：label + 说明（flex-1 收缩，长 desc 换行）—— 设计稿 .key-card-top 左列 */}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-fg">{label}</div>
          {desc && !descMissing && <div className="text-xs text-muted-2 mt-1.5 leading-relaxed">{resolvedDesc}</div>}
        </div>
        {/* 右：控件（shrink-0 固定 280px，对齐设计稿 .key-control） */}
        <div className="shrink-0 w-[280px]">
          <ControlByKeyType keyInfo={keyInfo} onChange={onChange} />
        </div>
      </div>
    </div>
  );
}

/** 按 key.type 路由到对应 primitive 控件；未知 type 降级为只读文本展示 */
function ControlByKeyType({
  keyInfo,
  onChange,
}: {
  keyInfo: KeyInfo;
  onChange: (next: unknown) => void;
}) {
  const { key, type, value, options } = keyInfo;
  // boolean → KeyBoolean（受控开关）
  if (type === 'boolean') {
    return (
      <KeyBoolean
        value={Boolean(value)}
        onChange={(next) => onChange(next)}

      />
    );
  }
  // enum → KeyChoiceCards（选项卡片，替代下拉；testid 沿用 key-select-{key} 保 ET 锚点）
  if (type === 'enum') {
    return (
      <KeyChoiceCards
        value={String(value ?? '')}
        options={options ?? []}
        onChange={(next) => onChange(next)}

      />
    );
  }
  // string → KeyInput（文本）
  if (type === 'string') {
    return (
      <KeyInput
        value={typeof value === 'string' ? value : ''}
        onChange={(next) => onChange(next)}

      />
    );
  }
  // number → KeyInput（数字，原生 input type=number 由 page 层做 Number 转换；
  // v0.0.89：number 容器 testid 改 `key-number-${key}`（替代旧 key-input-，E2E 锚点对齐））
  if (type === 'number') {
    return (
      <div>
        <NumberInput
          value={typeof value === 'number' ? value : (typeof value === 'string' ? value : '')}
          onChange={(next) => onChange(next)}
        />
      </div>
    );
  }
  // 未知 type 降级为只读展示
  return (
    <div className="text-fg-2 text-sm">
      {String(value ?? '')}
    </div>
  );
}

/** number 输入：复用原生 input type=number，受控，onChange 上抛 number 或 NaN 占位字符串。
 *  v0.0.89：testid 移到外层容器（key-number-${key}），input 自身不附 testid（E2E 用 `容器 input` 选择器） */
function NumberInput({
  value,
  onChange,
}: {
  value: number | string;
  onChange: (next: unknown) => void;
}) {
  return (
    <input
      type="number"
      className="w-full border border-border-2 rounded-md px-[12px] py-[8px] bg-surface-2 text-fg text-[13px] font-mono outline-none transition-colors focus:border-accent focus:shadow-[var(--shadow-focus)] hover:border-border-strong"
      value={value}
      onChange={(e) => {
        // 空串保留为字符串（page 处理空值）；非空转 Number
        const raw = e.target.value;
        onChange(raw === '' ? '' : Number(raw));
      }}
    />
  );
}

export default ComponentKeyCard;
