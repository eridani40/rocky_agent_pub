/**
 * @vitest-environment jsdom
 * component-message-stream sideResolver + on-message spinner 单测
 * 参考: specs/tech/app/frontend/[P0]component_architecture.md §3.6（sideResolver）/ §3.7（on-message spinner）
 *       specs/ui/components/chat-page/_overview.md §4.10（on-message spinner）
 *
 * 覆盖：
 *   - sideResolver 默认（不传）= sideOfMessage（playground 零回归：a2a inbox → assistant 左，user → 右）
 *   - sideResolver 覆盖：caller 传 resolver → 按 resolver 结果定 side（actor 解析不受影响）
 *   - sideOfMessage 导出（独立纯函数测试）
 *   - on-message spinner：runActive=true 显 + phase 正确；runActive=false 隐；sessionRunning 不影响 spinner
 *
 * side 判定锚点：消息行 DOM id=`msg-{messageId}`；user 侧行含 self-end class（右对齐），assistant 侧无。
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ComponentMessageStream, sideOfMessage } from '../component-message-stream';
import type { Message } from '../types';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：内嵌 ComponentLoadingStatus 文案走 chat.loading.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

const userMsg = (id: string, text: string): Message => ({
  id,
  sessionId: 'S1',
  role: 'user',
  content: [{ type: 'text', text }],
  createdAt: '2026-06-29T00:00:00Z',
  sender: { source: 'user' },
});

const assistantMsg = (id: string, text: string): Message => ({
  id,
  sessionId: 'S1',
  role: 'assistant',
  content: [{ type: 'text', text }],
  createdAt: '2026-06-29T00:00:01Z',
});

const a2aInboxMsg = (id: string): Message => ({
  id,
  sessionId: 'S1',
  role: 'user',
  content: [{ type: 'text', text: id + '-a2a' }],
  createdAt: '2026-06-29T00:00:02Z',
  sender: {
    source: 'agent',
    agent: { ref: { type: 'leader', name: 'Alpha', sessionId: 'sx' }, needReply: false },
  },
});

/** 消息行（DOM id=msg-{id}）；user 侧含 self-end，assistant 侧无 */
function getRow(id: string): HTMLElement | null {
  return document.getElementById(`msg-${id}`);
}

describe('sideOfMessage 纯函数（默认逻辑，导出供 caller 复用）', () => {
  it('undefined → assistant（兜底）', () => {
    expect(sideOfMessage(undefined)).toBe('assistant');
  });

  it('role=user + sender.source=user → user（右侧）', () => {
    expect(sideOfMessage(userMsg('u1', 'hi'))).toBe('user');
  });

  it('role=assistant → assistant（左侧）', () => {
    expect(sideOfMessage(assistantMsg('a1', 'r'))).toBe('assistant');
  });

  it('role=user + sender.source=agent（a2a inbox）→ assistant（左侧，默认 a2a→左）', () => {
    expect(sideOfMessage(a2aInboxMsg('a2a1'))).toBe('assistant');
  });
});

describe('sideResolver 默认（不传）= playground 零回归', () => {
  it('不传 sideResolver → a2a inbox 渲染在 assistant 侧（左，无 self-end）', () => {
    render(<ComponentMessageStream messages={[a2aInboxMsg('a2a1')]} />);
    const row = getRow('a2a1');
    expect(row).toBeTruthy();
    // assistant 侧：无 self-end（左对齐）
    expect(row!.className).not.toContain('self-end');
  });

  it('不传 sideResolver → user msg 渲染在 user 侧（右，含 self-end）', () => {
    render(<ComponentMessageStream messages={[userMsg('u1', 'hi')]} />);
    const row = getRow('u1');
    expect(row).toBeTruthy();
    expect(row!.className).toContain('self-end');
  });
});

describe('sideResolver 覆盖（caller 传入 → 按 resolver 定 side）', () => {
  it('单聊 memberSideResolver：a2a inbox → user 侧（右，含 self-end）', () => {
    // 模拟 memberSideResolver：a2a → 'user'，其他 → 默认 sideOfMessage
    const memberSideResolver = (m: Message): 'user' | 'assistant' => {
      if (m.sender?.source === 'agent') return 'user'; // a2a → 右（与 user 同侧）
      return sideOfMessage(m);
    };
    render(<ComponentMessageStream messages={[a2aInboxMsg('a2a1')]} sideResolver={memberSideResolver} />);
    const row = getRow('a2a1');
    expect(row).toBeTruthy();
    expect(row!.className).toContain('self-end');
  });

  it('sideResolver 覆盖：普通 user msg 仍走默认（右）', () => {
    const memberSideResolver = (m: Message): 'user' | 'assistant' =>
      m.sender?.source === 'agent' ? 'user' : sideOfMessage(m);
    render(<ComponentMessageStream messages={[userMsg('u1', 'hi')]} sideResolver={memberSideResolver} />);
    expect(getRow('u1')!.className).toContain('self-end');
  });

  it('sideResolver 覆盖：assistant 自答仍走默认（左）', () => {
    const memberSideResolver = (m: Message): 'user' | 'assistant' =>
      m.sender?.source === 'agent' ? 'user' : sideOfMessage(m);
    render(<ComponentMessageStream messages={[assistantMsg('a1', 'reply')]} sideResolver={memberSideResolver} />);
    expect(getRow('a1')!.className).not.toContain('self-end');
  });
});

describe('on-message spinner（贴流式尾部，替代浮动胶囊）', () => {
  it('runActive=true + loadingPhase=thinking → 渲染 spinner + data-phase=thinking', () => {
    const { container } = render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi')]}
        runActive
        loadingPhase="thinking"
      />,
    );
    const spinner = container.querySelector('[data-phase="thinking"]');
    expect(spinner).toBeTruthy();
    expect(spinner!.textContent).toContain('思考中');
  });

  it('runActive=true + loadingPhase=answering → data-phase=answering', () => {
    const { container } = render(
      <ComponentMessageStream messages={[userMsg('u1', 'hi')]} runActive loadingPhase="answering" />,
    );
    expect(container.querySelector('[data-phase="answering"]')).toBeTruthy();
  });

  it('runActive=true + loadingPhase=null → 兜底 thinking（data-phase=thinking）', () => {
    const { container } = render(<ComponentMessageStream messages={[userMsg('u1', 'hi')]} runActive loadingPhase={null} />);
    // null → 默认 'thinking' 兜底（run 启动后 phase 暂无具体值时）
    expect(container.querySelector('[data-phase="thinking"]')).toBeTruthy();
  });

  it('runActive=false → spinner 不渲染（不入 DOM，不留坑）', () => {
    const { container } = render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi')]}
        runActive={false}
        loadingPhase="thinking"
      />,
    );
    expect(container.querySelector('[data-phase]')).toBeNull();
  });

  it('runActive=true 即使 sessionRunning=false → spinner 仍显（两层分离：run 层 vs session 层）', () => {
    // run 活着但 session 不 running（短暂差异，正常流程）—— spinner 跟 runActive 不跟 sessionRunning
    const { container } = render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi')]}
        runActive
        sessionRunning={false}
        loadingPhase="thinking"
      />,
    );
    expect(container.querySelector('[data-phase]')).toBeTruthy();
  });

  it('runActive=true + tool_calling phase → data-phase=tool_calling', () => {
    const { container } = render(
      <ComponentMessageStream
        messages={[userMsg('u1', 'hi')]}
        runActive
        loadingPhase="tool_calling"
      />,
    );
    const spinner = container.querySelector('[data-phase="tool_calling"]');
    expect(spinner).toBeTruthy();
    expect(spinner!.textContent).toContain('调用工具');
  });
});
