/**
 * RunLoopHandle.start() per-run 回收 UT（v0.0.83.forked_per_run_isolation + v0.0.204 T3 合并）
 * 参考: states/v0.0.83.forked_per_run_isolation/change_plan.md §4（回收单一 chokepoint）
 *
 * 验证用户强调的「注意回收，不要内存泄漏」：
 *   - 成功路径：runReActLoop 正常 return → finally 调 clearScopeSession(scopeId, sid, {runId})
 *   - 抛错路径：runReActLoop throw → finally 仍调 clearScopeSession（reject 传播前释放，防泄漏）
 *   - 释放 key 含 runId（per-run 隔离回收，不是 sid）
 *
 * 直接构造 RunLoopHandle（releasesScopeSession=true 模拟旁路 run）+ mock runReActLoop + spy
 *   contextEngine.clearScopeSession，不需要完整 EP 装配（测的是 finally 胶水）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock 用绝对路径（memory: test-vitest-mock-absolute-path）+ vi.hoisted（被提升到文件顶）。
const { runReActLoopMock, runLoopHandlePath, reactLoopPath } = vi.hoisted(() => {
  const { resolve } = require('node:path') as typeof import('node:path');
  return {
    runReActLoopMock: vi.fn(),
    runLoopHandlePath: resolve(__dirname, '../run-loop-handle'),
    reactLoopPath: resolve(__dirname, '../run-react-loop'),
  };
});

vi.mock(reactLoopPath, () => ({ runReActLoop: runReActLoopMock }));

import { RunLoopHandle } from '../run-loop-handle';
import type { RunSpec, RunResult } from '../loop-ports';

function mkSpec(overrides: { scopeId?: string; sessionId?: string; runId?: string; clearScopeSession?: ReturnType<typeof vi.fn> } = {}): { spec: RunSpec; clearScopeSession: ReturnType<typeof vi.fn> } {
  const clearScopeSession = overrides.clearScopeSession ?? vi.fn(async (): Promise<void> => { /* spy */ });
  const spec = {
    scopeId: overrides.scopeId ?? 'forked',
    sessionId: overrides.sessionId ?? 'sess-1',
    runId: overrides.runId ?? 'run-1',
    wireContextEngine: { clearScopeSession },
  } as unknown as RunSpec;
  return { spec, clearScopeSession };
}

const okResult = { answer: 'x', usage: {}, stopReason: 'stop', rounds: 1 } as unknown as RunResult;

beforeEach(() => {
  runReActLoopMock.mockReset();
  runReActLoopMock.mockResolvedValue(okResult);
});

describe('[v0.0.83/T3] RunLoopHandle.start() per-run 回收（旁路 run finally 单一 chokepoint）', () => {
  it('成功路径：runReActLoop return → finally 调 clearScopeSession(scopeId, sid, {runId})', async () => {
    const { spec, clearScopeSession } = mkSpec({ scopeId: 'forked', sessionId: 'sess-A', runId: 'run-A' });
    const loop = new RunLoopHandle('summary', spec, true);
    await loop.start();
    expect(runReActLoopMock).toHaveBeenCalledTimes(1);
    // 回收：scopeId + 真 sid + opts.runId（per-run 桶 key）
    expect(clearScopeSession).toHaveBeenCalledWith('forked', 'sess-A', { runId: 'run-A' });
  });

  it('抛错路径：runReActLoop throw → finally 仍释放（reject 传播前，防泄漏）', async () => {
    runReActLoopMock.mockRejectedValue(new Error('loop-boom'));
    const { spec, clearScopeSession } = mkSpec({ runId: 'run-err' });
    const loop = new RunLoopHandle('summary', spec, true);
    await expect(loop.start()).rejects.toThrow('loop-boom');
    // 关键：即便抛错，finally 仍清桶——无泄漏路径
    expect(clearScopeSession).toHaveBeenCalledWith('forked', 'sess-1', { runId: 'run-err' });
  });

  it('释放 key 是 runId（per-run），不同 runId 的 handle 各自释放自己的桶', async () => {
    const { spec: spec1, clearScopeSession: clear1 } = mkSpec({ runId: 'run-sibling-1' });
    const { spec: spec2, clearScopeSession: clear2 } = mkSpec({ runId: 'run-sibling-2' });
    await new RunLoopHandle('summary', spec1, true).start();
    await new RunLoopHandle('consolidate', spec2, true).start();
    expect(clear1).toHaveBeenCalledWith('forked', 'sess-1', { runId: 'run-sibling-1' });
    expect(clear2).toHaveBeenCalledWith('forked', 'sess-1', { runId: 'run-sibling-2' });
  });

  it('start() 未调 → clearScopeSession 未调（slot 未分配即无可漏）', async () => {
    const { spec, clearScopeSession } = mkSpec();
    // 不调 start()——wireInitState 在 runReActLoop 内，未跑 → 无桶分配
    const _loop = new RunLoopHandle('summary', spec, true);
    void _loop;
    expect(clearScopeSession).not.toHaveBeenCalled();
  });

  it('main run（releasesScopeSession=false）→ finally 不调 clearScopeSession（main 无 per-run buffer）', async () => {
    const { spec, clearScopeSession } = mkSpec({ scopeId: 'default' });
    await new RunLoopHandle('main', spec, false).start();
    // main 路径不释放 scope session（无 in_memory buffer 桶）
    expect(clearScopeSession).not.toHaveBeenCalled();
  });
});

// ============================================================
// v0.0.207 T2：revokeSideEffects（authority transfer 入口）
// ============================================================

describe('[v0.0.207 T2] RunLoopHandle.revokeSideEffects（可选第 4 参 revokeFn）', () => {
  it('未传 revokeFn（3 参构造，forked 兼容）→ revokeSideEffects() no-op 不抛错', () => {
    const { spec } = mkSpec();
    const loop = new RunLoopHandle('summary', spec, true);
    expect(() => loop.revokeSideEffects()).not.toThrow();
  });

  it('传 revokeFn → revokeSideEffects() 调用 revokeFn 一次', () => {
    const { spec } = mkSpec();
    const revokeFn = vi.fn();
    const loop = new RunLoopHandle('main', spec, false, revokeFn);
    loop.revokeSideEffects();
    expect(revokeFn).toHaveBeenCalledTimes(1);
  });

  it('多次调 revokeSideEffects → 每次都触发 revokeFn（幂等不缓存）', () => {
    const { spec } = mkSpec();
    const revokeFn = vi.fn();
    const loop = new RunLoopHandle('main', spec, false, revokeFn);
    loop.revokeSideEffects();
    loop.revokeSideEffects();
    loop.revokeSideEffects();
    expect(revokeFn).toHaveBeenCalledTimes(3);
  });

  it('revokeSideEffects 不影响 start() 流程（独立副作用入口，由 abort api 时机调用）', async () => {
    const { spec, clearScopeSession } = mkSpec({ scopeId: 'forked', runId: 'r-A' });
    const revokeFn = vi.fn();
    const loop = new RunLoopHandle('summary', spec, true, revokeFn);
    // 在 start 之前调 revoke
    loop.revokeSideEffects();
    expect(revokeFn).toHaveBeenCalledTimes(1);
    // start 仍正常工作，clearScopeSession 仍调（revokeFn 与 finally 独立）
    await loop.start();
    expect(clearScopeSession).toHaveBeenCalledWith('forked', 'sess-1', { runId: 'r-A' });
  });
});
