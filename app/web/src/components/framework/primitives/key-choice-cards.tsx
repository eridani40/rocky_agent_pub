/**
 * key-choice-cards — 选项卡片组 primitive
 * 参考: specs/ui/components/framework/primitives/（替代 enum 下拉的「好看选择框」）
 *
 * 职责：把若干选项渲染为可点卡片（选中 = accent 边框 + 浅底 + 勾），替代下拉。
 *   适用少量选项的 enum；选项多（>4）时应改回下拉。
 * 边界：纯受控（value/onChange），不持状态。
 *
 * v0.0.165：删 ThemeSwatch（theme KV 已下线，THEME_OPTS 分支无消费方）。
 *
 * testid：容器 `${testId}`；每张卡 `${testId}-${value}`。
 */
interface KeyChoiceCardsProps {
  /** 当前选中值 */
  value: string;
  /** 选项列表 */
  options: string[];
  /** 选中某项 → 上抛其 value */
  onChange: (next: string) => void;
  /** testid 前缀（容器 `${testId}`；每卡 `${testId}-${value}`） */
  testId?: string;
}

/** 选项卡片组 */
export function KeyChoiceCards({ value, options, onChange, testId }: KeyChoiceCardsProps) {
  return (
    <div className="flex gap-2 w-full">
      {options.map((opt) => {
        const selected = opt === value;
        return (
          <button
            key={opt}
            type="button"

            aria-pressed={selected}
            data-selected={selected ? 'true' : 'false'}
            onClick={() => onChange(opt)}
            className={
              'flex-1 flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ' +
              (selected ? 'border-accent bg-accent-surface' : 'border-border bg-surface-2 hover:border-border-strong')
            }
          >
            <span className="flex items-center justify-between gap-2">
              <span className={'text-[13px] font-medium capitalize ' + (selected ? 'text-accent' : 'text-fg-2')}>
                {opt}
              </span>
              {selected && (
                <svg
                  aria-hidden
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-accent shrink-0"
                >
                  <path d="M5 12l5 5L20 7" />
                </svg>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default KeyChoiceCards;
