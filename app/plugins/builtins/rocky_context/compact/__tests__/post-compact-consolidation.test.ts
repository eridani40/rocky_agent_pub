/**
 * post-compact-consolidation handler tier1 锁接入单测（v0.0.80.t1 task-2）
 * 参考: specs/tech/version_logs/v0.0.80.t1/change_plan.md §2.3（tier1_consolidation 锁接入）
 *       specs/tech/agent/session/[P0]session_task_lock.md §6（实现落点）
 *
 * 覆盖 task-2 acceptance：
 *   - acquire('tier1_consolidation') 失败 → 静默跳过（不调 runner）
 *   - fork-2 完成 → markDone（release 锁）
 *   - fork-2 失败 → markFailed（release 锁）
 *   - 缺 taskLock（UT fixture）→ 不做锁守卫，仍启动 fork-2（兼容）
 *
 * 注：保留「runner 缺失 / 工具空跳过」既有 case 在 post-compact-eps.test.ts（与本文件互补）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PostCompactCtx } from '../../../../server/src/agent/compact-types';
import type { SessionTaskLock } from '../../../../server/src/agent/session-task-lock';
import MemorySkillConsolidationHandler from '../post-compact-consolidation';

/** 造假 PostCompactCtx（含 taskLock + 双快照 + 工具声明，触发 fork-2 路径） */
function fakeCtx(overrides: Partial<PostCompactCtx> = {}): PostCompactCtx {
  const snapshot = {
    system: { id: 's', sessionId: 'sid-c', role: 'system', content: [] } as never,
    messages: [
      { id: 'm1', sessionId: 'sid-c', role: 'user', content: [{ type: 'text', text: 'hi' }] } as never,
    ],
    inputCharCount: 10,
    contextWindowUsage: {
      systemTokens: 5, messageTokens: 5, toolTokens: 0,
      totalTokens: 10, maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 79990,
    },
    summary: null,
  } as never;
  return {
    config: { sessionId: 'sid-c' } as never,
    prevSnapshot: snapshot,
    postSnapshot: snapshot,
    store: { accumulateUsage: vi.fn(async () => ['sid-c']), notifyUsageChanged: vi.fn(async () => {}) } as never,
    scopeId: 'default',
    ...overrides,
  } as PostCompactCtx;
}

function fakeToolDefinitions() {
  return [
    { name: 'skill_manage', description: 'skill', inputSchema: { type: 'object', properties: {} } } as never,
    { name: 'memory_manage', description: 'memory', inputSchema: { type: 'object', properties: {} } } as never,
  ];
}

/**造假 SessionTaskLock（仅追踪 acquire/markDone/markFailed 调用） */
function fakeTaskLock(opts: {
  acquireResult?: boolean;
}): SessionTaskLock & {
  acquireCalls: Array<{ sid: string; taskType: string; runId?: string }>;
  markDoneCalls: Array<{ sid: string; taskType: string }>;
  markFailedCalls: Array<{ sid: string; taskType: string; error: string }>;
} {
  return {
    acquireCalls: [],
    markDoneCalls: [],
    markFailedCalls: [],
    acquire(sid, taskType, runId) {
      (this.acquireCalls as Array<{ sid: string; taskType: string; runId?: string }>).push({ sid, taskType, runId });
      return opts.acquireResult ?? true;
    },
    markDone(sid, taskType) {
      (this.markDoneCalls as Array<{ sid: string; taskType: string }>).push({ sid, taskType });
    },
    markFailed(sid, taskType, error) {
      (this.markFailedCalls as Array<{ sid: string; taskType: string; error: string }>).push({ sid, taskType, error });
    },
    release() {},
    getState() {
      return { status: 'idle', runId: null, startedAt: null, error: null };
    },
    reconcile() {
      return Promise.resolve({ reconciled: [] });
    },
  } as unknown as ReturnType<typeof fakeTaskLock>;
}

describe('[v0.0.80.t1 task-2] post-compact-consolidation tier1 锁接入', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('acquire tier1_consolidation 失败 → 静默跳过（不调 runner、不调 markDone/markFailed）', async () => {
    const handler = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const runner = vi.fn().mockResolvedValue({ answer: 'ok', usage: {} });
    const taskLock = fakeTaskLock({ acquireResult: false });
    const ctx = fakeCtx({
      consolidateRunner: runner,
      toolDefinitions: fakeToolDefinitions(),
      taskLock,
    });
    await handler.handle(ctx);
    // 等 microtask flush（fire-and-forget 链路，但 acquire 失败应同步 return）
    await new Promise((r) => setImmediate(r));

    expect(taskLock.acquireCalls.length).toBe(1);
    expect(taskLock.acquireCalls[0]!.taskType).toBe('tier1_consolidation');
    expect(taskLock.markDoneCalls.length).toBe(0);
    expect(taskLock.markFailedCalls.length).toBe(0);
    expect(runner).not.toHaveBeenCalled();
  });

  it('fork-2 成功完成 → markDone(sid, tier1_consolidation)', async () => {
    const handler = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const runner = vi.fn().mockResolvedValue({ answer: '整理完成', usage: { input_tokens: 10 } });
    const taskLock = fakeTaskLock({ acquireResult: true });
    const ctx = fakeCtx({
      consolidateRunner: runner,
      toolDefinitions: fakeToolDefinitions(),
      taskLock,
    });
    await handler.handle(ctx);
    // 等 microtask flush（fire-and-forget fork-2 完成）
    await new Promise((r) => setImmediate(r));

    expect(taskLock.acquireCalls[0]!.taskType).toBe('tier1_consolidation');
    expect(runner).toHaveBeenCalledOnce();
    expect(taskLock.markDoneCalls.length).toBe(1);
    expect(taskLock.markDoneCalls[0]!.sid).toBe('sid-c');
    expect(taskLock.markDoneCalls[0]!.taskType).toBe('tier1_consolidation');
    expect(taskLock.markFailedCalls.length).toBe(0);
  });

  it('fork-2 完成 → accumulateUsage(sid, forked, result.usage) 总量一次性累计（与 fork-1 同契约）', async () => {
    const handler = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const usage = { input_tokens: 42, output_tokens: 7 };
    const runner = vi.fn().mockResolvedValue({ answer: '整理完成', usage });
    const ctx = fakeCtx({
      consolidateRunner: runner,
      toolDefinitions: fakeToolDefinitions(),
    });
    await handler.handle(ctx);
    await new Promise((r) => setImmediate(r));

    expect(runner).toHaveBeenCalledOnce();
    const storeMock = ctx.store as unknown as { accumulateUsage: ReturnType<typeof vi.fn> };
    // 旁路 run usage 由 caller 按 run 结束总量累计一次（不经 lifecycle 逐调用，防双计）
    expect(storeMock.accumulateUsage).toHaveBeenCalledTimes(1);
    expect(storeMock.accumulateUsage).toHaveBeenCalledWith('sid-c', 'forked', usage);
  });

  it('[v0.0.235] accumulateUsage 后对 sid 链补 notifyUsageChanged（fork-2 caller 推送）', async () => {
    const handler = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const usage = { input_tokens: 42, output_tokens: 7 };
    const runner = vi.fn().mockResolvedValue({ answer: '整理完成', usage });
    // accumulateUsage 返多 sid 链（模拟递归 sub 上报）
    const chain = ['sid-c', 'parent-sid'];
    const ctx = fakeCtx({
      consolidateRunner: runner,
      toolDefinitions: fakeToolDefinitions(),
      store: {
        accumulateUsage: vi.fn(async () => chain),
        notifyUsageChanged: vi.fn(async () => {}),
      } as never,
    });
    await handler.handle(ctx);
    await new Promise((r) => setImmediate(r));

    const storeMock = ctx.store as unknown as {
      accumulateUsage: ReturnType<typeof vi.fn>;
      notifyUsageChanged: ReturnType<typeof vi.fn>;
    };
    // accumulateUsage 先 write，再对链上每个 sid 各 notify 一次（spec §3 顺序契约）
    expect(storeMock.accumulateUsage).toHaveBeenCalledOnce();
    expect(storeMock.notifyUsageChanged).toHaveBeenCalledTimes(chain.length);
    expect(storeMock.notifyUsageChanged.mock.calls[0]![0]).toBe('sid-c');
    expect(storeMock.notifyUsageChanged.mock.calls[1]![0]).toBe('parent-sid');
  });

  it('fork-2 失败 → markFailed(sid, tier1_consolidation, msg)', async () => {
    const handler = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const runner = vi.fn().mockRejectedValue(new Error('fork-2 LLM 失败'));
    const taskLock = fakeTaskLock({ acquireResult: true });
    const ctx = fakeCtx({
      consolidateRunner: runner,
      toolDefinitions: fakeToolDefinitions(),
      taskLock,
    });
    await handler.handle(ctx);
    await new Promise((r) => setImmediate(r));

    expect(runner).toHaveBeenCalledOnce();
    expect(taskLock.markFailedCalls.length).toBe(1);
    expect(taskLock.markFailedCalls[0]!.sid).toBe('sid-c');
    expect(taskLock.markFailedCalls[0]!.taskType).toBe('tier1_consolidation');
    expect(taskLock.markFailedCalls[0]!.error).toContain('fork-2 LLM 失败');
    expect(taskLock.markDoneCalls.length).toBe(0);
  });

  it('taskLock 缺省（UT fixture）→ 不做锁守卫，仍启动 fork-2（兼容）', async () => {
    const handler = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const runner = vi.fn().mockResolvedValue({ answer: 'ok', usage: {} });
    const ctx = fakeCtx({
      consolidateRunner: runner,
      toolDefinitions: fakeToolDefinitions(),
      // taskLock 不注入
    });
    await handler.handle(ctx);
    await new Promise((r) => setImmediate(r));

    expect(runner).toHaveBeenCalledOnce();
  });

  it('consolidateRunner 缺失 → 跳过（不 acquire 锁，不抛错）', async () => {
    const handler = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const taskLock = fakeTaskLock({ acquireResult: true });
    const ctx = fakeCtx({
      // consolidateRunner 不注入
      toolDefinitions: fakeToolDefinitions(),
      taskLock,
    });
    await handler.handle(ctx);
    await new Promise((r) => setImmediate(r));

    expect(taskLock.acquireCalls.length).toBe(0); // 早 return（runner 缺失）→ 不 acquire
    expect(taskLock.markDoneCalls.length).toBe(0);
    expect(taskLock.markFailedCalls.length).toBe(0);
  });

  it('task message = 纯 directive：不含 snapshot 对话内容（旁路不变量，与 fork-1 同契约）', async () => {
    const handler = new MemorySkillConsolidationHandler('memory_skill_consolidation');
    const runner = vi.fn().mockResolvedValue({ answer: 'ok', usage: {} });
    const ctx = fakeCtx({
      consolidateRunner: runner,
      toolDefinitions: fakeToolDefinitions(),
      prevSnapshot: {
        system: { id: 's', sessionId: 'sid-c', role: 'system', content: [] } as never,
        messages: [
          { id: 'm1', sessionId: 'sid-c', role: 'user', content: [{ type: 'text', text: 'SECRET-TRANSCRIPT-MARKER' }] } as never,
        ],
        inputCharCount: 10,
        contextWindowUsage: {
          systemTokens: 5, messageTokens: 5, toolTokens: 0,
          totalTokens: 10, maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 79990,
        },
        summary: null,
      } as never,
    });
    await handler.handle(ctx);
    await new Promise((r) => setImmediate(r));

    expect(runner).toHaveBeenCalledOnce();
    const input = runner.mock.calls[0]![0] as { userMessage: { content: Array<{ text: string }> } };
    const taskText = input.userMessage.content.map((b) => b.text).join('\n');
    // 对话历史只经 snapshot 进旁路 buffer，task text 绝不复述（复述 = 历史发两遍）
    expect(taskText).not.toContain('SECRET-TRANSCRIPT-MARKER');
    expect(taskText).not.toContain('[user]');
    // prevSnapshot（压缩前完整对话）原样透传给 runner（唯一信息源）
    expect((runner.mock.calls[0]![0] as { snapshot: unknown }).snapshot).toBe(ctx.prevSnapshot);
  });
});
