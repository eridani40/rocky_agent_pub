/**
 * [v0.0.130.hang 模块 A] ToolExecutionEngine.runTool 超时 race UT（白盒）
 * 参考: specs/tech/version_logs/v0.0.130.hang/change_plan.md 模块 A
 *       specs/tech/agent/tools/[P0]tool_execution_engine.md §4
 *
 * 覆盖（走 engine.execute 公开入口，runTool 私有不直接测）：
 *   - 卡死 fake tool（run 永不 resolve）→ 超时命中 → controller.abort() 触发（ctx.signal aborted）
 *     + 返回 [timeout] 前缀的 isError tool_result
 *   - 正常 fake tool 立即 resolve → 结果透传 + timer 被清理（vi.getTimerCount()===0，无悬挂定时器）
 *   - fake tool 返回 isError=true（非超时的正常错误）→ 原样透传，不被超时逻辑覆盖
 *   - HITL（checkPermission=ask 未批准）→ 结构性不进 runTool race：run 从不被调、
 *     execute 期间不产生任何计时器（vi.getTimerCount()===0），即使推进远超硬天花板的时间
 *
 * 用 vi.useFakeTimers() + advanceTimersByTimeAsync 保证确定性（不真实等待 backstop GRACE 5s）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToolExecutionEngine } from '../engine';
import { TIMEOUT_GRACE_MS } from '../engine-timeout';
import type { Tool, ToolCtx, ToolInput, ToolRunResult, PermissionDecision } from '../types';
import { textResult, errorResult } from '../types';
import type { ToolCallBlock } from '../../message/types';

function callBlock(id: string, name: string, args: Record<string, unknown> = {}): ToolCallBlock {
  return { type: 'tool_call', id, name, arguments: args };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ToolExecutionEngine.runTool 超时 race（v0.0.130.hang 模块 A）', () => {
  it('卡死 tool（run 永不 resolve）→ 超时命中 → abort 触发 + [timeout] isError result', async () => {
    vi.useFakeTimers();
    let sawAbort = false;
    const hangTool: Tool = {
      definition: { name: 'hang', description: 'never resolves', inputSchema: { type: 'object' } },
      defaultTimeoutMs: 1000, // effective=1000（无 per-call）；backstop=1000+GRACE(5000)=6000ms
      run: (_input: ToolInput, ctx: ToolCtx): Promise<ToolRunResult> =>
        new Promise(() => {
          // 永不 resolve/reject；只监听 abort 证明 controller.abort() 被真实触发
          ctx.signal?.addEventListener('abort', () => {
            sawAbort = true;
          });
        }),
    };
    const engine = new ToolExecutionEngine();
    const config = { tools: [hangTool], workdir: '/tmp' };
    const resultPromise = engine.execute(config, [callBlock('c1', 'hang')]);

    // 推进到 backstop 触发点之后
    await vi.advanceTimersByTimeAsync(1000 + TIMEOUT_GRACE_MS + 1);
    const { results } = await resultPromise;

    expect(sawAbort).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    const text = results[0]!.content[0];
    expect(text?.type).toBe('text');
    expect((text as { text: string }).text).toMatch(/^\[timeout\] hang exceeded 1000ms/);
  });

  it('正常 tool 立即 resolve → 结果透传 + timer 被清理（无悬挂定时器）', async () => {
    vi.useFakeTimers();
    const fastTool: Tool = {
      definition: { name: 'fast', description: 'resolves immediately', inputSchema: { type: 'object' } },
      defaultTimeoutMs: 5000,
      run: async (): Promise<ToolRunResult> => textResult('fast-ok'),
    };
    const engine = new ToolExecutionEngine();
    const config = { tools: [fastTool], workdir: '/tmp' };
    const { results } = await engine.execute(config, [callBlock('c1', 'fast')]);

    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(false);
    // timer 必须已被 finally 清理，不留悬挂定时器（否则 vi.getTimerCount() 仍 > 0）
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tool 返回 isError=true（正常错误，非超时）→ 原样透传', async () => {
    vi.useFakeTimers();
    const failingTool: Tool = {
      definition: { name: 'failing', description: 'returns isError', inputSchema: { type: 'object' } },
      defaultTimeoutMs: 5000,
      run: async (): Promise<ToolRunResult> => errorResult('业务错误：文件不存在'),
    };
    const engine = new ToolExecutionEngine();
    const config = { tools: [failingTool], workdir: '/tmp' };
    const { results } = await engine.execute(config, [callBlock('c1', 'failing')]);

    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBe(true);
    const text = results[0]!.content[0];
    expect((text as { text: string }).text).toBe('业务错误：文件不存在');
    // 不应被超时文案覆盖
    expect((text as { text: string }).text).not.toMatch(/\[timeout\]/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('per-call timeout（call.arguments.timeout）优先于 per-tool defaultTimeoutMs 生效', async () => {
    vi.useFakeTimers();
    const hangTool: Tool = {
      definition: { name: 'hang2', description: 'never resolves', inputSchema: { type: 'object' } },
      defaultTimeoutMs: 100000, // per-tool 很大，但 per-call=1500 应生效
      run: () => new Promise(() => {}),
    };
    const engine = new ToolExecutionEngine();
    const config = { tools: [hangTool], workdir: '/tmp' };
    const resultPromise = engine.execute(config, [callBlock('c1', 'hang2', { timeout: 1500 })]);

    await vi.advanceTimersByTimeAsync(1500 + TIMEOUT_GRACE_MS + 1);
    const { results } = await resultPromise;

    expect(results[0]!.isError).toBe(true);
    expect((results[0]!.content[0] as { text: string }).text).toMatch(/^\[timeout\] hang2 exceeded 1500ms/);
  });

  it('HITL（checkPermission=ask 未批准）→ 结构性不进 runTool race：run 不被调，无计时器产生', async () => {
    vi.useFakeTimers();
    const runSpy = vi.fn(async (): Promise<ToolRunResult> => textResult('should-not-run'));
    const askTool: Tool = {
      definition: { name: 'dangerous', description: 'needs approval', inputSchema: { type: 'object' } },
      defaultTimeoutMs: 10, // 即使声明极短超时，HITL 分支也不应受影响（结构性豁免，非计时对抗）
      checkPermission(): PermissionDecision {
        return { behavior: 'ask', reason: '危险操作', approvalKey: 'dangerous:policy1' };
      },
      run: runSpy,
    };
    const engine = new ToolExecutionEngine();
    const config = { tools: [askTool], sessionId: 's1', workdir: '/tmp' };
    const { results, pending } = await engine.execute(config, [callBlock('c1', 'dangerous')]);

    // pending 分支产出，run 从未被调用
    expect(runSpy).not.toHaveBeenCalled();
    expect(pending).toHaveLength(1);
    expect(results[0]!.status).toBe('pending');
    expect(results[0]!.isError).toBe(false);
    // 关键：execute() 全程未创建任何计时器（HITL 分支在 runTool 之前 continue，
    // 根本不会建 AbortController/setTimeout；即使把时间推极远，也不该有任何 backstop 触发）
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(700000); // 远超硬天花板 600000
    expect(runSpy).not.toHaveBeenCalled();
  });
});
