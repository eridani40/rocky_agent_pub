# component-classroom-card（教室行卡）

> 层级: component
> 文件: app/web/src/components/academy-page/component-classroom-card.tsx

## 职责
sidebar 内的教室单行卡（logo + 名 + 学生/任务摘要）。点行触发选中教室；active 态由父级控制。

边界：不显示教室内部内容（学生网格归 section-classroom-detail）；不显示任务详情（只显示计数）。

## Props
```ts
interface Props {
  classroom: { id: string; name: string; logo?: string; logoBg?: string; studentCount: number; activeTaskCount: number };
  active?: boolean;
  onClick: () => void;
}
```

## 状态 / 交互
- 行容器：`classroom-item` p-8/10 `rounded-lg` + hover/active `bg-accent-light`。
- 30×30 logo 方块（`rounded-md`）+ bg 来自 `logoBg` prop（如 `--color-violet-bg` / `--color-indigo-bg`）。
- 文字列：13px/500 名（ellipsis）+ 11px muted「N 学生 · M 任务中」（M=0 时省略「· M 任务中」）。
- **可见文案**（E2E）：教室名 + 「N 学生 · M 任务中」。

## 复用关系
- 被 `section-classroom-list` 组合 × N。
- 视觉模式平行于 `studio-page/studio-sidebar` 的 squad 行（扁平单行，无展开树）。

## 视觉基线
- 设计稿来源：`demo/01-classroom-list.html` `.classroom-item`。
- 尺寸：行 p-8/10 + gap-10；logo 30×30 `rounded-md`。
- 字体：名 13px/500；副 11px muted。
- 边框：仅 hover/active 底色变化，无边框。
- 配色：logo bg 由 `logoBg` prop 派生（典型 violet-bg / indigo-bg）；active 底色 `--color-accent-light`（=#f4f4f5）。
