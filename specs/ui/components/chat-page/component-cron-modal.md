# component-cron-modal（定时任务弹层，二级视图）

> 层级: component
> 文件: app/web/src/components/chat-page/component-cron-modal.tsx
> （被 `component-chat-float-menu` 承载，取代 ws-panel「定时任务」tab）
> `crud` prop 下传，与 badge 同一实例 —— **不在本组件内重新调用 `useCronCrud`**）

## 消费方

- `components/chat-page/component-chat-float-menu.tsx`

## Props
- sessionId: string
- crud: CronCrud
- onClose: () => void

## 状态 / 交互 `view = form.open ? 'editor' : 'list'`。
- **list 态**：
  - `crud.jobs.length===0` → idle 空态（`cron-empty`，沿用既有 `⏰` + 文案风格）。
  - **删除二次确认**：点删除 → `setConfirmDel(job)` → 覆盖式 confirm dialog（`absolute
- **editor 态（新建，无编辑）**：渲染 `ComponentCronNewForm`（`sessionId`、`form`、`setForm`、 `onCancel={=>setForm(INITIAL_NEW)}`、`onSaved={async=>{setForm(INITIAL_NEW); await
  crud.refetch;}}`）。
  - **无 enabled toggle**（架构裁决，见 `component-chat-float-menu.md §5` 表下注）：POST 缺省 `enabled=true`；enable/disable 由列表项既有 `cron-item-{id}-toggle` 承担，新建表单不重复。
  重开默认回列表态）。

## 视觉基线
无设计稿，走 token（同 `component-memory-modal.md` 遮罩/卡片壳风格）；idle 空态、job-card、
新建表单外观与旧 `section-cron-panel` 一致（原样复用零件，仅去掉整块 tab 容器改为弹层承载）。
