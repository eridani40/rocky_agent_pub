// @vitest-environment jsdom
/**
 * component-pending-approval-card 单测（工具权限系统 前端审批卡）
 * 参考: specs/ui/components/chat-page/component-pending-approval-card.md
 *
 * 覆盖：
 *   - isApprovalData guard 正反例
 *   - 审批卡渲染：need_approval + ApprovalData → command/reason/三按钮全存在
 *   - 防御：need_feedback / data 不是 ApprovalData → 返回 null（不渲染）
 *   - 三按钮点击各触发 onSubmit，payload {decision} 正确
 *   - reason 为空时不渲染 reason 节点
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentPendingApprovalCard } from '../component-pending-approval-card';
import { isApprovalData, isFeedbackData } from '../types';
import { initI18n } from '../../../i18n';
import type { PendingToolCallView } from '../types';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

// ============================================================
// isApprovalData 类型守卫正反例
// ============================================================

describe('isApprovalData 类型守卫', () => {
  it('正例：包含 toolName: string → true', () => {
    expect(isApprovalData({ toolName: 'bash', arguments: { command: 'rm -rf *' } })).toBe(true);
  });

  it('正例：带可选字段 reason/approvalKey → true', () => {
    expect(
      isApprovalData({
        toolName: 'bash',
        arguments: { command: 'rm *' },
        reason: 'rm 通配删除',
        approvalKey: 'bash:rm-wildcard',
      }),
    ).toBe(true);
  });

  it('反例：FeedbackData（有 questions 数组，无 toolName）→ false', () => {
    const feedbackData = { questions: [{ id: 'q1', title: '问题', type: 'single', options: [] }] };
    expect(isApprovalData(feedbackData)).toBe(false);
  });

  it('反例：toolName 不为 string（如数字）→ false', () => {
    expect(isApprovalData({ toolName: 123, arguments: {} })).toBe(false);
  });

  it('反例：空对象 → false', () => {
    expect(isApprovalData({})).toBe(false);
  });

  it('反例：null / undefined → false', () => {
    expect(isApprovalData(null as unknown as Record<string, unknown>)).toBe(false);
    expect(isApprovalData(undefined as unknown as Record<string, unknown>)).toBe(false);
  });

  it('isFeedbackData 与 isApprovalData 互斥（有 questions → FeedbackData，无 toolName → not ApprovalData）', () => {
    const fd = { prompt: '提示', questions: [] };
    expect(isFeedbackData(fd)).toBe(true);
    expect(isApprovalData(fd)).toBe(false);
  });
});

// ============================================================
// 工厂函数
// ============================================================

/** 构造 need_approval pending（ApprovalData，bash 场景） */
function makeApprovalPending(overrides: Partial<PendingToolCallView> = {}): PendingToolCallView {
  return {
    sessionId: 's1',
    runId: 'r1',
    toolCallId: 'tc-approval-1',
    toolName: 'bash',
    handleType: 'approval',
    subState: 'need_approval',
    data: {
      toolName: 'bash',
      arguments: { command: 'rm -rf /tmp/test/*' },
      reason: 'rm 通配删除，需用户批准',
      approvalKey: 'bash:rm-wildcard',
    },
    resultMessageId: 'm1',
    resultBlockIndex: 0,
    status: 'pending',
    ...overrides,
  };
}

// ============================================================
// 渲染契约
// ============================================================

describe('ComponentPendingApprovalCard · 渲染', () => {
  it('need_approval + ApprovalData → 标题/command/reason/三按钮全渲染', () => {
    render(<ComponentPendingApprovalCard pending={makeApprovalPending()} onSubmit={vi.fn()} />);
    // 卡片标题
    expect(screen.getByText('需要审批')).toBeTruthy();
    // command 等宽块
    expect(screen.getByText('rm -rf /tmp/test/*')).toBeTruthy();
    // reason 文本
    expect(screen.getByText('rm 通配删除，需用户批准')).toBeTruthy();
    // 三按钮
    expect(screen.getByRole('button', { name: '同意' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '永远同意' })).toBeTruthy();
  });

  it('reason 为空 → 不渲染 reason 节点', () => {
    const pending = makeApprovalPending();
    pending.data = { toolName: 'bash', arguments: { command: 'rm *' } };
    const { container } = render(<ComponentPendingApprovalCard pending={pending} onSubmit={vi.fn()} />);
    // reason 节点（leading-snug div）不存在
    expect(container.querySelector('div.leading-snug')).toBeNull();
  });

  it('非 bash 工具 → command 展示 JSON.stringify(arguments)', () => {
    const pending = makeApprovalPending();
    pending.data = { toolName: 'other-tool', arguments: { foo: 'bar' }, reason: '测试' };
    render(<ComponentPendingApprovalCard pending={pending} onSubmit={vi.fn()} />);
    expect(screen.getByText(JSON.stringify({ foo: 'bar' }))).toBeTruthy();
  });

  it('无取消按钮（INV-7）', () => {
    const { container } = render(<ComponentPendingApprovalCard pending={makeApprovalPending()} onSubmit={vi.fn()} />);
    // 只有三个 button：allow / deny / allow-always
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(3);
  });
});

// ============================================================
// 防御分支：need_feedback / data 不是 ApprovalData → null
// ============================================================

describe('ComponentPendingApprovalCard · 防御分支', () => {
  it('subState=need_feedback → 返回 null（不渲染）', () => {
    const pending = makeApprovalPending({ subState: 'need_feedback' });
    const { container } = render(<ComponentPendingApprovalCard pending={pending} onSubmit={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('subState=need_approval 但 data 无 toolName → 返回 null（不渲染）', () => {
    const pending = makeApprovalPending();
    // 覆盖 data 为 FeedbackData 形态（无 toolName）
    pending.data = { questions: [{ id: 'q1', title: 'q', type: 'single', options: [] }] } as unknown as typeof pending.data;
    const { container } = render(<ComponentPendingApprovalCard pending={pending} onSubmit={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

// ============================================================
// 三按钮点击 → onSubmit payload
// ============================================================

describe('ComponentPendingApprovalCard · 按钮交互 + onSubmit payload', () => {
  it('点「同意」→ onSubmit(toolCallId, "approval", {decision:"allow"})', () => {
    const onSubmit = vi.fn();
    render(<ComponentPendingApprovalCard pending={makeApprovalPending()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: '同意' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [toolCallId, handleType, payload] = onSubmit.mock.calls[0]!;
    expect(toolCallId).toBe('tc-approval-1');
    expect(handleType).toBe('approval');
    expect(payload).toEqual({ decision: 'allow' });
  });

  it('点「拒绝」→ onSubmit(toolCallId, "approval", {decision:"deny"})', () => {
    const onSubmit = vi.fn();
    render(<ComponentPendingApprovalCard pending={makeApprovalPending()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [toolCallId, handleType, payload] = onSubmit.mock.calls[0]!;
    expect(toolCallId).toBe('tc-approval-1');
    expect(handleType).toBe('approval');
    expect(payload).toEqual({ decision: 'deny' });
  });

  it('点「永远同意」→ onSubmit(toolCallId, "approval", {decision:"allow_always"})', () => {
    const onSubmit = vi.fn();
    render(<ComponentPendingApprovalCard pending={makeApprovalPending()} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: '永远同意' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [toolCallId, handleType, payload] = onSubmit.mock.calls[0]!;
    expect(toolCallId).toBe('tc-approval-1');
    expect(handleType).toBe('approval');
    expect(payload).toEqual({ decision: 'allow_always' });
  });

  it('三按钮点击各触发独立 onSubmit（互不干扰）', () => {
    const allow = vi.fn();
    const deny = vi.fn();
    const always = vi.fn();

    render(<ComponentPendingApprovalCard pending={makeApprovalPending()} onSubmit={allow} />);
    fireEvent.click(screen.getByRole('button', { name: '同意' }));
    expect(allow).toHaveBeenCalledTimes(1);

    cleanup();
    render(<ComponentPendingApprovalCard pending={makeApprovalPending()} onSubmit={deny} />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(deny).toHaveBeenCalledTimes(1);

    cleanup();
    render(<ComponentPendingApprovalCard pending={makeApprovalPending()} onSubmit={always} />);
    fireEvent.click(screen.getByRole('button', { name: '永远同意' }));
    expect(always).toHaveBeenCalledTimes(1);
  });
});
