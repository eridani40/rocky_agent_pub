/**
 * [v0.0.354 T1] ToolExecutionEngine onResult 增量回调 UT（白盒）
 * 参考: specs/tech/version_logs/v0.0.354/change_plan.md（D1/D2 + 契约表 engine 行 + tests 行）
 *       states/bugs/BUG-multi-tool-result-sse-batch-[open].md §5 方案 A（engine 增量回调）
 *
 * 覆盖：
 *   ① 快慢工具时序：回调序 [A,B,C] + A 回调显著早于 B（fake timers 确定性推进）
 *   ② 7 条产出路径逐一触发 onResult（白名单外 reject / 未注册 / invalid-input / deny /
 *      ask-pending / interaction-pending / runTool 正常 + runTool 超时）
 *   ③ onResult 抛错不影响执行主流程与返回值（fail-silent，对齐 writeToolLog）
 *   ④ 不传 onResult 行为不变（回归零变化）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolExecutionEngine } from '../engine';
import { ApprovalManager } from '../approval-manager';
import type { Tool, ToolInteraction, ToolRunResult } from '../types';
import { textResult } from '../types';
import type { ToolCallBlock, ToolResultBlock } from '../../message/types';

function callBlock(id: string, name: string, args: Record<string, unknown> = {}): ToolCallBlock {
  return { type: 'tool_call', id, name, arguments: args };
}

function makeConfig(tools: Tool[]): { tools: Tool[]; workdir: string; sessionId: string } {
  return { tools, workdir: '/tmp', sessionId: 'session-onresult' };
}

function simpleTool(name: string, run?: Tool['run']): Tool {
  return {
    definition: { name, description: `tool ${name}`, inputSchema: { type: 'object' } },
    run: run ?? (async (): Promise<ToolRunResult> => textResult(`${name}-ok`)),
  };
}

/** 取 ToolResultBlock 的首个 text block 文本 */
function textOf(r: ToolResultBlock | undefined): string {
  if (!r || !r.content || r.content.length === 0) return '';
  const first = r.content[0];
  return first && typeof first === 'object' && first.type === 'text' ? first.text : '';
}

afterEach(() => {
  vi.useRealTimers();
});

describe('onResult 快慢工具时序（v0.0.354 T1）', () => {
  it('回调序 [A,B,C] 且 A 显著早于 B（fake timers 推进）', async () => {
    vi.useFakeTimers();
    const ticks: number[] = [];
    const callbacks: string[] = [];
    const fastA = simpleTool('fastA', async () => {
      ticks.push(Date.now());
      return textResult('A');
    });
    const slowB = simpleTool('slowB', () =>
      new Promise<ToolRunResult>((res) => {
        setTimeout(() => {
          ticks.push(Date.now());
          res(textResult('B'));
        }, 100);
      }),
    );
    const fastC = simpleTool('fastC', async () => {
      ticks.push(Date.now());
      return textResult('C');
    });
    const engine = new ToolExecutionEngine();
    const calls = [callBlock('cA', 'fastA'), callBlock('cB', 'slowB'), callBlock('cC', 'fastC')];
    const p = engine.execute(makeConfig([fastA, slowB, fastC]), calls, undefined, {
      onResult: (_r, i) => callbacks.push(calls[i]!.name),
    });

    // 推进 0ms：fastA 的 microtask 完成 → 仅 A 回调（slowB 未到、fastC 串行在后未到）
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks).toEqual(['fastA']);
    const tA = ticks[0]!;

    // 推进 100ms：slowB 完成（timer 触发）→ B 回调；串行语义下 fastC 的 microtask 随 B 完成立即执行 → C 回调
    await vi.advanceTimersByTimeAsync(100);
    expect(callbacks).toEqual(['fastA', 'slowB', 'fastC']);
    expect(ticks[1]! - tA).toBeGreaterThanOrEqual(100); // B 显著晚于 A（A 先到，不被 B 扣住）

    const { results, pending } = await p;
    expect(results.map((r) => textOf(r))).toEqual(['A', 'B', 'C']);
    expect(pending).toEqual([]);
  });
});

describe('onResult 7 条产出路径逐一触发（v0.0.354 T1）', () => {
  it('① 白名单外 reject → 回调触发 + isError + not in whitelist', async () => {
    const engine = new ToolExecutionEngine();
    const seen: { i: number; isError: boolean }[] = [];
    const { results } = await engine.execute(
      makeConfig([simpleTool('read')]),
      [callBlock('c1', 'read')],
      ['bash'],
      { onResult: (r, i) => seen.push({ i, isError: r.isError }) },
    );
    expect(seen).toEqual([{ i: 0, isError: true }]);
    expect(textOf(results[0])).toMatch(/not in whitelist/);
  });

  it('② 未注册 → 回调触发 + not registered', async () => {
    const engine = new ToolExecutionEngine();
    const seen: number[] = [];
    const { results } = await engine.execute(makeConfig([]), [callBlock('c1', 'foo_unknown')], undefined, {
      onResult: (_r, i) => seen.push(i),
    });
    expect(seen).toEqual([0]);
    expect(textOf(results[0])).toMatch(/not registered/);
  });

  it('③ invalid-input → 回调触发 + INVALID_INPUT', async () => {
    const tool: Tool = {
      definition: {
        name: 'needPath',
        description: 'd',
        inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      },
      run: async () => textResult('x'),
    };
    const engine = new ToolExecutionEngine();
    const seen: number[] = [];
    const { results } = await engine.execute(makeConfig([tool]), [callBlock('c1', 'needPath', {})], undefined, {
      onResult: (_r, i) => seen.push(i),
    });
    expect(seen).toEqual([0]);
    expect(textOf(results[0])).toMatch(/invalid_input/);
  });

  it('④ deny → 回调触发 + isError 不悬挂', async () => {
    const tool: Tool = {
      definition: { name: 'bash', description: 'd', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'deny', reason: '策略拒绝' }),
      run: async () => textResult('no'),
    };
    const engine = new ToolExecutionEngine(new ApprovalManager());
    const seen: { i: number; pending: boolean }[] = [];
    const { results, pending } = await engine.execute(makeConfig([tool]), [callBlock('c1', 'bash')], undefined, {
      onResult: (r, i) => seen.push({ i, pending: r.status === 'pending' }),
    });
    expect(seen).toEqual([{ i: 0, pending: false }]);
    expect(results[0]!.isError).toBe(true);
    expect(pending).toEqual([]);
  });

  it('⑤ ask 未批准 → 回调触发 + pending 占位 block', async () => {
    const tool: Tool = {
      definition: { name: 'bash', description: 'd', inputSchema: { type: 'object' } },
      checkPermission: () => ({ behavior: 'ask', reason: '需批准', approvalKey: 'k:1' }),
      run: async () => textResult('no'),
    };
    const engine = new ToolExecutionEngine(new ApprovalManager()); // fresh 实例未记忆 → 未批准
    const seen: { i: number; status?: string }[] = [];
    const { results, pending } = await engine.execute(makeConfig([tool]), [callBlock('c1', 'bash')], undefined, {
      runId: 'r1',
      onResult: (r, i) => seen.push({ i, status: r.status }),
    });
    expect(seen).toEqual([{ i: 0, status: 'pending' }]);
    expect(results[0]!.status).toBe('pending');
    expect(pending).toHaveLength(1);
  });

  it('⑥ interaction 悬挂 → 回调触发 + pending 占位 block', async () => {
    const interaction: ToolInteraction = {
      subType: 'need_feedback',
      handleType: 'direct_result',
      data: {
        prompt: 'p',
        questions: [{ id: 'q1', title: 't', type: 'single', options: [{ key: 'a', label: 'A' }], allowOther: false }],
      },
    };
    const tool: Tool = {
      definition: { name: 'askme', description: 'd', inputSchema: { type: 'object' } },
      interaction: () => interaction,
      run: async () => textResult('no'),
    };
    const engine = new ToolExecutionEngine();
    const seen: { i: number; status?: string }[] = [];
    const { results, pending } = await engine.execute(makeConfig([tool]), [callBlock('c1', 'askme')], undefined, {
      runId: 'r1',
      onResult: (r, i) => seen.push({ i, status: r.status }),
    });
    expect(seen).toEqual([{ i: 0, status: 'pending' }]);
    expect(results[0]!.status).toBe('pending');
    expect(pending).toHaveLength(1);
  });

  it('⑦ runTool 正常 → 回调触发 + 非错误结果', async () => {
    const engine = new ToolExecutionEngine();
    const seen: { i: number; isError: boolean }[] = [];
    const { results } = await engine.execute(makeConfig([simpleTool('ok')]), [callBlock('c1', 'ok')], undefined, {
      onResult: (r, i) => seen.push({ i, isError: r.isError }),
    });
    expect(seen).toEqual([{ i: 0, isError: false }]);
    expect(textOf(results[0])).toBe('ok-ok');
  });

  it('⑧ runTool 超时 → 回调触发 + [timeout] isError', async () => {
    vi.useFakeTimers();
    const hang: Tool = {
      definition: { name: 'hang', description: 'never resolves', inputSchema: { type: 'object' } },
      defaultTimeoutMs: 1000,
      run: () => new Promise<ToolRunResult>(() => {}), // 永不 resolve/reject
    };
    const engine = new ToolExecutionEngine();
    const seen: { i: number; isError: boolean }[] = [];
    const p = engine.execute(makeConfig([hang]), [callBlock('c1', 'hang')], undefined, {
      onResult: (r, i) => seen.push({ i, isError: r.isError }),
    });
    await vi.advanceTimersByTimeAsync(6000); // backstop = 1000 + GRACE(5000)
    const { results } = await p;
    expect(seen).toEqual([{ i: 0, isError: true }]);
    expect(textOf(results[0])).toMatch(/^\[timeout\]/);
  });
});

describe('onResult 健壮性（v0.0.354 T1）', () => {
  it('onResult 抛错 → 不影响执行主流程与返回值（fail-silent）', async () => {
    const engine = new ToolExecutionEngine();
    const calls = [callBlock('c1', 'a'), callBlock('c2', 'b')];
    const { results, pending } = await engine.execute(
      makeConfig([simpleTool('a'), simpleTool('b')]),
      calls,
      undefined,
      { onResult: () => { throw new Error('boom'); } },
    );
    expect(results).toHaveLength(2);
    expect(textOf(results[0])).toBe('a-ok');
    expect(textOf(results[1])).toBe('b-ok');
    expect(pending).toEqual([]);
  });

  it('不传 onResult → 行为不变（回归零变化）', async () => {
    const engine = new ToolExecutionEngine();
    const { results, pending } = await engine.execute(
      makeConfig([simpleTool('a')]),
      [callBlock('c1', 'a')],
    );
    expect(results).toHaveLength(1);
    expect(textOf(results[0])).toBe('a-ok');
    expect(pending).toEqual([]);
  });
});
