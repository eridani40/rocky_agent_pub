# component-key-card

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-key-card.tsx

## 职责
单个 key 的配置卡片：label + 说明 + 按 `key.type` 路由到对应 primitive 输入控件。
边界：不持有编辑态本地副本，输入即时上抛 `onChange`；不做保存（保存由 `component-group-save-bar` 在 group 粒度执行）；不解析 enum 的可选项（options 由 page 透传或 keyInfo 携带）。

## Props
- key: string
- type: 'string' | 'number' | 'enum' | 'boolean'
- value: string | number | boolean | string[]
- desc?: string
- options?: string[]; // type === 'enum' 时使用
- keyInfo: KeyInfo
- onChange: (next: unknown) => void

## 状态 / 交互
- 按 `keyInfo.type` 渲染对应 primitive 控件
- 输入变更 → 立即 `onChange(next)`（无本地 debounce，page 决定何时提交）
- label 始终展示，desc 缺省时省略说明行
- 类型路由约束：type 不在枚举内时降级为只读展示 value

## 复用关系
- 被组合：`section-config-layout`
