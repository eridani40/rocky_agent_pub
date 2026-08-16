/**
 * buildRequest —— wire body modelId 由 caller 现场注入，buildRequest 不二次改写（T4 根治版）。
 * 参考: specs/tech/version_logs/v0.0.353/model-routing-trace-correctness/change_plan.md D7
 *
 * 覆盖:
 *   1. buildRequest 不修改 baseReq.modelId（caller 已注入正确值）
 *   2. buildRequest 不修改传入的 baseReq 对象
 *   3. maxTokens/precompress overlay 既有行为不回归
 */
import { describe, it, expect } from 'vitest';
import { buildRequest } from '../build_request';
import { createLlmErrorState } from '../llm_error_state';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../../config/llm_request_config';
import type { CanonicalRequest } from '../../protocol';
import type { LlmModelConfig } from '../../provider-types';
import type { ContextCompressor } from '../length_context';

function makeModel(modelId: string): LlmModelConfig {
  return {
    modelId,
    inputModalities: ['text'],
    outputModalities: ['text'],
    contextWindow: 200000,
    maxOutputTokens: 8192,
    paramConstraints: {},
    providerId: 'p1',
    pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
    capabilities: { maxOutputTokens: 8192, supportsPrefill: false, supportsThinking: false },
  };
}

function makeBaseReq(modelId = 'baseModel'): CanonicalRequest {
  return {
    modelId,
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: { stream: true, maxTokens: 1024 },
  };
}

const config = DEFAULT_LLM_REQUEST_CONFIG;

/**
 * T4 根治版核心断言：buildRequest 信任 caller 已注入正确 modelId，自身不再改写。
 * 若 buildRequest 内部再重写，会导致 routing_loop/llm_caller 调用点注入权被覆盖。
 */
it('buildRequest 不修改 baseReq.modelId（即使 model 参数不同）', () => {
  const baseReq = makeBaseReq('caller-injected-model');
  const targetModel = makeModel('deepseek-chat');
  const { req } = buildRequest({ baseReq, errorState: createLlmErrorState(), model: targetModel, config });
  expect(req.modelId).toBe('caller-injected-model');
});

it('同值幂等：baseReq.modelId 与 target.modelId 一致时，结果不变', () => {
  const baseReq = makeBaseReq('deepseek-chat');
  const targetModel = makeModel('deepseek-chat');
  const { req } = buildRequest({ baseReq, errorState: createLlmErrorState(), model: targetModel, config });
  expect(req.modelId).toBe('deepseek-chat');
});

it('不可变：buildRequest 不修改传入的 baseReq 对象', () => {
  const baseReq = makeBaseReq('baseModel');
  const before = JSON.stringify(baseReq);
  buildRequest({ baseReq, errorState: createLlmErrorState(), model: makeModel('other'), config });
  expect(JSON.stringify(baseReq)).toBe(before);
});

it('overlay 不回归：maxTokens 派生与 precompress 仍然生效', () => {
  const baseReq: CanonicalRequest = {
    ...makeBaseReq('baseModel'),
    params: { stream: true, maxTokens: 4096 },
  };
  const targetModel = makeModel('target');
  const compressor: ContextCompressor = {
    compact: (messages) => messages.slice(0, 1),
  };
  const errorState = createLlmErrorState();
  errorState.precompress = true;
  const { req, appliedPrefill } = buildRequest({
    baseReq,
    errorState,
    model: targetModel,
    config,
    compressor,
  });
  expect(req.modelId).toBe('baseModel');
  // maxTokens 派生：base=4096，无 recent errors → 保持 4096，并 cap 到 model 上限 8192
  expect(req.params.maxTokens).toBe(4096);
  // precompress 生效：messages 被 compressor 处理
  expect(req.messages).toHaveLength(1);
  expect(appliedPrefill).toBe(false);
});
