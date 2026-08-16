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

// [v0.0.347 T6 修正段决策㉛] 模型/方案单 select 严格互斥二选一（老板 22:22 拍板「必须只保留一个有效的」）
describe('ManageTab 模型/方案单 select 严格互斥（v0.0.347 T6）', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** URL 路由 fetch 桩：model_routing_plans group → 方案清单；其余（/provider）→ providers */
  function mockFetchWithPlans() {
    // 注意：req() 走 res.text() 解析——mock 必须同时提供 text()（仅 json() 会抛错致方案组空态）
    const mk = (payload: unknown) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    });
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
      if (url.includes('group=model_routing_plans')) {
        return mk({ items: [{ key: 'plan-a', data: { id: 'plan-a', name: '白天主力', createdAt: 1755200000000, items: [] } }] });
      }
      return mk({ items: [{ id: 'pA', label: 'Provider A', models: [{ modelId: 'a-1', label: 'A-1' }] }] });
    }) as unknown as typeof fetch;
  }

  it('初值方案优先：detail 双设（modelDefault+planId）→ trigger 显「方案 · <名>」（对齐 resolve 真值）', async () => {
    mockFetchWithPlans();
    const detail = mkDetail({ modelDefault: 'claude-sonnet', modelRoutingPlanId: 'plan-a' });
    render(<ManageTab detail={detail} onSaveMeta={vi.fn()} onDelete={vi.fn().mockResolvedValue(true)} onSaveBarChange={vi.fn()} />);
    // routingPlans 拉取完成后 trigger 反查方案名显示
    await waitFor(() => expect(screen.getByRole('button', { name: '方案 · 白天主力' })).toBeTruthy());
  });

  it('选方案 → save 载荷：planId + 显式清空 modelDefault+modelDefaultProviderId（非省略）', async () => {
    mockFetchWithPlans();
    const detail = mkDetail({ modelDefault: undefined });
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    const { ctrl } = renderWithCtrl(detail, onSaveMeta);
    expect(ctrl()?.dirty).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '选择模型或方案' })); });
    await act(async () => { fireEvent.click(await screen.findByRole('option', { name: '白天主力' })); });
    expect(ctrl()?.dirty).toBe(true);
    await act(async () => { await ctrl()?.save(); });
    await waitFor(() => expect(onSaveMeta).toHaveBeenCalledTimes(1));
    const body = onSaveMeta.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.modelRoutingPlanId).toBe('plan-a');
    expect(body.modelDefault).toBe('');
    expect(body.modelDefaultProviderId).toBe('');
  });

  it('选模型 → save 载荷：modelDefault+modelDefaultProviderId+modelRoutingPlanId:null', async () => {
    mockFetchWithPlans();
    const detail = mkDetail({ modelDefault: undefined });
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    const { ctrl } = renderWithCtrl(detail, onSaveMeta);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '选择模型或方案' })); });
    await act(async () => { fireEvent.click(await screen.findByRole('option', { name: /Provider A \/ A-1/ })); });
    expect(ctrl()?.dirty).toBe(true);
    await act(async () => { await ctrl()?.save(); });
    await waitFor(() => expect(onSaveMeta).toHaveBeenCalledTimes(1));
    const body = onSaveMeta.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.modelDefault).toBe('a-1');
    expect(body.modelDefaultProviderId).toBe('pA');
    expect(body.modelRoutingPlanId).toBe(null);
  });

  it('方案→模型切换：单 select 内直接切 → 载荷收敛到模型单值（planId:null）', async () => {
    mockFetchWithPlans();
    const detail = mkDetail({ modelDefault: undefined, modelRoutingPlanId: 'plan-a' });
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    const { ctrl } = renderWithCtrl(detail, onSaveMeta);
    // 初值=方案（方案优先）→ 等 plans 反查回填后打开选模型行（waitFor 先行，避免 findByRole 嵌 act 轮询失效）
    await waitFor(() => expect(screen.getByRole('button', { name: '方案 · 白天主力' })).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '方案 · 白天主力' })); });
    await act(async () => { fireEvent.click(await screen.findByRole('option', { name: /Provider A \/ A-1/ })); });
    expect(ctrl()?.dirty).toBe(true);
    await act(async () => { await ctrl()?.save(); });
    await waitFor(() => expect(onSaveMeta).toHaveBeenCalledTimes(1));
    const body = onSaveMeta.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.modelDefault).toBe('a-1');
    expect(body.modelDefaultProviderId).toBe('pA');
    expect(body.modelRoutingPlanId).toBe(null);
  });

  it('cancel：选方案后 ctrl.cancel() → pick 回 detail 初值（dirty=false）', async () => {
    mockFetchWithPlans();
    const detail = mkDetail({ modelDefault: undefined });
    const { ctrl } = renderWithCtrl(detail, vi.fn().mockResolvedValue(undefined));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '选择模型或方案' })); });
    await act(async () => { fireEvent.click(await screen.findByRole('option', { name: '白天主力' })); });
    expect(ctrl()?.dirty).toBe(true);
    await act(async () => { ctrl()?.cancel(); });
    expect(ctrl()?.dirty).toBe(false);
  });
});
