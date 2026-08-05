/**
 * v0.0.144 需求2 — llm_request config 装配接线 UT（config 生效验证）
 * 参考: specs/tech/version_logs/v0.0.144/change_plan.md「需求 2」
 *       specs/tech/agent/llm_caller/[P0]llm_request_config.md §1.2（缺省回退 DEFAULT）
 *       specs/tech/agent/llm_caller/[P0]llm_caller.md §3（invoke 读 config.retry.max_attempts）
 *
 * 验证 invoke 的重试次数由 ctx.config.retry.max_attempts 驱动（= SessionConfig.llmRequestConfig
 * 一路透传的终点），证明装配接线后 config 真正生效：
 *   - 注入 max_attempts=5 + stub client 恒错（空响应）→ attempt 循环跑满 5 次
 *   - 注入 max_attempts=1 → 仅 1 次不重试
 *   - ctx.config=undefined → 回退 DEFAULT_LLM_REQUEST_CONFIG（max_attempts=3）
 *
 * 恒错手段：stub client 每次 stream 只 yield finish(stop) 无 content → invoke 归类
 *   EMPTY_RESPONSE（retryable 瞬时、shouldFallbackProvider=false）→ 单 provider 空 chain 下
 *   attempt<max 走 RETRY_BACKOFF、attempt==max 走 NO_RETRY 抛出。stream 调用次数 = attempt 次数。
 *   backoff 全置 0 避免退避 sleep 拖慢测试。
 *
 * 文件系统隔离：不触真实路径；health 每例用独立 registry 隔离。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { invoke, type InvokeBaseReq } from '../llm_caller';
import { buildInvokeContext } from '../build_invoke_context';
import { createLlmErrorState } from '../llm_error_state';
import {
  createProviderHealthRegistry,
  __resetProviderHealthRegistryForTest,
} from '../provider_health_registry';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../../config/llm_request_config';
import type { LlmClient } from '../../client';
import type { StreamEvent } from '../../protocol';

/**
 * 构造「恒错」stub client：每次 stream 只发 finish(stop) 无内容 → invoke 归类 EMPTY_RESPONSE。
 * 返回 calls() 读取 stream 被调用（= attempt）次数。
 */
function makeCountingEmptyClient(): { client: LlmClient; calls: () => number } {
  let count = 0;
  const stream = async function* (_req: unknown, _signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    count++;
    // 空响应：无 text / 无 tool_call，仅正常 finish → attemptLoop 判 EMPTY_RESPONSE（可重试瞬时）
    yield { type: 'finish', reason: 'stop' };
  };
  const client = {
    stream,
    getInfo: () => ({
      providerId: 'p1',
      providerName: 'anthropic_compatible' as const,
      modelId: 'm1',
      maxOutputTokens: 8192,
      capabilities: { maxOutputTokens: 8192, supportsPrefill: true, supportsThinking: false },
    }),
  } as unknown as LlmClient;
  return { client, calls: () => count };
}

function makeBaseReq(): InvokeBaseReq {
  return {
    modelId: 'm1',
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: { stream: true, maxTokens: 1024 },
  };
}

/** 零退避 config（避免 sleep 拖慢），仅覆盖 max_attempts。 */
function configWithMaxAttempts(max: number) {
  return {
    ...DEFAULT_LLM_REQUEST_CONFIG,
    retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, max_attempts: max, backoff_base_s: 0, backoff_cap_s: 0, jitter: false },
  };
}

beforeEach(() => {
  __resetProviderHealthRegistryForTest();
});

describe('[v0.0.144 需求2] invoke 重试次数由 ctx.config.retry.max_attempts 驱动', () => {
  it('注入 max_attempts=5 → 恒错时 attempt 跑满 5 次', async () => {
    const { client, calls } = makeCountingEmptyClient();
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
    });
    ctx.config = configWithMaxAttempts(5);
    ctx.health = createProviderHealthRegistry();

    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    expect(calls()).toBe(5);
  });

  it('注入 max_attempts=1 → 仅 1 次不重试', async () => {
    const { client, calls } = makeCountingEmptyClient();
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
    });
    ctx.config = configWithMaxAttempts(1);
    ctx.health = createProviderHealthRegistry();

    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    expect(calls()).toBe(1);
  });

  it('ctx.config=undefined → 回退 DEFAULT_LLM_REQUEST_CONFIG（max_attempts=3）', async () => {
    const { client, calls } = makeCountingEmptyClient();
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
    });
    // 不设 ctx.config → invoke 内 `ctx.config ?? DEFAULT_LLM_REQUEST_CONFIG` 回退默认（向后兼容）
    ctx.health = createProviderHealthRegistry();
    expect(ctx.config).toBeUndefined();
    expect(DEFAULT_LLM_REQUEST_CONFIG.retry.max_attempts).toBe(3);

    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    expect(calls()).toBe(3);
  });
});
