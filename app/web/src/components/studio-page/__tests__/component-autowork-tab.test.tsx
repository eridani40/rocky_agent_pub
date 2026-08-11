/**
 * @vitest-environment jsdom
 * component-autowork-tab 单测（v0.0.317 onSaveBarChange 上推 + dirty/save/cancel 逻辑不变）
 * 参考: specs/ui/components/studio-page/component-autowork-tab.md（组合 + testid）
 *       specs/tech/version_logs/v0.0.317/change_plan.md P0-C
 *
 * v0.0.317: 底部保存/取消按钮去掉，改由 onSaveBarChange 上推 SaveBarController 给 SeatsPanel。
 * 测试用 mock onSaveBarChange 拿到 controller 后验证 dirty/save/cancel。
 *
 * vi.mock 绝对路径（MEMORY: bun+jsdom 并发下相对路径 vi.mock 静默失效）。
 */
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor, within, fireEvent, act } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import type { SaveBarController } from '../squad-types';
import { AutoworkTab } from '../component-autowork-tab';
import { mkDetail } from './_fixtures';

beforeAll(async () => {
  await initI18n('zh-CN');
});

const mocks = vi.hoisted(() => ({
  getBudgetUsage: vi.fn(),
  getSchedulerHistory: vi.fn(),
}));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/squad-api'));
vi.mock(apiPath, () => mocks);

const autonomyRoot = () =>
  screen.getByText('enableHeartBeat（自主性总开关）').closest('div') as HTMLElement;
const intervalChip = (n: number) => screen.getByRole('button', { name: `${n} min` });

/** 捕获最新 SaveBarController */
function renderWithCtrl(
  detail: ReturnType<typeof mkDetail>,
  onSaveMeta: ReturnType<typeof vi.fn>,
): { ctrl: () => SaveBarController | null } {
  let currentCtrl: SaveBarController | null = null;
  const onSaveBarChange = vi.fn((ctrl: SaveBarController | null) => {
    currentCtrl = ctrl;
  });
  render(<AutoworkTab detail={detail} onSaveMeta={onSaveMeta} onSaveBarChange={onSaveBarChange} />);
  return { ctrl: () => currentCtrl };
}

describe('AutoworkTab（v0.0.317 — dirty 管理者 + onSaveBarChange 上推）', () => {
  beforeEach(() => {
    mocks.getBudgetUsage.mockResolvedValue({
      squadId: 's1',
      limit: 1000000,
      window: 'daily',
      consumed: 200000,
      remaining: 800000,
      windowStart: '2026-06-29T16:00:00.000Z',
      windowEnd: '2026-06-30T16:00:00.000Z',
      perSession: [],
      timezone: 'Asia/Shanghai',
    } as never);
    mocks.getSchedulerHistory.mockResolvedValue([] as never);
  });

  afterEach(() => {
    cleanup();
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  it('渲染 autowork-tab 容器根 + 四块都在（toggle + heartbeat + budget + history）', async () => {
    const { container } = render(<AutoworkTab detail={mkDetail()} onSaveMeta={async () => {}} onSaveBarChange={vi.fn()} />);
    expect(container.firstElementChild).toBeTruthy();
    expect(autonomyRoot()).toBeTruthy();
    expect(within(autonomyRoot()).getByRole('switch')).toBeTruthy();
    expect(screen.getByText(/budget（团队 token 预算/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('暂无自动工作记录')).toBeTruthy());
  });

  it('初始无改动 → ctrl.dirty=false', () => {
    const { ctrl } = renderWithCtrl(mkDetail(), vi.fn().mockResolvedValue(undefined));
    expect(ctrl()?.dirty).toBe(false);
  });

  it('切总开关 → ctrl.dirty=true（不即时调 onSaveMeta）', async () => {
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    const { ctrl } = renderWithCtrl(mkDetail(), onSaveMeta);
    await act(async () => { fireEvent.click(within(autonomyRoot()).getByRole('switch')); });
    expect(onSaveMeta).not.toHaveBeenCalled();
    expect(ctrl()?.dirty).toBe(true);
  });

  it('改心跳间隔（点 60 chip）→ ctrl.dirty=true', async () => {
    const { ctrl } = renderWithCtrl(mkDetail(), vi.fn().mockResolvedValue(undefined));
    await act(async () => { fireEvent.click(intervalChip(60)); });
    expect(ctrl()?.dirty).toBe(true);
  });

  it('dirty 后 ctrl.save() → onSaveMeta 合并 PATCH（enableHeartBeat + heartbeatConfig + budget）', async () => {
    const onSaveMeta = vi.fn().mockResolvedValue(undefined);
    const { ctrl } = renderWithCtrl(mkDetail(), onSaveMeta);
    await act(async () => {
      fireEvent.click(within(autonomyRoot()).getByRole('switch'));
      fireEvent.click(intervalChip(60));
    });
    await act(async () => { await ctrl()?.save(); });
    await waitFor(() => expect(onSaveMeta).toHaveBeenCalledTimes(1));
    const body = onSaveMeta.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toHaveProperty('enableHeartBeat', true);
    expect(body).toHaveProperty('heartbeatConfig');
    expect((body.heartbeatConfig as { interval: number }).interval).toBe(60);
    expect(body).toHaveProperty('budget');
  });

  it('dirty 后 ctrl.cancel() → draft 回 detail 原值（dirty=false）', async () => {
    const { ctrl } = renderWithCtrl(mkDetail(), vi.fn().mockResolvedValue(undefined));
    await act(async () => { fireEvent.click(within(autonomyRoot()).getByRole('switch')); });
    expect(ctrl()?.dirty).toBe(true);
    await act(async () => { ctrl()?.cancel(); });
    expect(ctrl()?.dirty).toBe(false);
    // toggle 回原 off 态
    expect(within(autonomyRoot()).getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('改了又改回原值 → ctrl.dirty=false', async () => {
    const { ctrl } = renderWithCtrl(mkDetail(), vi.fn().mockResolvedValue(undefined));
    const sw = within(autonomyRoot()).getByRole('switch');
    await act(async () => { fireEvent.click(sw); });
    expect(ctrl()?.dirty).toBe(true);
    await act(async () => { fireEvent.click(sw); });
    expect(ctrl()?.dirty).toBe(false);
  });

  it('BudgetMeter 异步拉取后渲染 consumed 数字节点', async () => {
    render(<AutoworkTab detail={mkDetail()} onSaveMeta={async () => {}} onSaveBarChange={vi.fn()} />);
    expect(await screen.findByText('200,000')).toBeTruthy();
    expect(mocks.getBudgetUsage).toHaveBeenCalledWith('s1');
  });

  it('AutoWorkHistory 调 GET /scheduler/history', async () => {
    render(<AutoworkTab detail={mkDetail()} onSaveMeta={async () => {}} onSaveBarChange={vi.fn()} />);
    await waitFor(() => expect(mocks.getSchedulerHistory).toHaveBeenCalledWith('s1', undefined));
  });

  it('反映 detail.enableHeartBeat 当前态（killswitch off）', () => {
    render(<AutoworkTab detail={mkDetail()} onSaveMeta={async () => {}} onSaveBarChange={vi.fn()} />);
    expect(within(autonomyRoot()).getByText('已暂停自主工作，成员仅响应对话')).toBeTruthy();
  });

  it('detail.enableHeartBeat=true 时 on 态', () => {
    render(<AutoworkTab detail={mkDetail({ enableHeartBeat: true })} onSaveMeta={async () => {}} onSaveBarChange={vi.fn()} />);
    expect(within(autonomyRoot()).getByText('自主工作已开启，成员将按心跳节奏主动运转')).toBeTruthy();
  });

  // [v0.0.317] onSaveBarChange 上推
  it('mount 时上推 controller（dirty=false）；unmount 时上推 null', () => {
    const onSaveBarChange = vi.fn();
    const { unmount } = render(
      <AutoworkTab detail={mkDetail()} onSaveMeta={async () => {}} onSaveBarChange={onSaveBarChange} />,
    );
    const lastCall = onSaveBarChange.mock.calls[onSaveBarChange.mock.calls.length - 1];
    expect(lastCall?.[0]).not.toBeNull();
    expect(lastCall?.[0]?.dirty).toBe(false);
    unmount();
    expect(onSaveBarChange).toHaveBeenLastCalledWith(null);
  });

  // [v0.0.317] save error inline banner（code review Major 1 修复）
  it('save 失败 → inline error banner 显示错误信息', async () => {
    const onSaveMeta = vi.fn().mockRejectedValue(new Error('网络错误'));
    const { ctrl } = renderWithCtrl(mkDetail(), onSaveMeta);
    await act(async () => { fireEvent.click(within(autonomyRoot()).getByRole('switch')); });
    await act(async () => { await ctrl()?.save(); });
    await waitFor(() => expect(screen.getByText('网络错误')).toBeTruthy());
  });

  it('save 成功 → error banner 不出现（初始无 error）', () => {
    render(<AutoworkTab detail={mkDetail()} onSaveMeta={async () => {}} onSaveBarChange={vi.fn()} />);
    expect(screen.queryByText(/错误|error/i)).toBeNull();
  });
});
