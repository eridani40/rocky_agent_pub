/**
 * @vitest-environment jsdom
 * base-chat-page 单测 —— chat 主区骨架（slot 注入 + loading 门控 + clear modal）
 * 参考: specs/ui/components/chat-page/base-chat-page.md
 *       specs/tech/version_logs/v0.0.155/change_plan.md 段 E（INV-E1 只含骨架）
 *
 * 覆盖：
 * ① loading=true → 渲 loading 占位（不 mount topbar/messages/input slot）
 * ② loading=false → 渲 topbar + messages + input slot
 * ③ rootTag='main' → 根元素为 <main>（studio 兼容）
 * ④ hideInputBar=true → inputSlot 不渲
 * ⑤ clear modal：clearModalOpen=true → modal 出现；点确认清空 → onClear 调用 + onClearModalChange(false)
 * ⑥ slot 透传：topbarLeft/topbarRight/messagesSlot/rightOverlaySlot/inputSlot 均渲染
 *
 * 说明：骨架 slot 本身无文案/role，测试通过向 slot 注入带文案的占位节点，
 *       再用文案定位，验证 slot 是否挂载到正确位置（不依赖 testid）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { BaseChatPage } from '../base-chat-page';

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
});

describe('BaseChatPage（chat 主区骨架）', () => {
  it('① loading=true → 渲 loading 占位（不 mount slot）', () => {
    render(
      <BaseChatPage
        sessionId="s1"
        loading={true}
        messagesSlot={<div>MSGS</div>}
      />,
    );
    // loading 占位文案（…）渲染，messages slot 不挂载
    expect(screen.getByText('…')).toBeTruthy();
    expect(screen.queryByText('MSGS')).toBeNull();
  });

  it('② loading=false → 渲 topbar + messages slot + input slot', () => {
    render(
      <BaseChatPage
        sessionId="s1"
        loading={false}
        topbarLeft={<div>TL</div>}
        topbarRight={<div>TR</div>}
        messagesSlot={<div>MSGS</div>}
        inputSlot={<div>INPUT</div>}
      />,
    );
    // 根元素为 section（playground 默认）
    expect(document.querySelector('section.flex-1')).toBeTruthy();
    expect(screen.getByText('TL')).toBeTruthy();
    expect(screen.getByText('TR')).toBeTruthy();
    expect(screen.getByText('MSGS')).toBeTruthy();
    expect(screen.getByText('INPUT')).toBeTruthy();
  });

  it('③ rootTag="main" → 根元素为 main（studio 兼容）', () => {
    render(
      <BaseChatPage
        sessionId="s1"
        rootTag="main"
        fadeIn
        messagesSlot={<div>MSGS</div>}
      />,
    );
    const root = document.querySelector('main');
    expect(root).toBeTruthy();
    expect(root!.tagName).toBe('MAIN');
    // 严肃基调：无 @keyframes / 无 animate-* class（INV-3）
    expect(root!.className).not.toContain('animate-[');
    expect(root!.className).toContain('flex-1');
    // 不再渲染 section 根
    expect(document.querySelector('section.flex-1')).toBeNull();
  });

  it('④ hideInputBar=true → inputSlot 不渲（playground idle/subagent readOnly 分支用）', () => {
    render(
      <BaseChatPage
        sessionId="s1"
        hideInputBar
        messagesSlot={<div>MSGS</div>}
        inputSlot={<div>INPUT</div>}
      />,
    );
    expect(screen.getByText('MSGS')).toBeTruthy();
    expect(screen.queryByText('INPUT')).toBeNull();
  });

  it('⑤ clear modal：clearModalOpen=true → modal 出现；点确认清空 → onClear + onClearModalChange(false)', () => {
    const onClear = vi.fn();
    const onClearModalChange = vi.fn();
    render(
      <BaseChatPage
        sessionId="s1"
        messagesSlot={<div>MSGS</div>}
        onClear={onClear}
        clearModalOpen={true}
        onClearModalChange={onClearModalChange}
      />,
    );
    expect(screen.getByText('清空会话')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onClearModalChange).toHaveBeenCalledWith(false);
  });

  it('⑥ rightOverlaySlot 透传：渲染到 messages wrapper 内', () => {
    render(
      <BaseChatPage
        sessionId="s1"
        messagesSlot={<div>MSGS</div>}
        rightOverlaySlot={<div>OVERLAY</div>}
      />,
    );
    const overlay = screen.getByText('OVERLAY');
    expect(overlay).toBeTruthy();
    // overlay 与 messages 同处 messages wrapper（flex-1 relative 容器）
    const messages = screen.getByText('MSGS');
    expect(overlay.closest('.relative')).toBe(messages.closest('.relative'));
  });
});
