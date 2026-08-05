/**
 * primitive-key-input — 单个 key 文本输入 primitive（schema type=string）
 * 参考: specs/ui/components/framework/primitive-key-input.md
 *       设计稿视觉基线: reqs/v0.0.5/easy-opc-config-center-v4.html .f-input（§9）
 *
 * 只管一个 string key 的输入：说明副文本 + 受控 input。不含保存逻辑
 * （保存由 component-key-card 外层在 group 级触发）。
 *
 * 视觉基线（.f-input）：8px 圆角 + 8/12 padding + surface-2 底 + border-2 +
 * JetBrains Mono 13px + w-full + focus 橙边 + 3px accent-light 光晕。
 */
interface KeyInputProps {
  /** 当前值（受控） */
  value: string;
  /** 输入变更回调 */
  onChange: (next: string) => void;
  /** key 说明（副文本，可选） */
  desc?: string;
}

/**
 * key 文本输入：受控原生 input，focus:border-accent + 光晕。
 * 输入只改父级 state，不触发保存。
 */
export function KeyInput({ value, onChange, desc }: KeyInputProps) {
  return (
    <label className="flex flex-col gap-1 w-full">
      {desc && <span className="text-muted text-xs">{desc}</span>}
      <input
        type="text"

        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-border-2 rounded-md px-[12px] py-[8px] bg-surface-2 text-fg text-[13px] font-mono outline-none transition-colors focus:border-accent focus:shadow-[var(--shadow-focus)] hover:border-border-strong"
      />
    </label>
  );
}

export default KeyInput;
