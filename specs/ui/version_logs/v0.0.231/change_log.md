# v0.0.231 — UI Change Log（playground 会话列表：即时排序 + 置顶）

> 增量变更。全量权威：`specs/ui/components/chat-page/_overview.md` §4.1/§4.2（组件契约）+ `specs/ui/overall/00-app-guide.md` §3.1（操作路径）。
> 对应 PRD：`specs/prd/version_logs/v0.0.231.md`；技术契约：`specs/tech/version_logs/v0.0.231/change_plan.md` + `specs/api/version_logs/v0.0.231/change_log.md`。
> 范围：仅 playground 会话列表；academy/studio 列表零变化。无设计稿 → 视觉保真 compare 跳过。

## §1 组件 spec 更新（architect 概念先落，doc-modifier 核对代码一致）

### `specs/ui/components/chat-page/_overview.md`

- **§4.1 section-conversation-list**：
  - 新增「列表统一排序契约」（补落 doc 缺口——原 spec 无列表排序规则）：列表顺序 = 置顶组在前、非置顶组在后，同组内 `updatedAt desc`；排序是常驻属性，前端 chat-slice 单一比较器 `compareSessionsForList` 统一计算，`setSessions` + `applySessionMetaEvent` 两写路径收敛重排；新建/对话/置顶切换/重拉即时归位，无需手动刷新；重排不动状态（active/unread/running/suspended/subagent 树不变）；`GET /session` 后端顺序契约不变（置顶分组纯前端展示层归位）。
  - 右键菜单新增「置顶 / 取消置顶」项：在「复制 Session ID」之上；文案按 pinned 派生；点击 → `PUT /session/:id {pinned: !current}`（fire-and-forget，无乐观更新）→ `session_meta` 广播 → 比较器归位（多端一致）；i18n `chat:convPanel.pin` / `convPanel.unpin`；仅 playground 顶层会话。
- **§4.2 component-conversation-item**：
  - 新增 `pinned`（派生，非 prop）：`s.pinned === true` → pin 图标 + 置顶背景。
  - 新增 pinned 视觉基线：pin 图标最右侧常驻（`PinIcon` 12px text-muted，absolute `top-2 right-2` 零 reflow；title 行 pinned 时 `pr-5` 让位）；背景三层级 白底 < pinned 常态 `bg-bg-warm` < active `bg-[var(--surface-3)]`（active 统一替换原 bg-accent-surface，保持最强）；unread 红点 `right-2` → `right-[18px]` 统一位移与 pin 错位共存；两组之间无组头/分隔线。

### `specs/ui/overall/00-app-guide.md`

- **§3.1 Playground**：新增「会话列表排序 + 置顶」操作路径段——排序规则（两组各自 updatedAt desc、即时归位）+ 置顶操作（右键菜单「置顶/取消置顶」在复制 Session ID 之上、pin 图标 + 背景加重、跨重启保留）。「照手册能从 nav-rail 点到置顶功能」成立。

## §2 实现核对（doc-modifier 阶段 5）

| 实现文件 | 与 spec 一致性 |
|---|---|
| `app/web/src/store/chat-slice.ts` `compareSessionsForList` + setSessions/applySessionMetaEvent 收敛 | 与 §4.1 统一排序契约一致（pinned 降序优先、同组 `updatedAt desc`、spread 不 mutate 入参、biz 守卫原样） |
| `app/web/src/components/chat-page/section-conv-panel.tsx` 右键菜单置顶项 | 与 §4.1 一致（复制 ID 之上、文案按 pinned 派生走 t()、fire-and-forget、data-action-key `chat.session.pin`） |
| `app/web/src/components/chat-page/component-conversation-item.tsx` pinned 视觉 | 与 §4.2 视觉基线一致（PinIcon absolute top-2 right-2 / bg-bg-warm / active surface-3 / pr-5 让位 / unread right-[18px]） |
| `app/web/src/components/chat-page/icons.tsx` PinIcon + i18n 双语言 | 与 §4.1/§4.2 一致（zh「置顶/取消置顶」/ en「Pin/Unpin」） |

无静默偏离。ET `playground-session-pin` 10 步留证全绿（`states/v0.0.231/verify/e2e/`）。
