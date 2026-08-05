/**
 * @vitest-environment jsdom
 * component-model-picker-panel 单测（v0.0.165 新增）
 * 参考: specs/ui/components/common/component-model-picker-panel.md
 *
 * 覆盖：
 *   - 渲染 role=listbox 根容器 + items（每项 IconBox + modelLabel，role=option）
 *   - selected 判定（value 命中 → 加 ✓ + data-active=true）
 *   - onPick 上抛完整 item（含 providerId/modelId/modelLabel）
 *   - searchable=true → 顶部搜索框存在 + 本地过滤（modelLabel/providerLabel/modelId 三字段）
 *   - extraTopItems 置顶（在常规 items 之上；有 items 时有分割线）
 *   - emptyMessage 兜底（items+extraTop 全空时）
 *   - showModelIdSubtitle=true → 每项右侧渲染 mono modelId 副标
 *   - 视觉基线：容器 `w-[300px] bg-surface border border-border rounded-lg shadow-lg`
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ModelPickerPanel, type PickerItem } from '../component-model-picker-panel';

const ITEMS: PickerItem[] = [
  { providerId: 'p1', providerLabel: 'OpenAI', modelId: 'gpt-4o', modelLabel: 'GPT-4o' },
  { providerId: 'p1', providerLabel: 'OpenAI', modelId: 'gpt-4o-mini', modelLabel: 'GPT-4o mini' },
  { providerId: 'p2', providerLabel: 'Anthropic', modelId: 'claude-sonnet', modelLabel: 'Claude Sonnet' },
];

describe('ModelPickerPanel — 渲染', () => {
  it('渲染 role=listbox 根容器 + 每项 role=option', () => {
    render(<ModelPickerPanel items={ITEMS} onPick={() => {}} />);
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'GPT-4o' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'GPT-4o mini' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Claude Sonnet' })).toBeTruthy();
    cleanup();
  });

  it('容器视觉基线：w-[300px] + bg-surface + border + rounded-lg + shadow-lg（regulation 02 §7）', () => {
    render(<ModelPickerPanel items={ITEMS} onPick={() => {}} />);
    const panel = screen.getByRole('listbox');
    expect(panel.className).toContain('w-[300px]');
    expect(panel.className).toContain('bg-surface');
    expect(panel.className).toContain('border');
    expect(panel.className).toContain('rounded-lg');
    expect(panel.className).toContain('shadow-lg');
    cleanup();
  });
});

describe('ModelPickerPanel — selected + onPick', () => {
  it('value 命中 → selected item 加 data-active + ✓ svg', () => {
    render(
      <ModelPickerPanel
        items={ITEMS}
        value={{ providerId: 'p1', modelId: 'gpt-4o' }}
        onPick={() => {}}
      />,
    );
    const selectedItem = screen.getByRole('option', { name: 'GPT-4o' });
    expect(selectedItem.getAttribute('data-active')).toBe('true');
    // ✓ SVG（w-[13px] h-[13px]）；查子元素含 svg
    expect(selectedItem.querySelector('svg')).toBeTruthy();
    // 未选中项无 data-active
    const other = screen.getByRole('option', { name: 'Claude Sonnet' });
    expect(other.getAttribute('data-active')).toBeNull();
    cleanup();
  });

  it('点 item → onPick 上抛完整 PickerItem（含 providerId + modelId + modelLabel）', () => {
    const onPick = vi.fn();
    render(<ModelPickerPanel items={ITEMS} onPick={onPick} />);
    fireEvent.click(screen.getByRole('option', { name: 'Claude Sonnet' }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0]![0]).toMatchObject({
      providerId: 'p2',
      modelId: 'claude-sonnet',
      modelLabel: 'Claude Sonnet',
    });
    cleanup();
  });
});

describe('ModelPickerPanel — searchable', () => {
  it('searchable=true → 顶部渲染 search input（placeholder 透传）', () => {
    render(
      <ModelPickerPanel items={ITEMS} onPick={() => {}} searchable searchPlaceholder="搜..." />,
    );
    const search = screen.getByPlaceholderText('搜...') as HTMLInputElement;
    expect(search.tagName).toBe('INPUT');
    cleanup();
  });

  it('搜索按 modelLabel 大小写不敏感过滤', () => {
    render(<ModelPickerPanel items={ITEMS} onPick={() => {}} searchable searchPlaceholder="搜" />);
    fireEvent.change(screen.getByPlaceholderText('搜'), { target: { value: 'claude' } });
    // 只剩 claude-sonnet
    expect(screen.queryByRole('option', { name: 'Claude Sonnet' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'GPT-4o' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'GPT-4o mini' })).toBeNull();
    cleanup();
  });

  it('搜索按 providerLabel 过滤（大小写不敏感）', () => {
    render(<ModelPickerPanel items={ITEMS} onPick={() => {}} searchable searchPlaceholder="搜" />);
    fireEvent.change(screen.getByPlaceholderText('搜'), { target: { value: 'OPENAI' } });
    expect(screen.queryByRole('option', { name: 'GPT-4o' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'GPT-4o mini' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Claude Sonnet' })).toBeNull();
    cleanup();
  });

  it('搜索无命中 + 传 emptyMessage → 渲染兜底文案', () => {
    render(
      <ModelPickerPanel
        items={ITEMS}
        onPick={() => {}}
        searchable
        searchPlaceholder="搜"
        emptyMessage="无匹配"
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('搜'), { target: { value: 'nomatch' } });
    expect(screen.getByText('无匹配')).toBeTruthy();
    cleanup();
  });
});

describe('ModelPickerPanel — extraTopItems + headerTitle', () => {
  it('extraTopItems 置顶（DOM 顺序在常规 items 之前）', () => {
    render(
      <ModelPickerPanel
        items={ITEMS}
        onPick={() => {}}
        extraTopItems={[
          { key: 'default', label: 'GPT-4o（默认）', selected: true, onClick: () => {} },
        ]}
      />,
    );
    const extra = screen.getByRole('button', { name: 'GPT-4o（默认）' });
    const first = screen.getByRole('option', { name: 'GPT-4o' });
    // extra 在 first 之前
    expect(extra.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();
  });

  it('extraTopItems + 常规 items 之间有分割线（border-t）', () => {
    const { container } = render(
      <ModelPickerPanel
        items={ITEMS}
        onPick={() => {}}
        extraTopItems={[{ key: 'x', label: 'X', onClick: () => {} }]}
      />,
    );
    // 有 border-t 分割
    expect(container.querySelector('.border-t')).toBeTruthy();
    cleanup();
  });

  it('点 extra item → 上抛 extra.onClick', () => {
    const onExtra = vi.fn();
    render(
      <ModelPickerPanel
        items={ITEMS}
        onPick={() => {}}
        extraTopItems={[{ key: 'inherit', label: 'Inherit', onClick: onExtra }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inherit' }));
    expect(onExtra).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('headerTitle 渲染 muted 题目行（role=heading）', () => {
    render(
      <ModelPickerPanel
        items={ITEMS}
        onPick={() => {}}
        headerTitle="模型选择"
      />,
    );
    const title = screen.getByRole('heading', { name: '模型选择' });
    expect(title.textContent).toBe('模型选择');
    expect(title.className).toContain('text-muted');
    expect(title.className).toContain('border-b');
    cleanup();
  });
});

describe('ModelPickerPanel — empty + subtitle', () => {
  it('items+extraTop 全空 + emptyMessage → 渲染兜底文案', () => {
    render(
      <ModelPickerPanel
        items={[]}
        onPick={() => {}}
        emptyMessage="去插件设置页配置"
      />,
    );
    expect(screen.getByText('去插件设置页配置')).toBeTruthy();
    cleanup();
  });

  it('showModelIdSubtitle=true → 每项右侧渲染 mono modelId 副标', () => {
    render(
      <ModelPickerPanel
        items={ITEMS}
        onPick={() => {}}
        showModelIdSubtitle
      />,
    );
    // GPT-4o item textContent 应含 modelId 'gpt-4o' 作副标（accessible name = label + subtitle）
    const item = screen.getByRole('option', { name: 'GPT-4o gpt-4o' });
    expect(item.textContent).toContain('gpt-4o');
    cleanup();
  });

  it('showModelIdSubtitle=false（缺省）→ 无 modelId 副标（仅 modelLabel）', () => {
    // 用 modelLabel !== modelId 的项确保能看出差异
    const items: PickerItem[] = [
      { providerId: 'p1', modelId: 'gpt-4o', modelLabel: 'GPT-4o' },
    ];
    render(<ModelPickerPanel items={items} onPick={() => {}} />);
    const item = screen.getByRole('option', { name: 'GPT-4o' });
    // modelLabel 'GPT-4o' 存在；modelId 'gpt-4o' 不作副标出现
    expect(item.textContent).toContain('GPT-4o');
    // textContent 不含小写 modelId（无副标）
    expect(item.textContent).not.toContain('gpt-4o');
    cleanup();
  });
});
