/**
 * @vitest-environment jsdom
 * component-config-tree 单测（v0.0.318）。
 * 参考 specs/tech/version_logs/v0.0.318/change_plan.md D5
 *
 * 校验点：
 *   - folder 联动子节点全选/取消
 *   - indeterminate 半选态
 *   - import 模式重名标签渲染
 *   - 默认全选
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { ConfigTree, type SelectionState } from '../component-config-tree';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const testProviders = [
  { label: 'OpenAI', protocolId: 'anthropic_messages' as const },
  { label: 'Claude', protocolId: 'anthropic_messages' as const },
];
const testTools = ['web_search', 'web_fetch', 'see_image', 'bash'];

function renderTree(overrides?: Partial<Parameters<typeof ConfigTree>[0]>) {
  const selected: SelectionState = {
    providers: new Set(['OpenAI', 'Claude']),
    tools: new Set(testTools),
  };
  const onSelectionChange = vi.fn();
  const props: Parameters<typeof ConfigTree>[0] = {
    mode: 'export',
    providers: testProviders,
    tools: testTools,
    selected,
    onSelectionChange,
    ...overrides,
  };
  return { ...render(<ConfigTree {...props} />), onSelectionChange, props };
}

describe('component-config-tree — checkbox 勾选树（v0.0.318）', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('默认全选：所有 folder + leaf 均选中', () => {
    renderTree();
    const providerFolder = screen.getByTestId('config-tree-folder-模型配置') as HTMLInputElement;
    const toolFolder = screen.getByTestId('config-tree-folder-工具配置') as HTMLInputElement;
    expect(providerFolder.checked).toBe(true);
    expect(toolFolder.checked).toBe(true);
    expect((screen.getByTestId('config-tree-leaf-OpenAI') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('config-tree-leaf-web_search') as HTMLInputElement).checked).toBe(true);
  });

  it('点击 folder checkbox → 联动所有子节点取消', () => {
    const { onSelectionChange } = renderTree();
    fireEvent.click(screen.getByTestId('config-tree-folder-模型配置'));
    expect(onSelectionChange).toHaveBeenCalledTimes(1);
    const next = onSelectionChange.mock.calls[0]![0] as SelectionState;
    expect(next.providers.size).toBe(0);
    // 工具不受影响
    expect(next.tools.size).toBe(4);
  });

  it('点击 folder checkbox → 联动所有子节点全选', () => {
    const selected: SelectionState = {
      providers: new Set(),
      tools: new Set(['web_search']),
    };
    const onSelectionChange = vi.fn();
    render(
      <ConfigTree
        mode="export"
        providers={testProviders}
        tools={testTools}
        selected={selected}
        onSelectionChange={onSelectionChange}
      />,
    );
    fireEvent.click(screen.getByTestId('config-tree-folder-模型配置'));
    const next = onSelectionChange.mock.calls[0]![0] as SelectionState;
    expect(next.providers.size).toBe(2);
    expect(next.providers.has('OpenAI')).toBe(true);
    expect(next.providers.has('Claude')).toBe(true);
  });

  it('部分子节点选中 → folder indeterminate 半选态', () => {
    const selected: SelectionState = {
      providers: new Set(['OpenAI']),
      tools: new Set(testTools),
    };
    render(
      <ConfigTree
        mode="export"
        providers={testProviders}
        tools={testTools}
        selected={selected}
        onSelectionChange={vi.fn()}
      />,
    );
    const providerFolder = screen.getByTestId('config-tree-folder-模型配置') as HTMLInputElement;
    expect(providerFolder.checked).toBe(false);
    expect(providerFolder.indeterminate).toBe(true);
  });

  it('点击 leaf checkbox → 独立切换自身选中态', () => {
    const { onSelectionChange } = renderTree();
    fireEvent.click(screen.getByTestId('config-tree-leaf-OpenAI'));
    const next = onSelectionChange.mock.calls[0]![0] as SelectionState;
    expect(next.providers.has('OpenAI')).toBe(false);
    expect(next.providers.has('Claude')).toBe(true);
  });

  it('import 模式：重名 provider 节点显示「存在重名」标签', () => {
    renderTree({
      mode: 'import',
      duplicateLabels: new Set(['OpenAI']),
    });
    expect(screen.getByTestId('config-tree-dup-OpenAI')).toBeTruthy();
    // Claude 无重名标签
    expect(screen.queryByTestId('config-tree-dup-Claude')).toBeNull();
  });

  it('export 模式：不显示重名标签', () => {
    renderTree({ mode: 'export', duplicateLabels: new Set(['OpenAI']) });
    expect(screen.queryByTestId('config-tree-dup-OpenAI')).toBeNull();
  });
});
