/**
 * Length 处理模块单测（白盒）
 * 参考: specs/tech/agent/llm_caller/[P0]length_handling.md（§2 决策树 / §2.1 prefill / §3 CONTEXT_LENGTH / §4 STREAM_INCOMPLETE）
 *       states/v0.0.25/verify/test-plan.md §3（length_handling 行）
 *
 * 覆盖（test-plan §3）：
 *   - MAX_TOKENS 决策树各分支（prefill / bump / throw）
 *   - prefill 拼接规则（text_delta append / tool_call_delta append 或新建 / usage 累加 / 递归限 1 次）
 *   - STREAM_INCOMPLETE 严格不 bump
 *   - CONTEXT_LENGTH 粘性预压缩（不缩窗口）
 *   - ModelCapability 能力位用法（supportsPrefill/supportsThinking）
 */
import { describe, it, expect } from 'vitest';
import {
  isSalvageable,
  decideMaxTokensAction,
  bumpMaxTokensToOneShotCeiling,
  computePrefillRemainingBudget,
  applyPrefillOverlay,
  mergePrefillChunks,
} from '../length_max_tokens';
import { LlmErrorCategory } from '../error_types';
import {
  applyContextLengthEscalation,
  applyCompressOverlay,
  computeContextLengthMaxTokensAdjustment,
  type ContextCompressor,
} from '../length_context';
import {
  MAX_PREFILL_RECURSION,
  PREFILL_TOTAL_BUDGET_FACTOR,
  PRECOMPRESS_TRIGGER_THRESHOLD,
  COMPRESS_TARGET_RATIO,
  type LengthModelInfo,
  type PartialMessage,
  type LengthErrorState,
} from '../length_types';
import { isStreamIncomplete } from '../length_context';
import type { CanonicalRequest } from '../../protocol';

// ──────────────────────────────────────────────────────────────────────────
// 工具：构造 model / partial / baseReq
// ──────────────────────────────────────────────────────────────────────────

/** Anthropic 模型（supportsPrefill=true，maxOutputTokens=8000） */
function anthropicModel(maxOutput = 8000): LengthModelInfo {
  return {
    modelId: 'claude-sonnet-4-6',
    capabilities: {
      maxOutputTokens: maxOutput,
      supportsPrefill: true,
      supportsThinking: true,
    },
  };
}

/** OpenAI 模型（supportsPrefill=false） */
function openaiModel(maxOutput = 4096): LengthModelInfo {
  return {
    modelId: 'gpt-4',
    capabilities: {
      maxOutputTokens: maxOutput,
      supportsPrefill: false,
      supportsThinking: false,
    },
  };
}

/** 构造 partial（默认纯 text，可 salvage） */
function partialText(text = 'partial answer', outputTokens = 4000): PartialMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { output_total_tokens: outputTokens },
  };
}

/** 构造 partial（含完整 tool_call，可 salvage） */
function partialWithToolCall(): PartialMessage {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'I will use a tool' },
      {
        type: 'tool_call',
        id: 'tc_1',
        name: 'search',
        arguments: { query: 'foo' },
      },
    ],
    usage: { output_total_tokens: 2000 },
  };
}

/** 构造 baseReq */
function baseReq(maxTokens = 4000): CanonicalRequest {
  return {
    modelId: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: { maxTokens },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// §2 isSalvageable
// ──────────────────────────────────────────────────────────────────────────

describe('isSalvageable', () => {
  it('纯 text partial → true', () => {
    expect(isSalvageable(partialText('hello'))).toBe(true);
  });

  it('含完整 tool_call → true', () => {
    expect(isSalvageable(partialWithToolCall())).toBe(true);
  });

  it('空 content → false', () => {
    expect(isSalvageable({ role: 'assistant', content: [] })).toBe(false);
  });

  it('undefined → false', () => {
    expect(isSalvageable(undefined)).toBe(false);
  });

  it('空 text（无可用内容）→ false', () => {
    expect(isSalvageable({ role: 'assistant', content: [{ type: 'text', text: '' }] })).toBe(false);
  });

  it('含未完成 tool_call（arguments=null）→ false', () => {
    const p: PartialMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'partial' },
        // 模拟流断：arguments 非 object（防御性编程触发）
        { type: 'tool_call', id: 'x', name: 'n', arguments: null as unknown as Record<string, unknown> },
      ],
    };
    expect(isSalvageable(p)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// §2 + §6 decideMaxTokensAction 决策树
// ──────────────────────────────────────────────────────────────────────────

describe('decideMaxTokensAction 决策树', () => {
  it('[T12 prefill defer] continue + salvageable + supportsPrefill → 不走 prefill，走 bump（one-shot ceiling）', () => {
    // v0.0.25 prefill defer：即便 supportsPrefill=true + salvageable，也不走 prefill 分支
    const action = decideMaxTokensAction(partialText(), anthropicModel(), 4000, 'continue');
    expect(action).toEqual({ action: 'bump', newMax: 8000 });
  });

  it('[T12] continue + salvageable + !supportsPrefill → bump（one-shot ceiling）', () => {
    const action = decideMaxTokensAction(partialText(), openaiModel(4096), 2000, 'continue');
    expect(action).toEqual({ action: 'bump', newMax: 4096 });
  });

  it('[T12] increase 策略 → bump（one-shot ceiling，不试 prefill）', () => {
    const action = decideMaxTokensAction(partialText(), anthropicModel(), 4000, 'increase');
    expect(action).toEqual({ action: 'bump', newMax: 8000 });
  });

  it('none 策略 → throw（不处理）', () => {
    const action = decideMaxTokensAction(partialText(), anthropicModel(), 4000, 'none');
    expect(action).toEqual({ action: 'throw' });
  });

  it('[T12] 未到硬上限 → bump（one-shot 直接到 ceiling，不渐进翻倍）', () => {
    // 旧 ×2 逻辑：3000 → 6000；新 one-shot：3000 → 8000（直接到 ceiling）
    const action = decideMaxTokensAction(partialText(), anthropicModel(8000), 3000, 'increase');
    expect(action).toEqual({ action: 'bump', newMax: 8000 });
  });

  it('[T12] 已到硬上限 → throw（不无限重试，§2.2 封顶）', () => {
    // current == maxOutputTokens → 无法再 bump
    const action = decideMaxTokensAction(partialText(), anthropicModel(8000), 8000, 'increase');
    expect(action).toEqual({ action: 'throw' });
  });

  it('[T12] 超过硬上限 → throw（防御）', () => {
    const action = decideMaxTokensAction(partialText(), anthropicModel(8000), 9000, 'increase');
    expect(action).toEqual({ action: 'throw' });
  });

  it('[T12 prefill defer] partial 不可 salvage（含未完成 tool_call）→ 仍走 bump（不走 prefill）', () => {
    const partial: PartialMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_call', id: 'x', name: 'n', arguments: null as unknown as Record<string, unknown> },
      ],
    };
    // v0.0.25 prefill defer：salvageable 不再影响分支选择，未到硬上限 → bump
    const action = decideMaxTokensAction(partial, anthropicModel(8000), 4000, 'continue');
    expect(action).toEqual({ action: 'bump', newMax: 8000 });
  });

  it('[T12 prefill defer] 默认 strategy=continue → 仍走 bump（不走 prefill）', () => {
    const action = decideMaxTokensAction(partialText(), anthropicModel(), 4000);
    expect(action).toEqual({ action: 'bump', newMax: 8000 });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// §2.2 bumpMaxTokensToOneShotCeiling（v0.0.25 rev2 / T12：one-shot ceiling）
// ──────────────────────────────────────────────────────────────────────────

describe('bumpMaxTokensToOneShotCeiling', () => {
  it('[T12] current < ceiling → 返 ceiling（one-shot 直接到上限）', () => {
    // 旧 ×2：2000→4000；新 one-shot：2000→8000
    expect(bumpMaxTokensToOneShotCeiling(2000, anthropicModel(8000))).toBe(8000);
  });

  it('[T12] current 远小于 ceiling → 仍返 ceiling（非渐进翻倍）', () => {
    expect(bumpMaxTokensToOneShotCeiling(500, anthropicModel(8000))).toBe(8000);
  });

  it('[T12] current 略小于 ceiling → 返 ceiling', () => {
    expect(bumpMaxTokensToOneShotCeiling(7999, anthropicModel(8000))).toBe(8000);
  });

  it('[T12] current == ceiling → throw（已在上限，无法再 bump）', () => {
    expect(() => bumpMaxTokensToOneShotCeiling(8000, anthropicModel(8000))).toThrowError(
      /exceeds model capability/,
    );
  });

  it('[T12] current > ceiling → throw（防御）', () => {
    expect(() => bumpMaxTokensToOneShotCeiling(9000, anthropicModel(8000))).toThrow();
  });

  it('[T12] throw 时错误为 MAX_TOKENS_EXCEEDED + retryable=false', () => {
    try {
      bumpMaxTokensToOneShotCeiling(8000, anthropicModel(8000));
      expect.fail('should throw');
    } catch (e) {
      const err = e as { category?: string; hints?: { retryable?: boolean } };
      expect(err.category).toBe(LlmErrorCategory.MAX_TOKENS_EXCEEDED);
      expect(err.hints?.retryable).toBe(false);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// §2.1 prefill 续写数据流
// ──────────────────────────────────────────────────────────────────────────

describe('computePrefillRemainingBudget', () => {
  it('剩余 = 2*maxOutput - partial.output，封顶单次 maxOutput', () => {
    // 2*8000 - 4000 = 12000，但单次上限 8000 → 8000
    expect(computePrefillRemainingBudget(anthropicModel(8000), 4000)).toBe(8000);
  });

  it('partial 已用接近总预算 → 剩余小（≥1）', () => {
    // 2*8000 - 15999 = 1
    expect(computePrefillRemainingBudget(anthropicModel(8000), 15999)).toBe(1);
  });

  it('partial 超用（负数防御）→ max(0) 后算，返回 ≥1', () => {
    expect(computePrefillRemainingBudget(anthropicModel(8000), 99999)).toBe(1);
  });

  it('partial=0 → 剩余 = 单次 maxOutput（不超过）', () => {
    expect(computePrefillRemainingBudget(anthropicModel(8000), 0)).toBe(8000);
  });

  it(`总预算系数 = ${PREFILL_TOTAL_BUDGET_FACTOR}`, () => {
    expect(PREFILL_TOTAL_BUDGET_FACTOR).toBe(2);
  });

  it(`递归上限 = ${MAX_PREFILL_RECURSION}`, () => {
    expect(MAX_PREFILL_RECURSION).toBe(1);
  });
});

describe('applyPrefillOverlay', () => {
  it('partial 作为 messages 最后一条 assistant turn', () => {
    const req = applyPrefillOverlay(baseReq(4000), partialText('partial', 4000), anthropicModel(8000));
    const last = req.messages[req.messages.length - 1]!;
    expect(last.role).toBe('assistant');
    expect(last.content).toEqual([{ type: 'text', text: 'partial' }]);
  });

  it('maxTokens 重置为剩余预算', () => {
    const req = applyPrefillOverlay(baseReq(4000), partialText('p', 6000), anthropicModel(8000));
    // 2*8000 - 6000 = 10000，封顶 8000
    expect(req.params.maxTokens).toBe(8000);
  });

  it('保留原 messages（不替换）', () => {
    const orig = baseReq(4000);
    const req = applyPrefillOverlay(orig, partialText(), anthropicModel(8000));
    expect(req.messages.length).toBe(orig.messages.length + 1);
    expect(req.messages[0]).toEqual(orig.messages[0]);
  });

  it('剥离 partial.usage（wire 不需要）', () => {
    const req = applyPrefillOverlay(baseReq(4000), partialText('p', 4000), anthropicModel(8000));
    const last = req.messages[req.messages.length - 1] as PartialMessage;
    expect(last.usage).toBeUndefined();
  });

  it('partial role 强制 assistant（即使传入 role=tool）', () => {
    const partial: PartialMessage = { role: 'tool', content: [{ type: 'text', text: 'x' }] };
    const req = applyPrefillOverlay(baseReq(4000), partial, anthropicModel(8000));
    const last = req.messages[req.messages.length - 1]!;
    expect(last.role).toBe('assistant');
  });
});

describe('mergePrefillChunks 拼接规则', () => {
  it('text_delta append 到最后一个 TextBlock', () => {
    const partial = partialText('partial ');
    const merged = mergePrefillChunks(partial, [
      { type: 'text_delta', text: 'continued' },
      { type: 'text_delta', text: '!' },
    ]);
    expect(merged.content[0]).toEqual({ type: 'text', text: 'partial continued!' });
  });

  it('无 TextBlock 时新建', () => {
    const partial: PartialMessage = { role: 'assistant', content: [] };
    const merged = mergePrefillChunks(partial, [{ type: 'text_delta', text: 'new' }]);
    expect(merged.content).toContainEqual({ type: 'text', text: 'new' });
  });

  it('tool_call_delta append 到同 toolCallId 的 block（arguments 解析）', () => {
    const partial = partialWithToolCall(); // 已有 tc_1: {query:'foo'}
    const merged = mergePrefillChunks(partial, [
      {
        type: 'tool_call_delta',
        toolCallId: 'tc_1',
        argumentsDelta: JSON.stringify({ query: 'foo', limit: 10 }),
      },
    ]);
    const tc = merged.content.find(
      (b) => b.type === 'tool_call' && b.id === 'tc_1',
    );
    expect(tc && tc.type === 'tool_call' && tc.arguments).toEqual({ query: 'foo', limit: 10 });
  });

  it('tool_call_delta 新 toolCallId → 新建 block', () => {
    const partial = partialText('p');
    const merged = mergePrefillChunks(partial, [
      {
        type: 'tool_call_delta',
        toolCallId: 'tc_2',
        name: 'calc',
        argumentsDelta: JSON.stringify({ x: 1 }),
      },
    ]);
    const tc = merged.content.find(
      (b) => b.type === 'tool_call' && b.id === 'tc_2',
    );
    expect(tc && tc.type === 'tool_call').toBeTruthy();
  });

  it('半截 argumentsDelta（不可解析）→ 保留原 arguments', () => {
    const partial = partialWithToolCall(); // tc_1: {query:'foo'}
    const merged = mergePrefillChunks(partial, [
      {
        type: 'tool_call_delta',
        toolCallId: 'tc_1',
        argumentsDelta: '{not closed', // 半截 JSON
      },
    ]);
    const tc = merged.content.find(
      (b) => b.type === 'tool_call' && b.id === 'tc_1',
    );
    // 半截不可解析 → 保留原 {query:'foo'}
    expect(tc && tc.type === 'tool_call' && tc.arguments).toEqual({ query: 'foo' });
  });

  it('usage 累加（output 加，input 取较大）', () => {
    const partial: PartialMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'p' }],
      usage: { output_total_tokens: 1000, input_total_tokens: 500 },
    };
    const merged = mergePrefillChunks(partial, [
      { type: 'usage', usage: { output_total_tokens: 500, input_total_tokens: 800 } },
    ]);
    expect(merged.usage?.output_total_tokens).toBe(1500); // 1000 + 500
    expect(merged.usage?.input_total_tokens).toBe(800); // max(500, 800)
  });

  it('递归限 1 次：MAX_PREFILL_RECURSION=1（常量约束）', () => {
    // 调用方在 prefillRecursionCount >= MAX_PREFILL_RECURSION 时应上抛不再续
    expect(MAX_PREFILL_RECURSION).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// §4 STREAM_INCOMPLETE 区分（严格不 bump）
// ──────────────────────────────────────────────────────────────────────────

describe('isStreamIncomplete', () => {
  it('无 stop_reason（流断无 finish）→ STREAM_INCOMPLETE', () => {
    expect(isStreamIncomplete(undefined, partialText())).toBe(true);
  });

  it('stop_reason=max_tokens + 无 tool_call（纯 text salvageable）→ 非 STREAM_INCOMPLETE', () => {
    expect(isStreamIncomplete('max_tokens', partialText())).toBe(false);
  });

  it('stop_reason=max_tokens + 完整 tool_call → 非 STREAM_INCOMPLETE（走 MAX_TOKENS 路径）', () => {
    expect(isStreamIncomplete('max_tokens', partialWithToolCall())).toBe(false);
  });

  it('stop_reason=stop + 完整 tool_call → 非 STREAM_INCOMPLETE', () => {
    expect(isStreamIncomplete('stop', partialWithToolCall())).toBe(false);
  });

  it('stop_reason 存在 + 未完成 tool_call（arguments=null）→ STREAM_INCOMPLETE', () => {
    const partial: PartialMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_call', id: 'x', name: 'n', arguments: null as unknown as Record<string, unknown> },
      ],
    };
    // 即使 stop_reason=max_tokens，tool args 未完成 → STREAM_INCOMPLETE（不 bump）
    expect(isStreamIncomplete('max_tokens', partial)).toBe(true);
  });

  it('STREAM_INCOMPLETE 严格不 bump（hermes 教训）', () => {
    // 场景：流断 + tool args 未完成 → STREAM_INCOMPLETE
    // 调用方应走 retry 路径（retryable=true），不进 decideMaxTokensAction
    const streamIncomplete = isStreamIncomplete(undefined, partialWithToolCall());
    expect(streamIncomplete).toBe(true);
    // 此场景下 decideMaxTokensAction 不应被调用（调用方判 STREAM_INCOMPLETE 后跳过）
    // 此处验证 decideMaxTokensAction 对未完成 tool_call partial 也不走 prefill（防御）
    const partial: PartialMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_call', id: 'x', name: 'n', arguments: null as unknown as Record<string, unknown> },
      ],
    };
    const action = decideMaxTokensAction(partial, anthropicModel(8000), 4000, 'continue');
    expect(action.action).not.toBe('prefill');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// §3 CONTEXT_LENGTH 压缩 + 粘性预压缩
// ──────────────────────────────────────────────────────────────────────────

describe('applyContextLengthEscalation 粘性预压缩', () => {
  it('首次触发 → consecutive=1，达阈值 → precompress=true', () => {
    const state: LengthErrorState = {};
    const next = applyContextLengthEscalation(state);
    expect(next.consecutiveContextLength).toBe(1);
    expect(next.precompress).toBe(true); // 阈值=1，首次即达
  });

  it('达阈值后 precompress 持续生效（不自动清）', () => {
    let state: LengthErrorState = {};
    state = applyContextLengthEscalation(state); // 1 → precompress=true
    state = applyContextLengthEscalation(state); // 2 → precompress 仍 true
    expect(state.consecutiveContextLength).toBe(2);
    expect(state.precompress).toBe(true);
  });

  it('不 mutate 原 state', () => {
    const orig: LengthErrorState = {};
    const next = applyContextLengthEscalation(orig);
    expect(orig.consecutiveContextLength).toBeUndefined();
    expect(next.consecutiveContextLength).toBe(1);
  });

  it(`阈值 = ${PRECOMPRESS_TRIGGER_THRESHOLD}`, () => {
    expect(PRECOMPRESS_TRIGGER_THRESHOLD).toBe(1);
  });
});

describe('applyCompressOverlay', () => {
  it('precompress=false → 不压缩（原样返回）', () => {
    const req = baseReq(4000);
    const compressor: ContextCompressor = {
      compact: () => {
        throw new Error('should not be called');
      },
    };
    const out = applyCompressOverlay(req, { precompress: false }, compressor);
    expect(out).toBe(req); // 同一引用
  });

  it('precompress=true → 调 compressor.compact，targetRatio=0.8', () => {
    const req = baseReq(4000);
    let calledRatio: number | undefined;
    const compressor: ContextCompressor = {
      compact: (msgs, opts) => {
        calledRatio = opts.targetRatio;
        return [...msgs, { role: 'user', content: [{ type: 'text', text: 'COMPRESSED' }] }];
      },
    };
    const out = applyCompressOverlay(req, { precompress: true }, compressor);
    expect(calledRatio).toBe(COMPRESS_TARGET_RATIO);
    expect(calledRatio).toBe(0.8);
    const last = out.messages[out.messages.length - 1]!;
    expect(last.content).toContainEqual({ type: 'text', text: 'COMPRESSED' });
  });
});

describe('computeContextLengthMaxTokensAdjustment 不瞎猜窗口', () => {
  it('provider 未报告 context window → 不调整（原样返回）', () => {
    expect(computeContextLengthMaxTokensAdjustment(4000, 10000, undefined)).toBe(4000);
  });

  it('未超窗 → 不调整', () => {
    // 4000 + 5000 = 9000 ≤ 10000
    expect(computeContextLengthMaxTokensAdjustment(4000, 5000, 10000)).toBe(4000);
  });

  it('超窗 → 降 max_tokens 腾输入空间', () => {
    // 4000 + 8000 = 12000 > 10000 → 降为 10000-8000=2000
    expect(computeContextLengthMaxTokensAdjustment(4000, 8000, 10000)).toBe(2000);
  });

  it('降后低于 modelLowerBound → 封底 modelLowerBound', () => {
    // 10000 - 9999 = 1 < 1024 → 封底 1024
    expect(computeContextLengthMaxTokensAdjustment(4000, 9999, 10000)).toBe(1024);
  });

  it('自定义 modelLowerBound', () => {
    expect(computeContextLengthMaxTokensAdjustment(4000, 9999, 10000, 512)).toBe(512);
  });

  it('§3.3 不瞎猜窗口：本次调用降 max_tokens，不写持久化（函数纯计算）', () => {
    // 函数签名本身不接 errorState，证明不写持久化（粘性只设 precompress，不改窗口）
    const adjusted = computeContextLengthMaxTokensAdjustment(4000, 8000, 10000);
    expect(adjusted).toBe(2000);
    // 注：调用方不应把 adjusted 写入 errorState.maxTokensOverlay（那是 MAX_TOKENS bump 的）
    // 也不应改 model.capabilities.maxOutputTokens 或 contextWindow
  });
});
