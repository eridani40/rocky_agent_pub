/**
 * run-react-loop compact 触发点迁移单测（v0.0.80.t1 task-1）
 * 参考: specs/tech/version_logs/v0.0.80.t1/change_plan.md §1.1/§2.1（触发点迁移）
 *
 * 覆盖：
 *   - compact 触发点在 prepareStage 之后、callLLM 之前（用 mock spy 验时机）
 *   - fire-and-forget：主 loop 不 await tryCompact，立即进 callLLM
 *
 * 测试策略：mock prepareStage / callLLMForSpec / runTryCompact，按 spy 调用顺序断言
 *   prepareStage → runTryCompact（被 fire-and-forget void）→ callLLMForSpec
 */
import { describe, it, expect, vi } from 'vitest';

// 绝对路径 mock（避免 bun+jsdom 相对路径静默失效）。
// vi.mock 被 vitest 提升到文件顶部（早于 import/const），故 path 用 vi.hoisted + require('node:path')
// + __dirname 派生（portable）；严禁硬编码 worktree 路径——merge 到别的 worktree/主仓库后 vi.mock 不拦截
// → 真 module 跑 → 假绿（memory: test-vitest-mock-absolute-path）。
const { mockPaths } = vi.hoisted(() => {
  const { resolve } = require('node:path') as typeof import('node:path');
  return {
    mockPaths: {
      context: resolve(__dirname, '../loop-stage-context'),
      llm: resolve(__dirname, '../loop-stage-llm'),
      helpers: resolve(__dirname, '../agent-loop-helpers'),
      base: resolve(__dirname, '../agent-loop-base'),
      stageTool: resolve(__dirname, '../agent-loop-stage-tool'),
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
    assistant: { id: 'a1', sessionId: 's1', role: 'assistant', content: [] },
    usage: {},
  }),
}));
vi.mock(mockPaths.helpers, () => ({
  extractToolCalls: vi.fn().mockReturnValue([]),
  toProtocolMessage: vi.fn(),
}));
vi.mock(mockPaths.base, () => ({
  checkDoomLoop: vi.fn().mockReturnValue(false),
  checkMaxIter: vi.fn().mockReturnValue(false),
}));
vi.mock(mockPaths.stageTool, () => ({
  executeAndEmit: vi.fn(),
}));
vi.mock(mockPaths.emitters, () => ({
  emitRunStart: vi.fn(),
  emitRunEnd: vi.fn(),
  emitError: vi.fn(),
}));
vi.mock(mockPaths.lifecycle, () => ({
  initState: vi.fn(),
  ensureRunCreated: vi.fn(),
}));

import { runReActLoop } from '../run-react-loop';
import { prepareStage, ingestAssistant, runTryCompact, hasPendingInput } from '../loop-stage-context';
import { callLLMForSpec } from '../loop-stage-llm';
import { extractToolCalls } from '../agent-loop-helpers';
import type { RunSpec, LoopState } from '../loop-ports';

describe('[v0.0.80.t1 task-1] run-react-loop compact 触发点（prepareStage 后、callLLM 前）', () => {
  it('调用顺序：prepareStage → runTryCompact（fire-and-forget void）→ callLLMForSpec', async () => {
    // 模拟：prepareStage 'ok' → tryCompact → callLLM → assistant → ingestAssistant → no tool_call → break
    const callOrder: string[] = [];
    (prepareStage as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('prepareStage');
      return 'ok' as const;
    });
    (runTryCompact as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('runTryCompact');
    });
    (callLLMForSpec as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('callLLMForSpec');
      return {
        assistant: { id: 'a1', sessionId: 's1', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        usage: { total_tokens: 5 },
      };
    });
    (ingestAssistant as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('ingestAssistant');
    });
    (extractToolCalls as ReturnType<typeof vi.fn>).mockReturnValue([]);

    const spec = {
      sessionId: 's1',
      runId: 'r1',
      runKind: 'main',
      scopeId: 'default',
      controller: { aborted: false },
      config: { sessionId: 's1' },
      observability: {
        reset: vi.fn(),
        startTrace: vi.fn(),
        endTrace: vi.fn(),
        startStepSpan: vi.fn(),
        endStepSpan: vi.fn(),
        markTraceError: vi.fn(),
      },
      wireEmitCtx: { bus: { clearReplay: vi.fn() } },
      wireStore: null,
      // 跳过真实 state init：返最小 LoopState（无 wireStore 场景）
      wireInitState: async () => ({
        ingestUpTo: null, llmUpTo: null, snapshot: {
          system: { id: 'sys', sessionId: 's1', role: 'system', content: [] },
          messages: [], inputCharCount: 0,
          contextWindowUsage: { systemTokens: 0, messageTokens: 0, toolTokens: 0, totalTokens: 0, maxOutputTokens: 0, tokenLimit: 0, remainingTokens: 0 },
          summary: null,
        }, step: 0, done: false,
      }),
      lifecycle: {
        onUsage: vi.fn(),
        onRunEnd: vi.fn(),
        onInterrupted: vi.fn(),
      },
      toolDefinitions: [],
      message: undefined,
      maxIter: 10,
    } as unknown as RunSpec;

    await runReActLoop(spec);

    // 顺序断言：prepareStage → runTryCompact → callLLMForSpec → ingestAssistant
    expect(callOrder[0]).toBe('prepareStage');
    expect(callOrder[1]).toBe('runTryCompact');
    expect(callOrder[2]).toBe('callLLMForSpec');
    expect(callOrder[3]).toBe('ingestAssistant');
    // tryCompact 被调一次
    expect(runTryCompact).toHaveBeenCalledOnce();
  });

  it('fire-and-forget：tryCompact promise reject 不影响主 loop（外层 .catch log 兜底）', async () => {
    (prepareStage as ReturnType<typeof vi.fn>).mockResolvedValue('ok');
    (runTryCompact as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('compact async 失败'));
    (callLLMForSpec as ReturnType<typeof vi.fn>).mockResolvedValue({
      assistant: { id: 'a1', sessionId: 's1', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      usage: {},
    });
    (ingestAssistant as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (extractToolCalls as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const spec = {
      sessionId: 's1',
      runId: 'r1',
      runKind: 'main',
      scopeId: 'default',
      controller: { aborted: false },
      config: { sessionId: 's1' },
      observability: {
        reset: vi.fn(),
        startTrace: vi.fn(),
        endTrace: vi.fn(),
        startStepSpan: vi.fn(),
        endStepSpan: vi.fn(),
        markTraceError: vi.fn(),
      },
      wireEmitCtx: { bus: { clearReplay: vi.fn() } },
      wireStore: null,
      wireInitState: async () => ({
        ingestUpTo: null, llmUpTo: null, snapshot: {
          system: { id: 'sys', sessionId: 's1', role: 'system', content: [] },
          messages: [], inputCharCount: 0,
          contextWindowUsage: { systemTokens: 0, messageTokens: 0, toolTokens: 0, totalTokens: 0, maxOutputTokens: 0, tokenLimit: 0, remainingTokens: 0 },
          summary: null,
        }, step: 0, done: false,
      }),
      lifecycle: { onUsage: vi.fn(), onRunEnd: vi.fn(), onInterrupted: vi.fn() },
      toolDefinitions: [],
      message: undefined,
      maxIter: 10,
    } as unknown as RunSpec;

    // tryCompact reject 不应传播到 runReActLoop（外层 .catch log 吞）
    await expect(runReActLoop(spec)).resolves.toBeDefined();
    // warning 被打（外层 catch log）
    const warnText = warnSpy.mock.calls.map((c) => String(c.join(' '))).join('\n');
    expect(warnText).toContain('compact async');
    warnSpy.mockRestore();
  });
});

// ============================================================
// [v0.0.144 需求1] run 层失败 → error.log 记录含 layer:'run'
// ============================================================
describe('[v0.0.144 需求1] run 层失败写 error.log 含 layer:run', () => {
  it('callLLMForSpec throw → agentLog.write(error) 记录携带 layer:run', async () => {
    (prepareStage as ReturnType<typeof vi.fn>).mockResolvedValue('ok');
    (runTryCompact as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    // callLLMForSpec 抛错 → run-react-loop catch 分支写 error.log（layer:'run'）
    (callLLMForSpec as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('llm boom'));

    const errorWrites: Array<Record<string, unknown>> = [];
    const logWriter = {
      write: (type: string, record: Record<string, unknown>) => {
        if (type === 'error') errorWrites.push(record);
      },
    };

    const spec = {
      sessionId: 's1',
      runId: 'r1',
      runKind: 'main',
      scopeId: 'default',
      controller: { aborted: false },
      // config.logWriter → run-react-loop 顶部 agentLog 来源
      config: { sessionId: 's1', logWriter },
      observability: {
        reset: vi.fn(),
        startTrace: vi.fn(),
        endTrace: vi.fn(),
        startStepSpan: vi.fn(),
        endStepSpan: vi.fn(),
        markTraceError: vi.fn(),
      },
      wireEmitCtx: { bus: { clearReplay: vi.fn() } },
      wireStore: null,
      wireInitState: async () => ({
        ingestUpTo: null, llmUpTo: null, snapshot: {
          system: { id: 'sys', sessionId: 's1', role: 'system', content: [] },
          messages: [], inputCharCount: 0,
          contextWindowUsage: { systemTokens: 0, messageTokens: 0, toolTokens: 0, totalTokens: 0, maxOutputTokens: 0, tokenLimit: 0, remainingTokens: 0 },
          summary: null,
        }, step: 0, done: false,
      }),
      lifecycle: { onUsage: vi.fn(), onRunEnd: vi.fn(), onInterrupted: vi.fn() },
      toolDefinitions: [],
      message: undefined,
      maxIter: 10,
    } as unknown as RunSpec;

    await runReActLoop(spec);

    // run 层 catch 写了一条 error 记录，且带 layer:'run' + category/message
    expect(errorWrites.length).toBe(1);
    expect(errorWrites[0]!.layer).toBe('run');
    expect(errorWrites[0]!.sessionId).toBe('s1');
    expect(errorWrites[0]!.runId).toBe('r1');
    expect(errorWrites[0]!.message).toBe('llm boom');
    expect(errorWrites[0]!.category).toBeDefined();
  });
});

// ============================================================
// [v0.0.235] RunResult.usage 聚合：每轮 callLLM usage 经 sumUsage 累加进返回值
//   spec session_usage §6.1（forked caller 按结束总量一次性累计）+ §10（RunResult.usage 聚合）
//   覆盖三条 exit 路径：pre-loop abort 空 / interrupted 已累加 / 正常退出全量 Σ
// ============================================================

/** 造最小 spec（wireInitState 跳真实 state init；其余依赖 mock 模块） */
function buildSpec(opts: { aborted?: boolean } = {}): RunSpec {
  return {
    sessionId: 's1',
    runId: 'r1',
    runKind: 'summary',
    scopeId: 'forked-1',
    controller: { aborted: opts.aborted ?? false },
    config: { sessionId: 's1' },
    observability: {
      reset: vi.fn(),
      startTrace: vi.fn(),
      endTrace: vi.fn(),
      startStepSpan: vi.fn(),
      endStepSpan: vi.fn(),
      markTraceError: vi.fn(),
    },
    wireEmitCtx: { bus: { clearReplay: vi.fn() } },
    wireStore: null,
    wireInitState: async () => ({
      ingestUpTo: null, llmUpTo: null, snapshot: {
        system: { id: 'sys', sessionId: 's1', role: 'system', content: [] },
        messages: [], inputCharCount: 0,
        contextWindowUsage: { systemTokens: 0, messageTokens: 0, toolTokens: 0, totalTokens: 0, maxOutputTokens: 0, tokenLimit: 0, remainingTokens: 0 },
        summary: null,
      }, step: 0, done: false,
    }),
    lifecycle: { onUsage: vi.fn(), onRunEnd: vi.fn(), onInterrupted: vi.fn() },
    toolDefinitions: [],
    message: undefined,
    maxIter: 10,
  } as unknown as RunSpec;
}

describe('[v0.0.235] RunResult.usage 聚合（每轮 callLLM usage Σ 进返回值）', () => {
  it('正常退出：多轮 callLLM usage 全量 Σ 进 RunResult.usage', async () => {
    (prepareStage as ReturnType<typeof vi.fn>).mockResolvedValue('ok');
    (ingestAssistant as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (runTryCompact as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (extractToolCalls as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const usages = [
      { total_tokens: 100, cost: 0.01, input_total_tokens: 80 },
      { total_tokens: 50, cost: 0.005, input_total_tokens: 40, output_total_tokens: 30 },
    ];
    let round = 0;
    (callLLMForSpec as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const usage = usages[round++]!;
      return {
        assistant: { id: `a${round}`, sessionId: 's1', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        usage,
      };
    });
    // 第 1 轮后 hasPendingInput=true（continue 再跑一轮）；第 2 轮后 false（break）
    (hasPendingInput as ReturnType<typeof vi.fn>).mockImplementation(async () => round < 2);

    const result = await runReActLoop(buildSpec());

    expect(round).toBe(2); // 两次 callLLM
    expect(result.usage.total_tokens).toBe(150);
    expect(result.usage.cost).toBeCloseTo(0.015, 6);
    expect(result.usage.input_total_tokens).toBe(120);
    expect(result.usage.output_total_tokens).toBe(30);
  });

  it('interrupted：中断时带已累加的 usage（不含未发生的轮）', async () => {
    (prepareStage as ReturnType<typeof vi.fn>).mockResolvedValue('ok');
    (ingestAssistant as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (runTryCompact as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (extractToolCalls as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const spec = buildSpec();
    let round = 0;
    (callLLMForSpec as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const usage = { total_tokens: 100, cost: 0.01 };
      round++;
      // 第 1 轮 callLLM 返回后立即标 aborted → L155 abort check 触发 interrupted break
      (spec.controller as { aborted: boolean }).aborted = true;
      return {
        assistant: { id: 'a1', sessionId: 's1', role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        usage,
      };
    });
    (hasPendingInput as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const result = await runReActLoop(spec);

    expect(round).toBe(1); // 只发生 1 轮 callLLM
    expect(result.stopReason).toBe('interrupted');
    expect(result.usage.total_tokens).toBe(100); // 已累加第 1 轮
    expect(result.usage.cost).toBeCloseTo(0.01, 6);
  });

  it('pre-loop abort：未进 loop 直接返回 → usage 为空对象（等价现状，无回归）', async () => {
    // 清 call 历史（前面 test 的 callLLMForSpec 调用不污染本断言）
    (callLLMForSpec as ReturnType<typeof vi.fn>).mockClear();
    const spec = buildSpec({ aborted: true });

    const result = await runReActLoop(spec);

    expect(result.stopReason).toBe('interrupted');
    expect(result.rounds).toBe(0);
    expect(callLLMForSpec).not.toHaveBeenCalled();
    // 空对象：无数值字段被填
    expect(result.usage.total_tokens).toBeUndefined();
    expect(result.usage.cost).toBeUndefined();
  });
});
