/**
 * @vitest-environment jsdom
 * component-plugin-item + section-plugin-list 单测
 * 参考: specs/ui/components/plugin-config-page/{component-plugin-item,section-plugin-list}.md
 *
 * 核心回归（BUG-001）：每个 plugin 开关独立——切 A 不影响 B。
 * [v0.0.67] 配置只读化：disabled prop 透传 → toggle 不可点；本文件覆盖 disabled 缺省场景（兼容），
 *   disabled=true 的 plugin-item 集成测试在 readonly-mode.test.tsx。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentPluginItem } from '../component-plugin-item';
import { SectionPluginList } from '../section-plugin-list';
import type { PluginListItem } from '../../../lib/api-client';
import { initI18n } from '../../../i18n';

// 组件 useTranslation(plugin-config) 需 i18n 实例就绪
beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('ComponentPluginItem', () => {
  afterEach(() => cleanup());

  const p: PluginListItem = {
    pluginId: 'anthropic_provider_plugin',
    label: 'Anthropic Provider',
    description: 'Anthropic LLM provider',
    enabled: true,
  };

  it('渲染 label + description + 开关', () => {
    render(<ComponentPluginItem plugin={p} onToggle={() => {}} />);
    expect(screen.getByRole('switch')).toBeTruthy();
    expect(screen.getByText('Anthropic Provider')).toBeTruthy();
    expect(screen.getByText('Anthropic LLM provider')).toBeTruthy();
  });

  it('开关 value=true 时 data-enabled=true', () => {
    render(<ComponentPluginItem plugin={p} onToggle={() => {}} />);
    expect(screen.getByRole('switch').getAttribute('data-enabled')).toBe('true');
  });

  it('点击 toggle → onToggle(!value) 从 true 翻为 false', () => {
    const onToggle = vi.fn();
    render(<ComponentPluginItem plugin={p} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('受控：value 变化不自动触发 onToggle（父级驱动）', () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ComponentPluginItem plugin={p} onToggle={onToggle} />);
    rerender(<ComponentPluginItem plugin={{ ...p, enabled: false }} onToggle={onToggle} />);
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByRole('switch').getAttribute('data-enabled')).toBe('false');
  });
});

describe('SectionPluginList — BUG-001 回归（每 plugin 开关独立）', () => {
  afterEach(() => cleanup());

  const plugins: PluginListItem[] = [
    { pluginId: 'plugin_a', label: 'A', description: 'a', enabled: true },
    { pluginId: 'plugin_b', label: 'B', description: 'b', enabled: true },
  ];

  it('渲染每 plugin 一行独立开关', () => {
    render(<SectionPluginList plugins={plugins} onToggle={() => {}} />);
    // label 在 logo 首字母 + 名称 span 各出现一次
    expect(screen.getAllByText('A').length).toBeGreaterThan(0);
    expect(screen.getAllByText('B').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('switch')).toHaveLength(2);
  });

  it('BUG-001 回归：切 plugin A 开关只触发 onToggle(plugin_a, false)，不触发 plugin_b', () => {
    const onToggle = vi.fn();
    render(<SectionPluginList plugins={plugins} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('switch', { name: '切换插件 A 启用' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('plugin_a', false);
    expect(onToggle).not.toHaveBeenCalledWith('plugin_b', expect.anything());
  });

  it('BUG-001 回归：受控状态下，切 A 的 toggle → 父级仅改 A.enabled，B.enabled 不变（无联动）', () => {
    let state: PluginListItem[] = plugins;
    const setState = (updater: (prev: PluginListItem[]) => PluginListItem[]) => {
      state = updater(state);
      rerender(<SectionPluginList plugins={state} onToggle={handleToggle} />);
    };
    function handleToggle(pluginId: string, next: boolean) {
      // 模拟 page-plugin-config 的独立 state slice：只改当前 pluginId
      setState((prev) => prev.map((p) => (p.pluginId === pluginId ? { ...p, enabled: next } : p)));
    }
    const { rerender } = render(<SectionPluginList plugins={state} onToggle={handleToggle} />);
    // 切 A OFF
    fireEvent.click(screen.getByRole('switch', { name: '切换插件 A 启用' }));
    // A 变 OFF，B 保持 ON（无联动）
    expect(screen.getByRole('switch', { name: '切换插件 A 启用' }).getAttribute('data-enabled')).toBe('false');
    expect(screen.getByRole('switch', { name: '切换插件 B 启用' }).getAttribute('data-enabled')).toBe('true');
  });

  it('空列表渲染占位文案', () => {
    render(<SectionPluginList plugins={[]} onToggle={() => {}} />);
    expect(screen.getByText('暂无已注册的插件。')).toBeTruthy();
  });
});
