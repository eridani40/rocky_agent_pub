/**
 * [v0.0.130.hang task-3 Wave B] ChildProcessRegistry 挂载链集成 UT
 * 参考: specs/tech/version_logs/v0.0.130.hang/change_plan.md 模块 B-2
 *
 * 覆盖挂载链自上而下的透传（不新建 registry，只验证同一实例沿链路下沉）：
 *   RunSpec.controller.childRegistry
 *     → run-react-loop.executeToolsForSpec（私有函数，经 runReActLoop ③ 段间接驱动）
 *     → agent-loop-stage-tool.executeAndEmit（真实实现，未 mock）
 *     → agent-loop-base.executeTools（真实实现，未 mock）
 *     → tools/engine.ts ToolExecutionEngine.execute（真实引擎，未 mock）
 *     → ctx.childRegistry（fake tool 断言收到同一实例）
 *
 * 只 mock loop 骨架的非工具相关阶段（context/llm/helpers/lifecycle/emitters），
 * 工具执行链路（stage-tool/base/engine）全部走真实实现，才能证明挂载链真正打通。
 */
import { describe, it, expect, vi } from 'vitest';

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
  callLLMForSpec: vi.fn().mockResolvedValue({
    assistant: {
      id: 'a1', sessionId: 's1', role: 'assistant',
      content: [{ type: 'tool_call', id: 'call1', name: 'capture', arguments: {} }],
    },
    usage: {},
  }),
}));
vi.mock(mockPaths.helpers, () => {
  const extractToolCalls = vi.fn();
  return { extractToolCalls, toProtocolMessage: vi.fn() };
});
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
import { extractToolCalls } from '../agent-loop-helpers';
import { ToolExecutionEngine } from '../../tools/engine';
import { ChildProcessRegistry } from '../../tools/child-process-registry';
import { textResult } from '../../tools/types';
import type { Tool, ToolCtx, ToolInput, ToolRunResult } from '../../tools/types';
import type { RunSpec, LoopState } from '../loop-ports';

/** 最小 LoopState 工厂（跳过真实 store 初始化，走 wireInitState 分支） */
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

/** 构造最小可跑的 RunSpec（真实 wireToolEngine，controller 带 childRegistry） */
function buildSpec(opts: { controllerChildRegistry?: ChildProcessRegistry; tool: Tool }): RunSpec {
  const toolEngine = new ToolExecutionEngine();
  return {
    sessionId: 's1',
    runId: 'r1',
    runKind: 'main',
    scopeId: 'default',
    controller: { runId: 'r1', aborted: false, childRegistry: opts.controllerChildRegistry },
    config: { sessionId: 's1', tools: [opts.tool], workdir: '/tmp' },
    allowedTools: ['capture'],
    maxIter: 10,
    toolDefinitions: [],
    observability: {
      reset: vi.fn(), startTrace: vi.fn(), endTrace: vi.fn(),
      startStepSpan: vi.fn(), endStepSpan: vi.fn(), markTraceError: vi.fn(),
      startToolSpan: vi.fn().mockReturnValue({}), endToolSpan: vi.fn(),
    },
    wireEmitCtx: { bus: { clearReplay: vi.fn() } },
    wireStore: undefined,
    wireInitState: async () => minimalLoopState(),
    wireToolEngine: toolEngine,
    lifecycle: { onUsage: vi.fn(), onRunEnd: vi.fn(), onInterrupted: vi.fn() },
  } as unknown as RunSpec;
}

describe('[v0.0.130.hang task-3] ChildProcessRegistry 挂载链（RunSpec.controller → engine ctx）', () => {
  it('spec.controller.childRegistry 沿透传链下沉到 tools/engine.ts ctx.childRegistry（同一实例）', async () => {
    let capturedCtx: ToolCtx | undefined;
    const captureTool: Tool = {
      definition: { name: 'capture', description: 'capture ctx', inputSchema: { type: 'object' } },
      run: async (_input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> => {
        capturedCtx = ctx;
        return textResult('ok');
      },
    };
    const registry = new ChildProcessRegistry();
    const spec = buildSpec({ controllerChildRegistry: registry, tool: captureTool });

    // 第一轮 extractToolCalls 返 tool_call 触发 ③ 段；第二轮返空触发 no_tool_call 收尾（跳出 while）
    (extractToolCalls as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([{ type: 'tool_call', id: 'call1', name: 'capture', arguments: {} }])
      .mockReturnValue([]);

    await runReActLoop(spec);

    expect(capturedCtx).toBeDefined();
    // 挂载链核心断言：ctx.childRegistry 与 spec.controller.childRegistry 是同一实例（非新建）
    expect(capturedCtx!.childRegistry).toBe(registry);
  });

  it('controller.childRegistry 缺省（undefined）→ ctx.childRegistry 也是 undefined（不影响裸跑）', async () => {
    let capturedCtx: ToolCtx | undefined;
    const captureTool: Tool = {
      definition: { name: 'capture', description: 'capture ctx', inputSchema: { type: 'object' } },
      run: async (_input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> => {
        capturedCtx = ctx;
        return textResult('ok');
      },
    };
    const spec = buildSpec({ controllerChildRegistry: undefined, tool: captureTool });

    (extractToolCalls as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([{ type: 'tool_call', id: 'call1', name: 'capture', arguments: {} }])
      .mockReturnValue([]);

    await runReActLoop(spec);

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.childRegistry).toBeUndefined();
  });
});
