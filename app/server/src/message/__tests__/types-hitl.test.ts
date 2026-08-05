/**
 * [v0.0.101 T1] message/types HITL 类型闭合性 UT（白盒）
 * 参考: specs/tech/version_logs/v0.0.101/change_plan.md 模块 B
 *       reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §1/§11
 *
 * 校验点：
 *   - ToolResultBlock 三态闭合（success/pending/fail）
 *   - status='pending' 携带 subState + data；缺省 status 视 success（向后兼容）
 *   - ToolReplyBlock 加入 ContentBlock 联合（第 6 类）
 *   - FeedbackAnswer / ApprovalDecision 结构
 *   - MessageSender 加第 5 变体 tool_reply
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  ToolResultBlock,
  ToolReplyBlock,
  ContentBlock,
  FeedbackAnswer,
  ApprovalDecision,
  MessageSender,
} from '../types';

describe('ToolResultBlock 三态（v0.0.101 T1）', () => {
  it('status 字段闭合：success | pending | fail', () => {
    type Expected = 'success' | 'pending' | 'fail';
    // status 可选（向后兼容旧数据缺省视 success）；存在时值域闭合三态
    expectTypeOf<ToolResultBlock['status']>().toEqualTypeOf<
      Expected | undefined
    >();
    const all: Array<NonNullable<ToolResultBlock['status']>> = [
      'success',
      'pending',
      'fail',
    ];
    expect(all).toHaveLength(3);
  });

  it('status 缺省合法（向后兼容旧 ToolResultBlock 无此字段）', () => {
    const legacy: ToolResultBlock = {
      type: 'tool_result',
      toolCallId: '01CALL',
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    };
    expect(legacy.status).toBeUndefined();
    expect(legacy.subState).toBeUndefined();
    expect(legacy.data).toBeUndefined();
  });

  it('status=pending 携带 subState + data（FeedbackData）', () => {
    const pending: ToolResultBlock = {
      type: 'tool_result',
      toolCallId: '01CALL',
      content: [{ type: 'text', text: '用户回答中…' }],
      isError: false,
      status: 'pending',
      subState: 'need_feedback',
      data: { questions: [] },
    };
    expect(pending.status).toBe('pending');
    expect(pending.subState).toBe('need_feedback');
    expect(pending.data).toBeDefined();
  });

  it('subState 值域闭合：need_feedback | need_approval', () => {
    type Expected = 'need_feedback' | 'need_approval';
    expectTypeOf<ToolResultBlock['subState']>().toEqualTypeOf<
      Expected | undefined
    >();
  });

  it('status=fail 时 isError=true（约定不变量，类型层不强制但约定）', () => {
    const fail: ToolResultBlock = {
      type: 'tool_result',
      toolCallId: '01CALL',
      content: [{ type: 'text', text: '错误' }],
      isError: true,
      status: 'fail',
    };
    expect(fail.status).toBe('fail');
    expect(fail.isError).toBe(true);
  });
});

describe('ToolReplyBlock 加入 ContentBlock 联合（v0.0.101 T1）', () => {
  it('ContentBlock 联合含 tool_reply（6 类）', () => {
    const reply: ToolReplyBlock = {
      type: 'tool_reply',
      toolCallId: '01CALL',
      handleType: 'direct_result',
      payload: { selections: { q1: ['a'] } },
    };
    // 赋给 ContentBlock 数组合法
    const blocks: ContentBlock[] = [reply];
    expect(blocks[0]?.type).toBe('tool_reply');
  });

  it('handleType 三态闭合：direct_result | approval | callback', () => {
    type Expected = 'direct_result' | 'approval' | 'callback';
    expectTypeOf<ToolReplyBlock['handleType']>().toEqualTypeOf<Expected>();
  });

  it('payload 接收 FeedbackAnswer（direct_result）', () => {
    const r: ToolReplyBlock = {
      type: 'tool_reply',
      toolCallId: '01CALL',
      handleType: 'direct_result',
      payload: { selections: { q1: ['a', '其他：自填'] } },
    };
    expect((r.payload as FeedbackAnswer).selections.q1).toEqual([
      'a',
      '其他：自填',
    ]);
  });

  it('payload 接收 ApprovalDecision（approval）', () => {
    const r: ToolReplyBlock = {
      type: 'tool_reply',
      toolCallId: '01CALL',
      handleType: 'approval',
      payload: { decision: 'deny' },
    };
    expect((r.payload as ApprovalDecision).decision).toBe('deny');
  });
});

describe('FeedbackAnswer / ApprovalDecision（v0.0.101 T1）', () => {
  it('FeedbackAnswer.selections 按 questionId 索引，值含「其他：<text>」格式', () => {
    const ans: FeedbackAnswer = {
      selections: {
        q1: ['a'],
        q2: ['x', 'y', '其他：自填文本'],
      },
    };
    expect(ans.selections.q1).toEqual(['a']);
    expect(ans.selections.q2).toContain('其他：自填文本');
  });

  it('ApprovalDecision.decision 闭合：allow | deny', () => {
    type Expected = 'allow' | 'deny';
    expectTypeOf<ApprovalDecision['decision']>().toEqualTypeOf<Expected>();
    const allow: ApprovalDecision = {
      decision: 'allow',
      modifiedArguments: { command: 'ls -la' },
    };
    expect(allow.decision).toBe('allow');
    expect(allow.modifiedArguments).toBeDefined();
    const deny: ApprovalDecision = { decision: 'deny' };
    expect(deny.decision).toBe('deny');
    expect(deny.modifiedArguments).toBeUndefined();
  });
});

describe('MessageSender 第 5 变体 tool_reply（v0.0.101 T1）', () => {
  it('source=tool_reply 携带 tool_reply.{toolCallId,runId}', () => {
    const sender: MessageSender = {
      source: 'tool_reply',
      tool_reply: { toolCallId: '01CALL', runId: '01RUN' },
    };
    expect(sender.source).toBe('tool_reply');
    if (sender.source === 'tool_reply') {
      // 窄化后类型安全访问
      expect(sender.tool_reply.toolCallId).toBe('01CALL');
      expect(sender.tool_reply.runId).toBe('01RUN');
    }
  });

  it('判别联合窄化：source=tool_reply 不暴露 agent/system/approval 子字段', () => {
    const sender: MessageSender = {
      source: 'tool_reply',
      tool_reply: { toolCallId: 'c', runId: 'r' },
    };
    expect('agent' in sender).toBe(false);
    expect('system' in sender).toBe(false);
    expect('approval' in sender).toBe(false);
  });
});
