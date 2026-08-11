# component-todo-modal（todo 待办弹层 — 双层树只读视图）

> 层级: component
> 文件: app/web/src/components/chat-page/component-todo-modal.tsx
> 视觉基线: **待设计师 demo**（req.md「需要看 demo」；本版按现有 token + cron modal 风格做交互逻辑，字号/色号/几何精修留 demo 到位）
> 需求权威: specs/prd/version_logs/v0.0.223.md §2.6；数据契约: specs/api/overall/20-todo.md

## 消费方

- `components/chat-page/component-chat-float-menu.tsx`

## 职责
session 级 todo 的只读弹层：主 item + 步骤的**双层树视图**，悬停主 item 弹结构化详情（source/output/memo）。
边界：本版**只读**（todo 是 agent 自主维护的工具数据，用户编辑归 follow-up）；不直调 API（crud 由父 component-chat-float-menu 恒挂载后 prop 下传，badge 与弹层同源）。

## Props
```ts
interface ComponentTodoModalProps {
  crud: TodoCrud;   // useTodoCrud 实例（float-menu 恒挂，badge 同源）
  onClose: () => void;
}
```

## 状态 / 交互（含可见文案——E2E 定位契约）
- 打开：float-menu 第 4 项「待办」（aria-label `chat:floatMenu.todo`，zh「待办」）点击 → 挂本弹层（L3 modal，Portal 到 overlay-root，与 cron-modal 同规矩）。**[v0.0.228] 打开即刷新**：弹层每次打开（挂载）由弹层侧调一次 `crud.refetch()`（skills 弹层先例，见 component-chat-float-menu.md §7）。
- 弹层结构：标题栏（`chat:todoModal.title` zh「待办清单」+ 关闭按钮）+ body 列表。
- **尺寸 [v0.0.228]**：宽度响应式 `w-[720px] max-w-[92vw]`（对齐 md viewer/editor 弹层档位；窄屏 92vw 兜底不溢出）；高度 `max-h-[88vh]`，body 内部滚动，标题栏/关闭按钮固定不滚走。
- **双层树**：主 item 行 = 状态徽章（`chat:todoModal.status.*`：未开始/进行中/已结束/已跳过/出错）+ desc + 步骤进度 `步骤 N/M`（steps 非空才渲染）；步骤行缩进在主 item 下 = 状态徽章 + desc。
- **状态徽章色板 [v0.0.228]**：not_started = muted 灰（中性待机）/ in_progress = accent 蓝 / **done = success 绿**（`--success` / `--success-bg` token，与 tool-call「✓ done」同款语义色）/ skipped = muted 灰 + 降透明度（与 done 靠色相拉开）/ error = warning 橙。只用既有 token，零新色值零硬编码 hex。
- **悬停详情 [v0.0.228 收敛 / v0.0.229 收窄 / v0.0.240 触发域迁徽章]**：仅**状态徽章**（item 行最左 STATUS_STYLE 徽章，`data-action-key=chat.todo.item.status`）hover 触发详情弹层（主 item 行其余区域——desc / 步骤进度——以及步骤行 hover 均不触发）；弹层出现在**主 item 行正下方**（absolute overlay 覆盖于步骤层之上，不推挤后续行——布局稳定铁律）；hover 触发域 = **仅状态徽章本身**（v0.0.229 收窄：不再含详情弹层，鼠标移出徽章即收起——防弹层横在行下方遮挡误触发）；source/output/memo 全空的主 item 不弹（既有）。详情内容只读：来源（`chat:todoModal.source.*`：任务/用户消息/Agent + refId）、输出（`chat:todoModal.output.*`：文件/回复会话/回复 Agent + refId）、备忘（memo 纯文本）。点击不做任何事（本版无编辑）。
- 空态：`chat:todoModal.empty`（zh「暂无待办」）+ `chat:todoModal.emptyHint`（zh「agent 工作时会自主维护手头待办」）。
- 加载态：`common:status.loading`；错误态：crud.error 文本（role=alert）。
- 关闭：遮罩点击 / 关闭按钮 → onClose；重开回列表态（无二级视图）。

## 数据
- `useTodoCrud(sessionId)`（chat-page/use-todo-crud.ts，仿 useCronCrud）：Collection<TodoItem> 形。**[v0.0.228] SSE 驱动**：`session_todo_changed`（session_panel topic）经 `useSessionPanelFanout` 扇出 → store.lastTodoEvent → hook 内 effect 匹配 sessionId 后静默 refetch（GET+mutateCtx，无 loading 闪烁）；60s polling 已退役。打开弹层 refetch 兜底打开瞬间必最新。
- badge（float-menu 侧）= 未完成主 item 数（status ∉ {done, skipped}）。badge 与弹层列表同一 hook 数据源（同源不变量）——SSE 触发 refetch 后两处同时更新。

## 复用关系
- 被组合：`component-chat-float-menu`（第 4 菜单项，skills 下方）。
- 组合：lib/portal（Portal）+ icons（CloseIcon）；数据 hook `useTodoCrud`；API 薄封装 `lib/todo-api.ts`。
- 风格参照：`component-cron-modal`（L3 modal 壳 + 空态风格）。

## 版本
v0.0.223 新建（只读双层树 + 悬停详情；视觉待 demo）。v0.0.228 SSE 实时化（session_todo_changed 替换 60s 轮询）+ 打开 refetch + 宽度响应式 720px 档 + hover 弹层收敛（主 item only + 正下方）+ done 徽章 success 绿。v0.0.229 hover 触发域收窄（移出主 item 行即收，不再含弹层）。v0.0.240 hover 触发域从主 item 行迁到状态徽章（`data-action-key=chat.todo.item.status`，主 item 行其余区域不再触发）。
