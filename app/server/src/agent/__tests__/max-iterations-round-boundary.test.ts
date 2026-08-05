/**
 * [v0.0.130.hang] max_iterations 轮次边界 UT
 * 参考: specs/tech/version_logs/v0.0.130.hang/change_plan.md 模块 F
 *
 * 契约：max_iterations 判定在 ④ Exit Check 的 step++ 之后（轮次边界）——
 *   一轮 = LLM 调用→工具执行→result 落盘，只有完整轮结束后才判 should-continue。
 *   maxIter=2 时：恰好 2 次 LLM 调用 + 2 次工具执行（每个提取的 tool_call 都被执行，
 *   无 dangling），第 3 次 LLM 调用绝不发生（旧位置会发起第 3 次调用并丢弃其 tool_use）。
 *
 * 驱动方式沿用 child-registry-mount-chain.test.ts：只 mock 非工具阶段
 * （context/llm/helpers/emitters/lifecycle），工具链路走真实 engine。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 绝对路径 mock（bun+jsdom 下相对路径 vi.mock 会静默失效，memory: test-vitest-mock-absolute-path）
const { mockPaths } = vi.hoisted(() => {
  const { resolve } = require('node:path') as typeof import('node:path');
  return {
    mockPaths: {
      context: resolve(__dirname, '../loop-stage-context'),
      llm: resolve(__dirname, '../loop-stage-llm'),
      helpers: resolve(__dirname, '../agent-loop-helpers'),
      emitters: resolve(__dirname, '../agent-loop-emitters'),
      lifecycle: resolve(__dirname, '../agent-loop-lifecycle'),
    },
  };
});

vi.mock(mockPaths.context, () => ({
  prepareStage: vi.fn().mockResolvedValue('ok'),
  ingestAssistant: vi.fn().mockResolvedValue(undefined),
  ingestToolResults: vi.fn().mockResolvedValue(undefined),
  hasPendingInput: vi.fn().mockResolvedValue(false),
  runTryCompact: vi.fn().mockResolvedValue(undefined),
}));
vi.mock(mockPaths.llm, () => ({
  callLLMForSpec: vi.fn(),
}));
vi.mock(mockPaths.helpers, () => ({
  extractToolCalls: vi.fn(),
  toProtocolMessage: vi.fn(),
}));
vi.mock(mockPaths.emitters, () => ({
  emitRunStart: vi.fn(),
  emitRunEnd: vi.fn(),
  emitError: vi.fn(),
  emitRequireHumanInput: vi.fn(),
  emitToolExecutionStart: vi.fn(),
  emitToolExecutionEnd: vi.fn(),
  emitToolResult: vi.fn(),
}));
vi.mock(mockPaths.lifecycle, () => ({
  initState: vi.fn(),
  ensureRunCreated: vi.fn(),
}));

import { runReActLoop } from '../run-react-loop';
import { callLLMForSpec } from '../loop-stage-llm';
import { extractToolCalls } from '../agent-loop-helpers';
import { ToolExecutionEngine } from '../../tools/engine';
import { textResult } from '../../tools/types';
import type { Tool, ToolInput, ToolCtx, ToolRunResult } from '../../tools/types';
import type { RunSpec, LoopState } from '../loop-ports';

function minimalLoopState(): LoopState {
  return {
    ingestUpTo: null, llmUpTo: null,
    snapshot: {
      system: { id: 'sys', sessionId: 's1', role: 'system', content: [] },
      messages: [], inputCharCount: 0,
      contextWindowUsage: {
        systemTokens: 0, messageTokens: 0, toolTokens: 0, totalTokens: 0,
        maxOutputTokens: 0, tokenLimit: 0, remainingTokens: 0,
      },
      summary: null,
    },
    step: 0, done: false,
  } as unknown as LoopState;
}

function buildSpec(tool: Tool, maxIter: number): RunSpec {
  return {
    sessionId: 's1',
    runId: 'r1',
    runKind: 'main',
    scopeId: 'default',
    controller: { runId: 'r1', aborted: false },
    config: { sessionId: 's1', tools: [tool], workdir: '/tmp' },
    allowedTools: ['echo_tool'],
    maxIter,
    toolDefinitions: [],
    observability: {
      reset: vi.fn(), startTrace: vi.fn(), endTrace: vi.fn(),
      startStepSpan: vi.fn(), endStepSpan: vi.fn(), markTraceError: vi.fn(),
      startToolSpan: vi.fn().mockReturnValue({}), endToolSpan: vi.fn(),
    },
    wireEmitCtx: { bus: { clearReplay: vi.fn() } },
    wireStore: undefined,
    wireInitState: async () => minimalLoopState(),
    wireToolEngine: new ToolExecutionEngine(),
    lifecycle: { onUsage: vi.fn(), onRunEnd: vi.fn(), onInterrupted: vi.fn() },
  } as unknown as RunSpec;
}

// 每轮 tool_call 的 arguments 不同 → 不触发 doom_loop 签名重复检测
function toolCallForRound(n: number) {
  return [{ type: 'tool_call', id: `call_${n}`, name: 'echo_tool', arguments: { round: n } }];
}

describe('[v0.0.130.hang] max_iterations 轮次边界（step++ 之后判定）', () => {
  let runCount: number;
  let echoTool: Tool;

  beforeEach(() => {
    vi.clearAllMocks();
    runCount = 0;
    echoTool = {
      definition: { name: 'echo_tool', description: 'echo', inputSchema: { type: 'object' } },
      run: async (_input: ToolInput, _ctx: ToolCtx): Promise<ToolRunResult> => {
        runCount++;
        return textResult('ok');
      },
    };
    (callLLMForSpec as ReturnType<typeof vi.fn>).mockImplementation(async (_spec, state) => ({
      assistant: {
        id: `a${state.step}`, sessionId: 's1', role: 'assistant',
        content: toolCallForRound(state.step),
      },
      usage: {},
    }));
    (extractToolCalls as ReturnType<typeof vi.fn>).mockImplementation(
      (content: Array<{ type: string }>) => content.filter((b) => b.type === 'tool_call'),
    );
  });

  it('maxIter=2 恒出 tool_call：恰 2 次 LLM 调用 + 2 次工具执行，stopReason=max_iterations，rounds=2', async () => {
    const result = await runReActLoop(buildSpec(echoTool, 2));

    // 核心：第 3 次 LLM 调用绝不发生（旧位置=3 次，第 3 次的 tool_use 成 dangling）
    expect(callLLMForSpec).toHaveBeenCalledTimes(2);
    // 每个提取的 tool_call 都被执行（无「已落盘未执行」半轮）
    expect(runCount).toBe(2);
    expect(result.stopReason).toBe('max_iterations');
    expect(result.rounds).toBe(2);
  });

  it('maxIter=3 但第 2 轮 LLM 返纯文本：no_tool_call 正常收尾优先（max_iter 不干扰自然终点）', async () => {
    (callLLMForSpec as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(async (_spec, state) => ({
        assistant: { id: 'a0', sessionId: 's1', role: 'assistant', content: toolCallForRound(state.step) },
        usage: {},
      }))
      .mockImplementationOnce(async () => ({
        assistant: { id: 'a1', sessionId: 's1', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        usage: {},
      }));

    const result = await runReActLoop(buildSpec(echoTool, 3));

    expect(callLLMForSpec).toHaveBeenCalledTimes(2);
    expect(runCount).toBe(1);
    expect(result.stopReason).toBe('no_tool_call');
  });
});
