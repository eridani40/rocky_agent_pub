# component-training-create-modal（发起训练 modal）

> 层级: component
> 文件: app/web/src/components/academy-page/component-training-create-modal.tsx

## 职责
发起训练的 modal 弹层（design §5）：模式卡（简单/多轮）+ 基线 picker（可 cycle 任一 formal）+ 数据集/评估器 picker（多轮）+ 训练目标 textarea + 迭代策略 stepper + 自主修复 toggle + hint-bar + foot。

边界：不管训练观察（发起后路由到训练观察）；不管教室资产（数据集/评估器在 head 对话或教室详情 tab 管理）。

## Props
```ts
interface Props {
  open: boolean;
  student: { id: string; name: string };
  /** [v0.0.219] baseline picker 可 cycle 的 formal 列表（不止 currentFormal） */
  formalVersions: { id: string; label: string }[];
  /** 默认 baseline（currentFormal 或调用方 hint） */
  defaultBaseVersionId: string;
  datasets: Array<{ id: string; name: string; caseCount: number; hasPerCaseStandard?: boolean }>;
  graders: Array<{ id: string; name: string; type: 'llm-judge' | 'programmatic' }>;
  hasEvaluationCapability: boolean; // false → 多轮卡 dis
  /** 本 base 下下一个 taskSeq（hint 文案用，由 page-academy 传入） */
  nextTaskSeq: number;
  onCancel: () => void;
  /** [v0.0.219] 上抛选中 baseVersionId + config（modal 内 state 持选中 baseline） */
  onSubmit: (baseVersionId: string, config: TrainingConfig) => Promise<void> | void;
}
```

> **[v0.0.219] baseline picker 不再锁 currentFormal**：旧 Props 是 `defaultBaseVersion: { id, label }` 单值（不可选，仅展示固定 base）；现改为 `formalVersions` 列表 + `defaultBaseVersionId` 默认值，modal 内 `useState(defaultBaseVersionId)`，PickerRow 加 onClick cycle 切任一 formal（复用 dataset/grader cycle 模式）。`onSubmit` 上抛选中 `baseVersionId`，由 page-academy 调 `toCreateTaskBody(baseVersionId, config)`。

## 状态 / 交互
- **L3 modal 不变式（硬约束）**：走 `<Portal>` 挂 overlay-root + Portal 根节点显式 `pointer-events-auto` ——见 `_conventions.md §13`（漏第二条则整弹层按钮全不可点；已有防回归 UT 断 className）。
- **modal shell**：640px + max-h 88vh + `rounded-xl` + shadow-lg + column flex。
- **modal-head**（p-16/20 + bottom border）：title「发起训练 · 学生「{name}」」15px/600 + ✕ 关闭。
- **modal-body**（flex-1 overflow-y-auto p-18/20）：
  - **mode-cards**（grid 2 + gap 12 + mb 18）：每卡 radio 圈 + icon + 名「简单模式」/「多轮模式」+ 描述 + 能力 tag（`req-ok`「✓ 随时可用」sage / `req-miss`「需先备评估能力」gold）；多轮卡在 `hasEvaluationCapability=false` 时 `dis`（opacity:.55 + cursor:not-allowed）。
  - **基线版本**（[v0.0.219] 可 cycle）：sec-label「📌 基线版本」+ picker（🌳 logo + 选中 formal 的「v{label}（{默认/自定义名}）」+ 副「基于它发起本次训练」+ ›）。点 picker row 触发 `cycleOption(formalVersions, baseVersionId, setBaseVersionId)` 切下一个 formal（formalVersions.length > 1 才可点；复用 dataset/grader cycle 模式）。modal 内 state `baseVersionId` 默认 `defaultBaseVersionId`。
  - **数据集 + 评估器**（仅多轮模式渲染）：sec-label「📚 数据集 · ⚖️ 评估器」+ opt-row（2 picker 并列，各走 cycleOption）。
  - **训练目标**：sec-label「🎯 本次训练目标 透传给教练和优化 agent」+ textarea 占位「例：这次重点学学《旧猫咪》这本书的叙事感…」。
  - **迭代策略**（grid 3 + gap 11）：最大轮次 stepper（默认 5）+ 早停 stepper（默认 3）+ 接受决策（固定文案「新版分 > 基线分」）。
  - **自主修复 checkline**：「允许教练在训练中自主修复数据格式等小问题（消耗更多 token 换可靠性）」（默认 on）。
  - **hint-bar**（indigo-bg `rounded-md` p-10/13 mt-16 12px/1.55）：「💡 本次将基于 **v{baseMajor}** 创建训练任务 **v{baseMajor}.{nextSeq}**，由一位专属教练全程跟进…」（[v0.0.219] baseMajor 从选中 `baseVersion.label.split('.')[0]` 派生，nextSeq = `nextTaskSeq`）。
- **modal-foot**（p-14/20 + top border gap-9）：「取消」outline + 「发起训练 →」primary（valid = directive 非空 + multi 配置齐全 + `baseVersionId` 非空）。
- **可见文案**（E2E）：「发起训练 · 学生「{name}」」/「简单模式」「多轮模式」+ 描述 / 「✓ 随时可用」「需先备评估能力」/ 「📌 基线版本」/ 「基于它发起本次训练」/ 「📚 数据集」「⚖️ 评估器」/ 「🎯 本次训练目标 透传给教练和优化 agent」/ placeholder / 「最大轮次」「早停（连续无提升）」「接受决策」/ 「新版分 > 基线分」/ 「允许教练在训练中自主修复数据格式等小问题…」/ hint-bar 文案 / 「取消」「发起训练 →」。

## 复用关系
- 被 `page-academy` 顶层挂载（section-classroom-detail / section-student-detail 触发 state）。
- mode-card 视觉与 `member-create` 的 choice-cards 同款（`primitive-key-choice-cards` 思路）；stepper 是通用 primitive，暂随本组件实现（未来提升到 framework/）。

## 视觉基线
- 设计稿来源：`demo/05-training-create.html`。
- 尺寸：modal 640px；head p-16/20；body p-18/20；foot p-14/20；mode-card p-15；picker p-9/12；stepper button 26×28 + input 38 宽。
- 字体：modal-title 15px/600；mode-name 13.5px/600；mode-desc 11.5px/1.5 muted；sec-label 12px/600；field-label 12px/500；hint-bar 12px/1.55。
- 边框：modal `rounded-xl` + shadow-lg；head/foot border；mode-card border-2（sel border-accent + bg）；picker border；stepper border + overflow-hidden；checkbox 16×16 border-1.5。
- 配色：req-ok sage-bg/sage；req-miss gold-bg/#b45309；hint-bar indigo-bg；checkbox on `--color-accent` 黑底；btn-primary 黑底白字。

## 消费方

- `app/web/src/components/academy-page/page-academy.tsx`
