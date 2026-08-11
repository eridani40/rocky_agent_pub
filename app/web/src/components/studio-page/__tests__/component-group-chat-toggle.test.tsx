/**
 * @vitest-environment jsdom
 * component-group-chat-toggle 单测（v0.0.316 受控化：enableGroupChat + onChange）
 * 参考: specs/tech/version_logs/v0.0.316/change_plan.md P0
 *
 * v0.0.316: 改为受控组件——无 pending/error 本地态，无 onPatch。
 *   父级 ManageTab 管 draft state + dirty + 统一 save。
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { GroupChatToggle } from '../component-group-chat-toggle';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(cleanup);

/** on/off 态文案（语义定位） */
const ON_TEXT = '群聊已开启，SquadChat 对全体成员可见';
const OFF_TEXT = '已关闭群聊，成员仅使用私聊';

describe('GroupChatToggle（v0.0.316 受控模式）', () => {
  it('enableGroupChat=false → 渲染 off 态标识', () => {
    render(<GroupChatToggle enableGroupChat={false} onChange={vi.fn()} />);
    expect(screen.getByText('enableGroupChat（群聊可见性）')).toBeTruthy();
    expect(screen.getByText(OFF_TEXT)).toBeTruthy();
    expect(screen.queryByText(ON_TEXT)).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('enableGroupChat=true → 渲染 on 态标识', () => {
    render(<GroupChatToggle enableGroupChat={true} onChange={vi.fn()} />);
    expect(screen.getByText(ON_TEXT)).toBeTruthy();
    expect(screen.queryByText(OFF_TEXT)).toBeNull();
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('data-action-key 锚点 = studio.squad.toggle-group-chat', () => {
    render(<GroupChatToggle enableGroupChat={true} onChange={vi.fn()} />);
    expect(screen.getByRole('switch').getAttribute('data-action-key')).toBe('studio.squad.toggle-group-chat');
  });

  it('点 switch → onChange(!now)（off→true）', () => {
    const onChange = vi.fn();
    render(<GroupChatToggle enableGroupChat={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('点 switch → onChange(!now)（on→false）', () => {
    const onChange = vi.fn();
    render(<GroupChatToggle enableGroupChat={true} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('受控模式：不接管本地态——连续点击不自行切换（由父级控制）', () => {
    const onChange = vi.fn();
    render(<GroupChatToggle enableGroupChat={false} onChange={onChange} />);
    const sw = screen.getByRole('switch');
    // 连续点击 3 次——每次都回调 onChange(true)，但 switch 自身不变（仍 off）
    fireEvent.click(sw);
    fireEvent.click(sw);
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith(true);
    // 仍 off（受控——父级没更新 enableGroupChat prop）
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('受控模式：无 error banner（v0.0.316 去掉了 error 本地态）', () => {
    render(<GroupChatToggle enableGroupChat={true} onChange={vi.fn()} />);
    // 不存在 error banner 元素
    expect(screen.queryByText(/error|错误/i)).toBeNull();
  });

  it('受控模式：switch 不再 disabled（无 pending 态）', () => {
    render(<GroupChatToggle enableGroupChat={false} onChange={vi.fn()} />);
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(false);
  });
});
