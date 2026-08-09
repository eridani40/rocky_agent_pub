// @vitest-environment jsdom
/**
 * component-ws-image-viewer 单测 —— workspace 图片只读查看器（v0.0.269）
 * 参考: specs/prd/version_logs/v0.0.269.file_dispatch_nav_status/prd.md §3.2/UC-1/2
 *       specs/tech/version_logs/v0.0.269/change_plan.md（viewer UT 行）
 *
 * 覆盖：渲染 img（mock readWorkspaceFileBinary → base64 → data URL）/ svg media type /
 * 加载失败 error 文案 / 只读无编辑按钮 / 关闭回调（✕ + 遮罩 + Esc）/ target=null 不渲染。
 *
 * mock 策略（MEMORY test-vitest-mock-absolute-path）：vi.hoisted + __dirname 派生绝对路径 mock chat-api。
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';

const { readWorkspaceFileBinaryMock, chatApiPath } = vi.hoisted(() => ({
  readWorkspaceFileBinaryMock: vi.fn(),
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
}));

vi.mock(chatApiPath, () => ({
  readWorkspaceFileBinary: (...args: unknown[]) => readWorkspaceFileBinaryMock(...args),
}));

import { ComponentWsImageViewer, type WsImageTarget } from '../component-ws-image-viewer';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => {
  cleanup();
  readWorkspaceFileBinaryMock.mockReset();
});

const TARGET: WsImageTarget = { path: 'img/logo.png', fileName: 'logo.png', subtitle: 'img/logo.png' };

function renderViewer(overrides: { target?: WsImageTarget | null; onClose?: () => void } = {}) {
  const onClose = vi.fn();
  render(
    <ComponentWsImageViewer
      sessionId="s1"
      target={overrides.target === undefined ? TARGET : overrides.target}
      onClose={overrides.onClose ?? onClose}
    />,
  );
  return { onClose };
}

describe('ComponentWsImageViewer — workspace 图片只读查看器（v0.0.269）', () => {
  it('渲染 modal + 读 base64 → data URL <img>（PNG media type）', async () => {
    readWorkspaceFileBinaryMock.mockResolvedValue({ content: 'aGVsbG8=' }); // "hello"
    renderViewer();
    // modal 根 testid
    expect(screen.getByTestId('ws-image-viewer')).toBeTruthy();
    // 异步读 → img 出现
    await waitFor(() => expect(screen.getByTestId('ws-image-viewer-img')).toBeTruthy());
    const img = screen.getByTestId('ws-image-viewer-img') as HTMLImageElement;
    expect(img.src).toBe('data:image/png;base64,aGVsbG8=');
    expect(img.alt).toBe('logo.png');
    // 读调用 path 正确
    expect(readWorkspaceFileBinaryMock).toHaveBeenCalledWith('s1', { path: 'img/logo.png' });
  });

  it('svg 扩展名 → image/svg+xml media type（6 格式闭合）', async () => {
    readWorkspaceFileBinaryMock.mockResolvedValue({ content: 'PHN2Zz48L3N2Zz4=' });
    renderViewer({ target: { path: 'a.svg', fileName: 'a.svg', subtitle: 'a.svg' } });
    await waitFor(() => expect(screen.getByTestId('ws-image-viewer-img')).toBeTruthy());
    const img = screen.getByTestId('ws-image-viewer-img') as HTMLImageElement;
    expect(img.src).toBe('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=');
  });

  it('读取失败 → 轻量错误文案（testid ws-image-viewer-error），不渲染 img', async () => {
    readWorkspaceFileBinaryMock.mockRejectedValue(new Error('404'));
    renderViewer();
    await waitFor(() => expect(screen.getByTestId('ws-image-viewer-error')).toBeTruthy());
    expect(screen.queryByTestId('ws-image-viewer-img')).toBeNull();
    expect(screen.getByTestId('ws-image-viewer-error').textContent).toContain('加载失败');
  });

  it('只读：无编辑/保存/格式化/校验按钮（无 mode-toggle）', async () => {
    readWorkspaceFileBinaryMock.mockResolvedValue({ content: 'x' });
    renderViewer();
    await waitFor(() => expect(screen.getByTestId('ws-image-viewer-img')).toBeTruthy());
    expect(screen.queryByText(/编辑|保存|格式化|校验/)).toBeNull();
  });

  it('关闭按钮 ✕ → onClose 回调', async () => {
    readWorkspaceFileBinaryMock.mockResolvedValue({ content: 'x' });
    const { onClose } = renderViewer();
    await waitFor(() => expect(screen.getByTestId('ws-image-viewer-img')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('关闭'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('遮罩点击 → onClose 回调（L3 modal）', async () => {
    readWorkspaceFileBinaryMock.mockResolvedValue({ content: 'x' });
    const { onClose } = renderViewer();
    await waitFor(() => expect(screen.getByTestId('ws-image-viewer-img')).toBeTruthy());
    fireEvent.click(screen.getByTestId('ws-image-viewer'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Esc → onClose 回调', async () => {
    readWorkspaceFileBinaryMock.mockResolvedValue({ content: 'x' });
    const { onClose } = renderViewer();
    await waitFor(() => expect(screen.getByTestId('ws-image-viewer-img')).toBeTruthy());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('target=null → 不渲染（挂载层关闭置空）', () => {
    const { container } = render(<ComponentWsImageViewer sessionId="s1" target={null} onClose={() => {}} />);
    expect(container.innerHTML).toBe('');
  });

  it('source=absolute → rockyShell.readFileBinary（IPC，base64 同形态）', async () => {
    // 造 window.rockyShell（absolute 源走 Electron IPC，不走 HTTP readWorkspaceFileBinary）
    const api = {
      readFileBinary: vi.fn(async () => ({ ok: true, content: 'aGVsbG8=' })),
    };
    (window as unknown as { rockyShell: unknown }).rockyShell = api;
    renderViewer({ target: { path: '/abs/logo.png', fileName: 'logo.png', subtitle: '/abs/logo.png', source: 'absolute' } });
    await waitFor(() => expect(screen.getByTestId('ws-image-viewer-img')).toBeTruthy());
    const img = screen.getByTestId('ws-image-viewer-img') as HTMLImageElement;
    expect(img.src).toBe('data:image/png;base64,aGVsbG8=');
    expect(api.readFileBinary).toHaveBeenCalledWith('/abs/logo.png');
    // absolute 源不调 HTTP workspace 读
    expect(readWorkspaceFileBinaryMock).not.toHaveBeenCalled();
  });

  it('source=absolute + readFileBinary 失败 → error 文案（不渲染 img）', async () => {
    const api = {
      readFileBinary: vi.fn(async () => ({ ok: false, reason: 'not-found' })),
    };
    (window as unknown as { rockyShell: unknown }).rockyShell = api;
    renderViewer({ target: { path: '/abs/missing.png', fileName: 'missing.png', subtitle: '/abs/missing.png', source: 'absolute' } });
    await waitFor(() => expect(screen.getByTestId('ws-image-viewer-error')).toBeTruthy());
    expect(screen.queryByTestId('ws-image-viewer-img')).toBeNull();
    expect(readWorkspaceFileBinaryMock).not.toHaveBeenCalled();
  });

  it('source=absolute + 非 Electron（无 rockyShell）→ error 文案', async () => {
    delete (window as unknown as { rockyShell?: unknown }).rockyShell;
    renderViewer({ target: { path: '/abs/x.png', fileName: 'x.png', subtitle: '/abs/x.png', source: 'absolute' } });
    await waitFor(() => expect(screen.getByTestId('ws-image-viewer-error')).toBeTruthy());
    expect(readWorkspaceFileBinaryMock).not.toHaveBeenCalled();
  });
});
