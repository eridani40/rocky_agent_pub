# section-student-detail（学生详情：版本树 + 四元组）

> 层级: section
> 文件: app/web/src/components/academy-page/section-student-detail.tsx

## 职责
学生详情页：顶 stu-head（返回键 + 学生名 + 顶部操作行）+ 左 300px 版本树 + 右 ver-hero + 四元组 tuple-grid。

边界：不管训练观察（ver-hero 过程版「进入观察」按钮 → 路由到 section-training-observe）；不管版本会话（顶部「发起会话」→ 路由到 section-version-chat）；不管训练发起 modal（顶层 page 持 state）。

## Props
```ts
interface Props {
  classroomId: string;
  studentId: string;
  onBack: () => void; // 回教室详情
  onOpenTrainingObserve: (taskId: string) => void;
  onStartSession: (versionId: string) => void; // 发起会话 → version-chat
  onDeriveToStudio: (versionId: string) => void; // 派生到团队
  /** [v0.0.219] 发起训练；默认基线 hint 可选（不传则由 page-academy 取 currentFormal） */
  onStartTraining: (baseVersionIdHint?: string) => void;
  onEditVersion: (target: MdEditorTarget) => void; // 开 md-editor modal（AGENTS.md）
  onOpenSkillBrowser: (target: SkillBrowserTarget) => void; // 开 skill browser modal（Skills）
  /** [v0.0.219] 开 version memory modal（Memory 卡「查看」，只读） */
  onOpenMemoryModal: (target: VersionMemoryTarget) => void;
  onRefreshContent: () => void;
  /** [v0.0.221] 版本树采纳成功后回刷学生详情（formal 列表新增 + currentFormalVersionId 指针同步） */
  onAdopted?: () => void;
}
```

本 section 导出三个弹层 target 类型，**并列且互不复用**（三条通道彻底分开）：
- `MdEditorTarget`（`saveKind: 'agentsMd' | 'tools'`；`'tools'` 为 dead-but-retained 通道，UI 无触发点）→ `component-modal-md-editor`
- `SkillBrowserTarget`（`{ skills, versionId, versionLabel, readOnly }`）→ `component-skill-browser-modal`
- `VersionMemoryTarget`（`{ memory: MemoryEntrySummary[], versionLabel }`）→ `component-version-memory-modal`（[v0.0.219]）

## 状态 / 交互
- **stu-head**：返回键「← 教室」+ 22px vdivider + 36×36 学生 avatar（gradient）+ 学生名 + `v1.0 正式版` tag + 副「每个版本是一个 agent · 基于工作区目录」+ 右操作行：
  - 「💬 发起会话」outline 按钮
  - 「⇪ 派生到团队」outline 按钮
  - 「＋ 发起训练」primary 按钮（[v0.0.219] onClick `() => onStartTraining()`——不预锁 currentFormal.id，由 page-academy 默认取 currentFormal 作 defaultBaseVersionId，modal 内可 cycle 切任一 formal）
- **左 left-col**（300px）：
  - **版本树**（`component-version-tree`）：`v-list-label`「版本树」+ 平铺版本行（formal 副标题「采纳自 v{label}」/ process 节点名用 3 段 versionLabel）；当前版本高亮 sel 态。
- **右 right-col**：
  - **ver-hero**：60×60 大徽章（mono 700 版本号 + 黑底）+ 版本名「正式版 v1.0」/「过程版 v1.2」+ 副「一个版本 = 一个工作区目录 · 含 prompt / memory / skills / 模型」（不列 Tools，对齐四元组 UI）+ 右侧动作槽位按版本类型分流：
    - **正式版**：无按钮（槽位留空）。编辑走下方四元组卡 item（如 System Prompt 卡），readOnly 由 `openMdEditor` 的 `readOnly: !selectedIsFormal` 控制——能力不变，只是入口从 hero 收回四元组卡。
    - **过程版**：显「进入观察」sm 按钮——`selectedVersion.createdFromTaskId` 有值时渲染，click 调 `onOpenTrainingObserve(selectedVersion.createdFromTaskId)`；缺失（异常）则不显按钮。data-action-key=`academy.version.enterObserve`。同 task 多过程版指向同一 coach session。
  - **tuple-grid**：4 张 tuple-card（垂直堆叠 gap 12px）由 `component-tuple-cards` 渲染 —— **各卡 sub / body / 动作的单一权威是 `component-tuple-cards.md`**，本文不重复描述。要点：
    | 卡片 | icon | 标题 | 动作去向 |
    |---|---|---|---|
    | 1 | 📝 | System Prompt | md 编辑器（`saveKind='agentsMd'`） |
    | 2 | 🧩 | Skills（sub `.rocky/skills/ · N 个 skill · M 个文件`） | 「查看」→ **skill browser 弹层**（不经 md 编辑器） |
    | 3 | 🧠 | Memory（条目数 + 「查看」） | **`onOpenMemoryModal`** → `component-version-memory-modal`（只读） |
    | 4 | 🤖 | 模型 | `InputModelPicker` → PATCH versionJson.model |
  - target 组装在本 section（含 `readOnly = !selectedIsFormal`），modal state 归 `page-academy`。
- **可见文案**（E2E）：「← 教室」/ 学生名 / 「v1.0 正式版」/ 「每个版本是一个 agent…」/ 「💬 发起会话」「⇪ 派生到团队」「＋ 发起训练」/ 「版本树」/ 「进入观察」（过程版 ver-hero）/ 四元组卡文案见 `component-tuple-cards.md`。

## 复用关系
- 左侧组合 `component-version-tree`。
- 右侧组合 `component-tuple-cards`（四元组卡）。
- 卡动作触发的弹层均由顶层 `page-academy` 持 state：AGENTS.md → `component-modal-md-editor`；Skills → `component-skill-browser-modal`；Memory → `component-version-memory-modal`。
- 工具 / 模型 picker 复用通用控件（chat-page 的 InputModelPicker 等），不走 md-editor。

## 视觉基线
- 设计稿来源：`demo/03-student-detail.html`。
- 尺寸：stu-head p-13/20；left-col 300px；right-col flex-1；ver-hero-badge 60×60；tuple-card `rounded-xl` + p-13/15。
- 字体：stu-name 15px/600；ver-name 12.5px/500；tuple-title 13px/600；code-block mono 12px/1.65。
- 边框：stu-head bottom border；left-col right border；tuple-card border + head bottom border；tuple-head `bg-warm`。
- 配色：tag-sage 正式版/当前；tag-gold 训练中；tag-muted 未训练/初始；skill-chip border + bg-surface；tool-chip indigo-bg。
