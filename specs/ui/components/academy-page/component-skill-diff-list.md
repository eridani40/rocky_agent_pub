# component-skill-diff-list（skills 段两级 diff：skill 目录 × 目录内文件）

> 层级: component
> 文件: app/web/src/components/academy-page/component-skill-diff-list.tsx（派生纯函数 `academy-page/skill-diff.ts`）

## 职责
训练结果采纳页 skills 段的两级 diff 渲染：外层每个 skill **目录**一张可折叠卡（整体新增 / 已移除 / 文件修改 / 不变），内层是目录内**文件行**（新增文件 / 删除文件 / 修改 / 二进制变更 / 不变），文本文件可展开行级 diff。

边界：**纯展示**——四态判定、内容取用清单、内容回填全在 `skill-diff.ts` + `section-training-result`（本组件无 fetch、无判定）；行级 diff 算法与对比样式复用 `line-diff.ts` + `component-diff-viewer` 的 `CmpCols`/`ColTag`/`DiffLines`（不自写一份）。

## Props
```ts
interface Props {
  /** 两级 diff（skill 名码位序，文件 path 码位序；来自 skill-diff.ts buildSkillDirDiffs） */
  dirs: SkillDirDiff[];
  baseLabel: string; // 'base · v1.0'
  candLabel: string; // '候选 · v2.0'
}
```
`SkillDirDiff` / `SkillFileDiff` 定义见 `component-diff-viewer.md` §Props（两级契约单一来源）。

配套纯函数（`skill-diff.ts`，全部无 IO）：
- `buildSkillDirDiffs(baseSkills, candSkills)` → `SkillDirDiff[]`：目录四态（仅候选有 = added / 仅 base 有 = **removed** / 两侧都有且任一文件变更 = modified / 否则 unchanged），文件四态同法。**modified 只看后端 per-file `hash`**（sha1 前 12，`18-academy §1.8`）——不看 `size`（同长度改动会漏判）。`hash` 缺失（后端读失败）→ 标 `binary` 且保守判 modified。
- `collectDiffFileRefs(dirs, limit = 20)` → `{ refs, truncated }`：摘出「有变更且非 binary」的文件引用（`needBase`/`needCand` 指示要取哪侧），超上限即 `truncated`。
- `applySkillFileContents(dirs, loaded)`：回填两侧内容；后端标 binary 的文件**清空两侧内容**（保证永不进 `computeLineDiff`）。

## 状态 / 交互
- **目录卡**（demo `.skill-file` 视觉，border `rounded-md` m-0/15/12）：head 可点折叠 —— 「🧩 {skill 名}」+ 目录 badge + 右 caret（▼/▶）。默认展开规则：`changeKind !== 'unchanged'` 展开，`unchanged` 折叠（不变的 skill 不占视线，改动的一眼可见）。
- **文件行**（目录卡内，border `rounded-sm` mx-3 mb-1.5）：mono path + 文件 badge（+ binary 行追加「900 B → 2.0 KB」字节变化）+ caret。
  | 条件 | 行为 |
  |---|---|
  | `changeKind='modified'` 且非 binary 且至少一侧有内容 | 可展开，**默认展开**行级 diff（`CmpCols` + `computeLineDiff`） |
  | `added` / `removed` 且有对应侧内容 | 可展开（默认折叠），展开显单侧全 add / 全 del |
  | `binary=true` | **不可展开**、不进 `computeLineDiff`，只显「二进制变更」+ 字节变化 |
  | `unchanged` | 不可展开（无 diff 可看） |
  | 有变更但两侧内容都没取到（取内容失败 / 超上限未取） | 不可展开，降级为只显 badge（不整行报错） |
- **caret 恒占位**：不可展开的行 caret 用 `opacity-0` 保留位置——按钮出现/消失不得挤动同行元素（布局稳定性硬规则）。
- `dirs` 为空 → 显 `skillBrowser.emptyTree`「该版本还没有 skill」。
- 「文件较多，未加载全部行级 diff」（`diff.filesTruncated`）由 `build-diff-items.ts` 拼进 skills 卡 head 的 summary，不在本组件内渲染。
- **可见文案**（E2E 定位契约，i18n ns=`academy`）：
  | 位置 | key | zh-CN |
  |---|---|---|
  | 目录 badge | `diff.newSkill` | 整体新增 |
  | 目录 badge | `diff.removedSkill` | 已移除 |
  | 目录 badge | `diff.modSkill` | 文件修改 |
  | 目录 badge | `diff.unchanged` | 未变 |
  | 文件 badge | `diff.fileAdded` | 新增文件 |
  | 文件 badge | `diff.fileRemoved` | 删除文件 |
  | 文件 badge | `diff.fileModified` | 修改 |
  | 文件 badge | `diff.fileBinary` | 二进制变更 |
  | 文件 badge | `diff.fileUnchanged` | 不变 |
  | 空态 | `skillBrowser.emptyTree` | 该版本还没有 skill |

  另有 skill 目录名（前缀 🧩）、文件 path、`base · vX`/`候选 · vX`（来自 Props label）与字节变化文本（`B`/`KB` 通用单位不入 i18n）。

## 复用关系
- 被 `component-diff-viewer` 的 skills 分支渲染（两模块互相引用：diff-viewer 渲染本组件、本组件复用其对比原语；引用只在渲染期解析，ESM 循环安全）。
- 数据由 `section-training-result` 编排：`buildSkillDirDiffs` → `collectDiffFileRefs` → 并发 `getVersionSkillFile`（`18-academy §1.11.1`）→ `applySkillFileContents`。
- 与 `component-skill-browser-modal` 无耦合（那是单版本浏览/编辑，本组件是双版本对比）。

## 视觉基线
- 设计稿来源：`demo/06-training-result.html` `.skill-file`（外层目录卡沿用其视觉）+ `specs/ui/overall/12-academy.md §11`。
- 尺寸：目录卡 `rounded-md` mx-15 mb-12 + head p-8/12；文件行 `rounded-sm` mx-12 mb-6 + p-6/10；badge p-1/6 `rounded-sm`。
- 字体：目录 head 12px；文件 path mono 11.5px；badge 10.5px/600；字节变化 mono 10.5px muted-2；行级 diff mono 12px/1.7。
- 边框：目录卡 1px border + 展开时 head bottom border；文件行 1px border；`CmpCols` 两列之间 1px border。
- 配色：整体新增 sage-bg/sage；已移除 danger-light/danger；文件修改 + 修改 + 二进制变更 gold-bg/`#b45309`；新增文件 sage；删除文件 danger；不变 muted；目录 head 底 `bg-warm`，展开体底 `bg`，hover `accent-light`。

## 消费方

- `app/web/src/components/academy-page/component-diff-viewer.tsx`
