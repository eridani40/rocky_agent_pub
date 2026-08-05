# page-academy（Academy 板块入口）

> 层级: page
> 文件: app/web/src/components/academy-page/page-academy.tsx

## 职责
Academy 板块的根组件与路由分发器。订阅 `?biz=academy` session 列表，按当前 route（classroom / student / training-observe / training-result / version-chat）分发到对应 section；承载 modal 弹层（md-editor / training-create）的开关 state。

边界：不做业务渲染——每个 route 渲染对应 section；modal 由本页顶层挂载（避免 section 重挂丢 state）。

## Props
无 props（读 `useViewStore` 拿 academy 子路由 + 当前选中的 classroomId/studentId/taskId/versionId）。

## 状态 / 交互
- **路由态**（来自 view-store）：`{kind:'classroom-list'} | {kind:'classroom-detail', classroomId} | {kind:'student-detail', classroomId, studentId} | {kind:'training-observe', taskId} | {kind:'training-result', taskId} | {kind:'version-chat', versionId, sessionId?}`。
- **modal 态**（本页 state）：`mdEditor: {open, target} | null` / `trainingCreate: {open, studentId, baseVersionId} | null`。
- **可见文案**（E2E 定位契约）：无直接可见文案（page 是骨架）；可见文案都在各 section / modal 中。

## 复用关系
- 组合 `section-classroom-list`（左 sidebar，常驻）+ 1 个 route section（右主区）+ 可选 1-2 个 modal。
- 消费 view-store 的 `currentView='academy'` 分支（`app-shell.tsx` 路由到这里）。

## 视觉基线
- 设计稿来源：`demo/index.html`（导航）+ `demo/01-classroom-list.html`（空态）。
- 整体三栏外壳由 `app-shell` 提供；本页只填中间 sidebar + 右主区。
- 字体：Inter（标题/正文）+ JetBrains Mono（版本号/分数），两族分工（`specs/tech/app/frontend/[P0]design_system.md §5.2`）。
- 配色：与 Playground/Studio 一致（银灰 token，无专属 hue）。
