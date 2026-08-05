# primitive-status-badge（academy 状态标签）

> 层级: primitive
> 文件: app/web/src/components/academy-page/primitive-status-badge.tsx

## 职责
academy 各处通用的状态徽标：版本类型（正式/过程）+ 任务状态（pending/running/awaiting_confirm/done/rejected/paused）+ 训练优化模式（学习/训练）。复用全站 tag 视觉。

边界：纯展示，不含交互；不含业务语义（业务在父级）。

## Props
```ts
type Variant =
  | 'formal' | 'process' // 版本类型
  | 'current' // 当前正式版
  | 'training' | 'ready' | 'untrained' // 学生状态
  | 'pending' | 'running' | 'paused' | 'awaiting_confirm' | 'done' | 'rejected' // 任务状态
  | 'learn' | 'train' // 优化模式
  | 'gate-baseline' | 'gate-regressed' | 'gate-pending' | 'gate-kept'; // 迭代 gateDecision

interface Props {
  variant: Variant;
  label?: string; // 自定义文案；缺省走 i18n 默认
  size?: 'sm' | 'md';
}
```

## 状态 / 交互
- `.tag` h-20 + p-0/7 + `rounded-sm` + 11px/500 + whitespace-nowrap。
- 按 variant 映射颜色（设计 token + i18n key）：

| variant | 配色 | 默认文案 | i18n key |
|---|---|---|---|
| formal | `--color-accent` 黑底白字 | 「正式版」 | academy:badge.formal |
| process | `--color-violet-bg` + `--color-violet` | 「过程版」 | academy:badge.process |
| current | `--color-sage-bg` + `--color-sage` | 「当前」 | academy:badge.current |
| training | gold-bg / #b45309 | 「训练中」 | academy:badge.training |
| ready | sage-bg / sage | 「可用」 | academy:badge.ready |
| untrained | surface-2 / muted | 「未训练」 | academy:badge.untrained |
| pending | surface-2 / muted | 「待开始」 | academy:task.pending |
| running | gold-bg / #b45309 | 「进行中」 | academy:task.running |
| paused | surface-2 / muted | 「已暂停」 | academy:task.paused |
| awaiting_confirm | gold-bg / #b45309 | 「等待审核」 | academy:task.awaiting_confirm |
| done | sage-bg / sage | 「已完成」 | academy:task.done |
| rejected | danger-light / danger | 「已拒绝」 | academy:task.rejected |
| learn | indigo-bg / indigo | 「学习优化」 | academy:optimize.learn |
| train | violet-bg / violet | 「训练优化」 | academy:optimize.train |
| gate-baseline | sage-bg / sage | 「✓ 成为基线」 | academy:gate.baseline |
| gate-regressed | danger-light / danger | 「✗ 退化」 | academy:gate.regressed |
| gate-pending | gold-bg / #b45309 | 「进行中」 | academy:gate.pending |
| gate-kept | surface-2 / muted | 「未替换」 | academy:gate.kept |

- **可见文案**（E2E）：上表「默认文案」列（用户可见 = E2E 定位契约）。

## 复用关系
- 被全 academy-page 内多组件组合：`component-version-tree` / `component-student-card` / `component-training-status-bar` / `component-iteration-timeline` 等。
- 视觉复用全站 `.tag` 类（regulation 02）；与 studio `tag-{sage,gold,violet,...}` 同款。

## 视觉基线
- 设计稿来源：所有 demo（`.tag` 通用类）。
- 尺寸：tag h-20 + p-0/7 + `rounded-sm`（radius 6px）。
- 字体：11px/500。
- 边框：默认无；`tag-outline` 变种（不在 academy 用）有 border。
- 配色：按 variant 映射（见上表）；全部走 `specs/ui/regulation/` 银灰 + hue 体系，禁字面 hex。
