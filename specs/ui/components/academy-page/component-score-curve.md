# component-score-curve（评分走势折线图，可选）

> 层级: component
> 文件: app/web/src/components/academy-page/component-score-curve.tsx

## 职责
训练观察右栏的可选组件：轮次 X 轴 vs 平均分 Y 轴的折线图，标记 base 分基线和临时基线演进点。

边界：只读展示；不触发交互（点轮次不跳转，那是 iter-item 的职责）；本组件可选——MVP 可不实现（design §8.5 未强制）。

## Props
```ts
interface Point { turn: number; score: number; isBaseline?: boolean; }
interface Props {
  points: Point[]; // 按轮次升序
  baseScore: number; // base 分基线（画水平虚线）
}
```

## 状态 / 交互
- 折线 + 数据点 + base 水平虚线 + Y 轴标签（0-10）+ X 轴轮次标签（1, 2, 3…）。
- 临时基线点（isBaseline=true）高亮 sage 实心 + 其他点普通圆。
- **可见文案**（E2E）：Y/X 轴数字 + 可选 tooltip「轮 N · 分数 X」。

## 复用关系
- 被 `section-training-observe` train-col 在 iter-list 上方/下方嵌入（可选）。
- 复用 `widget-score-curve` 旧组件思路（已删但调研留参考）；coder 按调研实现（纯函数 + 简单 SVG）。

## 视觉基线
- 设计稿来源：无直接 demo 页面（design §8.5 描述 + 调研）。
- 尺寸：高度 ~120px，宽度撑满 train-col。
- 字体：轴标签 11px mono muted；tooltip 12px。
- 边框：图区无 border，仅网格线 1px surface-2。
- 配色：折线 `--color-accent` 黑；基线点 sage；普通点 accent；base 虚线 muted-2 dashed。
