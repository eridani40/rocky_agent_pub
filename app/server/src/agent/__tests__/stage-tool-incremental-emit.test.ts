/**
 * [v0.0.354 T1] executeAndEmit 增量 emit UT（黑盒：真实 engine + bus 帧收集 + mock obs）
 * 参考: specs/tech/version_logs/v0.0.354/change_plan.md（D1/D3 + 契约表 stage-tool 行 + tests 行）
 *       states/bugs/BUG-multi-tool-result-sse-batch-[open].md §3.6（span 时长失真修复）
 *
 * 覆盖：
 *   ① 帧序不变式：每 result 的 start/delta/end 三帧相邻（同 messageId），全部 result 帧
 *      先于 tool_execution_end（caller 侧 emit）；fast 帧显著先于 slow 帧（增量到达）
 *   ② span 修复：slow tool 的 span startTime 不含 fast tool 排队（start 逐个化，
 *      startTime=该 tool 真实开始时刻；旧实现批量 t0 预起 → slow span 被拉长）
 *   ③ HITL pending 混合：ask-pending 占位 block 与普通 result 同序返回，pending 队列正常
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { executeAndEmit } from '../agent-loop-stage-tool';
import { ToolExecutionEngine } from '../../tools/engine';
import { ReplayableEventBus } from '../event-bus';
import { groupKeyForRunKind } from '../agent-interface';
import { emitToolExecutionEnd } from '../agent-loop-emitters';
import type { EmitContext } from '../agent-loop-emitters';
import type { LoopObservability } from '../agent-loop-observability';
import type { Tool, ToolRunResult } from '../../tools/types';
import { textResult } from '../../tools/types';
import type { ToolCallBlock } from '../../message/types';
import type { SpanHandle } from '../../observability/types';

function callBlock(id: string, name: string, args: Record<string, unknown> = {}): ToolCallBlock {
  return { type: 'tool_call', id, name, arguments: args };
}

function makeConfig(tools: Tool[]): { tools: Tool[]; workdir: string; sessionId: string } {
  return { tools, workdir: '/tmp', sessionId: 'session-emit' };
}

function tool(name: string, run: Tool['run']): Tool {
  return {
    definition: { name, description: `tool ${name}`, inputSchema: { type: 'object' } },
    run,
  };
}

function makeEmitCtx(bus: ReplayableEventBus): EmitContext {
  return {
    sessionId: 'session-emit',
    runId: 'run-1',
    runKind: 'main',
    bus,
    now: () => new Date().toISOString(),
  };
}

function makeObs(): {
  obs: LoopObservability;
  startSpy: ReturnType<typeof vi.fn>;
  endSpy: ReturnType<typeof vi.fn>;
} {
  const startSpy = vi.fn(
    (): SpanHandle => ({ kind: 'span', id: 'span-tool', parent: { kind: 'trace', id: 'trace-1' } }),
  );
  const endSpy = vi.fn();
  return { obs: { startToolSpan: startSpy, endToolSpan: endSpy } as unknown as LoopObservability, startSpy, endSpy };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('executeAndEmit 增量 emit（v0.0.354 T1）', () => {
  it('帧序不变式：每 result 三帧相邻 + 全部 result 帧先于 execution_end + fast 帧先于 slow 帧', async () => {
    vi.useFakeTimers();
    const bus = new ReplayableEventBus();
    const emitCtx = makeEmitCtx(bus);
    const group = groupKeyForRunKind('session-emit', 'main');
    const frames: { type: string; toolCallId?: string; messageId?: string }[] = [];
    const collector = (async () => {
      for await (const ev of bus.subscribe(group)) {
        const d = ev.data as { type: string; toolCallId?: string; messageId?: string };
        frames.push(d);
        if (frames.length >= 10) break; // 9 result 帧 + 1 execution_end
      }
    })();

    const fastA = tool('fastA', async () => textResult('A'));
    const slowB = tool('slowB', () =>
      new Promise<ToolRunResult>((res) => {
        setTimeout(() => res(textResult('B')), 100);
      }),
    );
    const fastC = tool('fastC', async () => textResult('C'));
    const engine = new ToolExecutionEngine();
    const { obs } = makeObs();
    const p = executeAndEmit({
      toolEngine: engine,
      config: makeConfig([fastA, slowB, fastC]),
      toolCalls: [callBlock('cA', 'fastA'), callBlock('cB', 'slowB'), callBlock('cC', 'fastC')],
      allowedTools: ['fastA', 'slowB', 'fastC'],
      emitCtx,
      obs,
    });

    // 推进 0ms：fastA 完成 → A 三帧（slowB 未到，fastC 串行在后未到）
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.map((f) => f.type)).toEqual([
      'tool_result_start', 'tool_result_delta', 'tool_result_end',
    ]);
    // 推进 100ms：slowB 完成 → B 三帧；fastC 随 B 完成立即执行 → C 三帧
    await vi.advanceTimersByTimeAsync(100);
    expect(frames.map((f) => f.type)).toEqual([
      'tool_result_start', 'tool_result_delta', 'tool_result_end',
      'tool_result_start', 'tool_result_delta', 'tool_result_end',
      'tool_result_start', 'tool_result_delta', 'tool_result_end',
    ]);
    const { results, pending } = await p;
    // caller 侧（run-react-loop 编排）：executeAndEmit 返回后 emit execution_end
    emitToolExecutionEnd(emitCtx, 3, 0);
    await Promise.resolve();
    await Promise.resolve();
    expect(frames).toHaveLength(10);
    expect(frames[9]!.type).toBe('tool_execution_end'); // 全部 result 帧先于 execution_end

    // 每 result 三帧共享 messageId（独立绑定）
    for (const base of [0, 3, 6]) {
      expect(frames[base]!.messageId).toBe(frames[base + 1]!.messageId);
      expect(frames[base]!.messageId).toBe(frames[base + 2]!.messageId);
    }
    // toolCallId 绑定
    expect(frames[0]!.toolCallId).toBe('cA');
    expect(frames[3]!.toolCallId).toBe('cB');
    expect(frames[6]!.toolCallId).toBe('cC');
    // 返回值契约不变
    expect(results).toHaveLength(3);
    expect(pending).toEqual([]);
  });

  it('span 修复：slow tool 的 span startTime 不含 fast tool 排队时间（start 逐个化）', async () => {
    vi.useFakeTimers();
    const { obs, startSpy, endSpy } = makeObs();
    const engine = new ToolExecutionEngine();
    const bus = new ReplayableEventBus();
    const emitCtx = makeEmitCtx(bus);
    const midA = tool('midA', () =>
      new Promise<ToolRunResult>((res) => {
        setTimeout(() => res(textResult('A')), 50);
      }),
    );
    const slowB = tool('slowB', () =>
      new Promise<ToolRunResult>((res) => {
        setTimeout(() => res(textResult('B')), 100);
      }),
    );
    const p = executeAndEmit({
      toolEngine: engine,
      config: makeConfig([midA, slowB]),
      toolCalls: [callBlock('cA', 'midA'), callBlock('cB', 'slowB')],
      allowedTools: ['midA', 'slowB'],
      emitCtx,
      obs,
    });

    await vi.advanceTimersByTimeAsync(50); // midA 完成（t50）→ 回调 A + span A end
    expect(startSpy).toHaveBeenCalledTimes(1); // 进一个起一个（slowB 未开始时不起 span）
    await vi.advanceTimersByTimeAsync(100); // slowB 完成（t150）→ 回调 B + span B end
    await p;
    expect(startSpy).toHaveBeenCalledTimes(2);

    // endToolSpan 收到的 startTime：A = execute 起点（t0）；B = A 完成时刻（t50）
    // → B 的 span 起点不含 A 的排队时间（旧实现批量 t0 预起，B span 被拉长 50ms）
    const startA = endSpy.mock.calls[0]![2] as Date;
    const startB = endSpy.mock.calls[1]![2] as Date;
    expect(startB.getTime() - startA.getTime()).toBeGreaterThanOrEqual(50);
    // durationMs 语义回归真实执行时长：B = t150 - t50 = 100ms（真实执行 100ms，非 150ms 含排队）
    const durationB = Date.now() - startB.getTime();
    expect(durationB).toBeGreaterThanOrEqual(100);
  });

  it('HITL pending 混合：ask-pending 占位 block 与普通 result 同序返回 + 帧也逐个发', async () => {
    const bus = new ReplayableEventBus();
    const emitCtx = makeEmitCtx(bus);
    const group = groupKeyForRunKind('session-emit', 'main');
    const frames: { type: string; toolCallId?: string }[] = [];
    const collector = (async () => {
      for await (const ev of bus.subscribe(group)) {
        const d = ev.data as { type: string; toolCallId?: string };
        frames.push(d);
        if (frames.length >= 6) break; // 2 result × 3 帧
      }
    })();

    const askTool: Tool = {
      definition: { name: 'bash', description: 'd', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'ask', reason: '需批准', approvalKey: 'k:1' }),
      run: async () => textResult('no'),
    };
    const okTool = tool('ok', async () => textResult('ok'));
    const engine = new ToolExecutionEngine(); // fresh 实例未记忆 → ask 未批准 → pending
    const { results, pending } = await executeAndEmit({
      toolEngine: engine,
      config: makeConfig([askTool, okTool]),
      toolCalls: [callBlock('cAsk', 'bash'), callBlock('cOk', 'ok')],
      allowedTools: ['bash', 'ok'],
      emitCtx,
      obs: makeObs().obs,
      opts: { runId: 'run-1' },
    });
    await Promise.resolve();
    await Promise.resolve();

    // 返回值契约：results 等长同序（pending 占位 block 在 results[0]），pending 队列正常
    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBe('pending');
    expect(results[1]!.status).toBeUndefined();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.toolCallId).toBe('cAsk');
    // pending 占位 block 也经 emit 暴露（帧逐 result 发，两 result 各三帧相邻）
    expect(frames.map((f) => f.type)).toEqual([
      'tool_result_start', 'tool_result_delta', 'tool_result_end',
      'tool_result_start', 'tool_result_delta', 'tool_result_end',
    ]);
    expect(frames[0]!.toolCallId).toBe('cAsk');
    expect(frames[3]!.toolCallId).toBe('cOk');
  });
});
