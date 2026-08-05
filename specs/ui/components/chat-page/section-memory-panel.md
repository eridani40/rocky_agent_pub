# section-memory-panel（长期记忆 tab 内容区）
> - 数据 hook `useMemoryCrud` 未删（float-menu 恒挂载驱动 badge + 弹层，见 `[P0]component_data_map.md §2`）。

> 文件: ~~app/web/src/components/chat-page/section-memory-panel.tsx~~

## 4. 状态 / 交互
- **进入 tab** → GET `/memory/session?sessionId=<sid>` → 渲染 entries 列表
- **点 entry 卡片编辑按钮** → `editing = entry` → 弹编辑 modal
- **点「新建」按钮（tab header 右侧 plus icon）** → `editing = 'new'` → 弹空表单 modal
- **保存**（modal 内）→ POST（new）或 PATCH（edit）`/memory/session` → 成功后 refetch 列表 + 关闭 modal
- **点 entry 归档按钮** → DELETE `/memory/session/:name?sessionId=<sid>` → 成功后 refetch（归档项默认隐藏）
- **失败** → toast 提示 + modal 不关
**待 coder 实现前按设计稿填具体值**。架构阶段约定结构：
- **layout**：列表垂直滚动，padding 8px 12px，gap 8px；entry 卡 `flex column gap 4px`，padding 12px 14px，rounded-10px，1px var(--border)。

## 复用关系
- 被组合：`section-workspace-panel`（chat 右侧 ws-panel 长期记忆 tab 内容）+ `section-right-ta
- 组合：`component-memory-entry-card`（单 entry 卡）+ `component-memory-editor-modal`（新
- 与 `section-user-memory`（应用设置全局长期记忆）：list 数据源不同（session vs user scope）+ contain
