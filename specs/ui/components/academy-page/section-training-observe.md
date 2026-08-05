# section-training-observe（训练观察页：coach 对话 + 训练视图）

> 层级: section
> 文件: app/web/src/components/academy-page/section-training-observe.tsx

## 职责
训练任务观察页（最复杂自定义页）：obs-topbar（任务名 + 状态 + 生命周期按钮 v0.0.221 两轴模型）+ 中 chat-col（coach 对话，经 `chat-page/section-chat-session` 接入）+ 右可拖宽 train-col（默认 520px；任务状态 4 cell + 迭代 timeline + case 表 + 反思盒 + subagent working 入口）。

边界：不管训练发起（归 modal）；v0.0.221 删 section-training-result（采纳改为版本树旁路 adopt，不再有独立结果页）；只读训练状态由训练引擎推送（SSE），UI 不直接 mutate。

## Props
```ts
interface Props {
  classroomId: string;
  taskId: string;
  taskDetail: TrainingTaskDetail;
  onReloadTask: () => void;
  studentDetail: StudentDetail;
  onBack: () => void;
  onOpenSubagent: (sessionId: string) => void;
}
```

## 状态 / 交互
- **obs-topbar**：返回键「← 学生」+ 22px vdivider + 任务名「v{baseMajor}.{seq} 训练任务」+ 「多轮 · 训练优化」violet tag + 状态 tag + 生命周期按钮（见 `component-training-status-bar` spec）。
- **[v0.0.221] 生命周期按钮组**（不再有 stop；不再有 awaiting_confirm→result 入口）：
  - running/pending → 「⏸ 暂停」（POST /pause）
  - paused + reason≠maxturns → 「▶ 续训」（POST /resume）
  - paused + reason=maxturns → 「⬆ 调大至 {当前+5} 轮」（POST /update-task {maxTurns:+5}）
  - 动作统一走 `runTaskAction`（busy 锁 + error 展示 + 成功后 onReloadTask）；actionError 显 obs-topbar 下沿 danger 行。
- **chat-col**（中 flex-1）= `SectionChatSession sessionId={coachSessionId}`（能力全开，`_overview §2`）：
  - topbarLeft 注入 `ComponentAcademyChatHeader`：28×28 教练 avatar（gradient indigo→violet）+ 「教练」+ 「● 工作中」sage 色 + 「academy-coach」mono tag。
  - usage 三件套 / Clear 确认 modal / 消息流 / 输入区全部内置（页面零接线）。
  - **保留 `onMessagesChange={handleMessagesChange}`**：消息驱动任务刷新残留（后端无 training.* SSE）——只用于任务刷新，**禁止**用于回收 messages 建 UI（防双 useMessages 订阅）；防 use-training-task 死循环链路（软刷新 mutateCtx 机制）不动。
  - **placeholder**：「和教练说点什么，指导训练方向…」
  - **高度链**：行容器 `min-h-0`；chat-col 包装层为水平 flex + `min-h-0 overflow-hidden`（禁 flex-col 垫层，见 `_overview §2 宿主高度链约束`）。
- **train-col**（右，可拖宽：默认 520 / min 380 / max 800；左缘复用 `chat-page/component-col-resize-handle`（side='right'）拖拽，宽度经 `common/use-persistent-width` + `ACADEMY_COL.train` 常量持久化 localStorage 全局 key `academy-train-col-width`）：
  - **train-head**：「训练视图」13px/600 + 副「base v1.0 · 评估器：种草文案」11px muted。
  - **task-status**（4 cell grid，gap 10px）：
    - 任务状态 / 当前轮次（4/5）/ 临时基线（v1.2.3）/ 最高分（7.6 sage 色）
  - **迭代记录**（`component-iteration-timeline`）：
    - sec-label「迭代记录」+ 右 `vs-toggle`（「vs 临时基线」「vs 训练 base」二段，激活黑底）。
    - 倒序 iter-item 列表：
      - **iter-head**：版本号（mono 12.5px/600）+ gate-tag（sage ✓ 成为基线 / danger ✗ 退化未替换 / gold 进行中）+ 分数（mono 12px/600 + ↑/↓ 箭头）。
      - **iter-detail**（展开态）：4 step：
        - ✓ fork v1.2.3 → v1.2.4（sage dot）
        - ◐ 优化 agent 改写 prompt（indigo spin dot + working）+ **「👁 观察 →」working-link**（点 → `onOpenSubagent`）
        - · 评估（每 case 独立打分）（muted 数字 dot）
        - · 反思 + 决策是否替换基线（muted 数字 dot）
      - **case-table**（评估 step 展开时）：每 case 一行（tag 分数 + 题目 ellipsis + 正/负/中 标签）+ 「… 共 N 条」汇总行。
      - **reflect-box**（反思 step 展开时）：violet 底盒 + 「反思：」+ 反思正文。
- **[v0.0.221] 生命周期动作**：`handlePause` → `pauseTrainingTask(taskId)`；`handleResume` → `resumeTrainingTask(taskId)`（maxturns 到顶后端返 409 task_at_maxturns，前端 catch 显错并指引先调大）；`handleIncreaseMaxTurns` → `updateTrainingTask(taskId, {maxTurns: 当前+5})`（调大后用户再点 resume）。design §4.1：状态机推进权归程序；UI 走 HTTP 不直接 mutate。
- **可见文案**（E2E）：「← 学生」/ 任务名 / 「多轮 · 训练优化」/ 状态文案（含 pausedReason 细分）/ 「⏸ 暂停」「▶ 续训」「⬆ 调大至 N 轮」/ 「教练」/ 「● 工作中」/ 「academy-coach」/ placeholder「和教练说点什么…」/ 「训练视图」/ 「base vN · 评估器：…」/ 4 状态格 label / 「迭代记录」/ 「vs 临时基线」「vs 训练 base」/ 版本号 / 「✓ 成为临时基线」「✗ 退化 · 未替换」「进行中」/ step 文案 / 「👁 观察 →」/ 「每题得分（N case，独立 LLM 打分）」/ 「共 N 条」/ 「反思：」。

## 复用关系
- 中 chat-col 经 `chat-page/section-chat-session` 接入（coach 是正经 academy-coach session，design §8.1 + §8.7：可对话）+ topbarLeft 注入 `component-academy-chat-header`。
- 右 train-col 组合 `component-iteration-timeline`（含 `component-case-table`）+ `chat-page/component-subagent-tree`（flat + onOpenNode「观察 →」）+ 自实现 task-status grid。
- subagent 观察 → 跳只读 transcript 页（`component-session-readonly`，SectionChatSession chrome.readOnly 自动 true）。

## 视觉基线
- 设计稿来源：`demo/04-training-observe.html`。
- 尺寸：obs-topbar p-10/18 h-auto；chat-col flex-1 min-w-0；train-col 默认 520px（可拖 380~800，persist `academy-train-col-width`）；task-status cell 1fr × 4；iter-item `rounded-lg`；step-dot 18×18；case-table row p-7/11；reflect-box p-10/12。
- 字体：obs 任务名 13.5px/600；msg-bubble 13px/1.6；ts-cell v mono 13.5px/600；iter-ver mono 12.5px/600；iter-score mono 12px/600。
- 边框：obs-topbar bottom border；chat-col right border；train-col 无左 border（chat-col 已有）；ts-cell border；iter-item border（cur 态 border-accent + shadow-xs）；iter-detail top border + `bg`；case-table border + 行 bottom border。
- 配色：msg.user `--accent`；msg.assistant `--surface` + border；gate-tag 三色（sage/danger/gold）；step-dot 四色（sage/gold/muted/indigo）；reflect-box violet-bg；working-link indigo。
