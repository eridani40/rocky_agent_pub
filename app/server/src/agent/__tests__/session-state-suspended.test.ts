/**
 * [v0.0.101 T1] SessionState 第六态 + Session.pendingToolCalls 类型闭合性 UT（白盒）
 * 参考: specs/tech/version_logs/v0.0.101/change_plan.md 模块 D
 *       reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §4
 *
 * 校验点：
 *   - SessionState 含 'suspended'（六态）
 *   - Session.pendingToolCalls 字段类型 = PendingToolCall[] | undefined
 *   - schema state enum 含 suspended（schema 闭合性）
 */
import { describe, it, expect, expectTypeOf } from 'vitest';
import type { SessionState, Session } from '../session-store-types';
import type { PendingToolCall } from '../../tools/types';
import { SessionSchema } from '../schema_defs/session';

describe('SessionState 第六态 suspended（v0.0.101 T1）', () => {
  it('含 suspended（六态闭合）', () => {
    const states: SessionState[] = [
      'idle',
      'running',
      'interrupting',
      'interrupted',
      'error',
      'suspended',
    ];
    expect(states).toContain('suspended');
    expect(states).toHaveLength(6);
    type Expected =
      | 'idle'
      | 'running'
      | 'interrupting'
      | 'interrupted'
      | 'error'
      | 'suspended';
    expectTypeOf<SessionState>().toEqualTypeOf<Expected>();
  });
});

describe('Session.pendingToolCalls（v0.0.101 T1）', () => {
  it('字段类型 = PendingToolCall[] | undefined（optional 兼容旧 session）', () => {
    expectTypeOf<Session['pendingToolCalls']>().toEqualTypeOf<
      PendingToolCall[] | undefined
    >();
  });

  it('合法 Session 字面量可省 pendingToolCalls（向后兼容旧 session）', () => {
    const legacy: Session = {
      id: '01S',
      status: 'active',
      state: 'idle',
      running: false,
      currentRunId: null,
      unread: false,
      workspaceDir: '/tmp',
      createdAt: '2026-07-09T00:00:00Z',
      updatedAt: '2026-07-09T00:00:00Z',
      version: 1,
    };
    expect(legacy.pendingToolCalls).toBeUndefined();
  });

  it('suspended session 携带 pendingToolCalls（合法存活态）', () => {
    const s: Session = {
      id: '01S',
      status: 'active',
      state: 'suspended',
      running: false, // INV-2：suspended 不算 running
      currentRunId: null,
      unread: false,
      workspaceDir: '/tmp',
      pendingToolCalls: [
        {
          sessionId: '01S',
          runId: '01RUN',
          toolCallId: '01CALL',
          toolName: 'ask-question',
          handleType: 'direct_result',
          subState: 'need_feedback',
          data: { questions: [] },
          status: 'pending',
        },
      ],
      createdAt: '2026-07-09T00:00:00Z',
      updatedAt: '2026-07-09T00:00:00Z',
      version: 1,
    };
    expect(s.state).toBe('suspended');
    expect(s.running).toBe(false);
    expect(s.pendingToolCalls).toHaveLength(1);
    expect(s.pendingToolCalls?.[0]?.toolName).toBe('ask-question');
  });
});

describe('SessionSchema state enum 含 suspended（v0.0.101 T1）', () => {
  it("schema state 字段 enumValues 含 'suspended'", () => {
    const stateField = SessionSchema.fields.state;
    expect(stateField.type).toBe('enum');
    expect(stateField.enumValues).toContain('suspended');
    expect(stateField.enumValues).toEqual([
      'idle',
      'running',
      'interrupting',
      'interrupted',
      'error',
      'suspended',
    ]);
  });

  it("schema 含 pendingToolCalls 字段（json, required false）", () => {
    const field = SessionSchema.fields.pendingToolCalls;
    expect(field).toBeDefined();
    expect(field.type).toBe('json');
    expect(field.required).toBeFalsy();
  });
});
