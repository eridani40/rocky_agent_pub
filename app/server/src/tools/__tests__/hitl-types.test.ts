/**
 * [v0.0.101 T1] HITL 载荷类型闭合性 UT（白盒）
 * 参考: specs/tech/version_logs/v0.0.101/change_plan.md 模块 A
 *       reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §4/§5
 *
 * 校验点：
 *   - PendingToolCall 字段集完整（10 字段全在）
 *   - PendingToolCall.subState / ToolInteraction.subType 值域闭合
 *   - handleType 三态闭合（direct_result/approval/callback）
 *   - FeedbackData / Question / ApprovalData 结构契约
 *   - status 字段闭合（pending/resolved）
 *   - TS 编译时类型安全（expectTypeOf）
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  PendingToolCall,
  ToolInteraction,
  ToolHandleType,
  FeedbackData,
  Question,
  ApprovalData,
} from '../types';

/** 构造合法 FeedbackData fixture */
function feedbackData(): FeedbackData {
  return {
    prompt: '请选择',
    questions: [
      {
        id: 'q1',
        title: '问题 1',
        type: 'single',
        options: [
          { key: 'a', label: '选项 A' },
          { key: 'b', label: '选项 B' },
        ],
        allowOther: true,
      },
    ],
  };
}

describe('PendingToolCall 字段集（v0.0.101 T1）', () => {
  it('完整 10 字段：sessionId/runId/toolCallId/toolName/handleType/subState/data/resultMessageId/resultBlockIndex/status', () => {
    const p: PendingToolCall = {
      sessionId: '01SESSION',
      runId: '01RUN',
      toolCallId: '01CALL',
      toolName: 'ask-question',
      handleType: 'direct_result',
      subState: 'need_feedback',
      data: feedbackData(),
      resultMessageId: '01MSG',
      resultBlockIndex: 2,
      status: 'pending',
    };
    expect(p.sessionId).toBe('01SESSION');
    expect(p.runId).toBe('01RUN');
    expect(p.toolCallId).toBe('01CALL');
    expect(p.toolName).toBe('ask-question');
    expect(p.handleType).toBe('direct_result');
    expect(p.subState).toBe('need_feedback');
    expect(p.data).toBeDefined();
    expect(p.resultMessageId).toBe('01MSG');
    expect(p.resultBlockIndex).toBe(2);
    expect(p.status).toBe('pending');
  });

  it('resultMessageId / resultBlockIndex 可选（engine 不填，caller 回填）', () => {
    const p: PendingToolCall = {
      sessionId: '01SESSION',
      runId: '01RUN',
      toolCallId: '01CALL',
      toolName: 'ask-question',
      handleType: 'direct_result',
      subState: 'need_feedback',
      data: feedbackData(),
      status: 'pending',
    };
    expect(p.resultMessageId).toBeUndefined();
    expect(p.resultBlockIndex).toBeUndefined();
  });

  it('subState 值域闭合：need_feedback | need_approval', () => {
    const states: Array<PendingToolCall['subState']> = [
      'need_feedback',
      'need_approval',
    ];
    expect(states).toHaveLength(2);
    // 编译时闭合：非 'need_*' 字面量不可赋值
    type Expected = 'need_feedback' | 'need_approval';
    expectTypeOf<PendingToolCall['subState']>().toEqualTypeOf<Expected>();
  });

  it('status 值域闭合：pending | resolved', () => {
    const all: Array<PendingToolCall['status']> = ['pending', 'resolved'];
    expect(all).toHaveLength(2);
    type Expected = 'pending' | 'resolved';
    expectTypeOf<PendingToolCall['status']>().toEqualTypeOf<Expected>();
  });

  it('handleType 三态闭合：direct_result | approval | callback', () => {
    const all: ToolHandleType[] = ['direct_result', 'approval', 'callback'];
    expect(all).toHaveLength(3);
    type Expected = 'direct_result' | 'approval' | 'callback';
    expectTypeOf<ToolHandleType>().toEqualTypeOf<Expected>();
  });
});

describe('ToolInteraction（v0.0.101 T1）', () => {
  it('完整结构：subType/handleType/data', () => {
    const i: ToolInteraction = {
      subType: 'need_feedback',
      handleType: 'direct_result',
      data: feedbackData(),
    };
    expect(i.subType).toBe('need_feedback');
    expect(i.handleType).toBe('direct_result');
    expect(i.data).toBeDefined();
  });

  it('subType 值域闭合（与 PendingToolCall.subState 值域相同）', () => {
    type Expected = 'need_feedback' | 'need_approval';
    expectTypeOf<ToolInteraction['subType']>().toEqualTypeOf<Expected>();
    // 值域与 PendingToolCall.subState 相同（命名不同是契约锁定）
    expectTypeOf<ToolInteraction['subType']>().toEqualTypeOf<
      PendingToolCall['subState']
    >();
  });

  it('data 接收 ApprovalData（need_approval 分支）', () => {
    const approval: ApprovalData = {
      toolName: 'bash',
      arguments: { command: 'rm -rf /' },
    };
    const i: ToolInteraction = {
      subType: 'need_approval',
      handleType: 'approval',
      data: approval,
    };
    expect((i.data as ApprovalData).toolName).toBe('bash');
  });
});

describe('FeedbackData / Question / ApprovalData 结构契约（v0.0.101 T1）', () => {
  it('FeedbackData.prompt 可选 / questions 必填', () => {
    const noPrompt: FeedbackData = { questions: [] };
    expect(noPrompt.prompt).toBeUndefined();
    expect(noPrompt.questions).toEqual([]);
    const withPrompt: FeedbackData = {
      prompt: '引导',
      questions: [],
    };
    expect(withPrompt.prompt).toBe('引导');
  });

  it('Question.type 闭合：single | multi', () => {
    type Expected = 'single' | 'multi';
    expectTypeOf<Question['type']>().toEqualTypeOf<Expected>();
  });

  it('Question.options 元素含 key + label', () => {
    const q: Question = {
      id: 'q1',
      title: 't',
      type: 'multi',
      options: [{ key: 'k', label: 'l' }],
      allowOther: false,
    };
    expect(q.options[0]?.key).toBe('k');
    expect(q.options[0]?.label).toBe('l');
    expect(q.allowOther).toBe(false);
  });

  it('ApprovalData 含 toolName + arguments', () => {
    const a: ApprovalData = { toolName: 'bash', arguments: { command: 'ls' } };
    expect(a.toolName).toBe('bash');
    expect(a.arguments).toEqual({ command: 'ls' });
  });
});
