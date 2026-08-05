/**
 * @vitest-environment jsdom
 * component-obs-item 单测：点击整卡进详情 / toggle stopPropagation / delete stopPropagation
 * 参考: specs/ui/components/app-dev-config-page/observability-config/component-obs-item.md
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentObsItem } from '../component-obs-item';
import type { ObservabilityConfig } from '../types';
import { initI18n } from '../../../../i18n';

// 启动 i18next instance：obs-item 内部用 useTranslation 查 app-dev-config.observability.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('ComponentObsItem', () => {
  afterEach(() => cleanup());

  const cfg: ObservabilityConfig = {
    id: 'obs_1',
    name: 'Production Tracing',
    type: 'langfuse',
    baseUrl: 'https://cloud.langfuse.com',
    publicKey: 'pk-lf-xxx',
    secretKey: 'sk-lf-yyy',
    enabled: true,
    desc: 'main',
    logPhysical: false,
  };

  it('渲染名称 + badge + toggle + 删除按钮', () => {
    render(
      <ComponentObsItem config={cfg} onSelect={() => {}} onToggle={() => {}} onDeleteRequest={() => {}} />,
    );
    expect(screen.getByText('Production Tracing').textContent).toBe('Production Tracing');
    expect(screen.getByText('已启用').textContent).toBe('已启用');
    expect(screen.getByRole('switch')).toBeTruthy();
    expect(screen.getByRole('button', { name: '删除 Production Tracing' })).toBeTruthy();
  });

  it('点击整卡 → onSelect(id)', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ComponentObsItem config={cfg} onSelect={onSelect} onToggle={() => {}} onDeleteRequest={() => {}} />,
    );
    // 组件根节点即整卡（cursor-pointer）
    fireEvent.click(container.firstElementChild!);
    expect(onSelect).toHaveBeenCalledWith('obs_1');
  });

  it('点击 toggle 不触发 onSelect（stopPropagation），并触发 onToggle 翻转', () => {
    const onSelect = vi.fn();
    const onToggle = vi.fn();
    render(
      <ComponentObsItem config={cfg} onSelect={onSelect} onToggle={onToggle} onDeleteRequest={() => {}} />,
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(onSelect).not.toHaveBeenCalled();
    // enabled=true → 翻转为 false
    expect(onToggle).toHaveBeenCalledWith('obs_1', false);
  });

  it('点击删除按钮不触发 onSelect，并触发 onDeleteRequest', () => {
    const onSelect = vi.fn();
    const onDeleteRequest = vi.fn();
    render(
      <ComponentObsItem config={cfg} onSelect={onSelect} onToggle={() => {}} onDeleteRequest={onDeleteRequest} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '删除 Production Tracing' }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDeleteRequest).toHaveBeenCalledWith(cfg);
  });

  it('enabled=false → badge 显示「已禁用」，状态点 muted 类', () => {
    const { container } = render(
      <ComponentObsItem
        config={{ ...cfg, enabled: false }}
        onSelect={() => {}}
        onToggle={() => {}}
        onDeleteRequest={() => {}}
      />,
    );
    expect(screen.getByText('已禁用').textContent).toBe('已禁用');
    const dot = container.querySelector('.bg-muted');
    expect(dot).toBeTruthy();
  });
});
