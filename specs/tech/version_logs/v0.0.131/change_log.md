# v0.0.131 tech change_log — 会话区 2 升级（历史 query minimap + 右上悬浮菜单）

> 类型：纯前端 UI 升级（`app/web/` 渲染层）。无后端 API / schema 变更（复用既有 `/memory/session` + `/session/:id/cron` CRUD）。
> 权威变更契约见同目录 `change_plan.md`（method 级，A-G 组 34 行）。PRD：`specs/prd/version_logs/v0.0.131/change_log.md`。

## 影响子系统 KB

| KB | 改什么 |
|----|--------|
| `specs/tech/app/frontend/` | 概念表加 flatten 单次分发 + 右缘 overlay + 悬浮菜单（`index.md`）；`[P0]component_data_map.md §2` 的 cron 数据行 `SectionCronPanel`→`useCronCrud`（抽出为 hook + `enabled` gate 零网络）+ `useMemoryCrud` 备注补 float-menu badge/弹层消费；`log.md` v0.0.131 条目 |
| `specs/ui/components/chat-page/` | 新增 6 组件 spec（history-minimap / chat-float-menu / chat-right-overlay / memory-modal / cron-modal / memory-editor-fields）；`_overview.md` §1 布局 + §3 清单 + §7 testid；`_components.md` 清单 + testid；`component-workspace-panel.md`（3 tab→1）+ `component-cron-new-form.md`（承载迁 cron-modal）；`section-memory-panel.md` / `component-cron-panel.md` 标 SUPERSEDED |
| `specs/ui/components/studio-page/` | `section-right-tabs.md`（删 showCronTab，右侧仅工作区）+ `_overview.md`（三处 chat 右缘挂 overlay） |

## 摘要

### ① flatten 单次分发（change_plan A/C/D 组）
三处 chat root（`section-chat-detail` / `section-member-chat` / `section-squad-chat`）用 `useFlattenedView(messages, opts)` 单次 flatten → 分发 `ComponentMessageStream`（新增可选 `flattened` prop，不传 fallback 内部 `flattenAndGroup`，零回归）+ 历史 query minimap（`deriveMinimapBars`）。**bar 与 message-stream 同源同一份 `elements`**，保证「bar 数 = 可见右侧 user 气泡数」恒等，不二次 flatten。

- **`deriveMinimapBars(elements, messages, sideResolver?, max=10)`**（`minimap-bars.ts`，纯派生 UT 覆盖）：取 `kind:'user-text'` 元素，用 `sideResolver ?? sideOfMessage`（复用 `component-message-stream` 导出）判侧别，**仅 side==='user'（右侧气泡）才产 bar**（修正「a2a inbox 不产 user-text」误解——a2a `role:'user'` 确产 user-text，靠 side 判定排除群聊左侧 a2a）；preview=该 user-text 后首个 `agent-answer.text`（无则 undefined）；`slice(-max)` 取最近。

### ② 历史 query minimap（change_plan B 组）
`component-history-minimap.tsx`：右缘竖排小 bar + Dock 悬停放大（CSS width transition）+ 左侧预览气泡（query + 回答头部截断）+ 点击 `scrollIntoView` 跳转（按 `anchorTestid` 定位，playground=`msg-user-{id}` / studio=`squad-chat-message-{id}`）。绝对定位 overlay，布局稳定不推动正文。

### ③ 右上悬浮菜单 + 弹层二级视图（change_plan B/C 组）
- `component-chat-right-overlay.tsx`：右缘统一 overlay（`absolute right-3 top-16 z-20` + `pointer-events-none` 容器/`auto` 子，z < usage-panel 展开 z-50/60），承载 minimap（下）+ 悬浮菜单（上）。T2/T3 并行开发过渡：float-menu 经 `children` 插槽传入（`sessionId`/`hideCron` props 保留），详 `component-chat-right-overlay.md §7`。
- `component-chat-float-menu.tsx`：竖向工具条 + 长期记忆/定时任务菜单项 + badge（accent 角标绝对定位，=0 不渲染）。**恒挂载 `useMemoryCrud`+`useCronCrud`**（chat 挂载即取，badge 与弹层同源、弹层开关不重 GET）；`hideCron` gate（squad 群聊 cron 项不挂载 + `useCronCrud(enabled:false)` 零网络）。badge 实时性：用户 CRUD refetch 即时，agent 侧写入非实时（无 memory SSE，known-boundary）。
- `component-memory-modal.tsx` / `component-cron-modal.tsx`：`view:'list'|'editor'` 二级视图（memory 复用 `crud.editor` state；cron 本地持 `form:NewFormState`）+ 顶部返回按钮 + idle 空态；list 态复用 entry-card/job-card，editor 态复用 editor-fields/cron-new-form。**不弹层套 modal**。memory archive 单击直执行无确认层（禁 `window.confirm`）；cron 删除沿用列表项既有二次确认。
- `component-memory-editor-fields.tsx`：从 `component-memory-editor-modal` 抽纯表单字段（无 modal 壳，挂载即编辑态、卸载即取消），弹层二级视图 + app config global scope modal 共用（DRY，testid 前缀 `memory-session`/`memory-user` 不变；editor-modal 从 312→106 行委托 fields，零回归）。

### ④ ws-panel tab 收敛 + 废弃删除（change_plan E 组，不留僵尸）
- `component-ws-tab-bar`：删 memory/cron tab（`ws-tab-memory`/`cron-tab` testid 退役）+ `hideCronTab` prop；单 tab 后进一步删 `WsTab` type + `activeTab`/`onTabChange` props，`ws-tab-workspace` 从 `<button>` 改静态 `<div>`（死切换 state 是僵尸）。
- `section-workspace-panel`：删 memory/cron 分支 + `useState<WsTab>`，恒渲染工作区。
- `section-right-tabs` 删 `showCronTab`；`component-studio-chat-router` 删 `showCronTab` 传递（squad 群聊 cron 显隐迁 float-menu `hideCron`）。
- 删 `section-memory-panel.tsx` / `section-cron-panel.tsx`（内容迁弹层）；`useCronCrud` 抽出（`NewFormState`/`INITIAL_NEW` 迁入 `use-cron-crud.ts`）；`component-cron-new-form` import 源改 `./use-cron-crud` + 去内部重复标题/外层容器（弹层 head 承担标题）。

### ⑤ i18n + UT（change_plan F/G 组）
- i18n 中英双语新增 `minimap.noReply` / `floatMenu.memory` / `floatMenu.cron`（菜单 aria-label/title + 空占位）；memory-modal/cron-modal/editor-fields 全复用既有 key（零新增业务 key）；删孤儿 `workspace.tab.cron`。
- 3 新 UT：`minimap-bars`（真实 `flattenMessages` 产 elements 覆盖 ≤10/边界/a2a 侧别/reminder 过滤/preview 各分支）+ `component-chat-float-menu` badge（=count/=0 隐藏/hideCron gate/enabled=false 零 fetch）+ `use-cron-crud`（GET/toggle·delete refetch/enabled=false 零网络/60s poll）；旧 test 适配删除（section-memory/cron-panel test + ws-tab-bar 断言 + stale stub）。

## 已知边界

- **badge agent 侧写入非实时**：memory 可被 agent（`memory_manage` / evolvable）写入，本版无 memory SSE topic——badge 仅保证「用户 CRUD 即时」，agent 侧写入下次 chat 重挂载 / cron 60s poll 才反映。
- **3 root 文件超 300 行**（message-stream 324 / section-chat-detail 359 / section-member-chat 330）：pre-existing，T4 最小增量；瘦身 + 三处接线块抽共享 hook 留后续版本。
