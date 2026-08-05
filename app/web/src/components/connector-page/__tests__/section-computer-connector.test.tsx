/**
 * @vitest-environment jsdom
 * section-computer-connector 单测（v0.0.105 spike）：非 Electron 降级 + 权限态渲染 + 按钮派发 + 截图
 * 参考: specs/ui/components/connector-page/section-computer-connector.md
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { SectionComputerConnector } from '../section-computer-connector';
import { initI18n } from '../../../i18n';
import type { RockyComputerApi } from '../../../types/rocky-computer';

beforeAll(async () => {
  await initI18n('zh-CN');
});

/** 造 window.rockyComputer fake（默认 macOS 未授权 + 截图成功） */
function fakeApi(over: Partial<RockyComputerApi> = {}): RockyComputerApi {
  return {
    getPermissions: vi.fn(async () => ({
      platform: 'darwin',
      supported: true,
      accessibility: false,
      screenRecording: 'denied' as const,
    })),
    requestAccessibility: vi.fn(async () => true),
    openScreenRecordingSettings: vi.fn(async () => ({ ok: true })),
    testScreenshot: vi.fn(async () => ({ ok: true, dataUrl: 'data:image/png;base64,ZZ', width: 640, height: 400 })),
    ...over,
  };
}

afterEach(() => {
  cleanup();
  window.rockyComputer = undefined;
});

describe('SectionComputerConnector — 非 Electron 降级', () => {
  it('window.rockyComputer 缺失 → 显「仅桌面 App 可用」，不渲染权限面板', () => {
    window.rockyComputer = undefined;
    render(<SectionComputerConnector />);
    expect(screen.getByText(/仅桌面/).textContent).toContain('仅桌面');
    expect(screen.queryByText('辅助功能')).toBeNull();
    expect(screen.queryByRole('button', { name: '测试截图' })).toBeNull();
  });
});

describe('SectionComputerConnector — Electron 权限态渲染', () => {
  it('挂载即调 getPermissions；未授权 → 两行 ✗未授权 + 两个授权按钮', async () => {
    const api = fakeApi();
    window.rockyComputer = api;
    render(<SectionComputerConnector />);
    // 挂载拉一次
    await waitFor(() => expect(api.getPermissions).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getAllByText(/未授权/).length).toBe(2),
    );
    // 未授权行显操作按钮
    expect(screen.getByRole('button', { name: '授权辅助功能' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开屏幕录制设置' })).toBeTruthy();
  });

  it('已授权 → 两行 ✓已授权，不显授权按钮', async () => {
    const api = fakeApi({
      getPermissions: vi.fn(async () => ({
        platform: 'darwin',
        supported: true,
        accessibility: true,
        screenRecording: 'granted' as const,
      })),
    });
    window.rockyComputer = api;
    render(<SectionComputerConnector />);
    await waitFor(() =>
      expect(screen.getAllByText(/已授权/).length).toBe(2),
    );
    expect(screen.queryByRole('button', { name: '授权辅助功能' })).toBeNull();
    expect(screen.queryByRole('button', { name: '打开屏幕录制设置' })).toBeNull();
  });
});

describe('SectionComputerConnector — 按钮派发 IPC', () => {
  it('点「授权辅助功能」→ 调 requestAccessibility + 重拉权限', async () => {
    const api = fakeApi();
    window.rockyComputer = api;
    render(<SectionComputerConnector />);
    const btn = await screen.findByRole('button', { name: '授权辅助功能' });
    fireEvent.click(btn);
    await waitFor(() => expect(api.requestAccessibility).toHaveBeenCalled());
    // 挂载 1 次 + 授权后重拉 1 次 ≥ 2
    await waitFor(() => expect((api.getPermissions as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('点「打开屏幕录制设置」→ 调 openScreenRecordingSettings', async () => {
    const api = fakeApi();
    window.rockyComputer = api;
    render(<SectionComputerConnector />);
    const btn = await screen.findByRole('button', { name: '打开屏幕录制设置' });
    fireEvent.click(btn);
    await waitFor(() => expect(api.openScreenRecordingSettings).toHaveBeenCalled());
  });

  it('点「重新检测」→ 重拉权限', async () => {
    const api = fakeApi();
    window.rockyComputer = api;
    render(<SectionComputerConnector />);
    const btn = await screen.findByRole('button', { name: '重新检测' });
    fireEvent.click(btn);
    await waitFor(() => expect((api.getPermissions as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});

describe('SectionComputerConnector — 测试截图', () => {
  it('点「测试截图」成功 → 渲染缩略图 img（src=dataUrl）', async () => {
    const api = fakeApi();
    window.rockyComputer = api;
    render(<SectionComputerConnector />);
    const btn = await screen.findByRole('button', { name: '测试截图' });
    fireEvent.click(btn);
    const img = (await screen.findByAltText('截图成功')) as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/png;base64,ZZ');
    expect(screen.queryByText(/截图失败/)).toBeNull();
  });

  it('点「测试截图」失败 → 显示 error reason，不渲染缩略图', async () => {
    const api = fakeApi({
      testScreenshot: vi.fn(async () => ({ ok: false, reason: 'no-screen-source' })),
    });
    window.rockyComputer = api;
    render(<SectionComputerConnector />);
    const btn = await screen.findByRole('button', { name: '测试截图' });
    fireEvent.click(btn);
    const err = await screen.findByText(/no-screen-source/);
    expect(err.textContent).toContain('no-screen-source');
    expect(screen.queryByAltText('截图成功')).toBeNull();
  });
});
