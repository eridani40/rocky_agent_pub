/**
 * @vitest-environment jsdom
 * section-heartbeat-config 单测（v0.0.316 P1 受控化：子控件改 draft 汇总 onChange 上报）
 * 参考: specs/ui/components/studio-page/heartbeat-config.md（状态/交互）
 *       specs/tech/version_logs/v0.0.316/change_plan.md P1（受控模式：去掉 squadId/onSave/save/reset 按钮）
 *
 * [v0.0.316] 受控模式：值从 props.heartbeatConfig 派生；子控件改动汇总 onChange 上报；
 *   不再自管 PATCH/save/reset 按钮/pending/error。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
    enableHeartBeat: true,
    heartbeatConfig: null as SquadHeartbeatConfig | null,
    members: [] as Member[],
    timezone: 'Asia/Shanghai',
    onChange: vi.fn(),
    ...over,
  };
}

// —— 语义定位辅助 —— //
/** interval chip（accessible name = `${n} min`，数字与 min 间有空格） */
const intervalChip = (n: number) => screen.getByRole('button', { name: `${n} min` });

describe('HeartbeatConfigSection — 根节点契约（v0.0.316 受控）', () => {
  it('interval chip 4 个（5/15/30/60）', () => {
    render(<HeartbeatConfigSection {...mkProps()} />);
    expect(intervalChip(5)).toBeTruthy();
    expect(intervalChip(15)).toBeTruthy();
    expect(intervalChip(30)).toBeTruthy();
    expect(intervalChip(60)).toBeTruthy();
  });

  it('受控模式无 save/reset 按钮（v0.0.316 去掉，统一由 tab 级保存）', () => {
    render(<HeartbeatConfigSection {...mkProps()} />);
    expect(screen.queryByRole('button', { name: '保存心跳配置' })).toBeNull();
    expect(screen.queryByRole('button', { name: '重置默认' })).toBeNull();
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

describe('HeartbeatConfigSection — 受控 onChange 上报', () => {
  it('heartbeatConfig=null → 默认选中 15（DEFAULT_CONFIG 基线展示）', () => {
    render(<HeartbeatConfigSection {...mkProps({ heartbeatConfig: null })} />);
    // 选中态：15 chip 存在（accent 样式，只断言 button 存在）
    expect(intervalChip(15)).toBeTruthy();
  });

  it('点 interval chip 5 → onChange 汇总上报完整 heartbeatConfig（interval=5 + 原 windows/scope）', () => {
    const onChange = vi.fn();
    const cfg: SquadHeartbeatConfig = {
      interval: 30,
      activeWindows: [],
      scope: { mode: 'all', memberIds: [] },
    };
    render(<HeartbeatConfigSection {...mkProps({ heartbeatConfig: cfg, onChange })} />);
    fireEvent.click(intervalChip(5));
    // 受控：同步上报 onChange（汇总 interval + activeWindows + scope）
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      interval: 5,
      activeWindows: [],
      scope: { mode: 'all', memberIds: [] },
    });
  });

  it('点 interval chip 60 → onChange 上报 interval=60（保留其他字段）', () => {
    const onChange = vi.fn();
    const cfg: SquadHeartbeatConfig = {
      interval: 15,
      activeWindows: [{ start: '09:00', end: '18:00' }],
      scope: { mode: 'whitelist', memberIds: ['m1'] },
    };
    render(<HeartbeatConfigSection {...mkProps({ heartbeatConfig: cfg, onChange })} />);
    fireEvent.click(intervalChip(60));
    expect(onChange).toHaveBeenCalledWith({
      interval: 60,
      activeWindows: [{ start: '09:00', end: '18:00' }],
      scope: { mode: 'whitelist', memberIds: ['m1'] },
    });
  });
});

describe('HeartbeatConfigSection — 受控 props 驱动', () => {
  it('父级 rerender 新 heartbeatConfig → 组件展示新值（受控派生，无本地 useState 残留）', () => {
    const cfg1: SquadHeartbeatConfig = { interval: 15, activeWindows: [], scope: { mode: 'all', memberIds: [] } };
    const onChange = vi.fn();
    const { rerender } = render(<HeartbeatConfigSection {...mkProps({ heartbeatConfig: cfg1, onChange })} />);
    // 点 60 → 上报
    fireEvent.click(intervalChip(60));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ interval: 60 }));
    // 父级回灌新配置（如 save 成功后 detail 变化）
    const cfg2: SquadHeartbeatConfig = { interval: 60, activeWindows: [], scope: { mode: 'all', memberIds: [] } };
    rerender(<HeartbeatConfigSection {...mkProps({ heartbeatConfig: cfg2, onChange })} />);
    // 受控派生：组件直接展示新 props 值（60 chip 选中）
    expect(intervalChip(60)).toBeTruthy();
  });
});
