# chat-placeholder

> 层级: section
> 文件: app/web/src/components/studio-page/section-chat-placeholder.tsx

## 职责
占位 chat 页（点 sidebar 树内 群聊/leader/mate 节点进入，占用主区）：topbar（标题 + tag）+ 居中占位 banner「该对话能力在 v0.0.33.2 上线」+ 静态预览气泡 + **禁用输入框**。本版不接 LLM。边界：纯占位，无真实对话；banner 友好提示（**非 error**）。

## Props
- node: { sessionId: string; title: string; tag: string }; // ChatNode

## 状态 / 交互
- 无内部状态；纯展示。输入框 `disabled`（占位文案「v0.0.33.2 上线后可输入」）。返回上一面板 = 点 sidebar squad 行（sidebar 常驻）。

## 视觉基线
- **布局**：主区 flex column（topbar + 消息区居中 + 输入区底），`animate-[fadeIn]` 入场。

## 复用关系
- 被组合: `page-studio`（主区三态之一）
- 组合: `studio-icons`
