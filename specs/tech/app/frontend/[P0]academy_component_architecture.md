# v0.0.210 Academy — 前端组件架构与清单

> 定位：academy 板块前端的**总纲**（分层 + 命名 + 目录 + 文件级清单）。具体每个组件 spec 由 coder 编码前置产出（先 spec 后实现）。
> 标准：`specs/ui/components/_conventions.md`（五层粒度 primitive/component/section/page/framework + i18n + 视觉基线 + testid 规范）。

## 1. 分层与目录结构

```
app/web/src/components/academy-page/
├── page-academy.tsx                       # page 层：板块入口 + 路由分发
├── section-classroom-list.tsx             # section 层：教室列表 + 资源概览
├── section-classroom-detail.tsx           # section 层：教室详情（左 head 对话 + 右学生/资源）
├── section-student-detail.tsx             # section 层：学生详情（版本树）
├── section-training-observe.tsx           # section 层：训练观察页（coach 对话 + 右训练视图）
├── section-training-result.tsx            # section 层：采纳对比页（diff system/memory/skills）
├── section-version-chat.tsx               # section 层：版本会话（复用 playground-rocky 设计）
├── component-classroom-card.tsx           # component 层
├── component-student-card.tsx
├── component-version-tree.tsx             # 版本树（正式/过程，平铺+base 文案，复用 v0.0.203 平铺规范）
├── component-training-status-bar.tsx      # 任务状态条（pending/running/turn N/maxTurns/awaiting_confirm）
├── component-iteration-timeline.tsx       # 多轮迭代卡（倒序、折叠、decision 三色 tag）—— 复用旧 widget-iteration-timeline
├── component-case-table.tsx               # case 评估结果表（题/答/分/level tag/reasoning）—— 复用旧 drawer-eval-records
├── component-score-curve.tsx              # 评分走势（轮次 vs 分数）—— 复用旧 widget-score-curve
├── component-diff-viewer.tsx              # 三段 diff（system/memory/skills 逐项左右对比）—— 复用旧 widget-patch-diff + 复用 v0.0.203 component-version-review
├── component-subagent-tree.tsx            # 优化/评估 subagent 树（进行中可点入口）—— 复用旧 component-subagent-tree
├── component-modal-md-editor.tsx          # 统一 Markdown 弹层（view/edit 切换）—— design.md §8.2；已提升到 common/（跨 academy + workspace 共享），不在 academy-page/ 目录下
├── component-derive-academy-picker.tsx    # squad derive 时二级 select（classroom→student→version）
├── primitive-academy-tab.tsx              # 通用 tab（教室详情右栏：学生/数据集/评估器/skill 切换）
└── primitive-status-badge.tsx             # 状态标签（formal/process/active/adopted/rejected）
```

> `section-classroom-detail` 等复用 `chat-page/base-chat-page.tsx`（design.md §8.1「所有 chat 复用 chat page，不创新」）。

## 2. 文件级变更清单

| 文件路径 | 操作 | 变更内容 |
|------|------|---------|
| `app/web/src/components/academy-page/page-academy.tsx` | 新增 | 板块入口：路由分发到各 section；订阅 `?biz=academy` session 列表；MainView union 加 academy kind |
| `app/web/src/components/academy-page/section-classroom-list.tsx` | 新增 | 教室列表 + 资源概览；左 sidebar 教室 + 资源（数据集/评估器/skill 计数） |
| `app/web/src/components/academy-page/section-classroom-detail.tsx` | 新增 | 教室详情：左 head 对话（复用 BaseChatPage + chat 内核）+ 右内容区（学生卡片网格 + 资源表格） |
| `app/web/src/components/academy-page/section-student-detail.tsx` | 新增 | 学生详情：版本树（component-version-tree）+ 版本卡（component-version-card 类似 component-version-row） |
| `app/web/src/components/academy-page/section-training-observe.tsx` | 新增 | 训练观察页：左 coach 对话（复用 BaseChatPage）+ 右训练视图（task 状态条 + 迭代 timeline + case 表 + 反思盒 + subagent 入口） |
| `app/web/src/components/academy-page/section-training-result.tsx` | 新增 | 采纳 diff 页：三段 diff（system/memory/skills 逐项左右对比） |
| `app/web/src/components/academy-page/section-version-chat.tsx` | 新增 | 学生版本会话页：复用 playground-rocky 设计（chat + 右 ws 面板） |
| `app/web/src/components/academy-page/component-classroom-card.tsx` | 新增 | 教室卡片（logo + 名 + 学生数 + 任务数 + 班主任状态） |
| `app/web/src/components/academy-page/component-student-card.tsx` | 新增 | 学生卡片（名 + 版本数 + 当前正式版 + 最近训练） |
| `app/web/src/components/academy-page/component-version-tree.tsx` | 新增 | 版本树（平铺 + "基于 vX" 文案，复用 v0.0.203 平铺规范；正式版加粗、过程版灰显） |
| `app/web/src/components/academy-page/component-training-status-bar.tsx` | 新增 | 任务状态条（status + currentTurn/maxTurns + 早停提示 + 暂停/停止按钮） |
| `app/web/src/components/academy-page/component-iteration-timeline.tsx` | 新增 | 多轮迭代 timeline（倒序折叠卡 + decision 三色 tag + 展开 case 表） |
| `app/web/src/components/academy-page/component-case-table.tsx` | 新增 | case 评估结果表（question/student_output/score/level tag/reasoning） |
| `app/web/src/components/academy-page/component-score-curve.tsx` | 新增 | 评分走势折线图（轮次 X / avgScore Y） |
| `app/web/src/components/academy-page/component-diff-viewer.tsx` | 新增 | 三段 diff（system/memory/skills 逐项左右对比 + 可展开/关闭；skill 支持整体新增 or 文件级 diff） |
| `app/web/src/components/chat-page/component-subagent-tree.tsx` | 复用 | 优化/评估 subagent 树（running/terminated 分组；running 时「观察 →」入口可点跳只读 transcript）——academy 平行实现已删，`component-train-view-col.tsx` 直接 import chat-page 版（可选 props `flat`/`onOpenNode`/`openNodeLabel`/`terminatedLabel` 承载 academy 形态差异，缺省行为零变化） |
| `app/web/src/components/common/component-modal-md-editor.tsx` | 已提升到 common/ | 统一 Markdown 弹层（view/edit 双 mode 切换）；跨 academy + workspace 共享，spec `specs/ui/components/common/component-modal-md-editor.md` |
| `app/web/src/components/academy-page/component-derive-academy-picker.tsx` | 新增 | squad 派生时二级 select（classroom→student→version 三级下拉） |
| `app/web/src/components/academy-page/primitive-academy-tab.tsx` | 新增 | 教室详情右栏 tab 切换（学生/数据集/评估器/skill） |
| `app/web/src/components/academy-page/primitive-status-badge.tsx` | 新增 | 版本/任务状态标签（formal/process/active/adopted/rejected/running/awaiting_confirm） |
| `app/web/src/store/view-store.ts` | 修改 | ViewId 加 `'academy'`；currentView 默认值不变 |
| `app/web/src/components/framework/nav-rail/nav-rail.tsx` | 修改 | 顶部业务区从 2 项（Playground/Studio）扩为 3 项（+ Academy 🎓） |
| `app/web/src/components/framework/app-shell/app-shell.tsx` | 修改 | MainView union 加 academy 分支 → 路由到 `page-academy.tsx` |
| `app/web/src/store/chat-slice.ts` | 修改 | 列表守卫放行 `biz='academy'`；新增 `fetchAcadamySessions(classroomId?)` action |
| `app/web/src/components/chat-page/section-chat-session.tsx` | 复用 | 只读观察：实效 readOnly = 前端 `readOnly` prop ∪ `chrome.readOnly`（后端按 `derivation==='subagent'` 判定，api 04a §3.1；design §8 「任意 session 只读」） |
| `app/web/src/components/studio-page/component-new-squad-modal.tsx`（或对应 member-create 入口） | 修改 | Fresh/Derive 选项加第 3 选项「From Classroom」+ 二级 select（classroom→student→version）→ `POST /squad/:id/member {mode:'derive_academy'}` |

## 3. 设计 hook（数据生命周期）

按 architect skill MANDATORY，新数据 hook 必须先出「组件-数据源拆解表」对齐基线 `specs/tech/app/frontend/[P0]component_data_map.md`：

| hook | 形 | topic | 读 API | 触发 | 契约草案 |
|---|---|---|---|---|---|
| `useClassrooms` | Collection | `academy.classroom.<cid>` | `GET /academy/classroom` | mount + classroom 变更 | Collection applyCrud（task started/accepted 等事件触发 insert/update） |
| `useClassroomDetail(cid)` | Snapshot | `academy.classroom.<cid>` + `academy.task.<tid>` | `GET /academy/classroom/:cid` | cid 变化 | Snapshot applySnapshot；订阅 task events 自动 refresh |
| `useStudentVersions(sid)` | Collection | `academy.student.<sid>` | `GET .../student/:sid` | sid 变化 + version add | Collection applyCrud（process version 创建事件） |
| `useTrainingTask(tid)` | Snapshot | `academy.task.<tid>` + `academy.turn.<tid>` | `GET /academy/training-task/:tid` | tid 变化 + turn_completed 事件 | Snapshot applySnapshot；SSE 事件触发 refresh（不直接 mutate，重读 API 保权威） |
| `useTrainingTurns(tid)` | Collection | `academy.turn.<tid>` | 内联于 useTrainingTask | tid 变化 | Collection applyCrud（turn append 事件） |
| `useDataset/datasets(cid)` | Collection | `academy.dataset.<cid>` | `GET /academy/classroom/:cid/dataset` | mount + add/update | Collection applyCrud |
| `useGrader(s)(cid)` | Collection | `academy.grader.<cid>` | `GET .../grader` | 同上 | Collection applyCrud |
| `useAcadamySessionMessages(sid)` | Collection | `session.<sid>.messages` | `GET /session/:id/messages` | sid 变化 + SSE message | 复用现有 `useLifecycle`/`useMessages`（与 chat 同构；academy session 也是正经 session） |

> 三形 reducer（Collection/Snapshot/KeyedMap + applyCrud/applySnapshot/applyKeyed）见 `[P0]lifecycle_data_shapes.md`；area-hooks 模板见 `[P0]chat_area_hooks.md`。

## 4. 视觉契约（design.md §8 + demo）

- 视觉权威源 = `reqs/[working] v0.0.210.new_academy/demo/`（11 页互通 + `_tokens.css`）。
- 关键约束（design.md §8 十条）：
  1. 所有 chat 复用 chat page 设计，只能微调（结构不发明）
  2. Markdown 查看/编辑 = 统一弹层（modal，view/edit 切换）
  3. 学生会话 = 完全复用 playground-rocky（去掉自定义右面板，memory 入口放右上悬浮菜单）
  4. 训练观察页：coach 对话在中间（复用 chat 设计），训练视图在右侧（更大，~520px 宽）
  5. 右侧训练视图体现：临时版本（vs 临时 base/vs 训练 base 可切对比）+ 已评估版本是否通过成为新临时基线 + 每题分数 + 当前迭代状态 + 任务状态
  6. 优化类型分详略：学习 = agent + 结果即可（轻）；训练 = 每 case 结果 + 评估结果 + 反思（深）
  7. coach 可对话（非只读）；只读的是优化/评估 subagent
  8. subagent 观察入口：仅进行中可点（working 状态 → 跳只读 transcript → 可返回）；跑完无入口
  9. 采纳对比：system/memory/skills 逐项左右 diff，可展开/关闭；skill 支持整体新增或单文件改变（文件级 diff）
  10. 派生 = 复用创建 member 处做二级 select（融入现有 member-create 流程，非独立大页面）

## 5. testid 命名（E2E 定位契约，按 _conventions §4）

> testid 已废弃，改用「可见文案 = E2E 定位契约」（参考 studio-page 现行模式）。新增 component 的可见文案在 spec 中明确（如「发起训练」「接受」「拒绝」「暂停」「停止」「跳转 coach 对话」）。

## 6. 复用旧组件资产（调研 §4）

| 旧组件 | 新组件复用点 |
|---|---|
| widget-iteration-timeline | component-iteration-timeline 直接复用（多轮迭代卡 + gateDecision 三色 tag） |
| component-version-row | component-version-tree 参考平铺规范（v0.0.203 已改平铺 + "基于 vX" 文案） |
| component-version-review | component-diff-viewer 复用 draft vs base 两 tab 对比 + skills 增改删计数 |
| widget-patch-diff | component-diff-viewer 复用 EditOp 结构化 diff（append/replace/delete） |
| drawer-eval-records | component-case-table 直接复用（题+答+分+reasoning+翻页） |
| widget-score-curve | component-score-curve 直接复用 |
| component-subagent-tree | component-subagent-tree 直接复用（三段树 + running 入口可点） |

> 旧组件代码已删（v0.0.208），但**设计参考**保留在调研 + demo 中；coder 实现时按 demo + 旧 spec 重建。

## 7. 国际化（i18n）

- 所有可见文案走 `t()` 占位符（`specs/ui/components/_conventions.md §6`）。
- 资源 key 命名：`academy.classroom.create` / `academy.training.run_turn` / `academy.training.accept` 等。
- 中英文同步落地（i18n-key-add-checklist memory）。

## 8. 打包护栏

- academy-page 全部代码走 web 打包（无 native 依赖）；现有 build 流程覆盖。
- 新 academy session-types/*.yaml + scopes/*.yaml 必须经 `build-plugins copyResources` 拷贝到 dist（持续可打包护栏 §2 BUG-003）。
- 无新增第三方依赖（如需 pLimit 等已有依赖复用）。

## 9. 边界

| 管 | 不管 |
|---|---|
| 前端组件分层 + 文件级清单 + hook 拆解 | 本文 ✅ |
| 具体每个组件 spec（.md + .tsx） | coder 编码前置产出（先 spec 后实现） |
| 视觉契约（demo + tokens） | `reqs/[working] v0.0.210.new_academy/demo/` |
| 现有组件复用规范 | `specs/ui/components/_conventions.md` |
| 数据 hook 基线 | `specs/tech/app/frontend/[P0]component_data_map.md` |
