/**
 * @vitest-environment jsdom
 * base-chat-input-bar 单测 —— 输入区骨架（slot 注入 + HITL 分流 + 错误行）
 * 参考: specs/ui/components/chat-page/base-chat-input-bar.md
 *
 * 覆盖：
 * ① composerSlot + buttonRowSlot 渲染到容器对应位置
 * ② pendingToolCall.subState=need_approval → 渲审批卡不渲提问卡
 * ③ pendingToolCall.subState=need_feedback → 渲提问卡不渲审批卡
 * ④ error 非空 → 渲红字错误行
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { BaseChatInputBar } from '../base-chat-input-bar';
import type { PendingToolCallView } from '../types';

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
});

/** 构造 need_approval 态 */
function mkApprovalPending(): PendingToolCallView {
  return {
    sessionId: 's1',
    runId: 'r1',
    toolCallId: 'tc-app',
    toolName: 'bash',
    handleType: 'approval',
    subState: 'need_approval',
    data: { toolName: 'bash', arguments: { command: 'rm -rf /tmp/x' }, reason: '危险命令' },
    resultMessageId: 'm1',
    resultBlockIndex: 0,
    status: 'pending',
  };
}

/** 构造 need_feedback 态 */
function mkFeedbackPending(): PendingToolCallView {
  return {
    sessionId: 's1',
    runId: 'r1',
    toolCallId: 'tc-fb',
    toolName: 'ask-question',
    handleType: 'direct_result',
    subState: 'need_feedback',
    data: {
      prompt: '请选择偏好',
      questions: [{ id: 'q1', title: '选哪个', type: 'single', options: [{ key: 'a', label: 'A' }] }],
    },
    resultMessageId: 'm1',
    resultBlockIndex: 0,
    status: 'pending',
  };
}

describe('BaseChatInputBar（输入区骨架）', () => {
  it('① composerSlot + buttonRowSlot 渲染到容器对应位置', () => {
    render(
      <BaseChatInputBar
        sessionId="s1"
        sessionRunning={false}
        enqueueItems={[]}
        onEnqueueCancel={() => {}}
        composerSlot={<div>COMPOSER_SLOT</div>}
        buttonRowSlot={<div>BUTTON_ROW_SLOT</div>}
      />,
    );
    expect(screen.getByText('COMPOSER_SLOT')).toBeTruthy();
    expect(screen.getByText('BUTTON_ROW_SLOT')).toBeTruthy();
  });

  it('② pendingToolCall.subState=need_approval → 渲审批卡不渲提问卡', () => {
    render(
      <BaseChatInputBar
        sessionId="s1"
        sessionRunning={false}
        enqueueItems={[]}
        onEnqueueCancel={() => {}}
        pendingToolCall={mkApprovalPending()}
        onSubmitReply={vi.fn()}
        composerSlot={<span />}
        buttonRowSlot={<span />}
      />,
    );
    // 审批卡标题存在
    expect(screen.getByText('需要审批')).toBeTruthy();
    // 提问卡 prompt 不存在
    expect(screen.queryByText('请选择偏好')).toBeNull();
  });

  it('③ pendingToolCall.subState=need_feedback → 渲提问卡不渲审批卡', () => {
    render(
      <BaseChatInputBar
        sessionId="s1"
        sessionRunning={false}
        enqueueItems={[]}
        onEnqueueCancel={() => {}}
        pendingToolCall={mkFeedbackPending()}
        onSubmitReply={vi.fn()}
        composerSlot={<span />}
        buttonRowSlot={<span />}
      />,
    );
    // 提问卡 prompt 存在
    expect(screen.getByText('请选择偏好')).toBeTruthy();
    // 审批卡标题不存在
    expect(screen.queryByText('需要审批')).toBeNull();
  });

  it('④ error 非空 → 渲红字错误行（输入区下方）', () => {
    render(
      <BaseChatInputBar
        sessionId="s1"
        sessionRunning={false}
        enqueueItems={[]}
        onEnqueueCancel={() => {}}
        error="send failed: network down"
        composerSlot={<span />}
        buttonRowSlot={<span />}
      />,
    );
    expect(screen.getByText('send failed: network down')).toBeTruthy();
  });
});
