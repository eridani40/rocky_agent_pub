/**
 * @vitest-environment jsdom
 * component-group-chat-toggle 单测（v0.0.270 群聊可见性开关：on/off 二态 + switch 点击 → onPatch 上抛）
 * 参考: specs/tech/version_logs/v0.0.270/change_plan.md（ui-autowork GroupChatToggle）
 *       specs/ui/components/studio-page/squad-autonomy-toggle.md（状态/交互契约，仿此模式）
 *
 * 纯本地态（pending + error）+ onPatch 上抛（不 mock squad-api）。无本地态切换（成功靠父级 refresh 回灌）。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { GroupChatToggle } from '../component-group-chat-toggle';

// [v0.0.62 i18n] 启动 i18next：groupChat label/on/off 走 studio.groupChat.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(cleanup);

/** on/off 态文案（语义定位） */
const ON_TEXT = '群聊已开启，SquadChat 对全体成员可见';
const OFF_TEXT = '已关闭群聊，成员仅使用私聊';

describe('GroupChatToggle', () => {
  it('enableGroupChat=false → 渲染 off 态标识（off 文案存在，on 文案不存在）', () => {
    render(<GroupChatToggle squadId="s1" enableGroupChat={false} onPatch={vi.fn()} />);
    expect(screen.getByText('enableGroupChat（群聊可见性）')).toBeTruthy();
    expect(screen.getByText(OFF_TEXT)).toBeTruthy();
    expect(screen.queryByText(ON_TEXT)).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    // hint 说明行（关闭影响面）
    expect(screen.getByText('关闭后 agents 注入无 SquadChat，群聊入口隐藏，成员仅走私聊')).toBeTruthy();
  });

  it('enableGroupChat=true → 渲染 on 态标识', () => {
    render(<GroupChatToggle squadId="s1" enableGroupChat={true} onPatch={vi.fn()} />);
    expect(screen.getByText(ON_TEXT)).toBeTruthy();
    expect(screen.queryByText(OFF_TEXT)).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('data-action-key 锚点 = studio.squad.toggle-group-chat', () => {
    render(<GroupChatToggle squadId="s1" enableGroupChat={true} onPatch={vi.fn()} />);
    expect(screen.getByRole('switch').getAttribute('data-action-key')).toBe('studio.squad.toggle-group-chat');
  });

  it('点 switch → onPatch({ enableGroupChat: !now })（off→true）', async () => {
    const onPatch = vi.fn().mockResolvedValue(undefined);
    render(<GroupChatToggle squadId="s1" enableGroupChat={false} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ enableGroupChat: true }));
  });

  it('onPatch reject → 显示 error banner + toggle 保持原态（无本地态切换）', async () => {
    const onPatch = vi.fn().mockRejectedValue(new Error('网络错误'));
    render(<GroupChatToggle squadId="s1" enableGroupChat={true} onPatch={onPatch} />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByText(/网络错误/)).toBeTruthy());
    // 原态 on 文案仍在（父级未 refresh，enableGroupChat 未变）
    expect(screen.getByText(ON_TEXT)).toBeTruthy();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('pending 期间 disabled（双击竞态防护）', async () => {
    let resolvePatch: (v: unknown) => void = () => {};
    const onPatch = vi.fn().mockImplementation(
      () => new Promise((res) => { resolvePatch = res; }),
    );
    render(<GroupChatToggle squadId="s1" enableGroupChat={false} onPatch={onPatch} />);
    const sw = screen.getByRole('switch');
    fireEvent.click(sw);
    // pending 中 disabled
    expect(sw.hasAttribute('disabled')).toBe(true);
    fireEvent.click(sw); // 第二次点击被 pending 拦截
    expect(onPatch).toHaveBeenCalledTimes(1);
    resolvePatch(undefined);
    await waitFor(() => expect(sw.hasAttribute('disabled')).toBe(false));
  });
});
