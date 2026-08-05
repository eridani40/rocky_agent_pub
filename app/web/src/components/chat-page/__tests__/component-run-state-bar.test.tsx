// @vitest-environment jsdom
/**
 * ComponentRunStateBar + ComponentRunStateAbortSlot 单测
 * 参考: specs/tech/app/frontend/[P0]component_architecture.md §3.5（组装层）/ §3.7（两层状态 UI）
 *       specs/ui/components/chat-page/_overview.md §4.11a（enqueue 排队区）/ §4.11b（abort 按钮）
 *
 * 覆盖：
 *   - enqueue 排队区按 sessionRunning + items 显隐；showEnqueue=false（readOnly）时即便 running+items 也不渲染
 *   - enqueue cancel 回调透传（onEnqueueCancel 收到 enqueueId）
 *   - abort slot 统一判断：sessionRunning && sessionId 才渲染；sessionState 透传到 abort-btn；点击回调带 sessionId
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentRunStateBar, ComponentRunStateAbortSlot } from '../component-run-state-bar';
import type { EnqueueItem } from '../types';

afterEach(() => cleanup());

const oneItem: EnqueueItem[] = [{ enqueueId: 'eq1', content: '排队消息' }];

describe('ComponentRunStateBar — enqueue 排队区（§4.11a）', () => {
  it('sessionRunning=true 且 items 非空 → 渲染排队区', () => {
    render(<ComponentRunStateBar sessionRunning enqueueItems={oneItem} />);
    // i18n 未初始化 → raw key 渲染
    expect(screen.getByText('enqueue.queueHint')).toBeTruthy();
    expect(screen.getByText('排队消息')).toBeTruthy();
  });

  it('sessionRunning=false → 不渲染排队区（即使 items 非空）', () => {
    render(<ComponentRunStateBar sessionRunning={false} enqueueItems={oneItem} />);
    expect(screen.queryByText('enqueue.queueHint')).toBeNull();
  });

  it('items 为空 → 不渲染排队区（即使 running）', () => {
    render(<ComponentRunStateBar sessionRunning enqueueItems={[]} />);
    expect(screen.queryByText('enqueue.queueHint')).toBeNull();
  });

  it('showEnqueue=false（readOnly mode）→ 即便 running+items 也不渲染排队区', () => {
    render(
      <ComponentRunStateBar
        sessionRunning
        enqueueItems={oneItem}
        showEnqueue={false}
      />,
    );
    expect(screen.queryByText('enqueue.queueHint')).toBeNull();
  });

  it('点排队项 cancel → onEnqueueCancel 收到 enqueueId', () => {
    let canceled = '';
    render(
      <ComponentRunStateBar
        sessionRunning
        enqueueItems={oneItem}
        onEnqueueCancel={(id) => (canceled = id)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'enqueue.dequeue' }));
    expect(canceled).toBe('eq1');
  });
});

describe('ComponentRunStateAbortSlot — 停止按钮判断收拢（§4.11b / sessionState 透传）', () => {
  it('sessionRunning=true 且 sessionId 非空 → 渲染 abort 按钮', () => {
    render(<ComponentRunStateAbortSlot sessionRunning sessionId="s1" onAbort={() => {}} />);
    expect(screen.getByRole('button', { name: 'abort.ariaLabel' })).toBeTruthy();
  });

  // 槽位始终预留：idle/无 session 时渲 invisible 占位（visibility:hidden 保 21px
  //   排版空间），picker/send/stop 三按钮位置固定不随 stop 显隐位移。真实 stop 按钮仍只在 running 时存在。
  it('sessionRunning=false → 真实 stop 按钮不渲（占位 invisible 保 slot）', () => {
    const { container } = render(
      <ComponentRunStateAbortSlot sessionRunning={false} sessionId="s1" onAbort={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: 'abort.ariaLabel' })).toBeNull();
    const ph = container.querySelector('span.invisible');
    expect(ph).toBeTruthy();
    expect(ph?.className).toContain('invisible');
  });

  it('sessionId=null → 真实 stop 按钮不渲（占位 invisible 保 slot，即便 running）', () => {
    const { container } = render(
      <ComponentRunStateAbortSlot sessionRunning sessionId={null} onAbort={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: 'abort.ariaLabel' })).toBeNull();
    const ph = container.querySelector('span.invisible');
    expect(ph).toBeTruthy();
    expect(ph?.className).toContain('invisible');
  });

  it('不传 sessionState → 默认 running（data-session-state=running）', () => {
    render(<ComponentRunStateAbortSlot sessionRunning sessionId="s1" onAbort={() => {}} />);
    const btn = screen.getByRole('button', { name: 'abort.ariaLabel' });
    expect(btn.getAttribute('data-session-state')).toBe('running');
  });

  it('sessionState=interrupting → data-session-state=interrupting（圆环减速）', () => {
    render(
      <ComponentRunStateAbortSlot
        sessionRunning
        sessionId="s1"
        sessionState="interrupting"
        onAbort={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: 'abort.ariaLabel' });
    expect(btn.getAttribute('data-session-state')).toBe('interrupting');
  });

  it('点击 → onAbort 收到 sessionId', () => {
    let aborted = '';
    render(<ComponentRunStateAbortSlot sessionRunning sessionId="s9" onAbort={(sid) => (aborted = sid)} />);
    fireEvent.click(screen.getByRole('button', { name: 'abort.ariaLabel' }));
    expect(aborted).toBe('s9');
  });
});
