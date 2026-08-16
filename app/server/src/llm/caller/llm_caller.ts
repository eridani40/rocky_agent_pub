/**
 * LlmCaller —— LLM 调用编排层（invoke 主入口）
 * 参考: specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §2 §3 §6
 *
 * 在 LlmClient（4 件套不可变共享）之上抽一层，收口：
 *   - 错误归一化（classify）
 *   - adaptive retry（attemptLoop + getRetryDelay 退避）
 *   - provider 降级（resolveTarget + healthRegistry）
 *   - 分阶段超时（Watchdog + CompositeAbortController）
 *   - 动态参数构建（buildRequest overlay：max_tokens bump / prefill / precompress）
 *
 * invoke 数据流（spec §3）：
 *   resolveTarget → attemptLoop(1..max_attempts) → 决策 action →
 *     RETRY_BACKOFF / ROTATE_KEY / FIX_AND_RETRY / FALLBACK / NO_RETRY
 *
 * 关键不变式（spec §6）：
 *   - 整链全 dead 才 throw（不塌缩 LOOP_ERROR）
 *   - 不可恢复错误首次即 throw
 *   - 用户 abort → throw ABORTED_BY_USER，保留 partial 于 errorState.partialResult
 *   - 所有 throw 前调 observability.endGeneration({status:'error'})
 *
 * attemptLoop / resolveTarget / buildRequest 等子模块独立。
 */
import type { CanonicalRequest, StreamEvent } from '../protocol';
import type { Message } from '../protocol-types';
import type { GenHandle } from '../../observability/types';
import type { Usage } from '../../message/types';
import type { LlmProviderConfig, LlmModelConfig, ProviderName } from '../provider-types';
import type { LlmRequestConfig } from '../../config/llm_request_config';
import type { LlmClient } from '../client';
import type { ProviderHealthRegistry } from './provider_health_registry';
import type { LlmClientFactory, ResolvedTarget } from './resolve_target';
import { resolveTarget, allDeadToClassifiedError } from './resolve_target';
import { buildRequest, applyMaxTokensOverlay, applyContextLengthOverlay, resolveLengthModelInfo } from './build_request';
import { attemptLoop } from './attempt_loop';
import { getRetryDelay } from './retry_backoff';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../config/llm_request_config';
import { getProviderHealthRegistry } from './provider_health_registry';
import { LlmErrorCategory, type ClassifiedLlmError } from './error_types';
import { decideAction } from './decide_action';
import type { LlmErrorState } from './llm_error_state';
import { clearTransientOnErrorState, appendRecentError } from './llm_error_state';
// llm_attempt SSE event emit 辅助（spec §3.1）
import { emitLlmAttempt } from './llm_attempt_emit';
import type { AbortControllerHandle } from '../../agent/agent-interface';
import type { ContextCompressor } from './length_context';
// dev 调试日志（llm hook，spec dev-logs §3.1）
import type { LogWriter } from '../../dev-logs/log-writer';
import { safeWriteLlm, type ResolvedResult } from '../../dev-logs/llm-log-helper';
// [v0.0.347] 模型路由：routingAttemptLoop（有 routingPlan 时走候选决策循环）
import { routingAttemptLoop, type RoutingPlanInput } from './routing_loop';
import type { CircuitBreakerRegistry } from './circuit_breaker_registry';
// [v0.0.359 T1] 成功 target registry（squad 用量统计归属：记调用成功那一下的 physical model）
import { recordSuccessTarget } from './success-target-registry';

/** invoke 输入的 canonical 请求（agent loop 组装的基线）。 */
export type InvokeBaseReq = CanonicalRequest;

/** observability 端口（langfuse startGeneration/endGeneration 的最小契约）。 */
export interface ObservabilityPort {
  /** 记录物理 wire body（onWire 钩子写入）。每 attempt 调一次。 */
  recordWireBody?(attempt: number, body: unknown, url: string): void;
  /**
   * [v0.0.353 T2] 记录本次 wire attempt 的真实 target（调用谁记录谁）。
   * 每次确定 target 后立即调用（分支1 resolveTarget 返回 / 分支2 routing 候选组装后），
   * 在 onWire 之前——供 physical generation 用真实 provider/model 启动。
   * target 未传时 safe 不报错（port 实现内部兜底）。
   */
  recordAttemptTarget?(target: {
    providerId: string;
    providerName: string;
    modelId: string;
  }): void;
  /**
   * [v0.0.353 T5 D9] 被跳过候选逐条记录（物理层同级 gen，标 skipped）。
   * routing_loop 6 处 skip 分支（时间窗/enabled/熔断 open/banned/resolve 失败/half-open permit）
   * continue 前调用；reason 枚举与 D9 契约一致。port 可选 + 内部 safe 包裹，
   * observability 失败绝不影响路由主流程（skip 语义本身不变）。
   */
  recordSkippedCandidate?(cand: {
    providerId: string;
    providerName?: string;
    modelId: string;
    reason: 'time_window' | 'disabled' | 'circuit_open' | 'banned' | 'resolve_failed' | 'probe_inflight';
  }): void;
  /** 成功结束。 */
  endGenerationOk?(message: Message, usage: Usage | null): void;
  /** 失败结束（不塌缩 LOOP_ERROR，带 errorCategory）。 */
  endGenerationError?(errorCategory: LlmErrorCategory, reason: string, metadata?: Record<string, unknown>): void;
  /**
   * 是否启用物理层埋点（任一 observability child logPhysical=true）。
   * invoke 在 onWire 回调里据此判定是否触发 physical generation（全 false 时零开销跳过）。
   */
  hasPhysicalChild?(): boolean;
  /**
   * 开始物理层 generation（wire body 载荷，kind=physical，无 usage/output）。
   * 在 onWire 回调里（protocol.encode 后、HTTP 前）调用；返回 handle 入 invoke 收集列表，由 finally 收尾。
   */
  startPhysicalGeneration?(wireBody: unknown, startTime: Date): GenHandle;
  /**
   * 结束物理层 generation（不带 usage/output）。invoke finally 调用，确保即使抛错也兜底 end。
   */
  endPhysicalGeneration?(handle: GenHandle, endTime: Date): void;
}

/** invoke 上下文（spec §2.1 InvokeContext）。 */
export interface InvokeContext {
  /** agent loop 的 RunState.llmErrorState（跨 iteration 继承 overlay） */
  errorState: LlmErrorState;
  /**
   * session 标识 —— health registry 按 (sessionId, provider, key, model) 四元组
   * 存储状态(per-session × per-model 双隔离,见 [P0]provider_health_registry §1/§6.5)。
   * agent-loop 从 RunState/sessionId 注入;未传时默认 ''(单 session 兜底,UT 用)。
   */
  sessionId?: string;
  /** agent loop 的内存 controller（用户中断信号源） */
  controller: AbortControllerHandle;
  /** observability 端口 */
  observability?: ObservabilityPort;
  /** 标记后台路径（summary/title）—— true 时 overload 直接 fail 不重试（防雪崩） */
  backgroundPath?: boolean;
  /** chunk 转发回调（agent loop emit 责任保留，spec §4 onEvent 决定） */
  onEvent?: (evt: StreamEvent) => void;
  /** provider 查找表（providerId → LlmProviderConfig） */
  providers: Map<string, LlmProviderConfig>;
  /** LlmClient 工厂（按 (provider,key,model) 取/建 client） */
  clientFactory: LlmClientFactory;
  /** ContextEngine 实现（precompress overlay 用） */
  compressor?: ContextCompressor;
  /** config（不传用 DEFAULT_LLM_REQUEST_CONFIG） */
  config?: LlmRequestConfig;
  /** 进程级健康表（不传用 globalThis 单例） */
  health?: ProviderHealthRegistry;
  /** 空 chain 时的单一 target 兜底（向后兼容） */
  fallback?: { provider: LlmProviderConfig; keyRef: string; model: LlmModelConfig; client: LlmClient };
  /**
   * dev 调试日志（llm hook，spec dev-logs §3.1）。
   * 缺省 undefined → 不写（开关 false 也早 return，零开销）。
   * invoke 末尾（成功）/ catch（失败）写一条 logs/llm.log：
   *   { provider, model, request: baseReq, response: InvokeResponse | error }
   */
  logWriter?: LogWriter;
  /**
   * [v0.0.347] 模型路由方案（SessionConfig.modelRoutingPlan 透传；分支 2 才有）。
   * 有 routingPlan → invokeCore 走 routingAttemptLoop（候选决策循环）；
   * 缺省 undefined → 现有 attemptLoop 路径（分支 1 零改动）。
   */
  routingPlan?: RoutingPlanInput;
  /**
   * [v0.0.347] 熔断注册表（进程内存单例；DI 注入）。
   * 缺省 undefined → routing_loop 内部用 getCircuitBreakerRegistry() 单例（生产路径）。
   * 测试注入隔离实例。
   */
  circuitRegistry?: CircuitBreakerRegistry;
}

/** invoke 返回的聚合响应（含 message / usage / stopReason）。 */
export interface InvokeResponse {
  message: Message;
  usage: Usage | null;
  stopReason: 'stop' | 'tool_use' | 'max_tokens';
}

/** attempt 重试链条目（langfuse retry_chain metadata，spec §3）。 */
interface RetryChainEntry {
  attempt: number;
  providerId: string;
  keyRef: string;
  category?: LlmErrorCategory;
  delayMs?: number;
}

/**
 * 发起一次带状态、自适应的 LLM 调用（spec §2.1）。
 *
 * @param baseReq canonical 请求基线
 * @param ctx    调用上下文（含 errorState / controller / observability / providers / clientFactory）
 * @returns 成功 → InvokeResponse；失败 → throw ClassifiedLlmError（不塌缩 LOOP_ERROR）。
 */
export async function invoke(baseReqIn: InvokeBaseReq, ctx: InvokeContext): Promise<InvokeResponse> {
  // llm hook（spec dev-logs §3.1）：invoke 级一条记录。
  // 整个 body 包 try/catch：成功 try 末尾写 response；失败 catch 写 error 后 re-throw。
  // 字段组装在 dev-logs/llm-log-helper.ts（extractLlmLogFields）。
  // 用对象容器绕开 TS 闭包 CFA 缩窄（let 在闭包赋值后会被当 null/never）。
  const lastResolved: { current: ResolvedResult | null } = { current: null };
  // 本次 invoke 的 physical generation handles（onWire 时收集，finally end）。
  // 即使 invoke 抛错（HTTP 失败 / 重试耗尽 / abort），finally 也兜底 end 防 langfuse 漏 end。
  // physical gen 数 = 真实 wire 尝试数（重试在上层循环，每次 encode 重新埋点 → 每次 onWire 推一个）。
  const physicalGens: GenHandle[] = [];
  // observabilityEnded 标志位：invokeCore 内部各 throw 点已 endGenerationError 后置 true。
  // 外层 catch 据此判定是否需补 end（spec llm_caller.md §2.1 不变量：所有 throw 前 end）。
  // 用对象容器绕开 TS 闭包 CFA 缩窄（同 lastResolved）。
  const obsState: { observabilityEnded: boolean } = { observabilityEnded: false };
  try {
    const resp = await invokeCore(baseReqIn, ctx, (t) => { lastResolved.current = t; }, physicalGens, obsState);
    // 成功路径写日志（safeWriteLlm：提取+write 整体 try/catch fail-silent，不影响主流程）
    safeWriteLlm(ctx.logWriter, lastResolved.current, baseReqIn, { response: resp });
    return resp;
  } catch (e) {
    // 非 ClassifiedLlmError 异常 + invokeCore 内部未 end → 补 endGenerationError。
    // invokeCore 内部各 throw 点已 end（obsState.observabilityEnded=true）—— 不重复 end；
    // 仅 invokeCore 漏出的 programming error / invariant 违反（非 ClassifiedLlmError）才补 end。
    // spec llm_caller.md §2.1 不变量：所有 throw 前调 endGenerationError。
    if (!obsState.observabilityEnded && !(e as ClassifiedLlmError)?.category) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.observability?.endGenerationError?.(
        LlmErrorCategory.INTERNAL,
        msg,
        { retryChain: [] },
      );
    }
    // 失败路径写日志后 re-throw（保留原错误语义；safeWriteLlm fail-silent 不掩盖原错误）
    const err = e as ClassifiedLlmError;
    safeWriteLlm(ctx.logWriter, lastResolved.current, baseReqIn, {
      error: { category: err?.category, message: err?.message ?? String(e) },
    });
    throw e;
  } finally {
    // physical generation 收尾：无论成功/失败/抛错都 end 所有 pending physical gen。
    // 无 usage/output（物理层不承载 LLM 产出）；endPhysicalGeneration 内部 safe 包裹，单条失败不阻塞其余。
    const endFn = ctx.observability?.endPhysicalGeneration;
    if (typeof endFn === 'function') {
      for (const h of physicalGens) {
        try {
          endFn(h, new Date());
        } catch {
          // safe：observability 失败绝不影响主流程（核心红线）
        }
      }
    }
  }
}

/**
 * invoke 核心逻辑（外层 invoke 负责包 dev log try/catch）。
 * @param onResolvedTarget 每次 resolveTarget 成功后回调（外层捕获最近 target 用于日志）
 * @param physicalGens   physical generation handle 收集容器（onWire 时 push，invoke finally drain）
 * @param obsState       observabilityEnded 标志位容器：内部各 endGenerationError 调用后置 true，
 *                       外层 catch 据此防重复 end（spec llm_caller.md §2.1 不变量）
 */
async function invokeCore(
  baseReqIn: InvokeBaseReq,
  ctx: InvokeContext,
  onResolvedTarget: (t: { kind: 'target'; target: ResolvedTarget } | { kind: 'all_dead'; reason: string }) => void,
  physicalGens: GenHandle[],
  obsState: { observabilityEnded: boolean },
): Promise<InvokeResponse> {
  // [v0.0.347] 路由分支：有 routingPlan（分支 2 挂载方案）→ 走 routingAttemptLoop（候选决策循环）。
  // 候选决策（时间过滤→enabled→熔断→banned→调用→差异化重试→降级）全在 routing_loop 上层，
  // 复用 attemptLoop 单次调用（watchdog/classify/buildRequest overlay 全保留）；无 routingPlan →
  // 现有循环（分支 1 零改动）。
  if (ctx.routingPlan) {
    return routingAttemptLoop(baseReqIn, ctx.routingPlan, ctx, physicalGens, obsState);
  }
  // baseReq 可被 MAX_TOKENS_EXCEEDED one-shot ceiling bump 覆盖 params.maxTokens
  // （bumped 值不进 errorState overlay，直接改本次 attempt 的基线，spec §2.2）。
  let baseReq = baseReqIn;
  const config = ctx.config ?? DEFAULT_LLM_REQUEST_CONFIG;
  const health = ctx.health ?? getProviderHealthRegistry();
  // health registry 按 (sessionId, provider, key, model) 四元组存储,
  // session-scoped 隔离(spec §1/§6.5)。sessionId 未注入时用 ''(单 session 兜底)。
  const sessionId = ctx.sessionId ?? '';
  const retryChain: RetryChainEntry[] = [];

  let lastError: ClassifiedLlmError | null = null;
  // provider 级 fallback 计数（同一 provider 失败次数；用于 RETRY_BACKOFF 触发 fallback）
  let providerAttempt = 0;

  // 外层循环：每次 resolveTarget 选 target；FALLBACK 后回此处重选。
  // 内层循环：attempt 1..max_attempts。
  for (let fallbackCount = 0; fallbackCount < Math.max(1, config.fallbackChain.length || 1); fallbackCount++) {
    const now = Date.now();
    const resolved = resolveTarget({
      config, providers: ctx.providers, health, sessionId, clientFactory: ctx.clientFactory,
      onWire: (req, body, url) => {
        ctx.observability?.recordWireBody?.(providerAttempt + 1, body, url);
        // physical generation 埋点：protocol.encode 后、HTTP 前（onWire 即此时刻）。
        // 每次 encode（含重试）重新埋点 → physical gen 数 = 真实 wire 尝试数；handle 入 physicalGens，
        // 由 invoke 的 try/finally 兜底 end（无 usage/output）。
        const startFn = ctx.observability?.startPhysicalGeneration;
        if (typeof startFn === 'function' && ctx.observability?.hasPhysicalChild?.()) {
          try {
            const h = startFn(body, new Date());
            if (h) physicalGens.push(h);
          } catch {
            // safe：observability 失败绝不影响主流程（核心红线）
          }
        }
      },
      now, fallback: ctx.fallback,
    });
    if (resolved.kind === 'all_dead') {
      lastError = allDeadToClassifiedError(resolved.reason);
      break; // 整链全 dead，退出 throw
    }
    const target = resolved.target;
    onResolvedTarget(resolved); // 通知外层捕获最近 target（日志用）
    // [v0.0.353 T2] 调用谁记录谁：target 确定后立即上报真实 provider/model（physical gen 用）
    // 分支1 target 来自 resolveTarget（含 fallback 兜底）；providerName = provider.name（接入方标识）。
    ctx.observability?.recordAttemptTarget?.({
      providerId: target.providerId,
      providerName: target.provider.name,
      modelId: target.model.modelId,
    });
    providerAttempt = 0;

    // [v0.0.353 T4 根治版] branch-1 非路由路径同样现场注入当前 target modelId，
    // 保证 fallback/resolve 链切换后 wire body 与真实 target 一致。
    baseReq = { ...baseReq, modelId: target.model.modelId };

    // 内层 attempt 循环
    for (let attempt = 1; attempt <= config.retry.max_attempts; attempt++) {
      const chainEntry: RetryChainEntry = { attempt, providerId: target.providerId, keyRef: target.keyRef };
      retryChain.push(chainEntry);

      // buildRequest（应用 overlay）
      const built = buildRequest({ baseReq, errorState: ctx.errorState, model: target.model, config, compressor: ctx.compressor });
      // 若应用了 prefill overlay，本次 attempt 后清 errorState.prefillPartial
      const appliedPrefill = built.appliedPrefill;

      const result = await attemptLoop({
        client: target.client,
        req: built.req,
        providerName: target.provider.name,
        userController: ctx.controller,
        timeoutConfig: config.timeout,
        onEvent: ctx.onEvent,
        hasMultipleKeys: hasMultipleKeysOf(target.provider),
        attempt,
      });

      if (result.kind === 'ok') {
        // 成功：recordSuccess + 清瞬时态 + endGeneration ok
        health.recordSuccess(sessionId, target.providerId, target.keyRef, target.model.modelId);
        Object.assign(ctx.errorState, clearTransientOnErrorState(ctx.errorState));
        if (appliedPrefill) delete ctx.errorState.prefillPartial;
        ctx.observability?.endGenerationOk?.(result.message, result.usage);
        // [v0.0.359 T1] 记录「调用成功那一下」的真实 target（与 observability 平行的正路线，
        // fire-and-forget 同步 Map.set 无异常面；ctx.sessionId 不存在时跳过）
        if (ctx.sessionId) {
          recordSuccessTarget(ctx.sessionId, {
            providerId: target.providerId,
            providerName: target.provider.name,
            modelId: target.model.modelId,
          });
        }
        return { message: result.message, usage: result.usage, stopReason: result.stopReason };
      }

      if (result.kind === 'user_abort') {
        // 用户 abort：保留 partial 到 errorState.partialResult，throw ABORTED_BY_USER
        if (result.partial) {
          ctx.errorState.partialResult = { message: result.partial, usage: result.partial.usage };
        }
        ctx.observability?.endGenerationError?.(LlmErrorCategory.ABORTED_BY_USER, 'aborted by user', { retryChain });
        obsState.observabilityEnded = true;
        throw makeClassifiedAbortError();
      }

      // MAX_TOKENS finish → applyMaxTokensOverlay 决策（one-shot ceiling bump / throw）
      // 流正常结束但 stop_reason=max_tokens（provider 等价终态），非 STREAM_INCOMPLETE（已 attemptLoop 排除）。
      // prefill 未启用：applyMaxTokensOverlay 不返 prefill 分支，只返 bump（one-shot ceiling）或 throw。
      //       bumped maxTokens 不进 errorState（spec §2.2：EXCEEDED 不 append recentErrors / 不复合 / 不 ×0.7），
      //       直接覆盖本次 attempt 的 baseReq.params.maxTokens 后下轮 attempt 使用。
      if (result.kind === 'max_tokens_finish') {
        const overlayRes = applyMaxTokensOverlay(
          ctx.errorState,
          result.partial,
          target.model,
          built.req.params.maxTokens ?? 0,
          config,
        );
        if (overlayRes.kind === 'throw') {
          // 已到硬上限（model.capabilities.maxOutputTokens），上抛 MAX_TOKENS_EXCEEDED（不无限重试）
          const err = new Error('max_tokens at hard cap') as ClassifiedLlmError;
          err.category = LlmErrorCategory.MAX_TOKENS_EXCEEDED;
          err.hints = {
            retryable: false, shouldRotateKey: false, shouldFallbackProvider: false,
            shouldCompressContext: false, shouldBumpMaxTokens: false,
          };
          ctx.errorState.lastError = { category: err.category, reason: err.message, at: Date.now() };
          ctx.observability?.endGenerationError?.(err.category, err.message, { retryChain });
          obsState.observabilityEnded = true;
          throw err;
        }
        // bumped 值写入 baseReq.params.maxTokens（不进 errorState overlay）
        baseReq = { ...baseReq, params: { ...baseReq.params, maxTokens: overlayRes.maxTokens } };
        continue; // 下轮 attempt：用 bumped maxTokens 重跑（从头生成，prefill 未启用）
      }

      // result.kind === 'error'：decide action
      const err = result.err;
      chainEntry.category = err.category;
      lastError = err;
      providerAttempt++;

      // 写 errorState.lastError（瞬时，debug/langfuse）
      ctx.errorState.lastError = { category: err.category, reason: err.message, at: Date.now() };

      // append recentError（连续错误历史真相源，spec §2.2）。
      // 每次 attempt error 都 append（带 category + modelEntry 快照 + at）；
      // 上限 = max_attempts−1，appendRecentError 内部裁剪。成功（ok 分支）才清空。
      // 跨 iteration 保留（不在此清，由 recordSuccess 的 clearTransientOnErrorState 清）。
      Object.assign(
        ctx.errorState,
        appendRecentError(
          ctx.errorState,
          {
            category: err.category,
            modelEntry: {
              providerId: target.providerId,
              keyRef: target.keyRef,
              modelId: target.model.modelId,
            },
            at: Date.now(),
          },
          config.retry.max_attempts,
        ),
      );

      // [dev-logs v0.0.144] 分层失败日志：每次 attempt 失败经 error.log 写一条 layer:'llm' 精简事件
      // （含重试中每次、含 TIMEOUT）。此点在所有 decide 分支（RETRY/ROTATE_KEY/FALLBACK/NO_RETRY/
      // backgroundPath-fail）上游 → 一条覆盖每次 attempt 失败。受 enableErrorLog 门禁（LogWriter.write
      // 内部开关 false 早 return 零开销）。与 llm.log（invoke 级快照）职责不重叠，都保留。
      // invoke 级 all_dead / max_tokens 硬顶的终态由 run 层 catch(layer=run) 兜底，不在此重复记。
      ctx.logWriter?.write('error', {
        layer: 'llm',
        sessionId,
        category: err.category,
        message: err.message,
        attempt,
        providerId: target.providerId,
        modelId: target.model.modelId,
        keyRef: target.keyRef,
        // provider 原始错误（status/body/message），prod 排障看 provider 响应原文（如 Kimi 4xx body）
        rawError: err.rawError,
        stack: err.stack,
      });

      // backgroundPath=true 时 overload/rate_limit 不重试（防雪崩，spec §6.5）
      const isCapacity = err.category === LlmErrorCategory.PROVIDER_OVERLOADED || err.category === LlmErrorCategory.RATE_LIMITED;
      if (ctx.backgroundPath && isCapacity) {
        // 后台路径 capacity 错误直 fail：emit llm_attempt{FAIL} 后 throw（spec §3.1）
        emitLlmAttempt(ctx, err.category, target, attempt, 'FAIL', config.retry.max_attempts);
        ctx.observability?.endGenerationError?.(err.category, err.message, { retryChain });
        obsState.observabilityEnded = true;
        throw err;
      }

      const action = decideAction(err, target, attempt, config.retry.max_attempts);
      if (action === 'NO_RETRY') {
        // 不可恢复错误：emit llm_attempt{FAIL} 后 throw（spec §3.1）
        emitLlmAttempt(ctx, err.category, target, attempt, 'FAIL', config.retry.max_attempts);
        ctx.observability?.endGenerationError?.(err.category, err.message, { retryChain });
        obsState.observabilityEnded = true;
        throw err;
      }
      if (action === 'RETRY_BACKOFF') {
        // 退避重试：emit llm_attempt{RETRY}（spec §3.1）
        emitLlmAttempt(ctx, err.category, target, attempt, 'RETRY', config.retry.max_attempts);
        const delay = getRetryDelay(attempt, err.retryAfter, config.retry);
        chainEntry.delayMs = delay;
        await sleep(delay);
        continue;
      }
      if (action === 'FIX_AND_RETRY_MAX_TOKENS') {
        // FIX_AND_RETRY 等价 RETRY 语义（同 provider 同 key 改参重试）→ emit RETRY
        // one-shot ceiling bump（spec §2.2）：bumped maxTokens 不进 errorState，
        //       直接覆盖 baseReq.params.maxTokens 后下轮 attempt 使用。
        emitLlmAttempt(ctx, err.category, target, attempt, 'RETRY', config.retry.max_attempts);
        if (result.partial) {
          const overlayRes = applyMaxTokensOverlay(ctx.errorState, result.partial, target.model, built.req.params.maxTokens ?? 0, config);
          if (overlayRes.kind === 'throw') {
            ctx.observability?.endGenerationError?.(err.category, 'max_tokens at hard cap', { retryChain });
            obsState.observabilityEnded = true;
            throw err;
          }
          // bumped 值写入 baseReq.params.maxTokens（不进 errorState overlay）
          baseReq = { ...baseReq, params: { ...baseReq.params, maxTokens: overlayRes.maxTokens } };
        }
        continue;
      }
      if (action === 'FIX_AND_RETRY_CONTEXT_LENGTH') {
        // 同 FIX_AND_RETRY，归 RETRY 语义（不改 provider/key）
        emitLlmAttempt(ctx, err.category, target, attempt, 'RETRY', config.retry.max_attempts);
        Object.assign(ctx.errorState, applyContextLengthOverlay(ctx.errorState));
        continue;
      }
      if (action === 'ROTATE_KEY') {
        // 同 provider 内换 key：emit llm_attempt{ROTATE_KEY}（spec §3.1）
        emitLlmAttempt(ctx, err.category, target, attempt, 'ROTATE_KEY', config.retry.max_attempts);
        health.markDead(sessionId, target.providerId, target.keyRef, target.model.modelId, `auth failed: ${err.category}`, Date.now());
        // ROTATE_KEY 退出内层 attempt 循环 → 外层 resolveTarget 重选（同 provider 内换 key）
        break;
      }
      if (action === 'FALLBACK') {
        // 换 provider：emit llm_attempt{FALLBACK}（spec §3.1）
        emitLlmAttempt(ctx, err.category, target, attempt, 'FALLBACK', config.retry.max_attempts);
        if (isCapacity) health.escalate(sessionId, target.providerId, target.keyRef, target.model.modelId, err.category as 'PROVIDER_OVERLOADED' | 'RATE_LIMITED', Date.now());
        break; // 退出内层 → 外层 resolveTarget 换 provider
      }
    }
  }

  // 整链全 dead 或所有 attempt 都失败
  const err = lastError ?? allDeadToClassifiedError('unknown');
  // 整链终结：emit llm_attempt{FAIL}（spec §3.1 整链 all_dead 发 FAIL）
  // lastError 带 category 时用它（真实失败原因）；all_dead 兜底 category 用 err.category
  emitLlmAttempt(ctx, err.category, null, 0, 'FAIL', config.retry.max_attempts);
  ctx.observability?.endGenerationError?.(err.category, err.message, { retryChain });
  obsState.observabilityEnded = true;
  throw err;
}

/** decide 决策的 action 类型（re-export 自 decide_action，便于调用方引用）。 */
export type { DecideAction } from './decide_action';

/** 判定 provider 是否配了多 key（用于 classify hints 的 hasMultipleKeys 上下文）。 */
function hasMultipleKeysOf(provider: LlmProviderConfig): boolean {
  const creds = provider.credentials;
  if ('keys' in creds && Array.isArray(creds.keys)) return creds.keys.length > 1;
  return false;
}

/** 构造 ABORTED_BY_USER ClassifiedLlmError（不重走 classify）。 */
function makeClassifiedAbortError(): ClassifiedLlmError {
  const err = new Error('aborted by user') as ClassifiedLlmError;
  err.category = LlmErrorCategory.ABORTED_BY_USER;
  err.hints = {
    retryable: false, shouldRotateKey: false, shouldFallbackProvider: false,
    shouldCompressContext: false, shouldBumpMaxTokens: false,
  };
  return err;
}

/**
 * Promise sleep（退避用）。
 * 测试环境压缩退避（NODE_ENV=test 时跳过实际 sleep），
 * 避免 client.stream 测试因默认 retry 退避超时。
 * 生产路径（NODE_ENV!='test'）保留真实退避，retry 行为不受影响。
 */
function sleep(ms: number): Promise<void> {
  if (process.env.NODE_ENV === 'test' && ms > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
