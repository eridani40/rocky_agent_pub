# component-case-table（每 case 评估结果表）

> 层级: component
> 文件: app/web/src/components/academy-page/component-case-table.tsx

## 职责
训练观察展开轮内的 case 评估结果行式表：每 case 一行（分数 tag + 题目 + 正/负/中 标签）+ 「共 N 条」汇总。

边界：不评 case（评估走后端 llm-judge 程序化直调，design §4.4）；不管反思（归 iter-detail reflect-box）。

## Props
```ts
interface CaseRow {
  id: string;
  score: number; // 0-10
  question: string; // 题目（ellipsis）
  level: 'positive' | 'negative' | 'neutral';
  reasoning?: string; // 评估理由（可选，hover/展开看）
}
interface Props {
  cases: CaseRow[];
  total?: number; // 当 cases 是截断展示时，提供 total > cases.length 显示「共 N 条」
}
```

## 状态 / 交互
- **小标题**（嵌入 iter-detail 时）：「每题得分（N case，独立 LLM 打分）」11.5px/600 fg-2 mb-6。
- **case-table**（border + `rounded-md` overflow-hidden + bg-surface）：
  - **case-row × N**（p-7/11 + bottom border + 12px）：tag（分数 + 颜色按分值：9 sage / 4 danger / 6 gold）+ `case-q` 题目（flex-1 ellipsis）+ 右 level 标签（「正」sage / 「负」danger / 「中」#b45309）。
  - 最后一行（如有 total 截断）：`justify-center + muted`「… 共 N 条」。
- **可见文案**（E2E）：「每题得分（N case，独立 LLM 打分）」/ 每题分数（数字）/ 题目文本 / 「正」「负」「中」/ 「共 N 条」。

## 复用关系
- 被 `component-iteration-timeline` 在评估 step 展开时嵌入。

## 视觉基线
- 设计稿来源：`demo/04-training-observe.html` `.case-table / .case-row`。
- 尺寸：table border + `rounded-md` overflow-hidden；row p-7/11 + bottom border（最后无 border）；gap-9。
- 字体：row 12px；分数 tag mono 11px/500；题 12px ellipsis。
- 边框：table 1px border；行 bottom border（last-child none）。
- 配色：分数 sage-bg/sage（>=8）/ gold-bg/#b45309（6-7）/ danger-light/danger（<=5）；level 标签同 sage/danger/gold 配色。

## 消费方

- `app/web/src/components/academy-page/component-iteration-timeline.tsx`
- `app/web/src/components/academy-page/section-training-observe.tsx`
