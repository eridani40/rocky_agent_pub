/**
 * @vitest-environment jsdom
 * section-browser-connector 单测：四态渲染 + toggle 派发 + connecting 禁用 + error 重试
 * 参考: specs/ui/components/connector-page/section-browser-connector.md
 *       状态机: specs/tech/config/[P1]connectors.md §3
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SectionBrowserConnector } from '../section-browser-connector';
import type { ConnectorState } from '../../../lib/api-client';
import { initI18n } from '../../../i18n';

// 组件 useTranslation(connector) 需 i18n 实例就绪（zh-CN 文案对齐原字面断言）
beforeAll(async () => {
  await initI18n('zh-CN');
});

const baseState = (over: Partial<ConnectorState>): ConnectorState => ({
  id: 'browser',
  switch: 'off',
  connection: 'disconnected',
  ...over,
});

describe('SectionBrowserConnector', () => {
  afterEach(() => cleanup());

  it('switch=off, disconnected：toggle off + status「未启用」+ guide 副标题 + 四步', () => {
    render(<SectionBrowserConnector state={baseState({ connection: 'disconnected' })} onToggle={vi.fn()} />);
    expect(screen.getByText('浏览器').textContent).toBe('浏览器');
    expect(screen.getByText(/Chrome/).textContent).toContain('Chrome');
    expect(screen.getByRole('switch')).toBeTruthy();
    // v0.0.46：switch=off → 「未启用」（原「未连接」文案退休）
    expect(screen.getByText('未启用').textContent).toBe('未启用');
    // v0.0.46：guide 副标题解释 lazy connect 语义
    expect(screen.getByText(/agent 首次使用 browser/).textContent).toContain('agent 首次使用 browser');
    expect(screen.getByText(/chrome:\/\/inspect/).textContent).toContain('chrome://inspect');
    expect(screen.getByText(/prompt/).textContent).toContain('prompt');
    // disconnected 不显 error
    expect(screen.queryByText(/连接失败，请检查/)).toBeNull();
  });

  // v0.0.46 新增：switch=on & connection=disconnected 是「已启用（未连接）」稳态
  it('switch=on, disconnected：toggle on + status「已启用（未连接）」（v0.0.46 稳态）', () => {
    render(
      <SectionBrowserConnector
        state={baseState({ switch: 'on', connection: 'disconnected' })}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByRole('switch').getAttribute('data-enabled')).toBe('true');
    expect(screen.getByText('已启用（未连接）').textContent).toBe('已启用（未连接）');
    // 不应误进 connecting 局部态（无内联反馈）
    expect(screen.queryByText('连接中')).toBeNull();
    // 也不显 error
    expect(screen.queryByText(/连接失败，请检查/)).toBeNull();
  });

  it('connecting：toggle on（禁用防抖）+ status「连接中…」+ toggle 旁内联反馈', () => {
    render(
      <SectionBrowserConnector
        state={baseState({ switch: 'on', connection: 'connecting' })}
        onToggle={vi.fn()}
      />,
    );
    // v0.0.46：connecting 时 switch=on → toggle 显 on
    expect(screen.getByRole('switch').getAttribute('data-enabled')).toBe('true');
    expect(screen.getByText('连接中…').textContent).toBe('连接中…');
    // v0.0.29 BUG-004：connecting 态在 toggle 旁显示内联反馈（连接中文案）
    const feedback = screen.getByText('连接中');
    expect(feedback.textContent).toContain('连接中');
  });

  it('connecting 以外的态不渲染 toggle 旁内联反馈（反馈态专属）', () => {
    // disconnected(off) / connected / error 均不应出现 toggle-feedback
    const { rerender } = render(
      <SectionBrowserConnector state={baseState({ connection: 'disconnected' })} onToggle={vi.fn()} />,
    );
    expect(screen.queryByText('连接中')).toBeNull();
    rerender(
      <SectionBrowserConnector
        state={baseState({ switch: 'on', connection: 'connected' })}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.queryByText('连接中')).toBeNull();
    rerender(
      <SectionBrowserConnector
        state={baseState({ switch: 'on', connection: 'error' })}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.queryByText('连接中')).toBeNull();
  });

  it('connected：toggle on + status「已连接」', () => {
    render(
      <SectionBrowserConnector
        state={baseState({ switch: 'on', connection: 'connected', lastConnectedAt: 1700000000000 })}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByRole('switch').getAttribute('data-enabled')).toBe('true');
    expect(screen.getByText('已连接').textContent).toBe('已连接');
  });

  it('error：status「连接失败」+ error 显 errorDetail + retry button', () => {
    render(
      <SectionBrowserConnector
        state={baseState({ switch: 'on', connection: 'error', errorDetail: 'chrome 未开 remote debugging' })}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('连接失败').textContent).toBe('连接失败');
    expect(screen.getByText(/chrome 未开 remote debugging/).textContent).toContain('chrome 未开 remote debugging');
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('点 toggle on（disconnected）→ onToggle(true)', () => {
    const onToggle = vi.fn();
    render(<SectionBrowserConnector state={baseState({ connection: 'disconnected' })} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('点 toggle off（connected）→ onToggle(false)', () => {
    const onToggle = vi.fn();
    render(
      <SectionBrowserConnector
        state={baseState({ switch: 'on', connection: 'connected' })}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('connecting 中点 toggle → 不派发（禁用防抖）', () => {
    const onToggle = vi.fn();
    render(
      <SectionBrowserConnector
        state={baseState({ switch: 'on', connection: 'connecting' })}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('error 态点重试 → onToggle(true)', () => {
    const onToggle = vi.fn();
    render(
      <SectionBrowserConnector
        state={baseState({ switch: 'on', connection: 'error', errorDetail: '失败' })}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it('error 无 errorDetail → 兜底文案', () => {
    render(
      <SectionBrowserConnector
        state={baseState({ switch: 'on', connection: 'error' })}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText(/连接失败，请检查/).textContent).toContain('chrome');
  });

  // v0.0.46 防御：switch=off 但 connection=error（stale state）→ 收敛到「未启用」，不显 error 区
  it('switch=off 且 connection=error（stale）→ status 显「未启用」+ error 区不渲染', () => {
    render(
      <SectionBrowserConnector
        state={baseState({ switch: 'off', connection: 'error', errorDetail: 'stale' })}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText('未启用').textContent).toBe('未启用');
    expect(screen.queryByText('stale')).toBeNull();
  });
});
