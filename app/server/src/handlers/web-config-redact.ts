/**
 * web group secretKey redact + 占位 merge helper。
 * 参考: specs/tech/config/[P0]app_config.md §3.10（web group：jinaApiKey secret 处理）
 *       specs/api/version_logs/v0.0.23/change_log.md §2.1（jinaApiKey redact 套路）
 *
 * 设计（与 observability-redact 同套路，但 web.jinaApiKey 是**单 string 标量**
 * 而非列表项字段，故 helper 更简单——直接 merge 整个 data 值）：
 *   - GET 响应路径：web.jinaApiKey **明文返回**（secret mask 收敛到前端 SecretInput 展示层，
 *     与 observability / providers 一致）。
 *   - PUT 入参路径：data === `'***'` 视为「占位（前端未改）」→ 读落盘原值 merge 回来，
 *     不写空、不覆盖；非 `'***'` 视为用户新填明文 → 直接落盘。
 *
 * 仅作用于 (group='web', key='jinaApiKey')；web group 其他 key（jinaEnabled / jinaTimeoutMs）
 * 是明文非 secret，透传。
 *
 * handler 层调用此 helper（service 层保持通用 KV 不域特化，KvConfigService 基类统一）。
 */

/** web group 名 */
export const WEB_GROUP = 'web';
/** web group 下唯一的 secret key（jina reader API key，标量 string） */
export const WEB_JINA_API_KEY = 'jinaApiKey';

/**
 * 占位常量（PUT 入参识别值）。
 * GET 已不再 redact（明文返回），此常量仅用于 PUT 占位 merge 识别。
 * 与 observability-redact 共用同一占位字面量，便于统一约定。
 */
export const WEB_SECRET_REDACT_PLACEHOLDER = '***';

/**
 * 判断 KV 请求是否命中 web.jinaApiKey secret 特化路径。
 *
 * @param group dev_config group（query 或 body.group）
 * @param key 组内 key（query 或 item.key）
 * @returns group==='web' 且 key==='jinaApiKey' 时为 true
 */
export function isWebSecretKV(group: string | null, key: string | null): boolean {
  return group === WEB_GROUP && key === WEB_JINA_API_KEY;
}

/**
 * 占位 merge：PUT web.jinaApiKey 时，若 incoming data === `'***'` 则回填落盘原值。
 *
 * 语义（与 observability merge 同套路，但标量更简单——单值替换）：
 *   - incoming === `'***'` → 返回落盘原值（existing 不为 string 时返回空串，
 *     防御性：理论上不应出现，但避免脏数据类型错位）
 *   - incoming !== `'***'`（用户新填明文，含空串） → 原样落盘
 *
 * @param incoming PUT body 中 jinaApiKey 的 data（占位 或 用户填的明文）
 * @param existing 落盘当前原值（service.get(web, jinaApiKey)，未 redact；缺失为 undefined）
 * @returns merge 后的 data（可直接 service.set 落盘）
 */
export function mergeWebSecretPlaceholder(
  incoming: unknown,
  existing: unknown,
): unknown {
  if (incoming !== WEB_SECRET_REDACT_PLACEHOLDER) {
    // 用户新填明文（含空串=用户主动清空）→ 原样落盘
    return incoming;
  }
  // 占位 → 读落盘原值；落盘原值非 string（含 undefined）→ 空串（防御性）
  return typeof existing === 'string' ? existing : '';
}
