# primitive-mention-pill

> 层级: primitive
> 文件: app/web/src/components/chat-page/primitive-mention-pill.tsx
> 视觉契约: 无设计稿（本版本无视觉契约设计稿，视觉基线沿用 v0.0.45 既有样式）
> 数据权威: specs/tech/mention/message-content.md（mention tag flat 属性 icon/label/badge）

## 职责
内联 mention 胶囊渲染——在输入区（Tiptap editor node view）和消息区（历史回放）**共用同一个 pill 组件**，按 `{ icon, label, badge? }` 三字段渲染，**完全 type-agnostic**（无 `if (type === ...)` 分支）。
- 删除 `deriveMentionLabel`（path 末段 hack）
- 新增 `Glyph` registry：icon key → SVG，一次性注册 7 个 glyph
- INV-2：加新 type = provider 给新 icon key + registry 注册对应 SVG，渲染逻辑零改动
边界：不做搜索/选择（→ `MentionPopover`）；不做编辑器交互（→ `ChatComposer`）；不做消息发送（→ `ChatComposer.onSend`）。

## Props
- icon: string
- label: string
- badge?: string
- onRemove?: () => void

## 状态 / 交互
- **只读渲染**：显示 `@{label}` 文本（前缀 `@` 由 renderer/composer 加，不在 label 里）为内联胶囊
- **badge**：`badge === 'leader'` → 在 icon 旁渲染皇冠 SVG；其他值省略
- **输入区 pill**：传 `onRemove` → Tiptap atom node 整颗删除时由编辑器触发
- **消息区 pill**：不传 `onRemove` → 纯展示
- **无 hover 效果**

## 视觉基线
无设计稿。沿用 v0.0.45 既有 pill 样式（不破坏视觉一致性）：
- icon：12px / accent 色
- label： /
- badge：8px / accent 色（皇冠，紧贴 icon 右侧）

## 复用关系
- **被组合**：
- `ChatComposer` — Tiptap inline node view（输入区 pill，传 `onRemove`）
- `component-mention-render.tsx` `MentionRender` — 用户消息中的 mention node（消息区 pill，
- **组合**：无（原子组件，内部仅 Glyph/Badge registry 静态映射）
- **依赖**：无外部依赖（SVG 内联，不引图标库）
