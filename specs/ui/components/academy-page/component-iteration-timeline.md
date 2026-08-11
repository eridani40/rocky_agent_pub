# component-iteration-timeline（多轮迭代倒序折叠卡）

> 层级: component
> 文件: app/web/src/components/academy-page/component-iteration-timeline.tsx

## 职责
训练观察右栏 train-col 的迭代记录区：`sec-label` 头 + `vs-toggle` 切换对比基准（临时基线/训练 base）+ 倒序 iter-item 列表（每轮一个折叠卡，展开含 4 step + case 表 + 反思盒）。

边界：不管任务状态（归 `component-training-status-bar`）；不管 coach 对话（归 chat-col）；只读训练引擎推送的 turn 数据。

## Props
```ts
interface Turn {
  id: string;
  versionLabel: string; // 'v1.2.3'
  gateDecision: 'became_baseline' | 'regressed' | 'pending' | 'kept_baseline';
  score?: number; // 7.6
  previousScore?: number; // 6.8 → 算 ↑/↓
  steps: Step[]; // 4 step
  cases?: CaseRow[]; // 评估 step 展开时
  reflection?: string;
  workingSubagentId?: string; // 优化中 → working-link 可点
}

interface Props {
  turns: Turn[]; // 倒序：最新轮在前
  compareBaseline: 'temp' | 'training'; // vs 临时基线 / vs 训练 base
  onCompareChange: (b: 'temp' | 'training') => void;
  onOpenSubagent?: (sessionId: string) => void;
}
```

## 状态 / 交互
- **sec-label**：「迭代记录」12px/600 + 右 `vs-toggle` 二段（激活黑底白字）。
- **iter-item × N**（倒序，gap 9px mb）：
  - **iter-head**（p-9/12 cursor-pointer）：版本号 mono 12.5px/600 + gate-tag（`✓ 成为临时基线` sage / `✗ 退化 · 未替换` danger / `进行中` gold / `✓ 曾成为基线` sage muted）+ 右分数 mono 12px/600 + ↑/↓/— 箭头（sage ↑ / danger ↓）。cur 轮 iter-item border-accent + shadow-xs。
  - **iter-detail**（展开时，top border + `bg` p-12/14）：
    - 4 step（每 step 一行 p-7/0 + 18×18 step-dot）：
      - ✓ dot-sage「fork v1.2.3 → v1.2.4」
      - ◐ dot-indigo spin「优化 agent 改写 prompt（训练优化）」+ **working-link** 「👁 观察 →」（仅 workingSubagentId 存在时渲染，design §8.8：进行中才可点；点击 `onOpenSubagent(workingSubagentId)`）。
      - · dot-muted 数字「4」「评估（每 case 独立打分）」。
      - · dot-muted 数字「5」「反思 + 决策是否替换基线」。
    - **case-table**（评估 step 展开时）：`component-case-table` 嵌入。
    - **reflect-box**（反思 step 展开时）：violet 底 p-10/12 + 「反思：」b + 正文。
- **可见文案**（E2E）：「迭代记录」/ 「vs 临时基线」「vs 训练 base」/ 版本号 / gate 文案「✓ 成为临时基线」「✗ 退化 · 未替换」「进行中」「✓ 曾成为基线」/ 分数 + ↑↓ / 4 step 文案 / 「👁 观察 →」/ 「每题得分（N case，独立 LLM 打分）」/ 「反思：」。

## 复用关系
- 组合 `component-case-table`（评估 step 展开时嵌入）。
- 被 `section-training-observe` train-col 组合。
- working-link 触发的只读 transcript 页由 `component-session-readonly`（内嵌 `chat-page/section-chat-session`，chrome.readOnly 自动 true）承载。

## 视觉基线
- 设计稿来源：`demo/04-training-observe.html` `.iter-item / .step / .working-link`。
- 尺寸：iter-item border `rounded-lg` mb-9；iter-head p-9/12；iter-detail p-12/14 + `bg`；step p-7/0；step-dot 18×18；reflect-box p-10/12。
- 字体：iter-ver mono 12.5px/600；iter-score mono 12px/600；step 12.5px；working-link 11px。
- 边框：iter-item border；cur 加 border-accent + shadow-xs；iter-detail top border。
- 配色：gate-tag sage/danger/gold；step-dot sage ✓ / gold 进行 / muted 数字 / indigo spin；working-link `--color-indigo`；reflect-box `--color-violet-bg` + fg-2。

## 消费方

- `app/web/src/components/academy-page/component-train-view-col.tsx`
- `app/web/src/components/academy-page/section-training-observe.tsx`
