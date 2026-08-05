# component-version-tree（版本树：正式版 + 过程版平铺）

> 层级: component
> 文件: app/web/src/components/academy-page/component-version-tree.tsx

## 职责
学生详情左栏的版本树：正式版（0.0/1.0/2.0…）+ 过程版（v1.1/v1.2/v1.2.3…）平铺展开；当前正式版高亮；训练中的过程版标 gold tag。

边界：不管版本内容（四元组在右 right-col）；不管版本编辑入口（编辑按钮在 ver-hero）。

> **[v0.0.219] 三项规则**（`buildVersionNodes` 实现）：① 过程版按 label major 段匹配父 formal（不沿用 `parentFormalVersionId`）；② 过程版节点 name 用 3 段 versionLabel；③ formal 副标题显「采纳自 v{label}」。

## Props
```ts
interface VersionNode {
  id: string;
  label: string; // '0.0' / '1.0' / '1.1' / '1.2.3'
  kind: 'formal' | 'process';
  name: string; // '初始版本' / '第 1 正式版' / process 用 3 段 versionLabel（'v1.2.3'）
  subtitle?: string; // formal: '采纳自 v1.2.3' / '全空 · 正式版'；process: '简单 · 已完成' / '多轮 · 第 2/5 轮'
  isCurrent?: boolean; // 当前正式版
  status?: 'training' | 'done' | 'idle'; // 过程版状态
  parentVersionId?: string; // 过程版挂到哪个正式版下（按 label major 匹配得）
}

interface Props {
  versions: VersionNode[];
  selectedId?: string;
  onSelect: (versionId: string) => void;
  /**
   * v0.0.221 UC-221-C：过程版「采纳」入口（旁路归档）。
   * 传入时过程版行尾部显「采纳」按钮 → POST /adopt；formal 行不显。
   * 点击 adopt 不触发 select（stopPropagation）；task 状态不变（仍在产）。
   */
  onAdopt?: (versionId: string) => void;
}
```

## 状态 / 交互
- 顶部 `v-list-label`「版本树」11px/600/uppercase。
- **正式版行**（`ver-row` p-9/11 `rounded-lg`）：44×26 `ver-badge` `vb-formal` 黑底白字 mono 12px/600 + 名 12.5px/500 + 副 10.5px muted + 右 tag（`tag-sage` 当前「当前」）。
- **过程版分组**（`ver-tree-proc` margin-left:22px + 左 2px border 竖线）：每个过程版同 `ver-row` 结构，但 badge `vb-proc` violet 底；`status='training'` 时名后加 gold「训练中」tag，`done` 不加 tag（完成信息在副文案「… · 已完成」）。
- **[v0.0.221] 过程版行尾「采纳」按钮**：`onAdopt` 传入时，过程版行尾部显「采纳」11px text-accent 按钮；formal 行不显；点击 stopPropagation 不触发 select → caller 调 `POST /academy/training-task/:tid/adopt {versionId}`（taskId 取该过程版 `createdFromTaskId`）。testid `academy.version.adopt`。
- 行 hover `bg-accent-light`；selected 加 `sel` class（border-2 + border-border-2 + bg-accent-light）。
- **可见文案**（E2E）：「版本树」/ 版本号（label，**不显目录名**——过程版 4+ 段路径是实现细节）/ 版本名（formal「初始版本」「第 N 正式版」；process `v{versionLabel}` 如 `v1.2.3`）/ 副（formal「采纳自 v{label}」「全空 · 正式版」；process「{模式} · {进度|状态}」如「简单 · 已完成 · 可续训」「多轮 · 第 N/M 轮」）/ 「当前」「训练中」/「采纳」按钮。
- **过程版副文案模式段由数据派生**（不可写死）：模式取任务实体 `mode`，状态段 running/pending 取「第 N/M 轮」（仅 multi 且 maxTurns 已知）否则「训练中」；**paused 时显 pausedReason 细分文案**（`task.pausedReason.{maxturns/completed/stopped/earlystop}`）；无任务实体时只显「已完成」。派生实现 = `academy-page/version-tree-nodes.ts::buildVersionNodes()`。

### [v0.0.219] buildVersionNodes 归属 + 副标题规则

- **过程版父归属按 label major 段匹配**：`process.versionLabel.split('.')[0] === formal.versionLabel.split('.')[0]` 找父 formal.id；**不依赖 `parentFormalVersionId`**——multi-turn round2+ 的 base 是 process（临时基线更新为 round1 候选），该字段跟着指向 process 而非 formal，沿用会致 round2+ 过程版落 `orphanProc` 列表尾脱离 base formal（如 `0.1.2` 出现在 `1.0` 之后）。formal major 唯一（0/1/2…）保证匹配无歧义；匹配不到时 orphan 分支兜底（沿用 `p.parentFormalVersionId`）。
- **过程版节点 name 用 3 段 versionLabel**：`t('versionTree.procName', { label: p.versionLabel })` → 「v1.2.3」（label 已含 major.taskSeq.round，schema 字段，见 `[P0]data_model.md §6`）；不再用「任务 #N」（旧 `versionTree.taskN`）。
- **formal 副标题「采纳自」规则**：`f.adoptedFromProcessVersionId` 有值且在 versions 中查到对应 process → 显 `t('versionTree.adoptedFromLabel', { label: adoptedFrom.versionLabel })` → 「采纳自 v1.2.3」；**初始 0.0 / 旧 record 无此字段 / 查不到 label** → 降级（0.0 显 `emptyFormal`，旧 record 按 `createdFromTaskId` 的 taskSeq 显旧 `adoptedFrom {n:seq}`，查不到留 undefined）。

## 复用关系
- 被 `section-student-detail` 左 left-col 组合。
- 平铺规范对齐 v0.0.203 已落地的「基于 vX」文案（过程版副文案包含 parent 版本号），不再走旧嵌套树。

## 视觉基线
- 设计稿来源：`demo/03-student-detail.html` `.ver-row / .ver-tree-proc`。
- 尺寸：left-col 300px；行 p-9/11 + gap-10；badge 44×26；过程版缩进 ml-22。
- 字体：badge mono 12px/600；ver-name 12.5px/500；ver-sub 10.5px muted。
- 边框：行 hover 无边框（仅底色）；sel 态 border-1 + border-border-2；过程版分组左 2px border。
- 配色：vb-formal `--color-accent` 黑底白字；vb-proc `--color-violet-bg` + `--color-violet` 字；tag-sage 当前；tag-gold 训练中；tag-muted 已完成。
