# primitive-toggle-switch

> 层级: primitive
> 文件: app/web/src/components/framework/primitives/toggle-switch.tsx

## 职责
受控开关。纯展示 + 点击翻转，无业务语义，全 app 最小复用单元。
边界：不持有业务状态、不调 API、不感知「插件/扩展点」等概念——只接收 `value` + `onChange`。

## Props
- value: boolean;                 // 当前开/关
- onChange: (next: boolean) => void;  // 点击翻转后回调
- label?: string;                 // aria-label（无障碍）
- testId?: string;                // 默认 'toggle-switch'
- disabled?: boolean;             // 灰显不可点（未激活 EP 下 ext-impl-ordered 开关只读）

## 状态 / 交互
- 受控（value 由父级管理），点击 → `onChange(!value)`
- 选中态 terracotta ，未选 ；圆点 `translate-x` 滑动
- 无障碍：`role="switch"` + `aria-checked`，键盘 Space/Enter 可触发（原生 button）
-  disabled=true：button `disabled` + ，点击/键盘均不触发 onChange（用于 ext-impl-ordered 未激活 EP 灰显态）
- **关键约束**：本组件本身无「联动」逻辑——联动与否由父级决定。父级用它控制多个 plugin 开关时，必须每个开关独立绑定独立 state，**严禁共享 state 导致联动**

## 复用关系
- 不依赖任何其他组件
