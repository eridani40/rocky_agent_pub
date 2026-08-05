/**
 * primitive-key-boolean — 单个 key 布尔开关 primitive（schema type=boolean）
 * 参考: specs/ui/components/framework/primitive-key-boolean.md
 *
 * 生产实现复用 primitive-toggle-switch：说明副文本 + 开关。
 * 关键约束：每个 boolean key 独立绑定独立 state，严禁共享 state 导致联动。
 */
import { ToggleSwitch } from './toggle-switch';

interface KeyBooleanProps {
  /** 当前值（受控） */
  value: boolean;
  /** 翻转回调（参数为翻转后的新值） */
  onChange: (next: boolean) => void;
  /** key 说明（副文本，可选） */
  desc?: string;
}

/**
 * key 布尔开关：有 desc 时 [desc 左 + 开关右]；无 desc 时开关右对齐（适配横向卡片）。
 * 翻转只改父级 state，不触发保存。
 */
export function KeyBoolean({ value, onChange, desc }: KeyBooleanProps) {
  return (
    <div className={'flex items-center gap-2 ' + (desc ? 'justify-between' : 'justify-end')}>
      {desc && <span className="text-muted text-xs">{desc}</span>}
      <ToggleSwitch value={value} onChange={onChange} />
    </div>
  );
}

export default KeyBoolean;
