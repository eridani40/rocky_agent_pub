/**
 * loop-stage-llm — 统一 LLM 调用 stage（v0.0.49 新建，替代 callLLMForMain/callLLMForForked）
 * 参考: specs/tech/version_logs/v0.0.49/design.md §2 ②（line 95-116）+ §1 D2
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §2.1（callLLM 原语）
 *
 * 定位：骨架 ② 段直调 base.callLLM。原 callLLMForMain/callLLMForForked 包装层删除后，
 * langfuse observability port 构造 + obs.startGeneration 内联到本 helper。
 * main/forked 差异由 RunSpec 字段透传（backgroundPath/stopSequences/eosStripper/runKind），
 * 无 if main/forked 分支。
 *
 * 行为 1:1 对齐原 callLLMForMain / callLLMForForked（保零回归）：
 *   1. messageId 分配（agentToolContext.currentMessageId 注入，squad_tools §0）
 *   2. obs.startGeneration（messages + inputCharCount + system text）
 *   3. createLangfuseObservabilityPort（invoke 内部 endGeneration 闭环）
 *   4. base.callLLM（messages = [snapshot.system, ...snapshot.messages]；stop/eosStripper 透传）
 *   5. eosStripper（main squad only；forked undefined 不调）
 *   6. obs.recordLastAssistant + 写回 state.lastAssistantContent
 */
import { ulid } from '../config/ulid';
import type { Message, Usage } from '../message/types';
import { toProtocolMessage } from './agent-loop-helpers';
import { firstText } from './assemble-pipeline';
import { callLLM as baseCallLLM } from './agent-loop-base';
import { invoke as llmCallerInvoke } from '../llm/caller/llm_caller';
import { createLangfuseObservabilityPort } from '../llm/caller/langfuse_observability_port';
// [v0.0.50 T1] sender 展平公共层：messages → LLM 视图（prefix 入首块 TextBlock）
// 调 protocol.encode / client.call 前先 toLogicalMessages；logical 产物同时喂 obs.startGeneration
// 参考: specs/tech/agent/providers_and_models/[P0]llm_logical_view.md §4（调用点）
import { toLogicalMessages } from '../llm/logical-view';
import type { LogWriter } from '../dev-logs/log-writer';
import type { LoopState, RunSpec } from './loop-ports';
// [v0.0.347] 模型路由：clientBuilder（routing 多候选模型按 (providerId, modelId) 真实组装 client）
import { buildLlmClient } from '../llm-client-factory';

/**
 * 统一 LLM 调用（骨架 ② 段，design §2 line 95-116）。
 *
 * @param spec RunSpec（透传 backgroundPath/stopSequences/eosStripper/runKind/toolDefinitions）
 * @param state LoopState（读 snapshot + buffer；写 lastAssistantContent；invoke 读 llmErrorState）
 * @returns assistant Message + per-call usage；caller → ingest assistant + onUsage
 */
export async function callLLMForSpec(
  spec: RunSpec,
  state: LoopState,
): Promise<{ assistant: Message; usage: Usage | null }> {
  const { config, controller, runId, runKind, scopeId, observability: obs } = spec;
  const sid = config.sessionId;
  // [v0.0.173] snapshot 永远 rebuild（assemble 链产出稳定 messages），但 base_builder 之后的
  //   6 个清理 reducer（snip/orphan/think/fill/empty/role_merge）已剥到 clean view EP——
  //   喂 LLM 前必须经 getCleanSnapshot 跑清理视图（深克隆 + clean 链），snapshot 自身不被触碰。
  //   forked agent 走同一 callLLMForSpec（loop-stage-llm.ts:40 入口，main+forked 共用）——一处覆盖。
  //   衔接链：assemble → state.snapshot（稳定）→ getCleanSnapshot（清理）→ encode（wire 合并）
  //   参考: change_plan §四 + 开放点 A3
  const rawSnapshot = state.snapshot!;
  const cleanSnapshot = await spec.wireContextEngine.getCleanSnapshot(rawSnapshot, scopeId);
  // [v0.0.66 §2.5/§2.6] messages = [snapshot.system, ...snapshot.messages]：
  //   base_builder 不再把 system 塞进 messages（design §1.3：system 独立由 snapshot.system 承载），
  //   本 stage 在送 LLM 前显式 prepend snapshot.system 让 protocol encode 落到 wire system 位。
  //   （旧 forked 走 state.buffer 已塞 system；旧 main 走 base_builder 产 systemMsg 在 messages[0]。
  //    两者重构后统一在此 prepend，main+forked 同一逻辑。）
  const messages: Message[] = [cleanSnapshot.system, ...cleanSnapshot.messages];
  // inputCharCount / contextWindowUsage 读原 rawSnapshot（cleanSnapshot 字段引用复用=同值，
  // 但显式取 rawSnapshot 表达「clean 不改 token 数」语义，cache 友好）
  const inputCharCount = rawSnapshot.inputCharCount;
  const systemText = firstText(rawSnapshot.system);

  // messageId 分配（[v0.0.33.3 T3] squad_tools §0：currentMessageId 注入 agentToolContext）
  const messageId = ulid();
  const rtc33 = (config as { agentToolContext?: { currentMessageId?: string } }).agentToolContext;
  if (rtc33) rtc33.currentMessageId = messageId;

  // [v0.0.50 T1] sender 展平（prefix 入首块）提前到 client.call 前；logical 视图同时喂 obs
  // 不变量（spec §4）：messages 不被 mutate；logicalMessages 是新数组（元素浅拷贝 + 首块新对象）
  const logicalMessages = toLogicalMessages(messages);
  // observability: 记录 LLM 真正看到的 messages（= logical 视图，sender 已展平；overall §5.2 + llm_logical_view §4）
  // [v0.0.80.t1] 第 5 参 contextWindowUsage 透传 snapshot 字段（change_plan §2.5 改进#2）：
  //   不在 stage-llm 内构造新字段，直接透传 snapshot.contextWindowUsage（snapshot 已 line 46 取、line 89 读 maxOutputTokens）
  const genHandle = obs.startGeneration(logicalMessages, inputCharCount, new Date(), systemText, rawSnapshot.contextWindowUsage);
  // [v0.0.50 §4.3/§6] langfuse observability port（invoke 内部 endGeneration 闭环；与原 callLLMForXxx 同构造）
  // iteration 取真实 genIteration（physical name `llm-N-physical` 与 logical 同 N 成对）；
  // model 取 config.modelId（physical generation.model）；二者让 invoke 内 onWire 触发的 physical 埋点对齐 logical
  const invokeObs = createLangfuseObservabilityPort({
    adapter: obs.getAdapter(), genHandle,
    iteration: obs.currentGenIteration(), step: obs.currentGenIteration(),
    model: config.modelId,
    // [v0.0.353 T5 D8] routingPlan 透传（config.modelRoutingPlan 有才传；无方案零行为变化）。
    // buildMetadata（logical end）对称携带——与 start 侧 LoopObservability 同源。
    ...(config.modelRoutingPlan !== undefined
      ? { routingPlan: { planId: config.modelRoutingPlan.planId, planName: config.modelRoutingPlan.planName } }
      : {}),
  });

  // 调 base.callLLM 原语（chunk 循环中断 + emit + 聚合 message/usage 全在 base）
  // [v0.0.50 T1] messages 用 logical 视图（sender 已展平）；protocol.encode 拿到的即是视图形态
  const { assistantMessage: assistantMsg, usage: lastUsage } = await baseCallLLM({
    sessionId: sid,
    runId,
    client: config.client,
    modelId: config.modelId,
    messages: logicalMessages.map(toProtocolMessage),
    tools: spec.toolDefinitions,
    controller,
    emit: spec.emit,
    messageId,
    inputCharCount,
    runKind,
    maxOutputTokens: rawSnapshot.contextWindowUsage.maxOutputTokens,
    // main squad 注 EOS stop seq；forked undefined（spec.stopSequences 透传）
    stop: spec.stopSequences,
    // [v0.0.148] effort 透传（main+forked 唯一活跃路径，run-react-loop:149 调用）：
    //   config.effort 缺省 undefined → encode 走 default 档（不注入 output_config）
    effort: config.effort,
    llmCaller: { invoke: llmCallerInvoke },
    runState: state,
    // main=false；forked=true（overload 直接 fail 防雪崩）
    backgroundPath: spec.backgroundPath,
    invokeObservability: invokeObs,
    logWriter: config.logWriter as LogWriter | undefined,
    // [v0.0.144] 透传生效的 llm_request config + provider 实例表（修 v0.0.25 装配断链）：
    //   invoke 据 config.retry.max_attempts 驱动重试、config.timeout 生效 watchdog；
    //   fallback_chain 非空时用 allProviders 查找。缺省 undefined → invoke 回退 DEFAULT（向后兼容）。
    //   health 不传 → invoke 内部用进程单例（按四元组 key 隔离，spec §6.5）。
    llmRequestConfig: config.llmRequestConfig,
    allProviders: config.allProviders,
    // [v0.0.347] 模型路由：透传挂载方案（分支 2；undefined = 分支 1 现有路径零改动）
    //   clientBuilder 只在有 routingPlan 时注入——routing 多候选模型才需按 (providerId, modelId)
    //   真实组装 client（buildLlmClient 需 appConfig + pluginManager，均来自 SessionConfig）。
    //   无 routingPlan（分支 1 / 测试 mock SessionConfig）→ 不注入 → clientFactory 占位
    //   回退 config.client（恒返回注入的 client），与 T2 前行为完全一致（装配链零回归）。
    routingPlan: config.modelRoutingPlan,
    ...(config.modelRoutingPlan
      ? {
          clientBuilder: (providerId: string, modelId: string) =>
            buildLlmClient(providerId, modelId, config.appConfig as never, config.pluginManager as never),
        }
      : {}),
  });

  // EOS strip（main squad only；forked spec.eosStripper=undefined 不调）
  if (spec.eosStripper) spec.eosStripper(assistantMsg.content);

  // 同步 lastAssistantMsg 给 LoopObservability（endTrace 时填 trace output）
  obs.recordLastAssistant(assistantMsg);

  // ② → ③ 间传递
  state.lastAssistantContent = assistantMsg.content;

  return { assistant: assistantMsg, usage: lastUsage };
}
