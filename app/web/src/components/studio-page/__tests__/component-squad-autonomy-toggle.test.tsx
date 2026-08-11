/**
 * @vitest-environment jsdom
 * component-squad-autonomy-toggle 单测（v0.0.316 P1 受控化：on/off 二态 + switch 点击 → onChange 上报）
 * 参考: specs/ui/components/studio-page/squad-autonomy-toggle.md（状态/交互契约）
 *       specs/tech/version_logs/v0.0.316/change_plan.md P1（受控模式：去掉 squadId/onPatch/error/pending）
 *
 * [v0.0.316] 受控模式：不再自管 PATCH/pending/error；纯上报 onChange(!enableHeartBeat)。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { SquadAutonomyToggle } from '../component-squad-autonomy-toggle';

// [v0.0.62 i18n] 启动 i18next：autonomy label/on/off 走 studio.autonomy.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(cleanup);

/** on/off 态文案（语义定位，替代旧 testid） */
const ON_TEXT = '自主工作已开启，成员将按心跳节奏主动运转';
const OFF_TEXT = '已暂停自主工作，成员仅响应对话';

describe('SquadAutonomyToggle（v0.0.316 受控模式）', () => {
  it('enableHeartBeat=false → 渲染 off 态标识（off 文案存在，on 文案不存在）', () => {
    render(<SquadAutonomyToggle enableHeartBeat={false} onChange={vi.fn()} />);
    expect(screen.getByText('enableHeartBeat（自主性总开关）')).toBeTruthy();
    expect(screen.getByText(OFF_TEXT)).toBeTruthy();
    expect(screen.queryByText(ON_TEXT)).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('enableHeartBeat=true → 渲染 on 态标识', () => {
    render(<SquadAutonomyToggle enableHeartBeat={true} onChange={vi.fn()} />);
    expect(screen.getByText(ON_TEXT)).toBeTruthy();
    expect(screen.queryByText(OFF_TEXT)).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('点 switch（off 态）→ onChange(true)（受控上报，不再 onPatch PATCH）', () => {
    const onChange = vi.fn();
    render(<SquadAutonomyToggle enableHeartBeat={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    // 受控：同步上报 onChange（非 async onPatch）
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('点 switch（on 态）→ onChange(false)', () => {
    const onChange = vi.fn();
    render(<SquadAutonomyToggle enableHeartBeat={true} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('受控模式无 error banner（自管 error 已去掉，保存失败由 tab 级统一处理）', () => {
    // 受控组件无 error state：即便 onChange 抛错也不渲染 error banner（父级统一处理）
    render(<SquadAutonomyToggle enableHeartBeat={true} onChange={vi.fn()} />);
    // 无 error 文案节点（v0.0.316 去掉 error banner JSX）
    expect(screen.queryByText(/失败|错误/)).toBeNull();
  });
});
