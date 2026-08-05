/**
 * rocky_context plugin compact EP(2) 单测（v0.0.40 新增）
 * 参考: specs/tech/agent/context/[P0]extension point and implementations.md §3.7/§4.6
 *       specs/tech/agent/context/[P0]context_compact_detail.md §2c.2/§2c.3
 *
 * 覆盖：
 *   - threshold_should_compact：边界（>0.6 触发 / <0.6 不触发）
 *     + [v0.0.81.compaction_bug] 阈值改纯使用比例（去 estimatedOutput）+ configSchema 阈值可调
 *     + tokenLimit<=0 容错
 *   - summary_do_compact：未装配依赖时报错（T3 仅注册未 wire）+ 装配后委托 runCompact
 *   - reject_should_compact（v0.0.40 修复新增）：恒返 false（forked scope 防递归用 dummy）
 *   - noop_do_compact（v0.0.40 修复新增）：run 空操作正常 resolve（forked defense-in-depth）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock 用绝对路径（memory: test-vitest-mock-absolute-path，bun+vitest 全量并发下相对路径静默失效）。
// vi.mock 被 vitest 提升到文件顶部（早于 import/const），故 path/mockFn 必须用 vi.hoisted 声明。
// ⚠️ 绝对路径用 __dirname 派生（portable），严禁硬编码 worktree 路径。
const { runCompactMock, runnerPath } = vi.hoisted(() => {
  const { resolve } = require('node:path') as typeof import('node:path');
  return {
    runCompactMock: vi.fn().mockResolvedValue(true),
    runnerPath: resolve(__dirname, '../../../../server/src/agent/context-compact-runner'),
  };
});

vi.mock(runnerPath, () => ({ runCompact: runCompactMock }));

import type { CompactCtx } from '../types';
import ThresholdShouldCompactPredicate from '../compact/threshold_should_compact';
import SummaryDoCompactAction from '../compact/summary_do_compact';
import RejectShouldCompactPredicate from '../compact/reject_should_compact';
import NoopDoCompactAction from '../compact/noop_do_compact';

/** 造假 ContextSnapshot（只关 contextWindowUsage 部分）*/
function fakeCtx(usage: {
  totalTokens: number;
  maxOutputTokens: number;
  tokenLimit: number;
}): CompactCtx {
  return {
    config: { sessionId: 'sid' } as never,
    snapshot: {
      system: { id: 's', sessionId: 'sid', role: 'system', content: [] } as never,
      messages: [],
      inputCharCount: 0,
      contextWindowUsage: {
        systemTokens: 0,
        messageTokens: 0,
        toolTokens: 0,
        totalTokens: usage.totalTokens,
        maxOutputTokens: usage.maxOutputTokens,
        tokenLimit: usage.tokenLimit,
        remainingTokens: usage.tokenLimit - usage.totalTokens - usage.maxOutputTokens,
      },
      summary: null,
    } as never,
    store: {} as never,
    scopeId: 'default',
  };
}

// ============================================================
// threshold_should_compact（谓词）
// ============================================================

describe('threshold_should_compact 谓词', () => {
  it('用量占比 > 0.6（默认阈值）→ true（触发 compact）', async () => {
    // [v0.0.81.compaction_bug] 阈值改纯使用比例 total/limit（不含 estimatedOutput）
    // tokenLimit=100k, totalTokens=70k, maxOutputTokens=20k → 70/100 = 0.7 > 0.6
    const p = new ThresholdShouldCompactPredicate('threshold_should_compact');
    expect(await p.check(fakeCtx({ totalTokens: 70000, maxOutputTokens: 20000, tokenLimit: 100000 }))).toBe(true);
  });

  it('用量占比 < 0.6（默认阈值）→ false（不触发）', async () => {
    // tokenLimit=100k, totalTokens=50k → 50/100 = 0.5 < 0.6
    const p = new ThresholdShouldCompactPredicate('threshold_should_compact');
    expect(await p.check(fakeCtx({ totalTokens: 50000, maxOutputTokens: 20000, tokenLimit: 100000 }))).toBe(false);
  });

  it('刚好 = 0.6 → false（> 严格大于，阈值线不触发）', async () => {
    // total/limit = 60/100 = 0.6 等于阈值，不 > ，不触发
    const p = new ThresholdShouldCompactPredicate('threshold_should_compact');
    expect(await p.check(fakeCtx({ totalTokens: 60000, maxOutputTokens: 20000, tokenLimit: 100000 }))).toBe(false);
  });

  it('[v0.0.81] 不含 estimatedOutput：total/limit 比例，maxOutput 不参与阈值', async () => {
    // 关键不变量：estimatedOutput 不进阈值——即使 maxOutput=0/50k 都不影响触发判定
    const p = new ThresholdShouldCompactPredicate('threshold_should_compact');
    // total=70/100=0.7 > 0.6 → 触发（无论 maxOutput 多少）
    expect(await p.check(fakeCtx({ totalTokens: 70000, maxOutputTokens: 0, tokenLimit: 100000 }))).toBe(true);
    expect(await p.check(fakeCtx({ totalTokens: 70000, maxOutputTokens: 50000, tokenLimit: 100000 }))).toBe(true);
    // total=50/100=0.5 < 0.6 → 不触发（即使 maxOutput 巨大也按用量比例判）
    expect(await p.check(fakeCtx({ totalTokens: 50000, maxOutputTokens: 50000, tokenLimit: 100000 }))).toBe(false);
  });

  it('configSchema 阈值可调：compactRatio=0.9 时 0.7 占比不触发', async () => {
    const p = new ThresholdShouldCompactPredicate('threshold_should_compact', { compactRatio: 0.9 });
    // 70/100 = 0.7 < 0.9 → 不触发
    expect(await p.check(fakeCtx({ totalTokens: 70000, maxOutputTokens: 20000, tokenLimit: 100000 }))).toBe(false);
    // 95/100 = 0.95 > 0.9 → 触发
    expect(await p.check(fakeCtx({ totalTokens: 95000, maxOutputTokens: 15000, tokenLimit: 100000 }))).toBe(true);
  });

  it('compactRatio=0.3：低阈值，30% 占比即触发', async () => {
    const p = new ThresholdShouldCompactPredicate('threshold_should_compact', { compactRatio: 0.3 });
    // 35/100 = 0.35 > 0.3 → 触发
    expect(await p.check(fakeCtx({ totalTokens: 35000, maxOutputTokens: 15000, tokenLimit: 100000 }))).toBe(true);
  });

  it('非法 cfg 值忽略，回退默认 0.6（getNumber 容错）', async () => {
    const p = new ThresholdShouldCompactPredicate('threshold_should_compact', { compactRatio: 'not-a-number' });
    // 回退默认 0.6：70/100 = 0.7 > 0.6 → 触发
    expect(await p.check(fakeCtx({ totalTokens: 70000, maxOutputTokens: 20000, tokenLimit: 100000 }))).toBe(true);
  });

  it('tokenLimit<=0 → false（容错，避免除零）', async () => {
    const p = new ThresholdShouldCompactPredicate('threshold_should_compact');
    expect(await p.check(fakeCtx({ totalTokens: 100, maxOutputTokens: 0, tokenLimit: 0 }))).toBe(false);
  });

  it('contextWindowUsage 缺省 → false（容错）', async () => {
    const p = new ThresholdShouldCompactPredicate('threshold_should_compact');
    const ctx = {
      config: { sessionId: 'sid' } as never,
      snapshot: { contextWindowUsage: undefined } as never,
      store: {} as never,
      scopeId: 'default',
    } as CompactCtx;
    expect(await p.check(ctx)).toBe(false);
  });
});

// ============================================================
// summary_do_compact（动作）
// ============================================================

describe('summary_do_compact 动作', () => {
  beforeEach(() => {
    runCompactMock.mockClear();
  });

  it('T3 未 wire：ctx 缺 sideRunner → 抛「未装配」错误（不调 runCompact）', async () => {
    const action = new SummaryDoCompactAction('summary_do_compact');
    const ctx = fakeCtx({ totalTokens: 80000, maxOutputTokens: 20000, tokenLimit: 100000 });
    // ctx.sideRunner 缺省 → 前置校验抛错
    await expect(action.run(ctx)).rejects.toThrow(/not wired/);
    // 不应触达 runCompact
    expect(runCompactMock).not.toHaveBeenCalled();
  });


  it('装配后：委托 runCompact（mock 验证透传 store/taskLock/config/runner/pluginCtx）', async () => {
    const action = new SummaryDoCompactAction('summary_do_compact');
    const store = { id: 'fake-store' } as never;
    // v0.0.55: CompactCtx.stateMachine 改为 taskLock（SessionTaskLock 统一锁）；
    // runCompact 已 mock，此处仅验证透传，但保留 acquire/markDone/markFailed stub 体现代码语义
    const taskLock = {
      acquire: vi.fn(),
      markDone: vi.fn(),
      markFailed: vi.fn(),
    } as never;
    const sideRunner = async () => ({ answer: '', usage: {} }) as never;
    const config = { sessionId: 'sid-wired' } as never;
    const pluginCtx = {
      scopeId: 'default',
      pluginManager: null,
      consolidateRunner: null,
      store,
    } as never;
    const ctx: CompactCtx = {
      config,
      snapshot: {} as never,
      store,
      scopeId: 'default',
      taskLock,
      sideRunner,
      pluginCtx,
    };

    await action.run(ctx);
    // 验证 runCompact 被调，参数透传顺序对齐 runCompact 签名
    // [v0.0.81.compaction_bug] noticeEmitter 参数已删（compact_notice 全段砍）
    expect(runCompactMock).toHaveBeenCalledOnce();
    const args = runCompactMock.mock.calls[0]!;
    expect(args[0]).toBe(store);
    expect(args[1]).toBe(taskLock);
    expect(args[2]).toBe(config);
    expect(args[3]).toBe(ctx.snapshot);
    expect(args[4]).toBe(sideRunner);
    // [v0.0.186] 第 8 参 = 烘焙参数（cfg 缺省 → 默认 tokenCap/candidateLimit）
    expect(args[7]).toEqual({ tokenCap: 10000, candidateLimit: 500 });
    // 第 9 参 = pluginCtx（tryCompact 胶水注入）→ runCompact 末尾 post-compact EP 派发
    expect(args[8]).toBe(pluginCtx);
  });

  it('[v0.0.186] cfg.tokenCap/candidateLimit 覆盖 → 透传到 runCompact 烘焙参数', async () => {
    const action = new SummaryDoCompactAction('summary_do_compact', {
      tokenCap: 2000,
      candidateLimit: 50,
    });
    const ctx: CompactCtx = {
      config: { sessionId: 'sid-wired' } as never,
      snapshot: {} as never,
      store: {} as never,
      scopeId: 'default',
      taskLock: { acquire: vi.fn(), markDone: vi.fn(), markFailed: vi.fn() } as never,
      sideRunner: async () => ({ answer: '', usage: {} }) as never,
    };
    await action.run(ctx);
    const args = runCompactMock.mock.calls[0]!;
    expect(args[7]).toEqual({ tokenCap: 2000, candidateLimit: 50 });
  });
});

// ============================================================
// reject_should_compact（谓词 dummy，v0.0.40 修复；forked scope 显式选中防递归）
// ============================================================

describe('reject_should_compact 谓词（dummy）', () => {
  it('恒返 false（无论用量多高都不触发 compact）', async () => {
    const p = new RejectShouldCompactPredicate('reject_should_compact');
    // 用量爆表（>200% 溢出）仍返 false——forked scope 永不 compact（防递归不变量）
    expect(await p.check(fakeCtx({ totalTokens: 200000, maxOutputTokens: 50000, tokenLimit: 100000 }))).toBe(false);
    // 零用量同样 false
    expect(await p.check(fakeCtx({ totalTokens: 0, maxOutputTokens: 0, tokenLimit: 100000 }))).toBe(false);
  });

  it('忽略 cfg（无可调参数，恒 false）', async () => {
    // 即便传 compactRatio 也不影响——本 impl 不读配置，恒 false
    const p = new RejectShouldCompactPredicate('reject_should_compact', { compactRatio: 0.01 });
    expect(await p.check(fakeCtx({ totalTokens: 99000, maxOutputTokens: 0, tokenLimit: 100000 }))).toBe(false);
  });
});

// ============================================================
// noop_do_compact（动作 noop，v0.0.40 修复；forked scope defense-in-depth）
// ============================================================

describe('noop_do_compact 动作（noop）', () => {
  it('run 正常 resolve 不抛错（即便 ctx 缺所有运行时依赖，与 summary_do_compact 对比）', async () => {
    const action = new NoopDoCompactAction('noop_do_compact');
    // ctx 缺 assembleFn/sideRunner 等——noop 不读这些依赖，空操作不抛错
    const ctx = fakeCtx({ totalTokens: 80000, maxOutputTokens: 20000, tokenLimit: 100000 });
    await expect(action.run(ctx)).resolves.toBeUndefined();
  });
});
