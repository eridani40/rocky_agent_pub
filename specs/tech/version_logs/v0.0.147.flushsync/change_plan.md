# v0.0.147.flushsync change_plan — 修复 chat composer flushSync lifecycle 警告

## 背景
component-chat-composer.tsx 两处 `useEffect` 在 React commit phase 同步操作 Tiptap editor：
1. 154-156 `editor.setEditable(!disabled)`（disabled 同步可编辑态）
2. 164-173 `editor.chain().insertMention().run()`（initialContent mount 一次注入 pill）—— 报错点 172

操作触发 ProseMirror transaction → `@tiptap/react` 库内部 `flushSync(forceUpdate)` 同步 React 视图 → 撞上「React is already rendering」→ 控制台警告：
`flushSync was called from inside a lifecycle method. React cannot flush when React is already rendering.`

项目自身无 flushSync 调用（grep app/web/src 无匹配），纯库内部触发。是 warning 非 error，不影响功能，但是不推荐写法 + 未来 React 19 升级隐患。

## 修复策略
把 effect 内对 editor 的操作推迟到 lifecycle 之外（microtask），让 Tiptap 内部 flushSync 在 React 空闲时执行。语义不变。

## 变更（method/符号级，8 列）

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|----------|------|---------|------|------|--------|
| chat-page | app/web/src/components/chat-page/component-chat-composer.tsx | disabled 同步 useEffect（setEditable） | 改逻辑 | effect body 内 `editor.setEditable(!disabled)` 包裹到 `queueMicrotask(() => {...})`，推迟出 commit phase | 语义不变（disabled 变更仍同步可编辑态，仅延后一个 microtask）；editor 空判断保留 | req.md | 154-156 |
| chat-page | app/web/src/components/chat-page/component-chat-composer.tsx | initialContent 注入 useEffect（chain.run） | 改逻辑 | ref guard + 空判断保留在外层立即执行；`editor.chain().insertMention().run()` 整体包裹到 `queueMicrotask`，延后执行 | mount 一次注入 + `initialContentInjectedRef` guard 语义不变（guard 仍立即置位防重复）；不调 focus（注释已说明 mount 无需焦点） | req.md | 164-173 |

## 不改的部分
- 事件回调内 editor 操作（handleSubmit `clearContent`:202 / handleSelect `chain.run`:228 / `focus`:242）——非 lifecycle，React 不在 rendering，不触发警告，不动。
- Tiptap 库内部 flushSync——不改库。

## 测试范围
- **UT（coder 写/补）**：① initialContent 注入仍生成 pill（mount 后异步生效）；② disabled 同步 editor 可编辑态；③ 既有 composer UT 回归。
- **豁免 AT/ET**：纯前端、无 API 契约/落库变更（memory ui-only-ut-skip-at-et）。
- typecheck 绿。

## spec 同步（doc-modifier 阶段）
- specs/ui/components/chat-page/chat-composer.md（若提及 lifecycle/effect 行为则补一句 microtask 延迟说明）
- specs/tech/mention/message-content.md（若涉及 initialContent 注入链路）
