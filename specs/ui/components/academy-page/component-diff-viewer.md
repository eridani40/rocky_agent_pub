# component-diff-viewer（采纳 diff：system/memory/skills/模型 逐项对比）

> 层级: component
> 文件: app/web/src/components/academy-page/component-diff-viewer.tsx

## 职责
训练结果采纳页的三段逐项 diff 容器：每个 `diff-item` 一个 itemKind（system/memory/skills/模型），head 折叠/展开，body 是 base vs 候选 的 cmp-cols。

边界：不管采纳动作（按钮在 foot-bar）；不管训练过程（归训练观察）。

## Props
```ts
type ItemKind = 'system' | 'memory' | 'skills' | 'model';

/** 两级 skill diff 外层：一个 skill 目录 */
interface SkillDirDiff {
  skillName: string; // skill 目录名（= .rocky/skills/<name>/）
  changeKind: 'added' | 'removed' | 'modified' | 'unchanged';
  files: SkillFileDiff[];
}

/** 两级 skill diff 内层：目录内单个文件 */
interface SkillFileDiff {
  path: string; // 相对 skill 目录（SKILL.md / references/audit.py）
  changeKind: 'added' | 'removed' | 'modified' | 'unchanged';
  binary?: boolean; // 内容不可行级比对（后端标二进制 / hash 缺失）
  baseContent?: string; // 按需取用；缺省 = 无行级 diff（降级只显 badge）
  candContent?: string;
  baseSize?: number; // binary 行的变化表达（字节）
  candSize?: number;
}

interface DiffItem {
  kind: ItemKind;
  icon: string; // '📝' / '🧠' / '🧩' / '🤖'
  name: string; // 'System Prompt' / 'Memory' / 'Skills' / '模型'
  summary: string; // 'AGENTS.md 内容对比' / 'skill 文件对比 · 整体新增 1 · 已移除 1' / '未变'
  defaultOpen?: boolean;
  // 各 kind 的 body 数据：
  system?: { baseContent: string; candContent: string };
  memory?: { baseEntries: string[]; candEntries: string[] };
  skills?: { skills: SkillDirDiff[] }; // 两级结构（不是文件平铺）
  model?: { baseText: string; candText: string; changed: boolean };
}

interface Props {
  items: DiffItem[];
  baseLabel: string; // cmp-col-tag 文案，如 'base · v1.0'
  candLabel: string; // 如 '候选 · v2.0'
}
```

本文件导出三个对比原语供 `component-skill-diff-list` 复用（**唯一实现，禁止复制**）：`CmpCols`（双列容器）/ `ColTag`（base/cand 标签）/ `DiffLines`（单侧行渲染）。`DiffItem[]` 由纯函数 `build-diff-items.ts buildDiffItems` 组装。

## 状态 / 交互
- 每个 `diff-item` 默认按 `defaultOpen` 决定折叠态（实现：system + skills 默认展开，memory / model 默认折叠）。
- **diff-item-head**（p-12/16 cursor-pointer + hover `bg-warm`）：icon（16px）+ name 13.5px/600 + 右 `diff-sum` 11.5px muted + `diff-caret`「▶」（open 态旋转 90°）。
- **diff-body**（top border）：
  - **system / memory**：`cmp-cols` grid 2 列 + cmp-col p-13/15；左 `cmp-col-tag tag-base`「base · vX」muted；右 `cmp-col-tag tag-cand`「候选 · vX」sage；body 是 code-block mono 12px/1.7；行级 `diff-add` sage-bg / `diff-del` danger-light + line-through muted。
  - **skills**：渲染委托 `component-skill-diff-list`（两级：skill 目录卡 × 目录内文件行）。本组件不做 skill 判定、不取文件内容。
  - **model**：cmp-cols 两列各显示 model；changed=false 时右列追加「· 未变」。
- **可见文案**（E2E）：item 名 / summary / 「base · vX」「候选 · vX」/ 「未变」；skills 段文案（skill 名 / 目录 badge「整体新增」「已移除」「文件修改」「不变」/ 文件 badge「新增文件」「删除文件」「修改」「二进制变更」「不变」）见 `component-skill-diff-list.md`。

## 复用关系
- 被 `section-training-result` 单实例组合（`items` 一次传 4 项）。
- 行级 diff 复用 `academy-page/line-diff.ts computeLineDiff`（LCS 双侧行 diff），不自写算法。
- skills 段渲染下沉 `component-skill-diff-list`（复用本文件 export 的 `CmpCols`/`ColTag`/`DiffLines`）。

## 视觉基线
- 设计稿来源：`demo/06-training-result.html` `.diff-item / .cmp-cols / .skill-file`。
- 尺寸：diff-item `rounded-xl` mb-12；head p-12/16；body cmp-col p-13/15；code-block 12px/1.7（skill 目录卡与文件行尺寸见 `component-skill-diff-list.md`）。
- 字体：diff-name 13.5px/600；diff-sum 11.5px muted；code-block mono 12px/1.7。
- 边框：diff-item 1px border；head bottom border（open 态）；cmp-col 之间 1px border。
- 配色：cmp-col-tag tag-base surface-2/muted；tag-cand sage-bg/sage；diff-add `--color-sage-bg`；diff-del `--color-danger-light` + line-through muted。

## 消费方

- `app/web/src/components/academy-page/build-diff-items.ts`
- `app/web/src/components/academy-page/component-skill-diff-list.tsx`
- `app/web/src/components/academy-page/skill-diff.ts`
