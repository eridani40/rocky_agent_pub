# primitive-key-input

> 层级: primitive
> 文件: app/web/src/components/framework/primitives/key-input.tsx

## 职责
单个配置 key 的**文本输入**控件（schema `type=string`）：展示 key 说明 + 受控输入框。
边界：只管一个 string key 的输入；不含保存逻辑（保存由 `component-key-card` 外层在 group 级触发）。

## Props
- value: string
- onChange: (next: string) => void
- desc?: string;       // key 说明（副文本）
- testId?: string;     // 默认 'key-input'

## 状态 / 交互
- 受控（value 由父级 group state 管理）
- focus 时边框变 terracotta
- 输入只改本地 state，不触发保存

## 复用关系
- 被组合：`component-key-card`（key 卡片根据 key.type 选 input/select/boolean 之一）
- 组合：无（直接用原生 input）
