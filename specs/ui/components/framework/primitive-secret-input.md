# primitive-secret-input

> 层级: primitive
> 文件: app/web/src/components/framework/primitives/secret-input.tsx

## 职责
敏感值（API Key / Token 等需要脱敏展示的字段）的**四态机输入控件**：在「空 / 编辑中明文 / 已保存 mask / 非空只读 + 编辑按钮」四态间流转，提交语义 = commit（父级据此标 dirty），**不含落库逻辑**（落库由表单级 save 负责）。
边界：
- 不管普通文本 key。
- 不落库、不发请求；只负责值流转 + dirty 信号。
- 不做 secret 的持久化决策（仅 commit 上抛，落库由表单级 save 触发）。

## Props
- value?: string
- onCommit: (next: string) => void
- onCancel?: () => void
- desc?: string
- placeholder?: string
- disabled?: boolean
- testId?: string

## 四态机
**实现上 c 与 d 是同一展示态**（mask + 编辑按钮）：c 是概念上「提交瞬间的目标态」，d 是稳态。组件只需区分 `display` / `editing` 两种 mode；display 下根据 value 是否空分两种 sub-UI。
### 提交语义（commit ≠ save）
- **✓ = commit**：把 draft 写回父级 value，父级标 dirty。**不立即落库**。
- 落库由表单级 save 触发。
- 父级 dirty 标记决定是否启用表单级 save。
### 按键 / 焦点
| 触发 | 行为 |
|------|------|

## 视觉基线
无专属设计稿；沿用  的 `.f-input` 规格。
- 展示态脱敏文本：与 input 同盒模型（同 padding/bg/border），便于状态切换无跳动。
- **展示态容器宽度约束**：display 态容器带 ——长 key（mask 后总长 = 真实长，可能很长）不撑破父布局，超出容器宽度时横向滚动而非撑宽/换行。 使 flex item 可收缩（覆盖 flex 默认 ）， 封顶父宽， 提供横向滚动。修复 BUG-002：长 key 展示时压破配置面板布局。
- 右侧动作按钮：固定 （36px）方钮，✓ / ✎ 图标；空态隐藏（slot 保留 `visibility:hidden` 防布局跳动）。

## 复用关系
- 被组合：`component-provider-fields`（provider apiKey 字段）、`section-web-search-config
- 组合：无（直接用原生 input + button）。
- 待接入（未来）：`component-key-card`（secret 类 key，替换 key-input 调用）—— 未排期，YAGNI。

## 接入状态
| # | 文件 | testId | 字段 | 父级 dirty 对接 |
|---|------|--------|------|----------------|
**删旧情况**：3 处均物理删除旧 password input 相关代码，grep 0 残留：
- `skCleared`（observability 旧 state，编辑态手动清空逻辑）—— 删
- `handleSkFocus`（observability 旧 onFocus 事件）—— 删
- `inputCls`（observability 旧 input className 常量）—— 删
- 旧 `<input type="password">` JSX —— 删
