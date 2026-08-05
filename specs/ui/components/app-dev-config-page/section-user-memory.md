# section-user-memory（应用设置 全局长期记忆 tab）

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/section-user-memory.tsx
> 本文是应用设置「全局长期记忆」tab 右栏配置区的**概念权威源**。

## 1. 定位 + 设计意图 `section-user-memory` 是 `page-app-settings-merged` 的 sidebar **新增 tab「全局长期记忆」**选中后右栏渲染的配置区，列出 global memory 全部 entry（跨 session 稳定的用户偏好/事实/反馈教训/外部参考）。
**global memory 介质 = `<dataDir>/memory/<name>.md`**（per-entry md dir store，与 session/group 同构；旧 app_config `user_memory` record 已退役不回读）——存储 + UI + 运行时注入 + `memory_manage` 工具写全走该 dir store，本 tab 是其 UI 入口。
**与 `section-memory-panel`（chat 右侧 session memory tab）的区别**：
- 本组件管 global 级（跨 session 稳定，应用设置入口，全局一份）
- section-memory-panel 管 session 级（`<session.workspaceDir>/.rocky/memory/`）
- 两者**复用 `component-memory-entry-card` + 编辑 modal**，仅 list 数据源（global dir vs session dir）+ container（settings tab vs ws-panel tab）不同。

## 4. 状态 / 交互
**数据源**：REST CRUD 无 SSE——`GET /memory/global` 列 entry（无 sessionId，全局一份），`POST /memory/global` 新建，`PATCH /memory/global/:id` 编辑，`DELETE /memory/global/:id` 归档；每次操作后 refetch 刷新列表。
- **进入 group** → GET `/memory/global` → 渲染 entries
- **新建**（顶部「新建长期记忆」按钮）→ 弹 modal
- **编辑/归档**（entry 卡 hover 显示按钮）→ 同 section-memory-panel
**待 coder 实现前按设计稿填具体值**。架构阶段约定结构：
- **layout**：右栏 KV key-cards 网格风格（与 appearance/llm_request 一致），但每「行」是一个 entry card 而非 KV pair。顶部「新建长期记忆」按钮（primary accent）；entry 列表垂直滚动 gap 8px。
- **font/color/border**：与 `section-memory-panel` 同源（复用 `component-memory-entry-card`）。
- **group 选中态**：复用 `section-config-layout` 的 group-item active 样式。

## 复用关系
- 被组合：`page-app-settings-merged`（plugin group 之前的 sidebar group）
- 组合：`component-memory-entry-card`（testIdPrefix=`memory-user`）+ 编辑 modal（与 secti
