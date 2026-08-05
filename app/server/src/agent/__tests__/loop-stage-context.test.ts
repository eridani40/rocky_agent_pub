/**
 * loop-stage-context 触发点迁移 + 纯生产者原则单测（v0.0.80.t1 task-1）
 * 参考: specs/tech/version_logs/v0.0.80.t1/change_plan.md §1.0/§1.1/§2.1/§2.7
 *
 * 覆盖：
 *   - runTryCompact 不再 re-assemble 主 loop snapshot / setSystem / notifyUsageChanged（纯生产者）
 *   - runTryCompact 仍是 fire-and-forget（返 Promise<void>，caller void .catch）
 *
 * 注：ingestAssistant 不再触发 tryCompact 的断言由 run-react-loop.test.ts 集成验证（含 mock spy 验时机）。
 */
import { describe, it, expect, vi } from 'vitest';
import { runTryCompact } from '../loop-stage-context';
import type { RunSpec, LoopState } from '../loop-ports';
import type { ContextSnapshot, SessionConfig } from '../context-types';
import type { Message } from '../../message/types';

// vi.mock 被 vitest 提升到文件顶部（早于 import/const），故 path 用 vi.hoisted + require('node:path')
// + __dirname 派生（portable）；严禁硬编码 worktree 路径——merge 后失效（memory: test-vitest-mock-absolute-path）。
const { tryCompactPath } = vi.hoisted(() => {
  const { resolve } = require('node:path') as typeof import('node:path');
  return { tryCompactPath: resolve(__dirname, '../try-compact') };
});

vi.mock(tryCompactPath, () => ({
  tryCompact: vi.fn().mockResolvedValue(undefined),
}));

import { tryCompact } from '../try-compact';

describe('[v0.0.80.t1 task-1] runTryCompact = 纯生产者（不再触碰消费侧）', () => {
  function mkSpec(snapshot: ContextSnapshot, opts: {
    notifyUsageChanged?: ReturnType<typeof vi.fn>;
    assemble?: ReturnType<typeof vi.fn>;
  } = {}): RunSpec {
    return {
      config: { sessionId: 'sid-1' } as SessionConfig,
      scopeId: 'default',
      wireContextEngine: {
        assemble: opts.assemble ?? vi.fn().mockResolvedValue(snapshot),
        getSideRunner: () => null,
        getConsolidateRunner: () => null,
      } as never,
      observability: { setSystem: vi.fn() } as never,
      wireStore: {
        notifyUsageChanged: opts.notifyUsageChanged ?? vi.fn(),
        getSummary: vi.fn().mockResolvedValue(null),
      } as never,
      wireTaskLock: undefined,
      // [v0.0.81.compaction_bug] compactNoticeEmitter 字段已删（compact_notice 全段砍）
      pluginManager: null, // 触发 tryCompact 早 return（无需真实插件链）
      toolDefinitions: [],
    } as unknown as RunSpec;
  }

  function mkState(snapshot: ContextSnapshot): LoopState {
    return {
      snapshot,
      step: 0,
      ingestUpTo: null,
      llmUpTo: null,
      done: false,
    } as LoopState;
  }

  function mkSnapshot(): ContextSnapshot {
    return {
      system: { id: 'sys', sessionId: 'sid-1', role: 'system', content: [{ type: 'text', text: 'sys' }] },
      messages: [
        { id: 'msg-1', sessionId: 'sid-1', role: 'user', content: [{ type: 'text', text: 'hi' }] } as Message,
      ],
      inputCharCount: 10,
      contextWindowUsage: {
        systemTokens: 3, messageTokens: 7, toolTokens: 0,
        totalTokens: 10, maxOutputTokens: 20000, tokenLimit: 100000, remainingTokens: 79990,
      },
      summary: null,
    } as ContextSnapshot;
  }

  it('runTryCompact 调 tryCompact（fire-and-forget caller 仍 void），不再 re-assemble snapshot', async () => {
    const snapshot = mkSnapshot();
    const assembleMock = vi.fn().mockResolvedValue(snapshot);
    const spec = mkSpec(snapshot, { assemble: assembleMock });
    const state = mkState(snapshot);

    await runTryCompact(spec, state);

    // tryCompact 被调一次（compact 主体保留）
    expect(tryCompact).toHaveBeenCalledOnce();
    // assemble 不被额外调用（旧实现 re-assemble 尾已删；纯生产者不碰消费侧）
    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('runTryCompact 不再调 notifyUsageChanged（§1.0 纯生产者：消费侧归正规 assemble 管线）', async () => {
    const snapshot = mkSnapshot();
    const notifyUsageMock = vi.fn();
    const spec = mkSpec(snapshot, { notifyUsageChanged: notifyUsageMock });
    const state = mkState(snapshot);

    await runTryCompact(spec, state);

    expect(notifyUsageMock).not.toHaveBeenCalled();
  });

  it('runTryCompact 不再调 obs.setSystem（消费侧 setSystem 归 ingestMainAndAssemble）', async () => {
    const snapshot = mkSnapshot();
    const setSystemMock = vi.fn();
    const spec = {
      ...mkSpec(snapshot),
      observability: { setSystem: setSystemMock } as never,
    } as unknown as RunSpec;
    const state = mkState(snapshot);

    await runTryCompact(spec, state);

    expect(setSystemMock).not.toHaveBeenCalled();
  });

  it('runTryCompact 仍返 Promise<void>（caller 仍 fire-and-forget：void .catch(log)）', async () => {
    const snapshot = mkSnapshot();
    const spec = mkSpec(snapshot);
    const state = mkState(snapshot);

    const result = runTryCompact(spec, state);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });
});
