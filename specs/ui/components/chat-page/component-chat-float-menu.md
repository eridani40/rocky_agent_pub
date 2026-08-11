# component-chat-float-menu（聊天区右上悬浮菜单 + 弹层二级视图）

> 层级: component
> 文件: app/web/src/components/chat-page/component-chat-float-menu.tsx
> （收纳原 ws-panel「长期记忆」「定时任务」tab → 悬浮菜单 + 弹层；[v0.0.205.t2_cons] 加第 3 菜单项「skills」；[v0.0.223] 加第 4 菜单项「待办 todo」；[v0.0.269] 加第 4 菜单项「团队状态」——skills 与 todo 之间，todo 保持最后 → 共 5 项）
> 视觉参考: 无设计稿（用户裁决视觉由 orchestrator 定，跳过 compare）——走现有 token。

## 消费方

- `components/chat-page/section-chat-session.tsx`

## 1. 定位 + 设计意图（一句话）
聊天区右上方（贴 chat-detail 与 ws-panel 分界处、topbar 下方）一个竖向圆角白色悬浮工具条，纵排「长期记忆」「定时任务」「skills」「团队状态」「待办」五个小图标菜单项（memory/cron/squad-status/todo 带 badge 计数；skills 无 badge——无计数需求）。顺序自上而下 = memory/cron/skills/squad-status/todo（v0.0.269：squad-status 在 skills 下方、todo **上方**——todo 保持最后）。点菜单项弹出对应弹层——memory/cron 弹层内「列表 ↔ 新建/编辑」走**二级视图导航（顶部返回按钮）**，不再弹层套弹层；skills 弹层为 3 tab 只读列表（见 `component-skills-modal.md`）；todo 弹层为双层树只读视图（见 `component-todo-modal.md`）；squad-status 弹层为成员状态分区只读视图（见 `component-squad-status-modal.md`）。三处 chat 页统一复用（由 `component-chat-right-overlay` 承载，见 §8）。

## Props
- sessionId: string
- hideCron?: boolean
- chrome?: SessionChromeView（v0.0.269：已装配 chrome；`currentMemberId = chrome?.memberId` 来源——防套娃判定；studio 单聊=对端 member id，群聊/playground/academy=undefined）

## 4. 弹层：列表 ↔ 二级视图导航（新交互模式，MANDATORY）
- **列表态（默认一级视图）**：
  - 记忆弹层：`view='list'` → 复用 `component-memory-entry-card` 渲染 entry 列表（testIdPrefix=`memory-session`，卡内含 edit/archive 按钮）+ 顶部「新建」按钮。空列表 → **idle 空态**（icon 圆 + muted 文案，`chat:memory.empty`）。
  - cron 弹层：`view='list'` → 复用 `component-cron-job-card` 渲染 cron 列表（含 toggle/delete）+「新建」按钮。空列表 → **idle 空态**（沿用 `cron-empty` 风格）。
  - todo 弹层：无二级视图——双层树只读（主 item + 步骤 + 悬停结构化详情），空态 `chat:todoModal.empty`（见 `component-todo-modal.md`）。
- **二级视图（新建/编辑）**：点「新建」或某条「编辑」→ **同弹层内切 `view='editor'`**，顶部保留**返回按钮**（`{modal}-back`）→ 点返回回 `view='list'`（不改数据）。
  - 记忆 editor：复用 `component-memory-editor-fields`。
  - cron editor：复用 `component-cron-freq-picker` + prompt/name 输入（沿用 `component-cron-new-form` 的表单零件，去掉外层 border 容器改为二级视图内容）。
- **保存**：POST/PATCH（记忆 `/memory/session`、cron `/session/:id/cron`）成功 → 回 `view='list'` + hook refetch + badge 更新；失败 → 弹层内 error 文本 + 留在 editor。
- **归档/删除**：

## 视觉基线
- 悬浮工具条：白底圆角竖条+ 纵排图标按钮（图标 muted，hover fg + ）。
- idle 空态：icon 圆（muted）+ muted 文案（沿用 `cron-empty` / memory empty 现风格）。
- 无 vision_check compare（无设计稿）。

## 7. 状态 / 交互（关键约束）
- 菜单项点击 → 设 `openModal: 'memory' | 'cron' | 'skills' | 'squad-status' | 'todo' | null`（float-menu 持有）→ 挂对应弹层。
- 弹层内 `view` state（list/editor）由弹层组件自持；返回按钮 setView('list')。skills 弹层无二级视图（3 tab 只读），tab state 弹层自持，重开回 session 默认 tab。todo 弹层只读无编辑。squad-status 弹层只读分区列表（v0.0.269，见 `component-squad-status-modal.md`）。
- 关闭弹层（遮罩点击 / 关闭按钮）→ `openModal=null`；重开回列表态。
- 数据 hook（memory/cron/skills/todo）恒挂载于 float-menu（不随弹层开关 mount/unmount）→ 弹层开关不触发重 GET，badge 常驻数据；skills 弹层每次打开由弹层侧调一次 `catalog.refetch()`（PRD UC-S7 重开刷新）；**[v0.0.228] todo 弹层同例**——每次打开由弹层侧调一次 `crud.refetch()`（打开瞬间必最新，与 SSE 实时增量互补）；**[v0.0.269] squad-status 弹层同例**——打开时弹层侧 `refreshDetail()` fire-and-forget（presence 尽量新）。
- **团队状态项（v0.0.269）**：`useSquadStatus()` 读 SquadStatusContext（page-studio chat 分支 Provider 下传，float-menu 在 chat 树内天然包裹）；**无 Provider（playground/academy）→ 按钮不渲染（fail-safe）**；有 Provider → running badge = `deriveRunningCount(detail, memberStateMap)`（deployed 成员 isRunningState 计数含 leader；0 态不显示数字，绝对定位不占文档流）→ 点击 `setOpen('squad-status')` → `ComponentSquadStatusModal`（currentMemberId = `chrome?.memberId ?? undefined` 防套娃）。
- badge 语义：memory=entry 数 / cron=active job 数 / **todo=未完成主 item 数**（status ∉ {done, skipped}，`useTodoCrud.pendingCount`）/ **squad-status=running 成员数**（v0.0.269，0 态不显数字）/ skills 无 badge。
- 可见文案（chat ns）：菜单 aria-label `floatMenu.memory|cron|skills|squadStatus|todo`（zh「长期记忆/定时任务/技能/团队状态/待办」）。

## 复用关系
- 被组合：`component-chat-right-overlay`（右缘统一 overlay，与 `component-history-minimap`
- 组合（child，coder 前置产出 .md/.tsx）：`component-memory-modal`（记忆弹层二级视图）+ `component-cron-modal`（cron 弹层）+ `component-skills-modal`（skills 3 tab 只读弹层，v0.0.205.t2_cons）+ `component-todo-modal`（todo 双层树只读弹层，v0.0.223）+ `component-squad-status-modal`（成员状态分区只读弹层，v0.0.269，studio-page 目录）。
- 数据 hook：`useMemoryCrud`（既有）+ `useCronCrud` + `useSkillsCatalog`（v0.0.205.t2_cons，GET /skill?sessionId= 按 scope 分三组）+ `useTodoCrud`（v0.0.223，Collection 形，API `lib/todo-api.ts`；**[v0.0.228]** 60s polling 退役 → SSE 驱动：`session_todo_changed` 经 useSessionPanelFanout 扇出 → store.lastTodoEvent → hook effect 静默 refetch）+ `useSquadStatus`（v0.0.269，读 SquadStatusContext；无 Provider → 按钮不渲染）。
- 挂载方：`section-chat-session.tsx`（v0.0.269 起传 `chrome={chrome}`——currentMemberId 来源）。
