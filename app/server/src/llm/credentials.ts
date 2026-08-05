/**
 * credentials 多 key 解析 + keyRef 选择器
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md §3.3
 *       specs/tech/agent/llm_caller/[P0]llm_request_config.md §3-§4
 *
 * 设计：
 *   - resolveCredentials: 把单 key / 多 key union 统一化为 CredentialKey[]
（向后兼容，单 key 等价 [{keyRef:"default", quotaScope:"per_key"}]）
 *   - resolveKey: 按 fallback_chain 的 keyRef 选指定 key；缺省返 "default"
 *   - isAccountWideQuota: quotaScope 判定（account-wide 不轮换 key，hermes 教训）
 *
 * 消费方：
 *   - LlmProvider.buildAuthHeaders(config, keyRef?) 调 resolveKey 选 key 后取 keyValue 拼 header
 *   - resolveTarget 遍历 fallback_chain 时，每条 item 调 resolveKey(provider.credentials, item.keyRef)
 *     取 keyValue，再用 (providerId, keyRef) 查 ProviderHealthRegistry.isAvailable
 *   - decide：err.hints.shouldRotateKey && !isAccountWideQuota(...) 才进 ROTATE_KEY，
 *     否则 FALLBACK（account-wide quota 例外）
 *
 * 只含纯函数，无 IO。
 */
import type {
  CredentialConfig,
  CredentialKey,
  LlmProviderConfig,
  QuotaScope,
} from './provider-types';

/** 单 key 等价多 key 时用的默认 keyRef（[P0]llm_provider_interface.md §3.3）。 */
export const DEFAULT_KEY_REF = 'default';

/** 单 key credentials 默认按 per_key 配额作用域（可轮换）。 */
const DEFAULT_QUOTA_SCOPE: QuotaScope = 'per_key';

/**
 * 把 credentials union 统一化为 CredentialKey[]。
 *
 * 向后兼容：单 key `{ key: "sk-..." }` 等价于
 * `[{ keyRef: "default", keyValue: "sk-...", quotaScope: "per_key" }]`。
 *
 * @param credentials 单 key 或多 key credentials
 * @returns 标准化的 CredentialKey 数组（永不为空；输入异常返空数组由调用方判定）
 */
export function resolveCredentials(
  credentials: CredentialConfig | undefined,
): CredentialKey[] {
  if (!credentials) return [];
  // 多 key 形态
  if ('keys' in credentials && Array.isArray(credentials.keys)) {
    return credentials.keys;
  }
  // 单 key 形态（向后兼容）
  if ('key' in credentials && typeof credentials.key === 'string') {
    return [
      {
        keyRef: DEFAULT_KEY_REF,
        keyValue: credentials.key,
        quotaScope: DEFAULT_QUOTA_SCOPE,
      },
    ];
  }
  return [];
}

/**
 * 按 keyRef 选指定 credential key。
 *
 * 用途：fallback_chain 的 item.keyRef 引用某 provider 的具体 key（[P0]llm_request_config.md §3）。
 *
 * @param credentials provider 的 credentials（单/多 key union）
 * @param keyRef 引用名；缺省或未命中时返 "default" keyRef 对应的 key（向后兼容）
 * @returns 命中的 CredentialKey；全未命中（如空 credentials）返 undefined
 */
export function resolveKey(
  credentials: CredentialConfig | undefined,
  keyRef: string | undefined,
): CredentialKey | undefined {
  const keys = resolveCredentials(credentials);
  if (keys.length === 0) return undefined;
  const ref = keyRef ?? DEFAULT_KEY_REF;
  // 精确匹配 keyRef
  const hit = keys.find((k) => k.keyRef === ref);
  if (hit) return hit;
  // keyRef 未指定或未命中时，回退到 "default"（向后兼容：单 key 场景必命中）
  if (ref !== DEFAULT_KEY_REF) {
    const fallback = keys.find((k) => k.keyRef === DEFAULT_KEY_REF);
    if (fallback) return fallback;
  }
  // 兜底：返首个 key（确保总能取到 key，调用方不必处理 undefined header）
  return keys[0];
}

/**
 * 判定某 keyRef 对应的 key 是否 account-wide quota（不轮换，直接 fallback 换 provider）。
 *
 * hermes 教训（[P0]llm_request_config.md §4）：account-wide quota 的 provider
 * RATE_LIMITED 时不轮换 key（同账号所有 key 都限流了，轮换无意义），
 * 直接 FALLBACK 换 provider。
 *
 * @param credentials provider credentials
 * @param keyRef 引用名
 * @returns true 表示该 key 是 account-wide（decide 时跳过 ROTATE_KEY 直接 FALLBACK）
 */
export function isAccountWideQuota(
  credentials: CredentialConfig | undefined,
  keyRef: string | undefined,
): boolean {
  const key = resolveKey(credentials, keyRef);
  return key?.quotaScope === 'account_wide';
}

/**
 * 判定整个 provider 是否所有 key 都是 account-wide quota。
 *
 * 用途：resolveTarget 决定是否对该 provider 做任何 key 轮换。
 * 任一 per_key key 存在 → provider 仍有轮换能力。
 *
 * @param credentials provider credentials
 * @returns true 表示所有 key 都 account-wide（无轮换能力）
 */
export function isAllAccountWide(
  credentials: CredentialConfig | undefined,
): boolean {
  const keys = resolveCredentials(credentials);
  if (keys.length === 0) return false; // 空 credentials 不能断言，保守返 false
  return keys.every((k) => k.quotaScope === 'account_wide');
}

/**
 * 辅助：从 LlmProviderConfig 取某 keyRef 的 keyValue（拼 auth header 用）。
 *
 * 调用方（LlmProvider.buildAuthHeaders）用法：
 * ```ts
 * const k = pickKeyValue(config.credentials, keyRef);
 * if (!k) throw new Error(`key not found for keyRef=${keyRef}`);
 * // 拼 header ...
 * ```
 *
 * @returns keyValue 字符串；未命中返 undefined
 */
export function pickKeyValue(
  credentials: CredentialConfig | undefined,
  keyRef: string | undefined,
): string | undefined {
  return resolveKey(credentials, keyRef)?.keyValue;
}
