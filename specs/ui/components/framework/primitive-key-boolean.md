# primitive-key-boolean

> 层级: primitive
> 文件: app/web/src/components/framework/primitives/key-boolean.tsx

## 职责
单个配置 key 的**布尔开关**控件（schema `type=boolean`）：展示 key 说明 + 开关。
边界：只管一个 boolean key 的翻转；不含保存逻辑；**开关独立**（不联动其他 key）。

## Props
- value: boolean
- onChange: (next: boolean) => void
- desc?: string;       // key 说明
- testId?: string;     // 默认 'key-boolean'

## 状态 / 交互
- 受控（value 由父级管理），翻转 → `onChange(!value)`
- **关键约束**：每个 boolean key 独立绑定独立 state，严禁共享 state 导致联动（同  约束）

## 复用关系
- 被组合：`component-key-card`
