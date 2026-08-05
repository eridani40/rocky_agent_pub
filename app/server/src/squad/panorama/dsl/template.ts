/**
 * Panorama card 模板插值 — {field} / {ref.target} / {field|fallback} / {{esc}}.
 * 参考: specs/tech/squad/[P1]panorama_dsl.md §5.5
 *
 * 插值规则（v1）：
 *   {field}            → 当前实例字段值
 *   {ref_id.target}    → ref 字段指向的目标实例字段值（一级嵌套）
 *   {field|fallback}   → null/空时用 fallback
 *   {{literal}}        → 原样输出 {literal}（转义）
 *
 * resolveRef 依赖调用方（store/projection 层）预解析 ref 为嵌套对象；
 * DSL 模块无 store 访问，无法自行查 ID→实例。
 */
import type { PanoramaSchema } from './types';

/**
 * 复合正则：先匹配 {{...}} 转义，再匹配 {...} 插值。
 * group 1 = 转义内容（字面输出）
 * group 2 = 字段名, group 3 = ref target 字段, group 4 = fallback 文本
 */
const TEMPLATE_RE = /\{\{([^{}]*)\}\}|\{(\w+)(?:\.(\w+))?(?:\|([^}]*))?\}/g;

/**
 * ref 字段嵌套解析：从 record 中取出 ref 字段指向的目标实例。
 * record[refFieldName] 须为预解析的目标实例对象（store 层注入）；字符串 ID 或 null → null。
 */
export function resolveRef(
  record: Record<string, unknown>,
  refFieldName: string,
  _dsl: PanoramaSchema,
): Record<string, unknown> | null {
  const v = record[refFieldName];
  if (v == null) return null;
  if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return null;
}

/**
 * card 模板插值。tpl=null/undefined → 空串。
 * 编译期校验（field 是否存在于 entity）在 validation 语义层处理（Task#2）。
 */
export function interpolate(
  tpl: string | undefined,
  record: Record<string, unknown>,
  dsl: PanoramaSchema,
  _entity: string,
): string {
  return String(tpl ?? '').replace(TEMPLATE_RE, (match, esc, field, target, fallback) => {
    // {{esc}} → {esc} 字面输出
    if (esc !== undefined) return `{${esc}}`;

    // {ref.target} 一级嵌套
    if (target) {
      const refRecord = resolveRef(record, field, dsl);
      if (!refRecord) return fallback ?? '';
      const v = refRecord[target];
      return (v == null || v === '') ? (fallback ?? '') : String(v);
    }

    // {field} 简单字段
    const v = record[field];
    return (v == null || v === '') ? (fallback ?? '') : String(v);
  });
}
