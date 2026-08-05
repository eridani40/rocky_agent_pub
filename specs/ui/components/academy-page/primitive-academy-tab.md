# primitive-academy-tab（教室详情右栏 tab 切换）

> 层级: primitive
> 文件: app/web/src/components/academy-page/primitive-academy-tab.tsx

## 职责
教室详情右栏 content-col 头部的 tab 切换：学生 / 训练任务 / 数据集 / 评估器。下划线式激活态。

边界：只切内容（本地 activeTab state），不改 mainView route；不带图标（纯文字 + 可选 tag 计数）。

## Props
```ts
interface Tab {
  id: string; // 'students' | 'training-tasks' | 'datasets' | 'graders'
  label: string; // '学生' / '训练任务' / '数据集' / '评估器'
  countTag?: { text: string; tone: 'gold' | 'muted' | 'sage' }; // '2 进行中' / '4' 等
}
interface Props {
  tabs: Tab[];
  activeId: string;
  onChange: (id: string) => void;
}
```

## 状态 / 交互
- `.tabs` flex + gap-2 + bottom border。
- `.tab` h-34 + p-0/13 + 13px + muted + `border-b-2 transparent` + `-mb-px`；hover fg；active fg + `border-b-accent`。
- countTag 内嵌在 tab label 后（如「训练任务」+ `tag-gold`「2 进行中」）。
- **可见文案**（E2E）：tab 名「学生」「训练任务」「数据集」「评估器」+ countTag 文案（「N 进行中」/ 计数数字）。

## 复用关系
- 被 `section-classroom-detail` 组合。
- 视觉与 studio-page `tabs`（`06-studio.md` 头部 tab）+ chat-page `tabs` 同款（regulation 02 §8 下划线式）；可考虑提升到 `framework/primitive-tab`（未来跨 ≥3 页复用时）。

## 视觉基线
- 设计稿来源：`demo/02-classroom-detail.html` `.tabs / .tab`。
- 尺寸：tabs flex + border-b；tab h-34 + p-0/13。
- 字体：tab 13px/500。
- 边框：tabs bottom border；tab border-b-2 transparent / active `--color-accent`。
- 配色：tab 默认 muted；hover/active `--color-fg`；active 下划线 `--color-accent`；countTag tone gold/muted/sage。
