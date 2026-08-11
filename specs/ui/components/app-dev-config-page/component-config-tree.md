# component-config-tree（配置同步 checkbox 勾选树）

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-config-tree.tsx
> 相关: lib/config-sync-export.ts（SelectionState / TOOL_TAB_IDS / TOOL_TAB_LABEL_KEYS）

## 职责

配置同步 tab 的**固定结构两层 checkbox 勾选树**（非递归文件树，是 config 专用树）：根 folder（模型配置 / 工具配置）→ 叶子节点（provider label / 工具 tab 名）。支持 export/import 双模式；folder 联动子节点全选/取消 + indeterminate 半选态；import 模式 provider 叶子可显示「存在重名」标签（不置灰、不阻止勾选）。

**边界**：不做数据拉取（providers/tools 由父级传入）；不做导入导出执行（只上抛选择变化）；不复用 `component-file-tree`（其是选择语义，非 checkbox 勾选 + indeterminate，不可复用）。

## Props

```ts
interface ConfigTreeProps {
  mode: 'export' | 'import';
  /** provider 叶子数据（导出=全量，导入=文件解析的） */
  providers: { label: string; protocolId?: string }[];
  /** 工具 tab id 列表 */
  tools: string[];
  /** 仅 import 模式：重名 label 集合 */
  duplicateLabels?: Set<string>;
  /** 当前选择状态 */
  selected: SelectionState;
  /** 选择变化回调 */
  onSelectionChange: (next: SelectionState) => void;
}

// SelectionState（lib/config-sync-export.ts 导出）
interface SelectionState {
  providers: Set<string>; // 选中的 provider label（key=label，非 id）
  tools: Set<string>;     // 选中的工具 tab id
}
```

## 状态 / 交互

- **两棵树**：模型配置树（provider 叶子）+ 工具配置树（工具 tab 叶子，恒 4 个：web_search/web_fetch/see_image/bash）
- **checkbox 三态**：
  - folder 全选 = 所有子节点选中 → checked
  - folder 半选 = 部分子节点选中 → **indeterminate**（`ref` 设 `el.indeterminate`）
  - leaf 独立切换自身
- **folder 联动**：点击 folder checkbox → 联动所有子节点全选/取消（`onToggle(childIds, checked)`）
- **leaf 独立**：点击 leaf → 仅切换自身
- **provider 选择 key = label（非 id）**：导出时 id 被剥离、导入时 id 未生成，故用 label 作 key（D5 约束）
- **import 模式重名标签**：`duplicateLabels?.has(label)` → 叶子后显示「存在重名」badge（`config-tree-dup-{label}`，amber 底）——**不置灰、不阻止勾选**（老板拍板）
- **空态**：providers 空 → 「无可导出的模型配置」（`config_sync.tree.empty_providers`）

### 可见文案（E2E 定位契约）

| 文案 | 位置 | testid |
|------|------|--------|
| 模型配置 | 模型树 folder | config-tree-folder-模型配置 |
| 工具配置 | 工具树 folder | config-tree-folder-工具配置 |
| {provider.label} | 模型树叶子 | config-tree-leaf-{label} |
| 网络搜索 / 网络抓取 / 看图理解 / 命令行 | 工具树叶子（i18n `tab.tools.*`） | config-tree-leaf-{tabId} |
| 存在重名 | import 重名叶子后 badge | config-tree-dup-{label} |
| 无可导出的模型配置 | 模型树空态 | — |

## 复用关系

- 被组合：`section-config-sync-export.tsx`（mode='export'，默认全选）+ `section-config-sync-import.tsx`（mode='import'，默认全选 + duplicateLabels）
- 组合：无子组件（内部 FolderNode / LeafNode 私有实现）
- 数据：`lib/config-sync-export`（`SelectionState` / `TOOL_TAB_IDS` / `TOOL_TAB_LABEL_KEYS`）

## 视觉基线

- 无设计稿 → 对齐 app-dev-config 页既有风格
- folder：`flex items-center gap-2 py-1.5 cursor-pointer text-[14px] font-semibold text-fg`；checkbox `h-4 w-4 accent-accent`
- leaf：`flex items-center gap-2 py-1` + label `text-[13px] text-fg-2`
- 子节点缩进：`ml-6 mt-0.5`
- 重名 badge：`text-[11px] px-1.5 py-0.5 rounded bg-warning/15 text-warning`
- 字体 weight 仅 400/600（收敛，禁 serif/mono）
