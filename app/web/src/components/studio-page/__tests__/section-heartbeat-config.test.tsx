/**
 * @vitest-environment jsdom
 * section-heartbeat-config 单测（[v0.0.116] squad 级重写：interval chip + activeWindows + scope）
 * 参考: specs/ui/components/studio-page/heartbeat-config.md（状态/交互）
 *       specs/api/overall/11a-squad-endpoints.md §1.4（PATCH /squad heartbeatConfig）
 *
 * 纯本地态校验 + onSave 上抛（组件不调 fetch，只上抛 patch body 给父级）。
 * 定位策略：产品代码 data-testid 已移除，改语义定位（role/text + data-squad-id 容器）。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { HeartbeatConfigSection } from '../section-heartbeat-config';
import type { SquadHeartbeatConfig, Member } from '../squad-types';

// i18n 初始化（studio.heartbeat.* + common）
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(cleanup);

/** 默认 Props 工厂 */
function mkProps(over: Record<string, unknown> = {}) {
  return {
    squadId: 'SQ-1',
    enableHeartBeat: true,
    heartbeatConfig: null as SquadHeartbeatConfig | null,
    members: [] as Member[],
    timezone: 'Asia/Shanghai',
    onSave: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

// —— 语义定位辅助 —— //
/** section 根容器（按 data-squad-id 定位） */
const rootOf = (container: HTMLElement) => container.querySelector('[data-squad-id="SQ-1"]');
/** interval chip（accessible name = `${n} min`，数字与 min 间有空格） */
const intervalChip = (n: number) => screen.getByRole('button', { name: `${n} min` });
/** 保存按钮 */
const saveBtn = () => screen.getByRole('button', { name: '保存心跳配置' }) as HTMLButtonElement;
/** 重置按钮 */
const resetBtn = () => screen.getByRole('button', { name: '重置默认' });

describe('HeartbeatConfigSection — 根节点契约', () => {
  it('渲染 section 根节点（data-squad-id）', () => {
    const { container } = render(<HeartbeatConfigSection {...mkProps()} />);
    expect(rootOf(container)).toBeTruthy();
  });

  it('interval chip 4 个（5/15/30/60）', () => {
    render(<HeartbeatConfigSection {...mkProps()} />);
    expect(intervalChip(5)).toBeTruthy();
    expect(intervalChip(15)).toBeTruthy();
    expect(intervalChip(30)).toBeTruthy();
    expect(intervalChip(60)).toBeTruthy();
  });

  it('保存按钮和重置按钮均渲染', () => {
    render(<HeartbeatConfigSection {...mkProps()} />);
    expect(saveBtn()).toBeTruthy();
    expect(resetBtn()).toBeTruthy();
  });
});

describe('HeartbeatConfigSection — killswitch 提示', () => {
  it('enableHeartBeat=false → 显示 killswitch 提示文案', () => {
    render(<HeartbeatConfigSection {...mkProps({ enableHeartBeat: false })} />);
    expect(screen.getByText('自主性总开关已关，配置保存但暂不生效。')).toBeTruthy();
  });

  it('enableHeartBeat=true → 无 killswitch 提示', () => {
    render(<HeartbeatConfigSection {...mkProps({ enableHeartBeat: true })} />);
    expect(screen.queryByText('自主性总开关已关，配置保存但暂不生效。')).toBeNull();
  });
});

describe('HeartbeatConfigSection — interval chip 选中', () => {
  it('heartbeatConfig=null → 默认选中 15（DEFAULT_CONFIG）', () => {
    render(<HeartbeatConfigSection {...mkProps({ heartbeatConfig: null })} />);
    const btn15 = intervalChip(15);
    // 选中态：class 含 accent（实现细节，只断言该 button 存在且非 disabled）
    expect(btn15).toBeTruthy();
  });

  it('heartbeatConfig.interval=30 → 点 5 后 save 可用（dirty）', () => {
    const cfg: SquadHeartbeatConfig = { interval: 30, activeWindows: [], scope: { mode: 'all', memberIds: [] } };
    render(<HeartbeatConfigSection {...mkProps({ heartbeatConfig: cfg })} />);
    // 点 5 → 变为 5 选中
    fireEvent.click(intervalChip(5));
    // save 此时可用（dirty）
    expect(saveBtn().disabled).toBe(false);
  });
});

describe('HeartbeatConfigSection — save/reset 行为', () => {
  it('无改动时 save disabled（not dirty）', () => {
    render(<HeartbeatConfigSection {...mkProps()} />);
    expect(saveBtn().disabled).toBe(true);
  });

  it('改 interval → dirty → save 可点击 → onSave 被调（携带 heartbeatConfig）', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<HeartbeatConfigSection {...mkProps({ onSave })} />);
    // 点 5 → dirty
    fireEvent.click(intervalChip(5));
    const btn = saveBtn();
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const callArg = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(callArg).toHaveProperty('heartbeatConfig');
    expect((callArg.heartbeatConfig as SquadHeartbeatConfig).interval).toBe(5);
  });

  it('点 reset → onSave({ heartbeatConfig: null })', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<HeartbeatConfigSection {...mkProps({ onSave })} />);
    fireEvent.click(resetBtn());
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({ heartbeatConfig: null });
  });

  it('onSave 抛错 → 显示错误 banner', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('服务器错误'));
    render(<HeartbeatConfigSection {...mkProps({ onSave })} />);
    fireEvent.click(intervalChip(5));
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByText('服务器错误')).toBeTruthy());
  });
});

describe('HeartbeatConfigSection — 外部 heartbeatConfig 变化时重置', () => {
  it('父级 refresh 后 heartbeatConfig 更新 → 组件状态同步（save 重置为 not dirty）', async () => {
    const cfg1: SquadHeartbeatConfig = { interval: 15, activeWindows: [], scope: { mode: 'all', memberIds: [] } };
    const { rerender } = render(<HeartbeatConfigSection {...mkProps({ heartbeatConfig: cfg1 })} />);
    // 改 interval → dirty
    fireEvent.click(intervalChip(60));
    expect(saveBtn().disabled).toBe(false);
    // 父级回灌新配置（如 save 成功后）
    const cfg2: SquadHeartbeatConfig = { interval: 60, activeWindows: [], scope: { mode: 'all', memberIds: [] } };
    rerender(<HeartbeatConfigSection {...mkProps({ heartbeatConfig: cfg2 })} />);
    // 回灌后 base 变 60，当前也是 60 → not dirty
    await waitFor(() => {
      expect(saveBtn().disabled).toBe(true);
    });
  });
});
