/**
 * routing_loop —— 模型路由候选决策主循环（attempt 内路由）
 * 参考: specs/tech/agent/providers_and_models/[P0]model_routing.md §5（D12 核心 attempt 内路由循环）
 *       specs/prd/model-routing-PRD-2026-08-14.md §2.5（①-⑥ 步骤）
 *
 * 候选决策（tech §5 伪代码）：
 *   ① 时间过滤（本地小时 ∉ hours → skipped；不消耗尝试、不计熔断失败）
 *   ② enabled 检查（item.enabled == false → skipped，同 ① 语义）
 *   ③ 熔断检查（CircuitBreakerRegistry(planId,pid,mid).state == Open → skipped + bannedModels.add）
 *   ④ bannedModels 检查（providerId+modelId ∈ bannedModels → skipped）
 *   ⑤ 发起调用（复用 attemptLoop 单次调用：watchdog/classify/buildRequest overlay 全保留）
 *      + routingRetryPolicy 模型内差异化重试（429/529=0、瞬态=1、AUTH=0+directOpen）
 *   ⑥ 成功 → 熔断 recordSuccess + health recordSuccess → 返回；失败 → 熔断 recordFailure +
 *      按策略降级（bannedModels.add）→ 下一个候选（换模型 0 sleep）
 *   ⑦ 循环耗尽 → 候选空「当前无可用模型」/ 全失败「所有候选模型不可用」（聚合错误）；
 *      全部候选 AUTH 失败 → 上抛首个 AUTH 错误引导修凭证（PRD §2.6）
 *
 * 关键语义：
 *   - 去重键 = providerId+modelId（bannedModels，D14）：同模型多 item 只尝试一次
 *   - ABORTED_BY_USER 直接返回不算失败（不 recordFailure）
 *   - 换模型降级 0 sleep（可复现，无随机）
 *   - 不在 attemptLoop 内塞路由逻辑（路由决策全在本层，现有单模型路径零改动）
 */
import type { CanonicalRequest, StreamEvent } from '../protocol';
import type { GenHandle } from '../../observability/types';
import type { InvokeContext, InvokeResponse } from './llm_caller';
import { LlmErrorCategory, type ClassifiedLlmError } from './error_types';
import type { LlmErrorState } from './llm_error_state';
import { appendRecentError, clearTransientOnErrorState } from './llm_error_state';
import { attemptLoop } from './attempt_loop';
import { buildRequest, applyMaxTokensOverlay, applyContextLengthOverlay } from './build_request';
import { getRetryDelay } from './retry_backoff';
import { routingRetryPolicy } from './routing_retry_policy';
import type { CircuitBreakerRegistry } from './circuit_breaker_registry';
import { getCircuitBreakerRegistry } from './circuit_breaker_registry';
// [v0.0.359 T1] 成功 target registry（squad 用量统计归属：记调用成功那一下的 physical model）
import { recordSuccessTarget } from './success-target-registry';
import { emitLlmAttempt } from './llm_attempt_emit';
import { resolveKey } from '../credentials';
import {
  isItemEnabled,
  DEFAULT_ROUTING_TIMEZONE,
  type RoutingItem,
  type CircuitConfig,
} from '../../services/model-routing-validation';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../config/llm_request_config';
import type { LlmProviderConfig } from '../provider-types';
import type { ResolvedTarget } from './resolve_target';

/** 路由循环输入（SessionConfig.modelRoutingPlan 形状；planId + 合成后候选链 + 生效熔断参数） */
export interface RoutingPlanInput {
  planId: string;
  items: RoutingItem[];
  circuit: CircuitConfig;
}

/** 时钟/睡眠注入（UT 控制；生产缺省真实时钟） */
export interface RoutingLoopOverrides {
  now?: () => number;
  /**
   * [v0.0.353 T1] 按时区取当前小时（0-23）。优先注入口径：时间过滤按 item.timezone 解析。
   * localHour 为兼容保留（deprecated）：注入时所有时区同值（仅覆盖默认时区条目语义）。
   */
  timezoneNow?: (timezone: string) => number;
  /** @deprecated [v0.0.353 T1] 兼容保留：无 timezoneNow 时兜底（等价于默认时区 Asia/Shanghai 的小时） */
  localHour?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * [v0.0.353 T1 D2] 原生 Intl 取指定时区当前小时（0-23，无新依赖）。
 * [review fix] hourCycle:'h23' 替代 hour12:false：hour12:false 在部分旧 V8/ICU（ECMA-402 h24 解析映射）
 * 午夜输出 "24"→parseInt=24 永不命中 0-23 白名单；h23 双运行时（node/bun）实测午夜恒 "00"。
 */
export function getHourInTimezone(timezone: string, now: number = Date.now()): number {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' });
  return parseInt(fmt.format(new Date(now)), 10);
}

/** 模型内重试链条目（langfuse retry_chain metadata，与 invokeCore 同形状） */
interface RoutingChainEntry {
  attempt: number;
  providerId: string;
  keyRef: string;
  category?: LlmErrorCategory;
  delayMs?: number;
}

/** 候选失败摘要（聚合错误信息） */
interface CandidateFailure {
  providerId: string;
  modelId: string;
  category: LlmErrorCategory;
  message: string;
}

/**
 * 路由主循环（tech §5）。invokeCore 检测到 ctx.routingPlan 时调用。
 *
 * @param baseReqIn canonical 请求基线
 * @param plan      方案（planId + 合成候选链 + 生效熔断参数）
 * @param ctx       InvokeContext（providers/clientFactory/health/controller/observability/onEvent/config）
 * @param physicalGens physical generation handle 收集容器（onWire 时 push，invoke finally drain）
 * @param obsState  observabilityEnded 标志位容器（内部 endGenerationError 后置 true，防外层重复 end）
 * @param overrides 时钟/睡眠注入（UT；生产缺省）
 * @returns 成功 → InvokeResponse；失败 → throw ClassifiedLlmError（聚合错误或 AUTH 首错）
 */
export async function routingAttemptLoop(
  baseReqIn: CanonicalRequest,
  plan: RoutingPlanInput,
  ctx: InvokeContext,
  physicalGens: GenHandle[],
  obsState: { observabilityEnded: boolean },
  overrides: RoutingLoopOverrides = {},
): Promise<InvokeResponse> {
  const config = ctx.config ?? DEFAULT_LLM_REQUEST_CONFIG;
  const registry: CircuitBreakerRegistry = ctx.circuitRegistry ?? getCircuitBreakerRegistry();
  const now = overrides.now ?? Date.now;
  // [v0.0.353 T1 D2] 小时解析：优先 timezoneNow（按条目 timezone）；localHour 兼容兜底；
  // 生产缺省 = getHourInTimezone(tz, now())。缓存避免每候选重复 format。
  const hourCache = new Map<string, number>();
  const hourIn = (tz: string): number => {
    const cached = hourCache.get(tz);
    if (cached !== undefined) return cached;
    const h = overrides.timezoneNow
      ? overrides.timezoneNow(tz)
      : overrides.localHour
        ? overrides.localHour()
        : getHourInTimezone(tz, now());
    hourCache.set(tz, h);
    return h;
  };
  const sleep = overrides.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retryChain: RoutingChainEntry[] = [];

  let baseReq = baseReqIn;
  let lastError: ClassifiedLlmError | null = null;
  let firstAuthError: ClassifiedLlmError | null = null;
  const bannedModels = new Set<string>();
  const failures: CandidateFailure[] = [];
  let attemptedAny = false;
  let wireAttempt = 0;

  // onWire 闭包：observability recordWireBody + physical gen 埋点（与 invokeCore 同路径）
  const onWire = (req: unknown, body: unknown, url: string): void => {
    ctx.observability?.recordWireBody?.(wireAttempt + 1, body, url);
    const startFn = ctx.observability?.startPhysicalGeneration;
    if (typeof startFn === 'function' && ctx.observability?.hasPhysicalChild?.()) {
      try {
        const h = startFn(body, new Date());
        if (h) physicalGens.push(h);
      } catch {
        // safe：observability 失败绝不影响主流程
      }
    }
  };

  // 候选链按 priority 升序（合成时已含 session 显式模型 priority 0；此处防御性再排序）
  const sorted = [...plan.items].sort((a, b) => a.priority - b.priority);

  // [v0.0.353 T5 D9] 被跳过候选逐条记录（port 可选 + safe：observability 失败绝不影响路由主流程）。
  // provider 存在时带 providerName（resolve_failed 分支 provider 可能缺失 → 省略）。
  const recordSkipped = (
    item: RoutingItem,
    reason: 'time_window' | 'disabled' | 'circuit_open' | 'banned' | 'resolve_failed' | 'probe_inflight',
  ): void => {
    try {
      const provider = ctx.providers.get(item.providerId);
      ctx.observability?.recordSkippedCandidate?.({
        providerId: item.providerId,
        ...(provider ? { providerName: provider.name } : {}),
        modelId: item.modelId,
        reason,
      });
    } catch {
      // safe：observability 失败绝不影响路由主流程（skip 语义不变）
    }
  };

  for (const item of sorted) {
    const modelKey = `${item.providerId}|${item.modelId}`;

    // ① 时间过滤：条件时区小时 ∉ hours → skipped（不消耗尝试、不计熔断）。
    //    [v0.0.353 T1] 按条目 timezone（缺省 DEFAULT_ROUTING_TIMEZONE）取小时。
    if (
      item.timeCondition &&
      Array.isArray(item.timeCondition.hours) &&
      item.timeCondition.hours.length > 0 &&
      !item.timeCondition.hours.includes(
        hourIn(item.timeCondition.timezone ?? DEFAULT_ROUTING_TIMEZONE),
      )
    ) {
      recordSkipped(item, 'time_window');
      continue;
    }
    // ② enabled == false → skipped（同 ① 语义）
    if (!isItemEnabled(item)) {
      recordSkipped(item, 'disabled');
      continue;
    }
    // ③ 熔断 Open → skipped + bannedModels.add（该模型配置本次 call 内不再出现）
    if (registry.getState(plan.planId, item.providerId, item.modelId, plan.circuit) === 'open') {
      bannedModels.add(modelKey);
      recordSkipped(item, 'circuit_open');
      continue;
    }
    // ④ bannedModels 命中（同模型已放弃/熔断）→ skipped
    if (bannedModels.has(modelKey)) {
      recordSkipped(item, 'banned');
      continue;
    }

    // ⑤ 构建 target：provider/model 运行时校验（方案校验保证存在，防御 provider 被删）
    const provider = ctx.providers.get(item.providerId);
    if (!provider) {
      recordSkipped(item, 'resolve_failed');
      continue;
    }
    const model = provider.models.find((m) => m.modelId === item.modelId);
    if (!model) {
      recordSkipped(item, 'resolve_failed');
      continue;
    }
    const selected = resolveKey(provider.credentials, 'default');
    if (!selected) {
      recordSkipped(item, 'resolve_failed');
      continue;
    }

    // HalfOpen 限流 1 并发探测（permit 必须归还，防卡死——change_plan 风险 5）
    if (!registry.tryAcquirePermit(plan.planId, item.providerId, item.modelId, plan.circuit)) {
      recordSkipped(item, 'probe_inflight');
      continue; // 已有探测在途 → 本次 call 跳过（不算尝试）
    }
    const client = ctx.clientFactory.getClient(provider, selected.keyRef, selected.keyValue, model, onWire);
    const target: ResolvedTarget = {
      providerId: provider.id,
      provider,
      keyRef: selected.keyRef,
      keyValue: selected.keyValue,
      model,
      client,
    };
    attemptedAny = true;

    // [v0.0.353 T4 根治版] wire body modelId 由调用现场当前 candidate 注入，
    // 禁止启动前预选污染。后续 MAX_TOKENS bump 仍通过 spread 保留此字段。
    baseReq = { ...baseReq, modelId: model.modelId };

    // [v0.0.353 T2] 调用谁记录谁：每次候选 target 确定后立即上报真实 provider/model
    // （在 attemptLoop 之前；physical generation 用真实 target 而非 config.modelId）
    ctx.observability?.recordAttemptTarget?.({
      providerId: provider.id,
      providerName: provider.name,
      modelId: model.modelId,
    });

    // 模型内尝试：差异化重试（routingRetryPolicy）+ 现有修复流程（bump/压缩）双轨
    let attempt = 1;
    let retriesUsed = 0;
    let err: ClassifiedLlmError | null = null;
    let policy = routingRetryPolicy(LlmErrorCategory.NETWORK); // 占位（首错后按真实 category 决策）

    for (;;) {
      wireAttempt++;
      const built = buildRequest({ baseReq, errorState: ctx.errorState, model, config, compressor: ctx.compressor });
      const appliedPrefill = built.appliedPrefill;

      const result = await attemptLoop({
        client,
        req: built.req,
        providerName: provider.name,
        userController: ctx.controller,
        timeoutConfig: config.timeout,
        onEvent: ctx.onEvent,
        hasMultipleKeys: hasMultipleKeysOf(provider),
        attempt,
      });

      // 成功：熔断 recordSuccess + health recordSuccess + 清瞬时态 → 返回
      if (result.kind === 'ok') {
        registry.recordSuccess(plan.planId, provider.id, model.modelId, plan.circuit);
        registry.releasePermit(plan.planId, provider.id, model.modelId);
        ctx.health?.recordSuccess(ctx.sessionId ?? '', provider.id, target.keyRef, model.modelId);
        Object.assign(ctx.errorState, clearTransientOnErrorState(ctx.errorState));
        if (appliedPrefill) delete ctx.errorState.prefillPartial;
        ctx.observability?.endGenerationOk?.(result.message, result.usage);
        obsState.observabilityEnded = true;
        // [v0.0.359 T1] 记录「调用成功那一下」的真实候选 target（与分支 1 同款写入；
        // ctx.sessionId 不存在时跳过，fire-and-forget 同步 Map.set 无异常面）
        if (ctx.sessionId) {
          recordSuccessTarget(ctx.sessionId, {
            providerId: provider.id,
            providerName: provider.name,
            modelId: model.modelId,
          });
        }
        return { message: result.message, usage: result.usage, stopReason: result.stopReason };
      }

      // 用户 abort：不算失败，直接返回（保留 partial）
      if (result.kind === 'user_abort') {
        registry.releasePermit(plan.planId, provider.id, model.modelId);
        if (result.partial) {
          ctx.errorState.partialResult = { message: result.partial, usage: result.partial.usage };
        }
        ctx.observability?.endGenerationError?.(LlmErrorCategory.ABORTED_BY_USER, 'aborted by user', { retryChain });
        obsState.observabilityEnded = true;
        throw makeAbortError();
      }

      // MAX_TOKENS finish：applyMaxTokensOverlay 决策（one-shot ceiling bump / throw）
      if (result.kind === 'max_tokens_finish') {
        const overlayRes = applyMaxTokensOverlay(
          ctx.errorState,
          result.partial,
          model,
          built.req.params.maxTokens ?? 0,
          config,
        );
        if (overlayRes.kind === 'throw') {
          err = makeMaxTokensHardCapError();
          lastError = err;
          failures.push({ providerId: provider.id, modelId: model.modelId, category: err.category, message: err.message });
          break;
        }
        baseReq = { ...baseReq, params: { ...baseReq.params, maxTokens: overlayRes.maxTokens } };
        attempt++;
        continue; // bump 后重试（修复流程，不耗差异化重试配额）
      }

      // result.kind === 'error'
      err = result.err;
      lastError = err;
      retryChain.push({ attempt, providerId: provider.id, keyRef: target.keyRef, category: err.category });
      ctx.errorState.lastError = { category: err.category, reason: err.message, at: now() };
      Object.assign(
        ctx.errorState,
        appendRecentError(ctx.errorState, {
          category: err.category,
          modelEntry: { providerId: provider.id, keyRef: target.keyRef, modelId: model.modelId },
          at: now(),
        }, config.retry.max_attempts),
      );
      policy = routingRetryPolicy(err.category);

      // CONTEXT_LENGTH_EXCEEDED：走现有压缩修复流程（FIX_AND_RETRY，不耗重试配额）
      if (err.category === LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED) {
        Object.assign(ctx.errorState, applyContextLengthOverlay(ctx.errorState));
        attempt++;
        continue;
      }
      // MAX_TOKENS_EXCEEDED：bump 修复（FIX_AND_RETRY，不耗重试配额）
      // attemptLoop error 分支带 PartialMessage（result.partial），喂 applyMaxTokensOverlay 做 bump 决策
      if (err.category === LlmErrorCategory.MAX_TOKENS_EXCEEDED && result.partial) {
        const overlayRes = applyMaxTokensOverlay(
          ctx.errorState,
          result.partial,
          model,
          built.req.params.maxTokens ?? 0,
          config,
        );
        if (overlayRes.kind === 'throw') {
          failures.push({ providerId: provider.id, modelId: model.modelId, category: err.category, message: err.message });
          break;
        }
        baseReq = { ...baseReq, params: { ...baseReq.params, maxTokens: overlayRes.maxTokens } };
        attempt++;
        continue;
      }

      // 差异化重试：模型内重试（退避沿用 getRetryDelay）；重试耗尽 → 降级
      if (retriesUsed < policy.inModelRetries) {
        retriesUsed++;
        const delay = getRetryDelay(attempt, err.retryAfter, config.retry);
        retryChain[retryChain.length - 1]!.delayMs = delay;
        emitLlmAttempt(ctx, err.category, target, attempt, 'RETRY', config.retry.max_attempts);
        await sleep(delay);
        attempt++;
        continue;
      }
      break; // 重试耗尽 / 0 次重试 → 模型内循环结束
    }

    // 模型内循环结束（失败）：熔断 recordFailure（AUTH directOpen 直达 Open）+ banned + 降级
    registry.recordFailure(plan.planId, provider.id, model.modelId, plan.circuit, policy.directOpen);
    registry.releasePermit(plan.planId, provider.id, model.modelId);
    bannedModels.add(modelKey); // D14：放弃/熔断 → 本次 call 内同模型不再出现
    if (err) {
      failures.push({ providerId: provider.id, modelId: model.modelId, category: err.category, message: err.message });
      if (err.category === LlmErrorCategory.AUTH_INVALID || err.category === LlmErrorCategory.AUTH_FORBIDDEN) {
        firstAuthError ??= err;
      }
      emitLlmAttempt(ctx, err.category, target, attempt, 'FALLBACK', config.retry.max_attempts);
    }
    // 换模型降级 0 sleep（可复现，无随机）→ 下一个候选
  }

  // ⑦ 循环耗尽
  // 候选为空（时间过滤/enabled/Open/banned/限流/provider 缺失全跳过，未发起任何调用）
  if (!attemptedAny) {
    const exhausted = makeRoutingExhaustedError('当前无可用模型', null, []);
    emitLlmAttempt(ctx, exhausted.category, null, 0, 'FAIL', config.retry.max_attempts);
    ctx.observability?.endGenerationError?.(exhausted.category, exhausted.message, { retryChain });
    obsState.observabilityEnded = true;
    throw exhausted;
  }
  // 全部候选 AUTH 失败 → 上抛首个 AUTH 错误引导修凭证（PRD §2.6）
  if (firstAuthError && failures.every((f) => f.category === LlmErrorCategory.AUTH_INVALID || f.category === LlmErrorCategory.AUTH_FORBIDDEN)) {
    emitLlmAttempt(ctx, firstAuthError.category, null, 0, 'FAIL', config.retry.max_attempts);
    ctx.observability?.endGenerationError?.(firstAuthError.category, firstAuthError.message, { retryChain });
    obsState.observabilityEnded = true;
    throw firstAuthError;
  }
  // 全失败聚合错误（含失败摘要）
  const exhausted = makeRoutingExhaustedError('所有候选模型不可用', lastError, failures);
  emitLlmAttempt(ctx, exhausted.category, null, 0, 'FAIL', config.retry.max_attempts);
  ctx.observability?.endGenerationError?.(exhausted.category, exhausted.message, { retryChain });
  obsState.observabilityEnded = true;
  throw exhausted;
}

/** 构造路由耗尽聚合错误（候选空/全失败统一出口）。 */
function makeRoutingExhaustedError(
  head: string,
  lastError: ClassifiedLlmError | null,
  failures: CandidateFailure[],
): ClassifiedLlmError {
  const detail = failures
    .map((f) => `${f.providerId}/${f.modelId}: ${f.category} ${f.message}`)
    .join('; ');
  const err = new Error(detail ? `${head}: ${detail}` : head) as ClassifiedLlmError;
  err.category = lastError?.category ?? LlmErrorCategory.NETWORK;
  err.hints = lastError?.hints ?? {
    retryable: false,
    shouldRotateKey: false,
    shouldFallbackProvider: false,
    shouldCompressContext: false,
    shouldBumpMaxTokens: false,
  };
  err.rawError = { message: head };
  return err;
}

/** 构造 ABORTED_BY_USER ClassifiedLlmError（不重走 classify）。 */
function makeAbortError(): ClassifiedLlmError {
  const err = new Error('aborted by user') as ClassifiedLlmError;
  err.category = LlmErrorCategory.ABORTED_BY_USER;
  err.hints = {
    retryable: false, shouldRotateKey: false, shouldFallbackProvider: false,
    shouldCompressContext: false, shouldBumpMaxTokens: false,
  };
  return err;
}

/** 构造 MAX_TOKENS_EXCEEDED 硬顶错误（applyMaxTokensOverlay throw 分支）。 */
function makeMaxTokensHardCapError(): ClassifiedLlmError {
  const err = new Error('max_tokens at hard cap') as ClassifiedLlmError;
  err.category = LlmErrorCategory.MAX_TOKENS_EXCEEDED;
  err.hints = {
    retryable: false, shouldRotateKey: false, shouldFallbackProvider: false,
    shouldCompressContext: false, shouldBumpMaxTokens: false,
  };
  return err;
}

/** 判定 provider 是否配了多 key（与 llm_caller.hasMultipleKeysOf 同逻辑，本地复用避免跨文件私有依赖）。 */
function hasMultipleKeysOf(provider: LlmProviderConfig): boolean {
  const creds = provider.credentials;
  if ('keys' in creds && Array.isArray(creds.keys)) return creds.keys.length > 1;
  return false;
}
