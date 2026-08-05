/**
 * observability 列表 secretKey PUT 哨兵 merge helper。
 * 参考: specs/tech/config/[P0]app_config.md §3.9（secretKey 处理：GET 明文返回、PUT 占位不改）
 *       tests/api/observability/dev_config_observability_crud_tc1
 *
 * 设计（同 provider handler credentials.key 同套路）：
 *   - GET 响应路径：secretKey 明文返回（无域特化，走通用 KV 透传），前端 SecretInput 展示层 mask。
 *   - PUT 入参路径：item.secretKey === `'***'` 视为「占位（旧前端未改）」→ 读落盘原值 merge 回来，
 *     其余字段正常覆盖；非 `'***'` 视为用户新填的明文 → 直接落盘。
 *
 * 仅作用于 (group='runtime', key='observability')；其他 KV 透传。
 * handler 层调用此 helper（service 层保持通用 KV 不域特化，与 DevConfigService 同构原则一致）。
 */
import type { ObservabilityConfigItem } from '../observability/observability-manager';

/** runtime 组下的 observability key（唯一特化对象） */
export const OBSERVABILITY_GROUP = 'runtime';
export const OBSERVABILITY_KEY = 'observability';

/** 占位常量（PUT 入参哨兵识别值，旧前端兼容；GET 不再使用此常量脱敏） */
export const SECRET_REDACT_PLACEHOLDER = '***';

/** 判断 KV 请求是否命中 observability 特化路径 */
export function isObservabilityKV(group: string | null, key: string | null): boolean {
  return group === OBSERVABILITY_GROUP && key === OBSERVABILITY_KEY;
}

/**
 * 占位 merge：PUT observability 列表时，对 secretKey === `'***'` 的项回填落盘原值。
 *
 * - 读落盘当前列表（`existingItems`），按 item.id 索引原 secretKey
 * - 对入参每项：secretKey === `'***'` → 用同 id 落盘原值；否则用入参明文
 * - 入参项 id 在落盘不存在（新增项）：secretKey 必须非占位（用户新填明文），否则该字段置空串
 *   （防御性：前端新增时不应送占位；若误送，落盘 secretKey 为空，不误用历史值）
 *
 * @param incomingItems PUT body 的 observability 列表（用户编辑后整组提交）
 * @param existingItems 落盘当前 observability 列表（service 读取的原值，未 redact）
 * @returns merge 后的列表（可直接 service.set 落盘）
 */
export function mergeObservabilityPlaceholderSecrets(
  incomingItems: ObservabilityConfigItem[],
  existingItems: ObservabilityConfigItem[],
): ObservabilityConfigItem[] {
  // 按 id 索引落盘原 secretKey（同 id 的最后一项胜出，理论不应重复）
  const existingSecretById = new Map<string, string>();
  for (const e of existingItems) {
    if (typeof e.id === 'string') existingSecretById.set(e.id, e.secretKey);
  }

  return incomingItems.map((item) => {
    if (item.secretKey === SECRET_REDACT_PLACEHOLDER) {
      // 占位 → 读落盘原值（同 id 存在则回填，否则视为新增但误送占位 → 置空串）
      const original = existingSecretById.get(item.id);
      return { ...item, secretKey: typeof original === 'string' ? original : '' };
    }
    // 用户新填明文 → 原样落盘
    return item;
  });
}
