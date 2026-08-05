# Academy Page 组件树（_overview）

> 层级: 一级页面目录（与 studio-page / chat-page 平级）
> 本文是 academy 板块的**组件清单 + 组合关系**。视觉契约 / 路由 / 数据流见 `specs/ui/overall/12-academy.md`；前端架构总纲见 `specs/tech/app/frontend/[P0]academy_component_architecture.md`。
> 视觉契约：`reqs/[working] v0.0.210.new_academy/demo/`（11 页）。

## 1. 组件树（page → section → component → primitive）

```
page-academy (page 层，板块入口 + route 分发)
├─ section-classroom-list (section，左 sidebar 教室列表) ⚠ 实为 sidebar 不是 section，但按层级归 section 层
│  ├─ component-classroom-card (component，教室行)
│  └─ primitive-status-badge (primitive，复用通用 badge)
├─ section-classroom-detail (section，教室详情页)
│  ├─ [左] SectionChatSession (复用 chat-page 统一装配层) — head teacher 对话
│  └─ [右] content-col
│     ├─ primitive-academy-tab (primitive，tab 切换：学生/数据集/评估器)
│     ├─ component-student-card (component，学生卡片，教室级紧凑态)
│     └─ [数据集/评估器 tab] res-table 行式列表（暂不单独提 component，随 section 实现）
├─ section-student-detail (section，学生详情页)
│  ├─ [左] component-version-tree (component，版本树：正式 + 过程)
│  └─ [右] component-tuple-cards (component，四元组卡 · v0.0.219 去 Tools)
│     ├─ Skills 卡「查看」→ component-skill-browser-modal（目录/文件树 + 单文件读写）
│     ├─ Memory 卡「查看」→ component-version-memory-modal（只读，v0.0.219）
│     └─ AGENTS.md 卡 → component-modal-md-editor（模型卡走 InputModelPicker；Tools 通道 dead-but-retained）
├─ section-training-observe (section，训练观察页，最复杂)
│  ├─ [topbar] component-training-status-bar (component，任务状态 + 暂停/停止)
│  ├─ [中] SectionChatSession (复用 chat-page 统一装配层) — coach 对话
│  └─ [右 520px] train-col
│     ├─ task-status 4 cell（随 section 实现）
│     ├─ component-iteration-timeline (component，多轮迭代倒序折叠)
│     │  └─ component-case-table (component，每 case 评估结果)
│     └─ [working step] subagent 观察入口 → component-subagent-tree (复用 chat-page)
├─ section-training-result (section，训练结果/采纳 diff 页)
│  ├─ verdict-hero（随 section 实现）
│  └─ component-diff-viewer (component，三段逐项 diff：system/memory/skills)
│     └─ component-skill-diff-list (component，skills 段两级 diff：skill 目录 × 文件)
├─ section-version-chat (section，学生版本会话页)
│  └─ 复用 chat-page：SectionChatSession（minimap/usage/float-menu 内置）+ conv 列表列 + ws-panel + memory/cron/skills modal
└─ [弹层]
   ├─ component-modal-md-editor (component，统一 md 查看/编辑，design §8.2 —— 已提升到 common/ 共享：academy + workspace 双消费；spec/impl 在 common/)
   ├─ component-skill-browser-modal (component，版本 Skills 目录/文件树浏览 + formal 单文件编辑)
   ├─ component-training-create-modal (component，发起训练表单) ⚠ 可随 section-classroom-detail / section-student-detail 触发，按 component 层
   └─ component-derive-academy-picker (component，派生二级 select，被 studio member-create 复用)
```

## 2. 复用声明（MANDATORY — design §8.1）

**所有 chat 一律经 `chat-page/section-chat-session` 接入，不创新**（design §8.1 + §8.3；消费方必备能力清单见 `chat-page/base-chat-page.md`）：

| academy 场景 | 接入方式 |
|---|---|
| 教室详情左 head 对话 | `SectionChatSession sessionId={classroom.headTeacherSessionId}` + topbarLeft（`ComponentAcademyChatHeader` 班主任身份）+ placeholder |
| 训练观察中 coach 对话 | `SectionChatSession sessionId={coachSessionId}` + topbarLeft + placeholder + `onMessagesChange`（消息驱动任务刷新残留，禁用于回收 messages 建 UI） |
| 训练观察 subagent 只读 transcript | `SectionChatSession`（`chrome.readOnly` 自动 true——后端按 `derivation==='subagent'` 判定；prop readOnly 冗余双保险）+ topbarLeft + onBack |
| 版本会话（学生版本工作区聊天） | `SectionChatSession`（minimap/usage/float-menu 全内置）+ 会话列表列 + `SectionWorkspacePanel` |

**能力全开**：academy 各 kind 的 capabilities 全开（HITL 两卡 / abort / effort picker / 审批 picker / enqueue / usage 三件套 / minimap / 悬浮菜单），由后端 `GET /session/:id/chrome` 静态表决定——academy 侧**禁止**传哑值/硬编码关闭（历史「部分复用 + 硬编码降级」曾致 HITL 卡不显示）。共用身份 header = `component-academy-chat-header.tsx`（avatar/title/statusLine/tag 纯展示）。

### 宿主高度链约束（MANDATORY）

`BaseChatPage` 根为 `flex-1 flex flex-col`（无 min-h-0），按**水平 row 子项 stretch** 设计（范式：chat-page/page-chat、studio-page/component-studio-chat-router）。academy 宿主嵌入 `SectionChatSession` 时必须保证高度链：

1. **chat 列的直接包装层必须是水平 flex（`flex`，禁 `flex-col`）+ `min-h-0 overflow-hidden`**——垫 flex-col 会让 BaseChatPage 作垂直 flex 子项，`min-height:auto` 被内容撑高 → 消息流 `overflow-y-auto` 失效、输入条被顶出视口。
2. **包装层之上的每级 flex-col 子项容器补 `min-h-0`**（行容器 / section 根），保证高度约束逐级传递到 chat 列。
3. 当前四处宿主均已按此实现：section-classroom-detail（班主任列）/ section-training-observe（教练列）/ section-version-chat（chat 列）/ component-session-readonly（banner 下 row 包装）。

### 可拖宽列约定（MANDATORY）

academy 的固定宽分栏（班主任列 / 训练视图列 / 版本会话列表）全部**宽度可拖拽**，复用 chat-page 既有模式，不另造手柄：

- **手柄**：`chat-page/component-col-resize-handle.tsx`（`ComponentColResizeHandle`）——`side='left'` 表示被拖的列在左侧（手柄贴右缘）、`side='right'` 表示列在右侧（手柄贴左缘）。手柄为 absolute，故列容器须带 `relative`。
- **手柄与 `overflow-hidden` 的取舍（勿「修」）**：手柄宽 6px 且外探 2px（`-right-0.5` / `-left-0.5`）。班主任列与版本会话列表列同时带上文高度链要求的 `overflow-hidden`，会裁掉外探那 2px → 实际可抓区 4px（训练视图列无 `overflow-hidden`，保有完整 6px）。这是**可接受取舍**：4px 仍是常规手柄命中尺寸。**禁止**为加宽手柄而摘掉 `overflow-hidden`——那会回退宿主高度链（消息流失去滚动、输入条被顶出视口）。
- **状态 + 持久化**：`common/use-persistent-width.ts`（全站列宽持久化单一实现源）——`usePersistentWidth({ storageKey, defaultWidth, minWidth, maxWidth })` 返回 `{ width, onResize, onResizeEnd, minWidth, maxWidth }`。读时 clamp 到 [min,max]、坏值/不可用回退 default；`onResizeEnd` 才写 localStorage（拖动中只更新 state），try/catch 吞异常。academy 三列常量集中在 `academy-page/academy-col-widths.ts`（`ACADEMY_COL` 表：key/默认/上下限，旧 localStorage key 原值兼容读回）。
- **上限语义**：静态上限（无三栏动态让位引擎——academy 分栏只两栏，中部无 480 保底约束）。
- **i18n**：手柄 aria-label / title 由调用方注入（`academy:resize.*`）。

| 列 | side | 默认 | min | max | localStorage key |
|---|---|---|---|---|---|
| classroom-detail 班主任列 | left | 480 | 320 | 720 | `academy-ht-col-width` |
| training-observe 训练视图列 | right | 520 | 380 | 800 | `academy-train-col-width` |
| version-chat 会话列表列 | left | 240 | 180 | 400 | `academy-version-conv-width` |

### 交互 / 只读边界（用户裁决）

| 场景 | 可交互 | usage 三件套（UsagePanel+Compact+Clear） |
|---|---|---|
| 班主任（classroom-detail） | ✅ 可聊 | ✅ SectionChatSession 内置（capabilities.usage/compact/clear） |
| 教练（training-observe） | ✅ 可聊 | ✅ 同上 |
| 学生版本会话（version-chat） | ✅ 可聊 | ✅ 同上（含 summaryTask） |
| subagent 只读 transcript（session-readonly） | ❌ readOnly（无输入区/无 Clear） | usage + Compact 保留（readOnly 覆盖层口径，api 04a §4） |

usage/compact/clear 接线全部内置于 `SectionChatSession`，academy 侧零接线。

## 3. 文件清单（实现侧）

实现目录：`app/web/src/components/academy-page/`（与 spec 同名映射，见 `_conventions §7`）：

| spec 文件 | 实现文件 |
|---|---|
| `page-academy.md` | `page-academy.tsx` |
| `section-classroom-list.md` | `section-classroom-list.tsx` |
| `section-classroom-detail.md` | `section-classroom-detail.tsx` |
| `section-student-detail.md` | `section-student-detail.tsx` |
| `section-training-observe.md` | `section-training-observe.tsx` |
| `section-training-result.md` | `section-training-result.tsx` |
| `section-version-chat.md` | `section-version-chat.tsx`（薄壳，内嵌 `SectionChatSession` 复用） |
| `component-academy-chat-header.md` | `component-academy-chat-header.tsx`（4 chat 消费方共用身份 header） |
| `component-classroom-card.md` | `component-classroom-card.tsx` |
| `component-student-card.md` | `component-student-card.tsx` |
| `component-version-tree.md` | `component-version-tree.tsx` |
| `component-training-status-bar.md` | `component-training-status-bar.tsx` |
| `component-iteration-timeline.md` | `component-iteration-timeline.tsx` |
| `component-case-table.md` | `component-case-table.tsx` |
| `component-score-curve.md` | `component-score-curve.tsx`（评估走势折线，可选） |
| `component-diff-viewer.md` | `component-diff-viewer.tsx` |
| `component-skill-diff-list.md` | `component-skill-diff-list.tsx`（skills 段两级 diff 渲染） |
| `component-tuple-cards.md` | `component-tuple-cards.tsx` |
| `component-modal-md-editor.md` | （已提升到 `common/component-modal-md-editor.tsx`，spec 同迁 common/ —— academy 仅消费方，挂载在 `component-academy-modals.tsx`） |
| `component-skill-browser-modal.md` | `component-skill-browser-modal.tsx` |
| `component-training-create-modal.md` | `component-training-create-modal.tsx` |
| `component-derive-academy-picker.md` | `component-derive-academy-picker.tsx` |
| `primitive-academy-tab.md` | `primitive-academy-tab.tsx` |
| `primitive-status-badge.md` | `primitive-status-badge.tsx` |

无独立 spec 的实现辅助文件（契约归属所列 spec 章节）：

| 实现文件 | 契约归属 | 职责 |
|---|---|---|
| `component-session-readonly.tsx` | `page-academy.md`（session-readonly 路由）+ 本文 §2 | subagent 只读 transcript 视图（gold banner + `SectionChatSession` 只读列） |
| `component-academy-modals.tsx` | `component-modal-md-editor.md` + `component-skill-browser-modal.md` | 版本内容弹层挂载层（md 编辑器 + skill browser 的挂载与保存通道接线；从 page-academy 拆出守 ≤300 行，modal 开关 state 仍归 page） |
| `component-classroom-head.tsx` | `section-classroom-detail.md`（cls-head） | 教室详情头部（logo / 改名 / tabs / 默认模型 slot） |
| `component-classroom-tab-panels.tsx` | `section-classroom-detail.md`（content-col） | 教室详情 4 tab 面板（学生网格 / 任务行 / 资源表） |
| `component-train-view-col.tsx` | `section-training-observe.md`（train-col） | 训练视图右列（可拖宽 + 状态 4 cell + 走势 + subagent 树〔import `chat-page/component-subagent-tree` 传 flat/onOpenNode〕+ 迭代记录） |
| `academy-hero.tsx` | `page-academy.md`（classroom-list 空态） | Academy 空态 hero |
| `academy-styles.ts` | `specs/ui/regulation/01-tokens.md` | 共享 tailwind 样式常量（btn / card / icon-btn） |
| `academy-col-widths.ts` | 本文 §2（可拖宽列约定） | `ACADEMY_COL` 三列宽度常量表（key / 默认 / 上下限） |
| `line-diff.ts` | `component-diff-viewer.md` | 行级 LCS diff 工具 |
| `skill-file-view.ts` | `component-skill-browser-modal.md` | skill 文件渲染分类（`classifySkillFile`）+ md 分支 frontmatter 剥离（`stripMarkdownFrontmatter`）+ 两级树派生（`buildSkillsTree` / `splitSkillSelection`） |
| `skill-diff.ts` | `component-skill-diff-list.md` | 两级 skill diff 派生（`buildSkillDirDiffs` 按 per-file hash 判 modified + `collectDiffFileRefs` 限流 + `applySkillFileContents` 回填） |
| `build-diff-items.ts` | `section-training-result.md` | diff item 组装纯函数（system / skills / memory / model 四项） |
| `use-academy-data.ts` | tech `[P0]academy_component_architecture.md §3` | 板块数据 hooks（useLifecycle 四方法契约） |
| `use-coach-children.ts` | tech `[P0]academy_component_architecture.md §3` | coach session 工作子代理列表（5s 轮询） |
| `use-derive-options.ts` | `component-derive-academy-picker.md` | 派生 picker 数据装配（studio member-create 消费） |
| `use-training-task.ts` | tech `[P0]academy_component_architecture.md §3` | 训练任务详情 hook（轮询保权威） |

外部改动（非 academy-page 目录）：
- `app/web/src/store/view-store.ts`：ViewId 加 `'academy'`。
- `app/web/src/components/framework/nav-rail/nav-rail.tsx`：顶部业务区 2→3 项。
- `app/web/src/components/framework/app-shell/app-shell.tsx`：MainView union 加 academy 分支。
- `app/web/src/store/chat-slice.ts`：列表守卫放行 `biz='academy'` + 新增 `fetchAcadamySessions(classroomId?)` action。
- `app/web/src/components/chat-page/section-chat-session.tsx`：subagent 只读由 `chrome.readOnly` 承载（后端按 derivation 判定，api `04a-session-chrome.md`）。
- `app/web/src/components/studio-page/component-new-squad-modal.tsx`（或对应 member-create 入口）：mode-cards 加「从教室派生」+ 二级 picker。

## 4. 视觉契约来源

| 来源 | 用途 |
|---|---|
| `reqs/[working] v0.0.210.new_academy/demo/_tokens.css` | 设计 token 与现网 dump 一致 |
| `demo/01-classroom-list.html` | sidebar + 空态 hero |
| `demo/02-classroom-detail.html` | 教室详情（head 对话 + 学生网格） |
| `demo/03-student-detail.html` | 学生详情（版本树 + 四元组） |
| `demo/04-training-observe.html` | 训练观察（最复杂页） |
| `demo/05-training-create.html` | 训练发起 modal |
| `demo/06-training-result.html` | 训练结果采纳 diff |
| `demo/07-squad-derive.html` | 派生 picker |
| `demo/08-coach-readonly.html` | subagent 只读 transcript |
| `demo/09-version-edit.html` | 统一 md 编辑器弹层 |
| `demo/10-version-chat.html` | 版本会话（复用 playground-rocky） |
| `demo/index.html` | demo 导航（11 页互通） |

## 5. 数据 hook（摘要）

详 `specs/tech/app/frontend/[P0]academy_component_architecture.md §3`：

- `useClassrooms` / `useClassroomDetail(cid)` / `useStudentVersions(sid)` / `useTrainingTask(tid)` / `useTrainingTurns(tid)` / `useDatasets(cid)` / `useGraders(cid)`
- 版本会话消息：复用现有 `useLifecycle` / `useMessages`（academy-student session 也是正经 session）

## 6. testid 规范（E2E 定位 = 可见文案）

testid 已废弃（v0.0.197 起）。所有 academy 组件的可见文案（按钮名 / tooltip / 空态文案 / badge 文字）在各自 component spec 的「状态 / 交互」章节明确，作为 E2E 定位契约。
