/**
 * channel appSecret 占位 merge helper
 * 参考: specs/tech/channel/[P0]channel_impl_interface.md §5.4（secret 单一源 + 占位约定）
 *       app/server/src/handlers/web-config-redact.ts（同套路占位字面量 '***'）
 *
 * 设计：
 *   - GET 响应路径：appSecret 明文返回（secret mask 收敛到前端 SecretInput 展示层，
 *     与 observability / providers / web.jinaApiKey 一致）
 *   - PUT 入参路径：input.config.appSecret === '***' 视为「占位（前端未改）」→ 读落盘原值 merge 回来；
 *     非 '***' 视为用户新填明文 → 直接落盘
 *
 * 占位约定（与 observability-redact / web-config-redact 共用 '***'）。
 */

/** 占位常量（PUT 入参识别值） */
export const CHANNEL_SECRET_REDACT_PLACEHOLDER = '***';

/** channel 配置中标记为 secret 的字段名（feishu: appSecret） */
export const CHANNEL_SECRET_FIELD = 'appSecret';

/**
 * 占位 merge：PUT 时若 incoming.config.appSecret === '***' 则回填落盘原值。
 *
 * 语义：
 *   - incoming.appSecret === '***' → 用 existing.appSecret（落盘原值缺失 → 空串防御）
 *   - incoming.appSecret !== '***'（用户新填明文，含空串=用户主动清空）→ 原样落盘
 *
 * @param incomingConfig PUT body 中 config（可能含占位 appSecret）
 * @param existingConfig 落盘当前 config（service.getRaw 取，未 redact）
 * @returns merge 后的 config（可直接 service.update 落盘）
 */
export function mergeChannelSecret(
  incomingConfig: Record<string, unknown> | undefined,
  existingConfig: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const incoming = incomingConfig ?? {};
  const existing = existingConfig ?? {};
  // 非 appSecret 字段以 incoming 优先（incoming 有则用，无则保留 existing）
  const merged: Record<string, unknown> = { ...existing, ...incoming };
  const inc = incoming[CHANNEL_SECRET_FIELD];
  if (inc === CHANNEL_SECRET_REDACT_PLACEHOLDER) {
    // 占位 → 回填落盘原值；落盘缺失 → 空串（防御性）
    const ex = existing[CHANNEL_SECRET_FIELD];
    merged[CHANNEL_SECRET_FIELD] = typeof ex === 'string' ? ex : '';
  } else {
    // 用户新填明文（含空串=主动清空）→ 原样落盘
    merged[CHANNEL_SECRET_FIELD] = inc;
  }
  return merged;
}
