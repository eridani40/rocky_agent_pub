# component-board-body-editor（看板 body 正文 markdown 编辑器）

> 层级: component
> 文件: app/web/src/components/studio-page/component-board-body-editor.tsx

## 职责
看板编辑面板**全实体 body 字段**（长正文 markdown）的编辑器——区别于 title（短标题 input）与摘要（Goal.description / Requirement.detail）。沿用 charter-editor 的 textarea + 自适应高度模式（不引入重型 WYSIWYG 编辑器）。
- 全实体（Goal / KR / Requirement / Task）共享同一编辑器组件。
- 输入为 markdown 纯文本；UI 仅做 textarea 渲染（不解析预览，T4 实现时若 coder 想加预览 toggle 可酌情，但非契约要求）。
- 字符上限沿用 store schema（body: text，无硬上限；前端不截断）。

## Props
- entity: 'goal' | 'kr' | 'req' | 'task'
- entityId: string
- value: string
- onChange: (v: string) => void
- placeholder?: string;  // 缺省「补充正文（支持 markdown）...」

## 状态 / 交互
- 受控输入：`value` 来自父组件 local state；input 事件上抛 `onChange`。
- **自适应高度**：min-height 4 行（~96px）；max-height 12 行（~288px）超出滚动；按内容自动增高（ 或 JS 监听 input 调 height）。
- **快捷键**：Cmd/Ctrl+Enter 触发父组件 save（编辑面板根监听，本组件不直接调端点）。
- placeholder 友好提示「补充正文（支持 markdown）...」。

## 视觉基线
- **字体**：（code-friendly，便于编辑 markdown 列表/代码块）；正文颜色 （design_system.md light token）。
- **placeholder**：。
- **滚动条**： + 自定义 webkit-scrollbar 细条（沿用 studio-styles.ts）。
- 沿用 charter-editor.md「字段」段的视觉 token；不硬编码颜色（用 `tokens.css` design token）。

## 复用关系
- **被组合**：`component-board-edit-panel`（每实体编辑面板一个 body-editor 实例）
- **参考**：`charter-editor.md`（视觉基线 + reason input 模式）
- **组合**：`studio-styles.ts`（focus 光晕 + scrollbar 样式）
