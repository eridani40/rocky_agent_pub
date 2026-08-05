/**
 * @vitest-environment jsdom
 * component-squad-autonomy-toggle 单测（v0.0.33.4 killswitch：on/off 二态 + switch 点击 → onPatch 上抛）
 * 参考: specs/ui/components/studio-page/squad-autonomy-toggle.md（状态/交互契约）
 *
 * 纯本地态（pending + error）+ onPatch 上抛（不 mock squad-api）。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
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

describe('SquadAutonomyToggle', () => {
  it('enableHeartBeat=false → 渲染 off 态标识（off 文案存在，on 文案不存在）', () => {
    render(<SquadAutonomyToggle squadId="s1" enableHeartBeat={false} onPatch={vi.fn()} />);
    expect(screen.getByText('enableHeartBeat（自主性总开关）')).toBeTruthy();
    expect(screen.getByText(OFF_TEXT)).toBeTruthy();
    expect(screen.queryByText(ON_TEXT)).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('enableHeartBeat=true → 渲染 on 态标识', () => {
    render(<SquadAutonomyToggle squadId="s1" enableHeartBeat={true} onPatch={vi.fn()} />);
    expect(screen.getByText(ON_TEXT)).toBeTruthy();
    expect(screen.queryByText(OFF_TEXT)).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('点 switch → onPatch({ enableHeartBeat: !now })（off→true）', async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    render(<SquadAutonomyToggle squadId="s1" enableHeartBeat={false} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ enableHeartBeat: true }));
  });

  it('onPatch reject → 显示 error banner', async () => {
    const onPatch = vi.fn().mockRejectedValue(new Error('网络错误'));
    render(<SquadAutonomyToggle squadId="s1" enableHeartBeat={true} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByText(/网络错误/)).toBeTruthy());
  });
});
