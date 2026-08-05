# Academy 视图契约（academy 教室+训练培养 UI）

> 管什么：**Academy** view——围绕一个目标培养一个 agent 的页面结构与组件契约（左 sidebar 教室列表 + 右主区多态：教室详情/学生详情/训练观察/训练结果/版本会话/版本编辑/训练发起弹层）。
> 不管什么：HTTP 端点契约（→ `specs/api/overall/`）；设计 token（→ `specs/ui/regulation/`）；nav-rail 改造（→ `specs/ui/components/framework/nav-rail.md`）；bizType 隔离规则（→ `specs/tech/agent/session/[P0]session_biztype.md`）；训练引擎/状态机（→ `specs/tech/academy/`）；五元组工作区语义（→ `specs/tech/academy/version.md`）。
> 视觉契约：`reqs/[working] v0.0.210.new_academy/demo/`（11 页互通 + `_tokens.css`）。

---

## 1. 概述

Academy 是 agent 培养入口（nav-rail 顶部业务区第 3 项「Academy」🎓，与 Playground / Studio 并列）。

一句话：**左 nav-rail 切 Playground/Studio/Academy；Academy 主页 = 左 sidebar 教室单行列表 + 右主区多态（教室详情 [左 head 对话 + 右学生网格 + 资源 tab（学生/数据集/评估器）] / 学生详情 [左版本树 + 右四元组卡 · 五元组去 Tools UI] / 训练观察 [中 coach 对话 + 右训练视图] / 训练结果 [采纳 diff] / 版本会话 [复用 playground-rocky] / 版本编辑 [统一 md 弹层] / 训练发起 [弹层]）；所有 chat 复用 chat-page 不创新。**

### 1.1 bizType 隔离（UI 侧）

| tab | view | 数据源 | 列表隔离 |
|---|---|---|---|
| Playground | `currentView='playground'` | `GET /session?biz=playground` | 不含 studio/academy |
| Studio | `currentView='studio'` | `GET /squad` + `GET /session?biz=studio` | 不含 playground/academy |
| **Academy** | `currentView='academy'` | `GET /academy/classroom` + `GET /session?biz=academy` | 不含 playground/studio |

教室一旦建立，Playground/Studio 列表不受污染（`biz=academy` query param 过滤保证；**注意**：API 端 query key 是 `biz`（不是 `bizType`），UI 文档保留 `bizType` 概念名是 product vocab）。

### 1.2 双引擎映射到 UI（design §4）

- **agent 引擎**（现成）：head teacher / coach / student 都是正经 session，会话入口在 chat-page 内核复用。
- **训练引擎**（新）：训练任务结构化状态机 → 推 `inbox` 事件 → 触发 academy 主区 SSE 重渲染（任务状态条 / 迭代 timeline / case 表 等只读视图）。
- **UI 不直接操纵训练引擎**：用户对 head/coach 说话 → head 调 `manage-classroom`（监督级）或 coach 调 `manage-task`（推进级）→ 引擎推进 → inbox 事件 → UI 刷新。UI 只读训练视图（例外：训练观察页的「暂停」按钮直接调 `/pause`；采纳走版本树过程版行尾的 inline「采纳」按钮调 `/adopt`）。

---

## 2. Academy 主页布局

```
┌─────────────────────────────────────────────────────────────┐
│ ┌──────┐ ┌──────────────┐ ┌──────────────────────────────┐ │
│ │nav-  │ │ academy      │ │ 主区（按 route 多态互斥）     │ │
│ │rail  │ │ sidebar      │ │ • 空态 hero（无教室）         │ │
│ │ 56px │ │ 220px        │ │ • 教室详情（左 head 对话 +    │ │
│ │      │ │              │ │   右学生网格 + tab：         │ │
│ │ R    │ │ + 新建教室   │ │   学生/数据集/评估器)        │ │
│ │ 💬   │ │              │ │ • 学生详情（左版本树 + 右四元组│ │
│ │ 👥   │ │ • 文案教室   │ │   + 发起训练/会话/派生按钮）  │ │
│ │ 🎓   │ │ • 质检教室   │ │ • 训练观察（中 coach + 右训练)│ │
│ │      │ │              │ │ • 训练结果（采纳 diff 页）   │ │
│ │ ⚙    │ │              │ │ • 版本会话（复用 chat-page） │ │
│ │      │ │              │ │                              │ │
│ │      │ │              │ │                              │ │
│ └──────┘ └──────────────┘ └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
   主区其他态（互斥）：version-edit / training-create 均为 modal 弹层（不切 route）
```

- **左 nav-rail**（改造见 `specs/ui/components/framework/nav-rail.md`）：brand「R」置顶 + 顶部业务区 3 项（Playground / Studio / Academy 🎓）+ 底部设置组（SKILLS/渠道/连接器/应用设置）。
- **中 academy-sidebar**（~220px）：教室单行列表（logo + 名 + 学生数/任务中数）+ 顶部「新建教室」按钮 + foot 文案「academy · 培养专家的地方」。
- **右主区**（按 route 多态互斥）：
  - **空态 hero**（无教室选中）：grad hero icon + 「选一间教室开始，或新建一间」标题 + 3 卡（班主任陪伴 / 两种训练模式 / 版本树）+ 「+ 新建教室」CTA。
  - **教室详情**：左 400px `ht-col`（head teacher 对话，复用 `BaseChatPage`）+ 右 `content-col`（头部 tab + 学生网格 + 数据集/评估器 tab）。
  - **学生详情**：左 300px `left-col`（版本树）+ 右 `right-col`（版本 hero + 四元组卡片）。
  - **训练观察**：topbar（任务名 + 状态 + 暂停/停止）+ 中 `chat-col`（coach 对话复用 `BaseChatPage`）+ 右 520px `train-col`（任务状态 4 格 + 迭代 timeline + 每 case 表 + 反思盒 + subagent 入口）。
  - **训练结果**：topbar + 滚动区（verdict hero + 4 score cells + system/memory/skills/模型 逐项 diff）+ 底部 foot-bar（拒绝 / 继续训练 / 采纳）。
  - **版本会话**：复用 playground-rocky 设计（conv-panel + chat-col + 右悬浮菜单 + ws-panel），见 §7。
  - **版本编辑**：modal 弹层（统一 md 编辑器，design §8.2），见 §8。
  - **训练发起**：modal 弹层（模式卡 + 基线/数据集/评估器 picker + 训练目标 textarea + 迭代策略），见 §9。

---

## 3. 教室详情页（默认 landing）

**入口**：点 sidebar 教室行 → 落教室详情。

**布局**（demo `02-classroom-detail.html`）：

```
┌─ cls-head ──────────────────────────────────────────────┐
│ [logo] 文案写作教室 [3 学生]            [⚙ 教室设置]    │
│ [tab: 学生 | 数据集 | 评估器 ]                         │
└─────────────────────────────────────────────────────────┘
┌─ ht-col 400px ──────┐ ┌─ content-col ──────────────────┐
│ 班主任 · 林老师 ●    │ │ sec-head: 学生（N）  + 添加学生│
│ ─────────────────── │ │ ┌─ student-card ─┐ ┌ card ─┐ ..│
│ 消息流（复用 chat    │ │ │ avatar + 名    │ │ ...   │  │
│ page 内核，msg max  │ │ │ 当前正式版     │ │       │  │
│ 78%）               │ │ │ 训练中/可用    │ │       │  │
│                     │ │ │ 版本/任务/提升 │ │       │  │
│ ─────────────────── │ │ └────────────────┘ └───────┘  │
│ input-box + send    │ │ [+ 添加学生（虚线卡）]         │
└─────────────────────┘ └────────────────────────────────┘
```

- **左 head teacher 对话**（400px，经 `chat-page/section-chat-session` 接入，能力全开——HITL 两卡/停止/两 picker/enqueue/usage/minimap/悬浮菜单内置，见组件 spec `academy-page/_overview.md §2`）：顶部注入班主任身份 header（avatar + 名 + 「● 在线 · 随时可聊」+ 展开按钮 → 切到「教室会话」全屏页，`component-academy-chat-header`）+ 消息流（assistant 浅底 / user 深底气泡，`msg max-w 78%`）+ 底部输入区（统一输入区，textarea + ➤ 发送）。
  - **head 可对话**（非只读）：备环境（增改数据集/迭代评估器/装 skill，通过 head 的 `manage-classroom` 工具）+ 发起训练（head 调 `manage-classroom.start_task`）。design §6。
  - **训练内/外要求分流**（design §6）：用户对 head 说的内容自动判定——「训练目标」（如「重点学《旧猫咪》」）→ head 透传进训练任务 directive；「教室资产演进」（如「评估器加一条」）→ head 自己用工具改，不开训练。
- **右 content-col**：tab 栏（学生/数据集/评估器，`primitive-academy-tab`）+ 内容滚动区。
  - **学生 tab**（默认）：`sec-head` 「学生（N）」+ 「+ 添加学生」 + `student-grid`（repeat 250px minmax，`component-student-card` + 末位「添加学生」虚线卡）。
  - **数据集 / 评估器 tab**：`res-table` 行式列表（icon + 名 + 描述 + 编辑/查看入口）。

---

## 4. 学生详情页

**入口**：教室详情 → 学生 tab → 点学生卡 → 进学生详情。

**布局**（demo `03-student-detail.html`）：

```
┌─ stu-head ─────────────────────────────────────────────────┐
│ ← 教室 │ [红 avatar] 小红书文案 [v1.0 正式版]               │
│ │        每个版本是一个 agent · 基于工作区目录              │
│ │                            [💬 发起会话][⇪ 派生][＋ 训练] │
└────────────────────────────────────────────────────────────┘
┌─ left-col 300px ────┐ ┌─ right-col ───────────────────────┐
│ 版本树               │ │ [60×60 v1.2 大徽章] 过程版 v1.2    │
│ ┌ 0.0 初始版本 ─────┐│ │   训练中 · 第 4/5 轮    [进入观察]│
│ ┌ 1.0 第 1 正式版 ✓ ││ │ ─────────────────────────────── │
│ │  └ v1.1           ││ │ tuple-grid（四元组卡）：          │
│ │  └ v1.2 训练      ││ │  📝 System Prompt (AGENTS.md)    │
│ ┌ 2.0 第 2 正式版   ││ │     [code-block 预览]            │
│   采纳自 v1.2.3     ││ │  🧩 Skills (2 个)                 │
│                     ││ │  🧠 Memory (3 条 · 查看)          │
│                     ││ │  🤖 模型 (version.json)          │
└─────────────────────┘└└──────────────────────────────────┘
```

> **[v0.0.219] tuple-grid 五元组 → 四元组**：Tools 卡移除（仅删 UI 入口）；`version.json.tools` 数据字段保留供装配链 `resolveToolSet` 使用（`[P0]session_kind_extension.md §4`），`MdEditorTarget.saveKind='tools'` union 保留为 dead-but-harmless 通道（本版不清）。布局稳定性：移除后 grid 自适应，相邻卡无位移。

- **左 left-col**（300px，版本树）：
  - **版本树**（`component-version-tree`，平铺规范对齐 v0.0.203）：正式版（0.0 / 1.0 / 2.0…）带 `vb-formal` 黑底白字徽章；过程版（v1.1 / v1.2 / v1.2.3…）带 `vb-proc` violet 底徽章，**缩进 + 左侧 2px border 竖线**（`ver-tree-proc margin-left:22px; border-left:2px solid var(--color-border)`）；当前正式版标「当前」tag；训练中的过程版标「训练中」gold tag。
  - **[v0.0.219] 版本树归属 + 副标题规则**：① **过程版按 label major 段匹配父 formal**（`process.versionLabel.split('.')[0] === formal.versionLabel.split('.')[0]`），不沿用 `parentFormalVersionId`（multi-turn round2+ base 是 process 非 formal，该字段非 formal id 会致 round2+ 过程版落 orphan 列表尾脱离 base formal）；formal major 唯一（0/1/2…）保无歧义，orphan 分支保留兜底。② **过程版节点 name 用 3 段 versionLabel**（`v1.2.3`，已是 schema 字段，见 `[P0]data_model.md §6` label 规则），不再用「任务 #N」。③ **formal 副标题显「采纳自 v{label}」**：`adoptedFromProcessVersionId` 有值且在 versions 中查到对应 process → 显 `versionTree.adoptedFromLabel`；初始 0.0 / 旧 record 无此字段 / 查不到 label → 降级（emptyFormal / 旧 `adoptedFrom {n:seq}`）。
  - **[v0.0.219] 任务名版本前缀**：训练观察 topbar / 训练结果 / 训练发起 hint 任务名统一用「v{baseMajor}.{taskSeq} 训练任务」（如 base 1.0 + taskSeq=2 → `v1.2 训练任务`），由后端反规范化 `task.baseVersionLabel`（api §2.2）拼；`baseVersionLabel` 缺失降级 `v?.{seq}`。任务跨多轮不含 round（round 属过程版粒度，过程版节点用 3 段 versionLabel）。
- **右 right-col**（四元组卡片）：
  - **ver-hero**：60×60 圆角徽章（版本号 mono 700）+ 版本名 + 「一个版本 = 一个工作区目录」副标题。副标题不列 Tools（对齐四元组 UI）。**[v0.0.220] ver-hero 按钮分流**：**正式版无编辑按钮**（槽位留空）——编辑走下方四元组卡 item（如 System Prompt 卡，readOnly 由 `openMdEditor` 的 `readOnly: !selectedIsFormal` 控制，能力不变）；**过程版 ver-hero 显「进入观察」按钮** → `onOpenTrainingObserve(selectedVersion.createdFromTaskId)` → 训练观察 coach 页（同 task 多过程版指向同一 coach；`createdFromTaskId` 缺失的过程版不显按钮）。data-action-key=`academy.version.enterObserve`。
  - **tuple-grid**：4 张 tuple-card（System Prompt / Skills / Memory / 模型），各卡 head（icon + 标题 + 路径 sub + 「查看 / 编辑」ghost 按钮）+ body（code-block 预览 / chip 列表 / 状态摘要）。Memory 卡显条目数 + 「查看」开 `component-version-memory-modal`（只读，§4.1）。
- **顶部操作行**（`action-row`）：
  - 「💬 发起会话」→ 基于该版本工作区建 academy-student session → 跳版本会话页（§7）。
  - 「⇪ 派生到团队」→ 走 squad member-create 派生 picker（§10）。
  - 「＋ 发起训练」→ 开训练发起 modal（§9）。

### 4.1 版本 memory modal（只读）[v0.0.219]

**入口**：学生详情 → Memory 卡 head「查看」（`content.memory` 非空时显；空显「暂无记忆条目」）。

**布局**：modal 复用 chat-page memory-entry-card 样式（银灰 token 一致），列出版本工作区 `.rocky/memory/` 下的 md 文件条目（每条 = 文件名 + 字节数 + 前 ~200 字符 preview）。

**只读硬约束**：版本资产 memory 是只读快照（非 session 级可写），**禁复用 `useMemoryCrud`**（那是 session 级读写 API，见 chat-page `component-memory-modal.md`）。组件 spec：`component-version-memory-modal.md`。

---

## 5. 训练观察页（核心复杂页）

**入口**（coach 持续可达产品不变量）：学生详情 ver-hero 过程版「进入观察」按钮（由 `selectedVersion.createdFromTaskId` 定位 task → `onOpenTrainingObserve(taskId)`；v0.0.221 task 三态机后含终态 paused+reason——仍有复盘价值；过程版节点始终在版本树可见，故任一 task 的过程版都能落到观察页）。任务一旦创建，其 coach 始终可进入对话（caps=ALL_OPEN 不降级、`derivation='parent'` 非 readOnly，见 `session-chrome.ts academy_coach` scope）。

> **实时性**（前端轮询兜底）：`useStudentDetail` / `useClassroomDetail` 检测到 active task（running/pending）时起 ~5s timer 周期 reload（复用 `useTrainingTask` polling 模式：`useLifecycle.startTimer` + `onTick mutateCtx` 软刷新，不堆叠 timer），让运行中训练 fork 的 round2+ 过程版实时涌现。**后端 training.\* SSE 未落地**（api §6 声明但代码缺），SSE 后置版本补；本版前端轮询兜底（PRD §2.3）。

**布局**（demo `04-training-observe.html`）：

```
┌─ obs-topbar ─────────────────────────────────────────────────┐
│ ← 学生 │ v1.2 训练任务 [多轮 · 训练优化]                    │
│ │                       [进行中 · 第 4/5 轮] [⏸ 暂停][⏹ 停止]│
└──────────────────────────────────────────────────────────────┘
┌─ chat-col (中，flex-1) ──────┐ ┌─ train-col 520px ──────────┐
│ coach head (avatar + 教练 +  │ │ train-head: 训练视图         │
│ ● 工作中 + acadamy-coach tag)│ │   base v1.0 · 评估器：种草  │
│ ─────────────────────────── │ │ ─────────────────────────── │
│ coach ↔ user 对话             │ │ task-status（4 cell）：     │
│ （复用 BaseChatPage，max 74%）│ │   任务状态/当前轮次/         │
│ - coach 报告进度             │ │   临时基线/最高分            │
│ - user 注入指导（透传给优化)  │ │                             │
│ - coach 转达 subagent 状态   │ │ 迭代记录（vs 临时基线/vs base)│
│ ─────────────────────────── │ │ ┌ iter-item cur ───────────┐│
│ chat-input + send           │ │ │ v1.2.4 进行中  —          ││
└──────────────────────────────┘ │ │ step ✓ fork → v1.2.4      ││
                                 │ │ step ◐ 优化 agent（观察→）││
                                 │ │ step · 评估                ││
                                 │ │ step · 反思+决策           ││
                                 │ │ └─────────────────────────┘│
                                 │ ┌ iter-item（已评估）──────┐│
                                 │ │ v1.2.2 ✗ 退化 6.8 ↓       ││
                                 │ │ case-table（每题分数）    ││
                                 │ │ reflect-box（反思）       ││
                                 │ │ └─────────────────────────┘│
                                 │ ┌ iter-item v1.2.3 ✓ 基线 ─┐│
                                 │ └─────────────────────────┘│
                                 └─────────────────────────────┘
```

- **obs-topbar**：返回键 + 任务名 + 「多轮 · 训练优化」tag + 状态 tag（gold 进行中 / sage paused / danger 异常）+ 「⏸ 暂停」按钮（design §8：用户可控制训练生命周期；v0.0.221 去「停止」按钮——停止改由 head `update_task` 调 directive 或 coach `pause(reason='stopped')` 在对话里完成；topbar 仅保留前端可调的 `/pause`）。
- **中 chat-col**（经 `chat-page/section-chat-session` 接入，能力全开）：coach 对话——coach 是正经 session 可对话（design §8.7：非只读）；user 可注入指导（透传给优化 agent 作 directive）；subagent 消息不在此显示（subagent 是只读观察对象，要看 → 点右栏 working 链入只读 transcript 页，§6）。usage 三件套（UsagePanel + 压缩 + 清空）内置，见组件 spec `academy-page/_overview.md §2`。
- **右 train-col**（520px，训练视图，design §8.4-8.5）：
  - **task-status**（4 cell grid）：任务状态 / 当前轮次（N/M）/ 临时基线版本号 / 最高分。
  - **迭代记录**（`component-iteration-timeline`，倒序 + 折叠）：`sec-label` 头 + `vs-toggle` 切换「vs 临时基线 / vs 训练 base」对比基准；每 `iter-item` 一轮：
    - **iter-head**：版本号（mono）+ gate tag（✓ 成为基线 / ✗ 退化未替换 / 进行中）+ 分数（带 ↑/↓ 箭头）。
    - **iter-detail**（展开）：4 step（fork → 优化 → 评估 → 反思），各 step 一个 dot（sage ✓ / gold 进行 / muted 数字 / indigo working spin）+ 文案；**working 中 step 出「👁 观察 →」working-link**（design §8.8：subagent 进行中才可点，跳只读 transcript）；评估 step 展开后含 `case-table`（每题分数 + 正/负/中 tag）+ `reflect-box`（violet 底反思盒）。

---

## 6. 只读 subagent transcript 页

**入口**：训练观察 → 右栏 working-link 「👁 观察 →」（仅优化/评估 subagent 进行中可点）。

**布局**（demo `08-coach-readonly.html`）：`component-session-readonly`（gold banner + `chat-page/section-chat-session`）；只读判定 = 后端 `GET /session/:id/chrome` 的 `readOnly`（`derivation==='subagent'` → true）∪ 前端 `readOnly` prop 双保险——只读时无输入区/无 picker/无 HITL/无停止，保留 usage + 压缩。

- topbar：返回键（回训练观察）+ subagent 名 + tag。
- 消息流：完整 transcript（含 manage-task / manage-classroom 工具调用展开），**只读无输入框**。
- 右栏（可选）：任务上下文摘要（subagent 角色 + 在哪一步）。

> design §8.8：跑完后此入口消失（不查历史，只看过程）。

---

## 7. 版本会话页（复用 playground-rocky）

**入口**：学生详情 → 「💬 发起会话」；或版本会话列表项。

**布局**（demo `10-version-chat.html`，design §8.3：完全复用 playground-rocky）：

```
┌─ conv-panel 220px ──┐ ┌─ chat-col ────────────┐ ┌─ ws-panel 300px ─┐
│ conv-head: 小红书 +  │ │ chat-topbar:          │ │ ws-head: 工作区 ✕│
│ conv-list: 该版本    │ │   v2.0 · 新会话 + tag │ │ ws-scroll:       │
│ 的会话列表           │ │   39k/300k [压缩][清] │ │  版本 v2.0 目录  │
│                     │ │                       │ │   📝 AGENTS.md   │
│                     │ │ float-menu（右上纵排）│ │   🤖 version.json│
│                     │ │   🧠 长期记忆          │ │  .rocky/skills/  │
│                     │ │   ⏰ 定时任务          │ │   ✍️ 爆款标题... │
│                     │ │   ✨ skills            │ │  .rocky/memory/  │
│                     │ │                       │ │   🧠 风格偏好.md │
│                     │ │ chat-msgs             │ │                  │
│                     │ │ chat-input + send     │ │                  │
└─────────────────────┘ └───────────────────────┘ └──────────────────┘
```

**复用声明**（MANDATORY — design §8.3）：
- 复用 `chat-page/section-chat-session.tsx`（统一装配层：消息流/输入区/usage/minimap/右缘 overlay/悬浮菜单及其弹层 memory/cron/skills 全内置）+ `component-workspace-panel`（与 playground/studio 同源）。
- **去掉自定义右面板**（旧 academy 的右栏已废）；memory/cron/skills 入口放右上悬浮菜单（复用 playground float-menu 位置）。
- session-kind = `academy-student`（design §9.1）；workspaceDir 指向该版本工作区目录（design §2.1：一个版本 = 一个目录）。
- 视觉、SSE 链路、run 态、IME 守护等全部沿用 playground，**不发明新结构**。

组件 spec：`section-version-chat.md`（本文档同目录）；底层 chat 内核契约 → `specs/ui/components/chat-page/`。

---

## 8. 版本编辑弹层（统一 md 编辑器）

**入口**：学生详情 → 四元组卡 head 「查看 / 编辑」（如 System Prompt 卡；**Skills 卡除外**见 §8.1，Skills 走 skill browser 弹层）。**[v0.0.220] ver-hero 不再持编辑按钮**——正式版编辑统一走四元组卡 item（readOnly 由 `openMdEditor` 控），ver-hero 槽位留给过程版「进入观察」（§4）。

**布局**（demo `09-version-edit.html`，design §8.2：统一 md 弹层）：

- **modal shell**：720px 宽（max 92vw）/ max-h 88vh / `rounded-xl` + `shadow-lg`；背景 `rgba(10,10,10,.4)` 遮罩。
- **md-head**：文件 mono 名（如 `AGENTS.md`）+ sub（学生 · 版本 · 字段）+ **mode-toggle**（「👁 查看 / ✏️ 编辑」二段，激活 `var(--color-accent)` 黑底白字）+ ✕ 关闭。
- **md-body**：
  - **view 模式**（默认）：markdown 渲染（`md-view`，13.5px / 1.75 行高，h1 17px/600，ul/li/code 全套）。
  - **edit 模式**：`md-edit` 全宽 textarea，mono 13px / 1.7 行高。
- **md-foot**：hint「直接编辑 · 保存后版本号不变（v2.0 仍是 v2.0）」+ 关闭按钮 + 「保存」按钮（仅 edit 模式渲染，view 模式 `display:none`）。

**字段边界**（design §2.1：五元组中的 a/b/c/d/e）：
- AGENTS.md / Memory 的 .md 文件 → 走 md 编辑器（保存通道 `saveKind: 'agentsMd'`）。
- **Skills → 走 skill browser 弹层，不走 md 编辑器**（[v0.0.214]，见 §8.1）。
- version.json（模型）→ 走 model picker，不走 md 编辑器。
- **[v0.0.219] Tools 字段**：`saveKind='tools'` union 保留为 dead-but-harmless 通道（数据字段 `version.json.tools` 在装配层仍用），但 Tools 卡 UI 入口随 §4 四元组移除后无触发点；后端 PATCH 端点保留，UI 不暴露。

组件 spec：`component-modal-md-editor.md`。

### 8.1 Skills 浏览弹层（skill browser）[v0.0.214]

**为什么单开一层**：skill 的载体是「一个目录 + SKILL.md + 任意附属文件」（`specs/tech/agent/skills/[P0]skill_definition.md §1/§2`），不是单个 markdown。早期实现把目录名列表拼成假 markdown 塞进 md 编辑器且 `saveKind='agentsMd'`，保存即把 AGENTS.md 覆盖成目录名列表（system prompt 丢失）。故 **Skills 彻底离开 md 编辑器通道**：`saveKind` 保持 `'agentsMd' | 'tools'` 不新增 `'skillFile'`，那条数据丢失路径按构造消失。

**入口**：学生详情 → Skills 卡 head 「查看」。

**布局**：modal `820×560`（max 94vw / 88vh），左侧 250px **两级目录树**（skill 目录 → 目录内文件/子目录）+ 右侧内容面板：
- `.md` → markdown 渲染（**渲染前剥离开头的 YAML frontmatter**：那是元信息不是正文，后端已解析成 `name`/`description`；编辑态 textarea 恒为文件原文，保存不丢元信息）；`.py/.sh/.yaml/.json/.txt/…` → mono `<pre>` 原样输出全部字符；未知扩展名或后端标 `binary` → 「不可预览」提示；`truncated` → 追加截断提示。
- **formal 版本**：head 「👁 查看 / ✏️ 编辑」toggle + foot 「保存」（单文件覆写，走 `specs/api/overall/18-academy.md §1.11.2`）。
- **process 版本**：全程只读（无 toggle / 无保存，foot 显「过程版本只读，不可编辑」）。

**数据通道**：文件树随 `GET .../version/:vid` 返回（`content.skills[]` = 目录 + 文件树 + per-file hash，`18-academy §1.8`）；单文件内容按需 `GET .../version/:vid/skill/:name/file?path=`（`§1.11.1`）。组件 spec：`component-skill-browser-modal.md`。

---

## 9. 训练发起弹层

**入口**：学生详情 → 「＋ 发起训练」。

**布局**（demo `05-training-create.html`）：modal 640px / max-h 88vh：

- **mode-cards**（design §5：简单/多轮模式二选一）：grid 2 列；每卡 = radio 圈 + icon + 名 + 描述 + 能力要求 tag（`req-ok` 绿底「✓ 随时可用」/`req-miss` gold 底「需先备评估能力」）；教室无数据集/评估器 → 多轮卡 `dis` 禁用（design §5：多轮需评估能力）。
- **基线版本 picker**（[v0.0.219] 可 cycle 任一 formal）：单行（🌳 logo + 版本号 + 副「基于它发起本次训练」+ ›）。点 row cycle 切换 `formalVersions` 列表（modal 内 state `baseVersionId` 默认 `defaultBaseVersionId`，可切任一 formal，不止 currentFormal）。复用 dataset/grader cycle 模式。
- **数据集 + 评估器 picker**：两行并列（仅多轮模式显示；简单模式隐藏）。
- **训练目标 textarea**：label「🎯 本次训练目标 透传给教练和优化 agent」+ textarea 占位「例：重点学《旧猫咪》叙事感…」。
- **迭代策略**（grid 3 列，design §5.3）：最大轮次 stepper（默认 5）+ 早停 stepper（默认 3）+ 接受决策（固定文案「新版分 > 基线分」）。
- **自主修复 toggle**：checkline「允许教练在训练中自主修复数据格式等小问题（消耗更多 token 换可靠性）」。
- **hint-bar**：indigo 底提示「将基于 **v{baseMajor}** 创建训练任务 **v{baseMajor}.{nextSeq}**，由专属教练跟进…」（[v0.0.219] 任务名版本前缀，baseMajor 从选中 base label `split('.')[0]` 派生）。
- **foot**：取消 + 「发起训练 →」（创建任务 + 起 coach session → 跳训练观察页）。onSubmit 上抛选中 `baseVersionId` + config，由 page-academy 调 `toCreateTaskBody`（不再硬 currentFormal）。

---

## 10. 派生到 Studio（复用 member-create）

**入口**：学生详情 → 「⇪ 派生到团队」；或 Studio 新建成员 → mode-cards 选「从教室派生」（demo `07-squad-derive.html`）。

**布局**（design §7 + §8.10：复用 member-create 流程，加第 3 mode）：

- **mode-cards 3 列**（在 `component-new-squad-modal` / `member-create` 中扩展，非独立大页面）：「✨ 空白创建 / 👥 从成员派生 / 🎓 从教室派生」。
- **二级 select 面板**（仅「从教室派生」展开）：grid 2 列——① 教室（pick-item list，logo + 名 + 学生数）+ ② 学生·版本（pick-item list，avatar + 名 + 「最新正式版 · 推荐」+ 版本徽章；初始版学生 `dis` 禁用「仅初始版 · 内容为空」）。
- **copy-note**：indigo 底说明「派生 = 把该学生版本的 system prompt（AGENTS.md）、memory、skills 复制为新成员初始工作区内容。新成员独立演化，不影响教室里的学生。」
- **foot**：src-chain（来源：教室 → 学生 → 版本）+ 取消 + 「派生为成员 →」（提交 `POST /squad/:id/member {mode:'derive_academy', classroomId, studentId, versionId}`）。

组件 spec：`component-derive-academy-picker.md`（picker 本体）；mode-card 扩展记入 `specs/ui/components/studio-page/member-create.md`（coder 同步对齐）。

---

## 11. 视觉基线（design token + 设计稿）

全站 token/组件视觉规则归 `specs/ui/regulation/` 银灰体系（与 Playground/Studio 一致，本节只列 academy 专属差异）。逐组件基线以 `specs/ui/components/academy-page/*.md` 为准。

- **整体**：银灰 token（`--bg=#fafafa` / `--surface=#ffffff` / `--fg=#0a0a0a` / `--accent=#18181b`），与 Playground/Studio 一致。详见 demo `_tokens.css` + `specs/ui/regulation/01-tokens.md §1`。
- **nav-rail**：顶部业务区 2→3 项（Playground 💬 / Studio 👥 / Academy 🎓），底部设置组不变。
- **academy-sidebar**（220px）：白底 + 右 `border`；教室行 `classroom-item`（30×30 logo + 13px/500 名 + 11px muted「N 学生 · M 任务中」）+ 激活态 `bg-accent-light` + foot「academy · 培养专家的地方」。数据集/评估器入口在教室详情 tab（不在 sidebar）；优化 skill 无独立 sidebar 入口。
- **教室详情 ht-col**（400px）：白底 + 右 border；msg bubble 复用 chat 视觉（user 黑底白字 `--accent` / assistant `--surface-2` + border）；max-width 78%；send 30×30 黑底 ➤。
- **学生卡片**：grid repeat 250px / gap 14px；`student-card` `rounded-xl` + border + p-15；hover `border-strong + shadow-md`；30×30 logo（brand-grad 渐变）/ 38×38 avatar（gradient pick）/ 名 13.5px/600 / 当前版 11px muted / tag（训练中 gold / 可用 sage / 未训练 muted）/ 底部 stats 三栏（版本 / 训练任务 / 最近提升 sage +N%）；末位「+ 添加学生」虚线卡（dashed border）。
- **版本树徽章**：`ver-badge` 44×26 mono 12px/600；正式版 `vb-formal` 黑底白字；过程版 `vb-proc` violet 底；缩进 `ver-tree-proc` margin-left:22px + 2px 左竖线。
- **训练观察 train-col**（520px）：白底；`task-status` 4 cell（`ts-cell` border + `bg` + 10.5px muted k + 13.5px mono 600 v，最高分 sage 色）；`iter-item` 卡（cur 边框 accent + shadow-xs）；`step-dot` 18×18 圆形（sage ✓ / gold / muted 数字 / indigo spin）；`reflect-box` violet 底；`gate-tag` 三色（sage ✓ / danger ✗ / gold 进行）。
- **训练结果 diff**：`verdict-hero` sage 渐变底 + sage ico；`score-cell` 4 列（21px mono 700 v）；`diff-item` 折叠卡（head chevron 90° 旋转）；`cmp-cols` 1:1 grid + `diff-add` sage 底 / `diff-del` danger 底 line-through；**skills 段两级**（[v0.0.214]）—— skill 目录级 badge：整体新增 sage / 已移除 danger / 文件修改 gold / 未变 muted（有变更默认展开、未变默认折叠）；其下文件级 badge：新增文件 / 删除文件 / 修改 / 二进制变更 / 不变（binary 只显标签不做行级 diff）。
- **md 编辑器弹层**：720px / `rounded-xl` / shadow-lg；mode-toggle 紧凑分段；view 13.5px/1.75 行高；edit mono 13px/1.7。
- **skill browser 弹层**（[v0.0.214]）：820×560（max 94vw/88vh）/ `rounded-xl` / shadow-lg；左 250px 两级树（`bg-surface-2`，dir gold / file muted，行高 26px）+ 右内容（markdown 13.5px/1.75 · mono `<pre>` 12px/1.6 · 不可预览为 muted mono 提示）；formal 时 head「👁 查看 / ✏️ 编辑」分段 + foot「保存」primary。
- **i18n**：所有可见文案走 `t()`，ns = `academy`；locale 文件路径 `app/web/src/i18n/locales/{zh-CN,en}/academy.json`（zh-CN 与 en **键集完全对等**，新增文案两侧同步补齐）。

---

## 12. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| Academy view 整体契约 + 各 route 多态布局 + 派生入口 | 本文 ✅ |
| nav-rail（Playground/Studio/Academy 入口 + 底部设置组） | `specs/ui/components/framework/nav-rail.md` |
| bizType 字段隔离规则 | `specs/tech/agent/session/[P0]session_biztype.md` |
| Academy 数据模型（classroom/student/version/task/dataset/grader） + 训练引擎状态机 | `specs/tech/academy/` |
| HTTP API 端点（academy CRUD + manage-task / manage-classroom 工具 + version 派生） | `specs/api/overall/` |
| 组件 spec（page-academy / section-* / component-* / primitive-*） | `specs/ui/components/academy-page/`（含视觉基线），实现 `app/web/src/components/academy-page/` |
| 共享 chat 内核（BaseChatPage / ComponentMessageStream / float-menu / ws-panel / memory/cron/skills modal） | `specs/ui/components/chat-page/`（academy 复用，不重新定义） |
| 共享 subagent tree component | `specs/ui/components/chat-page/component-subagent-tree.md`（academy 训练观察复用） |
| squad member-create 扩展（「从教室派生」mode） | `specs/ui/components/studio-page/member-create.md` + `component-derive-academy-picker.md`（academy 侧） |
| 版本模型（正式/过程版本号 + adopt 旁路语义 + 工作区目录规范） | `specs/tech/academy/[P0]data_model.md`（design §2） |
