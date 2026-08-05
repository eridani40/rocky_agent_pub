/**
 * [v0.0.101 T3] 工具引擎 HITL 钩子 UT（白盒）
 * 参考: specs/tech/version_logs/v0.0.101/change_plan.md 模块 A（engine interaction 钩子）
 *       reqs/[done] v0.0.101.ask_question_tool/3-ask-question-tool.md §1 §2 §13
 *
 * 覆盖：
 *   - interaction 返非 null → 不调 run、收集进 pending、results 含占位 block（status=pending）
 *   - interaction 返 null → 正常 run（向后兼容）
 *   - interaction 未实现（无字段）→ 正常 run（向后兼容）
 *   - 多个 toolCall 同 batch：混合悬挂 + 普通 → 顺序对应 results、pending 顺序对应悬挂项
 *   - buildPendingResult 构造正确（status=pending + subState + data；resultMessageId/resultBlockIndex 留空）
 *   - allowedTools 拒绝路径不进 interaction（不悬挂拒绝项）
 *   - 未注册 / 参数错 → 不悬挂（走原 reject / INVALID_INPUT 路径）
 *   - opts.runId 透传 PendingToolCall.runId
 */
import { describe, it, expect, vi } from 'vitest';
import type { ToolCallBlock, ToolResultBlock } from '../../message/types';
import { ToolExecutionEngine, buildPendingResult } from '../engine';
import type { Tool, ToolInteraction, ToolRunResult } from '../types';
import { errorResult, textResult } from '../types';

/** 构造一个普通 tool（无 interaction，立即 run） */
function makeNormalTool(name: string, runSpy?: ReturnType<typeof vi.fn>): Tool {
  return {
    definition: {
      name,
      description: `normal tool ${name}`,
      inputSchema: { type: 'object', required: [], properties: {} },
    },
    run: runSpy ?? (vi.fn(async (): Promise<ToolRunResult> => textResult(`${name}-ok`))),
  };
}

/** 构造一个悬挂型 tool（interaction 恒返非 null，run 不应被调） */
function makeSuspendTool(name: string, interaction: ToolInteraction): { tool: Tool; runSpy: ReturnType<typeof vi.fn> } {
  const runSpy = vi.fn(async (): Promise<ToolRunResult> => textResult('should-not-reach'));
  const tool: Tool = {
    definition: {
      name,
      description: `suspend tool ${name}`,
      inputSchema: { type: 'object', required: [], properties: {} },
    },
    interaction: () => interaction,
    run: runSpy,
  };
  return { tool, runSpy };
}

/** 构造一个 interaction 返 null（条件不悬挂）的 tool */
function makeConditionalTool(name: string, shouldSuspend: boolean): { tool: Tool; runSpy: ReturnType<typeof vi.fn> } {
  const runSpy = vi.fn(async (): Promise<ToolRunResult> => textResult(`${name}-ran`));
  const tool: Tool = {
    definition: {
      name,
      description: `conditional tool ${name}`,
      inputSchema: { type: 'object', required: [], properties: {} },
    },
    interaction: () => (shouldSuspend ? sampleFeedbackInteraction() : null),
    run: runSpy,
  };
  return { tool, runSpy };
}

/** FeedbackData 形态的 ToolInteraction fixture（ask-question 风格） */
function sampleFeedbackInteraction(): ToolInteraction {
  return {
    subType: 'need_feedback',
    handleType: 'direct_result',
    data: {
      prompt: '请选择',
      questions: [
        {
          id: 'q1',
          title: '选项',
          type: 'single',
          options: [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
          ],
          allowOther: false,
        },
      ],
    },
  };
}

function callBlock(id: string, name: string, args: Record<string, unknown> = {}): ToolCallBlock {
  return { type: 'tool_call', id, name, arguments: args };
}

describe('ToolExecutionEngine HITL 钩子（v0.0.101 模块 A）', () => {
  it('interaction 返非 null → 不调 run、收集进 pending、results 含 status=pending 占位 block', async () => {
    const { tool: suspendTool, runSpy } = makeSuspendTool('ask', sampleFeedbackInteraction());
    const engine = new ToolExecutionEngine();
    const config = { tools: [suspendTool], sessionId: 's1', workdir: '/tmp' };
    const calls = [callBlock('c1', 'ask')];

    const { results, pending } = await engine.execute(config, calls);

    expect(runSpy).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    const p = pending[0]!;
    expect(p.toolCallId).toBe('c1');
    expect(p.toolName).toBe('ask');
    expect(p.handleType).toBe('direct_result');
    expect(p.subState).toBe('need_feedback');
    expect(p.status).toBe('pending');
    expect(p.sessionId).toBe('s1');
    expect(p.resultMessageId).toBeUndefined();
    expect(p.resultBlockIndex).toBeUndefined();

    expect(results).toHaveLength(1);
    const block: ToolResultBlock = results[0]!;
    expect(block.toolCallId).toBe('c1');
    expect(block.status).toBe('pending');
    expect(block.subState).toBe('need_feedback');
    expect(block.isError).toBe(false);
    expect(block.data).toEqual(sampleFeedbackInteraction().data);
    // 占位 content 是人话「用户回答中…」
    const text = block.content[0];
    expect(text?.type).toBe('text');
    expect((text as { text: string }).text).toContain('用户回答中');
  });

  it('interaction 返 null → 正常调 run（向后兼容，无 interaction 字段同此行为）', async () => {
    const normalTool = makeNormalTool('echo');
    const conditional = makeConditionalTool('cond', false); // 返 null
    const engine = new ToolExecutionEngine();
    const config = { tools: [normalTool, conditional.tool], workdir: '/tmp' };
    const calls = [callBlock('c1', 'echo'), callBlock('c2', 'cond')];

    const { results, pending } = await engine.execute(config, calls);

    expect(pending).toEqual([]);
    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBeUndefined(); // 普通 result 无 status
    expect(results[1]!.status).toBeUndefined();
    expect(conditional.runSpy).toHaveBeenCalledTimes(1);
  });

  it('混合 batch：悬挂 + 普通 + 悬挂 → results 顺序对应、pending 顺序对应悬挂项', async () => {
    const a = makeSuspendTool('ask-a', sampleFeedbackInteraction());
    const b = makeNormalTool('echo-b');
    const c = makeSuspendTool('ask-c', sampleFeedbackInteraction());
    const engine = new ToolExecutionEngine();
    const config = { tools: [a.tool, b, c.tool], workdir: '/tmp' };
    const calls = [
      callBlock('call-a', 'ask-a'),
      callBlock('call-b', 'echo-b'),
      callBlock('call-c', 'ask-c'),
    ];

    const { results, pending } = await engine.execute(config, calls);

    // results 与 calls 同长度同序
    expect(results.map((r) => r.toolCallId)).toEqual(['call-a', 'call-b', 'call-c']);
    // pending 顺序对应悬挂项的相对顺序
    expect(pending.map((p) => p.toolCallId)).toEqual(['call-a', 'call-c']);
    // 普通 tool run 被调；悬挂 tool run 不被调
    expect(b.run).toBeDefined();
    expect(a.runSpy).not.toHaveBeenCalled();
    expect(c.runSpy).not.toHaveBeenCalled();
    // 占位 block status=pending；普通 result status 缺省
    expect(results[0]!.status).toBe('pending');
    expect(results[1]!.status).toBeUndefined();
    expect(results[2]!.status).toBe('pending');
  });

  it('allowedTools 拒绝路径不进 interaction（拒绝项不悬挂）', async () => {
    const { tool, runSpy } = makeSuspendTool('ask', sampleFeedbackInteraction());
    const engine = new ToolExecutionEngine();
    const config = { tools: [tool], workdir: '/tmp' };
    // allowedTools=[] 全拦 → 不应进 interaction
    const calls = [callBlock('c1', 'ask')];
    const { results, pending } = await engine.execute(config, calls, []);

    expect(pending).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.status).toBeUndefined();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('未注册 tool → 不悬挂（走 not registered 拒绝路径）', async () => {
    const engine = new ToolExecutionEngine();
    const config = { tools: [], workdir: '/tmp' };
    const calls = [callBlock('c1', 'unknown')];
    const { results, pending } = await engine.execute(config, calls);

    expect(pending).toEqual([]);
    expect(results[0]!.isError).toBe(true);
    // 文案应含 not registered
    const text = results[0]!.content[0] as { text: string };
    expect(text.text).toMatch(/not registered/i);
  });

  it('opts.runId 透传 PendingToolCall.runId（caller 通过 opts 注入）', async () => {
    const { tool } = makeSuspendTool('ask', sampleFeedbackInteraction());
    const engine = new ToolExecutionEngine();
    const config = { tools: [tool], sessionId: 's9', workdir: '/tmp' };
    const { pending } = await engine.execute(
      config,
      [callBlock('c1', 'ask')],
      undefined,
      { runId: 'run-xyz' },
    );
    expect(pending[0]!.runId).toBe('run-xyz');
    expect(pending[0]!.sessionId).toBe('s9');
  });
});

describe('buildPendingResult helper（v0.0.101 模块 A）', () => {
  it('构造 status=pending 占位 block + PendingToolCall wrapper', () => {
    const call = callBlock('tc-1', 'ask-question');
    const interaction = sampleFeedbackInteraction();
    const { resultBlock, pendingCall } = buildPendingResult(call, interaction, 's1', 'r1');

    // 占位 block
    expect(resultBlock.type).toBe('tool_result');
    expect(resultBlock.toolCallId).toBe('tc-1');
    expect(resultBlock.status).toBe('pending');
    expect(resultBlock.subState).toBe('need_feedback');
    expect(resultBlock.isError).toBe(false);
    expect(resultBlock.data).toBe(interaction.data);
    expect(resultBlock.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('用户回答中') });

    // pending wrapper
    expect(pendingCall.sessionId).toBe('s1');
    expect(pendingCall.runId).toBe('r1');
    expect(pendingCall.toolCallId).toBe('tc-1');
    expect(pendingCall.toolName).toBe('ask-question');
    expect(pendingCall.handleType).toBe('direct_result');
    expect(pendingCall.subState).toBe('need_feedback');
    expect(pendingCall.data).toBe(interaction.data);
    expect(pendingCall.status).toBe('pending');
    // resultMessageId/resultBlockIndex 留空由 caller 回填
    expect(pendingCall.resultMessageId).toBeUndefined();
    expect(pendingCall.resultBlockIndex).toBeUndefined();
  });

  it('sessionId undefined → 空串占位（caller 责任填）', () => {
    const call = callBlock('tc-2', 'ask-question');
    const { pendingCall } = buildPendingResult(call, sampleFeedbackInteraction(), undefined, 'r2');
    expect(pendingCall.sessionId).toBe('');
    expect(pendingCall.runId).toBe('r2');
  });
});
