/**
 * @vitest-environment jsdom
 * component-chat-session-input 单测（v0.0.245 中断体验优化）
 * 参考: specs/prd/version_logs/v0.0.245.interrupt_exp/prd.md §3.1 §3.2 §3.3
 *       specs/tech/version_logs/v0.0.245/change_plan.md（焦点门控 4 分支 + handleInterrupt 顺序）
 *
 * 覆盖：
 *   - ESC window capture-phase listener 焦点门控 4 分支
 *     · !isFocused → noop（不 preventDefault 不 handleInterrupt）
 *     · isPopoverOpen → noop（让 composer 关 popover）
 *     · pendingToolCall → noop
 *     · sessionRunning → preventDefault + handleInterrupt
 *   - handleInterrupt 步骤顺序：snapshot → forEach cancel-all → applyInterrupt 注入 → onAbort
 *   - 红钮 onAbort → handleInterrupt（UC-A4 语义统一）
 *   - capture phase 注册（第三参 true）+ cleanup removeEventListener
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { forwardRef, useImperativeHandle } from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';

// —— vi.hoisted：绝对路径 mock + 可变 composer 句柄状态 —— //
const {
  composerPath,
  baseInputPath,
  modelPickerPath,
  effortPickerPath,
  approvalPickerPath,
  runStateBarPath,
  iconsPath,
  composerState,
} = vi.hoisted(() => ({
  composerPath: require('node:path').resolve(__dirname, '../component-chat-composer'),
  baseInputPath: require('node:path').resolve(__dirname, '../base-chat-input-bar'),
  modelPickerPath: require('node:path').resolve(__dirname, '../component-input-model-picker'),
  effortPickerPath: require('node:path').resolve(__dirname, '../component-input-effort-picker'),
  approvalPickerPath: require('node:path').resolve(__dirname, '../component-input-approval-mode-picker'),
  runStateBarPath: require('node:path').resolve(__dirname, '../component-run-state-bar'),
  iconsPath: require('node:path').resolve(__dirname, '../icons'),
  // 测试可改的 composer 句柄状态
  composerState: {
    focused: true,
    popoverOpen: false,
    applyCalls: [] as Array<{ content: string }[]>,
  },
}));

// 桩 ChatComposer：forwardRef 暴露可控行柄（isFocused/isPopoverOpen/applyInterrupt）
vi.mock(composerPath, () => ({
  ChatComposer: forwardRef((_props: unknown, ref: React.Ref<unknown>) => {
    useImperativeHandle(
      ref,
      () => ({
        send: () => {},
        isFocused: () => composerState.focused,
        isPopoverOpen: () => composerState.popoverOpen,
        applyInterrupt: (items: { content: string }[]) => {
          composerState.applyCalls.push(items);
        },
      }),
      [],
    );
    return null;
  }),
}));

// 桩 BaseChatInputBar：直接渲染两个 slot
vi.mock(baseInputPath, () => ({
  BaseChatInputBar: ({ composerSlot, buttonRowSlot }: { composerSlot: React.ReactNode; buttonRowSlot: React.ReactNode }) => (
    <div>
      <div data-testid="composer-slot">{composerSlot}</div>
      <div data-testid="button-row-slot">{buttonRowSlot}</div>
    </div>
  ),
}));

// 桩 pickers（避免引入重逻辑）
vi.mock(modelPickerPath, () => ({
  InputModelPicker: () => <div data-testid="model-picker" />,
}));
vi.mock(effortPickerPath, () => ({
  InputEffortPicker: () => <div data-testid="effort-picker" />,
}));
vi.mock(approvalPickerPath, () => ({
  InputApprovalModePicker: () => <div data-testid="approval-picker" />,
}));
// 桩 ComponentRunStateAbortSlot：渲染按钮调 onAbort（模拟红钮点击）
vi.mock(runStateBarPath, () => ({
  ComponentRunStateAbortSlot: ({ onAbort }: { onAbort: (sessionId: string) => void }) => (
    <button data-testid="abort-slot-btn" onClick={() => onAbort('s1')}>
      abort
    </button>
  ),
}));
vi.mock(iconsPath, () => ({ SendIcon: () => <svg /> }));

import { ComponentChatSessionInput } from '../component-chat-session-input';
import type { SessionChromeView } from '../../../lib/chat-api';

/** chrome 夹具（capabilities 全开） */
function mkChrome(over: Partial<SessionChromeView> = {}): SessionChromeView {
  return {
    sessionId: 's1',
    kind: 'playground',
    readOnly: false,
    title: 't',
    titled: true,
    tag: '',
    sessionModel: null,
    defaultModel: null,
    effort: null,
    approvalMode: null,
    members: [],
    memberId: null,
    capabilities: {
      runState: true,
      hitl: true,
      enqueue: true,
      effortPicker: true,
      approvalPicker: true,
      usage: true,
      compact: true,
      clear: true,
      minimap: true,
      floatMenu: true,
      cron: true,
      groupRender: false,
    },
    ...over,
  };
}

/** 派发 window keydown（capture + bubble 两阶段，模拟真实事件传播） */
function dispatchESC(): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  composerState.focused = true;
  composerState.popoverOpen = false;
  composerState.applyCalls = [];
});

afterEach(() => cleanup());

describe('ESC window capture listener 焦点门控 4 分支', () => {
  it('sessionRunning + isFocused + 无 popover/HITL → preventDefault + handleInterrupt', () => {
    const onEnqueueCancel = vi.fn();
    const onAbort = vi.fn();
    render(
      <ComponentChatSessionInput
        sessionId="s1"
        chrome={mkChrome()}
        sessionRunning={true}
        sessionState="running"
        enqueueItems={[{ enqueueId: 'eq1', content: '排队1' }]}
        pendingToolCall={null}
        onSubmitReply={vi.fn()}
        onEnqueueCancel={onEnqueueCancel}
        onSend={vi.fn()}
        onAbort={onAbort}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onApprovalModeChange={vi.fn()}
        sendError={null}
      />,
    );
    const ev = dispatchESC();
    expect(ev.defaultPrevented).toBe(true);
    expect(onEnqueueCancel).toHaveBeenCalledWith('eq1');
    expect(composerState.applyCalls).toEqual([[{ content: '排队1' }]]);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('!isFocused → noop（不 preventDefault 不 handleInterrupt）', () => {
    composerState.focused = false;
    const onEnqueueCancel = vi.fn();
    const onAbort = vi.fn();
    render(
      <ComponentChatSessionInput
        sessionId="s1"
        chrome={mkChrome()}
        sessionRunning={true}
        sessionState="running"
        enqueueItems={[{ enqueueId: 'eq1', content: '排队1' }]}
        pendingToolCall={null}
        onSubmitReply={vi.fn()}
        onEnqueueCancel={onEnqueueCancel}
        onSend={vi.fn()}
        onAbort={onAbort}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onApprovalModeChange={vi.fn()}
        sendError={null}
      />,
    );
    const ev = dispatchESC();
    expect(ev.defaultPrevented).toBe(false);
    expect(onEnqueueCancel).not.toHaveBeenCalled();
    expect(composerState.applyCalls).toEqual([]);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('isPopoverOpen → noop（让 composer 自管关 popover）', () => {
    composerState.popoverOpen = true;
    const onAbort = vi.fn();
    render(
      <ComponentChatSessionInput
        sessionId="s1"
        chrome={mkChrome()}
        sessionRunning={true}
        sessionState="running"
        enqueueItems={[{ enqueueId: 'eq1', content: '排队1' }]}
        pendingToolCall={null}
        onSubmitReply={vi.fn()}
        onEnqueueCancel={vi.fn()}
        onSend={vi.fn()}
        onAbort={onAbort}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onApprovalModeChange={vi.fn()}
        sendError={null}
      />,
    );
    const ev = dispatchESC();
    expect(ev.defaultPrevented).toBe(false);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('pendingToolCall 非 null → noop（HITL 自管，不中断）', () => {
    const onAbort = vi.fn();
    render(
      <ComponentChatSessionInput
        sessionId="s1"
        chrome={mkChrome()}
        sessionRunning={true}
        sessionState="running"
        enqueueItems={[{ enqueueId: 'eq1', content: '排队1' }]}
        pendingToolCall={{ id: 'tc1', toolName: 'bash', status: 'pending' } as never}
        onSubmitReply={vi.fn()}
        onEnqueueCancel={vi.fn()}
        onSend={vi.fn()}
        onAbort={onAbort}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onApprovalModeChange={vi.fn()}
        sendError={null}
      />,
    );
    const ev = dispatchESC();
    expect(ev.defaultPrevented).toBe(false);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('非 running → 不中断（即使 isFocused）', () => {
    const onAbort = vi.fn();
    render(
      <ComponentChatSessionInput
        sessionId="s1"
        chrome={mkChrome()}
        sessionRunning={false}
        sessionState="idle"
        enqueueItems={[]}
        pendingToolCall={null}
        onSubmitReply={vi.fn()}
        onEnqueueCancel={vi.fn()}
        onSend={vi.fn()}
        onAbort={onAbort}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onApprovalModeChange={vi.fn()}
        sendError={null}
      />,
    );
    const ev = dispatchESC();
    expect(ev.defaultPrevented).toBe(false);
    expect(onAbort).not.toHaveBeenCalled();
  });

  it('非 Escape 键 → 不触发', () => {
    const onAbort = vi.fn();
    render(
      <ComponentChatSessionInput
        sessionId="s1"
        chrome={mkChrome()}
        sessionRunning={true}
        sessionState="running"
        enqueueItems={[]}
        pendingToolCall={null}
        onSubmitReply={vi.fn()}
        onEnqueueCancel={vi.fn()}
        onSend={vi.fn()}
        onAbort={onAbort}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onApprovalModeChange={vi.fn()}
        sendError={null}
      />,
    );
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(onAbort).not.toHaveBeenCalled();
  });
});

describe('handleInterrupt 步骤顺序（snapshot → cancel-all → applyInterrupt → onAbort）', () => {
  it('多条 enqueueItems 全部 cancel（snapshot 入参前，逐条 cancelEnqueue）', () => {
    const onEnqueueCancel = vi.fn();
    render(
      <ComponentChatSessionInput
        sessionId="s1"
        chrome={mkChrome()}
        sessionRunning={true}
        sessionState="running"
        enqueueItems={[
          { enqueueId: 'eq1', content: '排队1' },
          { enqueueId: 'eq2', content: '排队2' },
        ]}
        pendingToolCall={null}
        onSubmitReply={vi.fn()}
        onEnqueueCancel={onEnqueueCancel}
        onSend={vi.fn()}
        onAbort={vi.fn()}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onApprovalModeChange={vi.fn()}
        sendError={null}
      />,
    );
    dispatchESC();
    expect(onEnqueueCancel).toHaveBeenCalledTimes(2);
    expect(onEnqueueCancel).toHaveBeenNthCalledWith(1, 'eq1');
    expect(onEnqueueCancel).toHaveBeenNthCalledWith(2, 'eq2');
    // applyInterrupt 收到 items.map(content)（snapshot 全条 content）
    expect(composerState.applyCalls).toEqual([
      [{ content: '排队1' }, { content: '排队2' }],
    ]);
  });

  it('无排队（enqueueItems=[]）→ 不 cancel，applyInterrupt 收空数组，仍 onAbort（UC-F3）', () => {
    const onEnqueueCancel = vi.fn();
    const onAbort = vi.fn();
    render(
      <ComponentChatSessionInput
        sessionId="s1"
        chrome={mkChrome()}
        sessionRunning={true}
        sessionState="running"
        enqueueItems={[]}
        pendingToolCall={null}
        onSubmitReply={vi.fn()}
        onEnqueueCancel={onEnqueueCancel}
        onSend={vi.fn()}
        onAbort={onAbort}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onApprovalModeChange={vi.fn()}
        sendError={null}
      />,
    );
    dispatchESC();
    expect(onEnqueueCancel).not.toHaveBeenCalled();
    expect(composerState.applyCalls).toEqual([[]]);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});

describe('红钮 onAbort → handleInterrupt（UC-A4 语义统一）', () => {
  it('点红钮触发 handleInterrupt（与 ESC 同 handler）', () => {
    const onEnqueueCancel = vi.fn();
    const onAbort = vi.fn();
    render(
      <ComponentChatSessionInput
        sessionId="s1"
        chrome={mkChrome()}
        sessionRunning={true}
        sessionState="running"
        enqueueItems={[{ enqueueId: 'eq1', content: '排队1' }]}
        pendingToolCall={null}
        onSubmitReply={vi.fn()}
        onEnqueueCancel={onEnqueueCancel}
        onSend={vi.fn()}
        onAbort={onAbort}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onApprovalModeChange={vi.fn()}
        sendError={null}
      />,
    );
    // 红钮 slot 桩渲染为 button，点击触发 onAbort(s1) → handleInterrupt
    const btn = document.querySelector('[data-testid="abort-slot-btn"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    // 验证走的是 handleInterrupt（cancel + applyInterrupt + onAbort 都触发）
    expect(onEnqueueCancel).toHaveBeenCalledWith('eq1');
    expect(composerState.applyCalls).toEqual([[{ content: '排队1' }]]);
    expect(onAbort).toHaveBeenCalledTimes(1);
  });
});

describe('cleanup：unmount 后 ESC listener 移除', () => {
  it('unmount 后再 dispatch ESC → 不触发 onAbort（cleanup removeEventListener）', () => {
    const onAbort = vi.fn();
    const { unmount } = render(
      <ComponentChatSessionInput
        sessionId="s1"
        chrome={mkChrome()}
        sessionRunning={true}
        sessionState="running"
        enqueueItems={[]}
        pendingToolCall={null}
        onSubmitReply={vi.fn()}
        onEnqueueCancel={vi.fn()}
        onSend={vi.fn()}
        onAbort={onAbort}
        onModelChange={vi.fn()}
        onEffortChange={vi.fn()}
        onApprovalModeChange={vi.fn()}
        sendError={null}
      />,
    );
    unmount();
    dispatchESC();
    expect(onAbort).not.toHaveBeenCalled();
  });
});
