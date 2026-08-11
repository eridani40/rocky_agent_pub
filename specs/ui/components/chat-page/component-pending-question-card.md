# component-pending-question-card

> 层级：`component-`（功能组件，含业务语义）。组合 primitive（radio/checkbox/input/textarea/button/tooltip）。
> 归属一级目录：`chat-page/`（与 component-enqueue-view 同级）。
> 实现拆分（同目录三件套）：
> - `component-pending-question-card.tsx` — 容器：selections/other 本地态 + 整体布局（头部/导航列+内容区/底栏）+ 提交
> - `component-pending-question-nav.tsx` — 左侧竖向步骤导航（仅多题渲染）
> - `component-pending-question-block.tsx` — 单题选项区块（radio/checkbox + 「其他」toggle/textarea）
> 后端契约：`specs/api/overall/04-agent-session.md §3.6`（GET /pending-tool-call）+ `§3.2`（POST /messages toolReply）+ agent_event §7（require_human_input payload=pending）

## 消费方

- `components/chat-page/base-chat-input-bar.tsx`

## 职责
- 渲染队首 `subState==='need_feedback'` 的 PendingToolCall（data=FeedbackData）：挂 chat-input-bar composer 上方（与 enqueue-view 互斥），SSE require_human_input 驱动 mount，提交后乐观清 unmount（多 pending 串行 INV-4）；`key=toolCallId` 切 pending 天然 remount、本地态（selections/activeQuestionId）全重置。
- 多题（questions.length>1）左侧竖向步骤导航分题作答，一次只渲染 active 题的选项区块；单题不渲染导航列、内容区独占。
- 底栏常驻「已答 X/N + 提交」；每题 ≥1 项 selection 才放行提交，payload=FeedbackAnswer.selections。
- 只渲染 `need_feedback`；`need_approval` 防御性返回 null（交审批卡 component-pending-approval-card）。

## Props
```ts
// card（对外入口）
interface PendingQuestionCardProps {
  pending: PendingToolCallView;  // 队首（subState='need_feedback'，data=FeedbackData）
  onSubmit: (toolCallId: string, handleType: 'direct_result'|'approval'|'callback', payload: FeedbackAnswer) => void;
}
// nav（card 左列）
interface PendingQuestionNavProps {
  questions: PendingQuestion[];
  activeQuestionId: string;              // active 项 bg-surface 高亮（与内容区连通）
  isAnswered: (qId: string) => boolean;  // 状态圆点用
  onSelect: (qId: string) => void;       // click 与 focus 共用入口
}
// block（card 内容区，只接 active 题）
interface PendingQuestionBlockProps {
  q: PendingQuestion;
  sel: string[];                         // 该题当前 selection（含「其他：<text>」）
  isOpen: boolean;                       // 该题「其他」是否展开
  otherValue: string;                    // 该题「其他」输入框文本
  toggleOption: (q: PendingQuestion, key: string) => void;
  toggleOther: (q: PendingQuestion) => void;
  setOther: (qId: string, text: string) => void;
  t: ReturnType<typeof useTranslation>['t'];
}
```

## 状态 / 交互（MANDATORY — 决策锁定）
1. **多问题 = 单 ask-question 内 questions[]**：实现选 **左侧竖向步骤导航**（竖滚=桌面鼠标滚轮原生方向，题数无上限）。多题导航 ≠ 多 pending（D4 两层不混）。
   - **对下游 E2E 的影响**：DOM 里只有 active 题的选项区块——E2E 需**先点该题导航项切过去，再断言该题选项**（不能假设所有题选项同时在 DOM）。
   - **键盘 focus-follows**：每个导航项是原生 `<button>`（可聚焦，**不设 `tabIndex=-1`** 阻断键盘），`onClick` 与 `onFocus` 都切 active 题——键盘 Tab/Shift+Tab 焦点落到哪个导航项，内容区就跟到哪题。导航项用稳定 `key=q.id` 且 active 变更不 remount → 焦点不丢、Tab 序列连续。
2. **每题作答**（选项竖向堆叠、每项独占一行 pill）：
   - `type='single'` → radio 单选（禁原生 select）；`type='multi'` → checkbox 多选。
   - 选项点击统一走 `label.onClick + preventDefault`（原生 input `pointerEvents:none` + `tabIndex=-1`），`checked` 由 selections 派生受控（radio 需绕过原生翻转才能「再点切掉」）。单选再点同 key = 切掉（允许空答，但提交仍要求每题 ≥1 项）。
   - **「其他」恒定渲染为每题末位选项**——前端不消费 `allowOther`（字段保留于 schema/types 仅为持久化兼容）。toggle 展开自适应 textarea（1 行起，最高 ~5 行/120px 后内滚）；非空文本合成单条 selection 值 `其他：<text>`（全角冒号），空文本不占 selection；收起即清该题「其他：<text>」selection + 文本。
   - 单选题「其他」与普通选项互斥（同 radio 组）：选普通项 → 收起并清「其他」；打开「其他」→ 清普通项 selection。多选并存。
3. **单选选中普通选项自动前进**：单选「新选中」（再点同 key 切掉不算）后，自动切到按 questions 顺序的第一道未答题（排除当前题；无未答题不跳）。多选 / 选「其他」不跳。
4. **提交门控**：底栏左「已答 X/N」进度（已答 = 该题 ≥1 项 selection）；全答完才放行。未答完提交按钮 `aria-disabled`（非原生 disabled，保外层 wrapper hover）+ onClick 拦截，外层 PrimitiveTooltip 承接 hover 弹提示；无取消按钮（INV-7），composer 提问态保持可用。
5. **卡片 max-h-[360px] 封顶**：头部（prompt/awaitInput）与底栏常驻不滚，导航列与内容区各自 `overflow-y-auto` 内滚，卡片整体不无限撑高、composer 不被顶飞。

## 可见文案（i18n，ns=chat）
- 头部：有 prompt 显示 prompt；否则 mono pulse 圆点 + `pendingQuestion.awaitInput`（等待你的回答）。
- 底栏进度：`pendingQuestion.progress`（已答 {{answered}}/{{total}}）。
- 提交按钮：`pendingQuestion.submit`（提交）；未答完 tooltip：`pendingQuestion.submitHint`（请回答完问题再提交）。
- 多选标记：题干后 `[多选]` mono 小字，`pendingQuestion.multi`（多选）。
- 「其他」选项：`pendingQuestion.other`（其他）；输入框 placeholder：`pendingQuestion.otherPlaceholder`（请输入其他答案）。

## 定位符
- `data-testid="pending-q-nav-{qId}"` — 导航项 button（UT 切题定位用；本组件唯一 testid）。
- `name="pending-q-{qId}"` — 单题 radio/checkbox 同组名（普通选项与「其他」同组，单选原生互斥）。
- 选项个体无 testid/name 定位，按可见 label 文案定位（_conventions §6：E2E 以可见文案+位置定位）。

## 视觉基线
- 复用 chat-page 现有卡片视觉：accent 边 + accent-light 底 + rounded-xl，max-w-[820px] 居中。
- **竖向导航列（纯序号竖 tab）**：固定宽 `w-14`（~56px）不收缩、无右 padding（tab 顶到内容区左缘），题多仅本列竖滚（scrollbar-thin，题数不硬截断）。每题一格方块 tab（w-full h-9、flex 居中）：内容仅 状态圆点（未答=accent 橙点 / 已答=sage 绿点 `--color-sage`）+ 序号 `Q01` 起（两位 `padStart(2,'0')`，font-mono 等宽不跳变）；**不渲染题目标题**（内容区有完整题干，零信息损失）。去胶囊走经典竖 tab 切换：active 项 `bg-surface text-accent`、右缘与内容区贴合同色连通成一体（tab 只圆左缘 `rounded-l-md`）；非 active 透明底 `text-muted` + hover `bg-surface/60 text-fg-2` 过渡。
- **内容区**：多题时独立 `bg-surface rounded-r-lg` 面板（内边距 `px-3 py-2`）浮在卡片 accent-light 底上（左右两区背景差形成区隔；左缘不圆角，保与 active tab 无缝连通）。单题不渲染导航列、内容区不套面板维持原样。题干完整标题（多选带 `[多选]` 标记）+ 选项 pill（选中=accent 边/accent-light 底/accent 文案；未选=border 边/surface 底 + hover accent 边）。
- 提交按钮沿用 `chat-send` 主按钮配色（accent）；未答完 `aria-disabled` 灰态（bg-warm 底 + muted 文案 + cursor-not-allowed）+ hover primitive-tooltip 提示。
