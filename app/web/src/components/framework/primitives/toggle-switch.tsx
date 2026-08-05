/**
 * primitive-toggle-switch — 受控开关 primitive
 * 参考: specs/ui/components/framework/primitive-toggle-switch.md
 *
 * 全 app 最小复用单元：纯展示 + 点击翻转，无业务语义。
 * 只接收 value + onChange，由父级决定联动与否（每个开关必须独立绑定独立 state，
 * 严禁共享 state 导致联动——v0.0.4 plugin 开关 bug 根因）。
 */
interface ToggleSwitchProps {
  /** 当前开/关 */
  value: boolean;
  /** 点击翻转后回调（参数为翻转后的新值） */
  onChange: (next: boolean) => void;
  /** 无障碍 aria-label（无可见文本时必传） */
  label?: string;
  /** 灰显不可点：未激活 EP 下 ext-impl-ordered 开关只读（继承 default 视图） */
  disabled?: boolean;
  /** ET 稳定语义锚点 data-action-key（命名见 specs/ui/components/_conventions.md §12），可选透传 */
  actionKey?: string;
}

/**
 * 受控开关：terracotta 选中态（bg-accent），未选 bg-border-strong；
 * role=switch + aria-checked 无障碍；原生 button 支持 Space/Enter 键盘触发。
 *
 * 视觉基线（设计稿 .toggle）：36×20（w-9 h-5），未选 border-strong / 选中 accent，
 * radius 100px（rounded-full），knob bg-surface + 轻阴影，开启右移。
 *
 * [v0.0.26] disabled：button disabled + opacity-60 cursor-not-allowed，点击/键盘均不触发 onChange。
 */
export function ToggleSwitch({ value, onChange, label, disabled = false, actionKey }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      data-action-key={actionKey}
      data-enabled={value ? 'true' : 'false'}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => {
        // disabled 时原生 button 已拦截点击；防御性再次短路（jsdom 仍可能冒泡）
        if (disabled) return;
        onChange(!value);
      }}
      className={
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ' +
        (disabled ? 'opacity-60 cursor-not-allowed ' : '') +
        (value ? 'bg-accent' : 'bg-border-strong')
      }
    >
      <span
        aria-hidden
        className={
          'inline-block h-4 w-4 transform rounded-full bg-surface shadow transition-transform ' +
          (value ? 'translate-x-4' : 'translate-x-0.5')
        }
      />
    </button>
  );
}

export default ToggleSwitch;
