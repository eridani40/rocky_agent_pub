/**
 * @vitest-environment jsdom
 * v0.0.67 配置只读化单测
 * 参考: reqs/archive v0.0.67.plugin_config_refactor/design.md §2.2（前端只读化）
 *
 * 核心覆盖（v0.0.67）：
 *   - component-plugin-item disabled prop（plugin toggle 不可点 + opacity-60）
 *   - section-plugin-list disabled 透传
 *   - section-ext-point-area 只读集成：
 *     * default scope：所有 EP impl 列表 disabled
 *     * 非 default + 已激活 EP：impl 列表 disabled
 *     * 非 default + 未激活 EP：不渲染 impl 列表，渲染未激活提示
 *     * 不再渲染 activate/deactivate 按钮
 *   - component-scope-switcher 只读：dropdown 切换保留，无 create 入口，无 delete icon
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ComponentPluginItem } from '../component-plugin-item';
import { SectionPluginList } from '../section-plugin-list';
import { ComponentScopeSwitcher } from '../component-scope-switcher';
import { SectionExtPointArea } from '../section-ext-point-area';
import type { PluginGroup, PluginListItem } from '../../../lib/api-client';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：plugin-config 文案查表
beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('ComponentPluginItem disabled prop（v0.0.67 plugin toggle 只读）', () => {
  afterEach(() => cleanup());

  const p: PluginListItem = {
    pluginId: 'plugin_a',
    label: 'A',
    description: 'desc',
    enabled: true,
  };

  it('disabled=true：卡片 opacity-60（视觉只读提示）', () => {
    const { container } = render(<ComponentPluginItem plugin={p} onToggle={() => {}} disabled />);
    // 组件根节点即卡片
    expect((container.firstElementChild as HTMLElement).className).toContain('opacity-60');
  });

  it('disabled=true：toggle 按钮 disabled 属性 = 真，点击不触发 onToggle', () => {
    const onToggle = vi.fn();
    render(<ComponentPluginItem plugin={p} onToggle={onToggle} disabled />);
    const toggle = screen.getByRole('switch', { name: '切换插件 A 启用' });
    expect(toggle.getAttribute('disabled')).not.toBeNull();
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('disabled 缺省：toggle 可点，onToggle(false) 触发（兼容非只读调用方）', () => {
    const onToggle = vi.fn();
    render(<ComponentPluginItem plugin={p} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('switch', { name: '切换插件 A 启用' }));
    expect(onToggle).toHaveBeenCalledWith(false);
  });
});

describe('SectionPluginList disabled 透传（v0.0.67）', () => {
  afterEach(() => cleanup());

  it('disabled=true：所有 plugin-item 的 toggle 均 disabled', () => {
    const plugins: PluginListItem[] = [
      { pluginId: 'plugin_a', label: 'A', description: '', enabled: true },
      { pluginId: 'plugin_b', label: 'B', description: '', enabled: false },
    ];
    render(<SectionPluginList plugins={plugins} onToggle={() => {}} disabled />);
    expect(screen.getByRole('switch', { name: '切换插件 A 启用' }).getAttribute('disabled')).not.toBeNull();
    expect(screen.getByRole('switch', { name: '切换插件 B 启用' }).getAttribute('disabled')).not.toBeNull();
  });
});

describe('ComponentScopeSwitcher 只读（v0.0.67 不可创建/删除 scope）', () => {
  afterEach(() => cleanup());

  const scopes = [
    { id: 'default', name: 'Default', description: '默认基线' },
    { id: 'custom', name: '快速对话' },
  ];

  it('不渲染「+ 新建 scope」按钮（scope 代码声明，不可运行时创建）', () => {
    render(
      <ComponentScopeSwitcher
        scopes={scopes}
        currentScopeId="default"
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).queryByText(/新建/)).toBeNull();
    expect(within(listbox).queryAllByRole('button')).toHaveLength(0);
  });

  it('非 default scope 项不渲染删除 icon（scope 代码声明，不可运行时删除）', () => {
    render(
      <ComponentScopeSwitcher
        scopes={scopes}
        currentScopeId="default"
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    expect(screen.queryByText(/删除/)).toBeNull();
  });

  it('切换 scope 功能保留：点 dropdown 项 → onSelect(scopeId) 触发', () => {
    const onSelect = vi.fn();
    render(
      <ComponentScopeSwitcher
        scopes={scopes}
        currentScopeId="default"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    fireEvent.click(screen.getByRole('option', { name: '快速对话' }));
    expect(onSelect).toHaveBeenCalledWith('custom');
  });
});

/**
 * 构造测试用 inventory（嵌套 groups[].points[].impls[]）。
 */
function makeGroups(opts: { pointActivated?: boolean } = {}): PluginGroup[] {
  const pa = opts.pointActivated ?? true;
  return [
    {
      groupId: 'g1',
      points: [
        {
          pointId: 'llm_provider',
          activated: pa,
          impls: [
            {
              pluginId: 'p1',
              pointId: 'llm_provider',
              implId: 'impl_a',
              type: 'exclusive',
              enabled: true,
              pluginEnabled: true,
            },
          ],
        },
      ],
    },
  ];
}

describe('SectionExtPointArea 只读集成（v0.0.67）', () => {
  afterEach(() => cleanup());

  it('default scope：所有 EP impl 列表 disabled（灰显）', () => {
    render(
      <SectionExtPointArea
        groups={makeGroups()}
        onImplToggle={() => {}}
        onExclusiveSelect={() => {}}
        onReorder={() => {}}
        onSaveImplConfig={() => {}}
        currentScopeId="default"
        activatedPoints={new Set()}
      />,
    );
    // radio 容器带灰显 + 禁交互类
    const radio = screen.getByRole('radio', { hidden: true });
    const container = radio.closest('[class*="pointer-events-none"]') as HTMLElement;
    expect(container).toBeTruthy();
    expect(container.className).toContain('opacity-60');
  });

  it('default scope：不渲染激活/取消激活按钮', () => {
    render(
      <SectionExtPointArea
        groups={makeGroups()}
        onImplToggle={() => {}}
        onExclusiveSelect={() => {}}
        onReorder={() => {}}
        onSaveImplConfig={() => {}}
        currentScopeId="default"
        activatedPoints={new Set()}
      />,
    );
    expect(screen.queryByText('激活此 EP')).toBeNull();
    expect(screen.queryByText('取消激活')).toBeNull();
  });

  it('非 default + 已激活 EP：impl 列表 disabled（灰显，只读展示该 scope 配置）', () => {
    render(
      <SectionExtPointArea
        groups={makeGroups({ pointActivated: true })}
        onImplToggle={() => {}}
        onExclusiveSelect={() => {}}
        onReorder={() => {}}
        onSaveImplConfig={() => {}}
        currentScopeId="custom"
        activatedPoints={new Set(['llm_provider'])}
      />,
    );
    const radio = screen.getByRole('radio', { hidden: true });
    const container = radio.closest('[class*="pointer-events-none"]') as HTMLElement;
    expect(container).toBeTruthy();
    expect(container.className).toContain('opacity-60');
  });

  it('非 default + 未激活 EP：不渲染 impl 列表，渲染未激活提示', () => {
    render(
      <SectionExtPointArea
        groups={makeGroups({ pointActivated: false })}
        onImplToggle={() => {}}
        onExclusiveSelect={() => {}}
        onReorder={() => {}}
        onSaveImplConfig={() => {}}
        currentScopeId="custom"
        activatedPoints={new Set()}
      />,
    );
    expect(screen.queryByRole('radio', { hidden: true })).toBeNull();
    expect(screen.getByText('未激活（继承 default）')).toBeTruthy();
  });

  it('非 default + 未激活 EP：不渲染激活按钮（v0.0.67 删激活入口）', () => {
    render(
      <SectionExtPointArea
        groups={makeGroups({ pointActivated: false })}
        onImplToggle={() => {}}
        onExclusiveSelect={() => {}}
        onReorder={() => {}}
        onSaveImplConfig={() => {}}
        currentScopeId="custom"
        activatedPoints={new Set()}
      />,
    );
    expect(screen.queryByText('激活此 EP')).toBeNull();
  });
});
