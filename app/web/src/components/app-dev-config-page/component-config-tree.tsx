/**
 * component-config-tree — 配置同步 checkbox 勾选树（export/import 双模式）。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D5
 *      specs/prd/v0.0.318-config-sync.md §2.4
 *
 * 两棵固定结构两层树（非递归文件树）：
 *   根 folder（模型配置 / 工具配置）→ 叶子节点（provider label / 工具 tab 名）
 * Checkbox 交互：folder 联动子节点全选/取消；叶子独立；folder indeterminate 半选态。
 * Provider 选择 key 用 label（非 id）——导出时 id 被剥离，导入时 id 还未生成。
 */

import { type ReactNode, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { SelectionState } from '../../lib/config-sync-export';
import { TOOL_TAB_IDS, TOOL_TAB_LABEL_KEYS } from '../../lib/config-sync-export';

export type { SelectionState } from '../../lib/config-sync-export';

export interface ConfigTreeProps {
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

// ——内部辅助：三态计算——

/** folder 是否全选（所有子节点选中） */
function isAllChecked(childIds: string[], selectedSet: Set<string>): boolean {
  return childIds.length > 0 && childIds.every((id) => selectedSet.has(id));
}

/** folder 是否半选（部分子节点选中） */
function isIndeterminate(childIds: string[], selectedSet: Set<string>): boolean {
  return childIds.some((id) => selectedSet.has(id)) && !isAllChecked(childIds, selectedSet);
}

// ——Folder 节点——

interface FolderNodeProps {
  label: string;
  childIds: string[];
  selectedSet: Set<string>;
  onToggle: (childIds: string[], checked: boolean) => void;
  children: ReactNode;
}

function FolderNode({ label, childIds, selectedSet, onToggle, children }: FolderNodeProps) {
  const allChecked = isAllChecked(childIds, selectedSet);
  const indeterminate = isIndeterminate(childIds, selectedSet);

  return (
    <div className="select-none">
      <label className="flex items-center gap-2 py-1.5 cursor-pointer text-[14px] font-semibold text-fg">
        <input
          type="checkbox"
          checked={allChecked}
          ref={(el) => { if (el) el.indeterminate = indeterminate; }}
          onChange={(e) => onToggle(childIds, e.target.checked)}
          data-testid={`config-tree-folder-${label}`}
          className="h-4 w-4 accent-accent"
        />
        {label}
      </label>
      <div className="ml-6 mt-0.5">
        {children}
      </div>
    </div>
  );
}

// ——Leaf 节点——

interface LeafNodeProps {
  id: string;
  label: string;
  checked: boolean;
  onToggle: (id: string, checked: boolean) => void;
  extra?: ReactNode;
}

function LeafNode({ id, label, checked, onToggle, extra }: LeafNodeProps) {
  return (
    <div className="flex items-center gap-2 py-1">
      <label className="flex items-center gap-2 cursor-pointer text-[13px] text-fg-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onToggle(id, e.target.checked)}
          data-testid={`config-tree-leaf-${id}`}
          className="h-4 w-4 accent-accent"
        />
        {label}
      </label>
      {extra}
    </div>
  );
}

// ——主组件——

/**
 * ConfigTree — 配置同步 checkbox 勾选树。
 * 两棵树：模型配置（provider 叶子）+ 工具配置（工具 tab 叶子）。
 */
export function ConfigTree({
  mode,
  providers,
  tools,
  duplicateLabels,
  selected,
  onSelectionChange,
}: ConfigTreeProps): ReactNode {
  const { t } = useTranslation('app-dev-config');

  // — provider 叶子 toggle —
  const toggleProvider = useCallback((id: string, checked: boolean) => {
    const next = new Set(selected.providers);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectionChange({ ...selected, providers: next });
  }, [selected, onSelectionChange]);

  // — provider folder toggle（联动所有子节点）—
  const toggleProviderFolder = useCallback((childIds: string[], checked: boolean) => {
    const next = new Set(selected.providers);
    if (checked) childIds.forEach((id) => next.add(id));
    else childIds.forEach((id) => next.delete(id));
    onSelectionChange({ ...selected, providers: next });
  }, [selected, onSelectionChange]);

  // — tool 叶子 toggle —
  const toggleTool = useCallback((id: string, checked: boolean) => {
    const next = new Set(selected.tools);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectionChange({ ...selected, tools: next });
  }, [selected, onSelectionChange]);

  // — tool folder toggle —
  const toggleToolFolder = useCallback((childIds: string[], checked: boolean) => {
    const next = new Set(selected.tools);
    if (checked) childIds.forEach((id) => next.add(id));
    else childIds.forEach((id) => next.delete(id));
    onSelectionChange({ ...selected, tools: next });
  }, [selected, onSelectionChange]);

  const providerIds = providers.map((p) => p.label);
  const toolIds = tools.length > 0 ? tools : [...TOOL_TAB_IDS];

  // 工具 tab i18n label 查找
  const toolLabel = (tabId: string): string => {
    const key = TOOL_TAB_LABEL_KEYS[tabId];
    return key ? t(key) : tabId;
  };

  return (
    <div className="flex flex-col gap-6" data-testid="config-tree">
      {/* 模型配置树 */}
      <div>
        <FolderNode
          label={t('config_sync.tree.providers')}
          childIds={providerIds}
          selectedSet={selected.providers}
          onToggle={toggleProviderFolder}
        >
          {providers.length === 0 ? (
            <div className="text-[12px] text-muted py-1">{t('config_sync.tree.empty_providers')}</div>
          ) : (
            providers.map((p) => (
              <LeafNode
                key={p.label}
                id={p.label}
                label={p.label}
                checked={selected.providers.has(p.label)}
                onToggle={toggleProvider}
                extra={mode === 'import' && duplicateLabels?.has(p.label) ? (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-warning/15 text-warning" data-testid={`config-tree-dup-${p.label}`}>
                    {t('config_sync.tree.duplicate_label')}
                  </span>
                ) : undefined}
              />
            ))
          )}
        </FolderNode>
      </div>

      {/* 工具配置树 */}
      <div>
        <FolderNode
          label={t('config_sync.tree.tools')}
          childIds={toolIds}
          selectedSet={selected.tools}
          onToggle={toggleToolFolder}
        >
          {toolIds.map((tabId) => (
            <LeafNode
              key={tabId}
              id={tabId}
              label={toolLabel(tabId)}
              checked={selected.tools.has(tabId)}
              onToggle={toggleTool}
            />
          ))}
        </FolderNode>
      </div>
    </div>
  );
}
