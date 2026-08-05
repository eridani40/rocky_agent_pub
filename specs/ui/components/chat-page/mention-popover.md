# component-mention-popover

> 层级: component
> 文件: app/web/src/components/chat-page/component-mention-popover.tsx
> 视觉契约: 无设计稿（本版本无视觉契约设计稿，视觉基线由 coder 设计后回填）
> 数据权威: specs/tech/mention/provider-interface.md（MentionItem 结构）

## 职责
@ 触发的多 tab 搜索浮层——顶部 tab 栏 + search input + 滚动结果列表。由 ChatComposer 在 `@` 触发时渲染，绝对定位浮于编辑器上方。
边界：不做搜索执行（→ server `GET /mention/search`）；不做 pill 插入（→ ChatComposer 的 `onSelect` 回调处理）；不做 pill 渲染（→ `MentionPill`）。

## Props
- providers: MentionProviderMeta[]
- query: string
- onSelect: (item: MentionItem) => void
- onClose: () => void
- sessionId: string
- name: string;   // 'file' | 'skill'
- label: string;  // 'Files' | 'Skills'

## 状态 / 交互
### 布局
- **固定尺寸**：宽 = 编辑器宽度（或 360px，取较小值）；高 = 280px（或 viewport 剩余空间）。
- **绝对定位**：浮于编辑器上方（ / `bottom: 100%`），不占文档流空间。
### Tab
- **默认 activeTab**：第一个 provider（通常 `'file'`）。
- **Tab 切换**：点击 tab 按钮 / `Cmd+ArrowLeft/Right` → 切换 activeTab → 触发新 provider 搜索。
### Search Input
- **focus**：面板弹出后自动 focus 到 search input。

## 视觉基线
无设计稿（本版本无视觉契约设计稿）。coder 实现时设计基础样式后回填此章节。
预期基线方向：
- search input： /  /  /  ## 复用关系
- **被组合**：`ChatComposer`（在 `@` 触发时条件渲染）
