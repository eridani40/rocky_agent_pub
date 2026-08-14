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

## 超限提示（v0.0.346）
- **数据源**：服务端响应 `truncated: true`（命中集合 files+dirs 合计 ≥ 100 早停截断，仅 true 时输出）→ `SearchState.truncated`。
- **渲染条件**：`state.truncated && state.items.length > 0` → 结果列表底部渲染提示（`data-action-key="chat.mention.search-too-many"`），**不阻塞「加载更多」滚动翻页**——翻页 append 时 truncated 保留透传（`data.truncated === true || (append ? s.truncated : false)`）。
- **i18n key**：`mention.searchTooMany`
  - zh-CN：「结果超过 100 条，请细化输入」（老板钦定逐字）
  - en：「Over 100 results, please refine your input」
  - 与 `workspace.preview.searchTooMany` 不同 key（互不误动）。

## icon + 路径展示（v0.0.346-2，问题 4）
- **icon 渲染（仅 file provider）**：`item.type === 'file'` 才渲染上排 icon——目录（`item.isDir === true` 严格比较）`FolderIcon`（gold `text-gold`）/ 文件 `FileIcon`（muted `text-muted`），size 13，复用 `./icons`（icons.tsx，对齐工作区搜索 ws-tree-item ws-ico 样式）；`data-testid="mention-item-icon-{dir|file}"`。
- **下排路径始终展示（file provider）**：`(item.type === 'file' || item.listView.subtitle)` —— file 条目无条件渲染 subtitle（provider 保证根路径 `'/'` 或 dirname 非空，无空 div）；非 file provider 有 subtitle 才渲染（保持现状）。
- **非 file provider 兜底**：skill/member/workitem 无 `isDir`——不渲染 icon、不崩溃，保持纯文本现状。

## 视觉基线
无设计稿（本版本无视觉契约设计稿）。coder 实现时设计基础样式后回填此章节。
预期基线方向：
- search input： /  /  /  ## 复用关系
- **被组合**：`ChatComposer`（在 `@` 触发时条件渲染）
