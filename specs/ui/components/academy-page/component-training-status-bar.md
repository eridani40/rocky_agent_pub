# component-training-status-bar（任务状态条 topbar）

> 层级: component
> 文件: app/web/src/components/academy-page/component-training-status-bar.tsx

## 职责
训练观察 obs-topbar 内嵌任务状态条：任务名 + 模式 tag + 状态 tag + 生命周期按钮。
v0.0.221 两轴模型对齐三态机：去 stop（head 无权 stop，coach 用 pause 可逆停）；新增 resume / increaseMaxTurns 入口。

边界：不管任务内部迭代（归 `component-iteration-timeline`）；不管 task 列表筛选。

## Props
```ts
type TrainingTaskStatus = 'pending' | 'running' | 'paused';
type TrainingTaskPausedReason = 'maxturns' | 'completed' | 'stopped' | 'earlystop';

interface Props {
  task: {
    id: string;
    name: string;                       // 'v1.2 训练任务'（caller 拼）
    mode?: 'simple' | 'multi';          // 模式 tag
    optimizeStyle?: 'learning' | 'training';
    status: TrainingTaskStatus;         // v0.0.221 三态机
    pausedReason?: TrainingTaskPausedReason;
    currentTurn?: number;
    maxTurns?: number;
  };
  onPause?: () => void;              // running/pending → paused（POST /pause）
  onResume?: () => void;             // paused + reason≠maxturns → running（POST /resume）
  onIncreaseMaxTurns?: () => void;   // paused + reason=maxturns → POST /update-task {maxTurns:+5}
}
```

## 状态 / 交互（v0.0.221）
- **topbar**：任务名 + 「多轮 · 训练优化」violet tag + 状态 tag + 生命周期按钮组：
  - `running`（带 maxTurns）→ tag「进行中 · 第 N/M 轮」gold
  - `paused` + reason → tag 显 reason 文案（如「已到上限 · 调大后可续」/「已完成 · 可续训」）
  - `pending` → tag「待开始」muted
- **按钮可见条件**（布局稳定：按钮组区域恒定占位，按状态显隐具体按钮）：
  - running/pending + onPause 传 → 显「⏸ 暂停」
  - paused + reason≠maxturns + onResume 传 → 显「▶ 续训」
  - paused + reason=maxturns + onIncreaseMaxTurns 传 → 显「⬆ 调大至 {当前+5} 轮」
- **可见文案**（E2E / data-testid）：任务名 / 模式 tag / 状态文案（含 pausedReason 细分）/ 「⏸ 暂停」/「▶ 续训」/「⬆ 调大至 N 轮」。
- **testid**：`academy.task.pause` / `academy.task.resume` / `academy.task.increaseMaxTurns`（data-action-key）。

## 复用关系
- 唯一活跃消费者 = `section-training-observe`。
- 状态 tag 复用 `primitive-status-badge`（running/paused/pending variant）。
- v0.0.221 删 card 变体（v0.0.220 后无消费者）+ 删 stop 按钮。

## 视觉基线
- 设计稿来源：`demo/04-training-observe.html` `.obs-topbar`。
- 字体：topbar 任务名 13.5px/600；模式 tag 11px/500；按钮 sm h-26 p-0/9。
- 配色：tag-gold 进行中；tag-muted paused/pending；tag-violet 模式；按钮 `BTN_SECONDARY`。

## 消费方

- `app/web/src/components/academy-page/section-training-observe.tsx`
