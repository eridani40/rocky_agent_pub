/**
 * buildInvokeContext —— 生产路径 InvokeContext 共享构造器
 * 参考: specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §2.1 §4 §6.4
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md §2.1（callLLM 接入）
 *       specs/tech/agent/providers_and_models/[P0]llm_client_interface.md §3.8（onWire 物理层钩子）
 *
 * onWire 接线：fallback.client + clientFactory.getClient 派生的 LlmClient 都用 withOnWire
 *   绑本次 invoke 的 onWire → recordWireBody → langfuse metadata.physical_wire_body
 *   （spec §3.8 + observability overall §5.2）。
 * fallback_chain 多 provider：可选 llmRequestConfig + allProviders + health 注入；chain 非空时
 *   resolveTarget 走 pickFirstAvailableTarget 选下一个 provider（连续 overload → 切 provider）；
 *   chain 空（默认单 provider 配置）→ 走 fallback 单 target 兜底。
 *
 * 关键不变式：zero-config——只从 client.getInfo() + controller + errorState 派生 InvokeContext
 * 基础形态；多 provider chain 通过可选 llmRequestConfig/allProviders/health 注入解锁。
 */
import type { LlmClient } from '../client';
import type { LlmProviderConfig, LlmModelConfig } from '../provider-types';
import type { StreamEvent } from '../protocol';
import type { InvokeContext, ObservabilityPort } from './llm_caller';
import type { LlmRequestConfig } from '../../config/llm_request_config';
import type { ProviderHealthRegistry } from './provider_health_registry';
import type { LlmErrorState } from './llm_error_state';
import type { AbortControllerHandle } from '../../agent/agent-interface';
// dev 调试日志（llm hook，透传到 InvokeContext.logWriter）
import type { LogWriter } from '../../dev-logs/log-writer';

/** buildInvokeContext 输入。 */
export interface BuildInvokeContextInput {
  /** SessionConfig.client（已绑定 4 件套，提供 stream） */
  client: LlmClient;
  /** RunState.llmErrorState（跨 iteration overlay 继承） */
  errorState: LlmErrorState;
  /**
   * session 标识 —— health registry 按 (sessionId, provider, key, model) 四元组
   * 存储(per-session × per-model 双隔离,见 [P0]provider_health_registry §1/§6.5)。
   * agent-loop 从 RunState/sessionId 注入;未传时用 ''(单 session 兜底)。
   */
  sessionId?: string;
  /** agent loop 的内存 controller（用户中断信号源） */
  controller: AbortControllerHandle;
  /** observability 端口（langfuse 桥接，可 undefined = 不上报） */
  observability?: ObservabilityPort;
  /** 后台路径标记（forked summary/title 用，true 时 overload 直接 fail 防雪崩） */
  backgroundPath?: boolean;
  /** StreamEvent 转发回调（agent loop 在此调 consumer.consume + emit） */
  onEvent?: (evt: StreamEvent) => void;
  /**
   * llm_request config（含 fallback_chain）。
   * 不传或 fallbackChain 空 → 走单 target 兜底（向后兼容）。
   */
  llmRequestConfig?: LlmRequestConfig;
  /**
   * 多 provider 实例表（fallback_chain 命中时 resolveTarget 查找用）。
   * 不传 → 只用从 client.getInfo() 派生的单一 provider（chain 即使配置也会因查不到而 all_dead，
   * 但 chain 空时不受影响）。
   */
  allProviders?: LlmProviderConfig[];
  /** 健康表（多 provider fallback 用），不传 → invoke 内部用进程单例 */
  health?: ProviderHealthRegistry;
  /**
   * dev 调试日志（llm hook，spec dev-logs §3.1）。
   * 透传到 InvokeContext.logWriter；缺省 undefined → 不写（开关 false 也早 return 零开销）。
   * 由 stage-llm/forked-agent 从 SessionConfig.logWriter 注入。
   */
  logWriter?: LogWriter;
  /**
   * [v0.0.347] 模型路由方案（SessionConfig.modelRoutingPlan 透传；分支 2 才有）。
   * 有 routingPlan → invoke 走 routingAttemptLoop（候选决策循环）；缺省 undefined → 现有路径。
   */
  routingPlan?: import('./llm_caller').InvokeContext['routingPlan'];
  /**
   * [v0.0.347] 熔断注册表（进程内存单例；缺省 undefined → routing_loop 用 globalThis 单例）。
   */
  circuitRegistry?: import('./circuit_breaker_registry').CircuitBreakerRegistry;
  /**
   * [v0.0.347] 按 (providerId, modelId) 真实组装 LlmClient 的 builder（routing 多候选模型用）。
   * 缺省 undefined → clientFactory 保持占位（恒返回 input.client，向后兼容）。
   * 生产路径由装配层从 SessionConfig.appConfig + pluginManager 注入 buildLlmClient。
   */
  clientBuilder?: (providerId: string, modelId: string) => LlmClient;
}

/**
 * 从单一 client 句柄构造完整 InvokeContext（让 invoke 真生效）。
 *
 * 产出形态：
 *   - providers Map：单条目 {id → providerConfig}（chain 空 时唯一条目；chain 非空时合并 allProviders）
 *   - fallback：单 target 兜底（resolveTarget 空 chain 路径用，client 经 withOnWire 绑本次 onWire）
 *   - clientFactory.getClient：用 withOnWire 派生绑 onWire 的 client（chain 非空时被调）
 *
 * credentials 处理（spec §3.3）：本构造器不暴露真 credentials（client 内部持有发请求）。
 *   重建的 providerConfig.credentials 用占位 {key:'<bound>'}，resolveKey 取出后 keyValue 不参与
 *   client.stream（client 已绑定真 credential）；仅用于 health 字段对齐 + decideAction 判定
 *   ROTATE_KEY 时 isAccountWideQuota 的兜底。
 *
 * @returns InvokeContext（含 providers/clientFactory/fallback/errorState/controller/observability/onEvent）
 */
export function buildInvokeContext(input: BuildInvokeContextInput): InvokeContext {
  // 能力探测：生产 LlmClient 实例有 getInfo()；旧测试 stub（duck-typed {stream()}）无 → 兜底最小形状。
  const clientWithInfo = input.client as LlmClient & { getInfo?: () => unknown };
  const hasInfo = typeof clientWithInfo.getInfo === 'function';
  const info = hasInfo
    ? (clientWithInfo.getInfo!() as {
        providerId: string; providerName: LlmProviderConfig['name']; modelId: string;
        capabilities: NonNullable<LlmModelConfig['capabilities']>; maxOutputTokens: number;
      })
    : {
        providerId: 'stub', providerName: 'anthropic_compatible' as const, modelId: 'stub',
        capabilities: { maxOutputTokens: 8192, supportsPrefill: false, supportsThinking: false },
        maxOutputTokens: 8192,
      };

  // 重建最小 LlmModelConfig（buildRequest 取 capabilities + maxOutputTokens）
  const model: LlmModelConfig = {
    modelId: info.modelId,
    inputModalities: ['text'],
    outputModalities: ['text'],
    contextWindow: 0, // 生产 fallback 路径不消费此字段（client 已绑定真值）
    maxOutputTokens: info.maxOutputTokens,
    paramConstraints: {},
    pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
    providerId: info.providerId,
    // protocolId 属 provider 级（provider.protocolId），model 不含
    capabilities: info.capabilities,
  };

  // 重建最小 LlmProviderConfig（decideAction 取 credentials 判 ROTATE_KEY）
  // credentials 用占位（client 内部持有真 credential 发请求；resolveKey 仅用于字段对齐）
  const provider: LlmProviderConfig = {
    id: info.providerId,
    name: info.providerName,
    // protocolId 必填（兜底 'anthropic_messages'；fallback 路径不消费此字段，仅占位）
    protocolId: 'anthropic_messages',
    baseUrl: '',
    credentials: { key: '<bound-in-client>' },
    pluginId: 'builtin.anthropic',
    enabled: true,
    models: [model],
  };

  // providers Map：合并「单一 client 派生 provider」+「allProviders（多 provider 配置）」。
  // chain 空 → 只 1 条（client 派生）；chain 非空 → 含 allProviders 的全部条目供 resolveTarget 查找。
  const providers = new Map<string, LlmProviderConfig>([[provider.id, provider]]);
  if (input.allProviders) {
    for (const p of input.allProviders) {
      // 不覆盖 client 派生的条目（保持 fallback 路径优先用 client 绑定的 provider）
      if (!providers.has(p.id)) providers.set(p.id, p);
    }
  }

  // 本次 invoke 的 onWire 闭包：透传给 client.withOnWire，由 LlmClient 在
  // prepare（encode）后 fetch 前调用 → 触发 observability.recordWireBody（写 langfuse metadata）。
  // invoke 内每 attempt 重新调 clientFactory.getClient 传新 onWire → 新 client 实例（共享 4 件套）。
  // 能力探测（CLAUDE.md「运行时兼容性」）：duck-typed stub client 无 withOnWire 方法 →
  // 返原 client（向后兼容旧测试 stub）；生产 LlmClient 实例必有此方法。
  const bindOnWire = (
    srcClient: LlmClient,
    onWire?: (req: unknown, body: unknown, url: string) => void,
  ): LlmClient => {
    if (!onWire) return srcClient;
    const withOnWireFn = (srcClient as LlmClient & {
      withOnWire?(onWire: Parameters<LlmClient['withOnWire']>[0]): LlmClient;
    }).withOnWire;
    if (typeof withOnWireFn !== 'function') return srcClient;
    return withOnWireFn.call(srcClient, onWire as Parameters<LlmClient['withOnWire']>[0]);
  };

  return {
    errorState: input.errorState,
    sessionId: input.sessionId,
    controller: input.controller,
    observability: input.observability,
    backgroundPath: input.backgroundPath,
    onEvent: input.onEvent,
    providers,
    config: input.llmRequestConfig,
    health: input.health,
    logWriter: input.logWriter,
    // [v0.0.347] 模型路由方案 + 熔断注册表透传（分支 2；缺省 undefined → invoke 走现有路径/用单例）
    routingPlan: input.routingPlan,
    circuitRegistry: input.circuitRegistry,
    // fallback.client 经 withOnWire 绑本次 invoke 的 onWire
    // （resolveTarget 空 chain 路径用此 target；onWire 在 invoke 外层闭包里捕获 attempt 号）
    fallback: { provider, keyRef: 'default', model, client: input.client },
    // clientFactory：
    //  - 生产路径注入 clientBuilder（routing 多候选模型）→ 按 (provider, model) 真实组装 client
    //  - 缺省（旧测试 stub / 非 routing 场景）→ 占位：恒返回 input.client 绑 onWire（向后兼容）
    //  - 两者都经 withOnWire 绑本次 invoke 的 onWire（spec §6.4）
    clientFactory: {
      getClient: (
        provider: LlmProviderConfig,
        _keyRef: string,
        _keyValue: string,
        model: LlmModelConfig,
        onWire?: (req: unknown, body: unknown, url: string) => void,
      ): LlmClient => {
        if (input.clientBuilder) {
          // 真实按 (providerId, modelId) 组装（buildLlmClient 路径，装配层注入）
          const built = input.clientBuilder(provider.id, model.modelId);
          return bindOnWire(built, onWire);
        }
        // 占位路径（向后兼容）：恒返回 input.client
        return bindOnWire(input.client, onWire);
      },
    },
  };
}
