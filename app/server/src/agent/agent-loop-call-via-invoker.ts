/**
 * callLLMViaInvoker —— callLLM 走 LlmCaller.invoke 的适配路径
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §2.1（[v0.0.25] 接入改造）
 *       specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §4
 *
 * 职责：当 CallLLMInput 注入了 llmCaller + runState.llmErrorState + client 时，把 baseReq +
 * InvokeContext 传给 invoke，并通过 onEvent 把 StreamEvent 转发给 StreamConsumer
 * （保留 agent loop 的 emit 责任 + group 选择）。
 *
 * 生产接线：用 buildInvokeContext 从 client 句柄构造完整 InvokeContext
 * （providers/clientFactory/fallback 全部派生），让 invoke 真生效。
 * main（agent-loop-call-main）+ 旁路 run（run-react-loop）都注入 llmCaller → 走本路径。
 *
 * 单文件 ≤300 行。
 */
import type { RunKind } from '../../../shared/src/types/session-kind';
import type { CanonicalRequest, StreamEvent } from '../llm/protocol';
import type { InvokeResponse } from '../llm/caller/llm_caller';
import type { LlmClient } from '../llm/client';
import type { LlmProviderConfig } from '../llm/provider-types';
import type { LlmRequestConfig } from '../config/llm_request_config';
import type { ProviderHealthRegistry } from '../llm/caller/provider_health_registry';
import type { StreamConsumer } from './agent-loop-stream';
import type { CallLLMInput, CallLLMResult } from './agent-loop-base';
import { buildInvokeContext } from '../llm/caller/build_invoke_context';
// [v0.0.25 rev2] LlmAttemptEvent（llm_caller retry/fallback 进度外显）
import { ulid } from '../config/ulid';
import type { LlmAttemptEvent } from './agent-event-types';

/**
 * 走 LlmCaller.invoke 路径（spec §4 client.stream → llmCaller.invoke）。
 *
 * - 用 buildInvokeContext 从 input.client 派生完整 InvokeContext（providers/clientFactory/fallback）。
 * - invoke 内部聚合流为 InvokeResponse，本函数通过 onEvent 转发 StreamEvent 给 consumer（保留 emit 责任）。
 * - 错误：invoke throw ClassifiedLlmError（不塌缩 LOOP_ERROR），直接上抛给 caller。
 * - [v0.0.25 rev2] onEvent 拦截 llm_attempt StreamEvent → 转 LlmAttemptEvent AgentEvent emit 到 bus。
 *
 * 注：consumer 已通过 onEvent 等价聚合 message/usage（与旧路径一致的 emit 闭环），
 *     这里直接 buildMessage，不读 invoke 返回的 protocol-types Message（类型不兼容）。
 */
export async function callLLMViaInvoker(
  input: CallLLMInput,
  consumer: StreamConsumer,
): Promise<CallLLMResult> {
  const { sessionId, runId, modelId, messages, tools, controller, maxOutputTokens, runState, backgroundPath, llmCaller, client, invokeObservability, emit, runKind } = input;
  if (!llmCaller || !runState?.llmErrorState) {
    throw new Error('callLLMViaInvoker requires llmCaller + runState.llmErrorState');
  }
  if (!client) {
    throw new Error('callLLMViaInvoker requires client (for buildInvokeContext)');
  }
  const baseReq: CanonicalRequest = {
    modelId,
    messages: messages as unknown as CanonicalRequest['messages'],
    ...(tools.length > 0 ? { tools } : {}),
    // stop seq（EOS 双保险）：装配层（build-run-deps）对 main+squad 注入 ['<EOS>']
    params: {
      stream: true,
      maxTokens: maxOutputTokens,
      ...(input.stop !== undefined && input.stop.length > 0 ? { stop: input.stop } : {}),
      // [v0.0.148] effort 透传（canonical 语义键；映射归 encode，baseReq 不做映射）
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
    },
  };

  // [v0.0.25 rev2] onEvent 转发器：llm_attempt 单独走 AgentEvent emit（不进 StreamConsumer），
  // 其余 StreamEvent 仍交 consumer.consume 聚合 message/usage（保留旧闭环）。
  // spec §3.1：llm_caller 通过 ctx.onEvent 合成 llm_attempt；此处转 AgentEvent 走同 SSE 流。
  const forwardEvent = (evt: StreamEvent): void => {
    if (evt.type === 'llm_attempt') {
      const agentEvt: LlmAttemptEvent = {
        id: ulid(),
        type: 'llm_attempt',
        sessionId,
        createdAt: new Date().toISOString(),
        runId,
        runKind,
        category: evt.category,
        providerId: evt.providerId,
        modelId: evt.modelId,
        keyRef: evt.keyRef,
        attempt: evt.attempt,
        maxAttempts: evt.maxAttempts,
        action: evt.action,
        message: evt.message,
      };
      emit(agentEvt);
      return;
    }
    consumer.consume(evt);
  };

  // 用 buildInvokeContext 从 client 派生完整 InvokeContext
  // 生产路径（main / 旁路 run）的 client 永远是 LlmClient 实例（SessionConfig.client）
  // [v0.0.25 retry-1 P2] 透传可选 llmRequestConfig / allProviders / health（多 provider fallback 接通）
  // [v0.0.25 T15 rev2] sessionId 接线：从 input.sessionId 注入 InvokeContext（health 按 (sessionId,...) 四元组）
  const ctx = buildInvokeContext({
    client: client as unknown as LlmClient,
    errorState: runState.llmErrorState,
    sessionId,
    controller,
    backgroundPath,
    observability: invokeObservability,
    onEvent: forwardEvent,
    llmRequestConfig: input.llmRequestConfig,
    allProviders: input.allProviders,
    health: input.health,
    logWriter: input.logWriter,
  });
  await llmCaller.invoke(baseReq, ctx);
  // invoke 已通过 onEvent 转发 StreamEvent 给 consumer，consumer 已聚合 message/usage。
  const assistantMessage = consumer.buildMessage(sessionId);
  const usage = consumer.getLastUsage();
  return { assistantMessage, usage };
}
