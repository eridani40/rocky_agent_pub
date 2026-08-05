# primitive-key-choice-cards

> 层级: primitive
> 文件: app/web/src/components/framework/primitives/key-choice-cards.tsx

## 职责
把若干单选项渲染为**可点卡片组**（少选项 enum 的标准单选控件）。选中 = accent 边框 + bg-accent-surface + 勾；非选中 = border-border + bg-surface-2 + hover。
边界：纯受控（value/onChange），不持状态、不保存；只管「少选项」单选（≤ ~4），多选项须用自定义下拉（见 `_conventions.md` §10，未来 primitive-key-dropdown）。dark/light 选项自动渲染主题预览色块，其余选项仅文本。

## Props
- value: string
- options: string[];              // dark/light 带主题预览色块
- onChange: (next: string) => void
- testId?: string;                // 容器 `${testId}`；每卡 `${testId}-${value}`

## 状态 / 交互
- 点任一卡片 → onChange(该选项 value)
- 选中卡 aria-pressed=true；非选中不渲染勾
- 选项恒定（受控），无内部状态

## 视觉基线
- 主题预览色块（dark/light）： mini 窗口——dark 、light ，内含 accent 条 + 内容条
