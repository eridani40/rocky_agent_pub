/**
 * fallback chain key 选择器 helper
 * 参考: specs/tech/agent/llm_caller/[P0]llm_request_config.md §1.4 + §3-§4
 *       specs/tech/agent/llm_caller/[P0]provider_health_registry.md §4(account-wide quota)
 *
 * 本文件只保留「key 取值 / quota 例外 / 可轮换判定」helper。
 *   resolveTarget 两遍扫描逻辑归 resolve_target.ts。
 *
 * 只含纯函数，无 IO。
 */
import type { ProviderHealthRegistry, HealthProbe } from './provider_health_registry';
import type {
  CredentialConfig,
  LlmProviderConfig,
} from '../provider-types';
import {
  isAccountWideQuota,
  resolveCredentials,
  resolveKey,
} from '../credentials';

/**
 * 判定是否应跳过该 (provider, keyRef) —— account-wide quota 例外。
 *
 * hermes 教训（spec §4）：account-wide quota 的 provider RATE_LIMITED 时不轮换 key
 * （同账号所有 key 都限流，轮换无意义），直接 fallback 换下一个 provider。
 *
 * 判定逻辑：
 *   1. 该 keyRef 对应的 key 是 account-wide quota → 看 registry 该四元组是否可用
 *   2. account-wide + 不可用(非 healthy/degraded) → 跳过（不轮换 key）
 *   3. 非 account-wide → 不跳过（per-key 可轮换，由 decide 逻辑处理 ROTATE_KEY）
 *
 * @param credentials provider credentials
 * @param keyRef      fallback chain item 的 keyRef
 * @param health      ProviderHealthRegistry
 * @param sessionId   session 标识(spec §2 v2.0 四元组 key 之一)
 * @param providerId  provider 实例 id
 * @param modelId     model 标识(spec §2 v2.0 四元组 key 之一)
 * @param now         当前 epoch ms
 * @returns true 表示应跳过该 key 直接 fallback 换 provider
 */
export function isAccountWideSkip(
  credentials: CredentialConfig | undefined,
  keyRef: string,
  health: ProviderHealthRegistry,
  sessionId: string,
  providerId: string,
  modelId: string,
  now: number,
): boolean {
  // 非 account-wide：不跳过（per-key 可轮换）
  if (!isAccountWideQuota(credentials, keyRef)) return false;
  // account-wide：查健康（兜底语义——healthy/degraded 都算可用不跳过），
  // 不可用(cooled_down/dead) → 跳过
  const probe = health.isAvailable(sessionId, providerId, keyRef, modelId, now);
  return !probe.ok;
}

/**
 * 探测某四元组健康(供 resolveTarget 两遍扫描用)——返回原始 HealthProbe。
 *
 * - tier=healthy 优先；tier=degraded 兜底；cooled_down/dead 排除。
 * - account-wide 例外叠加：account-wide + 不可用 → 一律排除(不轮换)。
 *
 * @returns 命中可用返 { ok:true, tier }；否则 { ok:false, tier, reason }
 */
export function probeHealth(
  credentials: CredentialConfig | undefined,
  keyRef: string,
  health: ProviderHealthRegistry,
  sessionId: string,
  providerId: string,
  modelId: string,
  now: number,
): HealthProbe {
  // account-wide + 不可用 → 一律排除(等价 cooled_down/dead tier 语义)
  if (isAccountWideSkip(credentials, keyRef, health, sessionId, providerId, modelId, now)) {
    return { ok: false, tier: 'dead', reason: 'account-wide quota unavailable' };
  }
  return health.isAvailable(sessionId, providerId, keyRef, modelId, now);
}

/**
 * 选 fallback chain item 对应的可用 key（account-wide 例外已过滤）。
 *
 * resolveTarget 查完 isAvailable.ok 后调此函数取 keyValue。
 * 返回 { keyValue, keyRef } 供 buildAuthHeaders 拼头。
 *
 * @returns 命中返 { keyValue, keyRef }；credentials 空/未命中返 undefined
 */
export function selectKey(
  credentials: CredentialConfig | undefined,
  keyRef: string,
): { keyValue: string; keyRef: string } | undefined {
  const key = resolveKey(credentials, keyRef);
  if (!key) return undefined;
  return { keyValue: key.keyValue, keyRef: key.keyRef };
}

/**
 * 辅助：判断 provider 在 per-key 池里是否还有可轮换的备用 key。
 *
 * decide ROTATE_KEY 决策用：当前 keyRef 失败后，是否还有同 provider 的其他 per_key key。
 * 仅 per_key key 计入（account-wide 不轮换，跳过）。
 *
 * @param credentials   provider credentials
 * @param currentKeyRef 当前失败的 keyRef
 * @returns true 表示存在可轮换的 per_key 备用 key
 */
export function hasRotatableKey(
  credentials: CredentialConfig | undefined,
  currentKeyRef: string,
): boolean {
  // resolveCredentials 是纯函数，静态 import 无循环依赖（credentials.ts 不依赖 caller/）
  const keys = resolveCredentials(credentials);
  return keys.some(
    (k) =>
      k.keyRef !== currentKeyRef && k.quotaScope === 'per_key',
  );
}
