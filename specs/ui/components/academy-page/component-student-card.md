# component-student-card（学生卡片）

> 层级: component
> 文件: app/web/src/components/academy-page/component-student-card.tsx

## 职责
教室详情学生 tab 网格中的学生卡：avatar + 名 + 当前正式版 + 状态 tag + 3 统计列（版本/任务/最近提升）。点卡进学生详情。

边界：不显示版本树（归 section-student-detail）；不发起操作（发起按钮在学生详情顶部）。

## Props
```ts
interface Props {
  student: {
    id: string; name: string;
    avatarGradient?: string; // 'linear-gradient(135deg,#ec4899,#f97316)' 等
    currentVersionLabel?: string; // 'v1.0' / '初始版 v0.0'
    status: 'training' | 'ready' | 'untrained';
    versionCount: number;
    taskCount: number;
    recentGain?: number | null; // +18 → 18；null → '—'
  };
  onClick?: () => void;
}
```

## 状态 / 交互
- 卡容器：`card student-card` p-15 + cursor-pointer + hover `border-strong + shadow-md`。
- **stu-top**（avatar + 名 + tag）：38×38 avatar（gradient 来自 prop）+ 13.5px/600 名 + 11px muted 当前版 + 右 tag（`tag-gold` 训练中「训练中」/ `tag-sage` 可用 / `tag-muted` 未训练）。
- **stu-stats**（底部三栏，top border）：每栏 `stu-stat`（b 15px/600 + span 10.5px muted 标签）：版本数 / 训练任务数 / 最近提升（`+N%` sage 色，null 显「—」）。
- **可见文案**（E2E）：学生名 + 当前版（如「当前正式版 v1.0」/「初始版 v0.0」）+ 状态 tag 文字「训练中」/「可用」/「未训练」+ 「版本」「训练任务」「最近提升」。

## 复用关系
- 被 `section-classroom-detail` 学生 tab 组合 × N，放在 `student-grid`（repeat minmax(250px,1fr)）。
- 末位「+ 添加学生」是 sibling 虚线卡（非本卡可点击态），由 section 直接渲。

## 视觉基线
- 设计稿来源：`demo/02-classroom-detail.html` `.student-card`。
- 尺寸：卡 p-15 + min-w 250（grid）；stu-top gap-11 mb-11；stu-stats pt-11 gap-14。
- 字体：stu-name 13.5px/600；stu-v 11px muted；stat b 15px/600；stat span 10.5px muted。
- 边框：卡 `rounded-xl` + 1px border + hover border-strong + shadow-md（过渡 .15s）。
- 配色：avatar gradient；tag 三色按 status（gold/sage/muted）；recentGain sage 色（`--color-sage`）。

## 消费方

- `app/web/src/components/academy-page/component-classroom-tab-panels.tsx`
