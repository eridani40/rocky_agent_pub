/**
 * LlmErrorState rev2 改版单测（recentErrors + deriveMaxTokens + 成功清空）
 * 参考: specs/tech/agent/llm_caller/[P0]llm_request_config.md §2（schema + 派生规则）
 *       specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md
 *
 * 覆盖（spec §2.2 §2.3 §2.4）：
 *   1. appendRecentError：追加 + 裁剪上限（max_attempts−1）
 *   2. deriveMaxTokens：公式（0 个 TOO_HIGH→base；1→×0.7；2→×0.49；混入 EXCEEDED/NETWORK 不影响）
 *   3. clearRecentErrors：成功清空整个数组
 *   4. clearTransientOnErrorState：成功清 recentErrors + 瞬时字段（precompress 粘性保留）
 *   5. 跨 iteration 保留语义（连续错误不清，成功才清）—— 通过 append/clear 组合验证
 *
 * 测试方式：纯函数单测（不依赖 LlmClient / attemptLoop）。
 * 单文件 ≤300 行。
 */
import { describe, it, expect } from 'vitest';
import { LlmErrorCategory } from '../error_types';
import {
  createLlmErrorState,
  appendRecentError,
  clearRecentErrors,
  deriveMaxTokens,
  clearTransientOnErrorState,
  isErrorStateClean,
  type RecentErrorEntry,
} from '../llm_error_state';

/** 构造一条 recentError 条目（测试辅助）。 */
function mkEntry(category: LlmErrorCategory, at = 1000): RecentErrorEntry {
  return {
    category,
    modelEntry: { providerId: 'p1', keyRef: 'default', modelId: 'm1' },
    at,
  };
}

// ============================================================
// 1. appendRecentError：追加 + 裁剪上限
// ============================================================
describe('appendRecentError', () => {
  it('空 state → 追加 1 条，recentErrors 长度 = 1', () => {
    const state = createLlmErrorState();
    const next = appendRecentError(state, mkEntry(LlmErrorCategory.NETWORK), 3);
    expect(next.recentErrors).toHaveLength(1);
    expect(next.recentErrors![0]!.category).toBe(LlmErrorCategory.NETWORK);
    // 不 mutate 原 state
    expect(state.recentErrors).toBeUndefined();
  });

  it('max_attempts=3 → 上限 2 条，第 3 条 append 后丢最旧', () => {
    let state = createLlmErrorState();
    state = appendRecentError(state, mkEntry(LlmErrorCategory.NETWORK, 1000), 3);
    state = appendRecentError(state, mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH, 2000), 3);
    expect(state.recentErrors).toHaveLength(2);
    // 第 3 条：裁剪到上限 2，丢最旧（at=1000）
    state = appendRecentError(state, mkEntry(LlmErrorCategory.SERVER_ERROR, 3000), 3);
    expect(state.recentErrors).toHaveLength(2);
    expect(state.recentErrors![0]!.at).toBe(2000); // 最旧被丢
    expect(state.recentErrors![1]!.at).toBe(3000); // 最新保留
  });

  it('max_attempts=1 → 上限 0，append 后立即裁剪到空（不存历史）', () => {
    const state = createLlmErrorState();
    const next = appendRecentError(state, mkEntry(LlmErrorCategory.NETWORK), 1);
    expect(next.recentErrors).toHaveLength(0);
  });

  it('保留 modelEntry 三元组快照（不同 provider/key/model 各自记录）', () => {
    const state = createLlmErrorState();
    const entry: RecentErrorEntry = {
      category: LlmErrorCategory.AUTH_INVALID,
      modelEntry: { providerId: 'p2', keyRef: 'backup', modelId: 'm2' },
      at: 5000,
    };
    const next = appendRecentError(state, entry, 3);
    expect(next.recentErrors![0]!.modelEntry).toEqual({
      providerId: 'p2', keyRef: 'backup', modelId: 'm2',
    });
  });
});

// ============================================================
// 2. deriveMaxTokens：公式
// ============================================================
describe('deriveMaxTokens', () => {
  it('0 个 TOO_HIGH → base（无降级）', () => {
    expect(deriveMaxTokens(20000, [], 1024)).toBe(20000);
    expect(deriveMaxTokens(20000, undefined, 1024)).toBe(20000);
  });

  it('1 个 TOO_HIGH → base × 0.7（向下取整）', () => {
    // 20000 × 0.7 = 14000
    expect(deriveMaxTokens(20000, [mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH)], 1024)).toBe(14000);
  });

  it('2 个 TOO_HIGH → base × 0.49（向下取整）', () => {
    // 20000 × 0.7^2 = 9799.99...（浮点）→ floor = 9799
    expect(deriveMaxTokens(20000, [
      mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH),
      mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH),
    ], 1024)).toBe(9799);
  });

  it('混入 EXCEEDED / NETWORK / SERVER_ERROR 不影响 TOO_HIGH 计数（只数 TOO_HIGH）', () => {
    // 1 个 TOO_HIGH + 1 个 EXCEEDED + 1 个 NETWORK → 仍按 1 个 TOO_HIGH 算 = base×0.7
    const recent = [
      mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH),
      mkEntry(LlmErrorCategory.MAX_TOKENS_EXCEEDED),
      mkEntry(LlmErrorCategory.NETWORK),
    ];
    expect(deriveMaxTokens(20000, recent, 1024)).toBe(14000);
  });

  it('全非 TOO_HIGH（EXCEEDED + NETWORK）→ 不降级 = base', () => {
    const recent = [
      mkEntry(LlmErrorCategory.MAX_TOKENS_EXCEEDED),
      mkEntry(LlmErrorCategory.NETWORK),
    ];
    expect(deriveMaxTokens(20000, recent, 1024)).toBe(20000);
  });

  it('指数衰减到下限以下 → 保底 modelLowerBound（不衰减到 0）', () => {
    // base=2000，4 个 TOO_HIGH：2000 × 0.7^4 = 480.2 → floor=480，低于 lowerBound=1024 → 保底 1024
    const recent = [
      mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH),
      mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH),
      mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH),
      mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH),
    ];
    expect(deriveMaxTokens(2000, recent, 1024)).toBe(1024);
  });

  it('派生值不超过 base（防溢出）', () => {
    // 极端：0 个 TOO_HIGH，base 很小，lowerBound 很大 → 不超过 base
    expect(deriveMaxTokens(500, [], 1024)).toBe(500);
  });

  it('向下取整（非整数结果截断）', () => {
    // 100 × 0.7 = 70（整数）；101 × 0.7 = 70.7 → floor=70
    expect(deriveMaxTokens(101, [mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH)], 10)).toBe(70);
  });
});

// ============================================================
// 3. clearRecentErrors：成功清空
// ============================================================
describe('clearRecentErrors', () => {
  it('有 recentErrors → 清空为空数组', () => {
    const state = createLlmErrorState();
    const appended = appendRecentError(state, mkEntry(LlmErrorCategory.NETWORK), 3);
    const cleared = clearRecentErrors(appended);
    expect(cleared.recentErrors).toEqual([]);
  });

  it('无 recentErrors（undefined）→ 原样返回（不创建空数组）', () => {
    const state = createLlmErrorState();
    const cleared = clearRecentErrors(state);
    expect(cleared).toBe(state); // 同一引用（无变化）
    expect(cleared.recentErrors).toBeUndefined();
  });

  it('不 mutate 原 state（返回新对象）', () => {
    const state = createLlmErrorState();
    const appended = appendRecentError(state, mkEntry(LlmErrorCategory.NETWORK), 3);
    const originalLen = appended.recentErrors!.length;
    clearRecentErrors(appended);
    expect(appended.recentErrors).toHaveLength(originalLen); // 原 state 未变
  });
});

// ============================================================
// 4. clearTransientOnErrorState：成功清瞬时字段（precompress 粘性保留）
// ============================================================
describe('clearTransientOnErrorState', () => {
  it('清 recentErrors + prefillPartial + partialResult + consecutiveContextLength + lastError', () => {
    const state = {
      recentErrors: [mkEntry(LlmErrorCategory.NETWORK)],
      prefillPartial: { id: 'a1', role: 'assistant' as const, content: [{ type: 'text' as const, text: 'p' }] },
      partialResult: { message: { id: 'a1' } as never, usage: undefined },
      consecutiveContextLength: 2,
      lastError: { category: LlmErrorCategory.NETWORK, reason: 'x', at: 1 },
      precompress: true,
    };
    const next = clearTransientOnErrorState(state);
    expect(next.recentErrors).toEqual([]);
    expect(next.prefillPartial).toBeUndefined();
    expect(next.partialResult).toBeUndefined();
    expect(next.consecutiveContextLength).toBeUndefined();
    expect(next.lastError).toBeUndefined();
  });

  it('precompress 粘性保留（不主动清）', () => {
    const state = { precompress: true };
    const next = clearTransientOnErrorState(state);
    expect(next.precompress).toBe(true);
  });
});

// ============================================================
// 5. 跨 iteration 保留语义：连续错误不清，成功才清
// ============================================================
describe('跨 iteration recentErrors 保留语义', () => {
  it('连续 error（无成功）→ recentErrors 跨 iteration 累积', () => {
    // 模拟 iteration N: error → append
    let state = createLlmErrorState();
    state = appendRecentError(state, mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH, 1000), 3);
    // 模拟 iteration N+1: 又 error（未成功，recentErrors 保留 + 累积）
    state = appendRecentError(state, mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH, 2000), 3);
    expect(state.recentErrors).toHaveLength(2);
    // 派生 maxTokens 应是 base × 0.49（2 个 TOO_HIGH）
    expect(deriveMaxTokens(20000, state.recentErrors, 1024)).toBe(9799);
  });

  it('成功打断 → recentErrors 清空 → 后续派生回 base（连续错误归零）', () => {
    // 连续 2 个错误
    let state = createLlmErrorState();
    state = appendRecentError(state, mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH, 1000), 3);
    state = appendRecentError(state, mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH, 2000), 3);
    expect(deriveMaxTokens(20000, state.recentErrors, 1024)).toBe(9799);
    // 成功 → 清空
    state = clearTransientOnErrorState(state);
    expect(state.recentErrors).toEqual([]);
    // 后续派生回 base（降级因子立即归零，spec §2.3 关键决定）
    expect(deriveMaxTokens(20000, state.recentErrors, 1024)).toBe(20000);
  });

  it('成功后再次 error → recentErrors 重新从 1 累积（不继承旧历史）', () => {
    let state = createLlmErrorState();
    state = appendRecentError(state, mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH, 1000), 3);
    state = clearTransientOnErrorState(state); // 成功清空
    state = appendRecentError(state, mkEntry(LlmErrorCategory.MAX_TOKENS_TOO_HIGH, 3000), 3); // 新错误
    // 只 1 个 TOO_HIGH（旧历史已清）→ base × 0.7
    expect(state.recentErrors).toHaveLength(1);
    expect(deriveMaxTokens(20000, state.recentErrors, 1024)).toBe(14000);
  });
});

// ============================================================
// 6. isErrorStateClean
// ============================================================
describe('isErrorStateClean', () => {
  it('空 state → clean', () => {
    expect(isErrorStateClean(createLlmErrorState())).toBe(true);
  });

  it('recentErrors 非空 → not clean', () => {
    const state = appendRecentError(createLlmErrorState(), mkEntry(LlmErrorCategory.NETWORK), 3);
    expect(isErrorStateClean(state)).toBe(false);
  });

  it('recentErrors 空数组 → clean', () => {
    expect(isErrorStateClean({ recentErrors: [] })).toBe(true);
  });
});
