/**
 * @vitest-environment jsdom
 * page-connector 单测：渲染骨架（header/tab/section）+ 挂载拉取 + toggle 派发
 * 参考: specs/ui/components/connector-page/page-connector.md
 *
 * mock api-client（listConnectors 返 disconnected 默认态；putConnectorToggle 202）。
 *
 * 注意：bun --bun runtime 下 vitest 的 vi.mock 对相对路径在 jsdom 环境不生效，
 * 必须用绝对路径（与 page-skill.test.tsx 同模式）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { PageConnector } from '../page-connector';
import { initI18n } from '../../../i18n';

// 组件 useTranslation(connector) 需 i18n 实例就绪
beforeAll(async () => {
  await initI18n('zh-CN');
});

// bun --bun 下 vi.mock 需绝对路径（hoisted 计算避免引用未初始化）
const apiPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../../lib/api-client'),
);
const mocks = vi.hoisted(() => ({
  listConnectors: vi.fn(),
  putConnectorToggle: vi.fn(),
}));

vi.mock(apiPath, () => ({
  listConnectors: (...args: unknown[]) => mocks.listConnectors(...args),
  putConnectorToggle: (...args: unknown[]) => mocks.putConnectorToggle(...args),
}));

describe('PageConnector', () => {
  beforeEach(() => {
    mocks.listConnectors.mockClear();
    mocks.putConnectorToggle.mockClear();
    mocks.listConnectors.mockResolvedValue([
      { id: 'browser', switch: 'off', connection: 'disconnected' },
    ]);
    mocks.putConnectorToggle.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
  });

  it('渲染 header title/desc + tab + browser section', async () => {
    render(<PageConnector />);
    expect(screen.getByText('连接器').textContent).toBe('连接器');
    expect(screen.getByText(/connector/).textContent).toContain('connector');
    // tab 标签 + 卡片名称都含「浏览器」
    expect(screen.getAllByText('浏览器').length).toBeGreaterThanOrEqual(1);
    await waitFor(() => {
      expect(screen.getByRole('switch')).toBeTruthy();
      // v0.0.46：switch=off → 「未启用」
      expect(screen.getByText('未启用').textContent).toBe('未启用');
    });
  });

  it('挂载 → 调 listConnectors 拉 state', async () => {
    render(<PageConnector />);
    await waitFor(() => expect(mocks.listConnectors).toHaveBeenCalled());
  });

  it('点 toggle → 调 putConnectorToggle(browser, true)', async () => {
    render(<PageConnector />);
    await waitFor(() => expect(screen.getByRole('switch')).toBeTruthy());
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => {
      expect(mocks.putConnectorToggle).toHaveBeenCalledWith('browser', true);
    });
  });

  // v0.0.46：手动 toggle on 后立即回推 { switch:'on', connection:'disconnected' } 稳态
  // UI 立即显 toggle on + 「已启用（未连接）」，不进入 connecting 局部态
  it('toggle on 后立即回推 disconnected 稳态 → toggle on + 「已启用（未连接）」', async () => {
    // 先返 off，用户点后立刻切换成 on/disconnected
    mocks.listConnectors
      .mockResolvedValueOnce([{ id: 'browser', switch: 'off', connection: 'disconnected' }])
      .mockResolvedValue([{ id: 'browser', switch: 'on', connection: 'disconnected' }]);
    render(<PageConnector />);
    await waitFor(() => expect(screen.getByRole('switch')).toBeTruthy());
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => {
      expect(screen.getByRole('switch').getAttribute('data-enabled')).toBe('true');
      expect(screen.getByText('已启用（未连接）').textContent).toBe('已启用（未连接）');
    });
    // 未进入 connecting（v0.0.46：toggle 不本地推测 connecting）
    expect(screen.queryByText('连接中')).toBeNull();
  });

  it('后端返 connected → toggle on + status「已连接」', async () => {
    mocks.listConnectors.mockResolvedValue([
      { id: 'browser', switch: 'on', connection: 'connected', lastConnectedAt: 1700000000000 },
    ]);
    render(<PageConnector />);
    await waitFor(() => {
      expect(screen.getByRole('switch').getAttribute('data-enabled')).toBe('true');
      expect(screen.getByText('已连接').textContent).toBe('已连接');
    });
  });

  // v0.0.46：LLM 触发 lazy connect 期间后端会推 { switch:'on', connection:'connecting' }
  it('后端返 connecting（LLM lazy connect 期间）→ toggle on + status「连接中…」', async () => {
    mocks.listConnectors.mockResolvedValue([
      { id: 'browser', switch: 'on', connection: 'connecting' },
    ]);
    render(<PageConnector />);
    await waitFor(() => {
      expect(screen.getByRole('switch').getAttribute('data-enabled')).toBe('true');
      expect(screen.getByText('连接中…').textContent).toBe('连接中…');
    });
  });

  it('后端返 error → 显 error 区 + retry button', async () => {
    mocks.listConnectors.mockResolvedValue([
      { id: 'browser', switch: 'on', connection: 'error', errorDetail: 'chrome 未开' },
    ]);
    render(<PageConnector />);
    await waitFor(() => {
      expect(screen.getByText(/chrome 未开/)).toBeTruthy();
      expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    });
  });
});
