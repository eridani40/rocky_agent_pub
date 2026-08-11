/**
 * @vitest-environment jsdom
 * component-manage-tab 单测（v0.0.317 onSaveBarChange 上推 + dirty/save/cancel 逻辑不变）
 * 参考: specs/ui/overall/06-studio.md §3.2（管理 tab 元信息编辑）
 *       specs/tech/version_logs/v0.0.317/change_plan.md P0-B
 *
 * v0.0.317: 底部保存按钮去掉，改由 onSaveBarChange 上推 SaveBarController 给 SeatsPanel。
 * 测试用 mock onSaveBarChange 拿到 controller 后验证 dirty/save/cancel。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import type { SaveBarController } from '../squad-types';
import { ManageTab } from '../component-manage-tab';
import { mkDetail } from './_fixtures';

beforeAll(async () => {
  await initI18n('zh-CN');
});

vi.mock('../component-squad-delete', () => ({
  SquadDeleteSection: () => <div data-testid="squad-delete-mock" />,
}));

/** 捕获最新 SaveBarController */
function renderWithCtrl(
  detail: ReturnType<typeof mkDetail>,
  onSaveMeta: ReturnType<typeof vi.fn>,
): { ctrl: () => SaveBarController | null } {
  let currentCtrl: SaveBarController | null = null;
  const onSaveBarChange = vi.fn((ctrl: SaveBarController | null) => {
    currentCtrl = ctrl;
  });
  const { rerender } = render(
    <ManageTab
      detail={detail}
      onSaveMeta={onSaveMeta}
      onDelete={vi.fn().mockResolvedValue(true)}
      onSaveBarChange={onSaveBarChange}
    />,
  );
  return { ctrl: () => currentCtrl, rerender } as { ctrl: () => SaveBarController | null; rerender: (ui: React.ReactElement) => void };
}

describe('ManageTab effortDefault', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function mockProviders() {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ id: 'pA', label: 'Provider A', models: [{ modelId: 'a-1', label: 'A-1' }] }],
      }),
    }) as unknown as typeof fetch;
  }

  it('渲染 effortDefault 下拉（4 档 + 初始值 = detail.effortDefault）', async () => {
    mockProviders();
    const detail = mkDetail({ effortDefault: 'low' });
    render(<ManageTab detail={detail} onSaveMeta={vi.fn()} onDelete={vi.fn().mockResolvedValue(true)} onSaveBarChange={vi.fn()} />);
    expect(screen.getByText('默认推理强度')).toBeTruthy();
    expect(screen.getByRole('button', { name: '低' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '低' }));
    expect(screen.getByRole('option', { name: '默认' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '低' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '高' })).toBeTruthy();
    expect(screen.getByRole('option', { name: '超高' })).toBeTruthy();
  });

  it('选档后 ctrl.dirty=true → ctrl.save() → onSaveMeta patch 含 effortDefault', async () => {
    mockProviders();
    const detail = mkDetail({ effortDefault: 'default' });
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    const { ctrl } = renderWithCtrl(detail, onSaveMeta);
    expect(ctrl()?.dirty).toBe(false);
    // 先点开 dropdown，等 option 出现
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '默认' })); });
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: '高' })); });
    expect(ctrl()?.dirty).toBe(true);
    await act(async () => { await ctrl()?.save(); });
    await waitFor(() => expect(onSaveMeta).toHaveBeenCalledTimes(1));
    expect(onSaveMeta).toHaveBeenCalledWith(expect.objectContaining({ effortDefault: 'high' }));
  });

  it('dirty 判定：改档 dirty=true；改回 detail 值 dirty=false', async () => {
    mockProviders();
    const detail = mkDetail({ effortDefault: 'default' });
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    const { ctrl } = renderWithCtrl(detail, onSaveMeta);
    // 改「超高」→ dirty
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '默认' })); });
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: '超高' })); });
    expect(ctrl()?.dirty).toBe(true);
    // 改回「默认」→ dirty=false
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '超高' })); });
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: '默认' })); });
    expect(ctrl()?.dirty).toBe(false);
  });
});

// [v0.0.316] enableGroupChat dirty/save
describe('ManageTab enableGroupChat（v0.0.316）', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function mockProviders() {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ id: 'pA', label: 'Provider A', models: [{ modelId: 'a-1', label: 'A-1' }] }],
      }),
    }) as unknown as typeof fetch;
  }

  it('切换群聊开关 → ctrl.dirty=true', async () => {
    mockProviders();
    const detail = mkDetail({ enableGroupChat: true });
    const { ctrl } = renderWithCtrl(detail, vi.fn().mockResolvedValue(undefined));
    expect(ctrl()?.dirty).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('switch')); });
    expect(ctrl()?.dirty).toBe(true);
  });

  it('切换群聊开关后 ctrl.save() → PATCH body 含 enableGroupChat', async () => {
    mockProviders();
    const detail = mkDetail({ enableGroupChat: true });
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    const { ctrl } = renderWithCtrl(detail, onSaveMeta);
    await act(async () => { fireEvent.click(screen.getByRole('switch')); });
    await act(async () => { await ctrl()?.save(); });
    await waitFor(() => expect(onSaveMeta).toHaveBeenCalledTimes(1));
    expect(onSaveMeta).toHaveBeenCalledWith(expect.objectContaining({ enableGroupChat: false }));
  });

  it('只切群聊也可 save（混合 dirty）', async () => {
    mockProviders();
    const detail = mkDetail({ enableGroupChat: false });
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    const { ctrl } = renderWithCtrl(detail, onSaveMeta);
    expect(ctrl()?.dirty).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('switch')); });
    expect(ctrl()?.dirty).toBe(true);
    await act(async () => { await ctrl()?.save(); });
    await waitFor(() => expect(onSaveMeta).toHaveBeenCalledTimes(1));
    expect(onSaveMeta).toHaveBeenCalledWith(expect.objectContaining({ enableGroupChat: true }));
  });
});

// [v0.0.317] onSaveBarChange 上推 + cancel 逻辑
describe('ManageTab onSaveBarChange（v0.0.317）', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  function mockProviders() {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ id: 'pA', label: 'Provider A', models: [{ modelId: 'a-1', label: 'A-1' }] }],
      }),
    }) as unknown as typeof fetch;
  }

  it('mount 时上推 controller（dirty=false）；unmount 时上推 null', () => {
    mockProviders();
    const onSaveBarChange = vi.fn();
    const detail = mkDetail();
    const { unmount } = render(
      <ManageTab detail={detail} onSaveMeta={vi.fn()} onDelete={vi.fn().mockResolvedValue(true)} onSaveBarChange={onSaveBarChange} />,
    );
    const lastCall = onSaveBarChange.mock.calls[onSaveBarChange.mock.calls.length - 1];
    expect(lastCall?.[0]).not.toBeNull();
    expect(lastCall?.[0]?.dirty).toBe(false);
    unmount();
    expect(onSaveBarChange).toHaveBeenLastCalledWith(null);
  });

  it('cancel：改字段后 ctrl.cancel() → draft 回 detail 原值（dirty=false）', async () => {
    mockProviders();
    const detail = mkDetail({ enableGroupChat: true });
    const { ctrl } = renderWithCtrl(detail, vi.fn().mockResolvedValue(undefined));
    await act(async () => { fireEvent.click(screen.getByRole('switch')); });
    expect(ctrl()?.dirty).toBe(true);
    await act(async () => { ctrl()?.cancel(); });
    expect(ctrl()?.dirty).toBe(false);
  });

  it('save 成功后 detail prop 更新 → draft 同步 → dirty 清零', async () => {
    mockProviders();
    const initial = mkDetail({ enableGroupChat: true, name: '旧名' });
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    let currentCtrl: SaveBarController | null = null;
    const onSaveBarChange = vi.fn((c: SaveBarController | null) => { currentCtrl = c; });
    const { rerender } = render(
      <ManageTab detail={initial} onSaveMeta={onSaveMeta} onDelete={vi.fn().mockResolvedValue(true)} onSaveBarChange={onSaveBarChange} />,
    );
    const ctrl = () => currentCtrl;
    // 改 name → dirty
    await act(async () => {
      fireEvent.change(screen.getByDisplayValue('旧名'), { target: { value: '新名' } });
    });
    expect(ctrl()?.dirty).toBe(true);
    // save
    await act(async () => { await ctrl()?.save(); });
    expect(onSaveMeta).toHaveBeenCalledWith(expect.objectContaining({ name: '新名' }));
    // 父级 setDetail(updated) → detail prop 更新（name='新名'）
    const updated = mkDetail({ enableGroupChat: true, name: '新名' });
    await act(async () => {
      rerender(
        <ManageTab detail={updated} onSaveMeta={onSaveMeta} onDelete={vi.fn().mockResolvedValue(true)} onSaveBarChange={onSaveBarChange} />,
      );
    });
    // draft 已同步 → dirty 清零
    expect(ctrl()?.dirty).toBe(false);
  });
});
