/**
 * v0.0.347 T2 装配链回归 — buildInvokeContext clientFactory 双分支 + routingPlan 透传
 * 参考: specs/tech/version_logs/v0.0.347/change_plan.md（resolve / llm-routing 模块）
 *
 * 背景（本次回归根因）：
 *   T2 把 clientFactory 从占位（恒返回 input.client）改为 clientBuilder 注入分支；
 *   loop-stage-llm 曾无条件注入 clientBuilder → 测试 mock client 被真实 buildLlmClient
 *   覆盖 → AgentLoop 系列 6 文件 25 例全挂（stopReason=error）。
 *   修复 = 仅在有 routingPlan 时注入 clientBuilder；本测试兜底装配链断线点：
 *     1. 无 clientBuilder → getClient 恒返回 input.client（占位回退，向后兼容）
 *     2. 有 clientBuilder → getClient 按 (providerId, modelId) 调 builder，用真实构造结果
 *     3. routingPlan / circuitRegistry 透传（有=进 routing 分支；无=undefined 现有路径）
 */
import { describe, it, expect } from 'vitest';
import { buildInvokeContext } from '../build_invoke_context';
import { createLlmErrorState } from '../llm_error_state';
import type { LlmClient } from '../../client';
import type { LlmProviderConfig, LlmModelConfig } from '../../provider-types';
import type { StreamEvent } from '../../protocol';

/** 最小 stub client（getInfo → p1/m1，与 buildInvokeContext 能力探测匹配） */
function makeStubClient(): LlmClient {
  const stream = async function* (_req: unknown, _signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    yield { type: 'finish', reason: 'stop' };
  };
  return {
    stream,
    getInfo: () => ({
      providerId: 'p1',
      providerName: 'anthropic_compatible' as const,
      modelId: 'm1',
      maxOutputTokens: 8192,
      capabilities: { maxOutputTokens: 8192, supportsPrefill: true, supportsThinking: false },
    }),
  } as unknown as LlmClient;
}

/** 与 buildInvokeContext 内部重建形状一致的 provider/model（clientFactory 只读 id/modelId） */
const provider: LlmProviderConfig = {
  id: 'p1',
  name: 'anthropic_compatible',
  protocolId: 'anthropic_messages',
  baseUrl: '',
  credentials: { key: 'x' },
  pluginId: 'builtin.anthropic',
  enabled: true,
  models: [],
} as LlmProviderConfig;
const model: LlmModelConfig = { modelId: 'm1' } as LlmModelConfig;

describe('[v0.0.347 T2 装配链回归] clientFactory 双分支', () => {
  it('无 clientBuilder → getClient 恒返回 input.client（占位回退，向后兼容）', () => {
    const client = makeStubClient();
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
    });
    // 无 onWire → bindOnWire 返原对象；getClient 结果必须仍是注入的 mock client
    const got = ctx.clientFactory.getClient(provider, 'default', 'key', model, undefined);
    expect(got).toBe(client);
  });

  it('有 clientBuilder → getClient 按 (providerId, modelId) 调 builder 并返回真实构造结果', () => {
    const inputClient = makeStubClient();
    const builtClient = makeStubClient(); // 区分：builder 产物 ≠ input.client
    const builder = (providerId: string, modelId: string) => {
      expect(providerId).toBe('p1');
      expect(modelId).toBe('m1');
      return builtClient;
    };
    const ctx = buildInvokeContext({
      client: inputClient,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
      clientBuilder: builder,
    });
    const got = ctx.clientFactory.getClient(provider, 'default', 'key', model, undefined);
    // 必须走 builder 构造（routing 多候选模型真实组装），不能回退 input.client
    expect(got).toBe(builtClient);
    expect(got).not.toBe(inputClient);
  });

  it('有 clientBuilder + onWire → 构造结果绑 onWire（withOnWire 派生）', () => {
    const builtClient = makeStubClient();
    let wired: unknown = null;
    const withOnWireFn = (onWire: unknown) => {
      wired = onWire;
      return builtClient;
    };
    (builtClient as LlmClient & { withOnWire?: unknown }).withOnWire = withOnWireFn;
    const ctx = buildInvokeContext({
      client: makeStubClient(),
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
      clientBuilder: () => builtClient,
    });
    const onWire = () => undefined;
    const got = ctx.clientFactory.getClient(provider, 'default', 'key', model, onWire);
    expect(got).toBe(builtClient);
    expect(wired).toBe(onWire);
  });
});

describe('[v0.0.347 T2 装配链回归] routingPlan / circuitRegistry 透传', () => {
  it('无 routingPlan → ctx.routingPlan undefined（分支 1 现有路径零改动）', () => {
    const ctx = buildInvokeContext({
      client: makeStubClient(),
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
    });
    expect(ctx.routingPlan).toBeUndefined();
    expect(ctx.circuitRegistry).toBeUndefined();
  });

  it('有 routingPlan + circuitRegistry → 原样透传到 ctx（分支 2 进 routingAttemptLoop）', () => {
    const routingPlan = {
      planId: 'plan-1',
      items: [{ providerId: 'p1', modelId: 'm1', enabled: true }],
      circuit: { failureThreshold: 4 },
    } as never;
    const circuitRegistry = {} as never;
    const ctx = buildInvokeContext({
      client: makeStubClient(),
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
      routingPlan,
      circuitRegistry,
    });
    expect(ctx.routingPlan).toBe(routingPlan);
    expect(ctx.circuitRegistry).toBe(circuitRegistry);
  });
});
