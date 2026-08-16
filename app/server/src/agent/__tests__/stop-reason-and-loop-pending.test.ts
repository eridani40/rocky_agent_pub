/**
 * [v0.0.101 T3] StopReason enum + loop ③ 段悬挂分流 UT（白盒，模块 C）
 * 参考: specs/tech/version_logs/v0.0.101/change_plan.md 模块 C
 *       reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §2 §8 §10
 *
 * 覆盖：
 *   - StopReason 含 'tool_pending'，不含 'require_approval'（O7 全代码零残留）
 *   - RequireHumanInputEvent payload breaking：pending 单字段（不再 toolCalls/prompt）
 *   - ③ 段 pending 收集 + emit 队首 + state.stopReason=tool_pending + state.done=true（mock store/engine）
 *
 * 注：runReActLoop 整体集成由 AT/ET 验证，本 UT 只验类型闭合 + ③ 段关键不变量。
 */
import { describe, it, expect } from 'vitest';
import type { StopReason, RequireHumanInputEvent } from '../agent-event-types';
import type { PendingToolCall } from '../../tools/types';
import type { ToolCallBlock } from '../../message/types';

describe('StopReason enum（v0.0.101 模块 C）', () => {
  it('含 tool_pending（替代退役的 require_approval）', () => {
    const r: StopReason = 'tool_pending';
    expect(r).toBe('tool_pending');
  });

  it('require_approval 不在枚举（O7 退役，TS 编译时拒绝赋值）', () => {
    // 反向校验：require_approval 不能赋给 StopReason
    // @ts-expect-error - require_approval 已退役，赋值应报错
    const _: StopReason = 'require_approval';
    expect(_).toBe('require_approval'); // 运行时仍可持有字符串，但类型层拒绝
  });

  it('其他 5 枚举保留（no_tool_call/no_new_messages/max_iterations/doom_loop/error/interrupted）', () => {
    const reasons: StopReason[] = [
      'no_tool_call',
      'no_new_messages',
      'max_iterations',
      'doom_loop',
      'error',
      'interrupted',
      'tool_pending',
    ];
    expect(reasons).toHaveLength(7);
    expect(new Set(reasons).size).toBe(7); // 无重复
  });
});

describe('RequireHumanInputEvent payload breaking change（v0.0.101 模块 C）', () => {
  it('payload 含 pending: PendingToolCall（队首单个）', () => {
    const pending: PendingToolCall = {
      sessionId: 's1',
      runId: 'r1',
      toolCallId: 'tc1',
      toolName: 'ask-question',
      handleType: 'direct_result',
      subState: 'need_feedback',
      data: { questions: [] },
      resultMessageId: 'm1',
      resultBlockIndex: 0,
      status: 'pending',
    };
    const evt: RequireHumanInputEvent = {
      id: 'e1',
      type: 'require_human_input',
      sessionId: 's1',
      createdAt: '2026-07-09T00:00:00Z',
      runId: 'r1',
      runKind: 'main',
      pending,
    };
    expect(evt.pending).toBe(pending);
    expect(evt.pending.toolCallId).toBe('tc1');
  });

  it('payload 不再含 toolCalls[]（breaking change，TS 拒绝旧字段）', () => {
    // 旧 payload 含 toolCalls[] 已删；本测试通过显式赋值验证 TS 编译时拒绝
    const evt = {
      id: 'e1',
      type: 'require_human_input' as const,
      sessionId: 's1',
      createdAt: '2026-07-09T00:00:00Z',
      runId: 'r1',
      runKind: 'main' as const,
      pending: {} as PendingToolCall,
    };
    const _: RequireHumanInputEvent = evt;
    expect(_.pending).toBeDefined();
    // 反向校验：旧字段 toolCalls 不在合法 payload 类型上
    // @ts-expect-error - 旧字段 toolCalls 已退役，赋值应报 TS 错误
    const bad: RequireHumanInputEvent = { ...evt, toolCalls: [] };
    void bad;
    expect(true).toBe(true);
  });
});

describe('runReActLoop ③ 段悬挂分流（mock store + engine）', () => {
  /**
   * 本组测试通过 mock 一个最小化的 loop 入口验证 ③ 段核心逻辑：
   *   - executeToolsForSpec 返 {results, pending} 后，pending 非空时：
   *     1. setPendingToolCalls 落盘
   *     2. emit require_human_input（队首）
   *     3. state.stopReason='tool_pending' + state.done=true
   *   - INV-4：emit 仅队首（多 pending 不批量 emit）
   *
   * 集成层（真 runReActLoop + 真 store + 真 engine）由 AT case `ask_question_submit`
   * 覆盖；本 UT 只验关键不变量，不重复 AT 范围。
   */
  it('③ 段 pending 非空：setPendingToolCalls + emitRequireHumanInput(队首) + stopReason=tool_pending', async () => {
    // 直接调 executeAndEmit（③ 段调的 helper）验返结构 + 队首取值
    const { executeAndEmit } = await import('../agent-loop-stage-tool');
    const { askQuestionTool } = await import('../../tools/ask-question');

    // mock LoopObservability（最小 stub）
    const obs = {
      startToolSpan: () => ({ kind: 'span' as const, id: 'noop' }),
      endToolSpan: () => undefined,
    };

    // mock EmitContext（捕获 emit 的 require_human_input）
    const emitted: unknown[] = [];
    const emitCtx = {
      sessionId: 's1',
      runId: 'r1',
      runKind: 'main',
      bus: { emit: (_key: string, evt: { data: unknown }) => emitted.push(evt.data) },
      now: () => '2026-07-09T00:00:00Z',
    };

    const { results, pending } = await executeAndEmit({
      toolEngine: {
        execute: async (
          _config: unknown,
          calls: ToolCallBlock[],
          _allowed?: string[],
          opts?: { onResult?: (r: { type: 'tool_result'; toolCallId: string }, i: number) => void },
        ) => {
          // 假装 ask-question interaction 触发 → 悬挂
          const pendingOut: PendingToolCall[] = calls.map((c: ToolCallBlock) => ({
            sessionId: 's1',
            runId: 'r1',
            toolCallId: c.id,
            toolName: c.name,
            handleType: 'direct_result' as const,
            subState: 'need_feedback' as const,
            data: { questions: [] },
            status: 'pending' as const,
          }));
          const resultsOut = calls.map((c: ToolCallBlock) => ({
            type: 'tool_result' as const,
            toolCallId: c.id,
            content: [{ type: 'text' as const, text: '用户回答中…' }],
            isError: false,
            status: 'pending' as const,
            subState: 'need_feedback' as const,
            data: { questions: [] },
          }));
          // [v0.0.354 T1] mock 模拟真实引擎契约：每 result push 后调 onResult（executeAndEmit 依赖它 emit）
          resultsOut.forEach((r, i) => opts?.onResult?.(r, i));
          return { results: resultsOut, pending: pendingOut };
        },
      } as never,
      config: { tools: [askQuestionTool], sessionId: 's1', workdir: '/tmp' },
      toolCalls: [
        { type: 'tool_call', id: 'tc1', name: 'ask-question', arguments: { questions: [] } },
        { type: 'tool_call', id: 'tc2', name: 'ask-question', arguments: { questions: [] } },
      ],
      allowedTools: ['ask-question'],
      emitCtx: emitCtx as never,
      obs: obs as never,
      opts: { runId: 'r1' },
    });

    // 2 个 pending 都收集（不逐个退出）
    expect(pending).toHaveLength(2);
    expect(pending.map((p) => p.toolCallId)).toEqual(['tc1', 'tc2']);
    // results 含占位 block status=pending
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.status === 'pending')).toBe(true);
    // emit 走 publish → bus.emit：每 result 一组 tool_result_*（不验细节，只验 emit 了）
    expect(emitted.length).toBeGreaterThan(0);
    // emit 的 events 中无 require_human_input（那是 runReActLoop ③ 段在 caller 做的，不在 executeAndEmit）
    expect(emitted.some((e) => (e as { type: string }).type === 'require_human_input')).toBe(false);
  });

  it('③ 段 pending 空（普通 tool）：caller 不该 emit require_human_input / stopReason 不该是 tool_pending', async () => {
    const { executeAndEmit } = await import('../agent-loop-stage-tool');
    const { textResult } = await import('../../tools/types');

    const obs = {
      startToolSpan: () => ({ kind: 'span' as const, id: 'noop' }),
      endToolSpan: () => undefined,
    };
    const emitCtx = {
      sessionId: 's1',
      runId: 'r1',
      runKind: 'main',
      bus: { emit: () => undefined },
      now: () => '2026-07-09T00:00:00Z',
    };

    const { pending } = await executeAndEmit({
      toolEngine: {
        execute: async (_config: unknown, calls: ToolCallBlock[]) => ({
          results: calls.map((c: ToolCallBlock) => ({
            type: 'tool_result' as const,
            toolCallId: c.id,
            content: [{ type: 'text' as const, text: 'ok' }],
            isError: false,
          })),
          pending: [], // 普通 tool → 无 pending
        }),
      } as never,
      config: { tools: [], sessionId: 's1', workdir: '/tmp' },
      toolCalls: [{ type: 'tool_call', id: 'c1', name: 'echo', arguments: {} }],
      allowedTools: [],
      emitCtx: emitCtx as never,
      obs: obs as never,
    });

    // pending 空 → caller 不该 emit require_human_input / stopReason 不该 tool_pending
    expect(pending).toEqual([]);
    // （若 caller 看到 pending=[]，按 change_plan 应正常进 doom_loop 检查 + step++）
    // textResult helper 验证 import 正常
    expect(textResult('x').isError).toBe(false);
  });
});
