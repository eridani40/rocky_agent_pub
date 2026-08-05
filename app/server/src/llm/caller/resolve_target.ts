/**
 * resolveTarget —— fallback chain + 健康表 两遍扫描选 target
 * 参考: specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3 step 2 + §2.2(两遍扫描)
 *       specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §2(完整伪代码)
 *       specs/tech/agent/llm_caller/[P0]provider_health_registry.md §2(isPreferred/isAvailable)
 *
 * **两遍扫描**(spec §2.2)选 target:
 *   第 1 遍:扫 chain(顺序:正式项 > backup 项),选首个 health.isPreferred(healthy) 项;
 *   第 2 遍(兜底):第 1 遍无果,扫 chain,选首个 health.isAvailable(healthy 或 degraded) 项;
 *   cooled_down(未到期)/dead:两遍都跳过;
 *   全 dead(无 healthy 无 degraded) → all_dead。
 *
 * chain 项 = (providerId, keyRef, modelId);health 查询按四元组(sessionId, provider, key, model)。
 * 同 session 内共享健康表(spec §1);session 隔离见 [P0]provider_health_registry §6.5。
 *
 * 空 chain 退化:用调用方传入的单一 (provider, key, model, client)(向后兼容,仍走 isAvailable 兜底)。
 */
import type { FallbackChainItem, LlmRequestConfig } from '../../config/llm_request_config';
import type { LlmProviderConfig, LlmModelConfig } from '../provider-types';
import type { LlmClient } from '../client';
import type { ProviderHealthRegistry, HealthProbe } from './provider_health_registry';
import { probeHealth, isAccountWideSkip, selectKey } from './fallback_key_selector';
import { resolveKey } from '../credentials';
import { LlmErrorCategory, type ClassifiedLlmError } from './error_types';

/**
 * LlmClient 工厂契约（spec §6.4）：按 (provider, keyRef, model) 组合取/建对应 LlmClient。
 * 实现方负责 4 件套组合缓存复用（LlmClient 不可变共享）。
 */
export interface LlmClientFactory {
  getClient(
    provider: LlmProviderConfig,
    keyRef: string,
    keyValue: string,
    model: LlmModelConfig,
    onWire?: (req: unknown, body: unknown, url: string) => void,
  ): LlmClient;
}

/**
 * 选中的 target（spec §2.2 resolveTarget 返回）。
 * 含 provider/keyRef/keyValue/model/client，供 attemptLoop 使用。
 */
export interface ResolvedTarget {
  providerId: string;
  provider: LlmProviderConfig;
  keyRef: string;
  keyValue: string;
  model: LlmModelConfig;
  client: LlmClient;
}

/** 两遍扫描命中的某 chain 项(供 buildTarget 复用)。 */
interface PickedItem {
  providerId: string;
  keyRef: string;
  modelId: string;
  keyValue: string;
}

/**
 * 按 fallback_chain + 健康表 + 两遍扫描选首个可用 target(spec §2.2)。
 *
 * @param config        LlmRequestConfig(取 fallbackChain)
 * @param providers     providerId → LlmProviderConfig 查找表
 * @param health        ProviderHealthRegistry(session-scoped)
 * @param sessionId     session 标识(health 查询按四元组,spec §2 v2.0)
 * @param clientFactory LlmClient 工厂
 * @param onWire        本次 invoke 的 onWire 钩子
 * @param now           当前 epoch ms
 * @param fallback      空 chain 时的单一 target 兜底
 *
 * @returns target 选中;all_dead 时返 { kind:'all_dead', reason } 由调用方 throw。
 */
export function resolveTarget(args: {
  config: LlmRequestConfig;
  providers: Map<string, LlmProviderConfig>;
  health: ProviderHealthRegistry;
  sessionId: string;
  clientFactory: LlmClientFactory;
  onWire?: (req: unknown, body: unknown, url: string) => void;
  now: number;
  fallback?: {
    provider: LlmProviderConfig;
    keyRef: string;
    model: LlmModelConfig;
    client: LlmClient;
  };
}):
  | { kind: 'target'; target: ResolvedTarget }
  | { kind: 'all_dead'; reason: string } {
  const { config, providers, health, sessionId, clientFactory, onWire, now, fallback } = args;

  // 空 chain 退化:用调用方传入的单一 target(向后兼容)。
  // 单 target 等价两遍扫描的终态:isAvailable 一次取 healthy 或 degraded 命中;
  // cooled_down/dead → all_dead。(无第二 target 可降级兜底,故单次 isAvailable 即等价。)
  if (config.fallbackChain.length === 0) {
    if (!fallback) {
      return { kind: 'all_dead', reason: 'empty fallback chain and no fallback target' };
    }
    const probe = health.isAvailable(
      sessionId, fallback.provider.id, fallback.keyRef, fallback.model.modelId, now,
    );
    if (!probe.ok) {
      return {
        kind: 'all_dead',
        reason: `single target ${fallback.provider.id}/${fallback.keyRef} unavailable: ${probe.reason}`,
      };
    }
    return {
      kind: 'target',
      target: buildTarget(fallback.provider, fallback.keyRef, fallback.model, clientFactory, onWire),
    };
  }

  // 两遍扫描(spec §2.2):第 1 遍 isPreferred(healthy);第 2 遍 isAvailable(healthy||degraded)。
  const picked = pickTwoPass(config.fallbackChain, providers, health, sessionId, now);
  if (picked.kind === 'all_dead') {
    return { kind: 'all_dead', reason: picked.reason };
  }

  const provider = providers.get(picked.providerId);
  if (!provider) {
    return { kind: 'all_dead', reason: `provider ${picked.providerId} not found` };
  }
  const model = provider.models.find((m) => m.modelId === picked.modelId);
  if (!model) {
    return {
      kind: 'all_dead',
      reason: `model ${picked.modelId} not found for ${picked.providerId}`,
    };
  }

  return {
    kind: 'target',
    target: buildTarget(provider, picked.keyRef, model, clientFactory, onWire),
  };
}

/**
 * 第 1 + 第 2 遍扫描(spec §2.2 + rev2_changes §2 伪代码)。
 *
 * 两遍各自独立 dedup(同 provider+model+baseUrl 三元组只试一次,避免切回死路——hermes 教训)。
 *
 * @returns 命中返 { kind:'picked', ... };全 dead 返 { kind:'all_dead', reason }
 */
function pickTwoPass(
  chain: ReadonlyArray<FallbackChainItem>,
  providers: Map<string, LlmProviderConfig>,
  health: ProviderHealthRegistry,
  sessionId: string,
  now: number,
): { kind: 'picked'; providerId: string; keyRef: string; modelId: string; keyValue: string }
  | { kind: 'all_dead'; reason: string } {
  // ── 第 1 遍: 优先选 healthy(isPreferred) ──
  const pass1 = scanPass(chain, providers, health, sessionId, now, /* allowDegraded */ false);
  if (pass1.kind === 'picked') return pass1;

  // ── 第 2 遍: 兜底选 healthy 或 degraded(isAvailable) ──
  const pass2 = scanPass(chain, providers, health, sessionId, now, /* allowDegraded */ true);
  if (pass2.kind === 'picked') return pass2;

  return { kind: 'all_dead', reason: 'all fallback chain items dead or cooled_down' };
}

/**
 * 单遍扫描辅助(供 pickTwoPass 第 1/2 遍复用)。
 *
 * - allowDegraded=false:第 1 遍,仅 healthy 命中(isPreferred 等价语义);
 * - allowDegraded=true :第 2 遍,healthy 或 degraded 命中(isAvailable 兜底语义)。
 *
 * dedup:同 (providerId, modelId, baseUrl) 三元组只试一次(spec rev2_changes §2)。
 * cooled_down(未到期)/dead → 跳过;provider/credentials 缺失 → 跳过。
 */
function scanPass(
  chain: ReadonlyArray<FallbackChainItem>,
  providers: Map<string, LlmProviderConfig>,
  health: ProviderHealthRegistry,
  sessionId: string,
  now: number,
  allowDegraded: boolean,
): { kind: 'picked'; providerId: string; keyRef: string; modelId: string; keyValue: string }
  | { kind: 'pass_empty' } {
  const seen = new Set<string>();
  for (const item of chain) {
    const provider = providers.get(item.providerId);
    if (!provider) continue; // provider 不存在
    const dedupKey = `${item.providerId}|${item.modelId}|${provider.baseUrl}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    // account-wide 例外:account-wide + 不可用 → 直接跳换 provider(spec §4)
    if (
      isAccountWideSkip(
        provider.credentials, item.keyRef, health, sessionId, provider.id, item.modelId, now,
      )
    ) {
      continue;
    }
    // 健康探测
    const probe: HealthProbe = allowDegraded
      ? probeHealth(provider.credentials, item.keyRef, health, sessionId, provider.id, item.modelId, now)
      : health.isPreferred(sessionId, provider.id, item.keyRef, item.modelId, now);
    if (!probe.ok) continue;
    // 第 1 遍只要 healthy;第 2 遍 healthy 或 degraded(probeHealth 已返 ok)
    if (!allowDegraded && probe.tier !== 'healthy') continue;

    const selected = selectKey(provider.credentials, item.keyRef);
    if (!selected) continue; // credentials 配置异常
    return {
      kind: 'picked',
      providerId: provider.id,
      keyRef: selected.keyRef,
      modelId: item.modelId,
      keyValue: selected.keyValue,
    };
  }
  return { kind: 'pass_empty' };
}

/** 用 picked (provider, keyRef, model) 派生 client + 组装 ResolvedTarget。 */
function buildTarget(
  provider: LlmProviderConfig,
  keyRef: string,
  model: LlmModelConfig,
  clientFactory: LlmClientFactory,
  onWire?: (req: unknown, body: unknown, url: string) => void,
): ResolvedTarget {
  const keyValue = resolveKey(provider.credentials, keyRef)?.keyValue ?? '';
  const client = clientFactory.getClient(provider, keyRef, keyValue, model, onWire);
  return {
    providerId: provider.id,
    provider,
    keyRef,
    keyValue,
    model,
    client,
  };
}

/**
 * 把「all_dead」reason 包装为 ClassifiedLlmError（不塌缩 LOOP_ERROR）。
 * category 用 NETWORK（整链不可用，最接近的语义）。
 */
export function allDeadToClassifiedError(reason: string): ClassifiedLlmError {
  const err = new Error(`all targets unavailable: ${reason}`) as ClassifiedLlmError;
  err.category = LlmErrorCategory.NETWORK;
  err.hints = {
    retryable: false,
    shouldRotateKey: false,
    shouldFallbackProvider: false,
    shouldCompressContext: false,
    shouldBumpMaxTokens: false,
  };
  err.rawError = { message: reason };
  return err;
}

/** 重新导出 isAccountWideSkip 供 decide 逻辑复用（spec §4 例外）。 */
export { isAccountWideSkip };
